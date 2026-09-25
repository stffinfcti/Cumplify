/**
 * AOSS retrieval wrapper — mandatory tenantId metadata filter + 45s cold-start backoff.
 * Design §4.1 — agents-existing-8.
 *
 * REQ-RET-1: Every query MUST include tenantId metadata filter.
 * REQ-RET-3: Exponential backoff — base 500ms, factor 2, jitter, ceiling 45s.
 * Steering 02-aoss-rule: Lambda timeout >= 60s; cold-start up to 45s.
 *
 * Uses the OpenSearch client to query AOSS VECTORSEARCH collections.
 * Titan Embed v2 = 1024 dimensions (D-4 corpus-corrected).
 */

import { Logger } from '@aws-lambda-powertools/logger';
import { signedAossFetch } from './aoss-signed-client.js';

const logger = new Logger({ serviceName: 'agents-retrieval' });

const BACKOFF_BASE_MS = 500;
const BACKOFF_FACTOR = 2;
const BACKOFF_CEILING_MS = 45_000;
const MAX_ATTEMPTS = 12; // ceil(log2(45000/500)) + margin

export interface RetrievalRequest {
  /** MANDATORY — no unfiltered query (REQ-RET-1, steering 01) */
  tenantId: string;
  /** AOSS collection endpoint URL */
  collectionEndpoint: string;
  /** Index name within the collection */
  indexName: string;
  /** Query text (will be embedded by the retrieval path) */
  queryText: string;
  /** Embedding vector (pre-computed by caller using Titan Embed v2, 1024-dim) */
  queryVector: number[];
  /** Number of results to return (default 5) */
  topK?: number;
  /** Minimum score threshold (optional relevance floor) */
  scoreThreshold?: number;
  /** Hybrid clause-ref filtering (iso-kb-content-depth LEG-2) */
  hybrid?: HybridRetrievalOptions;
}

/**
 * Hybrid retrieval options for clause-ref-based filtering.
 * When present, adds term filters on metadata.clauseRef and/or metadata.standard
 * to the kNN query (RETRIEVAL-3a: kNN within filter).
 */
export interface HybridRetrievalOptions {
  /** Clause reference to filter on (metadata.clauseRef exact match) */
  clauseRef?: string;
  /** Standard to filter on (metadata.standard exact match) */
  standard?: string;
}

export interface RetrievalChunk {
  text: string;
  score: number;
  metadata: Record<string, string>;
}

export interface RetrievalResult {
  chunks: RetrievalChunk[];
  latencyMs: number;
  coldStart: boolean;
  attempts: number;
}

export class AossColdStartTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AossColdStartTimeoutError';
  }
}

export class TenantFilterMissingError extends Error {
  constructor() {
    super(
      'AOSS retrieval query MUST include tenantId metadata filter (REQ-RET-1). This is a blocking defect.',
    );
    this.name = 'TenantFilterMissingError';
  }
}

/**
 * Execute a tenant-isolated vector search against AOSS with exponential-backoff retry.
 *
 * The caller is responsible for:
 * 1. Embedding the query text (Titan Embed v2, 1024 dimensions).
 * 2. Providing the collection endpoint and index name.
 *
 * This function enforces:
 * - Mandatory tenantId metadata filter (REQ-RET-1).
 * - Exponential-backoff retry with 45s ceiling (REQ-RET-3).
 */
export async function retrieve(
  request: RetrievalRequest,
  /** Injectable HTTP client for testing */
  httpClient?: AossHttpClient,
  /** Absolute deadline (ms epoch) — the 45s ceiling carries through the
   * hybrid→kNN fallback instead of restarting, so a fallback can never
   * double the Lambda's time inside retrieve. */
  deadlineMs?: number,
): Promise<RetrievalResult> {
  // REQ-RET-1: MANDATORY tenantId filter — fail immediately if missing
  if (!request.tenantId) {
    throw new TenantFilterMissingError();
  }

  // R5-n1: fail-fast on wrong embedding dimensions (Titan Embed v2 = 1024)
  if (request.queryVector.length !== 1024) {
    throw new Error(
      `queryVector must be 1024 dimensions (Titan Embed v2), got ${request.queryVector.length}`,
    );
  }

  const topK = request.topK ?? 5;
  const startTime = Date.now();
  const deadline = deadlineMs ?? startTime + BACKOFF_CEILING_MS;
  let attempts = 0;
  let coldStart = false;
  let lastError: Error | null = null;

  const client = httpClient ?? defaultAossClient;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    attempts = attempt + 1;

    // Check the deadline BEFORE attempting (except first try)
    if (attempt > 0) {
      const remainingBudget = deadline - Date.now();
      if (remainingBudget <= 0) {
        break; // Deadline exhausted (carried across fallbacks)
      }

      const delayMs = Math.min(
        BACKOFF_BASE_MS * Math.pow(BACKOFF_FACTOR, attempt - 1),
        remainingBudget,
      );
      const jitter = Math.random() * delayMs * 0.2;
      await new Promise((resolve) => setTimeout(resolve, delayMs + jitter));
      coldStart = true; // Any retry indicates a cold-start scenario
    }

    try {
      const body = buildKnnQuery(
        request.queryVector,
        request.tenantId,
        topK,
        request.scoreThreshold,
        request.hybrid,
      );
      // R5-n3: derive socket timeout from the remaining deadline (not a
      // fixed 50s) — a fallback invocation gets what is actually left.
      const remainingMs = Math.max(deadline - Date.now() + 5000, 10_000); // floor 10s
      const response = await client.search(
        request.collectionEndpoint,
        request.indexName,
        body,
        remainingMs,
      );
      const chunks = parseSearchResponse(response);

      const latencyMs = Date.now() - startTime;
      logger.info('AOSS retrieval succeeded', {
        tenantId: request.tenantId,
        indexName: request.indexName,
        topK,
        resultsReturned: chunks.length,
        latencyMs,
        attempts,
        coldStart,
      });

      // RETRIEVAL-2f: if hybrid filters returned zero results, fall back to kNN-only
      if (chunks.length === 0 && request.hybrid?.clauseRef) {
        logger.info('Hybrid clause-ref returned 0 results — falling back to kNN-only', {
          clauseRef: request.hybrid.clauseRef,
          standard: request.hybrid.standard,
        });
        const fallbackRequest = { ...request, hybrid: undefined };
        return retrieve(fallbackRequest, httpClient, deadline);
      }

      return { chunks, latencyMs, coldStart, attempts };
    } catch (err: unknown) {
      lastError = err as Error;
      const isRetryable = isAossRetryable(err);

      if (!isRetryable) {
        logger.error('AOSS retrieval non-retryable error', {
          tenantId: request.tenantId,
          error: (err as Error).message,
          attempts,
        });
        throw err;
      }

      logger.warn('AOSS retrieval retrying (cold-start likely)', {
        tenantId: request.tenantId,
        attempt: attempt + 1,
        error: (err as Error).message,
      });
    }
  }

  // Exhausted all attempts within ceiling
  throw new AossColdStartTimeoutError(
    `AOSS retrieval timed out after ${Date.now() - startTime}ms (${attempts} attempts). ` +
      `Last error: ${lastError?.message ?? 'unknown'}`,
  );
}

