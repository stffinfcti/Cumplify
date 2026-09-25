/**
 * Shared resolver utilities — Data API + STS tenant context.
 *
 * TWO isolation paths (never conflated):
 *   1. RDS (system-of-record): Data API with app_role, transaction-local set_config.
 *   2. DynamoDB (metadata): Assumed tenant-data role with bare tenantId session tag.
 *
 * C-2 INVARIANT (review-blocking): set_config('app.tenant_id', :tenantId, true)
 * MUST be the FIRST statement in every BeginTransaction. Never `false`. Never a
 * bare ExecuteStatement for tenant-scoped data.
 *
 * SCHEMA-5: tenantId comes ONLY from resolverContext. Client-supplied tenantId
 * in mutation input is overwritten/rejected.
 */

import {
  RDSDataClient,
  BeginTransactionCommand,
  CommitTransactionCommand,
  RollbackTransactionCommand,
  ExecuteStatementCommand,
  type SqlParameter,
} from '@aws-sdk/client-rds-data';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { createHash } from 'node:crypto';
import { Logger } from '@aws-lambda-powertools/logger';
import { publish } from '../../../eventing/src/publisher.js';
import { canApprove } from '../permissions/role-matrix.js';
import type { DataApiResult } from './marshal.js';

const rdsClient = new RDSDataClient({});
const stsClient = new STSClient({});

const CLUSTER_ARN = process.env.CLUSTER_ARN!;
const APP_ROLE_SECRET_ARN = process.env.APP_ROLE_SECRET_ARN!;
const TABLE_NAME = process.env.TABLE_NAME!;
const BUS_NAME = process.env.BUS_NAME!;
const TENANT_DATA_ROLE_ARN = process.env.TENANT_DATA_ROLE_ARN!;

// ─── Rendering/sealing env (single source — m1/common and forms/common
// previously carried byte-identical copies; both re-export these) ────────────
export const CONTENT_BUCKET = process.env.CONTENT_BUCKET ?? '';
export const EVIDENCE_BUCKET = process.env.EVIDENCE_BUCKET ?? '';
export const EVIDENCE_LOCK_MODE = process.env.EVIDENCE_LOCK_MODE ?? 'GOVERNANCE';
export const PDF_RENDER_FN = process.env.PDF_RENDER_FN ?? '';
export const DEFAULT_RETENTION_YEARS = 7;

// Hard ceiling for unbounded list reads — single source; resolvers
// interpolate it into their SQL (Data API has no LIMIT bind parameter).
export const LIST_QUERY_LIMIT = 500;

/** Canonical AppSync Lambda-resolver event — one definition for the whole API. */
export interface AppSyncEvent {
  info: { fieldName: string };
  arguments: Record<string, unknown>;
  identity?: {
    resolverContext?: Record<string, string>;
    userArn?: string;
    username?: string;
  };
}

// ─── Tenant-scoped DDB credential cache (per warm container) ─────────────────
interface CachedCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: number; // epoch ms
  /** Client riding these credentials — cache-hit reuses it instead of
   * minting a new DynamoDBClient (and its connection pool) per call. */
  client: DynamoDBClient;
}

const credentialCache = new Map<string, CachedCredentials>();
// Bound per warm container — tenant space is unbounded and stale entries
// were never pruned. On overflow, drop expired entries first, then oldest.
const CREDENTIAL_CACHE_MAX = 500;

function pruneCredentialCache(now: number): void {
  const evict = (key: string) => {
    credentialCache.get(key)?.client.destroy();
    credentialCache.delete(key);
  };
  for (const [key, creds] of credentialCache) {
    if (creds.expiration - now <= 120_000) evict(key);
  }
  if (credentialCache.size <= CREDENTIAL_CACHE_MAX) return;
  // Insertion-ordered: evict oldest until within cap.
  const overflow = credentialCache.size - CREDENTIAL_CACHE_MAX;
  let removed = 0;
  for (const key of credentialCache.keys()) {
    if (removed++ >= overflow) break;
    evict(key);
  }
}

/**
 * Assume the tenant-data role with a bare tenantId session tag.
 * Returns a DynamoDB client scoped to the tenant's partition.
 * Caches credentials per tenantId for up to 10 minutes.
 */
