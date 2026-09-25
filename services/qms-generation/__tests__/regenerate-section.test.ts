/**
 * RegenerateSectionFn hermetic tests (GEN-6, spec-40 regenerateSection wave).
 *
 * Pins: guards (RUN_NOT_FOUND / RUN_NOT_FINALIZED / SECTION_NOT_FOUND),
 * review-state CLEARED on reset (APR-1 is not inheritable), compose invoked
 * with the section identity, NEW manual version at MAX+1 (::integer cast),
 * clause-doc version for the section, master-list REFRESH re-pointing every
 * entry at its latest version, run-status recompute (complete↔partial),
 * still-failed ships NO clause version, previously-failed→prose CREATES the
 * missing clause document.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExecute, mockCommit, mockRollback, mockPublishAudit, mockS3Send, mockCompose } =
  vi.hoisted(() => ({
    mockExecute: vi.fn(),
    mockCommit: vi.fn(),
    mockRollback: vi.fn(),
    mockPublishAudit: vi.fn().mockResolvedValue('evt-test'),
    mockS3Send: vi.fn(),
    mockCompose: vi.fn(),
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
    publishAuditEvent: mockPublishAudit,
  };
});
vi.mock('../src/compose-section.js', () => ({ handler: mockCompose }));
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
vi.mock('@aws-lambda-powertools/logger', () => ({
  Logger: class {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    appendKeys = vi.fn();
  },
}));

process.env.GENERAL_BUCKET = 'test-bucket';

import { handler } from '../src/regenerate-section.js';

const T = 'tenant-test';
const RUN = 'run-1111';
const SECTION_ID = 'sec-ctx-id';
const MANUAL = 'doc-manual-1';
const CLAUSE_DOC = 'doc-clause-41';
const MATRIX = 'doc-matrix-1';
const MASTER = 'doc-master-1';
const HKEY = 'context-of-the-organization';

const rows = (columns: string[], data: unknown[][]) => ({
  records: data.map((r) =>
    r.map((v) => {
      if (v === null) return { isNull: true };
      if (typeof v === 'boolean') return { booleanValue: v };
      if (typeof v === 'number') return { longValue: v };
      if (Array.isArray(v)) return { arrayValue: { stringValues: v } };
      return { stringValue: v as string };
    }),
  ),
  columnMetadata: columns.map((name) => ({ name })),
});
const emptyRes = { records: [], columnMetadata: [] };

interface Fx {
  runStatus: string;
  manualDocId: string | null;
  sectionKindDb: string; // section status in DB during txn2 (post-compose)
  clauseDocMatches: boolean; // candidate clause-doc content matches HKEY
  otherFailed: boolean; // another section is failed (drives partial)
}

const S3_JSON: Record<string, unknown> = {};

function wire(fx: Fx) {
  S3_JSON[`tenants/${T}/gen/${RUN}/${HKEY}.json`] = {
    harmonizationKey: HKEY,
    kind: 'prose',
    sentences: [{ text: 'The organization determines its context.', factRefs: ['F1'] }],
  };
  S3_JSON[`tenants/${T}/gen/${RUN}/leadership.json`] = {
    harmonizationKey: 'leadership',
    kind: 'prose',
    sentences: [{ text: 'Top management leads.', factRefs: ['F1'] }],
  };
  S3_JSON[`tenants/${T}/documents/${MASTER}/v1.json`] = {
    kind: 'master_list',
    entries: [
      {
        documentId: MANUAL,
        title: 'IMS Manual',
        docType: 'manual',
        standard: 'IMS',
        clauseRefs: ['4.1', '5.1'],
        status: 'draft',
        versionNo: 1,
        contentRef: `tenants/${T}/documents/${MANUAL}/v1.json`,
      },
      {
        documentId: CLAUSE_DOC,
        title: 'Context',
        docType: 'procedure',
        standard: 'ISO9001',
        clauseRefs: ['4.1'],
        status: 'draft',
        versionNo: 1,
        contentRef: `tenants/${T}/documents/${CLAUSE_DOC}/v1.json`,
      },
      {
        documentId: MATRIX,
        title: 'Matrix',
        docType: 'correlation_matrix',
        standard: 'IMS',
        clauseRefs: ['4.1', '5.1'],
        status: 'draft',
        versionNo: 1,
        contentRef: `tenants/${T}/documents/${MATRIX}/v1.json`,
      },
    ],
  };
  S3_JSON[`tenants/${T}/documents/${CLAUSE_DOC}/v1.json`] = {
    sections: [{ harmonizationKey: fx.clauseDocMatches ? HKEY : 'something-else' }],
  };

  mockS3Send.mockImplementation(
    async (cmd: { constructor: { name: string }; input: { Key: string } }) => {
      if (cmd.constructor.name === 'GetObjectCommand') {
        const body = S3_JSON[cmd.input.Key];
        if (!body) throw new Error(`NoSuchKey: ${cmd.input.Key}`);
        return { Body: { transformToString: async () => JSON.stringify(body) } };
      }
      return {};
    },
  );

  mockExecute.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM qms.generation_runs gr')) {
      if (!fx.manualDocId && fx.runStatus === 'MISSING') return emptyRes;
      return rows(
        ['standards', 'manual_document_id', 'status', 'payload'],
        [
          [
            ['ISO9001'],
            fx.manualDocId,
            fx.runStatus,
            JSON.stringify({
              legalName: 'Test Org',
              documentLocale: 'en',
              standardsInScope: ['ISO9001'],
            }),
          ],
        ],
      );
    }
    if (sql.includes('AND harmonization_key = :hkey')) {
      if (fx.sectionKindDb === 'MISSING') return emptyRes;
      return rows(['id', 'status'], [[SECTION_ID, 'prose']]);
    }
    if (sql.includes('SELECT clause_registry_ids FROM qms.generation_sections')) {
      // S3 override path: clause refs for the approved-draft content JSON
      return rows(['clause_registry_ids'], [[['c-41']]]);
    }
    if (sql.includes('SELECT standard, clause_no FROM qms.clause_registry')) {
      return rows(['standard', 'clause_no'], [['ISO9001', '4.1']]);
    }
    if (sql.includes('FROM qms.generation_sections WHERE run_id')) {
      return rows(
        ['id', 'harmonization_key', 'status', 'content_s3_key', 'clause_registry_ids'],
        [
          [
            SECTION_ID,
            HKEY,
            fx.sectionKindDb,
            fx.sectionKindDb === 'failed' ? null : `tenants/${T}/gen/${RUN}/${HKEY}.json`,
            ['c-41'],
          ],
          [
            'sec-other',
            'leadership',
            fx.otherFailed ? 'failed' : 'prose',
            fx.otherFailed ? null : `tenants/${T}/gen/${RUN}/leadership.json`,
            ['c-51'],
          ],
        ],
      );
    }
    if (sql.includes('FROM qms.clause_registry')) {
      return rows(
        ['id', 'standard', 'clause_no', 'clause_title', 'annex_sl_mode', 'doc_type', 'sort_order'],
        [
          ['c-41', 'ISO9001', '4.1', 'Understanding the organization', 'shared', 'procedure', 1],
          ['c-51', 'ISO9001', '5.1', 'Leadership and commitment', 'shared', 'procedure', 2],
        ],
      );
    }
    if (sql.includes('d.harmonization_key IN (')) {
      // Sentinel-key doc resolution (019 unique index): master + matrix +
      // this section's clause doc (only when fx.clauseDocMatches).
      const docRows: unknown[][] = [
        ['__MASTER_LIST__', MASTER, 'master_list', `tenants/${T}/documents/${MASTER}/v1.json`],
        [
          '__CORRELATION_MATRIX__',
          MATRIX,
          'correlation_matrix',
          `tenants/${T}/documents/${MATRIX}/v1.json`,
        ],
      ];
      if (fx.clauseDocMatches) {
        docRows.push([
          HKEY,
          CLAUSE_DOC,
          'procedure',
          `tenants/${T}/documents/${CLAUSE_DOC}/v1.json`,
        ]);
      }
      return rows(['harmonization_key', 'id', 'doc_type', 'content_ref'], docRows);
    }
    if (sql.includes('GROUP BY v.document_id')) {
      // Batched lock+MAX(version_no)+1 for every doc being versioned
      return rows(
        ['document_id', 'next'],
        [
          [MANUAL, 2],
          [CLAUSE_DOC, 2],
          [MATRIX, 2],
          [MASTER, 2],
        ],
      );
    }
    if (sql.includes('DISTINCT ON (v.document_id)')) {
      return rows(
        ['document_id', 'version_no', 'content_ref', 'status'],
        [
          [MANUAL, 2, `tenants/${T}/documents/${MANUAL}/v2.json`, 'draft'],
          [CLAUSE_DOC, 2, `tenants/${T}/documents/${CLAUSE_DOC}/v2.json`, 'draft'],
          [MATRIX, 1, `tenants/${T}/documents/${MATRIX}/v1.json`, 'draft'],
        ],
      );
    }
    if (sql.includes('INSERT INTO m1.documents')) {
      return rows(['id'], [['doc-new-created']]);
    }
    if (sql.includes('status AS kind')) {
      return rows(
        [
          'id',
          'kind',
          'harmonization_key',
          'clause_refs',
          'content_sha256',
          'reviewed_by',
          'reviewed_at',
          'error',
        ],
        [[SECTION_ID, fx.sectionKindDb, HKEY, ['c-41'], 'sha-new', null, null, null]],
      );
    }
    return emptyRes;
  });
}

beforeEach(() => {
  mockExecute.mockReset();
  mockCommit.mockReset();
  mockRollback.mockReset();
  mockS3Send.mockReset();
  mockPublishAudit.mockClear();
  mockCompose.mockReset().mockResolvedValue({ sectionId: SECTION_ID, status: 'prose' });
});

const input = { tenantId: T, runId: RUN, harmonizationKey: HKEY, actor: 'reviewer-1' };

describe('regenerateSection guards', () => {
  it('RUN_NOT_FOUND when the run does not exist', async () => {
    wire({
      runStatus: 'MISSING',
      manualDocId: null,
      sectionKindDb: 'prose',
      clauseDocMatches: true,
      otherFailed: false,
    });
    await expect(handler(input)).rejects.toThrow('RUN_NOT_FOUND');
    expect(mockCompose).not.toHaveBeenCalled();
  });

  it('RUN_NOT_FINALIZED when manual_document_id is NULL (no doc plane to version)', async () => {
    wire({
      runStatus: 'running',
      manualDocId: null,
      sectionKindDb: 'prose',
      clauseDocMatches: true,
      otherFailed: false,
    });
    await expect(handler(input)).rejects.toThrow('RUN_NOT_FINALIZED');
    expect(mockCompose).not.toHaveBeenCalled();
  });

  it('SECTION_NOT_FOUND for an unknown harmonization key', async () => {
    wire({
      runStatus: 'complete',
      manualDocId: MANUAL,
      sectionKindDb: 'MISSING',
      clauseDocMatches: true,
      otherFailed: false,
    });
    await expect(handler(input)).rejects.toThrow('SECTION_NOT_FOUND');
    expect(mockCompose).not.toHaveBeenCalled();
  });
});

describe('regenerateSection happy path (prose → prose)', () => {
  it('resets review state, composes, writes manual v2 + clause-doc v2 + refreshed master list; no run-status change', async () => {
    wire({
      runStatus: 'complete',
      manualDocId: MANUAL,
      sectionKindDb: 'prose',
      clauseDocMatches: true,
      otherFailed: false,
    });

    const result = (await handler(input)) as Record<string, unknown>;

    // APR-1: review state cleared on reset
    const reset = mockExecute.mock.calls.find((c) =>
      (c[0] as string).includes("SET status = 'pending'"),
    )!;
    expect(reset[0]).toContain('reviewed_by = NULL');
    expect(reset[0]).toContain('reviewed_at = NULL');
    expect(reset[0]).toContain('error = NULL');

    // Compose invoked with the section identity
    expect(mockCompose).toHaveBeenCalledWith({
      runId: RUN,
      tenantId: T,
      sectionId: SECTION_ID,
      sectionKey: HKEY,
    });

    // Version INSERTs: manual v2 + clause v2 + master v2 (matrix unchanged — kind stable)
    const versionInserts = mockExecute.mock.calls.filter((c) =>
      (c[0] as string).includes('INSERT INTO m1.document_versions'),
    );
    const insertedDocs = versionInserts.map((c) => {
      const params = Object.fromEntries(
        (c[1] as Array<{ name: string; value: Record<string, unknown> }>).map((p) => [
          p.name,
          Object.values(p.value)[0],
        ]),
      );
      expect(c[0]).toContain(':versionNo::integer');
      expect(c[0]).toContain(':docId::uuid');
      expect(params.versionNo).toBe(2);
      expect(params.summary).toContain(HKEY);
      expect(params.author).toBe('reviewer-1');
      return params.docId;
    });
    expect(insertedDocs).toEqual([MANUAL, CLAUSE_DOC, MASTER]);

    // Manual v2 content assembled from ALL sections (both harmonization keys)
    const manualPut = mockS3Send.mock.calls.find(
      (c) =>
        c[0].constructor.name === 'PutObjectCommand' &&
        c[0].input.Key === `tenants/${T}/documents/${MANUAL}/v2.json`,
    )!;
    const manualBody = JSON.parse(manualPut[0].input.Body);
    expect(
      manualBody.sections.map((s: { harmonizationKey: string }) => s.harmonizationKey).sort(),
    ).toEqual([HKEY, 'leadership'].sort());

    // Master-list refresh: entries re-pointed at latest versions (Task-9 carry-forward closed)
    const masterPut = mockS3Send.mock.calls.find(
      (c) =>
        c[0].constructor.name === 'PutObjectCommand' &&
        c[0].input.Key === `tenants/${T}/documents/${MASTER}/v2.json`,
    )!;
    const masterBody = JSON.parse(masterPut[0].input.Body);
    const manualEntry = masterBody.entries.find(
      (e: { documentId: string }) => e.documentId === MANUAL,
    );
    expect(manualEntry.versionNo).toBe(2);
    expect(manualEntry.contentRef).toBe(`tenants/${T}/documents/${MANUAL}/v2.json`);

    // Run already complete + zero failed → no status UPDATE on generation_runs
    expect(
      mockExecute.mock.calls.some((c) => (c[0] as string).includes('UPDATE qms.generation_runs')),
    ).toBe(false);

    // Returned section is the GraphQL shape (kind reverse-enum-mapped)
    expect(result.kind).toBe('PROSE');
    expect(result.harmonizationKey).toBe(HKEY);

    // Audit registered detailType, published after commit
    expect(mockPublishAudit.mock.calls[0][0]).toMatchObject({
      detailType: 'Generation.SectionRegenerated',
    });
    expect(mockCommit.mock.invocationCallOrder.at(-1)!).toBeLessThan(
      mockPublishAudit.mock.invocationCallOrder[0],
    );
  });
});

describe('regenerateSection failure + repair semantics', () => {
  it('still-failed section ships NO clause-doc version; run flips complete → partial', async () => {
    mockCompose.mockResolvedValue({ sectionId: SECTION_ID, status: 'failed' });
    wire({
      runStatus: 'complete',
      manualDocId: MANUAL,
      sectionKindDb: 'failed',
      clauseDocMatches: true,
      otherFailed: false,
    });

    await handler(input);

    const versionInserts = mockExecute.mock.calls.filter((c) =>
      (c[0] as string).includes('INSERT INTO m1.document_versions'),
    );
    const docs = versionInserts.map(
      (c) =>
        (c[1] as Array<{ name: string; value: { stringValue?: string } }>).find(
          (p) => p.name === 'docId',
        )!.value.stringValue,
    );
    expect(docs).not.toContain(CLAUSE_DOC); // failed prose never ships
    expect(docs).toContain(MANUAL); // manual still versions (failed marker visible)
    // kind changed prose→failed → matrix new version
    expect(docs).toContain(MATRIX);

    const statusUpdate = mockExecute.mock.calls.find((c) =>
      (c[0] as string).includes('UPDATE qms.generation_runs'),
    )!;
    const params = Object.fromEntries(
      (statusUpdate[1] as Array<{ name: string; value: Record<string, unknown> }>).map((p) => [
        p.name,
        Object.values(p.value)[0],
      ]),
    );
    expect(params.status).toBe('partial');
  });

  it('previously-failed → prose CREATES the missing clause document and adds it to the master list', async () => {
    wire({
      runStatus: 'partial',
      manualDocId: MANUAL,
      sectionKindDb: 'prose',
      clauseDocMatches: false,
      otherFailed: false,
    });

    await handler(input);

    // New document inserted (no candidate matched the harmonization key)
    const docInsert = mockExecute.mock.calls.find((c) =>
      (c[0] as string).includes('INSERT INTO m1.documents'),
    )!;
    expect(docInsert[0]).toContain("'draft'");

    // Master list gains the created doc
    const masterPut = mockS3Send.mock.calls.find(
      (c) =>
        c[0].constructor.name === 'PutObjectCommand' &&
        c[0].input.Key === `tenants/${T}/documents/${MASTER}/v2.json`,
    )!;
    const masterBody = JSON.parse(masterPut[0].input.Body);
    expect(
      masterBody.entries.some((e: { documentId: string }) => e.documentId === 'doc-new-created'),
    ).toBe(true);

    // Zero failed sections now → run repaired to complete
    const statusUpdate = mockExecute.mock.calls.find((c) =>
      (c[0] as string).includes('UPDATE qms.generation_runs'),
    )!;
    const params = Object.fromEntries(
      (statusUpdate[1] as Array<{ name: string; value: Record<string, unknown> }>).map((p) => [
        p.name,
        Object.values(p.value)[0],
      ]),
    );
    expect(params.status).toBe('complete');
  });
});

describe('regenerateSection override (S3 Manual Studio — HITL-approved DocStudio draft)', () => {
  it('skips compose; approved sentences ship as prose in compose shape; step-3 derivations still run', async () => {
    wire({
      runStatus: 'complete',
      manualDocId: MANUAL,
      sectionKindDb: 'prose',
      clauseDocMatches: true,
      otherFailed: false,
    });

    await handler({
      tenantId: T,
      runId: RUN,
      harmonizationKey: HKEY,
      actor: 'agent:DocStudio+human:user-9',
      override: { sentences: [{ text: 'Approved section prose from the card.' }] },
    });

    // The one door to Bedrock is NEVER opened for an approved draft
    expect(mockCompose).not.toHaveBeenCalled();

    // Section content PUT: exact compose prose shape at the section key
    const puts = mockS3Send.mock.calls
      .map((c) => c[0] as { constructor: { name: string }; input: { Key: string; Body: string } })
      .filter((c) => c.constructor.name === 'PutObjectCommand');
    const sectionPut = puts.find(
      (p) => p.input.Key === `tenants/${T}/generation/${RUN}/sections/${HKEY}.json`,
    );
    expect(sectionPut).toBeDefined();
    const content = JSON.parse(sectionPut!.input.Body);
    expect(content.kind).toBe('prose');
    expect(content.sentences).toEqual([{ text: 'Approved section prose from the card.' }]);
    expect(content.clauseRefs).toEqual([{ standard: 'ISO9001', clauseNo: '4.1' }]);

    // Section row flipped to prose with content keys
    expect(
      mockExecute.mock.calls.some(
        (c) =>
          (c[0] as string).includes("SET status = 'prose'") &&
          (c[0] as string).includes('content_s3_key'),
      ),
    ).toBe(true);

    // Step-3 derivations still ran: manual + clause-doc + master-list versions
    const versionInserts = mockExecute.mock.calls.filter((c) =>
      (c[0] as string).includes('INSERT INTO m1.document_versions'),
    );
    expect(versionInserts.length).toBeGreaterThanOrEqual(3);

    // Audit marks the writeback source
    const auditPayload = mockPublishAudit.mock.calls[0][0].payload as Record<string, unknown>;
    expect(auditPayload.source).toBe('manual-section-draft');
  });
});
