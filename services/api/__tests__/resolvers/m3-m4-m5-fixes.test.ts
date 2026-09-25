/**
 * Unit tests for the M3/M4/M5 resolver SQL fixes (frontend-app Phase C
 * checkpoint, architect 2026-07-14): m3.ts and m4.ts were written against a
 * stale schema — column names, table names, and even input-argument shapes
 * didn't match the ratified migrations/schema.graphql. Every mutation/query
 * these fixes touch was a guaranteed runtime failure before this commit.
 *
 * Mocks shared.js at the transaction boundary (RDS path) and getTenantDdbClient
 * (DynamoDB path for getAuditTrail) and asserts the executed SQL/DDB calls +
 * parameters — the exact bugs found (wrong table names, wrong columns, wrong
 * input field names, wrong argument shape) would all be caught at this layer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExecute, mockCommit, mockRollback, mockDdbSend } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockCommit: vi.fn(),
  mockRollback: vi.fn(),
  mockDdbSend: vi.fn(),
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
    getTenantDdbClient: vi.fn().mockResolvedValue({ send: mockDdbSend }),
    TABLE_NAME: 'CumplifyCore-test',
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

import { handler as m3Handler } from '../../src/resolvers/m3.js';
import { handler as m4Handler } from '../../src/resolvers/m4.js';
import { handler as m5Handler } from '../../src/resolvers/m5.js';

const EMPTY_RESULT = { records: undefined, columnMetadata: undefined };

function makeEvent(
  fieldName: string,
  args: Record<string, unknown> = {},
  ctx: Record<string, string> = {},
) {
  return {
    info: { fieldName },
    arguments: args,
    identity: {
      resolverContext: { tenantId: 'tenant-test', sub: 'user-test', role: 'IMSLead', ...ctx },
    },
  };
}

beforeEach(() => {
  mockExecute.mockReset().mockResolvedValue(EMPTY_RESULT);
  mockCommit.mockReset();
  mockRollback.mockReset();
  mockDdbSend.mockReset();
});

describe('m3 createAuditProgramme — SQL fix regression', () => {
  it('inserts into real columns (standard, year, frequency_plan) and writes year', async () => {
    await m3Handler(
      makeEvent('createAuditProgramme', {
        input: { standard: 'ISO9001', year: 2027, frequencyPlan: 'annual' },
      }),
    );
    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('INSERT INTO m3.audit_programmes');
    expect(sql).toContain('year');
    expect(sql).not.toContain('title');
    expect(sql).not.toContain('programme_owner');
    expect(params).toContainEqual({ name: 'year', value: { longValue: 2027 } });
  });
});

describe('m3 scheduleAudit — SQL fix regression', () => {
  it('inserts into real columns (standard, planned_date) not audit_type/scheduled_date', async () => {
    await m3Handler(
      makeEvent('scheduleAudit', {
        input: {
          programmeId: 'a3f1c6d2-8b4e-4f5a-9c6d-1e2f3a4b5c6d',
          standard: 'ISO9001',
          scope: 'Warehouse',
          leadAuditorId: 'u1',
          plannedDate: '2027-01-01T00:00:00.000Z',
        },
      }),
    );
    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('planned_date');
    expect(sql).not.toContain('audit_type');
    expect(sql).not.toContain('scheduled_date');
    expect(params).toContainEqual({ name: 'standard', value: { stringValue: 'ISO9001' } });
    expect(params).toContainEqual({
      name: 'plannedDate',
      value: { stringValue: '2027-01-01T00:00:00.000Z' },
    });
  });
});

describe('m3 completeAudit — argument-shape fix regression', () => {
  it('reads the bare id argument (not input.auditId) and never references a conclusion column', async () => {
    mockExecute.mockResolvedValueOnce({
      records: [[{ stringValue: 'audit-1' }]],
      columnMetadata: [{ name: 'id' }],
    });
    await m3Handler(makeEvent('completeAudit', { id: 'a3f1c6d2-8b4e-4f5a-9c6d-1e2f3a4b5c6d' }));
    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).not.toContain('conclusion');
    expect(sql).toContain(`AND status <> 'completed'`); // check-then-act predicate rides the UPDATE
    expect(params).toEqual([{ name: 'id', value: { stringValue: 'a3f1c6d2-8b4e-4f5a-9c6d-1e2f3a4b5c6d' } }]);
  });

  it('rejects a double-complete — empty RETURNING throws AUDIT_NOT_FOUND_OR_ALREADY_COMPLETED', async () => {
    await expect(
      m3Handler(makeEvent('completeAudit', { id: 'a3f1c6d2-8b4e-4f5a-9c6d-1e2f3a4b5c6d' })),
    ).rejects.toThrow('AUDIT_NOT_FOUND_OR_ALREADY_COMPLETED');
  });

  it('rejects a non-UUID id up front (VALIDATION, no SQL)', async () => {
    await expect(m3Handler(makeEvent('completeAudit', { id: 'audit-1' }))).rejects.toThrow(
      'VALIDATION',
    );
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

describe('m3 getAuditReadiness — shape fix regression', () => {
  it('selects per-clause scores from audit_readiness_scores filtered by standard, not aggregate counts', async () => {
    await m3Handler(makeEvent('getAuditReadiness', { standard: 'ISO14001' }));
    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('FROM m3.audit_readiness_scores');
    expect(sql).toContain('WHERE standard = :standard');
    expect(sql).not.toContain('scheduled_audits');
    expect(sql).not.toContain('open_findings');
    expect(params).toEqual([{ name: 'standard', value: { stringValue: 'ISO14001' } }]);
  });
});

describe('m4 registerRecord — SQL fix regression', () => {
  it('inserts into real columns (source_module, retention_class, s3_object_ref) not title/description/status', async () => {
    await m4Handler(
      makeEvent('registerRecord', {
        input: { standard: 'ISO9001', recordType: 'inspection', sourceModule: 'M3' },
      }),
    );
    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('source_module');
    expect(sql).not.toContain('title');
    expect(sql).not.toContain('storage_location');
    expect(sql).not.toContain('owner_id');
    expect(params).toContainEqual({ name: 'sourceModule', value: { stringValue: 'M3' } });
  });
});

describe('m4 recordCalibration — table/column fix regression', () => {
  it('inserts into m4.calibration_records (not m4.calibrations) with real columns', async () => {
    await m4Handler(
      makeEvent('recordCalibration', {
        input: {
          measuringResourceId: 'res-1',
          standardUsed: 'ISO17025',
          result: 'pass',
          nextDue: '2027-01-01T00:00:00.000Z',
        },
      }),
    );
    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('INSERT INTO m4.calibration_records');
    expect(sql).not.toContain('m4.calibrations');
    expect(sql).not.toContain('equipment_id');
    expect(params).toContainEqual({ name: 'measuringResourceId', value: { stringValue: 'res-1' } });
    expect(params).toContainEqual({ name: 'standardUsed', value: { stringValue: 'ISO17025' } });
  });
});

describe('m4 createRetentionPolicy — SQL fix regression', () => {
  it('inserts retention_years/disposition_rule, matching CreateRetentionPolicyInput', async () => {
    await m4Handler(
      makeEvent('createRetentionPolicy', {
        input: { recordType: 'audit-report', retentionYears: 7, dispositionRule: 'archive' },
      }),
    );
    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('retention_years');
    expect(sql).toContain('disposition_rule');
    expect(sql).not.toContain('retention_period_days');
    expect(sql).not.toContain('applies_to_standard');
    expect(params).toContainEqual({ name: 'retentionYears', value: { longValue: 7 } });
  });
});

describe('m4 listCalibrationsDue — table/arg fix regression', () => {
  it('queries m4.calibration_records (not m4.calibrations/m4.equipment) and honors windowDays', async () => {
    await m4Handler(makeEvent('listCalibrationsDue', { windowDays: 90 }));
    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('FROM m4.calibration_records');
    expect(sql).not.toContain('m4.equipment');
    expect(sql).not.toContain('m4.calibrations');
    expect(sql).toContain('make_interval');
    expect(params).toEqual([{ name: 'windowDays', value: { longValue: 90 } }]);
  });
});

describe('m4 getAuditTrail — GSI1 per-entity query + pre-migration fallback', () => {
  const ledgerItem = (id: string, ts: string, payloadRiskId: string) => ({
    PK: { S: 'TENANT#tenant-test#AUDITLOG' },
    SK: { S: `EVENT#${ts}#${id}` },
    eventId: { S: id },
    eventType: { S: 'Risk.Created' },
    actor: { S: 'user-1' },
    module: { S: 'M5' },
    clauseRef: { S: 'ISO 9001 6.1' },
    standard: { S: 'ISO9001' },
    eventTimestamp: { S: ts },
    payloadHash: { S: `hash-${id}` },
    payload: { M: { riskId: { S: payloadRiskId } } },
  });

  it('queries GSI1 on TENANT#<t>#ENTITY#<entityId> first and returns its hits directly', async () => {
    mockDdbSend.mockResolvedValueOnce({
      Items: [ledgerItem('evt-1', '2027-01-01T00:00:00.000Z', 'risk-42')],
    });

    const result = (await m4Handler(
      makeEvent('getAuditTrail', { entityId: 'risk-42' }, { role: 'InternalAuditor' }),
    )) as Array<Record<string, unknown>>;

    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockDdbSend).toHaveBeenCalledTimes(1); // GSI hit → NO fallback scan
    const [gsiCall] = mockDdbSend.mock.calls[0];
    expect(gsiCall.input.TableName).toBe('CumplifyCore-test');
    expect(gsiCall.input.IndexName).toBe('GSI1');
    expect(gsiCall.input.ExpressionAttributeValues[':gpk']).toEqual({
      S: 'TENANT#tenant-test#ENTITY#risk-42',
    });
    expect(gsiCall.input.ExpressionAttributeValues[':audit']).toEqual({ S: 'AUDITLOG' });
    expect(result).toHaveLength(1);
    expect(result[0].eventId).toBe('evt-1');
    expect(result[0].timestamp).toBe('2027-01-01T00:00:00.000Z');
  });

  it('falls back to the tenant-partition exact-value scan when the GSI has zero items (pre-migration events)', async () => {
    mockDdbSend
      .mockResolvedValueOnce({ Items: [] }) // GSI miss
      .mockResolvedValueOnce({
        Items: [
          ledgerItem('evt-1', '2027-01-01T00:00:00.000Z', 'risk-42'),
          ledgerItem('evt-2', '2027-01-01T00:00:01.000Z', 'risk-99'),
        ],
      });

    const result = (await m4Handler(
      makeEvent('getAuditTrail', { entityId: 'risk-42' }, { role: 'InternalAuditor' }),
    )) as Array<Record<string, unknown>>;

    expect(mockDdbSend).toHaveBeenCalledTimes(2);
    const [fallbackCall] = mockDdbSend.mock.calls[1];
    expect(fallbackCall.input.IndexName).toBeUndefined(); // base-table partition query
    expect(fallbackCall.input.ExpressionAttributeValues[':pk']).toEqual({
      S: 'TENANT#tenant-test#AUDITLOG',
    });
    // Exact-value match filters to the requested entity
    expect(result).toHaveLength(1);
    expect(result[0].eventId).toBe('evt-1');
  });

  it('rejects non-auditor/non-admin roles before any DDB call (FORBIDDEN)', async () => {
    await expect(
      m4Handler(makeEvent('getAuditTrail', { entityId: 'risk-42' }, { role: 'Employee' })),
    ).rejects.toThrow('FORBIDDEN');
    expect(mockDdbSend).not.toHaveBeenCalled();
  });

  it('does NOT substring-match a short entityId against other entities (exact match)', async () => {
    mockDdbSend
      .mockResolvedValueOnce({ Items: [] }) // GSI miss
      .mockResolvedValueOnce({
        Items: [ledgerItem('evt-1', '2027-01-01T00:00:00.000Z', 'risk-42')],
      });

    // 'risk' is a strict substring of 'risk-42' — the old substring filter
    // returned it; exact-value matching must not.
    const result = (await m4Handler(
      makeEvent('getAuditTrail', { entityId: 'risk' }, { role: 'InternalAuditor' }),
    )) as Array<Record<string, unknown>>;
    expect(result).toHaveLength(0);
  });
});

describe('m4 registerMeasuringResource — new mutation (unblocks recordCalibration)', () => {
  it('inserts into m4.measuring_resources with assetTag/description', async () => {
    await m4Handler(
      makeEvent('registerMeasuringResource', {
        input: { assetTag: 'CAL-001', description: 'Digital caliper' },
      }),
    );
    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('INSERT INTO m4.measuring_resources');
    expect(sql).toContain('asset_tag');
    expect(params).toContainEqual({ name: 'assetTag', value: { stringValue: 'CAL-001' } });
    expect(params).toContainEqual({
      name: 'description',
      value: { stringValue: 'Digital caliper' },
    });
  });
});

describe('m5 createRisk — register-refresh fix regression', () => {
  it('refreshes m5_views.risk_register_view via the SECURITY DEFINER accessor, AFTER the write commits', async () => {
    await m5Handler(
      makeEvent('createRisk', {
        input: {
          standard: 'ISO9001',
          category: 'QUALITY',
          description: 'Test risk',
          likelihood: 3,
          severity: 3,
        },
      }),
    );

    expect(mockExecute).toHaveBeenCalledTimes(2);
    const [insertSql] = mockExecute.mock.calls[0];
    const [refreshSql] = mockExecute.mock.calls[1];
    expect(insertSql).toContain('INSERT INTO m5.risks');
    expect(refreshSql).toContain('m5_views.refresh_risk_register_view()');
    // Refresh happens AFTER the write's commit — a post-commit best-effort
    // refresh in a second transaction (MV lock + refresh-failure isolation).
    expect(mockCommit).toHaveBeenCalledTimes(2);
    expect(mockExecute.mock.invocationCallOrder[1]).toBeGreaterThan(
      mockCommit.mock.invocationCallOrder[0],
    );
  });

  it('still returns the created risk when the post-commit refresh fails', async () => {
    mockExecute
      .mockResolvedValueOnce({
        records: [[{ stringValue: 'risk-1' }]],
        columnMetadata: [{ name: 'id' }],
      })
      .mockRejectedValueOnce(new Error('refresh blew up'));

    const result = (await m5Handler(
      makeEvent('createRisk', {
        input: {
          standard: 'ISO9001',
          category: 'QUALITY',
          description: 'Test risk',
          likelihood: 3,
          severity: 3,
        },
      }),
    )) as Record<string, unknown>;

    // The domain write committed — a refresh failure must not fail the mutation.
    expect(result.id).toBe('risk-1');
    expect(mockCommit).toHaveBeenCalledTimes(1); // only the INSERT txn committed
  });
});

// ─── Task 9: generateAuditChecklist (M3-native, OQ-1) ────────────────────────

describe('generateAuditChecklist — M3-native clause-registry checklist', () => {
  it('validates audit exists with ::uuid cast, reads standard, queries registry', async () => {
    // Call 1: audit fetch
    mockExecute.mockResolvedValueOnce({
      records: [[{ stringValue: 'audit-1' }, { stringValue: 'ISO9001' }]],
      columnMetadata: [{ name: 'id' }, { name: 'standard' }],
    });
    // Call 2: clause registry query (2 clauses)
    mockExecute.mockResolvedValueOnce({
      records: [
        [
          { stringValue: 'c-1' },
          { stringValue: '4.1' },
          { stringValue: 'Context' },
          { stringValue: 'understand the organization and its context' },
          { stringValue: '["documented context analysis"]' },
        ],
        [
          { stringValue: 'c-2' },
          { stringValue: '4.2' },
          { stringValue: 'Interested parties' },
          { stringValue: 'determine interested parties and their requirements' },
          { stringValue: '["stakeholder register"]' },
        ],
      ],
      columnMetadata: [
        { name: 'id' },
        { name: 'clause_no' },
        { name: 'clause_title' },
        { name: 'intent_paraphrase' },
        { name: 'required_sources' },
      ],
    });
    // Call 3+4: INSERT per clause (with RETURNING)
    mockExecute.mockResolvedValueOnce({
      records: [[{ stringValue: 'chk-1' }]],
      columnMetadata: [{ name: 'id' }],
    });
    mockExecute.mockResolvedValueOnce({
      records: [[{ stringValue: 'chk-2' }]],
      columnMetadata: [{ name: 'id' }],
    });
    // Call 5: fetch all checklist rows
    mockExecute.mockResolvedValueOnce({
      records: [
        [
          { stringValue: 'chk-1' },
          { stringValue: 'audit-1' },
          { stringValue: '4.1' },
          { stringValue: 'Does the organization understand the organization and its context' },
          { stringValue: 'documented context analysis' },
        ],
        [
          { stringValue: 'chk-2' },
          { stringValue: 'audit-1' },
          { stringValue: '4.2' },
          {
            stringValue:
              'Does the organization determine interested parties and their requirements',
          },
          { stringValue: 'stakeholder register' },
        ],
      ],
      columnMetadata: [
        { name: 'id' },
        { name: 'audit_id' },
        { name: 'clause_ref' },
        { name: 'question' },
        { name: 'expected_evidence' },
      ],
    });

    const result = (await m3Handler(
      makeEvent('generateAuditChecklist', { auditId: 'a3f1c6d2-8b4e-4f5a-9c6d-1e2f3a4b5c6d' }),
    )) as Record<string, unknown>[];

    // Audit validation with ::uuid cast
    const [auditSql] = mockExecute.mock.calls[0];
    expect(auditSql).toContain('FROM m3.audits');
    expect(auditSql).toContain(':id::uuid');

    // Clause registry query filtered by standard
    const [clauseSql, clauseParams] = mockExecute.mock.calls[1];
    expect(clauseSql).toContain('FROM qms.clause_registry');
    expect(clauseSql).toContain('WHERE standard = :standard');
    expect(clauseParams).toContainEqual({ name: 'standard', value: { stringValue: 'ISO9001' } });

    // INSERT with ::uuid cast and ON CONFLICT
    const [insertSql] = mockExecute.mock.calls[2];
    expect(insertSql).toContain('INSERT INTO m3.audit_checklists');
    expect(insertSql).toContain(':auditId::uuid');
    expect(insertSql).toContain('ON CONFLICT (audit_id, clause_ref) DO NOTHING');

    // Returns checklist rows (count = 2, from registry)
    expect(result).toHaveLength(2);
    expect(mockCommit).toHaveBeenCalled();
  });

  it('idempotent: second call returns same rows without duplicate inserts', async () => {
    // Call 1: audit fetch
    mockExecute.mockResolvedValueOnce({
      records: [[{ stringValue: 'audit-1' }, { stringValue: 'ISO14001' }]],
      columnMetadata: [{ name: 'id' }, { name: 'standard' }],
    });
    // Call 2: clause registry (1 clause)
    mockExecute.mockResolvedValueOnce({
      records: [
        [
          { stringValue: 'c-1' },
          { stringValue: '6.1.2' },
          { stringValue: 'Aspects' },
          { stringValue: 'determine environmental aspects' },
          { stringValue: '[]' },
        ],
      ],
      columnMetadata: [
        { name: 'id' },
        { name: 'clause_no' },
        { name: 'clause_title' },
        { name: 'intent_paraphrase' },
        { name: 'required_sources' },
      ],
    });
    // Call 3: INSERT → ON CONFLICT DO NOTHING (returns empty = already existed)
    mockExecute.mockResolvedValueOnce({ records: [], columnMetadata: [{ name: 'id' }] });
    // Call 4: fetch all (1 pre-existing row)
    mockExecute.mockResolvedValueOnce({
      records: [
        [
          { stringValue: 'chk-existing' },
          { stringValue: 'audit-1' },
          { stringValue: '6.1.2' },
          { stringValue: 'Q' },
          { isNull: true },
        ],
      ],
      columnMetadata: [
        { name: 'id' },
        { name: 'audit_id' },
        { name: 'clause_ref' },
        { name: 'question' },
        { name: 'expected_evidence' },
      ],
    });

    const result = (await m3Handler(
      makeEvent('generateAuditChecklist', { auditId: 'a3f1c6d2-8b4e-4f5a-9c6d-1e2f3a4b5c6d' }),
    )) as Record<string, unknown>[];

    // Still returns 1 row (idempotent — no duplicates)
    expect(result).toHaveLength(1);
    expect(mockCommit).toHaveBeenCalled();
  });

  it('AUDIT_NOT_FOUND when audit does not exist', async () => {
    mockExecute.mockResolvedValueOnce({
      records: [],
      columnMetadata: [{ name: 'id' }, { name: 'standard' }],
    });

    await expect(
      m3Handler(makeEvent('generateAuditChecklist', { auditId: 'b4e2d7f3-9c5a-4e6b-8d7f-2a3b4c5d6e7f' })),
    ).rejects.toThrow('AUDIT_NOT_FOUND');

    expect(mockRollback).toHaveBeenCalled();
  });

  it('question wraps intent_paraphrase with "Does the organization ..."', async () => {
    mockExecute.mockResolvedValueOnce({
      records: [[{ stringValue: 'a-1' }, { stringValue: 'ISO45001' }]],
      columnMetadata: [{ name: 'id' }, { name: 'standard' }],
    });
    mockExecute.mockResolvedValueOnce({
      records: [
        [
          { stringValue: 'c-1' },
          { stringValue: '5.4' },
          { stringValue: 'Participation' },
          { stringValue: 'Ensure worker consultation and participation' },
          { stringValue: '["meeting minutes"]' },
        ],
      ],
      columnMetadata: [
        { name: 'id' },
        { name: 'clause_no' },
        { name: 'clause_title' },
        { name: 'intent_paraphrase' },
        { name: 'required_sources' },
      ],
    });
    mockExecute.mockResolvedValueOnce({
      records: [[{ stringValue: 'chk-1' }]],
      columnMetadata: [{ name: 'id' }],
    });
    mockExecute.mockResolvedValueOnce({
      records: [
        [
          { stringValue: 'chk-1' },
          { stringValue: 'a-1' },
          { stringValue: '5.4' },
          { stringValue: 'Does the organization ensure worker consultation and participation' },
          { stringValue: 'meeting minutes' },
        ],
      ],
      columnMetadata: [
        { name: 'id' },
        { name: 'audit_id' },
        { name: 'clause_ref' },
        { name: 'question' },
        { name: 'expected_evidence' },
      ],
    });

    await m3Handler(makeEvent('generateAuditChecklist', { auditId: 'c5f3e8a4-0d6b-4f7c-9e8a-3b4c5d6e7f8a' }));

    // INSERT params contain the wrapped question
    const [, insertParams] = mockExecute.mock.calls[2];
    expect(insertParams).toContainEqual(
      expect.objectContaining({
        name: 'question',
        value: {
          stringValue: 'Does the organization ensure worker consultation and participation?',
        },
      }),
    );
    // expected_evidence from required_sources
    expect(insertParams).toContainEqual(
      expect.objectContaining({
        name: 'expectedEvidence',
        value: { stringValue: 'meeting minutes' },
      }),
    );
  });
});
