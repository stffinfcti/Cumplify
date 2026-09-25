/**
 * AI Invoker — Lambda entry point + public invoke() API.
 * The ONE DOOR through which every Bedrock model call passes (steering 12).
 *
 * Design §2.2 (F-1): Lambda entry dispatches on op discriminator:
 *   {op:'embed'} → embed.ts; absent op = invoke path (back-compat).
 * Design §1.2: invoke() orchestrates Register resolution, credit pre-check,
 * Converse, schema-retry (Workhorse), metering, and telemetry.
 */

import { Logger } from '@aws-lambda-powertools/logger';
import { resolveModel } from './register-resolver.js';
import { converse } from './converse.js';
import { computeCredits, loadWeights, incrementMeter, emitCreditsTelemetry } from './metering.js';
import { checkCreditBalance } from './credit-precheck.js';
import { resolveExemptFlag } from './exempt-principals.js';
import { assertSchemaValid } from './schema-retry.js';
import { buildGuardrailConfig } from './guardrail.js';
import { embed } from './embed.js';
import {
  runGroundingFlow,
  emitGroundingBlockedAndHonestMiss,
  GROUNDING_RETRY_INSTRUCTION,
} from './grounding.js';
import { checkHopPayload, isAgentRoutingTool } from './hop-check.js';
import { buildSystemPrompt } from './prompt-library.js';
import { checkArPolicy, buildArRetryInstruction, emitArRejected } from './ar-check.js';
import type { ArInvocationPath } from './ar-check.js';
import { publish } from '../../eventing/src/publisher.js';
import { InvokeError, SEAT_DEFAULTS } from './types.js';
import type {
  InvokeRequest,
  InvokeResponse,
  TokenUsage,
  EmbedOp,
  EmbedResult,
  GuardrailEvidenceData,
} from './types.js';

const logger = new Logger({ serviceName: 'ai-invoker' });

export type { InvokeRequest, InvokeResponse } from './types.js';
export type { EmbedRequest, EmbedResult, EmbedOp } from './types.js';
export type { GuardrailEvidenceData, GuardrailCitation } from './types.js';
export { InvokeError } from './types.js';
export type { SeatId, CompiledRegister, ModelWeight } from './types.js';
export { DOC_COMPOSER_OUTPUT_SCHEMA } from './doc-composer-schema.js';
export type { DocComposerOutput } from './doc-composer-schema.js';

/**
 * Lambda entry point — dispatches on op discriminator (spec-35 §2.2, F-1).
 * - {op:'embed', ...} → embed path (EMB-1..5)
 * - absent op / {op:'invoke', ...} → existing invoke path (back-compat)
 */
export async function handler(event: InvokeRequest | EmbedOp): Promise<InvokeResponse | EmbedResult> {
  if ('op' in event && event.op === 'embed') {
    return embed(event);
  }
  return invoke(event as InvokeRequest);
}

/**
 * Invoke a model through the one-door serving path.
 * Steps 1-8 per design §1.2 + spec-35 grounding (§3.1).
 */
