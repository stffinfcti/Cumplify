/**
 * Unit tests for the M2 resolver SQL fixes (full-phase validation, architect
 * 2026-07-14): all four M2 mutations (recordRootCause, createCorrectiveAction,
 * closeCapa, verifyEffectiveness) were still written against the stale/draft
 * schema — the dd605b0 round fixed M3/M4 only, and m2.ts mutations were outside
 * its blast radius. Wrong tables, nonexistent columns, and wrong input field
 * names made every call a guaranteed runtime failure.
 *
 * Also covers the same-round fixes: m5 getCrossRegisterRiskView filter args
 * (previously ignored — M5 filter bar was a live no-op), m3 recordFinding
 * ::uuid cast on checklist_id, and the shared.ts CAPAStatus reverse-map
 * (DB lowercase → GraphQL UPPERCASE) that M2 reads depend on.
 *
 * Same layer as m3-m4-m5-fixes.test.ts: mocks shared.js at the transaction
 * boundary and asserts executed SQL + parameters.
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

import { handler as m2Handler } from '../../src/resolvers/m2.js';
import { handler as m3Handler } from '../../src/resolvers/m3.js';
import { handler as m5Handler } from '../../src/resolvers/m5.js';
import { marshalMany } from '../../src/resolvers/shared.js';

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

describe('m2 recordRootCause — stale-schema fix regression', () => {
  it('inserts into m2.root_cause_analyses (not UPDATE nonconformities root_cause)', async () => {
    await m2Handler(
      makeEvent('recordRootCause', {
        input: {
          ncId: 'nc-1',
          method: '5why',
          findings: 'Line 3 skipped QC',
          rootCauseSummary: 'Missing checklist step',
        },
      }),
    );
    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('INSERT INTO m2.root_cause_analyses');
    expect(sql).not.toContain('root_cause_method');
    expect(sql).toContain('root_cause_summary');
    expect(params).toContainEqual({ name: 'ncId', value: { stringValue: 'nc-1' } });
    expect(params).toContainEqual({
      name: 'findings',
      value: { stringValue: 'Line 3 skipped QC' },
    });
    expect(params).toContainEqual({
      name: 'rootCauseSummary',
      value: { stringValue: 'Missing checklist step' },
    });
  });

  it('normalizes UPPERCASE method to the DB CHECK vocabulary (5WHY → 5why)', async () => {
    await m2Handler(
      makeEvent('recordRootCause', {
        input: { ncId: 'nc-1', method: 'FISHBONE', findings: 'f', rootCauseSummary: 's' },
      }),
    );
    const [, params] = mockExecute.mock.calls[0];
    expect(params).toContainEqual({ name: 'method', value: { stringValue: 'fishbone' } });
  });

  it('advances the NC open → in_progress in the same transaction (before commit)', async () => {
    await m2Handler(
      makeEvent('recordRootCause', {
        input: { ncId: 'nc-1', method: '5why', findings: 'f', rootCauseSummary: 's' },
      }),
    );
    expect(mockExecute).toHaveBeenCalledTimes(2);
    const [sql, params] = mockExecute.mock.calls[1];
    expect(sql).toContain(`SET status = 'in_progress'`);
    expect(sql).toContain(`AND status = 'open'`);
    expect(params).toEqual([{ name: 'ncId', value: { stringValue: 'nc-1' } }]);
    // status advance happens inside the txn: both executes precede the commit
    expect(mockCommit).toHaveBeenCalledTimes(1);
  });
});

describe('m2 createCorrectiveAction — stale-schema fix regression', () => {
  it('inserts into nc_id (not nonconformity_id), reads input.ncId, wires containment_flag', async () => {
    await m2Handler(
      makeEvent('createCorrectiveAction', {
        input: {
          ncId: 'nc-1',
          actionDesc: 'Retrain operators',
          ownerId: 'u2',
          dueDate: '2027-01-01T00:00:00.000Z',
          containmentFlag: true,
        },
      }),
    );
    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('nc_id');
    expect(sql).not.toContain('nonconformity_id');
    expect(sql).toContain('containment_flag');
    expect(params).toContainEqual({ name: 'ncId', value: { stringValue: 'nc-1' } });
    expect(params).toContainEqual({ name: 'containmentFlag', value: { booleanValue: true } });
  });

  it('defaults containment_flag to false when the optional input field is absent', async () => {
    await m2Handler(
      makeEvent('createCorrectiveAction', {
        input: {
          ncId: 'nc-1',
          actionDesc: 'a',
          ownerId: 'u2',
          dueDate: '2027-01-01T00:00:00.000Z',
        },
      }),
    );
    const [, params] = mockExecute.mock.calls[0];
    expect(params).toContainEqual({ name: 'containmentFlag', value: { booleanValue: false } });
  });
});

describe('m2 closeCapa — stale-schema fix regression', () => {
  it('sets only real columns (no closed_at/closed_by) and reads input.id', async () => {
    // RETURNING must yield the closed row — an empty result means the
    // status predicate rejected the write (not found / already closed).
    mockExecute.mockResolvedValueOnce({
      records: [[{ stringValue: 'ca-1' }]],
      columnMetadata: [{ name: 'id' }],
    });
    await m2Handler(makeEvent('closeCapa', { input: { id: 'ca-1', closureNotes: 'done' } }));
    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain(`SET status = 'closed'`);
    expect(sql).toContain(`AND status <> 'closed'`); // check-then-act predicate rides the UPDATE
    expect(sql).not.toContain('closed_at');
    expect(sql).not.toContain('closed_by');
    expect(params).toEqual([{ name: 'id', value: { stringValue: 'ca-1' } }]);
  });

  it('rejects a double-close — empty RETURNING throws CAPA_NOT_FOUND_OR_ALREADY_CLOSED', async () => {
    await expect(
      m2Handler(makeEvent('closeCapa', { input: { id: 'ca-1' } })),
    ).rejects.toThrow('CAPA_NOT_FOUND_OR_ALREADY_CLOSED');
  });
});

describe('m2 verifyEffectiveness — stale-schema fix regression', () => {
  it('inserts into m2.capa_effectiveness_checks with VerifyEffectivenessInput fields', async () => {
    await m2Handler(
      makeEvent('verifyEffectiveness', {
        input: { correctiveActionId: 'ca-1', verificationMethod: 'audit sample', effective: true },
      }),
    );
    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('INSERT INTO m2.capa_effectiveness_checks');
    expect(sql).toContain('verification_method');
    expect(sql).not.toContain('effectiveness_verified');
    expect(sql).not.toContain('effectiveness_notes');
    expect(params).toContainEqual({ name: 'caId', value: { stringValue: 'ca-1' } });
    expect(params).toContainEqual({ name: 'method', value: { stringValue: 'audit sample' } });
    expect(params).toContainEqual({ name: 'effective', value: { booleanValue: true } });
  });

  it('advances the CA to verified when effective=true (same transaction)', async () => {
    await m2Handler(
      makeEvent('verifyEffectiveness', {
        input: { correctiveActionId: 'ca-1', verificationMethod: 'm', effective: true },
      }),
    );
    expect(mockExecute).toHaveBeenCalledTimes(2);
    const [sql] = mockExecute.mock.calls[1];
    expect(sql).toContain(`SET status = 'verified'`);
    expect(sql).toContain(`status <> 'closed'`);
  });

  it('does NOT touch CA status when effective=false', async () => {
    await m2Handler(
      makeEvent('verifyEffectiveness', {
        input: { correctiveActionId: 'ca-1', verificationMethod: 'm', effective: false },
      }),
    );
    expect(mockExecute).toHaveBeenCalledTimes(1);
    const [, params] = mockExecute.mock.calls[0];
    expect(params).toContainEqual({ name: 'effective', value: { booleanValue: false } });
  });
});

describe('m5 getCrossRegisterRiskView — filter-args fix regression', () => {
  it('honors standard + category args (category mapped to DB vocabulary)', async () => {
    await m5Handler(
      makeEvent('getCrossRegisterRiskView', { standard: 'ISO14001', category: 'ENVIRONMENTAL' }),
    );
    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('m5_views.get_risk_register_view()');
    expect(sql).toContain('standard = :standard');
    expect(sql).toContain('category = :category');
    expect(params).toContainEqual({ name: 'standard', value: { stringValue: 'ISO14001' } });
    expect(params).toContainEqual({ name: 'category', value: { stringValue: 'environmental' } });
  });

  it('applies no WHERE clause when no filters are passed', async () => {
    await m5Handler(makeEvent('getCrossRegisterRiskView', {}));
    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).not.toContain('WHERE');
    expect(params).toEqual([]);
  });
});

describe('m3 recordFinding — checklist_id ::uuid cast fix regression', () => {
  it('casts :checklistId to uuid so a provided id does not bind as VARCHAR', async () => {
    await m3Handler(
      makeEvent('recordFinding', {
        input: {
          auditId: 'a3f1c6d2-8b4e-4f5a-9c6d-1e2f3a4b5c6d',
          checklistId: 'd6a4f9b5-1e7c-4a8d-0f9b-4c5d6e7f8a9b',
          findingType: 'MINOR_NC',
          clauseRef: '8.5.1',
          description: 'd',
        },
      }),
    );
    const [sql] = mockExecute.mock.calls[0];
    expect(sql).toContain(':checklistId::uuid');
  });
});

describe('shared marshalRow — CAPAStatus reverse-map fix regression', () => {
  const columns = (names: string[]) => names.map((name) => ({ name }));

  it('maps CAPA status values to GraphQL UPPERCASE (previously passed through lowercase)', () => {
    const result = {
      records: [
        [{ stringValue: 'open' }],
        [{ stringValue: 'in_progress' }],
        [{ stringValue: 'verified' }],
        [{ stringValue: 'closed' }],
      ],
      columnMetadata: columns(['status']),
    };
    expect(marshalMany(result).map((r) => r.status)).toEqual([
      'OPEN',
      'IN_PROGRESS',
      'VERIFIED',
      'CLOSED',
    ]);
  });

  it('still maps DocumentStatus values through the same merged map', () => {
    const result = {
      records: [
        [{ stringValue: 'draft' }],
        [{ stringValue: 'in_review' }],
        [{ stringValue: 'obsolete' }],
      ],
      columnMetadata: columns(['status']),
    };
    expect(marshalMany(result).map((r) => r.status)).toEqual(['DRAFT', 'IN_REVIEW', 'OBSOLETE']);
  });
});
