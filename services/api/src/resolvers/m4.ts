/**
 * M4 Records Management resolver.
 * RDS system-of-record via Data API (app_role).
 * C-2 INVARIANT: set_config FIRST in every transaction, transaction-local (true).
 * SCHEMA-5: tenantId from resolverContext only.
 */

import { Logger } from '@aws-lambda-powertools/logger';
import { GetItemCommand, PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import {
  extractContext,
  beginTenantTransaction,
  publishAuditEvent,
  requireModuleRole,
  marshalOne,
  marshalMany,
  getTenantDdbClient,
  TABLE_NAME,
  type ResolverContext,
} from './shared.js';
import { normalizeRole, KNOWN_ROLES } from '../permissions/role-matrix.js';
import {
  ARTIFACT_MODULES,
  GOVERNANCE_SK_PREFIX,
  MATRIX_ADMIN_ROLES,
  defaultStepsFor,
  governancePk,
  matrixSk,
  type ApprovalStep,
} from '../permissions/approval-matrix.js';

const logger = new Logger({ serviceName: 'resolver-m4' });

// M-effort: server-side bound on list queries (mirror forms' LIST_MAX_LIMIT).
const LIST_QUERY_LIMIT = 500;

// Audit ledger is a privileged read surface (approver subs, justifications,
// execution ARNs): admins + auditors only — plain Employees are gated out.
const AUDIT_TRAIL_ROLES = new Set(['InternalAuditor', 'ExternalAuditor']);

interface AppSyncEvent {
  info: { fieldName: string };
  arguments: Record<string, unknown>;
  identity?: { resolverContext?: Record<string, string> };
}

export async function handler(event: AppSyncEvent): Promise<unknown> {
  const ctx = extractContext(event);
  const { tenantId, sub, role } = ctx;
  logger.appendKeys({ tenantId, requestField: event.info.fieldName });

  // M-effort: M4 write mutations are role-gated at entry (Part 13 matrix);
  // queries stay at the authenticated floor.
  switch (event.info.fieldName) {
    case 'registerRecord':
      return requireModuleRole(role, 'M4', () => registerRecord(event, tenantId, sub));
    case 'registerMeasuringResource':
      return requireModuleRole(role, 'M4', () =>
        registerMeasuringResource(event, tenantId, sub),
      );
    case 'recordCalibration':
      return requireModuleRole(role, 'M4', () => recordCalibration(event, tenantId, sub));
    case 'createRetentionPolicy':
      return requireModuleRole(role, 'M4', () => createRetentionPolicy(event, tenantId, sub));
    case 'getRecord':
      return getRecord(event, tenantId);
    case 'listCalibrationsDue':
      return listCalibrationsDue(event, tenantId);
    case 'getAuditTrail':
      return getAuditTrail(event, tenantId, ctx);
    case 'listApprovalMatrix':
      return listApprovalMatrix(tenantId);
    case 'setApprovalMatrixEntry':
      return setApprovalMatrixEntry(event, tenantId, sub, ctx.role);
    default:
      throw new Error(`Unknown field: ${event.info.fieldName}`);
  }
}

// ─── Approval matrix (RS-6, governance items in DDB) ─────────────────────────

interface MatrixEntryOut {
  id: string;
  artifactType: string;
  standard: string | null;
  steps: ApprovalStep[];
  version: number;
  updatedBy: string | null;
  updatedAt: string | null;
}

function entryFromItem(item: Record<string, unknown>): MatrixEntryOut {
  const rawSteps = item.steps;
  const steps =
    typeof rawSteps === 'string' ? (JSON.parse(rawSteps) as ApprovalStep[]) : ([] as ApprovalStep[]);
  const standard = (item.standard as string) === 'ANY' ? null : ((item.standard as string) ?? null);
  return {
    id: item.SK as string,
    artifactType: item.artifactType as string,
    standard,
    steps,
    version: (item.version as number) ?? 1,
    updatedBy: (item.updatedBy as string) ?? null,
    updatedAt: (item.updatedAt as string) ?? null,
  };
}

async function listApprovalMatrix(tenantId: string): Promise<MatrixEntryOut[]> {
  const ddb = await getTenantDdbClient(tenantId);
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: marshall({
        ':pk': governancePk(tenantId),
        ':prefix': GOVERNANCE_SK_PREFIX,
      }),
    }),
  );
  const rows = (res.Items ?? []).map((i) => entryFromItem(unmarshall(i)));
  if (rows.length > 0) return rows;
  // No tenant config yet: return the Part-13 computed defaults (real
  // effective routing derived from the role matrix — never fabricated).
  return Object.keys(ARTIFACT_MODULES).map((artifactType) => ({
    id: `default#${artifactType}`,
    artifactType,
    standard: null,
    steps: defaultStepsFor(artifactType),
    version: 0,
    updatedBy: null,
    updatedAt: null,
  }));
}