/**
 * Build the kNN query body with mandatory tenantId metadata filter.
 * Hybrid options add clauseRef and/or standard term filters (RETRIEVAL-3a).
 */
function buildKnnQuery(
  vector: number[],
  tenantId: string,
  topK: number,
  scoreThreshold?: number,
  hybrid?: HybridRetrievalOptions,
): Record<string, unknown> {
  // Build filter clauses — always includes tenantId (REQ-RET-1)
  const filterClauses: Record<string, unknown>[] = [{ term: { 'metadata.tenantId': tenantId } }];

  // Add clauseRef term filter when hybrid parsing detected a clause reference
  if (hybrid?.clauseRef) {
    filterClauses.push({ term: { 'metadata.clauseRef': hybrid.clauseRef } });
  }

  // Add standard term filter (RETRIEVAL-2b: per-guru standard)
  if (hybrid?.standard) {
    filterClauses.push({ term: { 'metadata.standard': hybrid.standard } });
  }

  // Compose filter: single term or bool.must array
  const filter = filterClauses.length === 1 ? filterClauses[0] : { bool: { must: filterClauses } };

  const query: Record<string, unknown> = {
    size: topK,
    query: {
      knn: {
        embedding: {
          vector,
          k: topK,
          filter, // REQ-RET-1: mandatory tenantId + optional hybrid filters
        },
      },
    },
    _source: ['text', 'metadata'],
  };

  if (scoreThreshold !== undefined) {
    (query as any).min_score = scoreThreshold;
  }

  return query;
}

function parseSearchResponse(response: unknown): RetrievalChunk[] {
  const hits = (response as any)?.hits?.hits ?? [];
  return hits.map((hit: any) => ({
    text: hit._source?.text ?? '',
    score: hit._score ?? 0,
    metadata: hit._source?.metadata ?? {},
  }));
}

function isAossRetryable(err: unknown): boolean {
  const statusCode = (err as any)?.statusCode ?? (err as any)?.$metadata?.httpStatusCode ?? 0;
  const message = ((err as Error).message ?? '').toLowerCase();
  return (
    statusCode >= 500 ||
    statusCode === 503 ||
    statusCode === 429 ||
    message.includes('timeout') ||
    message.includes('connection') ||
    message.includes('econnrefused') ||
    message.includes('econnreset') ||
    message.includes('service unavailable')
  );
}

// ─── HTTP Client Interface (injectable for testing) ─────────────────────────

export interface AossHttpClient {
  search(
    endpoint: string,
    indexName: string,
    body: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown>;
}

/**
 * Default AOSS client — SigV4-signed (service 'aoss') via the shared client.
 * Task-12 fix: the previous default was a bare fetch — AOSS rejected every
 * query with 403 (live-confirmed, Task-11 carry). Caller must run inside the
 * VPC (AOSS network policy allows the VPC endpoint only).
 */
const defaultAossClient: AossHttpClient = {
  async search(
    endpoint: string,
    indexName: string,
    body: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    const response = await signedAossFetch(
      'POST',
      endpoint,
      `/${indexName}/_search`,
      JSON.stringify(body),
      timeoutMs ?? 50_000,
    );

    if (response.status < 200 || response.status >= 300) {
      const error = new Error(
        `AOSS search failed: ${response.status} ${response.body.slice(0, 300)}`,
      );
      (error as any).statusCode = response.status;
      throw error;
    }

    return JSON.parse(response.body);
  },
};