export async function invoke(request: InvokeRequest): Promise<InvokeResponse> {
  const { seat, tenantId, agent, module, feature } = request;

  // Step 1: Register resolution (SERVE-2, SERVE-5, SERVE-6)
  const seatEntry = resolveModel(seat);
  const { modelId, tier, cachingSupported } = seatEntry;

  logger.info('Invoking model', { seat, modelId, tenantId, agent });

  // Step 2: Credit pre-check (SERVE-9) — the exemption flag is honored only
  // for registered internal/system principals (see exempt-principals.ts).
  const cap = await checkCreditBalance(
    tenantId,
    resolveExemptFlag(request.creditExempt, agent, 'creditExempt'),
  );

  // Load model weights for metering
  const weights = await loadWeights(modelId);

  // Resolve defaults + L4-5 temperature enforcement
  const defaults = SEAT_DEFAULTS[tier];
  let temperature = request.temperature ?? defaults.temperature;
  // L4-5: record-writing paths MUST use ≤ 0.3
  if (feature === 'record-write' && temperature > 0.3) {
    temperature = 0.3;
  }
  const maxTokens = request.maxTokens ?? defaults.maxTokens;

  // L1-9/INV-3: Non-streaming invariant for record-write paths
  // (Current invoker is non-streaming; enforced here for when streaming is introduced)

  // Step 3+4: Build params and call Converse
  // Seat-routed (spec-35 §1.2): doc-composer→DocGen, record-write→RecordWrite, else→Agent
  const guardrailConfig = buildGuardrailConfig(seat, feature);

  // L4 (§7.2): Wrap base system prompt with shared instruction blocks.
  // FIX-W-2: unconditional — even when request.system is absent, the four
  // shared blocks (structural-honesty, licensed-uncertainty, retrieval-first,
  // relative-date) are injected. L4-1 uniformity mandate.
  const systemPrompt = buildSystemPrompt(request.system ?? '');

  const converseParams = {
    modelId,
    messages: request.messages,
    system: systemPrompt,
    tools: request.tools,
    temperature,
    maxTokens,
    requestMetadata: { tenantId, agent, module, feature },
    guardrailConfig,
    cachingEnabled: cachingSupported,
  };

  let result = await converse(converseParams);
  let usage = result.usage;
  let guardrailEvidence: GuardrailEvidenceData | undefined;

  // ─── FIX-T20-1: Short-circuit on guardrail_intervened (inline input block) ──
  // When Bedrock's inline guardrail blocks the input (stopReason='guardrail_intervened'),
  // the response text is the policy message (e.g. "Request blocked by content policy.").
  // Short-circuit: return the blocked messaging directly — NO grounding check, NO retry,
  // NO Ai.GroundingBlocked. Emit Ai.GuardrailChecked with policy 'prompt-attack' and
  // meter whatever usage exists (the model consumed some tokens even on a block).
  if (result.stopReason === 'guardrail_intervened') {
    logger.info('Guardrail intervened on input — short-circuiting', { seat, modelId, tenantId });

    // Emit Ai.GuardrailChecked (policy message, not a grounding issue)
    await publish({
      busName: process.env.BUS_NAME ?? 'cumplify-events',
      source: 'cumplify.ai-invoker',
      detailType: 'Ai.GuardrailChecked',
      event: {
        tenantId,
        timestamp: new Date().toISOString(),
        actor: agent,
        module,
        clauseRef: '',
        standard: request.standard ?? 'ISO9001',
        entityId: '',
        payload: {
          guardrailPolicy: 'prompt-attack',
          verdict: 'block',
          score: null,
          latencyMs: null,
        },
      },
    });

    // Meter consumed usage (billing integrity — even blocked calls have token cost)
    const credits = computeCredits(usage, weights);
    await incrementMeter(tenantId, credits, cap);
    await emitCreditsTelemetry({
      tenantId, agent, module, feature,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadInputTokens,
      creditsConsumed: credits, modelId, seat,
    });

    return {
      text: result.text,
      toolUseBlocks: [],
      stopReason: 'guardrail_intervened',
      usage,
      credits,
      modelId,
      seat,
    };
  }

  // ─── Spec-35 L3: Hop guardrail check (Task 15) ────────────────────────────
  // When stopReason='tool_use' + tool is in agent-routing registry → screen payload.
  // On block: throws HOP_BLOCKED after metering consumed usage (FIX-W-1).
  if (result.stopReason === 'tool_use' && result.toolUseBlocks.length > 0) {
    for (const toolBlock of result.toolUseBlocks) {
      if (isAgentRoutingTool(toolBlock.name)) {
        // Extract target agent from tool input if available
        const inputObj = toolBlock.input as Record<string, unknown> | undefined;
        const targetAgent = (inputObj?.targetAgent as string) ?? (inputObj?.agent as string) ?? 'unknown';

        try {
          await checkHopPayload({
            guardrailConfig: guardrailConfig!,
            toolInput: toolBlock.input,
            toolName: toolBlock.name,
            sourceAgent: agent,
            targetAgent,
            tenantId,
            module,
            standard: request.standard,
          });
        } catch (err) {
          // FIX-W-1: Meter consumed converse usage before HOP_BLOCKED propagates.
          // The converse call already consumed tokens; billing integrity requires
          // metering even on blocked hops (same pattern as honest-miss path).
          if (err instanceof InvokeError && err.code === 'HOP_BLOCKED') {
            const credits = computeCredits(usage, weights);
            await incrementMeter(tenantId, credits, cap);
            await emitCreditsTelemetry({
              tenantId, agent, module, feature,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cacheReadTokens: usage.cacheReadInputTokens,
              creditsConsumed: credits, modelId, seat,
            });
          }
          throw err;
        }
      }
    }
  }

  // ─── Spec-35 L1: Post-response grounding check ──────────────────────────
  // Dormant when groundingContext absent (non-KB-grounded invocations pass through)
  if (request.groundingContext) {
    const groundingResult = await runGroundingFlow({
      guardrailConfig: guardrailConfig!,
      groundingContext: request.groundingContext,
      responseText: result.text,
      locale: request.locale,
      standard: request.standard,
      tenantId,
      agent,
      module,
    });

    if (groundingResult.flagged) {
      // L1-7: RETRY ONCE with grounding injection
      logger.info('Grounding check failed, retrying with source injection', { seat, modelId });
      const retryMessages = [
        ...request.messages,
        { role: 'assistant' as const, content: [{ text: result.text }] },
        {
          role: 'user' as const,
          content: [
            { text: `${GROUNDING_RETRY_INSTRUCTION}\n\nSource:\n${request.groundingContext.source}` },
          ],
        },
      ];
      const retryParams = { ...converseParams, messages: retryMessages };
      const retryResult = await converse(retryParams);
      usage = addUsage(usage, retryResult.usage);

      // Re-check grounding on retry response
      const retryGroundingResult = await runGroundingFlow({
        guardrailConfig: guardrailConfig!,
        groundingContext: request.groundingContext,
        responseText: retryResult.text,
        locale: request.locale,
        standard: request.standard,
        tenantId,
        agent,
        module,
      });

      if (retryGroundingResult.flagged) {
        // L1-8: Double failure → honest-miss template + event
        const honestMissText = await emitGroundingBlockedAndHonestMiss({
          tenantId,
          agent,
          module,
          groundingScore: retryGroundingResult.groundingScore,
          relevanceScore: retryGroundingResult.relevanceScore,
          locale: request.locale,
          standard: request.standard,
        });

        // Meter consumed usage before returning honest-miss
        const credits = computeCredits(usage, weights);
        await incrementMeter(tenantId, credits, cap);
        await emitCreditsTelemetry({
          tenantId, agent, module, feature,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadInputTokens,
          creditsConsumed: credits, modelId, seat,
        });

        return {
          text: honestMissText,
          toolUseBlocks: [],
          stopReason: 'grounding_blocked',
          usage,
          credits,
          modelId,
          seat,
          guardrailEvidence: {
            groundingScore: retryGroundingResult.groundingScore,
            relevanceScore: retryGroundingResult.relevanceScore,
            arVerdict: null,
            arDetails: null,
            citations: retryGroundingResult.citations,
            flagged: true,
          },
        };
      }

      // Retry passed — use retry response, flag as evidence (passed on retry)
      result = retryResult;
      guardrailEvidence = {
        groundingScore: retryGroundingResult.groundingScore,
        relevanceScore: retryGroundingResult.relevanceScore,
        arVerdict: null,
        arDetails: null,
        citations: retryGroundingResult.citations,
        flagged: true, // grounding failed first time, passed on retry
      };
    } else {
      // Grounding passed first time — attach evidence (not flagged)
      guardrailEvidence = {
        groundingScore: groundingResult.groundingScore,
        relevanceScore: groundingResult.relevanceScore,
        arVerdict: null,
        arDetails: null,
        citations: groundingResult.citations,
        flagged: false,
      };
    }
  }

  // ─── Spec-35 L2: Post-response AR check (Tasks 27/28) ─────────────────────
  // After grounding passes: if clause-citing/role/plan path → checkArPolicy()
  // Dormant when AR guardrails not deployed (env vars absent).
  const arPath = resolveArInvocationPath(seat, feature);
  if (arPath) {
    // FIX-AR-GUARD (architect): L2 is a VALIDATION layer — an AR INFRA failure
    // (AccessDenied before the Task-26 IAM grant, throttling, transient API
    // errors) must not take down the answer path (invoker-down incident class).
    // Fail open LOUDLY: deliver with arVerdict=error so evidence, logs, and
    // metric filters surface the outage. Verdict-based blocking never throws
    // and is unaffected.
    try {
      const arResult = await checkArPolicy({
        responseText: result.text,
        invocationPath: arPath,
        tenantId,
        agent,
        module,
        feature,
        standard: request.standard,
      });

      if (arResult.decision === 'flag_hitl') {
        // TRANSLATION_AMBIGUOUS / NO_TRANSLATION / TOO_COMPLEX → flag for HITL immediately
        // Never silently pass an ambiguous result.
        await emitArRejected({
          tenantId,
          agent,
          module,
          standard: request.standard,
          arPolicy: arResult.arPolicy,
          finding: arResult.finding,
          retriedOnce: false,
          finalOutcome: 'hitl-deferred',
        });

        // Meter consumed usage (FIX-W-1 pattern)
        const credits = computeCredits(usage, weights);
        await incrementMeter(tenantId, credits, cap);
        await emitCreditsTelemetry({
          tenantId, agent, module, feature,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadInputTokens,
          creditsConsumed: credits, modelId, seat,
        });

        return {
          text: result.text,
          toolUseBlocks: [],
          stopReason: 'end_turn',
          usage,
          credits,
          modelId,
          seat,
          guardrailEvidence: {
            groundingScore: guardrailEvidence?.groundingScore ?? null,
            relevanceScore: guardrailEvidence?.relevanceScore ?? null,
            arVerdict: 'fail',
            arDetails: `${arResult.arPolicy}:${arResult.finding.result} — ${arResult.finding.reason ?? 'flagged for human review'}`,
            citations: guardrailEvidence?.citations ?? [],
            flagged: true,
          },
        };
      }

      if (arResult.decision === 'reject') {
        // INVALID / IMPOSSIBLE → steered-retry once with AR feedback
        logger.info('AR check rejected, attempting steered retry', {
          arPolicy: arResult.arPolicy,
          result: arResult.finding.result,
        });

        const arRetryInstruction = buildArRetryInstruction(arResult.finding);
        const arRetryMessages = [
          ...request.messages,
          { role: 'assistant' as const, content: [{ text: result.text }] },
          { role: 'user' as const, content: [{ text: arRetryInstruction }] },
        ];
        const arRetryParams = { ...converseParams, messages: arRetryMessages };
        const arRetryResult = await converse(arRetryParams);
        usage = addUsage(usage, arRetryResult.usage);

        // Re-check AR on retry response
        const arRetryCheck = await checkArPolicy({
          responseText: arRetryResult.text,
          invocationPath: arPath,
          tenantId,
          agent,
          module,
          feature,
          standard: request.standard,
        });

        if (arRetryCheck.decision === 'pass') {
          // Retry corrected the issue — use retry response
          result = arRetryResult;
          guardrailEvidence = {
            groundingScore: guardrailEvidence?.groundingScore ?? null,
            relevanceScore: guardrailEvidence?.relevanceScore ?? null,
            arVerdict: 'pass',
            arDetails: `${arResult.arPolicy}:corrected on retry`,
            citations: guardrailEvidence?.citations ?? [],
            flagged: true, // AR failed first time, passed on retry
          };

          await emitArRejected({
            tenantId,
            agent,
            module,
            standard: request.standard,
            arPolicy: arResult.arPolicy,
            finding: arResult.finding,
            retriedOnce: true,
            finalOutcome: 'corrected',
          });
        } else {
          // Double-fail (or HITL on retry) → flag for HITL
          await emitArRejected({
            tenantId,
            agent,
            module,
            standard: request.standard,
            arPolicy: arResult.arPolicy,
            finding: arRetryCheck.finding,
            retriedOnce: true,
            finalOutcome: 'hitl-deferred',
          });

          // Meter consumed usage (FIX-W-1 pattern)
          const credits = computeCredits(usage, weights);
          await incrementMeter(tenantId, credits, cap);
          await emitCreditsTelemetry({
            tenantId, agent, module, feature,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadInputTokens,
            creditsConsumed: credits, modelId, seat,
          });

          return {
            text: result.text,
            toolUseBlocks: [],
            stopReason: 'end_turn',
            usage,
            credits,
            modelId,
            seat,
            guardrailEvidence: {
              groundingScore: guardrailEvidence?.groundingScore ?? null,
              relevanceScore: guardrailEvidence?.relevanceScore ?? null,
              arVerdict: 'fail',
              arDetails: `${arResult.arPolicy}:${arRetryCheck.finding.result} — retry also failed`,
              citations: guardrailEvidence?.citations ?? [],
              flagged: true,
            },
          };
        }
      }

      // AR passed — attach evidence if not already set
      if (arResult.decision === 'pass' && !guardrailEvidence) {
        guardrailEvidence = {
          groundingScore: null,
          relevanceScore: null,
          arVerdict: 'pass',
          arDetails: `${arResult.arPolicy}:${arResult.finding.result}`,
          citations: [],
          flagged: false,
        };
      } else if (arResult.decision === 'pass' && guardrailEvidence) {
        guardrailEvidence = {
          ...guardrailEvidence,
          arVerdict: 'pass',
          arDetails: `${arResult.arPolicy}:${arResult.finding.result}`,
        };
      }
    } catch (err) {
      if (err instanceof InvokeError) throw err;
      logger.error('AR check infra failure — failing open with arVerdict=error', {
        error: err instanceof Error ? err.message : String(err),
        arPath, seat, feature, tenantId,
      });
      guardrailEvidence = {
        groundingScore: guardrailEvidence?.groundingScore ?? null,
        relevanceScore: guardrailEvidence?.relevanceScore ?? null,
        arVerdict: 'error',
        arDetails: `ar-check infra failure: ${err instanceof Error ? err.message : 'unknown'}`,
        citations: guardrailEvidence?.citations ?? [],
        flagged: false,
      };
    }
  }

  // Step 6: Schema-validate + one-retry (SERVE-10 + COND-3)
  if (request.outputSchema) {
    try {
      assertSchemaValid(result.text, request.outputSchema, {
        seat,
        modelId,
        attempt: 1,
      });
    } catch (err) {
      if (err instanceof InvokeError && err.code === 'SCHEMA_VALIDATION_ERROR') {
        logger.info('Schema validation failed, retrying once', { seat, modelId });
        const retryMessages = [
          ...request.messages,
          { role: 'assistant' as const, content: [{ text: result.text }] },
          {
            role: 'user' as const,
            content: [
              {
                text: 'Your previous output failed JSON schema validation. Please return valid JSON matching the required schema.',
              },
            ],
          },
        ];
        const retryParams = { ...converseParams, messages: retryMessages };
        result = await converse(retryParams);
        usage = addUsage(usage, result.usage);

        try {
          assertSchemaValid(result.text, request.outputSchema, {
            seat,
            modelId,
            attempt: 2,
          });
        } catch (retryErr) {
          const credits = computeCredits(usage, weights);
          await incrementMeter(tenantId, credits, cap);
          await emitCreditsTelemetry({
            tenantId, agent, module, feature,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadInputTokens,
            creditsConsumed: credits, modelId, seat,
          });
          throw retryErr;
        }
      } else {
        throw err;
      }
    }
  }

  // Step 7: Meter tokens → credits (SERVE-3)
  const credits = computeCredits(usage, weights);
  await incrementMeter(tenantId, credits, cap);

  // Emit telemetry (non-blocking)
  await emitCreditsTelemetry({
    tenantId, agent, module, feature,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadInputTokens,
    creditsConsumed: credits, modelId, seat,
  });

  logger.info('Invocation complete', {
    seat, modelId, tenantId,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    credits: credits.toFixed(4),
  });

  // Step 8: Return response
  return {
    text: result.text,
    toolUseBlocks: result.toolUseBlocks,
    stopReason: result.stopReason,
    usage,
    credits,
    modelId,
    seat,
    guardrailEvidence,
  };
}

