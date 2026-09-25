/**
 * QMS Document Engine resolver tests (spec 40, Task 3).
 * Hermetic: SQL/param-asserting per resolver, real 011 column names,
 * ::uuid casts pinned, zod rejection cases, SCHEMA-5.
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

// S3: captured at module load — must exist before the import below
process.env.DOC_STUDIO_FN_ARN = 'arn:aws:lambda:us-east-1:123:function:cumplify-doc-studio-test';

import { handler } from '../../src/resolvers/qms.js';

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

// ─── getOrgProfile ───────────────────────────────────────────────────────────

describe('getOrgProfile', () => {
  it('queries org_profiles joined to org_profile_versions with real 011 column names', async () => {
    await handler(makeEvent('getOrgProfile'));
    const [sql] = mockExecute.mock.calls[0];
    expect(sql).toContain('qms.org_profiles');
    expect(sql).toContain('qms.org_profile_versions');
    expect(sql).toContain('p.current_version');
    expect(sql).toContain('pv.payload');
    expect(sql).toContain('p.updated_at');
    expect(sql).toContain('pv.version_no');
  });

  it('returns payload as a parsed OBJECT for the AWSJSON slot (double-encode fix, 2026-07-22)', async () => {
    mockExecute.mockResolvedValueOnce({
      records: [
        [
          { stringValue: 'p-1' },
          { longValue: 2 },
          { stringValue: '{"legalName":"Meridian Design-Build LLC"}' }, // jsonb → string from Data API
          { stringValue: '2026-07-22 12:59:52' },
        ],
      ],
      columnMetadata: [
        { name: 'id' },
        { name: 'current_version' },
        { name: 'payload' },
        { name: 'updated_at' },
      ],
    });

    const result = (await handler(makeEvent('getOrgProfile'))) as { payload: unknown };
    expect(typeof result.payload).toBe('object');
    expect(result.payload).toEqual({ legalName: 'Meridian Design-Build LLC' });
  });
});

// ─── listClauseRegistry ──────────────────────────────────────────────────────

describe('listClauseRegistry', () => {
  it('queries qms.clause_registry with real 011 column names', async () => {
    await handler(makeEvent('listClauseRegistry'));
    const [sql] = mockExecute.mock.calls[0];
    expect(sql).toContain('qms.clause_registry');
    expect(sql).toContain('clause_no');
    expect(sql).toContain('clause_title');
    expect(sql).toContain('intent_paraphrase');
    expect(sql).toContain('annex_sl_mode');
    expect(sql).toContain('harmonization_key');
    expect(sql).toContain('required_sources');
    expect(sql).toContain('sort_order');
  });

  it('filters by standard when provided', async () => {
    await handler(makeEvent('listClauseRegistry', { standard: 'ISO14001' }));
    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('WHERE standard = :standard');
    expect(params).toContainEqual({ name: 'standard', value: { stringValue: 'ISO14001' } });
  });
});

// ─── saveOrgProfile (versioned write) ─────────────────────────────────────────

describe('saveOrgProfile', () => {
  it('versioned write: UPSERT profile + INSERT version row + bump current_version in ONE txn', async () => {
    // Call 1: UPSERT org_profiles
    mockExecute.mockResolvedValueOnce({
      records: [[{ stringValue: 'profile-1' }, { longValue: 2 }]],
      columnMetadata: [{ name: 'id' }, { name: 'current_version' }],
    });
    // Call 2: INSERT version row
    mockExecute.mockResolvedValueOnce(EMPTY_RESULT);
    // Call 3: UPDATE current_version
    mockExecute.mockResolvedValueOnce(EMPTY_RESULT);

    const payload = JSON.stringify({
      legalName: 'Acme Corp',
      sites: [{ name: 'Main Plant', address: '123 St' }],
      employeeCount: 200,
      industry: 'Manufacturing',
      productsServices: 'Precision widgets',
      coreProcesses: ['machining', 'assembly', 'testing'],
      designResponsibility: true,
      standardsInScope: ['ISO9001', 'ISO14001'],
      managementRep: 'Jane Doe',
    });
    await handler(makeEvent('saveOrgProfile', { input: { payload } }));

    // UPSERT profile
    const [upsertSql] = mockExecute.mock.calls[0];
    expect(upsertSql).toContain('INSERT INTO qms.org_profiles');
    expect(upsertSql).toContain('ON CONFLICT (tenant_id)');
    expect(upsertSql).toContain('RETURNING id, current_version');

    // INSERT version row with ::uuid and ::jsonb casts
    const [versionSql, versionParams] = mockExecute.mock.calls[1];
    expect(versionSql).toContain('INSERT INTO qms.org_profile_versions');
    expect(versionSql).toContain(':profileId::uuid');
    expect(versionSql).toContain(':payload::jsonb');
    expect(versionParams).toContainEqual({ name: 'versionNo', value: { longValue: 3 } }); // 2+1

    // Bump current_version with ::uuid cast
    const [bumpSql] = mockExecute.mock.calls[2];
    expect(bumpSql).toContain('UPDATE qms.org_profiles');
    expect(bumpSql).toContain('current_version = :newVersion');
    expect(bumpSql).toContain('WHERE id = :id::uuid');

    // All in one txn — commit called
    expect(mockCommit).toHaveBeenCalled();
    // Audit event published
    expect(mockPublishAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        detailType: 'Context.Updated',
      }),
    );
  });

  it('accepts the LIVE wire shape: payload arrives as a parsed OBJECT, not a string (found live 2026-07-22)', async () => {
    // AppSync delivers AWSJSON arguments to direct Lambda resolvers already
    // parsed. The prior bare JSON.parse coerced the object to
    // "[object Object]" — saveOrgProfile had never worked from the wire.
    mockExecute.mockResolvedValueOnce({
      records: [[{ stringValue: 'profile-1' }, { longValue: 0 }]],
      columnMetadata: [{ name: 'id' }, { name: 'current_version' }],
    });
    mockExecute.mockResolvedValueOnce(EMPTY_RESULT);
    mockExecute.mockResolvedValueOnce(EMPTY_RESULT);

    const payload = {
      legalName: 'Wire Shape LLC',
      sites: [{ name: 'HQ' }],
      employeeCount: 10,
      industry: 'Construction',
      productsServices: 'Remodeling',
      coreProcesses: ['intake'],
      designResponsibility: false,
      standardsInScope: ['ISO9001'],
      managementRep: 'Ops',
    };
    await handler(makeEvent('saveOrgProfile', { input: { payload } }));

    // The version row receives the validated payload serialized for ::jsonb
    const [, versionParams] = mockExecute.mock.calls[1] as [
      string,
      Array<{ name: string; value: { stringValue?: string } }>,
    ];
    const payloadParam = versionParams.find((p) => p.name === 'payload');
    expect(JSON.parse(payloadParam!.value.stringValue!)).toMatchObject({
      legalName: 'Wire Shape LLC',
    });
    expect(mockCommit).toHaveBeenCalled();
  });

  it('rejects invalid payload: missing legalName (zod ORG-1 schema)', async () => {
    const payload = JSON.stringify({
      standardsInScope: ['ISO9001'],
      sites: [{ name: 'HQ' }],
      employeeCount: 50,
      industry: 'Mfg',
      productsServices: 'Widgets',
      coreProcesses: ['assembly'],
      designResponsibility: true,
      managementRep: 'Jane',
    });
    await expect(handler(makeEvent('saveOrgProfile', { input: { payload } }))).rejects.toThrow(
      'INVALID_PAYLOAD',
    );
  });

  it('rejects invalid payload: empty standardsInScope (zod)', async () => {
    const payload = JSON.stringify({
      legalName: 'Acme',
      standardsInScope: [],
      sites: [{ name: 'HQ' }],
      employeeCount: 50,
      industry: 'Mfg',
      productsServices: 'Widgets',
      coreProcesses: ['assembly'],
      designResponsibility: true,
      managementRep: 'Jane',
    });
    await expect(handler(makeEvent('saveOrgProfile', { input: { payload } }))).rejects.toThrow(
      'INVALID_PAYLOAD',
    );
  });

  it('rejects invalid payload: invalid standard value (zod enum)', async () => {
    const payload = JSON.stringify({
      legalName: 'Acme',
      standardsInScope: ['ISO99999'],
      sites: [{ name: 'HQ' }],
      employeeCount: 50,
      industry: 'Mfg',
      productsServices: 'Widgets',
      coreProcesses: ['assembly'],
      designResponsibility: true,
      managementRep: 'Jane',
    });
    await expect(handler(makeEvent('saveOrgProfile', { input: { payload } }))).rejects.toThrow(
      'INVALID_PAYLOAD',
    );
  });
});

// ─── setClauseApplicability ──────────────────────────────────────────────────

describe('setClauseApplicability', () => {
  it('EXCLUSION_REQUIRES_JUSTIFICATION when applicable=false and no justification', async () => {
    await expect(
      handler(
        makeEvent('setClauseApplicability', {
          input: { clauseRegistryId: 'c-1', applicable: false, justification: '' },
        }),
      ),
    ).rejects.toThrow('EXCLUSION_REQUIRES_JUSTIFICATION');

    // No DB call made
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('upserts with ON CONFLICT (tenant_id, clause_registry_id) and ::uuid cast', async () => {
    mockExecute.mockResolvedValueOnce({
      records: [
        [
          { stringValue: 'ca-1' },
          { stringValue: 'c-1' },
          { booleanValue: false },
          { stringValue: 'Not relevant' },
        ],
      ],
      columnMetadata: [
        { name: 'id' },
        { name: 'clause_registry_id' },
        { name: 'applicable' },
        { name: 'justification' },
      ],
    });

    await handler(
      makeEvent('setClauseApplicability', {
        input: {
          clauseRegistryId: 'c-1',
          applicable: false,
          justification: 'Not relevant to our scope',
        },
      }),
    );

    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('INSERT INTO qms.clause_applicability');
    expect(sql).toContain(':clauseId::uuid');
    expect(sql).toContain('ON CONFLICT (tenant_id, clause_registry_id)');
    expect(sql).toContain('RETURNING id, clause_registry_id, applicable, justification');
    expect(params).toContainEqual({ name: 'applicable', value: { booleanValue: false } });
    expect(params).toContainEqual({
      name: 'justification',
      value: { stringValue: 'Not relevant to our scope' },
    });

    // Audit event
    expect(mockPublishAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        detailType: 'Scope.Changed',
      }),
    );
  });

  it('allows applicable=true without justification', async () => {
    mockExecute.mockResolvedValueOnce({
      records: [
        [{ stringValue: 'ca-1' }, { stringValue: 'c-1' }, { booleanValue: true }, { isNull: true }],
      ],
      columnMetadata: [
        { name: 'id' },
        { name: 'clause_registry_id' },
        { name: 'applicable' },
        { name: 'justification' },
      ],
    });

    await handler(
      makeEvent('setClauseApplicability', {
        input: { clauseRegistryId: 'c-1', applicable: true },
      }),
    );

    const [, params] = mockExecute.mock.calls[0];
    expect(params).toContainEqual({ name: 'applicable', value: { booleanValue: true } });
    expect(params).toContainEqual({ name: 'justification', value: { isNull: true } });
  });
});

// ─── getGenerationRun ─────────────────────────────────────────────────────────

describe('getGenerationRun', () => {
  it('queries generation_runs + generation_sections with ::uuid casts and real 011 columns', async () => {
    // Run query
    mockExecute.mockResolvedValueOnce(EMPTY_RESULT);
    // Sections query
    mockExecute.mockResolvedValueOnce(EMPTY_RESULT);

    await handler(makeEvent('getGenerationRun', { id: 'run-1' }));

    const [runSql] = mockExecute.mock.calls[0];
    expect(runSql).toContain('qms.generation_runs');
    expect(runSql).toContain(':id::uuid');
    expect(runSql).toContain('status');
    expect(runSql).toContain('standards');
    expect(runSql).toContain('manual_document_id');
    expect(runSql).toContain('started_at');
    expect(runSql).toContain('finished_at');

    const [secSql] = mockExecute.mock.calls[1];
    expect(secSql).toContain('qms.generation_sections');
    expect(secSql).toContain(':runId::uuid');
    expect(secSql).toContain('harmonization_key');
    expect(secSql).toContain('clause_registry_ids');
    expect(secSql).toContain('content_sha256');
    expect(secSql).toContain('reviewed_by');
    expect(secSql).toContain('reviewed_at');
  });

  it('returns section clauseRefs as a parsed ARRAY for the AWSJSON slot (double-encode fix, 2026-07-22)', async () => {
    mockExecute.mockResolvedValueOnce({
      records: [[{ stringValue: 'run-1' }, { stringValue: 'complete' }]],
      columnMetadata: [{ name: 'id' }, { name: 'status' }],
    });
    mockExecute.mockResolvedValueOnce({
      records: [
        [
          { stringValue: 'sec-1' },
          { stringValue: '4.1' },
          { stringValue: 'prose' },
          { stringValue: '["c-1","c-2"]' }, // jsonb → string from Data API
        ],
      ],
      columnMetadata: [
        { name: 'id' },
        { name: 'harmonization_key' },
        { name: 'kind' },
        { name: 'clause_refs' },
      ],
    });

    const result = (await handler(makeEvent('getGenerationRun', { id: 'run-1' }))) as {
      sections: Array<{ clauseRefs: unknown }>;
    };
    expect(Array.isArray(result.sections[0].clauseRefs)).toBe(true);
    expect(result.sections[0].clauseRefs).toEqual(['c-1', 'c-2']);
  });
});

// ─── SCHEMA-5 ─────────────────────────────────────────────────────────────────

describe('SCHEMA-5: tenantId from resolverContext only', () => {
  it('saveOrgProfile uses resolverContext tenantId, not input', async () => {
    mockExecute.mockResolvedValueOnce({
      records: [[{ stringValue: 'p-1' }, { longValue: 0 }]],
      columnMetadata: [{ name: 'id' }, { name: 'current_version' }],
    });
    mockExecute.mockResolvedValue(EMPTY_RESULT);

    await handler({
      info: { fieldName: 'saveOrgProfile' },
      arguments: {
        input: {
          payload: JSON.stringify({
            legalName: 'X',
            sites: [{ name: 'A' }],
            employeeCount: 10,
            industry: 'Tech',
            productsServices: 'SW',
            coreProcesses: ['dev'],
            designResponsibility: false,
            standardsInScope: ['ISO9001'],
            managementRep: 'Bob',
          }),
          tenantId: 'evil',
        },
      },
      identity: {
        resolverContext: { tenantId: 'tenant-test', sub: 'user-test', role: 'QualityManager' },
      },
    });

    const [, params] = mockExecute.mock.calls[0];
    expect(params).toContainEqual({ name: 'tenantId', value: { stringValue: 'tenant-test' } });
    expect(params).not.toContainEqual(expect.objectContaining({ value: { stringValue: 'evil' } }));
  });
});

// ─── Task 8: markSectionReviewed ──────────────────────────────────────────────

describe('markSectionReviewed', () => {
  it('stamps reviewed_by/reviewed_at with ::uuid cast on sectionId (run status = complete)', async () => {
    mockExecute.mockResolvedValueOnce({
      records: [
        [
          { stringValue: 'sec-1' },
          { stringValue: 'run-1' },
          { isNull: true },
          { stringValue: 'complete' },
        ],
      ],
      columnMetadata: [
        { name: 'id' },
        { name: 'run_id' },
        { name: 'reviewed_at' },
        { name: 'run_status' },
      ],
    });
    mockExecute.mockResolvedValueOnce({
      records: [
        [
          { stringValue: 'sec-1' },
          { stringValue: 'hk-1' },
          { stringValue: 'prose' },
          { stringValue: '[]' },
          { isNull: true },
          { stringValue: 'user-test' },
          { stringValue: '2026-07-15T00:00:00Z' },
          { isNull: true },
        ],
      ],
      columnMetadata: [
        { name: 'id' },
        { name: 'harmonization_key' },
        { name: 'kind' },
        { name: 'clause_refs' },
        { name: 'content_sha256' },
        { name: 'reviewed_by' },
        { name: 'reviewed_at' },
        { name: 'error' },
      ],
    });

    await handler(makeEvent('markSectionReviewed', { input: { sectionId: 'sec-1' } }));

    const [fetchSql] = mockExecute.mock.calls[0];
    expect(fetchSql).toContain(':sectionId::uuid');
    expect(fetchSql).toContain('qms.generation_sections');
    expect(fetchSql).toContain('qms.generation_runs');

    const [updateSql] = mockExecute.mock.calls[1];
    expect(updateSql).toContain('reviewed_by');
    expect(updateSql).toContain('reviewed_at');
    expect(updateSql).toContain(':sectionId::uuid');
    expect(mockCommit).toHaveBeenCalled();
  });

  it('RUN_NOT_REVIEWABLE when parent run is running (content not final)', async () => {
    mockExecute.mockResolvedValueOnce({
      records: [
        [
          { stringValue: 'sec-1' },
          { stringValue: 'run-1' },
          { isNull: true },
          { stringValue: 'running' },
        ],
      ],
      columnMetadata: [
        { name: 'id' },
        { name: 'run_id' },
        { name: 'reviewed_at' },
        { name: 'run_status' },
      ],
    });

    await expect(
      handler(makeEvent('markSectionReviewed', { input: { sectionId: 'sec-1' } })),
    ).rejects.toThrow('RUN_NOT_REVIEWABLE');
    expect(mockRollback).toHaveBeenCalled();
  });

  it('RUN_NOT_REVIEWABLE when parent run is failed', async () => {
    mockExecute.mockResolvedValueOnce({
      records: [
        [
          { stringValue: 'sec-1' },
          { stringValue: 'run-1' },
          { isNull: true },
          { stringValue: 'failed' },
        ],
      ],
      columnMetadata: [
        { name: 'id' },
        { name: 'run_id' },
        { name: 'reviewed_at' },
        { name: 'run_status' },
      ],
    });

    await expect(
      handler(makeEvent('markSectionReviewed', { input: { sectionId: 'sec-1' } })),
    ).rejects.toThrow('RUN_NOT_REVIEWABLE');
  });

  it('UNAUTHORIZED when role lacks M1 approval permission', async () => {
    const event = {
      info: { fieldName: 'markSectionReviewed' },
      arguments: { input: { sectionId: 'sec-1' } },
      identity: {
        resolverContext: { tenantId: 'tenant-test', sub: 'user-test', role: 'Employee' },
      },
    };

    await expect(handler(event)).rejects.toThrow('UNAUTHORIZED');
    // No SQL executed
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

// ─── Role gate: canApprove(role, 'M1') ────────────────────────────────────────

describe('canApprove role gate on QMS mutations', () => {
  it('saveOrgProfile: UNAUTHORIZED for Employee role, no SQL executed', async () => {
    const event = {
      info: { fieldName: 'saveOrgProfile' },
      arguments: { input: { payload: '{}' } },
      identity: {
        resolverContext: { tenantId: 'tenant-test', sub: 'user-test', role: 'Employee' },
      },
    };

    await expect(handler(event)).rejects.toThrow('UNAUTHORIZED');
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('setClauseApplicability: UNAUTHORIZED for Employee role, no SQL executed', async () => {
    const event = {
      info: { fieldName: 'setClauseApplicability' },
      arguments: { input: { clauseRegistryId: 'c-1', applicable: true } },
      identity: {
        resolverContext: { tenantId: 'tenant-test', sub: 'user-test', role: 'Employee' },
      },
    };

    await expect(handler(event)).rejects.toThrow('UNAUTHORIZED');
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('saveOrgProfile: QualityManager role passes gate (M1 in write modules)', async () => {
    mockExecute.mockResolvedValueOnce({
      records: [[{ stringValue: 'p-1' }, { longValue: 0 }]],
      columnMetadata: [{ name: 'id' }, { name: 'current_version' }],
    });
    mockExecute.mockResolvedValue({ records: [], columnMetadata: [] });

    const payload = JSON.stringify({
      legalName: 'X',
      sites: [{ name: 'A' }],
      employeeCount: 10,
      industry: 'Tech',
      productsServices: 'SW',
      coreProcesses: ['dev'],
      designResponsibility: false,
      standardsInScope: ['ISO9001'],
      managementRep: 'Bob',
    });
    await handler(makeEvent('saveOrgProfile', { input: { payload } }));

    // SQL executed (gate passed)
    expect(mockExecute).toHaveBeenCalled();
  });
});

describe('runManualSectionDraft (S3 Manual Studio)', () => {
  const PROFILE = JSON.stringify({ legalName: 'Meridian Design-Build LLC', documentLocale: 'en' });

  function wireReads() {
    // 1: run+profile (raw records access), 2: section (marshalOne), 3: clauses (marshalMany)
    mockExecute
      .mockResolvedValueOnce({
        records: [[{ stringValue: 'doc-manual-1' }, { stringValue: PROFILE }]],
        columnMetadata: [{ name: 'manual_document_id' }, { name: 'payload' }],
      })
      .mockResolvedValueOnce({
        records: [[{ stringValue: 'GAP' }, { arrayValue: { stringValues: ['c-41'] } }]],
        columnMetadata: [{ name: 'status' }, { name: 'clause_registry_ids' }],
      })
      .mockResolvedValueOnce({
        records: [
          [
            { stringValue: 'ISO9001' },
            { stringValue: '4.1' },
            { stringValue: 'Understanding the organization' },
            { stringValue: 'Determine external and internal issues' },
            { stringValue: '["profile.legalName"]' },
          ],
        ],
        columnMetadata: [
          { name: 'standard' },
          { name: 'clause_no' },
          { name: 'clause_title' },
          { name: 'intent_paraphrase' },
          { name: 'required_sources' },
        ],
      });
  }

  beforeEach(() => {
    mockLambdaSend.mockReset().mockResolvedValue({});
  });

  it('reads context, Event-invokes DocStudio with sectionDraftIntent, acks DISPATCHED — and publishes NO audit event (fail-closed registry, found live 2026-07-22)', async () => {
    wireReads();
    const result = (await handler(
      makeEvent('runManualSectionDraft', { runId: 'genrun-1', harmonizationKey: '4.2' }),
    )) as { runId: string; status: string };

    expect(result.status).toBe('DISPATCHED');
    expect(result.runId).toBeTruthy();

    expect(mockLambdaSend).toHaveBeenCalledOnce();
    const cmd = mockLambdaSend.mock.calls[0][0] as {
      input: { InvocationType: string; Payload: string };
    };
    expect(cmd.input.InvocationType).toBe('Event');
    const payload = JSON.parse(cmd.input.Payload);
    expect(payload.sectionDraftIntent.generationRunId).toBe('genrun-1');
    expect(payload.sectionDraftIntent.harmonizationKey).toBe('4.2');
    expect(payload.sectionDraftIntent.sectionKind).toBe('gap');
    expect(payload.sectionDraftIntent.clauses[0].clauseNo).toBe('4.1');
    expect(payload.sectionDraftIntent.orgProfile.legalName).toBe('Meridian Design-Build LLC');
    expect(payload.requestedBy).toBe('user-test');

    // The dispatch must NOT audit — 'Agent.RunRequested' is unregistered and
    // the registry throws AFTER the invoke, failing the mutation while the
    // agent run proceeds (the S3 witness failure). HITL plane owns the trail.
    expect(mockPublishAuditEvent).not.toHaveBeenCalled();
  });

  it('SECTION_NOT_FOUND when the harmonization key does not exist on the run', async () => {
    mockExecute
      .mockResolvedValueOnce({
        records: [[{ stringValue: 'doc-manual-1' }, { stringValue: PROFILE }]],
        columnMetadata: [{ name: 'manual_document_id' }, { name: 'payload' }],
      })
      .mockResolvedValueOnce({ records: [], columnMetadata: [] });

    await expect(
      handler(makeEvent('runManualSectionDraft', { runId: 'genrun-1', harmonizationKey: 'nope' })),
    ).rejects.toThrow('SECTION_NOT_FOUND');
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });
});
