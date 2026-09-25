/**
 * Unit tests for hybrid retrieval extension.
 * Spec: iso-kb-content-depth, Task 2.
 * Tests the compound filter construction and zero-result fallback.
 */

import { describe, it, expect, vi } from 'vitest';
import { retrieve, type AossHttpClient, type RetrievalRequest } from '../retrieval.js';

// Mock a 1024-dim vector
const MOCK_VECTOR = Array.from({ length: 1024 }, (_, i) => i * 0.001);

function makeRequest(overrides?: Partial<RetrievalRequest>): RetrievalRequest {
  return {
    tenantId: '__ISO_CANON__',
    collectionEndpoint: 'https://fake.aoss.us-east-1.amazonaws.com',
    indexName: 'cumplify-iso-kb',
    queryText: 'test question',
    queryVector: MOCK_VECTOR,
    topK: 5,
    ...overrides,
  };
}

function mockClient(responses: unknown[]): AossHttpClient {
  let callIdx = 0;
  const searchFn = vi.fn(async () => {
    const resp = responses[callIdx] ?? responses[responses.length - 1];
    callIdx++;
    return resp;
  });
  return { search: searchFn };
}

function extractQueryBody(client: AossHttpClient): Record<string, unknown> {
  const mock = client.search as ReturnType<typeof vi.fn>;
  return mock.mock.calls[0][2] as Record<string, unknown>;
}

function extractFilter(body: Record<string, unknown>): unknown {
  return (body as any).query.knn.embedding.filter;
}