async function setApprovalMatrixEntry(
  event: AppSyncEvent,
  tenantId: string,
  actor: string,
  role: string,
): Promise<MatrixEntryOut> {
  const roleSlug = normalizeRole(role);
  if (!MATRIX_ADMIN_ROLES.has(roleSlug)) {
    throw new Error(`FORBIDDEN: role '${role}' cannot edit the approval matrix`);
  }
  const input = event.arguments.input as {
    artifactType: string;
    standard?: string | null;
    steps: unknown;
  };
  if (!ARTIFACT_MODULES[input.artifactType]) {
    throw new Error(`VALIDATION: unknown artifactType '${input.artifactType}'`);
  }
  const steps = (
    typeof input.steps === 'string' ? JSON.parse(input.steps) : input.steps
  ) as ApprovalStep[];
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error('VALIDATION: steps must be a non-empty array');
  }
  for (const s of steps) {
    if (!KNOWN_ROLES.includes(s.roleSlug)) {
      throw new Error(`VALIDATION: unknown roleSlug '${s.roleSlug}'`);
    }
    if (s.action !== 'review' && s.action !== 'approve') {
      throw new Error(`VALIDATION: step action must be review|approve`);
    }
  }

  const ddb = await getTenantDdbClient(tenantId);
  const sk = matrixSk(input.artifactType, input.standard ?? null);
  const existing = await ddb.send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({ PK: governancePk(tenantId), SK: sk }),
    }),
  );
  const version = existing.Item ? (((unmarshall(existing.Item).version as number) ?? 0) + 1) : 1;
  const now = new Date().toISOString();

  await ddb.send(
    new PutItemCommand({
      TableName: TABLE_NAME,
      Item: marshall({
        PK: governancePk(tenantId),
        SK: sk,
        itemType: 'APPROVALMATRIX',
        artifactType: input.artifactType,
        standard: input.standard ?? 'ANY',
        steps: JSON.stringify(steps),
        version,
        updatedBy: actor,
        updatedAt: now,
      }),
    }),
  );

  await publishAuditEvent({
    tenantId,
    actor,
    module: 'M4',
    clauseRef: 'ISO 9001 7.5.2',
    standard: (input.standard as 'ISO9001' | 'ISO14001' | 'ISO45001') ?? 'ISO9001',
    detailType: 'Governance.ApprovalMatrixChanged',
    source: 'cumplify.m4.governance',
    entityId: sk,
    payload: { artifactType: input.artifactType, standard: input.standard ?? null, steps, version },
  });

  return {
    id: sk,
    artifactType: input.artifactType,
    standard: input.standard ?? null,
    steps,
    version,
    updatedBy: actor,
    updatedAt: now,
  };
}

