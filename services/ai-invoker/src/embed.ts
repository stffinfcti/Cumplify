/**
 * Embedding door — spec-35 EMB-1..5.
 * Calls amazon.titan-embed-text-v2:0 via bedrock:InvokeModel (InvokeModel-only model —
 * no Converse API, no requestMetadata, no inference profiles).
 *
 * Executes INSIDE the invoker Lambda. Handlers reach it exclusively via the
 * one-door transport embed operation (invoke-transport.ts createEmbedFn).
 * EMB-2: invoker-internal — never imported directly by agent handlers.
 * EMB-5: does NOT implement AOSS retry/backoff — callers handle the 45s budget.
 */

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { Logger } from '@aws-lambda-powertools/logger';
import { computeCredits, loadWeights, incrementMeter, emitCreditsTelemetry } from './metering.js';
import { checkCreditBalance } from './credit-precheck.js';
import { resolveExemptFlag } from './exempt-principals.js';
import type { EmbedRequest, EmbedResult, TokenUsage } from './types.js';

const logger = new Logger({ serviceName: 'ai-invoker-embed' });

const MODEL_ID = 'amazon.titan-embed-text-v2:0';
const DIMENSIONS = 1024;

/** Singleton client (cold-cached per Lambda) */
let client: BedrockRuntimeClient | null = null;
function getClient(): BedrockRuntimeClient {
  if (!client) {
    client = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
  }
  return client;
}

/** Reset client (for testing) */
export function resetEmbedClient(): void {
  client = null;
}

/**
 * Embed text via Titan Embed Text v2.
 * Metering: reads inputTextTokenCount from response, computes credits, meters, emits telemetry.
 */
export async function embed(request: EmbedRequest): Promise<EmbedResult> {
  const { tenantId, agent, module, feature, text } = request;

  // Credit pre-check — systemOp bypasses via SERVE-9 exempt flag (iso-kb-seeding
  // Task 2), honored only for registered internal/system principals.
  const systemOp = resolveExemptFlag(request.systemOp, agent, 'systemOp');
  const cap = await checkCreditBalance(tenantId, systemOp);

  logger.info('Embedding text', { tenantId, agent, textLength: text.length });

  // Call Titan Embed v2 via InvokeModel (EMB-3: InvokeModel-only, no Converse)
  const body = JSON.stringify({
    inputText: text,
    dimensions: DIMENSIONS,
  });

  const response = await getClient().send(
    new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: Buffer.from(body),
    }),
  );

  const result = JSON.parse(Buffer.from(response.body).toString()) as {
    embedding: number[];
    inputTextTokenCount: number;
  };

  // Meter: compute credits from input tokens only (embedding model — no output tokens)
  const weights = await loadWeights(MODEL_ID);
  const usage: TokenUsage = {
    inputTokens: result.inputTextTokenCount,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
  };
  const credits = computeCredits(usage, weights);
  await incrementMeter(tenantId, credits, cap);

  // Emit telemetry (EMB-4)
  await emitCreditsTelemetry({
    tenantId,
    agent,
    module,
    feature,
    inputTokens: result.inputTextTokenCount,
    outputTokens: 0,
    cacheReadTokens: 0,
    creditsConsumed: credits,
    modelId: MODEL_ID,
    seat: 'embed',
    systemOp,
  });

  logger.info('Embedding complete', {
    tenantId,
    tokenCount: result.inputTextTokenCount,
    credits: credits.toFixed(6),
    dimensions: result.embedding.length,
  });

  return {
    embedding: result.embedding,
    tokenCount: result.inputTextTokenCount,
    credits,
  };
}
