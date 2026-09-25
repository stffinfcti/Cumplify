/**
 * publishControlledDocument sealing hermetic tests (spec 40, Task 9 — STO-5).
 * Pins: per-object ObjectLockRetainUntilDate from the TENANT retention policy
 * (BC-10: bucket default is safety-net only), default-policy seed, m4.records
 * pointer row in the SAME txn as the status flip, publish-after-commit,
 * rollback on seal failure, and the documented empty-content_ref exemption.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExecute, mockCommit, mockRollback, mockS3Send, mockLambdaSend, mockPublishAudit } =
  vi.hoisted(() => {
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
      mockPublishAudit: vi.fn().mockResolvedValue('evt-test'),
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

import { handler } from '../../src/resolvers/m1.js';

const T = 'tenant-test';
const VERSION_ID = 'ver-seal-1';

function makeEvent() {
  return {
    info: { fieldName: 'publishControlledDocument' },
    arguments: { versionId: VERSION_ID },
    identity: { resolverContext: { tenantId: T, sub: 'approver-1', role: 'QualityManager' } },
  };
}

const metaRow = {
  records: [
    [
      { stringValue: `tenants/${T}/documents/doc-1/v1.json` }, // content_ref
      { longValue: 1 }, // version_no
      { stringValue: 'doc-1' }, // document_id
      { stringValue: 'IMS Manual' }, // title
      { stringValue: 'manual' }, // doc_type
      { stringValue: 'IMS' }, // standard
    ],
  ],
  columnMetadata: [
    { name: 'content_ref' },
    { name: 'version_no' },
    { name: 'document_id' },
    { name: 'title' },
    { name: 'doc_type' },
    { name: 'standard' },
  ],
};
const docRow = {
  records: [[{ stringValue: 'doc-1' }, { stringValue: 'approved' }]],
  columnMetadata: [{ name: 'id' }, { name: 'status' }],
};
const policyRow = (years: number) => ({
  records: [[{ longValue: years }]],
  columnMetadata: [{ name: 'retention_years' }],
});
// 'approved' approval row for the version — publish seals to WORM, so the
// resolver requires this before flipping the document to 'approved'.
const approvalRow = {
  records: [[{ longValue: 1 }]],
  columnMetadata: [{ name: 'ok' }],
};
const emptyRes = { records: [], columnMetadata: [] };

function wireRenderOk() {
  mockLambdaSend.mockResolvedValue({
    Payload: new TextEncoder().encode(
      JSON.stringify({
        results: [
          {
            documentId: 'doc-1',
            versionId: VERSION_ID,
            pdfKey: `tenants/${T}/pdf/doc-1-abc.pdf`,
            sha256: 'abc',
            cached: false,
          },
        ],
      }),
    ),
  });
  mockS3Send.mockResolvedValue({});
}

beforeEach(() => {
  mockExecute.mockReset();
  mockCommit.mockReset();
  mockRollback.mockReset();
  mockS3Send.mockReset();
  mockLambdaSend.mockReset();
  mockPublishAudit.mockClear();
});

describe('publishControlledDocument sealing (STO-5)', () => {
  it('seals with per-object retention from the tenant policy (5y) — CopyObject + m4.records in same txn, publish after commit', async () => {
    mockExecute
      .mockResolvedValueOnce(metaRow) // meta SELECT
      .mockResolvedValueOnce(approvalRow) // approval gate SELECT
      .mockResolvedValueOnce(docRow) // UPDATE approve
      .mockResolvedValueOnce(policyRow(5)) // retention policy SELECT
      .mockResolvedValueOnce(emptyRes); // m4.records INSERT
    wireRenderOk();

    const before = Date.now();
    await handler(makeEvent());

    // CopyObject: evidence bucket, per-object GOVERNANCE lock ≈ now + 5y
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
    expect(copy.Key).toBe(`tenants/${T}/sealed/${VERSION_ID}.pdf`);
    expect(decodeURIComponent(copy.CopySource)).toBe(
      `test-general-bucket/tenants/${T}/pdf/doc-1-abc.pdf`,
    );
    expect(copy.ObjectLockMode).toBe('GOVERNANCE');
    const fiveYears = 5 * 365.25 * 24 * 3600 * 1000;
    expect(copy.ObjectLockRetainUntilDate.getTime() - before).toBeGreaterThan(fiveYears - 60_000);
    expect(copy.ObjectLockRetainUntilDate.getTime() - before).toBeLessThan(fiveYears + 60_000);

    // m4.records pointer row: retain_until == object_lock_until, s3://-ref, 5y class
    const insertCall = mockExecute.mock.calls[4];
    expect(insertCall[0]).toContain('INSERT INTO m4.records');
    const params = Object.fromEntries(
      insertCall[1].map((p: { name: string; value: Record<string, unknown> }) => [
        p.name,
        Object.values(p.value)[0],
      ]),
    );
    expect(params.standard).toBe('IMS');
    expect(params.retClass).toBe('5y');
    expect(params.objectRef).toBe(`s3://test-evidence-vault/tenants/${T}/sealed/${VERSION_ID}.pdf`);
    expect(insertCall[0]).toContain(
      ':retainUntil::timestamptz, :objectRef, :retainUntil::timestamptz',
    );

    // ordering: commit BEFORE audit publish (rollback-before-publish lesson)
    expect(mockCommit).toHaveBeenCalledTimes(1);
    expect(mockCommit.mock.invocationCallOrder[0]).toBeLessThan(
      mockPublishAudit.mock.invocationCallOrder[0],
    );
    expect(mockPublishAudit.mock.calls[0][0].payload).toMatchObject({
      versionId: VERSION_ID,
      sealed: true,
      retentionYears: 5,
      lockMode: 'GOVERNANCE',
    });
  });

  it('seeds the default 7y policy row when the tenant has none, then seals at 7y', async () => {
    mockExecute
      .mockResolvedValueOnce(metaRow)
      .mockResolvedValueOnce(approvalRow) // approval gate SELECT
      .mockResolvedValueOnce(docRow)
      .mockResolvedValueOnce(emptyRes) // no policy row
      .mockResolvedValueOnce(emptyRes) // policy INSERT (seed)
      .mockResolvedValueOnce(emptyRes); // m4.records INSERT
    wireRenderOk();

    await handler(makeEvent());

    const seed = mockExecute.mock.calls[4];
    expect(seed[0]).toContain('INSERT INTO m4.retention_policies');
    expect(seed[0]).toContain("'controlled_document'");
    const seedParams = Object.fromEntries(
      seed[1].map((p: { name: string; value: Record<string, unknown> }) => [
        p.name,
        Object.values(p.value)[0],
      ]),
    );
    expect(seedParams.years).toBe(7);
    expect(mockPublishAudit.mock.calls[0][0].payload.retentionYears).toBe(7);
  });

  it('empty content_ref (agent-writeback exemption): publishes WITHOUT sealing, audit carries sealed:false', async () => {
    const noContentMeta = JSON.parse(JSON.stringify(metaRow));
    noContentMeta.records[0][0] = { isNull: true };
    mockExecute
      .mockResolvedValueOnce(noContentMeta)
      .mockResolvedValueOnce(approvalRow) // approval gate SELECT
      .mockResolvedValueOnce(docRow);
    mockLambdaSend.mockRejectedValue(new Error('must not be called'));

    await handler(makeEvent());

    expect(mockLambdaSend).not.toHaveBeenCalled();
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockCommit).toHaveBeenCalledTimes(1);
    expect(mockPublishAudit.mock.calls[0][0].payload).toMatchObject({
      sealed: false,
      reason: 'CONTENT_UNAVAILABLE',
    });
  });

  it('render failure → rollback, SEAL_FAILED, publish is BLOCKED and no audit event fires', async () => {
    mockExecute
      .mockResolvedValueOnce(metaRow)
      .mockResolvedValueOnce(approvalRow) // approval gate SELECT
      .mockResolvedValueOnce(docRow)
      .mockResolvedValueOnce(policyRow(5));
    mockLambdaSend.mockResolvedValue({
      FunctionError: 'Unhandled',
      Payload: new TextEncoder().encode('{"errorMessage":"chromium died"}'),
    });

    await expect(handler(makeEvent())).rejects.toThrow('SEAL_FAILED');
    expect(mockCommit).not.toHaveBeenCalled();
    expect(mockRollback).toHaveBeenCalled();
    expect(mockPublishAudit).not.toHaveBeenCalled();
  });

  it('CopyObject failure → rollback, error propagates, no records row committed', async () => {
    mockExecute
      .mockResolvedValueOnce(metaRow)
      .mockResolvedValueOnce(approvalRow) // approval gate SELECT
      .mockResolvedValueOnce(docRow)
      .mockResolvedValueOnce(policyRow(5));
    mockLambdaSend.mockResolvedValue({
      Payload: new TextEncoder().encode(
        JSON.stringify({
          results: [{ pdfKey: `tenants/${T}/pdf/doc-1-abc.pdf` }],
        }),
      ),
    });
    mockS3Send.mockRejectedValue(new Error('AccessDenied'));

    await expect(handler(makeEvent())).rejects.toThrow('AccessDenied');
    expect(mockCommit).not.toHaveBeenCalled();
    expect(mockRollback).toHaveBeenCalled();
    expect(mockPublishAudit).not.toHaveBeenCalled();
  });

  it('unknown version → VERSION_NOT_FOUND', async () => {
    mockExecute.mockResolvedValueOnce(emptyRes);
    await expect(handler(makeEvent())).rejects.toThrow('VERSION_NOT_FOUND');
    expect(mockCommit).not.toHaveBeenCalled();
  });
});
