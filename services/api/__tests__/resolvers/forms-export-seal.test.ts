/**
 * exportFormRecordPdf + approved-record sealing hermetic tests
 * (spec 41, Task 8 — REC-7/ACC-7).
 *
 * Pins: content JSON built with catalog-RESOLVED labels (BC-7 single source —
 * asserted against the real frontend/messages catalogs, not string literals),
 * ::uuid casts on every record-plane SELECT (M3 Data-API lesson), per-object
 * ObjectLockRetainUntilDate from the TENANT retention policy (BC-10),
 * m4.records pointer + forms.records.m4_record_id in the SAME txn as the
 * approval flip (ACC-7), BC-6 IMS standard derivation, rollback on seal
 * failure, SoD path never touches S3, and the honest SEAL_NOT_CONFIGURED skip.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { marshall } from '@aws-sdk/util-dynamodb';
import enMessages from '../../../../frontend/messages/en.json';
import esMessages from '../../../../frontend/messages/es.json';

const {
  mockExecute,
  mockCommit,
  mockRollback,
  mockS3Send,
  mockLambdaSend,
  mockDdbSend,
  mockPublishAudit,
  mockGetSignedUrl,
} = vi.hoisted(() => {
  process.env.CONTENT_BUCKET = 'test-general-bucket';
  process.env.EVIDENCE_BUCKET = 'test-evidence-vault';
  process.env.EVIDENCE_LOCK_MODE = 'GOVERNANCE';
  process.env.PDF_RENDER_FN = 'test-pdf-render-fn';
  return {
    mockExecute: vi.fn(),
    mockCommit: vi.fn(),
    mockRollback: vi.fn(),
    mockS3Send: vi.fn(),
    mockLambdaSend: vi.fn(),
    mockDdbSend: vi.fn(),
    mockPublishAudit: vi.fn().mockResolvedValue('evt-test'),
    mockGetSignedUrl: vi.fn().mockResolvedValue('https://signed.test/record.pdf'),
  };
});

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
    publishAuditEvent: mockPublishAudit,
    getTenantDdbClient: vi.fn().mockResolvedValue({ send: mockDdbSend }),
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
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = mockS3Send;
  },
  GetObjectCommand: class {
    constructor(public input: unknown) {}
  },
  PutObjectCommand: class {
    constructor(public input: unknown) {}
  },
  CopyObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));
vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class {
    send = mockLambdaSend;
  },
  InvokeCommand: class {
    constructor(public input: unknown) {}
  },
}));
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: mockGetSignedUrl,
}));

import { handler } from '../../src/resolvers/forms.js';

const T = 'tenant-test';
const RECORD_ID = 'rec-0000-1111';
const TEMPLATE_ID = 'tpl-ncr-1';
const CLAUSE_UUID = 'd0000001-0001-4000-8000-000000000022';

function event(fieldName: string, args: Record<string, unknown>, sub = 'approver-1') {
  return {
    info: { fieldName },
    arguments: args,
    identity: { resolverContext: { tenantId: T, sub, role: 'QualityManager' } },
  };
}

// ─── Row fixtures (DB casing: lowercase status, snake_case columns) ──────────

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

interface FixtureState {
  status: string;
  standards: string[];
  policyYears: number | null; // null = no tenant policy row
}

/**
 * SQL-dispatch mock: durable against call-order changes, discriminates the
 * queries by their distinctive fragments (the same strings the resolver owns).
 */
