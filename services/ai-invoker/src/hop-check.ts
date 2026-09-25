/**
 * Layer 3 — Hop Guardrail Check (spec-35 §6).
 *
 * When an agent invocation returns stopReason='tool_use' and the tool is in
 * the agent-routing registry, the hop payload is screened via ApplyGuardrail
 * (source:'INPUT', Agent guardrail — content + PII + prompt-attack).
 *
 * On BLOCK: halts the chain, publishes Ai.HopBlocked + Ai.GuardrailChecked,
 * and throws InvokeError('HOP_BLOCKED').
 *
 * Payload sanitization: only the first 500 chars of the stringified tool input
 * are included in the event payload (no PII leakage into telemetry bus).
 */

import {
  BedrockRuntimeClient,
  ApplyGuardrailCommand,
  type ApplyGuardrailCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';
import { Logger } from '@aws-lambda-powertools/logger';
import { publish } from '../../eventing/src/publisher.js';
import { InvokeError } from './types.js';
import type { GuardrailConfig } from './guardrail.js';

const logger = new Logger({ serviceName: 'ai-invoker-hop-check' });

/** Singleton client */
let client: BedrockRuntimeClient | null = null;
function getClient(): BedrockRuntimeClient {
  if (!client) {
    client = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
  }
  return client;
}

/** Reset client (for testing) */
export function resetHopCheckClient(): void {
  client = null;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Max chars of tool input included in event payload (sanitization, no PII) */
const MAX_PAYLOAD_SUMMARY_CHARS = 500;

// ─── Agent-Routing Tool Registry (§6.1) ─────────────────────────────────────

/**
 * Agent-routing tool names that trigger hop screening.
 * A tool_use call whose name is in this set represents an inter-agent hop
 * and must pass the guardrail before execution.
 *
 * Names are in DOMAIN form (hyphens) — matching the decoded output from
 * fromWireToolName() in converse.ts. The model outputs underscore-encoded
 * wire names (Nova can't emit hyphens), which are decoded before reaching
 * this check in invoke().
 */
export const AGENT_ROUTING_TOOLS: ReadonlySet<string> = new Set([
  'route-to-agent',
  'delegate-to-agent',
  'invoke-agent',
  'call-agent',
]);

/**
 * Check whether a tool name is an agent-routing hop that requires screening.
 */
export function isAgentRoutingTool(toolName: string): boolean {
  return AGENT_ROUTING_TOOLS.has(toolName);
}

// ─── Hop Check ──────────────────────────────────────────────────────────────

export interface HopCheckParams {
  guardrailConfig: GuardrailConfig;
  /** The tool input payload (will be stringified for guardrail evaluation) */
  toolInput: unknown;
  /** Tool name (for diagnostics) */
  toolName: string;
  /** Source agent initiating the hop */
  sourceAgent: string;
  /** Target agent (extracted from tool input if available) */
  targetAgent: string;
  /** Attribution */
  tenantId: string;
  module: string;
  standard?: 'ISO9001' | 'ISO14001' | 'ISO45001';
}

export interface HopCheckResult {
  verdict: 'pass' | 'blocked';
  blockedPolicy?: string;
  latencyMs: number;
}

/**
 * Screen an inter-agent hop payload via ApplyGuardrail (source:'INPUT').
 * On BLOCK: emits Ai.HopBlocked + Ai.GuardrailChecked, throws HOP_BLOCKED.
 * On PASS: emits Ai.GuardrailChecked, returns normally.
 */
export async function checkHopPayload(params: HopCheckParams): Promise<HopCheckResult> {
  const {
    guardrailConfig,
    toolInput,
    toolName,
    sourceAgent,
    targetAgent,
    tenantId,
    module,
    standard,
  } = params;

  const payloadText = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput ?? {});

  const startMs = Date.now();

  const response: ApplyGuardrailCommandOutput = await getClient().send(
    new ApplyGuardrailCommand({
      guardrailIdentifier: guardrailConfig.guardrailIdentifier,
      guardrailVersion: guardrailConfig.guardrailVersion,
      source: 'INPUT',
      content: [{ text: { text: payloadText } }],
    }),
  );

  const latencyMs = Date.now() - startMs;
  const blocked = response.action === 'GUARDRAIL_INTERVENED';
  const blockedPolicy = blocked ? extractBlockedPolicy(response) : undefined;

  // Emit Ai.GuardrailChecked (TEL-1) regardless of verdict
  await publish({
    busName: process.env.BUS_NAME ?? 'cumplify-events',
    source: 'cumplify.ai-invoker',
    detailType: 'Ai.GuardrailChecked',
    event: {
      tenantId,
      timestamp: new Date().toISOString(),
      actor: sourceAgent,
      module,
      clauseRef: '',
      standard: standard ?? 'ISO9001',
      entityId: '',
      payload: {
        guardrailPolicy: 'hop:prompt-attack',
        verdict: blocked ? 'block' : 'pass',
        score: null,
        latencyMs,
      },
    },
  });

  if (blocked) {
    // Sanitized summary for event payload (no PII leakage)
    const sanitizedPayload = payloadText.slice(0, MAX_PAYLOAD_SUMMARY_CHARS);

    // Emit Ai.HopBlocked (TEL-3)
    await publish({
      busName: process.env.BUS_NAME ?? 'cumplify-events',
      source: 'cumplify.ai-invoker',
      detailType: 'Ai.HopBlocked',
      event: {
        tenantId,
        timestamp: new Date().toISOString(),
        actor: sourceAgent,
        module,
        clauseRef: '',
        standard: standard ?? 'ISO9001',
        entityId: '',
        payload: {
          tenantId,
          sourceAgent,
          targetAgent,
          blockedPolicy: blockedPolicy ?? 'UNKNOWN',
          payload: sanitizedPayload,
        },
      },
    });

    logger.warn('Hop payload blocked by guardrail', {
      sourceAgent,
      targetAgent,
      toolName,
      blockedPolicy,
      latencyMs,
    });

    throw new InvokeError(
      'HOP_BLOCKED',
      `Inter-agent hop from ${sourceAgent} to ${targetAgent} blocked by ${blockedPolicy ?? 'guardrail policy'}`,
    );
  }

  logger.info('Hop payload passed guardrail check', {
    sourceAgent,
    targetAgent,
    toolName,
    latencyMs,
  });

  return { verdict: 'pass', latencyMs };
}

/**
 * Extract the blocking policy name from the ApplyGuardrail response assessments.
 * Returns the first blocked assessment type found (e.g. 'PROMPT_ATTACK', 'NAME').
 */
function extractBlockedPolicy(response: ApplyGuardrailCommandOutput): string {
  const assessments = response.assessments ?? [];
  for (const assessment of assessments) {
    // Content policy (prompt attack detection)
    const contentPolicy = (assessment as any).contentPolicy;
    if (contentPolicy?.filters) {
      for (const filter of contentPolicy.filters) {
        if (filter.action === 'BLOCKED') {
          return filter.type ?? 'CONTENT_FILTER';
        }
      }
    }
    // Sensitive information (PII)
    const sensitiveInfo = (assessment as any).sensitiveInformationPolicy;
    if (sensitiveInfo?.piiEntities) {
      for (const entity of sensitiveInfo.piiEntities) {
        if (entity.action === 'BLOCKED') {
          return `PII:${entity.type}`;
        }
      }
    }
    // Topic policy
    const topicPolicy = (assessment as any).topicPolicy;
    if (topicPolicy?.topics) {
      for (const topic of topicPolicy.topics) {
        if (topic.action === 'BLOCKED') {
          return `TOPIC:${topic.name}`;
        }
      }
    }
    // Word policy
    const wordPolicy = (assessment as any).wordPolicy;
    if (wordPolicy?.customWords || wordPolicy?.managedWordLists) {
      return 'WORD_FILTER';
    }
  }
  return 'UNKNOWN';
}
