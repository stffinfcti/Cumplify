/**
 * Unit tests for metering module.
 * Verifies: credit computation with wIn/wOut/wCache; null wCache fallback; atomic meter update;
 * telemetry.credits.consumed event shape (COND-4 cap alerting filters on detail.seat and
 * extracts detail.creditsConsumed as a metric value — both are contract).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock EventBridge (must precede module import)
const mockEbSend = vi.fn();
vi.mock('@aws-sdk/client-eventbridge', () => {
  return {
    EventBridgeClient: class {
      send = mockEbSend;
    },
    PutEventsCommand: class {
      input: unknown;
      constructor(input: unknown) {
        this.input = input;
      }
    },
  };
});

// Mock DynamoDB (incrementMeter UpdateItem)
const mockDdbSend = vi.fn();
vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class {
    send = mockDdbSend;
  },
  UpdateItemCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
  QueryCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

vi.stubEnv('TABLE_NAME', 'CumplifyCore');

const { computeCredits, emitCreditsTelemetry, incrementMeter } = await import('../src/metering.js');
import { InvokeError } from '../src/types.js';
import type { ModelWeight, TokenUsage } from '../src/types.js';

describe('computeCredits', () => {
  const novaProWeights: ModelWeight = {
    modelId: 'us.amazon.nova-pro-v1:0',
    wIn: 800, // $0.80/1M input → 800 credits/1M
    wOut: 3200, // $3.20/1M output → 3200 credits/1M
    wCache: 200, // $0.20/1M cached-read → 200 credits/1M
    effectiveFrom: '2026-07-08',
    sourceCommit: 'abc123',
  };

  const qwenWeights: ModelWeight = {
    modelId: 'qwen.qwen3-next-80b-a3b',
    wIn: 350,
    wOut: 1400,
    wCache: null, // No caching support
    effectiveFrom: '2026-07-08',
    sourceCommit: 'abc123',
  };

  it('computes credits for Nova Pro with all token types', () => {
    const usage: TokenUsage = {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadInputTokens: 2000,
      cacheWriteInputTokens: 0,
    };

    // (1000 × 800 + 2000 × 200 + 500 × 3200) / 1,000,000
    // = (800,000 + 400,000 + 1,600,000) / 1,000,000
    // = 2.8
    const credits = computeCredits(usage, novaProWeights);
    expect(credits).toBeCloseTo(2.8, 4);
  });

  it('computes credits with zero cache-read tokens', () => {
    const usage: TokenUsage = {
      inputTokens: 500,
      outputTokens: 200,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
    };

    // (500 × 800 + 0 × 200 + 200 × 3200) / 1,000,000
    // = (400,000 + 0 + 640,000) / 1,000,000
    // = 1.04
    const credits = computeCredits(usage, novaProWeights);
    expect(credits).toBeCloseTo(1.04, 4);
  });

  it('uses wIn as fallback when wCache is null (non-caching model)', () => {
    const usage: TokenUsage = {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadInputTokens: 0, // Will always be 0 for non-caching models
      cacheWriteInputTokens: 0,
    };

    // (1000 × 350 + 0 × 350 + 500 × 1400) / 1,000,000
    // = (350,000 + 0 + 700,000) / 1,000,000
    // = 1.05
    const credits = computeCredits(usage, qwenWeights);
    expect(credits).toBeCloseTo(1.05, 4);
  });

  it('handles wCache null fallback if cacheRead is somehow non-zero (safety guard)', () => {
    const usage: TokenUsage = {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadInputTokens: 100, // Should not happen for non-caching, but safety guard
      cacheWriteInputTokens: 0,
    };

    // (1000 × 350 + 100 × 350 (fallback to wIn) + 500 × 1400) / 1,000,000
    // = (350,000 + 35,000 + 700,000) / 1,000,000
    // = 1.085
    const credits = computeCredits(usage, qwenWeights);
    expect(credits).toBeCloseTo(1.085, 4);
  });

  it('returns 0 credits for zero-token usage', () => {
    const usage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
    };
    expect(computeCredits(usage, novaProWeights)).toBe(0);
  });

  it('computes credits for Titan Embed v2 (input-only, wOut=0, wCache=null)', () => {
    const titanEmbedWeights: ModelWeight = {
      modelId: 'amazon.titan-embed-text-v2:0',
      wIn: 20, // $0.02/1M input → 20 credits/1M
      wOut: 0, // embedding model: no output tokens
      wCache: null,
      effectiveFrom: '2026-07-16',
      sourceCommit: '349ce00',
    };
    const usage: TokenUsage = {
      inputTokens: 500,
      outputTokens: 0, // embeddings produce no output tokens
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
    };

    // (500 × 20 + 0 + 0) / 1,000,000 = 10,000 / 1,000,000 = 0.01
    const credits = computeCredits(usage, titanEmbedWeights);
    expect(credits).toBeCloseTo(0.01, 6);
  });
});

describe('emitCreditsTelemetry (telemetry.credits.consumed contract)', () => {
  beforeEach(() => {
    mockEbSend.mockReset();
    mockEbSend.mockResolvedValue({});
  });

  const opts = {
    tenantId: 'tenant-1',
    agent: 'legal-ledger',
    module: 'M8',
    feature: 'obligations',
    inputTokens: 13,
    outputTokens: 5,
    cacheReadTokens: 0,
    creditsConsumed: 0.029,
    modelId: 'zai.glm-5',
    seat: 'legal-ledger',
  };

  it('emits detail with seat and NUMERIC creditsConsumed (COND-4 metric filter contract)', async () => {
    await emitCreditsTelemetry(opts);

    expect(mockEbSend).toHaveBeenCalledTimes(1);
    const entry = (
      mockEbSend.mock.calls[0][0] as {
        input: { Entries: Array<{ Source: string; DetailType: string; Detail: string }> };
      }
    ).input.Entries[0];
    expect(entry.Source).toBe('cumplify.ai-invoker');
    expect(entry.DetailType).toBe('telemetry.credits.consumed');

    const detail = JSON.parse(entry.Detail);
    // COND-4 alert pipeline: EventBridge rule matches detail.seat; the CloudWatch
    // metric filter extracts detail.creditsConsumed — it must serialize as a number.
    expect(detail.seat).toBe('legal-ledger');
    expect(typeof detail.creditsConsumed).toBe('number');
    expect(detail.creditsConsumed).toBeCloseTo(0.029, 6);
    expect(detail.modelId).toBe('zai.glm-5');
    expect(detail.tenantId).toBe('tenant-1');
  });

  it('swallows EventBridge failures (telemetry is non-blocking)', async () => {
    mockEbSend.mockRejectedValueOnce(new Error('bus unavailable'));
    await expect(emitCreditsTelemetry(opts)).resolves.toBeUndefined();
  });
});

describe('incrementMeter — conditional ADD (TOCTOU)', () => {
  beforeEach(() => {
    mockDdbSend.mockReset();
    mockDdbSend.mockResolvedValue({});
  });

  it('carries the resolved hard cap as a ConditionExpression on the write', async () => {
    await incrementMeter('tenant-1', 12.5, { hardCap: 15000 });

    expect(mockDdbSend).toHaveBeenCalledTimes(1);
    const input = (mockDdbSend.mock.calls[0][0] as { input: Record<string, unknown> }).input;
    expect(input.UpdateExpression).toBe('ADD creditsUsed :credits SET lastUpdated = :ts');
    expect(input.ConditionExpression).toBe(
      'attribute_not_exists(creditsUsed) OR creditsUsed < :cap',
    );
    const values = input.ExpressionAttributeValues as Record<string, { N?: string }>;
    expect(values[':cap'].N).toBe('15000');
    expect(values[':credits'].N).toBe('12.500000');
  });

  it('writes unconditionally when the tenant has no hard cap (exempt/enterprise/paygo)', async () => {
    await incrementMeter('tenant-1', 3.25, {});

    const input = (mockDdbSend.mock.calls[0][0] as { input: Record<string, unknown> }).input;
    expect(input.ConditionExpression).toBeUndefined();
    const values = input.ExpressionAttributeValues as Record<string, unknown>;
    expect(values[':cap']).toBeUndefined();
  });

  it('a rejected conditional write surfaces PAUSED_FOR_CREDITS (concurrent race lost)', async () => {
    const err = new Error('condition failed');
    (err as { name?: string }).name = 'ConditionalCheckFailedException';
    mockDdbSend.mockRejectedValueOnce(err);

    try {
      await incrementMeter('tenant-1', 500, { hardCap: 15000 });
      expect.fail('Should have thrown');
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(InvokeError);
      expect((thrown as InvokeError).code).toBe('PAUSED_FOR_CREDITS');
    }
  });

  it('propagates non-condition write errors unchanged', async () => {
    mockDdbSend.mockRejectedValueOnce(new Error('throttled'));

    await expect(incrementMeter('tenant-1', 1, { hardCap: 15000 })).rejects.toThrow('throttled');
  });
});