function wireSql(fx: FixtureState) {
  mockExecute.mockImplementation(async (sql: string) => {
    // buildRecordContent record SELECT (only one selecting approved_by)
    if (sql.includes('r.approved_by')) {
      return rows(
        [
          'id',
          'template_id',
          'status',
          'opened_by',
          'completed_by',
          'completed_at',
          'approved_by',
          'approved_at',
          'm2_nc_id',
          'version',
          'created_at',
          'updated_at',
        ],
        [
          [
            RECORD_ID,
            TEMPLATE_ID,
            fx.status,
            'user-a',
            'user-b',
            '2026-07-16T10:00:00Z',
            fx.status === 'approved' ? 'approver-1' : null,
            fx.status === 'approved' ? '2026-07-16T11:00:00Z' : null,
            null,
            1,
            '2026-07-15T09:00:00Z',
            '2026-07-16T11:00:00Z',
          ],
        ],
      );
    }
    // getFormRecordById (post-mutation return read)
    if (sql.includes('r.m2_nc_id, r.created_at')) {
      return rows(
        [
          'id',
          'template_id',
          'status',
          'opened_by',
          'completed_by',
          'm2_nc_id',
          'created_at',
          'updated_at',
        ],
        [
          [
            RECORD_ID,
            TEMPLATE_ID,
            fx.status,
            'user-a',
            'user-b',
            null,
            '2026-07-15T09:00:00Z',
            '2026-07-16T11:00:00Z',
          ],
        ],
      );
    }
    // approveFormRecord initial record SELECT
    if (sql.includes('r.opened_by, r.completed_by') && sql.includes('FROM forms.records')) {
      return rows(
        ['id', 'template_id', 'status', 'opened_by', 'completed_by'],
        [[RECORD_ID, TEMPLATE_ID, fx.status, 'user-a', 'user-b']],
      );
    }
    if (sql.includes('FROM forms.templates')) {
      return rows(
        ['key', 'title_key', 'category', 'clause_refs', 'standards', 'requires_approval'],
        [['ncr', 'forms.tpl.ncr.title', 'corrective', ['8.7', '10.2'], fx.standards, true]],
      );
    }
    if (sql.includes('s.section_key, s.title_key')) {
      return rows(['id', 'section_key', 'title_key'], [['sec-1', 'info', 'forms.ncr.sec.info']]);
    }
    if (sql.includes('f.label_key')) {
      return rows(
        ['id', 'section_id', 'field_key', 'label_key', 'field_type', 'required', 'relation_target'],
        [
          ['f-1', 'sec-1', 'ncr_number', 'forms.ncr.field.ncrNumber', 'text', true, null],
          ['f-2', 'sec-1', 'clause_ref', 'forms.ncr.field.clauseRef', 'relation', true, 'clause'],
          [
            'f-3',
            'sec-1',
            'containment_flag',
            'forms.ncr.field.containmentFlag',
            'checkbox',
            false,
            null,
          ],
          ['f-4', 'sec-1', 'severity', 'forms.ncr.field.severity', 'select', true, null],
        ],
      );
    }
    if (sql.includes('rv.value_text')) {
      return rows(
        [
          'field_key',
          'value_text',
          'value_number',
          'value_date',
          'value_bool',
          'value_uuid',
          'value_json',
        ],
        [
          ['ncr_number', 'NCR-001', null, null, null, null, null],
          ['clause_ref', null, null, null, null, CLAUSE_UUID, null],
          ['containment_flag', null, null, null, true, null, null],
          // severity deliberately UNFILLED → renders '—' in the PDF
        ],
      );
    }
    if (sql.includes('FROM qms.clause_registry')) {
      return rows(
        ['standard', 'clause_no', 'clause_title'],
        [['ISO9001', '8.7', 'Nonconforming outputs']],
      );
    }
    if (sql.includes('FROM m4.retention_policies')) {
      return fx.policyYears === null ? emptyRes : rows(['retention_years'], [[fx.policyYears]]);
    }
    if (sql.includes('INSERT INTO m4.records')) {
      return rows(['id'], [['m4-rec-77']]);
    }
    // computeCompletion totals / filled
    if (sql.includes('f.field_key, f.required')) {
      return rows(
        ['field_key', 'required'],
        [
          ['ncr_number', true],
          ['clause_ref', true],
          ['containment_flag', false],
          ['severity', true],
        ],
      );
    }
    if (sql.includes('SELECT f.field_key') && sql.includes('record_values')) {
      return rows(['field_key'], [['ncr_number'], ['clause_ref'], ['containment_flag']]);
    }
    // Stateful: after the approval UPDATE, in-txn re-reads see 'approved'
    if (sql.includes("SET status = 'approved'")) {
      fx.status = 'approved';
      return emptyRes;
    }
    // Other UPDATEs, policy seed INSERT, m4_record_id stamp
    return emptyRes;
  });
}

