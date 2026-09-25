/**
 * Tenant-docs indexer unit tests (B3, amendment 2).
 * Hermetic: mocks S3, embed (one-door), AOSS signed client.
 * NO RDS mocks — contentRef comes from the event payload (B3-VPC-1).
 * Validates: payload-driven contentRef read, S3 fetch, prose-only chunking,
 * embed call per section, POST /_doc auto-ID writes, skips on missing
 * contentRef (old-format drain), IMS-standard passthrough, retries on
 * 403/404/429/5xx.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mocks ──────────────────────────────────────────────────────────

const { mockS3Send, mockEmbedFn, mockAossFetch } = vi.hoisted(() => ({
  mockS3Send: vi.fn(),
  mockEmbedFn: vi.fn(),
  mockAossFetch: vi.fn(),
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = mockS3Send;
  },
  GetObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('../../agents/shared/invoke-transport.js', () => ({
  createEmbedFn: () => mockEmbedFn,
  createInvokeFn: () => vi.fn(),
}));

vi.mock('../../agents/shared/aoss-signed-client.js', () => ({
  signedAossFetch: mockAossFetch,
}));

vi.mock('@aws-lambda-powertools/logger', () => ({
  Logger: class {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    appendKeys = vi.fn();
  },
}));

vi.mock('../../eventing/src/consumer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../eventing/src/consumer.js')>();
  return { ...actual };
});

// ─── Env setup (L4: call-time read) ─────────────────────────────────────────

process.env.CONTENT_BUCKET = 'mock-general-bucket';
process.env.AOSS_TENANT_DOCS_ENDPOINT = 'https://mock.us-east-1.aoss.amazonaws.com';
process.env.AI_INVOKER_ARN = 'arn:aws:lambda:us-east-1:123:function:ai-invoker';
process.env.DLQ_URL = 'https://sqs.us-east-1.amazonaws.com/123/TenantDocsIndexerDlq';

import { processDocumentPublished } from '../tenant-docs/handler.js';
import type { CumplifyEvent } from '../../eventing/src/types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEvent(
  payload: Record<string, unknown>,
  standard: string = 'ISO9001',
): CumplifyEvent<any> {
  return {
    tenantId: 'tenant-aaa',
    eventId: 'evt-1',
    timestamp: '2026-07-23T00:00:00Z',
    actor: 'user-1',
    module: 'M1',
    clauseRef: 'ISO 9001 7.5.3',
    standard: standard as any,
    auditTrail: true,
    entityId: 'doc-1',
    payload,
  };
}

const CONTENT_REF = 'tenants/tenant-aaa/documents/doc-1/v1.json';

const DOCUMENT_CONTENT = {
  schemaVersion: 1,
  sections: [
    {
      harmonizationKey: '4.1',
      kind: 'prose',
      sentences: [
        { text: 'The organization determines external issues.', sources: ['profile.legalName'] },
        { text: 'Internal issues are monitored.', sources: [] },
      ],
    },
    {
      harmonizationKey: '4.2',
      kind: 'gap',
      sentences: [],
    },
    {
      harmonizationKey: '4.4',
      kind: 'prose',
      sentences: [{ text: 'The QMS processes are defined.', sources: [] }],
    },
  ],
};

function mockS3ContentStream(content: unknown) {
  return {
    Body: {
      transformToString: vi.fn().mockResolvedValue(JSON.stringify(content)),
    },
  };
}

const FAKE_EMBEDDING = new Array(1024).fill(0.01);

beforeEach(() => {
  mockS3Send.mockReset();
  mockEmbedFn.mockReset();
  mockAossFetch.mockReset();

  // Default: S3 returns document content
  mockS3Send.mockResolvedValue(mockS3ContentStream(DOCUMENT_CONTENT));

  // Default: embed returns 1024-dim vector
  mockEmbedFn.mockResolvedValue({ embedding: FAKE_EMBEDDING, tokenCount: 10, credits: 1 });

  // Default: AOSS write succeeds
  mockAossFetch.mockResolvedValue({ status: 201, body: '{"result":"created"}' });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Tenant-docs indexer (B3)', () => {
  it('happy path: reads contentRef from payload → S3 → embeds prose → POST /_doc', async () => {
    await processDocumentPublished(
      makeEvent({ versionId: 'v1', documentId: 'doc-1', contentRef: CONTENT_REF }),
    );

    // S3 called with correct bucket and key from payload
    expect(mockS3Send).toHaveBeenCalledOnce();
    const s3Cmd = mockS3Send.mock.calls[0][0] as { input: { Bucket: string; Key: string } };
    expect(s3Cmd.input.Key).toBe(CONTENT_REF);
    expect(s3Cmd.input.Bucket).toBe('mock-general-bucket');

    // Embed called for 2 prose sections (gap section skipped)
    expect(mockEmbedFn).toHaveBeenCalledTimes(2);
    const firstEmbed = mockEmbedFn.mock.calls[0][0];
    expect(firstEmbed.tenantId).toBe('tenant-aaa');
    expect(firstEmbed.agent).toBe('TenantDocsIndexer');
    expect(firstEmbed.systemOp).toBe(true);
    expect(firstEmbed.text).toContain('The organization determines external issues.');
    expect(firstEmbed.text).toContain('Internal issues are monitored.');

    // AOSS: POST /_doc (auto-ID, no client _id)
    expect(mockAossFetch).toHaveBeenCalledTimes(2);
    const [method, endpoint, path, body] = mockAossFetch.mock.calls[0];
    expect(method).toBe('POST');
    expect(endpoint).toBe('https://mock.us-east-1.aoss.amazonaws.com');
    expect(path).toBe('/cumplify-tenant-docs/_doc');
    const parsed = JSON.parse(body);
    expect(parsed.embedding).toEqual(FAKE_EMBEDDING);
    expect(parsed.metadata.tenantId).toBe('tenant-aaa');
    expect(parsed.metadata.documentId).toBe('doc-1');
    expect(parsed.metadata.versionId).toBe('v1');
    expect(parsed.metadata.clauseRef).toBe('4.1');
    expect(parsed.metadata.standard).toBe('ISO9001');
  });

  it('missing contentRef in payload → skip with warn (old-format event drain)', async () => {
    await processDocumentPublished(makeEvent({ versionId: 'v1', documentId: 'doc-1' }));

    // No S3, embed, or AOSS calls — graceful skip
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockEmbedFn).not.toHaveBeenCalled();
    expect(mockAossFetch).not.toHaveBeenCalled();
  });

  it('empty string contentRef → skip with warn', async () => {
    await processDocumentPublished(
      makeEvent({ versionId: 'v1', documentId: 'doc-1', contentRef: '' }),
    );

    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockEmbedFn).not.toHaveBeenCalled();
  });

  it('missing versionId or documentId → skip', async () => {
    await processDocumentPublished(makeEvent({ contentRef: CONTENT_REF }));
    expect(mockS3Send).not.toHaveBeenCalled();

    await processDocumentPublished(makeEvent({ versionId: 'v1', contentRef: CONTENT_REF }));
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it('IMS standard passes through to AOSS metadata (multi-standard docs)', async () => {
    await processDocumentPublished(
      makeEvent({ versionId: 'v1', documentId: 'doc-1', contentRef: CONTENT_REF }, 'IMS'),
    );

    expect(mockAossFetch).toHaveBeenCalledTimes(2);
    const body1 = JSON.parse(mockAossFetch.mock.calls[0][3]);
    expect(body1.metadata.standard).toBe('IMS');
    const body2 = JSON.parse(mockAossFetch.mock.calls[1][3]);
    expect(body2.metadata.standard).toBe('IMS');
  });

  it('skips when document has no prose sections', async () => {
    mockS3Send.mockResolvedValue(
      mockS3ContentStream({
        schemaVersion: 1,
        sections: [{ harmonizationKey: '4.1', kind: 'gap', sentences: [] }],
      }),
    );

    await processDocumentPublished(
      makeEvent({ versionId: 'v1', documentId: 'doc-1', contentRef: CONTENT_REF }),
    );

    expect(mockEmbedFn).not.toHaveBeenCalled();
    expect(mockAossFetch).not.toHaveBeenCalled();
  });

  it('POST path is /cumplify-tenant-docs/_doc for all sections (auto-ID)', async () => {
    await processDocumentPublished(
      makeEvent({ versionId: 'v1', documentId: 'doc-1', contentRef: CONTENT_REF }),
    );

    for (const call of mockAossFetch.mock.calls) {
      expect(call[0]).toBe('POST');
      expect(call[2]).toBe('/cumplify-tenant-docs/_doc');
    }
  });

  it('retries on 503 from AOSS (cold-start backoff)', async () => {
    mockAossFetch
      .mockResolvedValueOnce({ status: 503, body: 'Service Unavailable' })
      .mockResolvedValueOnce({ status: 201, body: '{"result":"created"}' })
      .mockResolvedValue({ status: 201, body: '{"result":"created"}' });

    await processDocumentPublished(
      makeEvent({ versionId: 'v1', documentId: 'doc-1', contentRef: CONTENT_REF }),
    );

    // First section: 503 then 201 = 2 calls; second section: 201 = 1 call → total 3
    expect(mockAossFetch).toHaveBeenCalledTimes(3);
  });

  it('retries on 403 and 404 from AOSS (house write-path rule)', async () => {
    mockS3Send.mockResolvedValue(
      mockS3ContentStream({
        schemaVersion: 1,
        sections: [{ harmonizationKey: '4.1', kind: 'prose', sentences: [{ text: 'Test.' }] }],
      }),
    );
    mockAossFetch
      .mockResolvedValueOnce({ status: 403, body: 'Forbidden' })
      .mockResolvedValueOnce({ status: 404, body: 'Not Found' })
      .mockResolvedValueOnce({ status: 201, body: '{"result":"created"}' });

    await processDocumentPublished(
      makeEvent({ versionId: 'v1', documentId: 'doc-1', contentRef: CONTENT_REF }),
    );

    expect(mockAossFetch).toHaveBeenCalledTimes(3);
  });
});
