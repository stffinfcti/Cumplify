/**
 * Unit tests for saveDocumentSectionEdit (read-surface-completion RS-9,
 * Collaboration Law persistence). Pins: NEW version always written (never
 * mutates the current row), sealed/obsolete document rejection (7.5.2
 * versioning law), trackedChanges attribution payload round-trips verbatim
 * through the S3 content JSON, document status reset to DRAFT (APR-1: review
 * state not inheritable), Document.SectionEdited audit event.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExecute, mockCommit, mockRollback, mockS3Send, mockPublishAudit } = vi.hoisted(() => {
  process.env.CONTENT_BUCKET = 'test-general-bucket';
  return {
    mockExecute: vi.fn(),
    mockCommit: vi.fn(),
    mockRollback: vi.fn(),
    mockS3Send: vi.fn(),
    mockPublishAudit: vi.fn().mockResolvedValue('evt-test'),
  };
});

vi.mock('../../src/resolvers/shared.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/resolvers/shared.js')>();
  return {
    ...actual,
    beginTenantTransaction: vi.fn().mockResolvedValue({
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
  PutObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class {
    send = vi.fn();
  },
  InvokeCommand: class {
    constructor(public input: unknown) {}
  },
}));

import { handler } from '../../src/resolvers/m1.js';

function makeEvent(fieldName: string, args: Record<string, unknown> = {}) {
  return {
    info: { fieldName },
    arguments: args,
    identity: { resolverContext: { tenantId: 'tenant-test', sub: 'user-9', role: 'IMSLead' } },
  };
}

const ORIGINAL_CONTENT = {
  sections: [
    { harmonizationKey: '4.1', kind: 'prose', sentences: [{ text: 'Original.' }] },
    { harmonizationKey: '4.2', kind: 'gap', gap: 'no source' },
  ],
};

function s3GetBody(json: unknown) {
  return { Body: { transformToString: async () => JSON.stringify(json) } };
}

const TRACKED_CHANGES = [
  {
    id: 'change-1',
    actor: { type: 'user', id: 'user-9', name: 'Q. Manager' },
    type: 'replace',
    content: 'Edited content.',
    timestamp: '2026-07-22T00:00:00Z',
    status: 'pending',
  },
];

beforeEach(() => {
  mockExecute.mockReset();
  mockCommit.mockReset();
  mockRollback.mockReset();
  mockS3Send.mockReset();
  mockPublishAudit.mockReset().mockResolvedValue('evt-test');
});

describe('saveDocumentSectionEdit — happy path', () => {
  it('writes a NEW version with the edited section + trackedChanges, resets document to DRAFT', async () => {
    mockExecute
      .mockResolvedValueOnce({
        records: [[{ stringValue: 'doc-1' }, { stringValue: 'DRAFT' }, { stringValue: 'v1-key' }]],
        columnMetadata: [{ name: 'document_id' }, { name: 'status' }, { name: 'content_ref' }],
      })
      .mockResolvedValueOnce({
        records: [[{ stringValue: 'draft' }]],
        columnMetadata: [{ name: 'status' }],
      }) // FOR UPDATE document lock — returns the live status
      .mockResolvedValueOnce({
        records: [[{ longValue: 2 }]],
        columnMetadata: [{ name: 'next' }],
      })
      .mockResolvedValueOnce({
        records: [
          [
            { stringValue: 'ver-2' },
            { stringValue: 'doc-1' },
            { longValue: 2 },
            { stringValue: 'tenants/tenant-test/documents/doc-1/v2.json' },
            { stringValue: 'Section edit: 4.1' },
            { stringValue: 'user-9' },
            { stringValue: '2026-07-22T00:00:00Z' },
          ],
        ],
        columnMetadata: [
          { name: 'id' },
          { name: 'document_id' },
          { name: 'version_no' },
          { name: 'content_ref' },
          { name: 'change_summary' },
          { name: 'author_id' },
          { name: 'created_at' },
        ],
      })
      .mockResolvedValueOnce({ records: undefined, columnMetadata: undefined }); // status -> draft update

    mockS3Send.mockResolvedValueOnce(s3GetBody(ORIGINAL_CONTENT)); // GetObjectCommand
    mockS3Send.mockResolvedValueOnce({}); // PutObjectCommand

    const result = await handler(
      makeEvent('saveDocumentSectionEdit', {
        input: {
          versionId: 'v1',
          harmonizationKey: '4.1',
          body: 'Edited content.',
          trackedChanges: JSON.stringify(TRACKED_CHANGES),
        },
      }),
    );

    expect((result as { id: string }).id).toBe('ver-2');
    expect((result as { versionNo: number }).versionNo).toBe(2);

    // The new version-write INSERT (4th execute call: meta, lock, next, insert)
    // must carry a NEW, incremented version_no and a new S3 key — never the
    // same content_ref.
    const [insertSql, insertParams] = mockExecute.mock.calls[3];
    expect(insertSql).toContain('INSERT INTO m1.document_versions');
    expect(insertParams).toContainEqual({ name: 'versionNo', value: { longValue: 2 } });
    expect(insertParams).toContainEqual({
      name: 'contentRef',
      value: { stringValue: 'tenants/tenant-test/documents/doc-1/v2.json' },
    });

    // The PutObjectCommand body carries the edited section verbatim,
    // including the full trackedChanges attribution payload.
    const putCall = mockS3Send.mock.calls[1][0] as { input: { Body: string; Key: string } };
    const written = JSON.parse(putCall.input.Body);
    expect(written.sections[0].humanEditedBody).toBe('Edited content.');
    expect(written.sections[0].trackedChanges).toEqual(TRACKED_CHANGES); // round-trip
    expect(written.sections[1]).toEqual(ORIGINAL_CONTENT.sections[1]); // untouched section preserved
    expect(putCall.input.Key).toBe('tenants/tenant-test/documents/doc-1/v2.json');

    // Document reset to DRAFT (5th execute call)
    const [statusSql] = mockExecute.mock.calls[4];
    expect(statusSql).toContain("SET status = 'draft'");

    // Two commits: phase-1 meta txn + phase-3 write txn.
    expect(mockCommit).toHaveBeenCalledTimes(2);
    expect(mockPublishAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        detailType: 'Document.SectionEdited',
        payload: expect.objectContaining({ harmonizationKey: '4.1', changeCount: 1 }),
      }),
    );
  });

  it('accepts the LIVE wire shape: trackedChanges arrives as a parsed ARRAY, not a string (found live 2026-07-22)', async () => {
    // AppSync delivers AWSJSON arguments to direct Lambda resolvers already
    // parsed — same wire-shape class as saveOrgProfile's "[object Object]".
    mockExecute
      .mockResolvedValueOnce({
        records: [[{ stringValue: 'doc-1' }, { stringValue: 'DRAFT' }, { stringValue: 'v1-key' }]],
        columnMetadata: [{ name: 'document_id' }, { name: 'status' }, { name: 'content_ref' }],
      })
      .mockResolvedValueOnce({
        records: [[{ stringValue: 'draft' }]],
        columnMetadata: [{ name: 'status' }],
      }) // FOR UPDATE document lock — returns the live status
      .mockResolvedValueOnce({
        records: [[{ longValue: 2 }]],
        columnMetadata: [{ name: 'next' }],
      })
      .mockResolvedValueOnce({
        records: [
          [
            { stringValue: 'ver-2' },
            { stringValue: 'doc-1' },
            { longValue: 2 },
            { stringValue: 'tenants/tenant-test/documents/doc-1/v2.json' },
            { stringValue: 'Section edit: 4.1' },
            { stringValue: 'user-9' },
            { stringValue: '2026-07-22T00:00:00Z' },
          ],
        ],
        columnMetadata: [
          { name: 'id' },
          { name: 'document_id' },
          { name: 'version_no' },
          { name: 'content_ref' },
          { name: 'change_summary' },
          { name: 'author_id' },
          { name: 'created_at' },
        ],
      })
      .mockResolvedValueOnce({ records: undefined, columnMetadata: undefined });

    mockS3Send.mockResolvedValueOnce(s3GetBody(ORIGINAL_CONTENT));
    mockS3Send.mockResolvedValueOnce({});

    await handler(
      makeEvent('saveDocumentSectionEdit', {
        input: {
          versionId: 'v1',
          harmonizationKey: '4.1',
          body: 'Edited content.',
          trackedChanges: TRACKED_CHANGES, // the array itself — no stringify
        },
      }),
    );

    const putCall = mockS3Send.mock.calls[1][0] as { input: { Body: string } };
    const written = JSON.parse(putCall.input.Body);
    expect(written.sections[0].trackedChanges).toEqual(TRACKED_CHANGES); // round-trip intact
  });
});

describe('saveDocumentSectionEdit — sealed-version write rejection (7.5.2)', () => {
  it('rejects edits to an APPROVED document, no S3 write, rolls back', async () => {
    mockExecute.mockResolvedValueOnce({
      records: [[{ stringValue: 'doc-1' }, { stringValue: 'APPROVED' }, { stringValue: 'v1-key' }]],
      columnMetadata: [{ name: 'document_id' }, { name: 'status' }, { name: 'content_ref' }],
    });

    await expect(
      handler(
        makeEvent('saveDocumentSectionEdit', {
          input: {
            versionId: 'v1',
            harmonizationKey: '4.1',
            body: 'x',
            trackedChanges: '[]',
          },
        }),
      ),
    ).rejects.toThrow('SEALED_VERSION_REJECTED');

    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockRollback).toHaveBeenCalledOnce();
  });

  it('rejects edits to an OBSOLETE document', async () => {
    mockExecute.mockResolvedValueOnce({
      records: [[{ stringValue: 'doc-1' }, { stringValue: 'OBSOLETE' }, { stringValue: 'v1-key' }]],
      columnMetadata: [{ name: 'document_id' }, { name: 'status' }, { name: 'content_ref' }],
    });

    await expect(
      handler(
        makeEvent('saveDocumentSectionEdit', {
          input: { versionId: 'v1', harmonizationKey: '4.1', body: 'x', trackedChanges: '[]' },
        }),
      ),
    ).rejects.toThrow('SEALED_VERSION_REJECTED');
    expect(mockRollback).toHaveBeenCalledOnce();
  });
});

describe('saveDocumentSectionEdit — not-found paths', () => {
  it('throws VERSION_NOT_FOUND when the version row does not exist', async () => {
    mockExecute.mockResolvedValueOnce({ records: [], columnMetadata: [] });
    await expect(
      handler(
        makeEvent('saveDocumentSectionEdit', {
          input: { versionId: 'missing', harmonizationKey: '4.1', body: 'x', trackedChanges: '[]' },
        }),
      ),
    ).rejects.toThrow('VERSION_NOT_FOUND');
    expect(mockRollback).toHaveBeenCalledOnce();
  });

  it('throws SECTION_NOT_FOUND when harmonizationKey has no match in the content', async () => {
    mockExecute.mockResolvedValueOnce({
      records: [[{ stringValue: 'doc-1' }, { stringValue: 'DRAFT' }, { stringValue: 'v1-key' }]],
      columnMetadata: [{ name: 'document_id' }, { name: 'status' }, { name: 'content_ref' }],
    });
    mockS3Send.mockResolvedValueOnce(s3GetBody(ORIGINAL_CONTENT));

    await expect(
      handler(
        makeEvent('saveDocumentSectionEdit', {
          input: { versionId: 'v1', harmonizationKey: '9.9', body: 'x', trackedChanges: '[]' },
        }),
      ),
    ).rejects.toThrow('SECTION_NOT_FOUND');
    // Thrown in phase 2 (S3 merge), AFTER the meta txn committed and before
    // the write txn opened — nothing is left to roll back.
    expect(mockRollback).not.toHaveBeenCalled();
    expect(mockCommit).toHaveBeenCalledOnce(); // phase-1 meta txn
  });
});
