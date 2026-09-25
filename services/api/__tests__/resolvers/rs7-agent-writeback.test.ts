/**
 * Unit tests for the six agent* (@aws_iam) writeback door mutations
 * (read-surface-completion RS-7): agentDraftDocument (m1), agentTriageNC +
 * agentProposeCorrectiveAction (m2), agentGenerateChecklist +
 * agentScoreReadiness (m3), agentAssessRisk (m5).
 *
 * These fields carry ONLY @aws_iam auth — AppSync's Lambda authorizer (the
 * sole source of resolverContext) never runs for IAM-signed calls, so every
 * event here has NO identity.resolverContext, matching real IAM-call shape.
 * tenantId comes from the explicit input field (extractAgentContext,
 * owner-approved narrow SCHEMA-5 exception, 2026-07-22) — asserted against
 * the REAL (unmocked) extractAgentContext implementation.
 *
 * Mocks shared.js at the transaction boundary — same pattern as
 * m3-m4-m5-fixes.test.ts / hitl-approval.test.ts.
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

import { handler as m1Handler } from '../../src/resolvers/m1.js';
import { handler as m2Handler } from '../../src/resolvers/m2.js';
import { handler as m3Handler } from '../../src/resolvers/m3.js';
import { handler as m5Handler } from '../../src/resolvers/m5.js';

const EMPTY_RESULT = { records: undefined, columnMetadata: undefined };

/** No identity.resolverContext at all — real @aws_iam call shape. */
function makeAgentEvent(fieldName: string, args: Record<string, unknown> = {}) {
  return { info: { fieldName }, arguments: args };
}

beforeEach(() => {
  mockExecute.mockReset().mockResolvedValue(EMPTY_RESULT);
  mockCommit.mockReset();
  mockRollback.mockReset();
  mockPublishAuditEvent.mockReset().mockResolvedValue('evt-test');
});

describe('extractAgentContext — SCHEMA-5 narrow exception (RS-7)', () => {
  it('throws when tenantId is missing from a bare-arg call', async () => {
    await expect(
      m3Handler(makeAgentEvent('agentScoreReadiness', { standard: 'ISO9001' })),
    ).rejects.toThrow('Missing tenantId');
  });

  it('throws when tenantId is missing from a nested input call', async () => {
    await expect(
      m1Handler(
        makeAgentEvent('agentDraftDocument', {
          input: { standard: 'ISO9001', docType: 'PROCEDURE', title: 'x', contentRef: 'ref' },
        }),
      ),
    ).rejects.toThrow('Missing tenantId');
  });
});

describe('extractAgentContext — IAM session-tag tenant binding (RS-7a)', () => {
  it('accepts when the principal session name carries the matching tenant', async () => {
    const result = await m3Handler({
      info: { fieldName: 'agentScoreReadiness' },
      arguments: { standard: 'ISO9001', tenantId: 'tenant-abc' },
      identity: {
        userArn: 'arn:aws:sts::123456789012:assumed-role/writeback-role/tenant-tenant-abc',
      },
    });
    expect(result).toEqual([]);
  });

  it('rejects a mismatched tenant-<id> session name', async () => {
    await expect(
      m3Handler({
        info: { fieldName: 'agentScoreReadiness' },
        arguments: { standard: 'ISO9001', tenantId: 'tenant-abc' },
        identity: {
          userArn: 'arn:aws:sts::123456789012:assumed-role/writeback-role/tenant-other-tenant',
        },
      }),
    ).rejects.toThrow('FORBIDDEN');
  });

  it('accepts a resolver-<first8>-<epoch> session whose prefix matches', async () => {
    const result = await m3Handler({
      info: { fieldName: 'agentScoreReadiness' },
      arguments: { standard: 'ISO9001', tenantId: 'tenant-abc' },
      identity: {
        userArn:
          'arn:aws:sts::123456789012:assumed-role/tenant-data-role/resolver-tenant-a-1750000000',
      },
    });
    expect(result).toEqual([]);
  });

  it('rejects a resolver-<first8>-<epoch> session with a different tenant prefix', async () => {
    await expect(
      m3Handler({
        info: { fieldName: 'agentScoreReadiness' },
        arguments: { standard: 'ISO9001', tenantId: 'tenant-abc' },
        identity: {
          userArn:
            'arn:aws:sts::123456789012:assumed-role/tenant-data-role/resolver-zzzzzzzz-1750000000',
        },
      }),
    ).rejects.toThrow('FORBIDDEN');
  });

  it('no tenant marker on the principal → charset check alone (where-available escape)', async () => {
    const result = await m3Handler({
      info: { fieldName: 'agentScoreReadiness' },
      arguments: { standard: 'ISO9001', tenantId: 'tenant-abc' },
      identity: {
        userArn: 'arn:aws:sts::123456789012:assumed-role/writeback-role/agent-session-01',
      },
    });
    expect(result).toEqual([]);
  });
});

