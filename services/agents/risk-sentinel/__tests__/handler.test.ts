/**
 * RiskSentinel handler tests (RS-8, read-surface-completion).
 * Pins: requestedBy threads through to toolLoop for SOD-1; risk context
 * (description, category, current rating, related-register context) lands
 * in the prompt message; status reflects whether a proposal (HITL gate)
 * resulted.
 *
 * Mocks toolLoop directly — Bedrock/HITL internals are covered by
 * tool-loop.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockToolLoop } = vi.hoisted(() => ({ mockToolLoop: vi.fn() }));

vi.mock('../../shared/tool-loop.js', () => ({
  toolLoop: (...args: unknown[]) => mockToolLoop(...args),
}));

vi.mock('../../shared/invoke-transport.js', () => ({
  createInvokeFn: () => vi.fn(),
}));

beforeEach(() => {
  mockToolLoop.mockReset();
});

import { handler, runAssessment } from '../handler.js';

const baseInput = {
  tenantId: 'tenant-1',
  runId: 'run-1',
  riskId: 'risk-1',
  requestedBy: 'user-9',
  context: {
    description: 'Supplier quality drift on component X',
    category: 'quality' as const,
    standard: 'ISO9001' as const,
    currentLikelihood: 2,
    currentSeverity: 3,
  },
};

describe('runAssessment', () => {
  it('threads requestedBy + the risk-assessment-write tool into toolLoop (SOD-1)', async () => {
    mockToolLoop.mockResolvedValueOnce({
      finalResponse: 'ok',
      turns: 1,
      totalUsage: { inputTokens: 1, outputTokens: 1 },
    });

    await runAssessment(baseInput);

    const [, opts] = mockToolLoop.mock.calls[0];
    expect(opts.requestedBy).toBe('user-9');
    expect(opts.hitlTools).toEqual(new Set(['risk-assessment-write']));
    expect(opts.agent).toBe('RiskSentinel');
    expect(opts.module).toBe('M5');
    expect(opts.seat).toBe('workhorse');
  });

  it('includes the current rating + related-register context in the prompt message', async () => {
    mockToolLoop.mockResolvedValueOnce({
      finalResponse: 'ok',
      turns: 1,
      totalUsage: { inputTokens: 1, outputTokens: 1 },
    });

    await runAssessment({
      ...baseInput,
      context: { ...baseInput.context, relatedContext: 'Hazard H-12 recurred twice this quarter' },
    });

    const [messages] = mockToolLoop.mock.calls[0];
    const text = messages[0].content[0].text;
    expect(text).toContain('likelihood=2, severity=3');
    expect(text).toContain('Hazard H-12 recurred twice this quarter');
  });

  it('omits the related-register block entirely when no context is supplied', async () => {
    mockToolLoop.mockResolvedValueOnce({
      finalResponse: 'ok',
      turns: 1,
      totalUsage: { inputTokens: 1, outputTokens: 1 },
    });

    await runAssessment(baseInput);

    const [messages] = mockToolLoop.mock.calls[0];
    const text = messages[0].content[0].text;
    expect(text).not.toContain('Related-register context');
  });

  it('status is PENDING_APPROVAL when toolLoop enters the HITL gate', async () => {
    mockToolLoop.mockResolvedValueOnce({
      finalResponse: 'proposed',
      turns: 1,
      totalUsage: { inputTokens: 1, outputTokens: 1 },
      hitlResult: { status: 'HITL_PENDING', executionArn: 'arn:x', hitlItemId: 'hitl-1' },
    });

    const result = await runAssessment(baseInput);
    expect(result).toEqual({ runId: 'run-1', status: 'PENDING_APPROVAL' });
  });

  it('status is NO_PROPOSAL when the model does not call the tool', async () => {
    mockToolLoop.mockResolvedValueOnce({
      finalResponse: 'Context insufficient, keeping current rating.',
      turns: 1,
      totalUsage: { inputTokens: 1, outputTokens: 1 },
    });

    const result = await runAssessment(baseInput);
    expect(result).toEqual({ runId: 'run-1', status: 'NO_PROPOSAL' });
  });
});

describe('handler (Lambda:Invoke entry point)', () => {
  it('delegates directly to runAssessment', async () => {
    mockToolLoop.mockResolvedValueOnce({
      finalResponse: 'ok',
      turns: 1,
      totalUsage: { inputTokens: 1, outputTokens: 1 },
    });

    const result = await handler(baseInput);
    expect(result).toEqual({ runId: 'run-1', status: 'NO_PROPOSAL' });
  });
});
