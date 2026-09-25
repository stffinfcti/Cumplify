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
import { Logger } from '@aws-lambda-powertools/logger';
import { publish } from '../../../eventing/src/publisher.js';

const rdsClient = new RDSDataClient({});
const stsClient = new STSClient({});

const CLUSTER_ARN = process.env.CLUSTER_ARN!;
const APP_ROLE_SECRET_ARN = process.env.APP_ROLE_SECRET_ARN!;
const TABLE_NAME = process.env.TABLE_NAME!;
const BUS_NAME = process.env.BUS_NAME!;
const TENANT_DATA_ROLE_ARN = process.env.TENANT_DATA_ROLE_ARN!;

// ─── Tenant-scoped DDB credential cache (per warm container) ─────────────────
interface CachedCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: number; // epoch ms
}

const credentialCache = new Map<string, CachedCredentials>();
// Bound per warm container — tenant space is unbounded and stale entries
// were never pruned. On overflow, drop expired entries first, then oldest.
const CREDENTIAL_CACHE_MAX = 500;

function pruneCredentialCache(now: number): void {
  for (const [key, creds] of credentialCache) {
    if (creds.expiration - now <= 120_000) credentialCache.delete(key);
  }
  if (credentialCache.size <= CREDENTIAL_CACHE_MAX) return;
  // Insertion-ordered: evict oldest until within cap.
  const overflow = credentialCache.size - CREDENTIAL_CACHE_MAX;
  let removed = 0;
  for (const key of credentialCache.keys()) {
    if (removed++ >= overflow) break;
    credentialCache.delete(key);
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
    return new DynamoDBClient({
      credentials: {
        accessKeyId: cached.accessKeyId,
        secretAccessKey: cached.secretAccessKey,
        sessionToken: cached.sessionToken,
      },
    });
  }

  const assumed = await stsClient.send(
    new AssumeRoleCommand({
      RoleArn: TENANT_DATA_ROLE_ARN,
      RoleSessionName: `resolver-${tenantId.substring(0, 8)}-${now}`,
      Tags: [{ Key: 'tenantId', Value: tenantId }], // BARE tenantId (FF-3)
      DurationSeconds: 900,
    }),
  );

  const creds: CachedCredentials = {
    accessKeyId: assumed.Credentials!.AccessKeyId!,
    secretAccessKey: assumed.Credentials!.SecretAccessKey!,
    sessionToken: assumed.Credentials!.SessionToken!,
    expiration: assumed.Credentials!.Expiration!.getTime(),
  };

  pruneCredentialCache(now);
  credentialCache.set(tenantId, creds);

  return new DynamoDBClient({
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });
}

// ─── Aurora resume-retry (BUG-C) ─────────────────────────────────────────────
// First call after 0-ACU auto-pause throws DatabaseResumingException.
// Retry a few times with 15s waits (mirrors migrator's withResumeRetry).

const MAX_RESUME_RETRIES = 3;
const RESUME_DELAY_MS = 15_000;

async function withResumeRetry<T>(fn: () => Promise<T>): Promise<T> {
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
 */
export function extractAgentContext(
  args: Record<string, unknown>,
  agentName: string,
): { tenantId: string; actor: string } {
  const tenantId = (args.tenantId ?? (args.input as Record<string, unknown> | undefined)?.tenantId) as
    | string
    | undefined;
  if (!tenantId) {
    throw new Error('Missing tenantId — required on every agent* mutation input (RS-7)');
  }
  assertTenantIdSafe(tenantId);
  return { tenantId, actor: `agent:${agentName}` };
}

/**
 * tenantId charset/length check — defense in depth under the api-stack IAM
 * deny on `*`,`?`,`#` in the tenantId session tag: reject wildcard/tag-meta
 * characters at the resolver boundary so they can never reach AssumeRole.
 */
const TENANT_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
function assertTenantIdSafe(tenantId: string): void {
  if (!TENANT_ID_RE.test(tenantId)) {
    throw new Error('Invalid tenantId format — authorization failed');
  }
}

export { TABLE_NAME, BUS_NAME, CLUSTER_ARN, Logger };

// ─── Data API Response Marshalling (BUG-A fix) ───────────────────────────────
import {
  RISK_CATEGORY_MAP,
  DOC_TYPE_MAP,
  DOC_STATUS_MAP,
  APPROVAL_DECISION_MAP,
  NC_SOURCE_MAP,
  NC_TYPE_MAP,
  SEVERITY_MAP,
  DISPOSITION_MAP,
  FINDING_TYPE_MAP,
  CAPA_STATUS_MAP,
  GENERATION_RUN_STATUS_MAP,
  SECTION_KIND_MAP,
} from './enum-mappings.js';

/** Reverse maps: DB lowercase → GraphQL UPPERCASE */
function invertMap(map: Record<string, string>): Record<string, string> {
  const inv: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    inv[v] = k;
  }
  return inv;
}