describe('agentDraftDocument (m1, DocStudio) — direct write', () => {
  it('creates document + version 1 in one transaction, no HITL gate', async () => {
    mockExecute
      .mockResolvedValueOnce({
        records: [[{ stringValue: 'doc-1' }]],
        columnMetadata: [{ name: 'id' }],
      })
      .mockResolvedValueOnce(EMPTY_RESULT); // document_versions insert

    const result = await m1Handler(
      makeAgentEvent('agentDraftDocument', {
        input: {
          tenantId: 'tenant-agent',
          standard: 'ISO9001',
          docType: 'PROCEDURE',
          title: 'Agent-drafted procedure',
          contentRef: 'tenants/tenant-agent/drafts/procedure.json',
        },
      }),
    );

    expect(result).toEqual({ id: 'doc-1' });
    const [docSql, docParams] = mockExecute.mock.calls[0];
    expect(docSql).toContain('INSERT INTO m1.documents');
    expect(docSql).toContain("'draft'");
    expect(docParams).toContainEqual({ name: 'actor', value: { stringValue: 'agent:DocStudio' } });

    const [versionSql, versionParams] = mockExecute.mock.calls[1];
    expect(versionSql).toContain('INSERT INTO m1.document_versions');
    expect(versionSql).toContain('VALUES (:tenantId, :documentId::uuid, 1,');
    expect(versionParams).toContainEqual({ name: 'documentId', value: { stringValue: 'doc-1' } });
    expect(versionParams).toContainEqual({
      name: 'contentRef',
      value: { stringValue: 'tenants/tenant-agent/drafts/procedure.json' },
    });

    expect(mockCommit).toHaveBeenCalledOnce();
    expect(mockPublishAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ detailType: 'Document.DraftCreated', actor: 'agent:DocStudio' }),
    );
  });

  it('rolls back on failure', async () => {
    mockExecute.mockRejectedValueOnce(new Error('boom'));
    await expect(
      m1Handler(
        makeAgentEvent('agentDraftDocument', {
          input: {
            tenantId: 't1',
            standard: 'ISO9001',
            docType: 'PROCEDURE',
            title: 'x',
            contentRef: 'tenants/t1/drafts/x.json',
          },
        }),
      ),
    ).rejects.toThrow('boom');
    expect(mockRollback).toHaveBeenCalledOnce();
  });
});

describe('agentProposeCorrectiveAction (m2, CAPAGuru) — direct write, dueDate defaulted', () => {
  it('creates a CA with status open and a +14d dueDate (no dueDate in input)', async () => {
    mockExecute.mockResolvedValueOnce({
      records: [[{ stringValue: 'ca-1' }, { stringValue: 'open' }]],
      columnMetadata: [{ name: 'id' }, { name: 'status' }],
    });

    const before = Date.now();
    const result = await m2Handler(
      makeAgentEvent('agentProposeCorrectiveAction', {
        input: {
          tenantId: 'tenant-agent',
          ncId: 'nc-1',
          actionDesc: 'Contain the spill',
          suggestedOwnerId: 'user-9',
        },
      }),
    );
    expect(result).toEqual({ id: 'ca-1', status: 'OPEN' }); // REVERSE_ENUMS: DB 'open' -> CAPAStatus.OPEN

    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('INSERT INTO m2.corrective_actions');
    expect(sql).toContain("'open'");
    const dueDateParam = params.find((p: { name: string }) => p.name === 'dueDate');
    const dueDateMs = new Date(dueDateParam.value.stringValue).getTime();
    expect(dueDateMs).toBeGreaterThan(before + 13 * 24 * 60 * 60 * 1000);
    expect(dueDateMs).toBeLessThan(before + 15 * 24 * 60 * 60 * 1000);

    expect(mockPublishAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ detailType: 'CAPA.Opened', actor: 'agent:CAPAGuru' }),
    );
  });
});