async function registerRecord(event: AppSyncEvent, tenantId: string, actor: string) {
  const input = event.arguments.input as Record<string, unknown>;
  const txn = await beginTenantTransaction(tenantId);
  try {
    const result = await txn.execute(
      `INSERT INTO m4.records (tenant_id, standard, record_type, source_module, retention_class, s3_object_ref, created_by)
       VALUES (:tenantId, :standard, :recordType, :sourceModule, :retentionClass, :s3ObjectRef, :actor)
       RETURNING *`,
      [
        { name: 'tenantId', value: { stringValue: tenantId } },
        { name: 'standard', value: { stringValue: input.standard as string } },
        { name: 'recordType', value: { stringValue: input.recordType as string } },
        { name: 'sourceModule', value: { stringValue: input.sourceModule as string } },
        {
          name: 'retentionClass',
          value: input.retentionClass
            ? { stringValue: input.retentionClass as string }
            : { isNull: true },
        },
        {
          name: 's3ObjectRef',
          value: input.s3ObjectRef
            ? { stringValue: input.s3ObjectRef as string }
            : { isNull: true },
        },
        { name: 'actor', value: { stringValue: actor } },
      ],
    );
    await txn.commit();
    const record = marshalOne(result);
    await publishAuditEvent({
      tenantId,
      actor,
      module: 'M4',
      clauseRef: 'ISO 9001 7.5.3',
      standard: 'ISO9001',
      detailType: 'Record.Registered',
      source: 'cumplify.m4.records',
      entityId: String(record?.id ?? ''),
      payload: { recordId: record?.id, input },
    });
    logger.info('Record registered', { tenantId });
    return record;
  } catch (err) {
    await txn.rollback();
    throw err;
  }
}

async function registerMeasuringResource(event: AppSyncEvent, tenantId: string, actor: string) {
  const input = event.arguments.input as Record<string, unknown>;
  const txn = await beginTenantTransaction(tenantId);
  try {
    const result = await txn.execute(
      `INSERT INTO m4.measuring_resources (tenant_id, asset_tag, description, created_by)
       VALUES (:tenantId, :assetTag, :description, :actor)
       RETURNING *`,
      [
        { name: 'tenantId', value: { stringValue: tenantId } },
        { name: 'assetTag', value: { stringValue: input.assetTag as string } },
        { name: 'description', value: { stringValue: input.description as string } },
        { name: 'actor', value: { stringValue: actor } },
      ],
    );
    await txn.commit();
    const resource = marshalOne(result);
    await publishAuditEvent({
      tenantId,
      actor,
      module: 'M4',
      clauseRef: 'ISO 9001 7.1.5.1',
      standard: 'ISO9001',
      detailType: 'MeasuringResource.Registered',
      source: 'cumplify.m4.records',
      entityId: String(resource?.id ?? ''),
      payload: { resourceId: resource?.id, assetTag: input.assetTag },
    });
    logger.info('Measuring resource registered', { tenantId });
    return resource;
  } catch (err) {
    await txn.rollback();
    throw err;
  }
}

async function recordCalibration(event: AppSyncEvent, tenantId: string, actor: string) {
  const input = event.arguments.input as Record<string, unknown>;
  const txn = await beginTenantTransaction(tenantId);
  try {
    const result = await txn.execute(
      `INSERT INTO m4.calibration_records (tenant_id, measuring_resource_id, calibrated_at, next_due, standard_used, traceability_ref, result, created_by)
       VALUES (:tenantId, :measuringResourceId::uuid, NOW(), :nextDue::timestamptz, :standardUsed, :traceabilityRef, :result, :actor)
       RETURNING *`,
      [
        { name: 'tenantId', value: { stringValue: tenantId } },
        {
          name: 'measuringResourceId',
          value: { stringValue: input.measuringResourceId as string },
        },
        { name: 'nextDue', value: { stringValue: input.nextDue as string } },
        { name: 'standardUsed', value: { stringValue: input.standardUsed as string } },
        {
          name: 'traceabilityRef',
          value: input.traceabilityRef
            ? { stringValue: input.traceabilityRef as string }
            : { isNull: true },
        },
        { name: 'result', value: { stringValue: input.result as string } },
        { name: 'actor', value: { stringValue: actor } },
      ],
    );
    await txn.commit();
    const calibration = marshalOne(result);
    await publishAuditEvent({
      tenantId,
      actor,
      module: 'M4',
      clauseRef: 'ISO 9001 7.1.5.2',
      standard: 'ISO9001',
      detailType: 'Calibration.Recorded',
      source: 'cumplify.m4.records',
      entityId: String(calibration?.id ?? ''), // the CalibrationRecord row the mutation returns
      payload: {
        calibrationId: calibration?.id,
        measuringResourceId: input.measuringResourceId,
        result: input.result,
      },
    });
    logger.info('Calibration recorded', { tenantId });
    return calibration;
  } catch (err) {
    await txn.rollback();
    throw err;
  }
}

