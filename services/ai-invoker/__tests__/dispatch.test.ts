/**
 * Unit tests for handler() entry dispatch — spec-35 Task 3 (F-1 binding).
 * Verifies: op:'embed' routes to embed; absent op routes to invoke (back-compat).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the embed and invoke modules so we can verify routing
const mockEmbed = vi.fn();
const mockInvoke = vi.fn();

vi.mock('../src/embed.js', () => ({
  embed: (...args: unknown[]) => mockEmbed(...args),
}));

// We need to mock the entire module graph that invoke() pulls in
vi.mock('../src/register-resolver.js', () => ({
  resolveModel: () => ({
    modelId: 'us.amazon.nova-pro-v1:0',
    tier: 'workhorse',
    cachingSupported: true,
  }),
}));
vi.mock('../src/converse.js', () => ({
  converse: () =>
    Promise.resolve({
      text: 'ok',
      toolUseBlocks: [],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
      rawResponse: {},
    }),
}));
vi.mock('../src/metering.js', () => ({
  computeCredits: () => 0.001,
  loadWeights: () =>
    Promise.resolve({
      modelId: 'x',
      wIn: 800,
      wOut: 3200,
      wCache: 200,
      effectiveFrom: '',
      sourceCommit: '',
    }),
  incrementMeter: () => Promise.resolve(),
  emitCreditsTelemetry: () => Promise.resolve(),
}));
vi.mock('../src/credit-precheck.js', () => ({
  checkCreditBalance: () => Promise.resolve(),
}));
vi.mock('../src/guardrail.js', () => ({
  buildGuardrailConfig: () => undefined,
}));

vi.stubEnv('TABLE_NAME', 'CumplifyCore');
vi.stubEnv('BUS_NAME', 'cumplify-events');

const { handler } = await import('../src/index.js');

describe('handler dispatch (F-1)', () => {
  beforeEach(() => {
    mockEmbed.mockReset();
    mockInvoke.mockReset();
  });

  it('routes {op:"embed"} to embed()', async () => {
    mockEmbed.mockResolvedValueOnce({ embedding: [0.1], tokenCount: 5, credits: 0.0001 });

    const result = await handler({
      op: 'embed',
      tenantId: 'tenant-1',
      agent: 'guru-9001',
      module: 'M1',
      feature: 'advisory',
      text: 'hello',
    });

    expect(mockEmbed).toHaveBeenCalledTimes(1);
    expect(mockEmbed).toHaveBeenCalledWith(
      expect.objectContaining({
        op: 'embed',
        tenantId: 'tenant-1',
        text: 'hello',
      }),
    );
    expect(result).toEqual({ embedding: [0.1], tokenCount: 5, credits: 0.0001 });
  });

  it('routes absent op to invoke() (back-compat)', async () => {
    // handler() calls invoke() which is the real function (mocked dependencies above)
    const result = await handler({
      seat: 'workhorse',
      messages: [{ role: 'user', content: [{ text: 'hi' }] }],
      tenantId: 'tenant-1',
      agent: 'test',
      module: 'M1',
      feature: 'advisory',
    } as any);

    // Should have gone through the invoke path (converse mock returns 'ok')
    expect(result).toHaveProperty('text', 'ok');
    expect(result).toHaveProperty('credits');
    // embed should NOT have been called
    expect(mockEmbed).not.toHaveBeenCalled();
  });
});