export async function getTenantDdbClient(tenantId: string): Promise<DynamoDBClient> {
  const cached = credentialCache.get(tenantId);
  const now = Date.now();

  // Reuse if >2 min remaining (buffer for clock drift)
  if (cached && cached.expiration - now > 120_000) {
    return cached.client;
  }

  const assumed = await stsClient.send(
    new AssumeRoleCommand({
      RoleArn: TENANT_DATA_ROLE_ARN,
      RoleSessionName: `resolver-${tenantIdHash(tenantId)}-${now}`,
      Tags: [{ Key: 'tenantId', Value: tenantId }], // BARE tenantId (FF-3)
      DurationSeconds: 900,
    }),
  );

  const client = new DynamoDBClient({
    credentials: {
      accessKeyId: assumed.Credentials!.AccessKeyId!,
      secretAccessKey: assumed.Credentials!.SecretAccessKey!,
      sessionToken: assumed.Credentials!.SessionToken!,
    },
  });
  const creds: CachedCredentials = {
    accessKeyId: assumed.Credentials!.AccessKeyId!,
    secretAccessKey: assumed.Credentials!.SecretAccessKey!,
    sessionToken: assumed.Credentials!.SessionToken!,
    expiration: assumed.Credentials!.Expiration!.getTime(),
    client,
  };

  pruneCredentialCache(now);
  credentialCache.set(tenantId, creds);

  return client;
}

// ─── Aurora resume-retry (BUG-C) ─────────────────────────────────────────────
// First call after 0-ACU auto-pause throws DatabaseResumingException.
// Retry a few times with 15s waits. Shared by resolvers AND agent writeback
// (execute-writeback imports this — its callers pass the Lambda context's
// remaining-time budget so a resume cycle can't burn into a hard timeout).

const MAX_RESUME_RETRIES = 3;
const RESUME_DELAY_MS = 15_000;
// Minimum remaining execution time needed to attempt one more resume cycle
// (one request + one delay + margin for rollback/commit).
const MIN_REMAINING_MS = 30_000;

const logger = new Logger({ serviceName: 'resolver-shared' });