async function createRetentionPolicy(event: AppSyncEvent, tenantId: string, actor: string) {
  const input = event.arguments.input as Record<string, unknown>;
  const txn = await beginTenantTransaction(tenantId);
  try {
    const result = await txn.execute(
      `INSERT INTO m4.retention_policies (tenant_id, record_type, retention_years, disposition_rule, created_by)
       VALUES (:tenantId, :recordType, :retentionYears, :dispositionRule, :actor)
       ON CONFLICT (tenant_id, record_type)
       DO UPDATE SET retention_years = EXCLUDED.retention_years,
                     disposition_rule = EXCLUDED.disposition_rule,
                     updated_at = NOW()
       RETURNING *`,
      [
        { name: 'tenantId', value: { stringValue: tenantId } },
        { name: 'recordType', value: { stringValue: input.recordType as string } },
        { name: 'retentionYears', value: { longValue: input.retentionYears as number } },
        { name: 'dispositionRule', value: { stringValue: input.dispositionRule as string } },
        { name: 'actor', value: { stringValue: actor } },
      ],
    );
    await txn.commit();
    const policy = marshalOne(result);
    await publishAuditEvent({
      tenantId,
      actor,
      module: 'M4',
      clauseRef: 'ISO 9001 7.5.3',
      standard: 'ISO9001',
      detailType: 'Record.RetentionPolicySet',
      source: 'cumplify.m4.records',
      entityId: String(policy?.id ?? ''), // the RetentionPolicy row the mutation returns
      payload: {
        retentionPolicyId: policy?.id,
        recordType: input.recordType,
        retentionYears: input.retentionYears,
      },
    });
    return policy;
  } catch (err) {
    await txn.rollback();
    throw err;
  }
}

async function getRecord(event: AppSyncEvent, tenantId: string) {
  const txn = await beginTenantTransaction(tenantId);
  try {
    const result = await txn.execute(`SELECT * FROM m4.records WHERE id = :id::uuid`, [
      { name: 'id', value: { stringValue: event.arguments.id as string } },
    ]);
    await txn.commit();
    return marshalOne(result);
  } catch (err) {
    await txn.rollback();
    throw err;
  }
}

async function listCalibrationsDue(event: AppSyncEvent, tenantId: string) {
  const windowDays = event.arguments.windowDays as number;
  const txn = await beginTenantTransaction(tenantId);
  try {
    const result = await txn.execute(
      `SELECT * FROM m4.calibration_records
       WHERE next_due <= (NOW() + make_interval(days => :windowDays::int))
       ORDER BY next_due ASC LIMIT ${LIST_QUERY_LIMIT}`,
      [{ name: 'windowDays', value: { longValue: windowDays } }],
    );
    await txn.commit();
    return marshalMany(result);
  } catch (err) {
    await txn.rollback();
    throw err;
  }
}