describe('hybrid retrieval', () => {
  describe('filter construction', () => {
    it('without hybrid → single-term tenantId filter (backward compat)', async () => {
      const client = mockClient([
        { hits: { hits: [{ _source: { text: 'test', metadata: {} }, _score: 0.9 }] } },
      ]);
      const request = makeRequest();

      await retrieve(request, client);

      const body = extractQueryBody(client);
      const filter = extractFilter(body);
      expect(filter).toEqual({ term: { 'metadata.tenantId': '__ISO_CANON__' } });
    });

    it('with clauseRef → bool.must includes clauseRef term', async () => {
      const client = mockClient([
        { hits: { hits: [{ _source: { text: 'test', metadata: {} }, _score: 0.9 }] } },
      ]);
      const request = makeRequest({ hybrid: { clauseRef: 'ISO 9001 4.1' } });

      await retrieve(request, client);

      const body = extractQueryBody(client);
      const filter = extractFilter(body);
      expect(filter).toEqual({
        bool: {
          must: [
            { term: { 'metadata.tenantId': '__ISO_CANON__' } },
            { term: { 'metadata.clauseRef': 'ISO 9001 4.1' } },
          ],
        },
      });
    });

    it('with clauseRef + standard → bool.must includes all three terms', async () => {
      const client = mockClient([
        { hits: { hits: [{ _source: { text: 'test', metadata: {} }, _score: 0.9 }] } },
      ]);
      const request = makeRequest({ hybrid: { clauseRef: 'ISO 9001 4.1', standard: 'ISO9001' } });

      await retrieve(request, client);

      const body = extractQueryBody(client);
      const filter = extractFilter(body);
      expect(filter).toEqual({
        bool: {
          must: [
            { term: { 'metadata.tenantId': '__ISO_CANON__' } },
            { term: { 'metadata.clauseRef': 'ISO 9001 4.1' } },
            { term: { 'metadata.standard': 'ISO9001' } },
          ],
        },
      });
    });

    it('with standard only (no clauseRef) → bool.must with tenantId + standard', async () => {
      const client = mockClient([
        { hits: { hits: [{ _source: { text: 'test', metadata: {} }, _score: 0.9 }] } },
      ]);
      const request = makeRequest({ hybrid: { standard: 'ISO9001' } });

      await retrieve(request, client);

      const body = extractQueryBody(client);
      const filter = extractFilter(body);
      expect(filter).toEqual({
        bool: {
          must: [
            { term: { 'metadata.tenantId': '__ISO_CANON__' } },
            { term: { 'metadata.standard': 'ISO9001' } },
          ],
        },
      });
    });

    it('tenantId is ALWAYS present regardless of hybrid options', async () => {
      const client = mockClient([
        { hits: { hits: [{ _source: { text: 'x', metadata: {} }, _score: 0.5 }] } },
      ]);
      const request = makeRequest({ hybrid: { clauseRef: 'ISO 9001 4.1', standard: 'ISO9001' } });

      await retrieve(request, client);

      const body = extractQueryBody(client);
      const filter = extractFilter(body) as any;
      const terms = filter.bool.must;
      const tenantFilter = terms.find((t: any) => t.term?.['metadata.tenantId']);
      expect(tenantFilter).toBeDefined();
      expect(tenantFilter.term['metadata.tenantId']).toBe('__ISO_CANON__');
    });
  });

  describe('verified-clear pin: no min_score when scoreThreshold undefined', () => {
    it('query does NOT contain min_score key when scoreThreshold is undefined', async () => {
      const client = mockClient([
        { hits: { hits: [{ _source: { text: 'x', metadata: {} }, _score: 0.3 }] } },
      ]);
      const request = makeRequest({ scoreThreshold: undefined });

      await retrieve(request, client);

      const body = extractQueryBody(client);
      expect(body).not.toHaveProperty('min_score');
    });

    it('query DOES contain min_score when scoreThreshold is set', async () => {
      const client = mockClient([
        { hits: { hits: [{ _source: { text: 'x', metadata: {} }, _score: 0.5 }] } },
      ]);
      const request = makeRequest({ scoreThreshold: 0.5 });

      await retrieve(request, client);

      const body = extractQueryBody(client);
      expect(body).toHaveProperty('min_score', 0.5);
    });
  });

  describe('RETRIEVAL-2f: zero-result fallback', () => {
    it('falls back to kNN-only when hybrid returns zero results', async () => {
      const emptyResponse = { hits: { hits: [] } };
      const fallbackResponse = {
        hits: { hits: [{ _source: { text: 'fallback', metadata: {} }, _score: 0.4 }] },
      };
      const client = mockClient([emptyResponse, fallbackResponse]);

      const request = makeRequest({ hybrid: { clauseRef: 'ISO 9001 99.9', standard: 'ISO9001' } });
      const result = await retrieve(request, client);

      // Should have called search twice (first with hybrid, second without)
      expect((client.search as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
      expect(result.chunks).toHaveLength(1);
      expect(result.chunks[0].text).toBe('fallback');

      // Second call should NOT have hybrid filters (just tenantId)
      const secondBody = (client.search as ReturnType<typeof vi.fn>).mock.calls[1][2] as any;
      const secondFilter = secondBody.query.knn.embedding.filter;
      expect(secondFilter).toEqual({ term: { 'metadata.tenantId': '__ISO_CANON__' } });
    });

    it('does NOT fallback when hybrid returns results', async () => {
      const response = {
        hits: { hits: [{ _source: { text: 'found', metadata: {} }, _score: 0.9 }] },
      };
      const client = mockClient([response]);

      const request = makeRequest({ hybrid: { clauseRef: 'ISO 9001 4.1', standard: 'ISO9001' } });
      const result = await retrieve(request, client);

      expect((client.search as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
      expect(result.chunks[0].text).toBe('found');
    });

    it('does NOT fallback when no hybrid options are set (topic question)', async () => {
      const emptyResponse = { hits: { hits: [] } };
      const client = mockClient([emptyResponse]);

      const request = makeRequest(); // no hybrid
      const result = await retrieve(request, client);

      // Only one call — no fallback attempt for non-hybrid queries
      expect((client.search as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
      expect(result.chunks).toHaveLength(0);
    });
  });
});