/** Accumulate token usage across retries */
function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    cacheWriteInputTokens: a.cacheWriteInputTokens + b.cacheWriteInputTokens,
  };
}

// ─── AR Invocation Path Resolution (§5.2) ───────────────────────────────────

/** Seats that produce clause-citing content eligible for AR validation */
const CLAUSE_CITING_SEATS: ReadonlySet<string> = new Set([
  'guru-9001',
  'guru-14001',
  'guru-45001',
  'workhorse',
]);

/** Features that indicate clause-citing content */
const CLAUSE_CITING_FEATURES: ReadonlySet<string> = new Set([
  'clause-qa',
  'record-write',
]);

/** Features that indicate role-advisory content */
const ROLE_ADVISORY_FEATURES: ReadonlySet<string> = new Set([
  'role-advisory',
  'permission-check',
]);

/** Features that indicate plan-advisory content */
const PLAN_ADVISORY_FEATURES: ReadonlySet<string> = new Set([
  'plan-advisory',
  'entitlement-check',
]);

/**
 * Resolve the AR invocation path from seat + feature.
 * Returns undefined if the invocation is not subject to AR validation.
 */
function resolveArInvocationPath(
  seat: string,
  feature: string,
): ArInvocationPath | undefined {
  // Role/plan advisory features take precedence (advisory guardrail)
  if (ROLE_ADVISORY_FEATURES.has(feature)) return 'role-advisory';
  if (PLAN_ADVISORY_FEATURES.has(feature)) return 'plan-advisory';

  // Clause-citing: guru seats with clause-qa or record-write feature
  if (CLAUSE_CITING_FEATURES.has(feature) && CLAUSE_CITING_SEATS.has(seat)) {
    return 'clause-citing';
  }
  // Also: record-write on workhorse seat (record-writing drafts cite clauses)
  if (feature === 'record-write') return 'clause-citing';

  return undefined;
}
