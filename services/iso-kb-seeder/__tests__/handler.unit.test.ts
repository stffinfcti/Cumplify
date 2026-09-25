/**
 * Unit tests for the ISO KB Seeder handler.
 * Spec: iso-kb-seeding Task 4.
 * Mocks: signedAossFetch, createEmbedFn, verifyTemplate.
 * Verifies: idempotent skip, full-seed, fail-closed, _meta doc shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
const signedFetchMock = vi.fn();
const verifyTemplateMock = vi.fn();
const lambdaSendMock = vi.fn();

vi.mock('../../agents/shared/aoss-signed-client.js', () => ({
  signedAossFetch: (...args: unknown[]) => signedFetchMock(...args),
}));

vi.mock('../../agents/shared/aoss-apply-template.js', () => ({
  verifyTemplate: (...args: unknown[]) => verifyTemplateMock(...args),
}));

vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class {
    send = lambdaSendMock;
  },
  InvokeCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

vi.stubEnv('AOSS_ENDPOINT', 'https://iso-kb.us-east-1.aoss.amazonaws.com');
vi.stubEnv('AOSS_INDEX_NAME', 'cumplify-iso-kb');
vi.stubEnv('AI_INVOKER_ARN', 'arn:aws:lambda:us-east-1:697114252993:function:ai-invoker');

const { seed } = await import('../src/handler.js');

// Helper: mock embed response from the one-door Lambda transport
function mockEmbedResponse() {
  return {
    Payload: Buffer.from(
      JSON.stringify({
        embedding: Array(1024).fill(0.01),
        tokenCount: 50,
        credits: 0.001,
      }),
    ),
  };
}

beforeEach(() => {
  signedFetchMock.mockReset();
  verifyTemplateMock.mockReset();
  lambdaSendMock.mockReset();
});

describe('handler — idempotent skip (ACC-3)', () => {
  it('skips when content hash matches existing _meta doc', async () => {
    // Simulate: _meta doc exists with matching hash
    // The handler computes the hash internally; we need to return the same hash.
    // We intercept the _search request for _meta and return a hash that matches.
    // Since we can't predict the exact hash, we'll capture it on first call.
    let capturedHash: string | null = null;

    signedFetchMock.mockImplementation((method: string, _endpoint: string, path: string) => {
      if (method === 'POST' && path.includes('_search')) {
        if (capturedHash) {
          return Promise.resolve({
            status: 200,
            body: JSON.stringify({ hits: { hits: [{ _source: { contentHash: capturedHash } }] } }),
          });
        }
        // First call: return empty search (no _meta doc exists)
        return Promise.resolve({ status: 200, body: JSON.stringify({ hits: { hits: [] } }) });
      }
      if (method === 'DELETE') {
        return Promise.resolve({ status: 200, body: '{"acknowledged":true}' });
      }
      if (method === 'PUT') {
        return Promise.resolve({ status: 200, body: '{}' }); // createIndex
      }
      // POST /_doc (chunk indexing + _meta write)
      return Promise.resolve({ status: 201, body: '{"_id":"auto-1"}' });
    });

    // First: do a full seed to capture the real hash
    verifyTemplateMock.mockResolvedValue({
      collection: 'cumplify-iso-kb',
      dimension: 1024,
      tenantIdType: 'keyword',
    });
    lambdaSendMock.mockResolvedValue(mockEmbedResponse());

    const firstResult = await seed();
    expect(firstResult.status).toBe('seeded');
    capturedHash = firstResult.contentHash;

    // Reset mocks for second call
    signedFetchMock.mockReset();
    lambdaSendMock.mockReset();
    signedFetchMock.mockImplementation((method: string, _endpoint: string, path: string) => {
      if (method === 'POST' && path.includes('_search')) {
        return Promise.resolve({
          status: 200,
          body: JSON.stringify({ hits: { hits: [{ _source: { contentHash: capturedHash } }] } }),
        });
      }
      return Promise.resolve({ status: 201, body: '{}' });
    });

    // Second call: should skip
    const secondResult = await seed();
    expect(secondResult.status).toBe('skipped');
    expect(secondResult.contentHash).toBe(capturedHash);
    // No embed calls on skip
    expect(lambdaSendMock).not.toHaveBeenCalled();
  });
});

describe('handler — full seed on mismatch', () => {
  it('seeds all chunks when hash mismatches', async () => {
    signedFetchMock.mockImplementation((method: string, _endpoint: string, path: string) => {
      if (method === 'POST' && path.includes('_search')) {
        return Promise.resolve({ status: 200, body: JSON.stringify({ hits: { hits: [] } }) });
      }
      if (method === 'DELETE') {
        return Promise.resolve({ status: 200, body: '{"acknowledged":true}' });
      }
      if (method === 'PUT') {
        return Promise.resolve({ status: 200, body: '{}' }); // createIndex
      }
      // POST /_doc (chunk indexing + _meta write)
      return Promise.resolve({ status: 201, body: '{"_id":"auto-1"}' });
    });
    verifyTemplateMock.mockResolvedValue({
      collection: 'cumplify-iso-kb',
      dimension: 1024,
      tenantIdType: 'keyword',
    });
    lambdaSendMock.mockResolvedValue(mockEmbedResponse());

    const result = await seed();

    expect(result.status).toBe('seeded');
    expect(result.chunksTotal).toBe(109); // EXPECTED_CHUNK_COUNT
    expect(result.chunksIndexed).toBe(109);
    // Embeddings: one Lambda invoke per chunk
    expect(lambdaSendMock).toHaveBeenCalledTimes(109);
  });
});

describe('handler — template fail-closed (ACC-5)', () => {
  it('aborts when verifyTemplate throws', async () => {
    signedFetchMock.mockImplementation((method: string, _endpoint: string, path: string) => {
      if (method === 'POST' && path.includes('_search')) {
        return Promise.resolve({ status: 200, body: JSON.stringify({ hits: { hits: [] } }) });
      }
      if (method === 'DELETE') {
        return Promise.resolve({ status: 200, body: '{"acknowledged":true}' });
      }
      return Promise.resolve({ status: 200, body: '{}' });
    });
    verifyTemplateMock.mockRejectedValue(
      new Error('FAIL-CLOSED cumplify-iso-kb: metadata.lang.type=undefined, expected keyword'),
    );

    await expect(seed()).rejects.toThrow(/FAIL-CLOSED/);
    // No embeds or indexing attempted after template failure
    expect(lambdaSendMock).not.toHaveBeenCalled();
  });
});

describe('handler — _meta doc shape (D-2)', () => {
  it('_meta doc has tenantId=__META__ and no embedding field', async () => {
    const metaDocBodies: string[] = [];

    signedFetchMock.mockImplementation(
      (method: string, _endpoint: string, path: string, body?: string) => {
        if (method === 'POST' && path.includes('_search')) {
          return Promise.resolve({ status: 200, body: JSON.stringify({ hits: { hits: [] } }) });
        }
        // Capture _meta doc writes (POST /_doc with __META__ in body)
        if (method === 'POST' && path.endsWith('/_doc') && body?.includes('__META__')) {
          metaDocBodies.push(body);
        }
        if (method === 'DELETE') {
          return Promise.resolve({ status: 200, body: '{"acknowledged":true}' });
        }
        if (method === 'PUT') {
          return Promise.resolve({ status: 200, body: '{}' }); // createIndex
        }
        return Promise.resolve({ status: 201, body: '{"_id":"auto-1"}' });
      },
    );
    verifyTemplateMock.mockResolvedValue({
      collection: 'cumplify-iso-kb',
      dimension: 1024,
      tenantIdType: 'keyword',
    });
    lambdaSendMock.mockResolvedValue(mockEmbedResponse());

    await seed();

    // Verify _meta doc shape
    expect(metaDocBodies).toHaveLength(1);
    const metaDoc = JSON.parse(metaDocBodies[0]);
    expect(metaDoc.metadata.tenantId).toBe('__META__');
    expect(metaDoc.metadata.standard).toBe('SYSTEM');
    expect(metaDoc.metadata.clauseRef).toBe('_meta');
    expect(metaDoc).not.toHaveProperty('embedding'); // D-2: no embedding field
    expect(metaDoc.contentHash).toBeTruthy();
    expect(metaDoc.chunksTotal).toBe(109);
  });
});
