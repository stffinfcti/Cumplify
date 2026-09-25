/**
 * Task 6 tests — derived content (pure) + FinalizeManual handler behavior.
 * Spine assertions: IMS-vs-single standard, BC-1 disclaimer present and
 * fixed (never model text), matrix/master list DERIVED shapes, idempotency
 * guard skips document writes, failed sections ship no clause document.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  assembleManualContent,
  deriveCorrelationMatrix,
  deriveMasterList,
  documentStandard,
  clauseDocTitle,
  BC1_DISCLAIMER,
  type SectionState,
} from '../src/derive.js';

const SECTIONS: SectionState[] = [
  {
    sectionKey: '4.4',
    kind: 'prose',
    clauses: [
      {
        standard: 'ISO9001',
        clauseNo: '4.4',
        clauseTitle: 'QMS and its processes',
        annexSlMode: 'shared',
        docType: 'procedure',
      },
      {
        standard: 'ISO14001',
        clauseNo: '4.4',
        clauseTitle: 'EMS',
        annexSlMode: 'shared',
        docType: 'procedure',
      },
    ],
    content: { sentences: [{ text: 'Acme integrates.', factRefs: ['F1'] }] },
    sortOrder: 44,
  },
  {
    sectionKey: '6.1.2-aspects#ISO14001',
    kind: 'gap',
    clauses: [
      {
        standard: 'ISO14001',
        clauseNo: '6.1.2',
        clauseTitle: 'Aspects',
        annexSlMode: 'standard_only',
        docType: 'procedure',
      },
    ],
    content: { gap: { missingSources: ['register.aspects'] } },
    sortOrder: 61,
  },
  {
    sectionKey: '8.3#ISO9001',
    kind: 'na_justified',
    clauses: [
      {
        standard: 'ISO9001',
        clauseNo: '8.3',
        clauseTitle: 'Design and development',
        annexSlMode: 'standard_only',
        docType: 'procedure',
      },
    ],
    content: { naJustification: 'build-to-print only' },
    sortOrder: 83,
  },
  {
    sectionKey: '9.9#ISO9001',
    kind: 'failed',
    clauses: [
      {
        standard: 'ISO9001',
        clauseNo: '9.9',
        clauseTitle: 'Synthetic',
        annexSlMode: 'standard_only',
        docType: 'procedure',
      },
    ],
    content: null,
    sortOrder: 99,
  },
];

const PROFILE = { legalName: 'Acme', sites: [{ name: 'HQ', city: 'X' }], managementRep: 'Jane' };

describe('derive — manual content', () => {
  const manual = assembleManualContent('doc-1', 'en', PROFILE, ['ISO9001', 'ISO14001'], SECTIONS);

  it('front matter carries the FIXED BC-1 disclaimer + ISO purchase link', () => {
    const fm = manual.frontMatter as Record<string, unknown>;
    expect(fm.purpose).toBe(BC1_DISCLAIMER);
    expect(JSON.stringify(fm.normativeRefs)).toContain('iso.org/store');
  });

  it('every section appears in sort order — gap and na are IN the manual, failed is a marker', () => {
    const sections = manual.sections as Array<Record<string, unknown>>;
    expect(sections.map((s) => s.harmonizationKey)).toEqual([
      '4.4',
      '6.1.2-aspects#ISO14001',
      '8.3#ISO9001',
      '9.9#ISO9001',
    ]);
    expect(sections[1].gap).toEqual({ missingSources: ['register.aspects'] });
    expect(sections[2].naJustification).toBe('build-to-print only');
    expect(sections[3].failed).toBe(true);
    expect(sections[3].sentences).toBeUndefined();
  });
});

describe('derive — matrix, master list, helpers', () => {
  it('correlation matrix rows carry per-standard coverage with Annex SL mode', () => {
    const m = deriveCorrelationMatrix('doc-m', 'en', ['ISO9001', 'ISO14001'], SECTIONS);
    const rows = m.rows as Array<Record<string, unknown>>;
    expect(rows[0].harmonizationKey).toBe('4.4');
    const coverage = rows[0].coverage as Array<Record<string, unknown>>;
    expect(coverage.map((c) => c.standard).sort()).toEqual(['ISO14001', 'ISO9001']);
    expect(coverage[0].annexSlMode).toBe('shared');
  });

  it('master list is a flat register of what the run produced', () => {
    const ml = deriveMasterList('doc-l', 'en', [
      {
        documentId: 'a',
        title: 'Manual',
        docType: 'manual',
        standard: 'IMS',
        clauseRefs: ['4.4'],
        status: 'draft',
        versionNo: 1,
        contentRef: 'tenants/t/documents/a/v1.json',
      },
    ]);
    expect(ml.generatedCount).toBe(1);
    expect((ml.entries as unknown[]).length).toBe(1);
  });

  it('documentStandard: IMS only when spanning multiple standards (GEN-4)', () => {
    expect(documentStandard(['ISO9001', 'ISO14001'])).toBe('IMS');
    expect(documentStandard(['ISO9001'])).toBe('ISO9001');
  });

  it('clause doc titles come from registry data', () => {
    expect(clauseDocTitle(SECTIONS[0])).toBe('QMS and its processes (4.4)');
  });
});

// ─── FinalizeManual handler ───────────────────────────────────────────────────

const {
  mockExecute,
  mockCommit,
  mockRollback,
  mockPublishAuditEvent,
  mockS3Send,
  mockPublishEvent,
} = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockCommit: vi.fn(),
  mockRollback: vi.fn(),
  mockPublishAuditEvent: vi.fn(),
  mockS3Send: vi.fn(),
  mockPublishEvent: vi.fn(),
}));

vi.mock('../../api/src/resolvers/shared.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/src/resolvers/shared.js')>();
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
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = mockS3Send;
  },
  PutObjectCommand: class {
    constructor(public input: unknown) {}
  },
  GetObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));
vi.mock('../src/appsync-publish.js', () => ({ publishGenerationEvent: mockPublishEvent }));
vi.mock('@aws-lambda-powertools/logger', () => ({
  Logger: class {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    appendKeys = vi.fn();
  },
}));

process.env.GENERAL_BUCKET = 'test-bucket';

import { handler as finalizeHandler } from '../src/finalize-manual.js';

beforeEach(() => {
  mockExecute.mockReset();
  mockCommit.mockReset();
  mockRollback.mockReset();
  mockPublishAuditEvent.mockReset().mockResolvedValue('evt');
  mockS3Send.mockReset().mockResolvedValue({});
  mockPublishEvent.mockReset().mockResolvedValue(undefined);
});

describe('FinalizeManual handler', () => {
  it('idempotency guard: manual_document_id already set → NO document writes, state returned', async () => {
    mockExecute
      .mockResolvedValueOnce({
        records: [
          [
            { arrayValue: { stringValues: ['ISO9001'] } },
            { stringValue: 'existing-manual-id' },
            { stringValue: 'owner-1' },
            { stringValue: '{}' },
          ],
        ],
        columnMetadata: [
          { name: 'standards' },
          { name: 'manual_document_id' },
          { name: 'requested_by' },
          { name: 'payload' },
        ],
      })
      .mockResolvedValueOnce({
        records: [
          [
            { stringValue: 's-1' },
            { stringValue: '4.4' },
            { stringValue: 'prose' },
            { stringValue: 'k' },
            { arrayValue: { stringValues: [] } },
          ],
        ],
        columnMetadata: [
          { name: 'id' },
          { name: 'harmonization_key' },
          { name: 'status' },
          { name: 'content_s3_key' },
          { name: 'clause_registry_ids' },
        ],
      });

    const out = await finalizeHandler({ runId: 'run-1', tenantId: 'tenant-test' });

    expect(out.manualDocumentId).toBe('existing-manual-id');
    expect(out.documentsCreated).toBe(0);
    const sqls = mockExecute.mock.calls.map((c) => c[0] as string);
    expect(sqls.some((s) => s.includes('INSERT INTO m1.documents'))).toBe(false);
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it('writes manual + clause docs (SKIPPING failed) + matrix + master list, stamps manual_document_id, real content_ref/sha', async () => {
    const REG_COLS = [
      { name: 'id' },
      { name: 'standard' },
      { name: 'clause_no' },
      { name: 'clause_title' },
      { name: 'annex_sl_mode' },
      { name: 'doc_type' },
      { name: 'sort_order' },
    ];
    let docCounter = 0;
    mockExecute.mockImplementation((sql: string) => {
      if (sql.includes('FROM qms.generation_runs')) {
        return Promise.resolve({
          records: [
            [
              { arrayValue: { stringValues: ['ISO9001', 'ISO14001'] } },
              { isNull: true },
              { stringValue: 'owner-1' },
              { stringValue: JSON.stringify({ legalName: 'Acme', sites: [{ name: 'HQ' }] }) },
            ],
          ],
          columnMetadata: [
            { name: 'standards' },
            { name: 'manual_document_id' },
            { name: 'requested_by' },
            { name: 'payload' },
          ],
        });
      }
      if (sql.includes('FROM qms.generation_sections')) {
        return Promise.resolve({
          records: [
            [
              { stringValue: 's-1' },
              { stringValue: '4.4' },
              { stringValue: 'prose' },
              { stringValue: 'sec/4.4.json' },
              { arrayValue: { stringValues: ['c-1'] } },
            ],
            [
              { stringValue: 's-2' },
              { stringValue: '9.9#ISO9001' },
              { stringValue: 'failed' },
              { isNull: true },
              { arrayValue: { stringValues: ['c-2'] } },
            ],
          ],
          columnMetadata: [
            { name: 'id' },
            { name: 'harmonization_key' },
            { name: 'status' },
            { name: 'content_s3_key' },
            { name: 'clause_registry_ids' },
          ],
        });
      }
      if (sql.includes('FROM qms.clause_registry')) {
        return Promise.resolve({
          records: [
            [
              { stringValue: 'c-1' },
              { stringValue: 'ISO9001' },
              { stringValue: '4.4' },
              { stringValue: 'QMS' },
              { stringValue: 'shared' },
              { stringValue: 'procedure' },
              { longValue: 44 },
            ],
            [
              { stringValue: 'c-2' },
              { stringValue: 'ISO9001' },
              { stringValue: '9.9' },
              { stringValue: 'Synthetic' },
              { stringValue: 'standard_only' },
              { stringValue: 'procedure' },
              { longValue: 99 },
            ],
          ],
          columnMetadata: REG_COLS,
        });
      }
      if (sql.includes('INSERT INTO m1.documents')) {
        docCounter += 1;
        return Promise.resolve({
          records: [[{ stringValue: `doc-${docCounter}` }]],
          columnMetadata: [{ name: 'id' }],
        });
      }
      if (sql.includes('MAX(v.version_no)')) {
        return Promise.resolve({
          records: [[{ longValue: 1 }]],
          columnMetadata: [{ name: 'next' }],
        });
      }
      return Promise.resolve({ records: [], columnMetadata: [] });
    });
    // S3 GetObject for the prose section content
    mockS3Send.mockImplementation((cmd: { input: { Key?: string } }) => {
      if (cmd.constructor.name === 'GetObjectCommand') {
        return Promise.resolve({
          Body: {
            transformToString: () =>
              Promise.resolve(JSON.stringify({ sentences: [{ text: 'Acme.', factRefs: ['F1'] }] })),
          },
        });
      }
      return Promise.resolve({});
    });

    const out = await finalizeHandler({ runId: 'run-1', tenantId: 'tenant-test' });

    // manual + 1 clause doc (failed skipped) + matrix + master list = 4
    expect(out.documentsCreated).toBe(4);
    expect(out.status).toBe('partial'); // one failed section
    expect(out.manualDocumentId).toBe('doc-1');

    const sqls = mockExecute.mock.calls.map((c) => c[0] as string);
    const versionInserts = sqls.filter((s) => s.includes('INSERT INTO m1.document_versions'));
    expect(versionInserts).toHaveLength(4);
    for (const s of versionInserts) expect(s).toContain('content_ref, content_sha256');

    const runUpdate = sqls.find((s) => s.includes('manual_document_id = :manualId::uuid'))!;
    expect(runUpdate).toContain('status = :status');

    // manual standard is IMS (two standards in scope)
    const docParams = mockExecute.mock.calls
      .filter((c) => (c[0] as string).includes('INSERT INTO m1.documents'))
      .map((c) => c[1] as Array<{ name: string; value: { stringValue?: string } }>);
    const manualStandard = docParams[0].find((p) => p.name === 'standard')!.value.stringValue;
    expect(manualStandard).toBe('IMS');

    // doc_type params must be DB-cased (marshalMany uppercases via
    // REVERSE_ENUMS — live defect r4: 'PROCEDURE' violated the CHECK)
    for (const params of docParams) {
      const dt = params.find((p) => p.name === 'docType')!.value.stringValue!;
      expect(dt).toBe(dt.toLowerCase());
    }

    expect(mockPublishAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        detailType: 'Generation.RunCompleted',
        payload: expect.objectContaining({ documentsCreated: 4 }),
      }),
    );
  });

  it('B2 (ruling C): INSERT INTO m1.documents uses ON CONFLICT (tenant_id, harmonization_key) for clause docs — idempotent finalize', async () => {
    const REG_COLS = [
      { name: 'id' },
      { name: 'standard' },
      { name: 'clause_no' },
      { name: 'clause_title' },
      { name: 'annex_sl_mode' },
      { name: 'doc_type' },
      { name: 'sort_order' },
    ];
    mockExecute.mockImplementation((sql: string) => {
      if (sql.includes('FROM qms.generation_runs')) {
        return Promise.resolve({
          records: [
            [
              { arrayValue: { stringValues: ['ISO9001'] } },
              { isNull: true },
              { stringValue: 'owner-1' },
              { stringValue: JSON.stringify({ legalName: 'X' }) },
            ],
          ],
          columnMetadata: [
            { name: 'standards' },
            { name: 'manual_document_id' },
            { name: 'requested_by' },
            { name: 'payload' },
          ],
        });
      }
      if (sql.includes('FROM qms.generation_sections')) {
        return Promise.resolve({
          records: [
            [
              { stringValue: 's-1' },
              { stringValue: '4.4' },
              { stringValue: 'prose' },
              { stringValue: 'sec/4.4.json' },
              { arrayValue: { stringValues: ['c-1'] } },
            ],
          ],
          columnMetadata: [
            { name: 'id' },
            { name: 'harmonization_key' },
            { name: 'status' },
            { name: 'content_s3_key' },
            { name: 'clause_registry_ids' },
          ],
        });
      }
      if (sql.includes('FROM qms.clause_registry')) {
        return Promise.resolve({
          records: [
            [
              { stringValue: 'c-1' },
              { stringValue: 'ISO9001' },
              { stringValue: '4.4' },
              { stringValue: 'QMS' },
              { stringValue: 'shared' },
              { stringValue: 'procedure' },
              { longValue: 44 },
            ],
          ],
          columnMetadata: REG_COLS,
        });
      }
      if (sql.includes('INSERT INTO m1.documents')) {
        return Promise.resolve({
          records: [[{ stringValue: 'doc-idem' }]],
          columnMetadata: [{ name: 'id' }],
        });
      }
      if (sql.includes('MAX(v.version_no)')) {
        return Promise.resolve({
          records: [[{ longValue: 1 }]],
          columnMetadata: [{ name: 'next' }],
        });
      }
      return Promise.resolve({ records: [], columnMetadata: [] });
    });
    mockS3Send.mockImplementation((cmd: { input: { Key?: string } }) => {
      if (cmd.constructor.name === 'GetObjectCommand') {
        return Promise.resolve({
          Body: {
            transformToString: () =>
              Promise.resolve(JSON.stringify({ sentences: [{ text: 'X.' }] })),
          },
        });
      }
      return Promise.resolve({});
    });

    await finalizeHandler({ runId: 'run-1', tenantId: 'tenant-test' });

    // Every INSERT INTO m1.documents carries harmonization_key + ON CONFLICT
    const insertCalls = mockExecute.mock.calls.filter((c) =>
      (c[0] as string).includes('INSERT INTO m1.documents'),
    );
    expect(insertCalls.length).toBeGreaterThanOrEqual(3); // manual + clause + matrix (master list)

    for (const call of insertCalls) {
      const sql = call[0] as string;
      expect(sql).toContain('harmonization_key');
      expect(sql).toContain('ON CONFLICT');
      // harmonizationKey param is present
      const params = call[1] as Array<{ name: string; value: { stringValue?: string } }>;
      const hkParam = params.find((p) => p.name === 'hk');
      expect(hkParam).toBeDefined();
      expect(hkParam!.value.stringValue).toBeTruthy();
    }

    // Verify well-known keys: manual=__MANUAL__, matrix=__CORRELATION_MATRIX__
    const hkValues = insertCalls.map(
      (c) =>
        (c[1] as Array<{ name: string; value: { stringValue?: string } }>).find(
          (p) => p.name === 'hk',
        )!.value.stringValue,
    );
    expect(hkValues).toContain('__MANUAL__');
    expect(hkValues).toContain('__CORRELATION_MATRIX__');
    expect(hkValues).toContain('__MASTER_LIST__');
    // Clause doc gets the section's sectionKey
    expect(hkValues).toContain('4.4');
  });
});