export async function withResumeRetry<T>(
  fn: () => Promise<T>,
  getRemainingTimeInMillis?: () => number,
): Promise<T> {
  for (let attempt = 0; attempt <= MAX_RESUME_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const msg = (err as Error).message ?? '';
      const name = (err as { name?: string }).name ?? '';
      const isDatabaseResuming =
        msg.includes('Communications link failure') ||
        msg.includes('DatabaseResumingException') ||
        name === 'DatabaseResumingException' ||
        msg.includes('Timed out');

      if (isDatabaseResuming && attempt < MAX_RESUME_RETRIES) {
        // Stop retrying when the Lambda lacks the time budget to finish — a
        // mid-retry hard timeout leaves the txn state worse than a fast fail.
        const remaining = getRemainingTimeInMillis?.();
        if (remaining !== undefined && remaining < MIN_REMAINING_MS) {
          logger.warn('Aurora resuming but insufficient remaining time — failing fast', {
            attempt,
            remainingMs: remaining,
          });
          throw err;
        }
        logger.warn('Aurora resuming from auto-pause — retrying', { attempt });
        await new Promise((resolve) => setTimeout(resolve, RESUME_DELAY_MS));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Unreachable');
}

// ─── RDS Data API tenant-scoped transaction ──────────────────────────────────

export interface TenantTransaction {
  transactionId: string;
  execute: (sql: string, parameters?: SqlParameter[]) => Promise<DataApiResult>;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
}

/**
 * Begin a tenant-scoped RDS transaction.
 * C-2 INVARIANT: set_config is the FIRST statement, transaction-local (true).
 * Uses app_role secret (NEVER master) for Data API.
 */
export async function beginTenantTransaction(tenantId: string): Promise<TenantTransaction> {
  const { transactionId } = await withResumeRetry(() =>
    rdsClient.send(
      new BeginTransactionCommand({
        resourceArn: CLUSTER_ARN,
        secretArn: APP_ROLE_SECRET_ARN,
        database: 'postgres',
      }),
    ),
  );

  // C-2 INVARIANT: set_config is the FIRST statement in every transaction.
  // Third arg = true → transaction-local. Connection reuse is safe.
  await rdsClient.send(
    new ExecuteStatementCommand({
      resourceArn: CLUSTER_ARN,
      secretArn: APP_ROLE_SECRET_ARN,
      database: 'postgres',
      transactionId: transactionId!,
      sql: `SELECT set_config('app.tenant_id', :tenantId, true)`,
      parameters: [{ name: 'tenantId', value: { stringValue: tenantId } }],
    }),
  );

  const execute = async (sql: string, parameters?: SqlParameter[]): Promise<DataApiResult> => {
    const result = await rdsClient.send(
      new ExecuteStatementCommand({
        resourceArn: CLUSTER_ARN,
        secretArn: APP_ROLE_SECRET_ARN,
        database: 'postgres',
        transactionId: transactionId!,
        sql,
        parameters,
        includeResultMetadata: true, // Required for columnMetadata in response
      }),
    );
    return result as DataApiResult;
  };

  const commit = async () => {
    await rdsClient.send(
      new CommitTransactionCommand({
        resourceArn: CLUSTER_ARN,
        secretArn: APP_ROLE_SECRET_ARN,
        transactionId: transactionId!,
      }),
    );
  };

  const rollback = async () => {
    await rdsClient.send(
      new RollbackTransactionCommand({
        resourceArn: CLUSTER_ARN,
        secretArn: APP_ROLE_SECRET_ARN,
        transactionId: transactionId!,
      }),
    );
  };

  return { transactionId: transactionId!, execute, commit, rollback };
}

/** Rollback for catch paths — a failed rollback (e.g. the error came after
 * commit) must never mask the error that triggered it. */
export async function rollbackQuietly(txn: { rollback: () => Promise<void> }): Promise<void> {
  try {
    await txn.rollback();
  } catch {
    /* never mask the triggering error */
  }
}

// ─── Event publishing helper ─────────────────────────────────────────────────

export interface PublishAuditEventOptions {
  tenantId: string;
  actor: string;
  module: string;
  clauseRef: string;
  standard: 'ISO9001' | 'ISO14001' | 'ISO45001' | 'IMS';
  detailType: string;
  source: string;
  /**
   * Normalized id of the domain row this event is about — the id of the row
   * the mutation returns (marshalOne(result).id); blocked/negative events
   * carry the id of the row the attempt targeted. REQUIRED so every call
   * site declares it (compiler-enforced). Pass '' only when the event has no
   * domain row — no GSI stamping, getAuditTrail falls back to partition scan.
   */
  entityId: string;
  payload: Record<string, unknown>;
  /** Envelope timestamp override — pass when the caller must return the exact sealed value. */
  timestamp?: string;
}

export async function publishAuditEvent(opts: PublishAuditEventOptions): Promise<string> {
  return publish({
    busName: BUS_NAME,
    source: opts.source,
    detailType: opts.detailType,
    event: {
      tenantId: opts.tenantId,
      timestamp: opts.timestamp ?? new Date().toISOString(),
      actor: opts.actor,
      module: opts.module,
      clauseRef: opts.clauseRef,
      standard: opts.standard,
      entityId: opts.entityId,
      payload: opts.payload,
    },
  });
}

// ─── Resolver context extraction ─────────────────────────────────────────────

export interface ResolverContext {
  tenantId: string;
  role: string;
  poolClass: string;
  sub: string;
  entitlement: string;
}

/**
 * Extract and validate resolverContext from AppSync event.
 * SCHEMA-5: tenantId comes ONLY from resolverContext — never from input args.
 * Human-facing (@aws_lambda) mutations ONLY — see extractAgentContext for the
 * @aws_iam agent-path exception.
 */
export function extractContext(event: {
  identity?: { resolverContext?: Record<string, string> };
}): ResolverContext {
  const ctx = event.identity?.resolverContext;
  if (!ctx?.tenantId) {
    throw new Error('Missing resolverContext.tenantId — authorization failed');
  }
  assertTenantIdSafe(ctx.tenantId);
  return {
    tenantId: ctx.tenantId,
    role: ctx.role ?? 'Employee',
    poolClass: ctx.poolClass ?? 'tenant-user',
    sub: ctx.sub ?? 'unknown',
    entitlement: ctx.entitlement ?? '{}',
  };
}

/**
 * Extract tenant context for the six agent* (@aws_iam) mutations
 * (read-surface-completion RS-7). These fields carry ONLY @aws_iam auth —
 * AppSync's Lambda authorizer (the sole source of resolverContext) never
 * runs for IAM-signed calls, so tenantId cannot come from resolverContext
 * the way extractContext requires. Owner-approved exception (2026-07-22):
 * tenantId is an explicit, required argument on these six mutations only —
 * never extend this pattern to an @aws_lambda (human-facing) mutation.
 * actor is always 'agent:<agentName>' — there is no human sub on this path.
 *
 * Tenant binding (RS-7a): beyond assertTenantIdSafe, when the IAM principal's
 * assumed-role session name carries a tenant marker (see
 * iamSessionTenantHint), the input tenantId MUST match it — a mismatch is
 * rejected, never trusted. STS session tags are not exposed on the AppSync
 * IAM identity, so when no marker is derivable the check is absent
 * ("where available") and the tenant-scoped IAM role remains the binding.
 */
export function extractAgentContext(
  args: Record<string, unknown>,
  agentName: string,
  identity?: { userArn?: string; username?: string },
): { tenantId: string; actor: string } {
  const tenantId = (args.tenantId ??
    (args.input as Record<string, unknown> | undefined)?.tenantId) as string | undefined;
  if (!tenantId) {
    throw new Error('Missing tenantId — required on every agent* mutation input (RS-7)');
  }
  assertTenantIdSafe(tenantId);

  const hint = iamSessionTenantHint(identity);
  // `resolver-<hash16>-<epoch>` hints carry the stamp's 64-bit tenant hash:
  // compare hashes, not prefixes — a prefix test would accept a sibling
  // tenant sharing the first 8 chars (cross-tenant).
  if (hint && (hint.exact ? hint.value !== tenantId : hint.value !== tenantIdHash(tenantId))) {
    throw new Error(
      `FORBIDDEN: input.tenantId does not match the calling principal's tenant session tag`,
    );
  }
  return { tenantId, actor: `agent:${agentName}` };
}

/**
 * Derive the tenant marker embedded in an IAM principal's assumed-role
 * session name, when one exists. AppSync surfaces the IAM identity as
 * `userArn` = arn:aws:sts::<acct>:assumed-role/<roleName>/<sessionName> and
 * `username` = <roleId>:<sessionName>. Tenant-scoped callers stamp the
 * tenant into the session name by convention:
 *   - `tenant-<tenantId>`          → full tenantId
 *   - `resolver-<hash16>-<epoch>`  → tenant-data resolver sessions
 *     (getTenantDdbClient's RoleSessionName), first 16 hex chars of
 *     sha256(tenantId)
 * Any other session name yields no hint — the caller is not tenant-bound
 * by name and the input charset check stands alone.
 */
/** Deterministic 64-bit tenant marker for session names — RoleSessionName
 * caps at 64 chars, so a full tenantId + prefix + epoch doesn't fit; a
 * truncated first-8 stamp collides across tenants sharing an 8-char prefix
 * (one tenant's session hint then validates a sibling tenant's input). */
function tenantIdHash(tenantId: string): string {
  return createHash('sha256').update(tenantId).digest('hex').slice(0, 16);
}

const SESSION_TENANT_PATTERNS: RegExp[] = [
  /^tenant-([A-Za-z0-9-]{1,64})$/,
  /^resolver-([0-9a-f]{16})-\d+$/,
];

export function iamSessionTenantHint(identity?: {
  userArn?: string;
  username?: string;
}): { value: string; exact: boolean } | undefined {
  let sessionName: string | undefined;
  const userArn = identity?.userArn;
  if (userArn) {
    const m = /^arn:aws[a-z-]*:sts::\d+:assumed-role\/[^/]+\/(.+)$/.exec(userArn);
    sessionName = m?.[1];
  }
  if (!sessionName && identity?.username) {
    // Cognito IAM identity carries <roleId>:<sessionName> in username.
    const colon = identity.username.indexOf(':');
    if (colon > 0) sessionName = identity.username.slice(colon + 1);
  }
  if (!sessionName) return undefined;
  for (const re of SESSION_TENANT_PATTERNS) {
    const m = re.exec(sessionName);
    // `tenant-<fullId>` binds exactly; `resolver-<first8>-<epoch>` is a
    // prefix — either way, match the convention the name was stamped with.
    if (m?.[1]) return { value: m[1], exact: re === SESSION_TENANT_PATTERNS[0] };
  }
  return undefined;
}

/**
 * tenantId charset/length check — defense in depth under the api-stack IAM
 * deny on `*`,`?`,`#` in the tenantId session tag: reject wildcard/tag-meta
 * characters at the resolver boundary so they can never reach AssumeRole.
 */
const TENANT_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
/** Client-supplied page size floored at 1 and capped — an unbounded limit is
 * a response-size blowup and a negative one is a SQL error. Single idiom for
 * every list resolver. */
export function clampListLimit(limit: number | undefined, def: number, max: number): number {
  return Math.min(Math.max(1, limit ?? def), max);
}

export function assertTenantIdSafe(tenantId: string): void {
  if (!TENANT_ID_RE.test(tenantId)) {
    throw new Error('Invalid tenantId format — authorization failed');
  }
}

/** Canonical content-plane key for a document version — single writer for
 * the `tenants/<t>/documents/<doc>/v<n>.json` convention (previously
 * triplicated in m1/common, regenerate-section, finalize-manual). */
export function versionContentKey(tenantId: string, documentId: string, versionNo: number): string {
  return `tenants/${tenantId}/documents/${documentId}/v${versionNo}.json`;
}

/** The tenant's current org-profile version + parsed payload, or null when
 * none exists. Data API returns jsonb stringified — callers get it parsed
 * (the qms org-profile join duplicated in drafts/catalog/generation). */
export interface OrgProfileCurrent {
  currentVersion: number;
  payload: Record<string, unknown>;
}
export async function getCurrentOrgProfile(txn: {
  execute: (sql: string, params?: SqlParameter[]) => Promise<DataApiResult>;
}): Promise<OrgProfileCurrent | null> {
  const result = await txn.execute(
    `SELECT op.current_version, opv.payload
     FROM qms.org_profiles op
     JOIN qms.org_profile_versions opv
       ON opv.profile_id = op.id AND opv.version_no = op.current_version
     LIMIT 1`,
  );
  const rec = result.records?.[0];
  if (!rec) return null;
  return {
    currentVersion: Number((rec[0] as { longValue?: number }).longValue ?? 0),
    payload: JSON.parse((rec[1] as { stringValue?: string }).stringValue ?? '{}') as Record<
      string,
      unknown
    >,
  };
}

// ─── Module role gate (M-effort, Part 13 floor+matrix) ───────────────────────
/**
 * Server-side role gate for module write mutations — the same canApprove()
 * matrix hitl-approval.ts uses to approve HITL items. Apply at resolver entry:
 *   return requireModuleRole(ctx.role, 'M2', () => raiseNonconformity(...))
 * Unknown/missing role → UNAUTHORIZED (deny-by-default, mirroring
 * m4.getAuditTrail's AUDIT_TRAIL_ROLES fail-closed shape).
 */
export function requireModuleRole<T>(role: string, module: string, fn: () => T): T {
  if (!canApprove(role, module)) {
    throw new Error('UNAUTHORIZED');
  }
  return fn();
}

export { TABLE_NAME, BUS_NAME, CLUSTER_ARN, Logger };

// Marshalling helpers (snakeToCamel, marshalOne/Many/Result, unwrapField,
// jsonOut, DataApiResult, JsonValue(+Schema), parseAwsJson) live in marshal.ts —
// re-export so the ~15 importing files keep their './shared.js' specifiers.
export {
  snakeToCamel,
  sqlTimestampToIso,
  unwrapField,
  marshalRow,
  marshalResult,
  marshalOne,
  marshalMany,
  jsonOut,
  parseAwsJson,
  JsonValueSchema,
  type JsonValue,
  type DataApiResult,
} from './marshal.js';
export type { SqlParameter } from '@aws-sdk/client-rds-data';
