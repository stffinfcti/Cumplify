/**
 * m3 runAuditFindings dispatch test (B1.3) — pinned shape from
 * qms.runManualSectionDraft:
 * - Guards (auditId validation, LEAD_AUDITOR_FN_ARN check)
 * - Call-time env read (LEAD_AUDITOR_FN_ARN read inside the handler, not at module scope — L4)
 * - Event-invoke payload structure
 * - NO publishAuditEvent at dispatch (L3: dispatch mutations never audit — HITL plane owns the trail)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExecute, mockCommit, mockRollback, mockPublishAuditEvent, mockLambdaSend } = vi.hoisted(
  () => ({
    mockExecute: vi.fn(),
    mockCommit: vi.fn(),
    mockRollback: vi.fn(),
    mockPublishAuditEvent: vi.fn(),
    mockLambdaSend: vi.fn(),
  }),
);

vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class {
    send = mockLambdaSend;
  },
  InvokeCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('../../src/resolvers/shared.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/resolvers/shared.js')>();
  return {
    ...actual,
    beginTenantTransaction: vi.fn().mockResolvedValue({
      transactionId: 'txn-test',
      execute: mockExecute,
      commit: mockCommit,
      rollback: mockRollback,
    }),
    publishAuditEvent: mockPublishAuditEvent,
  };
});

vi.mock('@aws-lambda-powertools/logger', () => ({
  Logger: class {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    appendKeys = vi.fn();
  },
}));

// L4: env var read at CALL time — set before import
process.env.LEAD_AUDITOR_FN_ARN =
  'arn:aws:lambda:us-east-1:123:function:cumplify-lead-auditor-test';

import { handler } from '../../src/resolvers/m3.js';

function makeEvent(fieldName: string, args: Record<string, unknown> = {}) {
  return {
    info: { fieldName },
    arguments: args,
    identity: {
      resolverContext: { tenantId: 'tenant-test', sub: 'user-test', role: 'InternalAuditor' },
    },
  };
}

beforeEach(() => {
  mockExecute.mockReset();
  mockCommit.mockReset();
  mockRollback.mockReset();
  mockPublishAuditEvent.mockReset().mockResolvedValue('evt-test');
  mockLambdaSend.mockReset().mockResolvedValue({});
});

describe('runAuditFindings (S4 Audit Studio dispatch)', () => {
  function wireReads() {
    // 1: audit row (validate existence + read standard/scope/status)
    mockExecute.mockResolvedValueOnce({
      records: [
        [
          { stringValue: 'audit-1' },
          { stringValue: 'ISO9001' },
          { stringValue: 'Fabrication shop processes' },
          { stringValue: 'planned' },
        ],
      ],
      columnMetadata: [{ name: 'id' }, { name: 'standard' }, { name: 'scope' }, { name: 'status' }],
    });
    // 2: checklist rows
    mockExecute.mockResolvedValueOnce({
      records: [
        [
          { stringValue: '9.2' },
          { stringValue: 'Does the organization conduct internal audits?' },
          { stringValue: 'audit plans, records' },
        ],
      ],
      columnMetadata: [{ name: 'clause_ref' }, { name: 'question' }, { name: 'expected_evidence' }],
    });
    // 3: prior findings
    mockExecute.mockResolvedValueOnce({
      records: [
        [
          { stringValue: 'minor_nc' },
          { stringValue: '4.2' },
          { stringValue: 'Interested parties not fully identified' },
        ],
      ],
      columnMetadata: [{ name: 'finding_type' }, { name: 'clause_ref' }, { name: 'description' }],
    });
  }

  it('reads context, Event-invokes LeadAuditor with findingsIntent, acks DISPATCHED — and publishes NO audit event (L3: fail-closed registry, HITL plane owns the trail)', async () => {
    wireReads();
    const result = (await handler(
      makeEvent('runAuditFindings', { auditId: 'a3f1c6d2-8b4e-4f5a-9c6d-1e2f3a4b5c6d' }),
    )) as {
      runId: string;
      status: string;
    };

    expect(result.status).toBe('DISPATCHED');
    expect(result.runId).toBeTruthy();

    // Event-invoke to LeadAuditor
    expect(mockLambdaSend).toHaveBeenCalledOnce();
    const cmd = mockLambdaSend.mock.calls[0][0] as {
      input: { FunctionName: string; InvocationType: string; Payload: string };
    };
    expect(cmd.input.InvocationType).toBe('Event');
    expect(cmd.input.FunctionName).toBe(
      'arn:aws:lambda:us-east-1:123:function:cumplify-lead-auditor-test',
    );

    const payload = JSON.parse(cmd.input.Payload);
    expect(payload.tenantId).toBe('tenant-test');
    expect(payload.requestedBy).toBe('user-test');
    expect(payload.runId).toBe(result.runId);
    expect(payload.findingsIntent.auditId).toBe('a3f1c6d2-8b4e-4f5a-9c6d-1e2f3a4b5c6d');
    expect(payload.findingsIntent.audit.standard).toBe('ISO9001');
    expect(payload.findingsIntent.audit.scope).toBe('Fabrication shop processes');
    expect(payload.findingsIntent.audit.status).toBe('planned');
    expect(payload.findingsIntent.checklist).toHaveLength(1);
    expect(payload.findingsIntent.checklist[0].clauseRef).toBe('9.2');
    expect(payload.findingsIntent.priorFindings).toHaveLength(1);
    expect(payload.findingsIntent.priorFindings[0].findingType).toBe('MINOR_NC');

    // L3: dispatch mutations NEVER publishAuditEvent — the registry is fail-closed
    // and throws AFTER the invoke, failing the mutation while the agent run proceeds.
    // HITL plane owns the audit trail.
    expect(mockPublishAuditEvent).not.toHaveBeenCalled();
  });

  it('VALIDATION: rejects empty auditId', async () => {
    await expect(handler(makeEvent('runAuditFindings', { auditId: '' }))).rejects.toThrow(
      'VALIDATION',
    );
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  it('AUDIT_NOT_FOUND when audit does not exist', async () => {
    mockExecute.mockResolvedValueOnce({ records: [], columnMetadata: [] });

    await expect(
      handler(makeEvent('runAuditFindings', { auditId: 'b4e2d7f3-9c5a-4e6b-8d7f-2a3b4c5d6e7f' })),
    ).rejects.toThrow('AUDIT_NOT_FOUND');
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  it('LEAD_AUDITOR_NOT_AVAILABLE when env var is empty', async () => {
    const original = process.env.LEAD_AUDITOR_FN_ARN;
    process.env.LEAD_AUDITOR_FN_ARN = '';
    try {
      await expect(
        handler(makeEvent('runAuditFindings', { auditId: 'a3f1c6d2-8b4e-4f5a-9c6d-1e2f3a4b5c6d' })),
      ).rejects.toThrow('LEAD_AUDITOR_NOT_AVAILABLE');
      expect(mockLambdaSend).not.toHaveBeenCalled();
    } finally {
      process.env.LEAD_AUDITOR_FN_ARN = original;
    }
  });
});
