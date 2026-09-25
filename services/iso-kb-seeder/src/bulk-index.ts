/**
 * Embed + bulk-index orchestration for the ISO KB seeder.
 * Embeds all chunks via the one-door {op:'embed'} transport (systemOp: true),
 * then indexes them to AOSS with SigV4-signed requests.
 *
 * FIX-P12-2: All AOSS ops wrapped with per-operation retry (design §5).
 * - deleteIndexIfExists: 404 = absent (success), retries 403/429/5xx
 * - createIndex: retries 403/404/429/5xx (write path)
 * - chunk PUT: retries 403/404/429/5xx (write path — 404 = activation delay)
 */

import { Logger } from '@aws-lambda-powertools/logger';
import { ISO_CANON_TENANT_ID } from '../../agents/shared/constants.js';
import { aossWriteOp, aossDeleteOp } from './aoss-retry.js';
import type { Chunk } from './chunker.js';
import type { EmbedFn } from '../../agents/shared/invoke-transport.js';

const logger = new Logger({ serviceName: 'iso-kb-seeder-bulk' });

/**
 * Embed all chunks via the one-door with systemOp: true.
 * Returns embeddings in the same order as input chunks.
 */
export async function embedAllChunks(chunks: Chunk[], embedFn: EmbedFn): Promise<number[][]> {
  const embeddings: number[][] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const result = await embedFn({
      tenantId: ISO_CANON_TENANT_ID,
      agent: 'iso-kb-seeder',
      module: 'system',
      feature: 'seed',
      text: chunk.text,
      systemOp: true,
    });
    embeddings.push(result.embedding);

    if ((i + 1) % 20 === 0) {
      logger.info('Embedding progress', { done: i + 1, total: chunks.length });
    }
  }

  logger.info('All chunks embedded', { total: chunks.length });
  return embeddings;
}

/**
 * Bulk-index all chunks with their embeddings to AOSS.
 * FIX-P12-4: POST /_doc (auto-ID) — AOSS vector collections reject client-supplied IDs.
 * Uses write-path retry per chunk (403/404/429/5xx retryable).
 */
export async function bulkIndex(
  chunks: Chunk[],
  embeddings: number[][],
  endpoint: string,
  indexName: string,
): Promise<number> {
  let indexed = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const doc = {
      text: chunk.text,
      embedding: embeddings[i],
      metadata: chunk.metadata,
    };

    const resp = await aossWriteOp(
      `indexChunk:${i}:${chunk.metadata.clauseRef}`,
      'POST',
      endpoint,
      `/${indexName}/_doc`,
      JSON.stringify(doc),
    );

    if (resp.status !== 200 && resp.status !== 201) {
      throw new Error(
        `Failed to index chunk ${i} (${chunk.metadata.clauseRef}): HTTP ${resp.status} — ${resp.body}`,
      );
    }

    indexed++;
  }

  logger.info('Bulk indexing complete', { indexed });
  return indexed;
}

/**
 * Delete the existing index if it exists (SEED-2c: full-replace).
 * 404 = index already absent (success, not retried per read/delete semantics).
 * Retries 403/429/5xx.
 */
export async function deleteIndexIfExists(endpoint: string, indexName: string): Promise<boolean> {
  const resp = await aossDeleteOp('deleteIndex', endpoint, `/${indexName}`);
  if (resp.status === 200) {
    logger.info('Existing index deleted', { indexName });
    return true;
  }
  if (resp.status === 404) {
    logger.info('Index does not exist (first seed)', { indexName });
    return false;
  }
  throw new Error(`Unexpected response deleting index: HTTP ${resp.status} — ${resp.body}`);
}

/**
 * Create a fresh index (uses the applied template for mappings).
 * Write-path retry: 403/404/429/5xx retryable.
 */
export async function createIndex(endpoint: string, indexName: string): Promise<void> {
  const resp = await aossWriteOp(
    'createIndex',
    'PUT',
    endpoint,
    `/${indexName}`,
    JSON.stringify({}),
  );
  if (resp.status !== 200) {
    throw new Error(`Failed to create index: HTTP ${resp.status} — ${resp.body}`);
  }
  logger.info('Index created', { indexName });
}
