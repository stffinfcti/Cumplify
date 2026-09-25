/**
 * LeadAuditor handler dispatch tests (S4 Audit Studio).
 * Pins: SQS-shaped events route to the SQS path; findingsIntent payloads to
 * runAuditFindings; FINDINGS MODE carries auditId/checklist/prior findings;
 * requestedBy threads (SOD-1); audit-finding-write HITL-gated.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockToolLoop, mockSqsHandler, mockRetrieve } = vi.hoisted(() => ({
  mockToolLoop: vi.fn(),
  mockSqsHandler: vi.fn(),
  mockRetrieve: vi.fn(),
}));

vi.mock('../../shared/tool-loop.js', () => ({
  toolLoop: (...args: unknown[]) => mockToolLoop(...args),
}));

vi.mock('../../shared/invoke-transport.js', () => ({
  createInvokeFn: () => vi.fn(),
  createEmbedFn: () => vi.fn().mockResolvedValue({ embedding: Array(1024).fill(0.2) }),
}));

vi.mock('../../shared/retrieval.js', () => ({
  retrieve: (...args: unknown[]) => mockRetrieve(...args),
}));

vi.mock('../../../eventing/src/consumer.js', () => ({
  createHandler: () => mockSqsHandler,
}));

beforeEach(() => {
  mockToolLoop.mockReset();
  mockSqsHandler.mockReset();
  mockRetrieve.mockReset();
  mockRetrieve.mockResolvedValue({ chunks: [] });
  process.env.LEAD_AUDITOR_DLQ_URL = 'https://sqs.us-east-1.amazonaws.com/123/la-dlq';
  process.env.AOSS_ISO_KB_ENDPOINT = 'https://mock.aoss.amazonaws.com';
  process.env.AOSS_TENANT_DOCS_ENDPOINT = 'https://mock2.aoss.amazonaws.com';
});

import { handler, runAuditFindings } from '../handler.js';

const findingsInput = {
  tenantId: 'tenant-1',
  runId: 'run-66',
  requestedBy: 'user-9',
  findingsIntent: {
    auditId: 'audit-31',
    audit: { standard: 'ISO9001', scope: 'Fabrication shop', status: 'in_progress' },
    checklist: [
      {
        clauseRef: '8.5.1',
        question: 'Is production controlled?',
        expectedEvidence: 'Work orders',
      },
    ],
    priorFindings: [
      { findingType: 'observation', clauseRef: '7.2', description: 'Training log gap' },
    ],
  },
};

describe('LeadAuditor handler() dispatch', () => {
  it('routes SQS-shaped events to the SQS path', async () => {
    mockSqsHandler.mockResolvedValueOnce({ batchItemFailures: [] });
    const sqsEvent = { Records: [{ body: '{}' }] };
    const result = await handler(sqsEvent as never);
    expect(mockSqsHandler).toHaveBeenCalledWith(sqsEvent);
    expect(mockToolLoop).not.toHaveBeenCalled();
    expect(result).toEqual({ batchItemFailures: [] });
  });

  it('routes findingsIntent payloads to runAuditFindings', async () => {
    mockToolLoop.mockResolvedValueOnce({
      finalResponse: 'ok',
      turns: 1,
      totalUsage: { inputTokens: 1, outputTokens: 1 },
      hitlResult: { hitlItemId: 'h-4' },
    });
    const result = await handler(findingsInput);
    expect(mockSqsHandler).not.toHaveBeenCalled();
    expect(result).toEqual({ runId: 'run-66', status: 'PENDING_APPROVAL' });
  });
});

describe('runAuditFindings (S4)', () => {
  it('FINDINGS MODE: trusted framing rides plain, tenant text rides guardedText (S2.1 selective guardrail, found live on the S4 witness); requestedBy threaded; finding HITL-gated', async () => {
    mockToolLoop.mockResolvedValueOnce({
      finalResponse: 'ok',
      turns: 1,
      totalUsage: { inputTokens: 1, outputTokens: 1 },
    });

    await runAuditFindings(findingsInput);

    const [messages, opts] = mockToolLoop.mock.calls[0];
    const blocks = messages[0].content as Array<{ text?: string; guardedText?: string }>;
    const plain = blocks
      .filter((b) => b.text)
      .map((b) => b.text)
      .join('\n');
    const guarded = blocks
      .filter((b) => b.guardedText)
      .map((b) => b.guardedText)
      .join('\n');

    // Trusted framing: plain text only — never guard-evaluated
    expect(plain).toContain('FINDINGS MODE');
    expect(plain).toContain('audit-31');
    expect(plain).toContain('do NOT duplicate');
    // Tenant-typed content: guardedText only — never trusted
    expect(guarded).toContain('Fabrication shop');
    expect(guarded).toContain('8.5.1');
    expect(guarded).toContain('Is production controlled?');
    expect(guarded).toContain('Training log gap');
    expect(plain).not.toContain('Is production controlled?');
    expect(plain).not.toContain('Training log gap');

    expect(opts.requestedBy).toBe('user-9');
    expect(opts.feature).toBe('audit-findings');
    expect(opts.agent).toBe('LeadAuditor');
    expect(opts.hitlTools.has('audit-finding-write')).toBe(true);
  });

  it('grounding queries iso-kb as ISO canon and tenant-docs as the tenant (S2.2 lessons applied at build time)', async () => {
    mockToolLoop.mockResolvedValueOnce({
      finalResponse: 'ok',
      turns: 1,
      totalUsage: { inputTokens: 1, outputTokens: 1 },
    });

    await runAuditFindings(findingsInput);

    const calls = mockRetrieve.mock.calls.map(
      (c) => c[0] as { indexName: string; tenantId: string },
    );
    expect(calls.find((c) => c.indexName === 'cumplify-iso-kb')!.tenantId).toBe('__ISO_CANON__');
    expect(calls.find((c) => c.indexName === 'cumplify-tenant-docs')!.tenantId).toBe('tenant-1');
  });
});
