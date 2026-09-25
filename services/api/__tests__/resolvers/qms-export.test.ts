/**
 * requestImsExport resolver hermetic tests (spec 40, Task 9 — STO-4).
 * QmsFn does the SQL and dispatches to ExportFn; the export set itself is
 * resolved by ExportFn from master-list content (tested in pdf-export).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExecute, mockCommit, mockRollback, mockLambdaSend } = vi.hoisted(() => {
  process.env.EXPORT_FN = 'test-export-fn';
  return {
    mockExecute: vi.fn(),
    mockCommit: vi.fn(),
    mockRollback: vi.fn(),
    mockLambdaSend: vi.fn(),
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
vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class {
    send = mockLambdaSend;
  },
  InvokeCommand: class {
    constructor(public input: unknown) {}
  },
}));

import { handler } from '../../src/resolvers/qms.js';

const T = 'tenant-test';

function makeEvent(documentId?: string) {
  return {
    info: { fieldName: 'requestImsExport' },
    arguments: documentId ? { documentId } : {},
    identity: { resolverContext: { tenantId: T, sub: 'user-1', role: 'quality-manager' } },
  };
}

const manualRow = {
  records: [
    [
      { stringValue: 'doc-manual' },
      { stringValue: 'IMS Manual' },
      { stringValue: 'manual' },
      { stringValue: 'IMS' },
      { stringValue: 'ver-manual' },
      { longValue: 1 },
      { stringValue: `tenants/${T}/documents/doc-manual/v1.json` },
    ],
  ],
  columnMetadata: [
    { name: 'document_id' },
    { name: 'title' },
    { name: 'doc_type' },
    { name: 'standard' },
    { name: 'version_id' },
    { name: 'version_no' },
    { name: 'content_ref' },
  ],
};
const candidateRows = {
  records: [
    [
      { stringValue: 'doc-ml' },
      { stringValue: 'Master List' },
      { stringValue: 'IMS' },
      { stringValue: 'ver-ml' },
      { longValue: 1 },
      { stringValue: `tenants/${T}/documents/doc-ml/v1.json` },
    ],
  ],
  columnMetadata: [
    { name: 'document_id' },
    { name: 'title' },
    { name: 'standard' },
    { name: 'version_id' },
    { name: 'version_no' },
    { name: 'content_ref' },
  ],
};
const emptyRes = { records: [], columnMetadata: [] };

beforeEach(() => {
  mockExecute.mockReset();
  mockCommit.mockReset();
  mockRollback.mockReset();
  mockLambdaSend.mockReset();
});

describe('requestImsExport', () => {
  it('invokes ExportFn with the manual (latest version) + master-list candidates; relays url/expiresAt', async () => {
    mockExecute.mockResolvedValueOnce(manualRow).mockResolvedValueOnce(candidateRows);
    mockLambdaSend.mockResolvedValue({
      Payload: new TextEncoder().encode(
        JSON.stringify({
          url: 'https://signed.example/ims.zip',
          expiresAt: '2026-07-16T00:15:00Z',
        }),
      ),
    });

    const res = (await handler(makeEvent('doc-manual'))) as { url: string; expiresAt: string };
    expect(res.url).toBe('https://signed.example/ims.zip');
    expect(res.expiresAt).toBe('2026-07-16T00:15:00Z');

    // manual SQL: latest version (ORDER BY version_no DESC LIMIT 1) with ::uuid cast
    const [manualSql] = mockExecute.mock.calls[0];
    expect(manualSql).toContain(':documentId::uuid');
    expect(manualSql).toContain('ORDER BY v.version_no DESC LIMIT 1');
    // candidates SQL: master_list latest versions
    const [candSql] = mockExecute.mock.calls[1];
    expect(candSql).toContain("doc_type = 'master_list'");
    expect(candSql).toContain('DISTINCT ON');

    const payload = JSON.parse(String(mockLambdaSend.mock.calls[0][0].input.Payload));
    expect(payload).toMatchObject({
      tenantId: T,
      manual: {
        documentId: 'doc-manual',
        versionId: 'ver-manual',
        contentKey: `tenants/${T}/documents/doc-manual/v1.json`,
        versionNo: 1,
      },
    });
    expect(payload.masterListCandidates).toHaveLength(1);
    expect(payload.masterListCandidates[0].contentKey).toBe(
      `tenants/${T}/documents/doc-ml/v1.json`,
    );
  });

  it('DOCUMENT_NOT_FOUND when the manual has no row (RLS: other-tenant ids look identical)', async () => {
    mockExecute.mockResolvedValueOnce(emptyRes).mockResolvedValueOnce(candidateRows);
    await expect(handler(makeEvent('doc-nope'))).rejects.toThrow('DOCUMENT_NOT_FOUND');
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  it('EXPORT_SET_NOT_FOUND when the tenant has no master list at all', async () => {
    mockExecute.mockResolvedValueOnce(manualRow).mockResolvedValueOnce(emptyRes);
    await expect(handler(makeEvent('doc-manual'))).rejects.toThrow('EXPORT_SET_NOT_FOUND');
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  it('relays ExportFn typed errors (EXPORT_SET_NOT_FOUND from content-side resolution)', async () => {
    mockExecute.mockResolvedValueOnce(manualRow).mockResolvedValueOnce(candidateRows);
    mockLambdaSend.mockResolvedValue({
      FunctionError: 'Unhandled',
      Payload: new TextEncoder().encode('{"errorMessage":"EXPORT_SET_NOT_FOUND"}'),
    });
    await expect(handler(makeEvent('doc-manual'))).rejects.toThrow('EXPORT_SET_NOT_FOUND');
  });

  it('BAD_REQUEST without documentId', async () => {
    await expect(handler(makeEvent())).rejects.toThrow('BAD_REQUEST');
  });
});
