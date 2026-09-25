/**
 * M1 Document Studio — shared constants, clients, types, and content-plane
 * helpers extracted from m1.ts.
 */

import { Logger } from '@aws-lambda-powertools/logger';
import { z } from 'zod';
import { JsonValueSchema } from '../shared.js';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { LambdaClient } from '@aws-sdk/client-lambda';

export const logger = new Logger({ serviceName: 'resolver-m1' });

// M-effort: server-side bound on list queries (mirror forms' LIST_MAX_LIMIT) —
// an unbounded SELECT * turns a big register into a resolver timeout/payload blowup.

// Boundary shape for SaveDocumentSectionEditInput.trackedChanges (AWSJSON):
// an array of ChangeEntry objects, stored verbatim (M-effort, item 8).
export const TrackedChangesSchema = z.array(z.record(z.string(), JsonValueSchema));

export const s3 = new S3Client({});
export const lambdaClient = new LambdaClient({});
export const DOC_STUDIO_FN_ARN = process.env.DOC_STUDIO_FN_ARN ?? '';

// Rendering/sealing env + the canonical event type live in shared.ts —
// re-export so existing `from './common.js'` import sites keep working
// (import brings CONTENT_BUCKET into this file's own scope too).
import {
  CONTENT_BUCKET,
  EVIDENCE_BUCKET,
  EVIDENCE_LOCK_MODE,
  PDF_RENDER_FN,
  DEFAULT_RETENTION_YEARS,
  LIST_QUERY_LIMIT,
  type AppSyncEvent,
} from '../shared.js';
export {
  CONTENT_BUCKET,
  EVIDENCE_BUCKET,
  EVIDENCE_LOCK_MODE,
  PDF_RENDER_FN,
  DEFAULT_RETENTION_YEARS,
  LIST_QUERY_LIMIT,
  type AppSyncEvent,
};

export function versionContentKey(tenantId: string, documentId: string, versionNo: number): string {
  return `tenants/${tenantId}/documents/${documentId}/v${versionNo}.json`;
}

export interface Sentence {
  text: string;
  factRefs?: string[];
}

export interface ContentSection {
  harmonizationKey: string;
  kind?: string; // prose, gap, na_justified, etc.
  sentences?: Sentence[];
  gap?: string;
  naJustification?: string;
  [key: string]: unknown;
}

export interface ContentJson {
  sections: ContentSection[];
  [key: string]: unknown;
}

// ─── S3 content loading ──────────────────────────────────────────────────────

export async function loadContentJson(key: string): Promise<ContentJson> {
  if (!CONTENT_BUCKET) throw new Error('CONTENT_UNAVAILABLE');
  try {
    const resp = await s3.send(new GetObjectCommand({ Bucket: CONTENT_BUCKET, Key: key }));
    const body = await resp.Body?.transformToString('utf-8');
    if (!body) throw new Error('CONTENT_UNAVAILABLE');
    return JSON.parse(body);
  } catch (err) {
    if ((err as Error).message === 'CONTENT_UNAVAILABLE') throw err;
    logger.warn('Failed to load content from S3', { key, error: (err as Error).message });
    throw new Error('CONTENT_UNAVAILABLE');
  }
}