const REVERSE_ENUMS: Record<string, Record<string, string>> = {
  category: invertMap(RISK_CATEGORY_MAP),
  doc_type: invertMap(DOC_TYPE_MAP),
  // Overloaded `status` column: doc values (draft/in_review/approved/obsolete),
  // CAPA values (open/in_progress/closed/verified), qms run values
  // (running/complete/failed/partial), and section-kind values
  // (pending/prose/gap/na_justified/failed) are pairwise disjoint except
  // 'failed', which maps to FAILED in both qms maps — so one merged reverse
  // map serves DocumentStatus!, CAPAStatus!, GenerationRunStatus!, and
  // `status AS kind` aliases regardless of whether Data API reports the
  // alias or the underlying column name.
  // FIXED 2026-07-14 (architect): CAPA values previously passed through
  // lowercase → invalid enum serialization on every M2 NC/CA read.
  // FIXED 2026-07-15 (architect): same class, qms values — GenerationRun/
  // GenerationSection reads would have failed enum serialization on deploy.
  status: {
    ...invertMap(DOC_STATUS_MAP),
    ...invertMap(CAPA_STATUS_MAP),
    ...invertMap(GENERATION_RUN_STATUS_MAP),
    ...invertMap(SECTION_KIND_MAP),
  },
  kind: invertMap(SECTION_KIND_MAP),
  decision: invertMap(APPROVAL_DECISION_MAP),
  source: invertMap(NC_SOURCE_MAP),
  nc_type: invertMap(NC_TYPE_MAP),
  severity: invertMap(SEVERITY_MAP),
  disposition: invertMap(DISPOSITION_MAP),
  finding_type: invertMap(FINDING_TYPE_MAP),
};

/** snake_case → camelCase */
export function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * RDS Data API returns TIMESTAMP/TIMESTAMPTZ as `YYYY-MM-DD HH:MM:SS[.ffffff]`
 * (UTC, no zone designator) — AppSync AWSDateTime rejects that shape AFTER
 * the resolver succeeds (AUD-1/BUG-18: 33 fields, every populated register).
 * Strict full-string match converts to ISO-8601 UTC; anything else passes
 * through untouched (AWSDate `YYYY-MM-DD` is already valid and unaffected).
 */
const SQL_TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/;

export function sqlTimestampToIso(value: string): string {
  const m = SQL_TIMESTAMP_RE.exec(value);
  if (!m) return value;
  const ms = (m[3] ?? '').padEnd(3, '0').slice(0, 3);
  return `${m[1]}T${m[2]}.${ms}Z`;
}

/**
 * Data API wraps array columns as {stringValues|longValues|doubleValues|
 * booleanValues|arrayValues} — unwrap to a plain array (recursive for
 * nested arrays) or GraphQL list/AWSJSON fields serialize the wrapper.
 */
function unwrapArray(av: Record<string, unknown>): unknown[] {
  if (Array.isArray(av.arrayValues)) {
    return (av.arrayValues as Record<string, unknown>[]).map(unwrapArray);
  }
  return (av.stringValues ??
    av.longValues ??
    av.doubleValues ??
    av.booleanValues ??
    []) as unknown[];
}

/** Unwrap a Data API field value */
export function unwrapField(field: Record<string, unknown>): unknown {
  if (field.stringValue !== undefined)
    return typeof field.stringValue === 'string'
      ? sqlTimestampToIso(field.stringValue)
      : field.stringValue;
  if (field.longValue !== undefined) return field.longValue;
  if (field.doubleValue !== undefined) return field.doubleValue;
  if (field.booleanValue !== undefined) return field.booleanValue;
  if (field.isNull) return null;
  if (field.arrayValue !== undefined)
    return unwrapArray(field.arrayValue as Record<string, unknown>);
  // Blob or other — return as-is
  return Object.values(field)[0] ?? null;
}

export interface DataApiResult {
  records?: Array<Array<Record<string, unknown>>>;
  columnMetadata?: Array<{ name?: string; label?: string }>;
  numberOfRecordsUpdated?: number;
}

/**
 * Marshal a Data API response into a plain object (or array of objects)
 * with camelCase keys and GraphQL enum casing.
 */
export function marshalRow(
  row: Array<Record<string, unknown>>,
  columns: Array<{ name?: string; label?: string }>,
): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < columns.length; i++) {
    const colName = columns[i].name ?? columns[i].label ?? `col${i}`;
    let value = unwrapField(row[i]);

    // Reverse-map enum columns: DB lowercase → GraphQL UPPERCASE
    if (typeof value === 'string' && REVERSE_ENUMS[colName]?.[value]) {
      value = REVERSE_ENUMS[colName][value];
    }

    obj[snakeToCamel(colName)] = value;
  }
  return obj;
}

/**
 * Marshal a full Data API result into an array of objects.
 * For mutations (RETURNING), typically returns one row.
 */
export function marshalResult(result: DataApiResult): Record<string, unknown>[] {
  if (!result.records || !result.columnMetadata) return [];
  return result.records.map((row) => marshalRow(row, result.columnMetadata!));
}

/**
 * Marshal and return a single object (for create/get mutations) or null.
 */
export function marshalOne(result: DataApiResult): Record<string, unknown> | null {
  const rows = marshalResult(result);
  return rows[0] ?? null;
}

/**
 * Marshal and return an array (for list queries).
 */
export function marshalMany(result: DataApiResult): Record<string, unknown>[] {
  return marshalResult(result);
}

/**
 * Prepare a jsonb-derived value for an AWSJSON response field.
 *
 * AppSync serializes the resolver's return value into the AWSJSON slot
 * exactly once: return the parsed object/array and the client receives
 * parsed JSON; return the Data-API jsonb STRING and the client receives a
 * double-encoded string (found live 2026-07-22 — getDocumentContent,
 * OrgProfile.payload, GenerationSection.clauseRefs all arrived
 * double-encoded while array-returning clauseRefs arrived correctly).
 */
export function jsonOut(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}
