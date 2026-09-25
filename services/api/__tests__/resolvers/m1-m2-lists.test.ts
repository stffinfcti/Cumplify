/**
 * Unit tests for the M1/M2 list-query resolvers (frontend-app Phase C read
 * surface, architect 2026-07-13): listDocuments (filter fix),
 * listDocumentVersions, listNonconformities, listOpenCAPAs (SQL fix),
 * listCorrectiveActions.
 *
 * Mocks shared.js at the transaction boundary and asserts the executed SQL +
 * parameters — the listOpenCAPAs column bugs (nc.title, nonconformity_id)
 * would have been caught at this layer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExecute, mockCommit, mockRollback } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockCommit: vi.fn(),
  mockRollback: vi.fn(),
}));

vi.mock('../../src/resolvers/shared.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/resolvers/shared.js')>();
  return {
    ...actual,
    beginTenantTransaction: vi.fn().mockResolvedValue({
      execute: mockExecute,
      commit: mockCommit,
      rollback: mockRollback,
    }),
    publishAuditEvent: vi.fn().mockResolvedValue('evt-test'),
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

import { handler as m1Handler } from '../../src/resolvers/m1.js';
import { handler as m2Handler } from '../../src/resolvers/m2.js';

const EMPTY_RESULT = { records: undefined, columnMetadata: undefined };

function makeEvent(fieldName: string, args: Record<string, unknown> = {}) {
  return {
    info: { fieldName },
    arguments: args,
    identity: { resolverContext: { tenantId: 'tenant-test', sub: 'user-test', role: 'IMSLead' } },
  };
}

beforeEach(() => {
  mockExecute.mockReset().mockResolvedValue(EMPTY_RESULT);
  mockCommit.mockReset();
  mockRollback.mockReset();
});

describe('m1 listDocuments — filters honored (previously ignored)', () => {
  it('no filters: no WHERE clause, no params', async () => {
    await m1Handler(makeEvent('listDocuments'));
    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).not.toContain('WHERE');
    expect(sql).toContain('ORDER BY created_at DESC');
    expect(params).toEqual([]);
    expect(mockCommit).toHaveBeenCalled();
  });

  it('standard + status filters: WHERE with both, status mapped to lowercase', async () => {
    await m1Handler(makeEvent('listDocuments', { standard: 'ISO14001', status: 'IN_REVIEW' }));
    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('WHERE standard = :standard AND status = :status');
    expect(params).toEqual([
      { name: 'standard', value: { stringValue: 'ISO14001' } },
      { name: 'status', value: { stringValue: 'in_review' } },
    ]);
  });
});

describe('m1 listDocuments — RS-1 clauseRefs (real Data-API arrayValue fixture)', () => {
  it('marshals m1.documents.clause_refs TEXT[] into Document.clauseRefs', async () => {
    mockExecute.mockResolvedValueOnce({
      records: [
        [{ stringValue: 'doc-1' }, { arrayValue: { stringValues: ['9.1', '9.2', '10.2'] } }],
      ],
      columnMetadata: [{ name: 'id' }, { name: 'clause_refs' }],
    });
    const result = await m1Handler(makeEvent('listDocuments'));
    expect(result).toEqual([{ id: 'doc-1', clauseRefs: ['9.1', '9.2', '10.2'] }]);
  });

  it('NULL clause_refs marshals to null, not an error', async () => {
    mockExecute.mockResolvedValueOnce({
      records: [[{ stringValue: 'doc-2' }, { isNull: true }]],
      columnMetadata: [{ name: 'id' }, { name: 'clause_refs' }],
    });
    const result = await m1Handler(makeEvent('listDocuments'));
    expect(result).toEqual([{ id: 'doc-2', clauseRefs: null }]);
  });
});

describe('m1 listDocumentVersions', () => {
  it('selects versions for the document ordered by version_no DESC', async () => {
    await m1Handler(makeEvent('listDocumentVersions', { documentId: 'doc-1' }));
    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('FROM m1.document_versions');
    expect(sql).toContain('WHERE document_id = :documentId::uuid');
    expect(sql).toContain('ORDER BY version_no DESC');
    expect(params).toEqual([{ name: 'documentId', value: { stringValue: 'doc-1' } }]);
  });

  it('rolls back and rethrows on execute failure', async () => {
    mockExecute.mockRejectedValueOnce(new Error('boom'));
    await expect(
      m1Handler(makeEvent('listDocumentVersions', { documentId: 'doc-1' })),
    ).rejects.toThrow('boom');
    expect(mockRollback).toHaveBeenCalled();
  });
});

describe('m2 listNonconformities', () => {
  it('no filters: full register ordered by raised_at DESC', async () => {
    await m2Handler(makeEvent('listNonconformities'));
    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('FROM m2.nonconformities');
    expect(sql).not.toContain('WHERE');
    expect(sql).toContain('ORDER BY raised_at DESC');
    expect(params).toEqual([]);
  });

  it('severity filter mapped to lowercase CHECK value', async () => {
    await m2Handler(
      makeEvent('listNonconformities', { standard: 'ISO9001', severity: 'CRITICAL' }),
    );
    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('standard = :standard');
    expect(sql).toContain('severity = :severity');
    expect(params).toContainEqual({ name: 'severity', value: { stringValue: 'critical' } });
  });
});

describe('m2 listOpenCAPAs — SQL fix regression', () => {
  it('joins on ca.nc_id and never references nc.title or nonconformity_id', async () => {
    await m2Handler(makeEvent('listOpenCAPAs'));
    const [sql] = mockExecute.mock.calls[0];
    expect(sql).toContain('JOIN m2.nonconformities nc ON nc.id = ca.nc_id');
    expect(sql).not.toContain('nc.title');
    expect(sql).not.toContain('nonconformity_id');
    expect(sql).toContain(`ca.status IN ('open', 'in_progress')`);
  });

  it('standard/severity filters apply to the joined NC row', async () => {
    await m2Handler(makeEvent('listOpenCAPAs', { standard: 'ISO45001', severity: 'HIGH' }));
    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('nc.standard = :standard');
    expect(sql).toContain('nc.severity = :severity');
    expect(params).toEqual([
      { name: 'standard', value: { stringValue: 'ISO45001' } },
      { name: 'severity', value: { stringValue: 'high' } },
    ]);
  });
});

describe('m2 listCorrectiveActions', () => {
  it('selects CAs for the NC (any status) ordered by created_at', async () => {
    await m2Handler(makeEvent('listCorrectiveActions', { ncId: 'nc-9' }));
    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('FROM m2.corrective_actions');
    expect(sql).toContain('WHERE nc_id = :ncId::uuid');
    expect(sql).toContain('ORDER BY created_at ASC');
    expect(params).toEqual([{ name: 'ncId', value: { stringValue: 'nc-9' } }]);
  });
});