/**
 * getAuditTrail — reads the real audit ledger (services/audit-trail,
 * DynamoDB CumplifyCore, PK=TENANT#<id>#AUDITLOG) via the tenant-data role.
 *
 * Primary path: Query GSI1 on GSI1PK = TENANT#<id>#ENTITY#<entityId> — the
 * appender stamps this key on every item whose envelope carried a normalized
 * entityId (every publishAuditEvent call site declares one; the leading
 * TENANT#<id># satisfies the tenant-data role's LeadingKeys condition on
 * index/*). Fallback (GSI returns ZERO items): the pre-GSI partition scan
 * with substring payload match — covers events appended before the entityId
 * attribute existed. Mixed pre/post-migration entities return only the GSI
 * hits; a ledger backfill (new attributes only, chain untouched) is the
 * upgrade path if that ever matters in practice.
 */
async function getAuditTrail(event: AppSyncEvent, tenantId: string, ctx: ResolverContext) {
  if (ctx.poolClass !== 'tenant-admin' && !AUDIT_TRAIL_ROLES.has(ctx.role)) {
    throw new Error('FORBIDDEN: audit trail requires admin or auditor role');
  }

  const entityId = event.arguments.entityId as string;
  const ddb = await getTenantDdbClient(tenantId);

  const shape = (item: Record<string, unknown>) => ({
    tenantId,
    eventId: item.eventId,
    eventType: item.eventType,
    actor: item.actor,
    module: item.module,
    clauseRef: item.clauseRef,
    standard: item.standard,
    timestamp: item.eventTimestamp,
    payloadHash: item.payloadHash,
    prevHash: item.prevHash ?? null,
    payload: item.payload ?? null,
  });

  // Primary: per-entity GSI query (paginated, most recent first)
  const gsiMatches: Record<string, unknown>[] = [];
  let gsiLastKey: Record<string, unknown> | undefined;
  do {
    const resp = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :gpk', // :gpk = TENANT#<tenantId>#ENTITY#<entityId> (FF-5)
        // The itemType filter keeps this query audit-ledger-only even if another
        // item type ever adopts GSI1 (today the ledger is its sole writer).
        FilterExpression: 'itemType = :audit',
        ExpressionAttributeValues: {
          ':gpk': { S: `TENANT#${tenantId}#ENTITY#${entityId}` },
          ':audit': { S: 'AUDITLOG' },
        },
        ScanIndexForward: false,
        ExclusiveStartKey: gsiLastKey as never,
      }),
    );
    for (const raw of resp.Items ?? []) {
      gsiMatches.push(shape(unmarshall(raw)));
    }
    gsiLastKey = resp.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (gsiLastKey);

  if (gsiMatches.length > 0) return gsiMatches;

  // Fallback: pre-migration events (no entityId attribute) — partition scan
  // with EXACT payload-value matching (the old substring test false-positived
  // on short entityIds, returning the tenant's whole ledger).
  const matches: Record<string, unknown>[] = [];
  const pk = `TENANT#${tenantId}#AUDITLOG`;
  let lastKey: Record<string, unknown> | undefined;
  let pages = 0;

  do {
    const resp = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': { S: pk } },
        ScanIndexForward: false,
        ExclusiveStartKey: lastKey as never,
      }),
    );
    for (const raw of resp.Items ?? []) {
      const item = unmarshall(raw);
      if (payloadHasExactValue(item.payload, entityId)) {
        matches.push(shape(item));
      }
    }
    lastKey = resp.LastEvaluatedKey as Record<string, unknown> | undefined;
    pages += 1;
  } while (lastKey && pages < 10);

  return matches;
}

/** True when any string VALUE nested in payload equals needle exactly. */
function payloadHasExactValue(payload: unknown, needle: string): boolean {
  if (payload === needle) return true;
  if (!payload || typeof payload !== 'object') return false;
  for (const v of Object.values(payload as Record<string, unknown>)) {
    if (v === needle) return true;
    if (v && typeof v === 'object' && payloadHasExactValue(v, needle)) return true;
  }
  return false;
}
