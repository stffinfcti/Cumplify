/**
 * AOSS retry wrapper for the ISO KB seeder — design §5 (02-aoss-rule compliance).
 * Mirrors the proven aoss-apply-template.ts pattern with per-operation retryable sets.
 *
 * Indexing path (createIndex, chunk PUT, writeMetaDoc): retries 403/404/429/5xx
 *   - 403: data-access policy still propagating
 *   - 404: index activation delay (newly created index not yet addressable)
 *   - 429: throttling
 *   - 5xx: transient server errors
 *
 * Read/delete path (readMetaHash, deleteIndexIfExists): treats 404 as SUCCESS (absent),
 *   never retries it. Retries 403/429/5xx only.
 */

import { Logger } from '@aws-lambda-powertools/logger';
import { signedAossFetch } from '../../agents/shared/aoss-signed-client.js';
import type { AossHttpMethod } from '../../agents/shared/aoss-signed-client.js';

const logger = new Logger({ serviceName: 'iso-kb-seeder-retry' });

const BACKOFF_BASE_MS = 500;
const BACKOFF_FACTOR = 2;
const BACKOFF_CEILING_MS = 45_000;
const MAX_ATTEMPTS = 12;
const JITTER_RATIO = 0.2;

/** Retryable status codes for the WRITE path (post-createIndex) */
function isWriteRetryable(status: number): boolean {
  return status === 403 || status === 404 || status === 429 || status >= 500;
}

/** Retryable status codes for the READ/DELETE path (404 = absent, not retryable) */
function isReadRetryable(status: number): boolean {
  return status === 403 || status === 429 || status >= 500;
}

export interface RetryResult {
  status: number;
  body: string;
}

/**
 * Execute an AOSS operation with exponential-backoff retry.
 * @param label - Operation label for logging
 * @param method - HTTP method
 * @param endpoint - AOSS collection endpoint
 * @param path - Request path
 * @param body - Optional request body
 * @param okStatuses - Statuses that count as success (no retry)
 * @param isRetryable - Per-operation retryable predicate
 */
export async function withRetry(
  label: string,
  method: AossHttpMethod,
  endpoint: string,
  path: string,
  body: string | undefined,
  okStatuses: number[],
  isRetryable: (status: number) => boolean,
): Promise<RetryResult> {
  let last: RetryResult | undefined;
  let attempts = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    attempts = attempt;
    try {
      last = await signedAossFetch(method, endpoint, path, body);
      if (okStatuses.includes(last.status)) return last;
      if (!isRetryable(last.status)) break;
      logger.warn('Retryable AOSS response', { label, attempt, status: last.status });
    } catch (err) {
      logger.warn('AOSS request error, retrying', {
        label,
        attempt,
        error: (err as Error).message,
      });
      last = { status: 0, body: (err as Error).message };
    }

    if (attempt < MAX_ATTEMPTS) {
      const elapsed = attempt - 1;
      const delay = Math.min(
        BACKOFF_BASE_MS * Math.pow(BACKOFF_FACTOR, elapsed),
        BACKOFF_CEILING_MS,
      );
      const jitter = Math.random() * delay * JITTER_RATIO;
      await new Promise((r) => setTimeout(r, delay + jitter));
    }
  }

  throw new Error(
    `${label} FAILED after ${attempts} attempts: HTTP ${last?.status} — ${last?.body?.slice(0, 500)}`,
  );
}

// ─── Convenience wrappers with correct retryable sets ─────────────────────

/**
 * AOSS operation on the WRITE path (createIndex, chunk PUT, writeMetaDoc).
 * Retries 403 (policy propagation), 404 (index activation), 429, 5xx.
 */
export async function aossWriteOp(
  label: string,
  method: AossHttpMethod,
  endpoint: string,
  path: string,
  body?: string,
): Promise<RetryResult> {
  return withRetry(label, method, endpoint, path, body, [200, 201], isWriteRetryable);
}

/**
 * AOSS read operation (readMetaHash _search).
 * 404 = absent (returns immediately as result, not retried).
 * Retries 403/429/5xx only.
 */
export async function aossReadOp(
  label: string,
  method: AossHttpMethod,
  endpoint: string,
  path: string,
  body?: string,
): Promise<RetryResult> {
  return withRetry(label, method, endpoint, path, body, [200, 404], isReadRetryable);
}

/**
 * AOSS delete operation (deleteIndexIfExists).
 * 404 = index already absent (success). 200 = deleted.
 * Retries 403/429/5xx only.
 */
export async function aossDeleteOp(
  label: string,
  endpoint: string,
  path: string,
): Promise<RetryResult> {
  return withRetry(label, 'DELETE', endpoint, path, undefined, [200, 404], isReadRetryable);
}