function wireRenderOk() {
  mockLambdaSend.mockResolvedValue({
    Payload: new TextEncoder().encode(
      JSON.stringify({
        results: [
          {
            documentId: RECORD_ID,
            versionId: `${RECORD_ID}-v1`,
            pdfKey: `tenants/${T}/pdf/${RECORD_ID}-abcdef123456.pdf`,
            sha256: 'abcdef1234567890',
            cached: false,
          },
        ],
      }),
    ),
  });
  mockS3Send.mockResolvedValue({});
}

const label = (cat: Record<string, unknown>, key: string): string =>
  key.split('.').reduce<unknown>((o, p) => (o as Record<string, unknown>)[p], cat) as string;

beforeEach(() => {
  mockExecute.mockReset();
  mockCommit.mockReset();
  mockRollback.mockReset();
  mockS3Send.mockReset();
  mockLambdaSend.mockReset();
  mockDdbSend.mockReset().mockResolvedValue({});
  mockPublishAudit.mockClear();
  mockGetSignedUrl.mockClear();
});

describe('exportFormRecordPdf (REC-7)', () => {
  it('builds the content JSON with catalog-resolved labels, renders via PdfRenderFn, presigns 15 min', async () => {
    wireSql({
      status: 'in_progress',
      standards: ['ISO9001', 'ISO14001', 'ISO45001', 'IMS'],
      policyYears: 7,
    });
    wireRenderOk();

    const before = Date.now();
    const result = (await handler(event('exportFormRecordPdf', { recordId: RECORD_ID }))) as {
      url: string;
      expiresAt: string;
    };

    expect(result.url).toBe('https://signed.test/record.pdf');
    const ttlMs = new Date(result.expiresAt).getTime() - before;
    expect(ttlMs).toBeGreaterThan(14 * 60 * 1000);
    expect(ttlMs).toBeLessThan(16 * 60 * 1000);
    expect(mockGetSignedUrl.mock.calls[0][2]).toEqual({ expiresIn: 15 * 60 });

    // Content JSON: uploaded to the tenant record content plane
    const put = mockS3Send.mock.calls.find((c) => c[0].constructor.name === 'PutObjectCommand')![0]
      .input as {
      Bucket: string;
      Key: string;
      Body: string;
      ContentType: string;
    };
    expect(put.Bucket).toBe('test-general-bucket');
    expect(put.Key).toBe(`tenants/${T}/records/${RECORD_ID}.json`);
    expect(put.ContentType).toBe('application/json');

    const content = JSON.parse(put.Body);
    expect(content.kind).toBe('form_record');
    expect(content.locale).toBe('en');
    // Labels resolved against the REAL en catalog — never raw keys
    expect(content.template.title).toBe(label(enMessages, 'forms.tpl.ncr.title'));
    expect(content.recordSections[0].title).toBe(label(enMessages, 'forms.ncr.sec.info'));
    const fields = content.recordSections[0].fields as Array<Record<string, unknown>>;
    expect(fields.map((f) => f.label)).toEqual([
      label(enMessages, 'forms.ncr.field.ncrNumber'),
      label(enMessages, 'forms.ncr.field.clauseRef'),
      label(enMessages, 'forms.ncr.field.containmentFlag'),
      label(enMessages, 'forms.ncr.field.severity'),
    ]);
    // Typed display values: clause relation dereferenced, checkbox localized, unfilled honest
    expect(fields[1]).toMatchObject({
      filled: true,
      display: 'ISO9001 8.7 — Nonconforming outputs',
    });
    expect(fields[2]).toMatchObject({ filled: true, display: label(enMessages, 'forms.pdf.yes') });
    expect(fields[3]).toMatchObject({ filled: false, display: '' });

    // Render invoke: form_record docType, IMS standard (multi-standard template)
    // (InvokeCommand Payload is the JSON string the resolver passes)
    const invokePayload = JSON.parse(
      (mockLambdaSend.mock.calls[0][0] as { input: { Payload: string } }).input.Payload,
    );
    expect(mockLambdaSend.mock.calls[0][0].input.FunctionName).toBe('test-pdf-render-fn');
    expect(invokePayload.documents[0]).toMatchObject({
      documentId: RECORD_ID,
      docType: 'form_record',
      standard: 'IMS',
      versionNo: 1,
      contentKey: `tenants/${T}/records/${RECORD_ID}.json`,
    });

    // M3 Data-API lesson: every record-plane SELECT carries ::uuid casts
    const selects = mockExecute.mock.calls.filter(
      (c) =>
        (c[0] as string).trimStart().startsWith('\n    SELECT') ||
        (c[0] as string).trimStart().startsWith('SELECT'),
    );
    for (const s of selects) expect(s[0]).toContain('::uuid');
  });

  it('resolves labels in the tenant documentLocale (es)', async () => {
    mockDdbSend.mockResolvedValue({ Item: marshall({ documentLocale: 'es' }) });
    wireSql({ status: 'complete', standards: ['ISO9001', 'IMS'], policyYears: 7 });
    wireRenderOk();

    await handler(event('exportFormRecordPdf', { recordId: RECORD_ID }));

    const put = mockS3Send.mock.calls.find((c) => c[0].constructor.name === 'PutObjectCommand')![0]
      .input as { Body: string };
    const content = JSON.parse(put.Body);
    expect(content.locale).toBe('es');
    expect(content.template.title).toBe(label(esMessages, 'forms.tpl.ncr.title'));
  });

  it('RECORD_NOT_FOUND rolls back and never touches S3', async () => {
    mockExecute.mockResolvedValue(emptyRes);

    await expect(handler(event('exportFormRecordPdf', { recordId: RECORD_ID }))).rejects.toThrow(
      'RECORD_NOT_FOUND',
    );
    expect(mockRollback).toHaveBeenCalled();
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  it('render failure → RENDER_FAILED, no presigned URL', async () => {
    wireSql({ status: 'complete', standards: ['ISO9001', 'IMS'], policyYears: 7 });
    mockS3Send.mockResolvedValue({});
    mockLambdaSend.mockResolvedValue({
      FunctionError: 'Unhandled',
      Payload: new TextEncoder().encode('{"errorMessage":"chromium died"}'),
    });

    await expect(handler(event('exportFormRecordPdf', { recordId: RECORD_ID }))).rejects.toThrow(
      'RENDER_FAILED',
    );
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });
});

describe('approveFormRecord sealing (REC-7/ACC-7)', () => {
  it('seals with per-object retention from the tenant policy (3y): CopyObject lock + m4 pointer + m4_record_id in SAME txn, audit after commit', async () => {
    wireSql({
      status: 'complete',
      standards: ['ISO9001', 'ISO14001', 'ISO45001', 'IMS'],
      policyYears: 3,
    });
    wireRenderOk();

    const before = Date.now();
    await handler(event('approveFormRecord', { input: { recordId: RECORD_ID } }));

    // CopyObject: evidence vault, GOVERNANCE, retain ≈ now + 3y (policy-driven, BC-10)
    const copy = mockS3Send.mock.calls.find(
      (c) => c[0].constructor.name === 'CopyObjectCommand',
    )![0].input as {
      Bucket: string;
      Key: string;
      CopySource: string;
      ObjectLockMode: string;
      ObjectLockRetainUntilDate: Date;
    };
    expect(copy.Bucket).toBe('test-evidence-vault');
    expect(copy.Key).toBe(`tenants/${T}/sealed/records/${RECORD_ID}-abcdef123456.pdf`);
    expect(decodeURIComponent(copy.CopySource)).toBe(
      `test-general-bucket/tenants/${T}/pdf/${RECORD_ID}-abcdef123456.pdf`,
    );
    expect(copy.ObjectLockMode).toBe('GOVERNANCE');
    const threeYears = 3 * 365.25 * 24 * 3600 * 1000;
    expect(copy.ObjectLockRetainUntilDate.getTime() - before).toBeGreaterThan(threeYears - 60_000);
    expect(copy.ObjectLockRetainUntilDate.getTime() - before).toBeLessThan(threeYears + 60_000);

    // m4.records pointer: retain_until == object_lock_until (single param bound twice),
    // IMS standard (BC-6), form_record type, 3y class
    const insertIdx = mockExecute.mock.calls.findIndex((c) =>
      (c[0] as string).includes('INSERT INTO m4.records'),
    );
    const insert = mockExecute.mock.calls[insertIdx];
    expect(insert[0]).toContain(':retainUntil::timestamptz, :objectRef, :retainUntil::timestamptz');
    expect(insert[0]).toContain("'form_record'");
    const params = Object.fromEntries(
      (insert[1] as Array<{ name: string; value: Record<string, unknown> }>).map((p) => [
        p.name,
        Object.values(p.value)[0],
      ]),
    );
    expect(params.standard).toBe('IMS');
    expect(params.retClass).toBe('3y');
    expect(params.objectRef).toBe(`s3://test-evidence-vault/${copy.Key}`);

    // forms.records.m4_record_id stamped in the SAME txn (before the commit)
    const stampIdx = mockExecute.mock.calls.findIndex((c) =>
      (c[0] as string).includes('SET m4_record_id'),
    );
    expect(stampIdx).toBeGreaterThan(insertIdx);
    const stampParams = Object.fromEntries(
      (
        mockExecute.mock.calls[stampIdx][1] as Array<{
          name: string;
          value: Record<string, unknown>;
        }>
      ).map((p) => [p.name, Object.values(p.value)[0]]),
    );
    expect(stampParams.m4Id).toBe('m4-rec-77');
    expect(mockExecute.mock.calls[stampIdx][0]).toContain(':m4Id::uuid');
    expect(mockExecute.mock.invocationCallOrder[stampIdx]).toBeLessThan(
      mockCommit.mock.invocationCallOrder[0],
    );

    // Sealed content reflects the APPROVED row (post-flip re-read)
    const put = mockS3Send.mock.calls.find((c) => c[0].constructor.name === 'PutObjectCommand')![0]
      .input as { Body: string };
    expect(JSON.parse(put.Body).record.status).toBe('APPROVED');

    // Audit: after commit, carries the seal
    expect(mockCommit.mock.invocationCallOrder[0]).toBeLessThan(
      mockPublishAudit.mock.invocationCallOrder[0],
    );
    expect(mockPublishAudit.mock.calls[0][0]).toMatchObject({ detailType: 'FormRecord.Approved' });
    expect(mockPublishAudit.mock.calls[0][0].payload).toMatchObject({
      sealed: true,
      m4RecordId: 'm4-rec-77',
      retentionYears: 3,
      lockMode: 'GOVERNANCE',
      sealedKey: copy.Key,
    });
  });

  it('seeds the default 7y form_record policy when the tenant has none', async () => {
    wireSql({
      status: 'complete',
      standards: ['ISO9001', 'ISO14001', 'ISO45001', 'IMS'],
      policyYears: null,
    });
    wireRenderOk();

    await handler(event('approveFormRecord', { input: { recordId: RECORD_ID } }));

    const seed = mockExecute.mock.calls.find((c) =>
      (c[0] as string).includes('INSERT INTO m4.retention_policies'),
    )!;
    expect(seed[0]).toContain("'form_record'");
    expect(seed[0]).toContain("'review_before_disposal'");
    const seedParams = Object.fromEntries(
      (seed[1] as Array<{ name: string; value: Record<string, unknown> }>).map((p) => [
        p.name,
        Object.values(p.value)[0],
      ]),
    );
    expect(seedParams.years).toBe(7);
    expect(mockPublishAudit.mock.calls[0][0].payload.retentionYears).toBe(7);
  });

  it('single-concrete-standard template seals with that standard, not IMS (BC-6 derivation)', async () => {
    wireSql({ status: 'complete', standards: ['ISO14001', 'IMS'], policyYears: 7 });
    wireRenderOk();

    await handler(event('approveFormRecord', { input: { recordId: RECORD_ID } }));

    const insert = mockExecute.mock.calls.find((c) =>
      (c[0] as string).includes('INSERT INTO m4.records'),
    )!;
    const params = Object.fromEntries(
      (insert[1] as Array<{ name: string; value: Record<string, unknown> }>).map((p) => [
        p.name,
        Object.values(p.value)[0],
      ]),
    );
    expect(params.standard).toBe('ISO14001');
  });

  it('render failure during seal → rollback, SEAL_FAILED, approval blocked, no audit event', async () => {
    wireSql({ status: 'complete', standards: ['ISO9001', 'IMS'], policyYears: 5 });
    mockS3Send.mockResolvedValue({});
    mockLambdaSend.mockResolvedValue({
      FunctionError: 'Unhandled',
      Payload: new TextEncoder().encode('{"errorMessage":"chromium died"}'),
    });

    await expect(
      handler(event('approveFormRecord', { input: { recordId: RECORD_ID } })),
    ).rejects.toThrow('RENDER_FAILED');
    expect(mockCommit).not.toHaveBeenCalled();
    expect(mockRollback).toHaveBeenCalled();
    expect(mockPublishAudit).not.toHaveBeenCalled();
    // No sealed copy, no pointer row
    expect(mockS3Send.mock.calls.some((c) => c[0].constructor.name === 'CopyObjectCommand')).toBe(
      false,
    );
    expect(
      mockExecute.mock.calls.some((c) => (c[0] as string).includes('INSERT INTO m4.records')),
    ).toBe(false);
  });

  it('SoD violation (approver == opened_by) with seal env SET: writes nothing, never touches S3', async () => {
    wireSql({ status: 'complete', standards: ['ISO9001', 'IMS'], policyYears: 7 });
    wireRenderOk();

    await expect(
      handler(event('approveFormRecord', { input: { recordId: RECORD_ID } }, 'user-a')),
    ).rejects.toThrow('SOD_VIOLATION');
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockLambdaSend).not.toHaveBeenCalled();
    expect(mockCommit).not.toHaveBeenCalled();
    expect(mockPublishAudit.mock.calls[0][0]).toMatchObject({
      detailType: 'Security.SodViolationBlocked',
    });
  });

  it('unconfigured seal env (hermetic lane): approval commits, audit carries sealed:false + SEAL_NOT_CONFIGURED', async () => {
    // The env consts are module-level in shared.ts — process.env toggling
    // can't reach them, so stub the named exports for this re-import.
    vi.resetModules();
    vi.doMock('../../src/resolvers/shared.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../src/resolvers/shared.js')>();
      return {
        ...actual,
        CONTENT_BUCKET: '',
        EVIDENCE_BUCKET: '',
        PDF_RENDER_FN: '',
        beginTenantTransaction: vi.fn().mockResolvedValue({
          transactionId: 'txn-test',
          execute: mockExecute,
          commit: mockCommit,
          rollback: mockRollback,
        }),
        publishAuditEvent: mockPublishAudit,
      };
    });
    try {
      const mod = await import('../../src/resolvers/forms.js');
      wireSql({ status: 'complete', standards: ['ISO9001', 'IMS'], policyYears: 7 });

      await mod.handler(event('approveFormRecord', { input: { recordId: RECORD_ID } }));

      expect(mockS3Send).not.toHaveBeenCalled();
      expect(mockLambdaSend).not.toHaveBeenCalled();
      expect(mockCommit).toHaveBeenCalled();
      expect(mockPublishAudit.mock.calls[0][0].payload).toMatchObject({
        sealed: false,
        reason: 'SEAL_NOT_CONFIGURED',
      });
    } finally {
      vi.doUnmock('../../src/resolvers/shared.js');
      vi.resetModules();
    }
  });
});