describe('agentTriageNC (m2, CAPAGuru) — direct write, reclassification only', () => {
  it('updates nc_type and returns the updated NC', async () => {
    mockExecute.mockResolvedValueOnce({
      records: [[{ stringValue: 'nc-1' }, { stringValue: 'incident' }]],
      columnMetadata: [{ name: 'id' }, { name: 'nc_type' }],
    });

    const result = await m2Handler(
      makeAgentEvent('agentTriageNC', {
        input: { tenantId: 'tenant-agent', ncId: 'nc-1', classification: 'INCIDENT' },
      }),
    );
    expect(result).toEqual({ id: 'nc-1', ncType: 'INCIDENT' }); // REVERSE_ENUMS applies to nc_type

    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('UPDATE m2.nonconformities SET nc_type = :ncType');
    expect(params).toContainEqual({ name: 'ncType', value: { stringValue: 'incident' } });
    expect(mockPublishAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ detailType: 'NC.Triaged' }),
    );
  });

  it('throws NC_NOT_FOUND and rolls back when no row matches', async () => {
    mockExecute.mockResolvedValueOnce({ records: [], columnMetadata: [] });
    await expect(
      m2Handler(
        makeAgentEvent('agentTriageNC', {
          input: { tenantId: 't1', ncId: 'missing', classification: 'NC' },
        }),
      ),
    ).rejects.toThrow('NC_NOT_FOUND');
    expect(mockRollback).toHaveBeenCalledOnce();
  });
});

describe('agentGenerateChecklist (m3, LeadAuditor) — delegates to generateAuditChecklist internals', () => {
  it('same SQL path as the user-facing mutation, reached via bare tenantId arg', async () => {
    mockExecute
      .mockResolvedValueOnce({
        records: [[{ stringValue: 'audit-1' }, { stringValue: 'ISO9001' }]],
        columnMetadata: [{ name: 'id' }, { name: 'standard' }],
      })
      .mockResolvedValueOnce({
        records: [
          [
            { stringValue: 'c1' },
            { stringValue: '4.1' },
            { stringValue: 'Context' },
            { stringValue: 'determine external issues' },
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
      })
      .mockResolvedValueOnce({
        records: [[{ stringValue: 'chk-1' }]],
        columnMetadata: [{ name: 'id' }],
      })
      .mockResolvedValueOnce(EMPTY_RESULT);

    await m3Handler(
      makeAgentEvent('agentGenerateChecklist', {
        auditId: 'a3f1c6d2-8b4e-4f5a-9c6d-1e2f3a4b5c6d',
        tenantId: 'tenant-agent',
      }),
    );
    // Same internal function as generateAuditChecklist — SQL shape assertions
    // live in m3-m4-m5-fixes.test.ts; here we assert it ran at all under the
    // agent path with actor 'agent:LeadAuditor'.
    const insertCall = mockExecute.mock.calls[2];
    expect(insertCall[0]).toContain('INSERT INTO m3.audit_checklists');
    expect(insertCall[1]).toContainEqual({
      name: 'actor',
      value: { stringValue: 'agent:LeadAuditor' },
    });
  });
});

describe('agentScoreReadiness (m3, LeadAuditor) — upsert from generation-section status', () => {
  it('scores prose/na_justified as 100, everything else as 0, upserts each clause', async () => {
    mockExecute
      .mockResolvedValueOnce({
        records: [
          [{ stringValue: '4.1' }, { stringValue: 'prose' }],
          [{ stringValue: '4.2' }, { stringValue: 'gap' }],
          [{ stringValue: '4.3' }, { isNull: true }], // never generated
        ],
        columnMetadata: [{ name: 'clause_no' }, { name: 'status' }],
      })
      .mockResolvedValueOnce(EMPTY_RESULT) // upsert 4.1
      .mockResolvedValueOnce(EMPTY_RESULT) // upsert 4.2
      .mockResolvedValueOnce(EMPTY_RESULT) // upsert 4.3
      .mockResolvedValueOnce({
        records: [
          [{ stringValue: '4.1' }, { doubleValue: 100.0 }],
          [{ stringValue: '4.2' }, { doubleValue: 0.0 }],
          [{ stringValue: '4.3' }, { doubleValue: 0.0 }],
        ],
        columnMetadata: [{ name: 'clause_ref' }, { name: 'score' }],
      });

    const result = await m3Handler(
      makeAgentEvent('agentScoreReadiness', { standard: 'ISO9001', tenantId: 'tenant-agent' }),
    );
    expect(result).toEqual([
      { clauseRef: '4.1', score: 100.0 },
      { clauseRef: '4.2', score: 0.0 },
      { clauseRef: '4.3', score: 0.0 },
    ]);

    const [upsert41Sql, upsert41Params] = mockExecute.mock.calls[1];
    expect(upsert41Sql).toContain('ON CONFLICT (tenant_id, standard, clause_ref)');
    expect(upsert41Params).toContainEqual({ name: 'score', value: { doubleValue: 100.0 } });
    const [, upsert42Params] = mockExecute.mock.calls[2];
    expect(upsert42Params).toContainEqual({ name: 'score', value: { doubleValue: 0.0 } });
    const [, upsert43Params] = mockExecute.mock.calls[3];
    expect(upsert43Params).toContainEqual({ name: 'score', value: { doubleValue: 0.0 } });

    expect(mockPublishAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ detailType: 'Readiness.Scored' }),
    );
  });
});

