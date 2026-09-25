/**
 * M1 Approval Integrity tests (spec 40, Task 8 — BC-11, APR-1..3).
 * Negative path first: submit-while-unreviewed, submit-with-gap, self-approve.
 * Non-generated documents pass through unchanged.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExecute, mockCommit, mockRollback, mockPublishAuditEvent } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockCommit: vi.fn(),
  mockRollback: vi.fn(),
  mockPublishAuditEvent: vi.fn(),
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

import { handler } from '../../src/resolvers/m1.js';

const EMPTY_RESULT = { records: [], columnMetadata: [] };

function makeEvent(fieldName: string, args: Record<string, unknown> = {}) {
  return {
    info: { fieldName },
    arguments: args,
    identity: {
      resolverContext: { tenantId: 'tenant-test', sub: 'user-test', role: 'QualityManager' },
    },
  };
}

beforeEach(() => {
  mockExecute.mockReset().mockResolvedValue(EMPTY_RESULT);
  mockCommit.mockReset();
  mockRollback.mockReset();
  mockPublishAuditEvent.mockReset().mockResolvedValue('evt-test');
});

// ─── submitDocumentForApproval: APR-1/APR-3 preconditions ─────────────────────

describe('submitDocumentForApproval — NEGATIVE PATH FIRST', () => {
  it('UNREVIEWED_SECTIONS when generation run has unreviewed sections', async () => {
    // Call 1: generation run exists for this document
    mockExecute.mockResolvedValueOnce({
      records: [[{ stringValue: 'run-1' }, { stringValue: 'running' }]],
      columnMetadata: [{ name: 'id' }, { name: 'status' }],
    });
    // Call 2: combined readiness row — unreviewed = 3, gap_failed = 0
    mockExecute.mockResolvedValueOnce({
      records: [[{ longValue: 3 }, { longValue: 0 }]],
      columnMetadata: [{ name: 'unreviewed' }, { name: 'gap_failed' }],
    });

    await expect(handler(makeEvent('submitDocumentForApproval', { id: 'doc-1' }))).rejects.toThrow(
      'UNREVIEWED_SECTIONS',
    );

    expect(mockRollback).toHaveBeenCalled();
    expect(mockCommit).not.toHaveBeenCalled();
    // No status change written
    const allSqls = mockExecute.mock.calls.map((c) => c[0] as string);
    expect(allSqls.filter((s) => s.includes("status = 'in_review'"))).toHaveLength(0);
  });

  it('UNRESOLVED_GAPS when generation run has gap/failed sections', async () => {
    // Call 1: generation run exists
    mockExecute.mockResolvedValueOnce({
      records: [[{ stringValue: 'run-1' }, { stringValue: 'running' }]],
      columnMetadata: [{ name: 'id' }, { name: 'status' }],
    });
    // Call 2: combined readiness row — unreviewed = 0, gap_failed = 2
    mockExecute.mockResolvedValueOnce({
      records: [[{ longValue: 0 }, { longValue: 2 }]],
      columnMetadata: [{ name: 'unreviewed' }, { name: 'gap_failed' }],
    });

    await expect(handler(makeEvent('submitDocumentForApproval', { id: 'doc-1' }))).rejects.toThrow(
      'UNRESOLVED_GAPS',
    );

    expect(mockRollback).toHaveBeenCalled();
  });

  it('non-generated document (no run) submits normally without precondition checks', async () => {
    // Call 1: no generation run for this document
    mockExecute.mockResolvedValueOnce({
      records: [],
      columnMetadata: [{ name: 'id' }, { name: 'status' }],
    });
    // Call 2: status update (no precondition queries)
    mockExecute.mockResolvedValueOnce({
      records: [[{ stringValue: 'doc-1' }, { stringValue: 'in_review' }]],
      columnMetadata: [{ name: 'id' }, { name: 'status' }],
    });

    await handler(makeEvent('submitDocumentForApproval', { id: 'doc-1' }));

    // Only 2 execute calls (run check + status update), no section queries
    expect(mockExecute).toHaveBeenCalledTimes(2);
    expect(mockCommit).toHaveBeenCalled();
    // Audit event published
    expect(mockPublishAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        detailType: 'Document.SubmittedForApproval',
      }),
    );
  });

  it('precondition queries use real 011 column names with ::uuid casts', async () => {
    mockExecute.mockResolvedValueOnce({
      records: [[{ stringValue: 'run-1' }, { stringValue: 'running' }]],
      columnMetadata: [{ name: 'id' }, { name: 'status' }],
    });
    mockExecute.mockResolvedValueOnce({
      records: [[{ longValue: 0 }, { longValue: 0 }]],
      columnMetadata: [{ name: 'unreviewed' }, { name: 'gap_failed' }],
    });
    mockExecute.mockResolvedValueOnce({
      records: [[{ stringValue: 'doc-1' }]],
      columnMetadata: [{ name: 'id' }],
    });

    await handler(makeEvent('submitDocumentForApproval', { id: 'doc-1' }));

    // Run check uses manual_document_id with ::uuid
    const [runSql] = mockExecute.mock.calls[0];
    expect(runSql).toContain('qms.generation_runs');
    expect(runSql).toContain(':docId::uuid');
    expect(runSql).toContain('manual_document_id');

    // Section checks use run_id::uuid and real column names
    // One readiness query carries both FILTER predicates (single scan)
    const [readinessSql] = mockExecute.mock.calls[1];
    expect(readinessSql).toContain('qms.generation_sections');
    expect(readinessSql).toContain(':runId::uuid');
    expect(readinessSql).toContain('reviewed_at IS NULL');
    expect(readinessSql).toContain("status IN ('gap', 'failed')");
  });
});

// ─── approveDocumentVersion: BC-11 SoD ────────────────────────────────────────

describe('approveDocumentVersion — BC-11 SoD', () => {
  it('SOD_VIOLATION when approver === version created_by — writes NOTHING + publishes Security.SodViolationBlocked', async () => {
    // Call 1: version created_by = 'user-test' (same as actor from resolverContext)
    mockExecute.mockResolvedValueOnce({
      records: [[{ stringValue: 'user-test' }, { stringValue: 'in_review' }]],
      columnMetadata: [{ name: 'created_by' }, { name: 'doc_status' }],
    });

    await expect(
      handler(
        makeEvent('approveDocumentVersion', { input: { versionId: 'v-1', decision: 'APPROVED' } }),
      ),
    ).rejects.toThrow('SOD_VIOLATION');

    // Rollback called (before publish)
    expect(mockRollback).toHaveBeenCalled();
    expect(mockCommit).not.toHaveBeenCalled();
    // Security event published
    expect(mockPublishAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        detailType: 'Security.SodViolationBlocked',
        payload: expect.objectContaining({ attemptedBy: 'user-test', createdBy: 'user-test' }),
      }),
    );
    // No approval written
    const allSqls = mockExecute.mock.calls.map((c) => c[0] as string);
    expect(allSqls.filter((s) => s.includes('INSERT INTO m1.document_approvals'))).toHaveLength(0);
  });

  it('second-user approval succeeds when approver !== created_by', async () => {
    // Call 1: version created_by = 'other-user'
    mockExecute.mockResolvedValueOnce({
      records: [[{ stringValue: 'other-user' }, { stringValue: 'in_review' }]],
      columnMetadata: [{ name: 'created_by' }, { name: 'doc_status' }],
    });
    // Call 2: INSERT approval
    mockExecute.mockResolvedValueOnce({
      records: [
        [
          { stringValue: 'approval-1' },
          { stringValue: 'v-1' },
          { stringValue: 'user-test' },
          { stringValue: 'approved' },
        ],
      ],
      columnMetadata: [
        { name: 'id' },
        { name: 'document_version_id' },
        { name: 'approver_id' },
        { name: 'decision' },
      ],
    });

    await handler(
      makeEvent('approveDocumentVersion', { input: { versionId: 'v-1', decision: 'APPROVED' } }),
    );

    expect(mockCommit).toHaveBeenCalled();
    expect(mockPublishAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        detailType: 'Document.Approved',
      }),
    );
  });

  it('SoD check queries version with ::uuid cast', async () => {
    mockExecute.mockResolvedValueOnce({
      records: [[{ stringValue: 'other-user' }, { stringValue: 'in_review' }]],
      columnMetadata: [{ name: 'created_by' }, { name: 'doc_status' }],
    });
    mockExecute.mockResolvedValueOnce({
      records: [[{ stringValue: 'a-1' }]],
      columnMetadata: [{ name: 'id' }],
    });

    await handler(
      makeEvent('approveDocumentVersion', { input: { versionId: 'v-1', decision: 'APPROVED' } }),
    );

    const [sodSql] = mockExecute.mock.calls[0];
    expect(sodSql).toContain('m1.document_versions');
    expect(sodSql).toContain(':versionId::uuid');
    expect(sodSql).toContain('created_by');
  });
});
