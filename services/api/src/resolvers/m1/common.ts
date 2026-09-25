/**
 * M1 Document Studio — shared constants, clients, types, and content-plane
 * helpers extracted from m1.ts (god-file decomposition, mechanical only —
 * no semantic changes).
 */

import { Logger } from '@aws-lambda-powertools/logger';
import { z } from 'zod';
import { JsonValueSchema } from '../shared.js';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { LambdaClient } from '@aws-sdk/client-lambda';

export const logger = new Logger({ serviceName: 'resolver-m1' });

// M-effort: server-side bound on list queries (mirror forms' LIST_MAX_LIMIT) —
// an unbounded SELECT * turns a big register into a resolver timeout/payload blowup.
export const LIST_QUERY_LIMIT = 500;

// Boundary shape for SaveDocumentSectionEditInput.trackedChanges (AWSJSON):
// an array of ChangeEntry objects, stored verbatim (M-effort, item 8).
export const TrackedChangesSchema = z.array(z.record(z.string(), JsonValueSchema));

export const s3 = new S3Client({});
export const lambdaClient = new LambdaClient({});
export const CONTENT_BUCKET = process.env.CONTENT_BUCKET ?? '';
// Task 9 sealing (STO-5). Lock mode is env-parameterized like the bucket
// default (GOVERNANCE dev / COMPLIANCE prod) — BC-10.
export const EVIDENCE_BUCKET = process.env.EVIDENCE_BUCKET ?? '';
export const EVIDENCE_LOCK_MODE = process.env.EVIDENCE_LOCK_MODE ?? 'GOVERNANCE';
export const PDF_RENDER_FN = process.env.PDF_RENDER_FN ?? '';
export const DEFAULT_RETENTION_YEARS = 7;
export const DOC_STUDIO_FN_ARN = process.env.DOC_STUDIO_FN_ARN ?? '';

export interface AppSyncEvent {
  info: { fieldName: string };
  arguments: Record<string, unknown>;
  identity?: {
    resolverContext?: Record<string, string>;
    userArn?: string;
    username?: string;
  };
}

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