describe('agentAssessRisk (m5, RiskSentinel) — direct write, updates existing risk', () => {
  it('updates likelihood/severity, refreshes the register view post-commit', async () => {
    const riskRow = [
      { stringValue: 'risk-1' },
      { stringValue: 'tenant-agent' },
      { stringValue: 'ISO9001' },
      { stringValue: 'quality' },
      { stringValue: 'desc' },
      { longValue: 4 },
      { longValue: 5 },
      { longValue: 20 },
      { isNull: true },
      { stringValue: 'owner-1' },
      { stringValue: 'open' },
      { stringValue: '2026-01-01T00:00:00Z' },
    ];
    const riskColumns = [
      { name: 'id' },
      { name: 'tenant_id' },
      { name: 'standard' },
      { name: 'category' },
      { name: 'description' },
      { name: 'likelihood' },
      { name: 'severity' },
      { name: 'risk_rating' },
      { name: 'treatment' },
      { name: 'owner_id' },
      { name: 'status' },
      { name: 'created_at' },
    ];
    mockExecute.mockResolvedValueOnce({ records: [riskRow], columnMetadata: riskColumns });
    mockExecute.mockResolvedValueOnce(EMPTY_RESULT); // refresh_risk_register_view

    const result = await m5Handler(
      makeAgentEvent('agentAssessRisk', {
        input: {
          tenantId: 'tenant-agent',
          riskId: 'risk-1',
          likelihood: 4,
          severity: 5,
          rationale: 'Escalated after near-miss incident',
        },
      }),
    );
    expect((result as { id: string }).id).toBe('risk-1');
    expect((result as { likelihood: number }).likelihood).toBe(4);
    expect((result as { severity: number }).severity).toBe(5);

    const [updateSql, updateParams] = mockExecute.mock.calls[0];
    expect(updateSql).toContain(
      'UPDATE m5.risks SET likelihood = :likelihood, severity = :severity',
    );
    expect(updateParams).toContainEqual({ name: 'likelihood', value: { longValue: 4 } });

    // Refresh now runs post-commit in a second transaction (MV lock isolation).
    expect(mockExecute.mock.calls[1][0]).toContain('m5_views.refresh_risk_register_view()');
    expect(mockCommit).toHaveBeenCalledTimes(2);

    expect(mockPublishAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        detailType: 'Risk.Assessed',
        actor: 'agent:RiskSentinel',
        payload: expect.objectContaining({ rationale: 'Escalated after near-miss incident' }),
      }),
    );
  });

  it('throws RISK_NOT_FOUND and rolls back when no row matches', async () => {
    mockExecute.mockResolvedValueOnce({ records: [], columnMetadata: [] });
    await expect(
      m5Handler(
        makeAgentEvent('agentAssessRisk', {
          input: { tenantId: 't1', riskId: 'missing', likelihood: 1, severity: 1, rationale: 'x' },
        }),
      ),
    ).rejects.toThrow('RISK_NOT_FOUND');
    expect(mockRollback).toHaveBeenCalledOnce();
  });
});
