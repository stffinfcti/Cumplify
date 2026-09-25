/**
 * Unit tests for weight-seeder module.
 * Verifies: seed data loads without runtime fs/require; ConditionalCheckFailed handled.
 *
 * Task 2 (architect-executed) landed the REAL seed — assertions updated from the
 * placeholder-era 'no-data' expectations to the populated-seed behavior, and the
 * Task-2 acceptance criteria are encoded as CI assertions against the seed file.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();
vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class {
    send = mockSend;
  },
  PutItemCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));
vi.mock('@aws-sdk/util-dynamodb', () => ({
  marshall: (obj: unknown) => obj,
}));
vi.stubEnv('TABLE_NAME', 'CumplifyCore');

const { handler } = await import('../src/weight-seeder.js');
const seed = (await import('../data/model-weights-seed.json')).default as unknown as {
  capturedAt: string;
  sourceCommit: string;
  models: Record<string, { wIn: number; wOut: number; wCache: number | null }>;
};

const IN_SCOPE_MODELS = [
  'us.amazon.nova-pro-v1:0',
  'us.amazon.nova-lite-v1:0',
  'qwen.qwen3-next-80b-a3b',
  'moonshotai.kimi-k2.5',
  'zai.glm-5', // legal-ledger ASSIGNED at Task 14 (live-API $1.00/$3.20)
  'amazon.titan-embed-text-v2:0', // spec-35 Task 2: embedding model (wOut=0, input-only)
];

describe('weight-seeder', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
  });

  it('loads seed data at module level (bundled inline, no runtime fs)', async () => {
    // Real seed has 6 models (titan-embed added at spec-35 Task 2) — handler seeds all.
    // This proves the import resolved at bundle time without ENOENT.
    const result = await handler({ action: 'seed' });
    expect(result.status).toBe('success');
    expect(result.seeded).toBe(6);
    expect(result.skipped).toBe(0);
    expect(mockSend).toHaveBeenCalledTimes(6);
  });

  it('skips non-seed actions', async () => {
    const result = await handler({ action: 'other' });
    expect(result.status).toBe('skipped');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('handles ConditionalCheckFailedException by skipping (T3E-F3)', async () => {
    const condError = new Error('Conditional check failed');
    condError.name = 'ConditionalCheckFailedException';
    mockSend.mockRejectedValueOnce(condError);

    // First model already seeded → skipped; remaining 5 seed normally.
    const result = await handler({ action: 'seed' });
    expect(result.status).toBe('success');
    expect(result.seeded).toBe(5);
    expect(result.skipped).toBe(1);
  });

  it('omits wCache attribute for null-wCache models (qwen/kimi)', async () => {
    await handler({ action: 'seed' });
    const items = mockSend.mock.calls.map(
      (c) => (c[0] as { input: { Item: Record<string, unknown> } }).input.Item,
    );
    const byModel = Object.fromEntries(items.map((i) => [i.modelId as string, i]));
    expect(byModel['us.amazon.nova-pro-v1:0'].wCache).toBe(200);
    expect(byModel['us.amazon.nova-lite-v1:0'].wCache).toBe(15);
    expect('wCache' in byModel['qwen.qwen3-next-80b-a3b']).toBe(false);
    expect('wCache' in byModel['moonshotai.kimi-k2.5']).toBe(false);
  });

  // ── Task 2 acceptance criteria, encoded against the committed seed file ──

  it('ACCEPTANCE: all in-scope models present with numeric wIn > 0; generation models wOut > 0', () => {
    expect(Object.keys(seed.models).sort()).toEqual([...IN_SCOPE_MODELS].sort());
    for (const id of IN_SCOPE_MODELS) {
      expect(seed.models[id].wIn).toBeGreaterThan(0);
    }
    // Generation models must have wOut > 0; embedding models have wOut = 0
    const GENERATION_MODELS = IN_SCOPE_MODELS.filter((m) => m !== 'amazon.titan-embed-text-v2:0');
    for (const id of GENERATION_MODELS) {
      expect(seed.models[id].wOut).toBeGreaterThan(0);
    }
    // Embedding model: wOut = 0 (no output tokens)
    expect(seed.models['amazon.titan-embed-text-v2:0'].wOut).toBe(0);
  });

  it('ACCEPTANCE: Nova Pro/Lite have wCache defined; qwen/kimi/titan-embed have wCache null', () => {
    expect(seed.models['us.amazon.nova-pro-v1:0'].wCache).toBeGreaterThan(0);
    expect(seed.models['us.amazon.nova-lite-v1:0'].wCache).toBeGreaterThan(0);
    expect(seed.models['qwen.qwen3-next-80b-a3b'].wCache).toBeNull();
    expect(seed.models['moonshotai.kimi-k2.5'].wCache).toBeNull();
    expect(seed.models['amazon.titan-embed-text-v2:0'].wCache).toBeNull();
  });

  it('ACCEPTANCE: provenance present (capturedAt ISO, sourceCommit sha)', () => {
    expect(new Date(seed.capturedAt).toString()).not.toBe('Invalid Date');
    expect(seed.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
  });
});
