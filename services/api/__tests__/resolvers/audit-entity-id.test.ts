/**
 * entityId normalization pins (audit-trail entityId+GSI follow-up, architect
 * 2026-07-16): every publishAuditEvent call site must declare the id of the
 * row the mutation returns (compiler-enforced via the required entityId field
 * on PublishAuditEventOptions). These tests pin the VALUE for the
 * marshal-first sites — the class where the id exists only in the INSERT's
 * RETURNING row, so a wrong variable (parent id, input id) would still
 * typecheck. Representative site per shape:
 *
 * - raiseNonconformity: entityId = the new NC row id, AND payload.ncId now
 *   carries it (spec-9 routed finding F-A: the mutation→agent chain was dead
 *   because NC.Raised published only the raw input).
 * - approveDocumentVersion: entityId = the DocumentApproval row id — NOT the
 *   parent versionId that the payload also carries.
 * - scheduleAudit: entityId = the new Audit row id — NOT input.programmeId.
 * - addRiskTreatment: entityId = the RiskTreatment row id — NOT input.riskId.
 * - empty RETURNING → entityId '' (sparse: appender skips GSI stamping).
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

/** Data-API-shaped single-row result whose RETURNING row has the given id. */
function rowWithId(id: string, extra: Record<string, string> = {}) {
  const cols = ['id', ...Object.keys(extra)];
  return {
    columnMetadata: cols.map((name) => ({ name })),
    records: [[{ stringValue: id }, ...Object.values(extra).map((v) => ({ stringValue: v }))]],
  };
}

function makeEvent(fieldName: string, args: Record<string, unknown> = {}) {
  return {
    info: { fieldName },
    arguments: args,
    identity: { resolverContext: { tenantId: 'tenant-test', sub: 'user-test', role: 'IMSLead' } },
  };
}

const publishedEvent = () => {
  expect(mockPublishAuditEvent).toHaveBeenCalledTimes(1);
  return mockPublishAuditEvent.mock.calls[0][0];
};

beforeEach(() => {
  mockExecute.mockReset().mockResolvedValue(EMPTY_RESULT);
  mockCommit.mockReset();
  mockRollback.mockReset();
  mockPublishAuditEvent.mockReset().mockResolvedValue('evt-test');
});

describe('entityId = returned-row id (marshal-first sites)', () => {
  it('raiseNonconformity publishes entityId + payload.ncId = the new NC row id (F-A)', async () => {
    mockExecute.mockResolvedValueOnce(rowWithId('nc-uuid-1'));

    await m2Handler(
      makeEvent('raiseNonconformity', {
        input: {
          standard: 'ISO9001',
          source: 'AUDIT',
          ncType: 'NC',
          description: 'd',
          clauseRef: '8.7',
          severity: 'HIGH',
        },
      }),
    );

    const evt = publishedEvent();
    expect(evt.detailType).toBe('NC.Raised');
    expect(evt.entityId).toBe('nc-uuid-1');
    expect(evt.payload.ncId).toBe('nc-uuid-1');
  });

  it('approveDocumentVersion publishes entityId = the DocumentApproval row id, not versionId', async () => {
    mockExecute
      // SoD SELECT created_by + doc status (≠ actor → passes; doc in_review)
      .mockResolvedValueOnce({
        columnMetadata: [{ name: 'created_by' }, { name: 'doc_status' }],
        records: [[{ stringValue: 'creator-sub' }, { stringValue: 'in_review' }]],
      })
      .mockResolvedValueOnce(rowWithId('approval-uuid-1'));

    await m1Handler(
      makeEvent('approveDocumentVersion', {
        input: { versionId: 'version-uuid-9', decision: 'APPROVED' },
      }),
    );

    const evt = publishedEvent();
    expect(evt.detailType).toBe('Document.Approved');
    expect(evt.entityId).toBe('approval-uuid-1');
    expect(evt.entityId).not.toBe('version-uuid-9');
    expect(evt.payload.versionId).toBe('version-uuid-9'); // parent id stays in payload
  });

  it('scheduleAudit publishes entityId = the new Audit row id, not programmeId', async () => {
    mockExecute.mockResolvedValueOnce(rowWithId('audit-uuid-1'));

    await m3Handler(
      makeEvent('scheduleAudit', {
        input: {
          programmeId: 'a3f1c6d2-8b4e-4f5a-9c6d-1e2f3a4b5c6d',
          standard: 'ISO9001',
          scope: 's',
          leadAuditorId: 'aud-1',
          plannedDate: '2026-08-01T00:00:00Z',
        },
      }),
    );

    const evt = publishedEvent();
    expect(evt.detailType).toBe('Audit.Scheduled');
    expect(evt.entityId).toBe('audit-uuid-1');
    expect(evt.entityId).not.toBe('prog-uuid-7');
    expect(evt.payload.auditId).toBe('audit-uuid-1');
  });

  it('addRiskTreatment publishes entityId = the RiskTreatment row id, not riskId', async () => {
    mockExecute.mockResolvedValueOnce(rowWithId('treatment-uuid-1'));

    await m5Handler(
      makeEvent('addRiskTreatment', {
        input: {
          riskId: 'risk-uuid-3',
          actionDesc: 'a',
          ownerId: 'o',
          dueDate: '2026-08-01T00:00:00Z',
        },
      }),
    );

    const evt = publishedEvent();
    expect(evt.detailType).toBe('Risk.TreatmentAdded');
    expect(evt.entityId).toBe('treatment-uuid-1');
    expect(evt.entityId).not.toBe('risk-uuid-3');
  });

  it("empty RETURNING → entityId '' (sparse GSI: appender skips stamping)", async () => {
    // mockExecute default = EMPTY_RESULT → marshalOne returns null
    await m2Handler(
      makeEvent('raiseNonconformity', {
        input: {
          standard: 'ISO9001',
          source: 'AUDIT',
          ncType: 'NC',
          description: 'd',
          clauseRef: '8.7',
          severity: 'HIGH',
        },
      }),
    );

    const evt = publishedEvent();
    expect(evt.entityId).toBe('');
  });
});
