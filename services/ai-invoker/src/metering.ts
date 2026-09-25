/**
 * Token → credit metering module.
 * Design §1.4 — weight derivation: wIn/wOut/wCache = pricePerMToken × 1000.
 * Calibrated so 1,000 credits ≈ $1.00 raw Bedrock cost.
 *
 * Meter key: TENANT#<tenantId>#METER / MONTH#<yyyymm> (D-5 corrected).
 */

import { DynamoDBClient, UpdateItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { Logger } from '@aws-lambda-powertools/logger';
import { InvokeError } from './types.js';
import type { ModelWeight, TokenUsage } from './types.js';

const logger = new Logger({ serviceName: 'ai-invoker-metering' });

const ddb = new DynamoDBClient({});
const eb = new EventBridgeClient({});

const TABLE_NAME = process.env.TABLE_NAME!;
const BUS_NAME = process.env.BUS_NAME ?? 'cumplify-events';

/**
 * Compute credits consumed from token usage and model weights.
 * Formula (§1.4): credits = (input × wIn + cacheRead × wCache + output × wOut) / 1,000,000
 * If wCache is null (model doesn't support caching), fallback to wIn (safety guard —
 * cacheReadInputTokens will always be 0 for non-caching models).
 */
export function computeCredits(usage: TokenUsage, weights: ModelWeight): number {
  const wCache = weights.wCache ?? weights.wIn; // fallback for non-caching models
  const credits =
    (usage.inputTokens * weights.wIn +
      usage.cacheReadInputTokens * wCache +
      usage.outputTokens * weights.wOut) /
    1_000_000;
  // A NaN/negative input (embed edge: provider returned no usage block)
  // would ADD NaN to the counter — refuse to meter garbage.
  if (!Number.isFinite(credits) || credits < 0) {
    throw new Error(`Refusing to meter non-finite credits: ${credits} (${JSON.stringify(usage)})`);
  }
  return credits;
}

/** Deploy-time configuration — cache per model for a short TTL instead of a
 * QueryCommand on every converse/embed call (register-resolver precedent). */
const WEIGHTS_CACHE_TTL_MS = 60_000;
const weightsCache = new Map<string, { weights: ModelWeight; cachedAt: number }>();

/** Test-only: clear the in-process cache. */
export function resetWeightsCache(): void {
  weightsCache.clear();
}

/**
 * Load model weights from DynamoDB (latest version for the model).
 * Reads MODELWEIGHT#<modelId>, SK descending limit 1.
 */
export async function loadWeights(modelId: string): Promise<ModelWeight> {
  const hit = weightsCache.get(modelId);
  if (hit && Date.now() - hit.cachedAt < WEIGHTS_CACHE_TTL_MS) {
    return hit.weights;
  }

  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': { S: `MODELWEIGHT#${modelId}` },
      },
      ScanIndexForward: false,
      Limit: 1,
    }),
  );

  if (!result.Items || result.Items.length === 0) {
    throw new Error(`No MODELWEIGHT# entry found for model '${modelId}'`);
  }

  const item = result.Items[0];
  const weights = {
    modelId,
    wIn: parseFloat(item.wIn?.N ?? '0'),
    wOut: parseFloat(item.wOut?.N ?? '0'),
    wCache: item.wCache?.N ? parseFloat(item.wCache.N) : null,
    effectiveFrom: item.effectiveFrom?.S ?? '',
    sourceCommit: item.sourceCommit?.S ?? '',
  };
  weightsCache.set(modelId, { weights, cachedAt: Date.now() });
  return weights;
}

/**
 * Atomically increment the tenant's monthly credit meter.
 * Key: TENANT#<tenantId>#METER / MONTH#<yyyymm>
 *
 * TOCTOU (M-effort): the pre-check's check-then-act between the meter read
 * and this ADD used to race — two concurrent invokes could both pass the
 * pre-check and both ADD past the grant. When the caller passes the cap the
 * pre-check resolved, the SAME invariant rides the write as a
 * ConditionExpression ('used + credits <= cap before this ADD'), so a
 * racing write is rejected by DynamoDB instead of silently over-crediting.
 */
export async function incrementMeter(
  tenantId: string,
  credits: number,
  cap?: { hardCap?: number },
): Promise<void> {
  if (!Number.isFinite(credits) || credits < 0) {
    throw new Error(`Refusing to increment meter by non-finite credits: ${credits}`);
  }
  const yyyymm = new Date().toISOString().slice(0, 7).replace('-', '');
  const pk = `TENANT#${tenantId}#METER`;
  const sk = `MONTH#${yyyymm}`;

  const capped = cap?.hardCap !== undefined;
  try {
    await ddb.send(
      new UpdateItemCommand({
        TableName: TABLE_NAME,
        Key: {
          PK: { S: pk },
          SK: { S: sk },
        },
        // :capMinusCredits is computed client-side — used <= cap - credits is
        // equivalent to used + credits <= cap, so this write can never push
        // the meter past the grant. attribute_not_exists covers a
        // never-metered tenant (fresh month row) provided this ADD itself
        // fits under the cap.
        ...(capped
          ? {
              ConditionExpression:
                '(attribute_not_exists(creditsUsed) AND :credits <= :cap) OR creditsUsed <= :capMinusCredits',
            }
          : {}),
        UpdateExpression: 'ADD creditsUsed :credits SET lastUpdated = :ts',
        ExpressionAttributeValues: {
          ':credits': { N: credits.toFixed(6) },
          ':ts': { S: new Date().toISOString() },
          ...(capped
            ? {
                ':cap': { N: String(cap!.hardCap) },
                ':capMinusCredits': { N: String(cap!.hardCap! - credits) },
              }
            : {}),
        },
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      // A concurrent write already consumed the remaining grant — the correct
      // outcome is the same block the pre-check would have thrown.
      throw new InvokeError(
        'PAUSED_FOR_CREDITS',
        `Tenant ${tenantId} credit balance exhausted by a concurrent invoke (grant: ${cap!.hardCap})`,
      );
    }
    throw err;
  }
}

/**
 * Emit telemetry.credits.consumed event to EventBridge.
 */
export async function emitCreditsTelemetry(opts: {
  tenantId: string;
  agent: string;
  module: string;
  feature: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  creditsConsumed: number;
  modelId: string;
  /** Register seat that served the call — per-seat cost attribution (COND-4) */
  seat: string;
  /** System op marker — billing consumer excludes from tenant invoicing (iso-kb-seeding) */
  systemOp?: boolean;
}): Promise<void> {
  try {
    await eb.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: BUS_NAME,
            Source: 'cumplify.ai-invoker',
            DetailType: 'telemetry.credits.consumed',
            Detail: JSON.stringify({
              tenantId: opts.tenantId,
              agent: opts.agent,
              module: opts.module,
              feature: opts.feature,
              inputTokens: opts.inputTokens,
              outputTokens: opts.outputTokens,
              cacheReadTokens: opts.cacheReadTokens,
              creditsConsumed: opts.creditsConsumed,
              modelId: opts.modelId,
              seat: opts.seat,
              systemOp: opts.systemOp ?? false,
              timestamp: new Date().toISOString(),
            }),
          },
        ],
      }),
    );
  } catch (err) {
    // Telemetry failure is non-blocking — log and continue
    logger.warn('Failed to emit credits telemetry', { error: (err as Error).message });
  }
}
