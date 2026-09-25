/**
 * M5 Risk Management resolver.
 * Exercises BOTH isolation paths: RDS (system-of-record) + DDB (metadata).
 * risk_register_view accessed via get_risk_register_view() ONLY (never direct SELECT).
 *
 * C-2 INVARIANT: set_config('app.tenant_id', :tenantId, true) is ALWAYS the
 * FIRST statement in every BeginTransaction. Never false. Never bare ExecuteStatement.
 */

import { Logger } from '@aws-lambda-powertools/logger';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { ulid } from 'ulid';
import {
  extractContext,
  extractAgentContext,
  beginTenantTransaction,
  publishAuditEvent,
  requireModuleRole,
  marshalOne,
  marshalMany,
} from './shared.js';
import { mapEnum, RISK_CATEGORY_MAP } from './enum-mappings.js';

const logger = new Logger({ serviceName: 'resolver-m5' });
const lambdaClient = new LambdaClient({});
const RISK_SENTINEL_FN_ARN = process.env.RISK_SENTINEL_FN_ARN ?? '';

// M-effort: server-side bound on list queries (mirror forms' LIST_MAX_LIMIT).
const LIST_QUERY_LIMIT = 500;

interface AppSyncEvent {
  info: { fieldName: string };
  arguments: Record<string, unknown>;
  identity?: {
    resolverContext?: Record<string, string>;
    userArn?: string;
    username?: string;
  };
}

type IsoStandard = 'ISO9001' | 'ISO14001' | 'ISO45001';
const ISO_STANDARDS = new Set<IsoStandard>(['ISO9001', 'ISO14001', 'ISO45001']);
function toIsoStandard(raw: unknown): IsoStandard {
  return ISO_STANDARDS.has(raw as IsoStandard) ? (raw as IsoStandard) : 'ISO9001';
}

export async function handler(event: AppSyncEvent): Promise<unknown> {
  // RS-7: agent* (@aws_iam) fields never carry resolverContext — branch
  // BEFORE extractContext, which would throw for them.
  if (event.info.fieldName === 'agentAssessRisk') {
    const { tenantId, actor } = extractAgentContext(
      event.arguments,
      'RiskSentinel',
      event.identity,
    );
    logger.appendKeys({ tenantId, requestField: event.info.fieldName });
    return agentAssessRisk(event, tenantId, actor);
  }

  const ctx = extractContext(event);
  const { tenantId, sub, role } = ctx;
  logger.appendKeys({ tenantId, requestField: event.info.fieldName });

  const fieldName = event.info.fieldName;

  // M-effort: M5 write mutations are role-gated at entry (Part 13 matrix);
  // queries stay at the authenticated floor.
  switch (fieldName) {
    case 'createRisk':
      return requireModuleRole(role, 'M5', () => createRisk(event, tenantId, sub));
    case 'addRiskTreatment':
      return requireModuleRole(role, 'M5', () => addRiskTreatment(event, tenantId, sub));
    case 'createChangePlan':
      return requireModuleRole(role, 'M5', () => createChangePlan(event, tenantId, sub));
    case 'runRiskAssessment':
      return requireModuleRole(role, 'M5', () => runRiskAssessment(event, tenantId, sub));
    case 'getRisk':
      return getRisk(event, tenantId);
    case 'getCrossRegisterRiskView':
      return getCrossRegisterRiskView(event, tenantId);
    default:
      throw new Error(`Unknown field: ${fieldName}`);
  }
}

async function createRisk(event: AppSyncEvent, tenantId: string, actor: string) {
  const input = event.arguments.input as Record<string, unknown>;
  const category = mapEnum(RISK_CATEGORY_MAP, input.category as string, 'category');
  const ownerId = (input.ownerId as string) ?? actor; // NOT NULL — fall back to actor
  const txn = await beginTenantTransaction(tenantId);

  try {
    const result = await txn.execute(
      `INSERT INTO m5.risks (tenant_id, standard, category, description, likelihood, severity, treatment, owner_id, status, created_by)
       VALUES (:tenantId, :standard, :category, :description, :likelihood, :severity, :treatment, :ownerId, 'open', :actor)
       RETURNING id, tenant_id, standard, category, description, likelihood, severity, risk_rating, treatment, owner_id, status, created_at`,
      [
        { name: 'tenantId', value: { stringValue: tenantId } },
        { name: 'standard', value: { stringValue: input.standard as string } }, // verbatim ISO9001/14001/45001
        { name: 'category', value: { stringValue: category } }, // mapped to lowercase
        { name: 'description', value: { stringValue: input.description as string } },
        { name: 'likelihood', value: { longValue: input.likelihood as number } },
        { name: 'severity', value: { longValue: input.severity as number } },
        { name: 'treatment', value: { stringValue: (input.treatment as string) ?? '' } },
        { name: 'ownerId', value: { stringValue: ownerId } },
        { name: 'actor', value: { stringValue: actor } },
      ],
    );

    await txn.commit();

    const risk = marshalOne(result);

    // M-effort: the register view refresh moved to AFTER commit (see
    // refreshRiskRegisterView) — it no longer rides the write's transaction.
    await refreshRiskRegisterView(tenantId);

    // Publish audit event with REAL id from INSERT result (BUG-B fix)
    await publishAuditEvent({
      tenantId,
      actor,
      module: 'M5',
      clauseRef: 'ISO 9001 6.1',
      standard: toIsoStandard(risk?.standard),
      detailType: 'Risk.Created',
      source: 'cumplify.m5.risk',
      entityId: String(risk?.id ?? ''),
      payload: { riskId: risk?.id, category, description: input.description },
    });

    logger.info('Risk created', { tenantId, riskId: risk?.id });
    return risk;
  } catch (err) {
    await txn.rollback();
    throw err;
  }
}

/**
 * agentAssessRisk (RS-7, RiskSentinel writeback door) — updates an existing
 * risk's likelihood/severity. Direct write: no SFN-token HITL gate is
 * reachable from this Lambda (ApiStack) without a circular stack dependency
 * on AiStack's HitlStateMachine (AiStack already depends on ApiStack for
 * its DB/GraphQL props) — found at RS-7 build time, documented in the
 * evidence log. RS-8's runRiskAssessment is the real compliance-gated path:
 * the RiskSentinel seat (living in AiStack, zero circularity) proposes via
 * its own tool-loop -> enterHitlGate, and execute-writeback.ts's new
 * 'risk-assessment-write' case commits post-approval. rationale has no
 * m5.risks column (free-text narrative, not a register field) — preserved
 * in the audit event payload only, same convention as closeCapa's
 * closureNotes / records-retention-schedule's justification.
 */
async function agentAssessRisk(event: AppSyncEvent, tenantId: string, actor: string) {
  const input = event.arguments.input as Record<string, unknown>;
  const txn = await beginTenantTransaction(tenantId);
  try {
    const result = await txn.execute(
      `UPDATE m5.risks SET likelihood = :likelihood, severity = :severity, updated_at = NOW(), version = version + 1
       WHERE id = :riskId::uuid AND tenant_id = :tenantId
       RETURNING id, tenant_id, standard, category, description, likelihood, severity, risk_rating, treatment, owner_id, status, created_at`,
      [
        { name: 'likelihood', value: { longValue: input.likelihood as number } },
        { name: 'severity', value: { longValue: input.severity as number } },
        { name: 'riskId', value: { stringValue: input.riskId as string } },
        { name: 'tenantId', value: { stringValue: tenantId } },
      ],
    );
    if (!result.records || result.records.length === 0) {
      throw new Error('RISK_NOT_FOUND');
    }

    await txn.commit();
    const risk = marshalOne(result);

    // Same post-commit refresh as createRisk (see refreshRiskRegisterView).
    await refreshRiskRegisterView(tenantId);

    await publishAuditEvent({
      tenantId,
      actor,
      module: 'M5',
      clauseRef: 'ISO 9001 6.1',
      standard: toIsoStandard(risk?.standard),
      detailType: 'Risk.Assessed',
      source: 'cumplify.m5.risk',
      entityId: String(risk?.id ?? ''),
      payload: {
        riskId: risk?.id,
        likelihood: input.likelihood,
        severity: input.severity,
        rationale: input.rationale,
      },
    });

    logger.info('Agent-assessed risk updated', { tenantId, riskId: risk?.id });
    return risk;
  } catch (err) {
    await txn.rollback();
    throw err;
  }
}

/**
 * runRiskAssessment (RS-8) — "AI: draft this" on the /risk register
 * row/drawer. Fetches the risk's current state (this Lambda has RDS
 * access; RiskSentinel does not — AgentHandlerReadOnlyPolicy, T-1), then
 * FIRE-AND-FORGET async-invokes RiskSentinel (InvocationType 'Event') with
 * that context. See runCapaAnalysis (m2.ts) for the same AppSync-30s-
 * ceiling rationale — identical shape, mirrored deliberately.
 */
async function runRiskAssessment(event: AppSyncEvent, tenantId: string, actor: string) {
  const riskId = event.arguments.riskId as string;
  const txn = await beginTenantTransaction(tenantId);
  let risk: Record<string, unknown> | null;
  try {
    const result = await txn.execute(
      `SELECT description, category, standard, likelihood, severity FROM m5.risks WHERE id = :riskId::uuid`,
      [{ name: 'riskId', value: { stringValue: riskId } }],
    );
    risk = marshalOne(result);
    if (!risk) throw new Error('RISK_NOT_FOUND');
    await txn.commit();
  } catch (err) {
    await txn.rollback();
    throw err;
  }

  const runId = ulid();
  const payload = {
    tenantId,
    runId,
    riskId,
    requestedBy: actor,
    context: {
      description: risk.description,
      category: (risk.category as string).toLowerCase(),
      standard: risk.standard,
      currentLikelihood: risk.likelihood,
      currentSeverity: risk.severity,
    },
  };

  await lambdaClient.send(
    new InvokeCommand({
      FunctionName: RISK_SENTINEL_FN_ARN,
      InvocationType: 'Event',
      Payload: JSON.stringify(payload),
    }),
  );

  logger.info('Risk assessment dispatched', { tenantId, riskId, runId });
  return { runId, status: 'DISPATCHED' };
}

async function addRiskTreatment(event: AppSyncEvent, tenantId: string, actor: string) {
  const input = event.arguments.input as Record<string, unknown>;
  const txn = await beginTenantTransaction(tenantId);

  try {
    const result = await txn.execute(
      `INSERT INTO m5.risk_treatments (tenant_id, risk_id, action_desc, owner_id, due_date, status, created_by)
       VALUES (:tenantId, :riskId::uuid, :actionDesc, :ownerId, :dueDate::timestamptz, 'open', :actor)
       RETURNING id, risk_id, tenant_id, action_desc, owner_id, due_date, status, created_at`,
      [
        { name: 'tenantId', value: { stringValue: tenantId } },
        { name: 'riskId', value: { stringValue: input.riskId as string } },
        { name: 'actionDesc', value: { stringValue: input.actionDesc as string } },
        { name: 'ownerId', value: { stringValue: input.ownerId as string } },
        { name: 'dueDate', value: { stringValue: input.dueDate as string } },
        { name: 'actor', value: { stringValue: actor } },
      ],
    );
    await txn.commit();

    const treatment = marshalOne(result);
    await publishAuditEvent({
      tenantId,
      actor,
      module: 'M5',
      clauseRef: 'ISO 9001 6.1',
      standard: 'ISO9001',
      detailType: 'Risk.TreatmentAdded',
      source: 'cumplify.m5.risk',
      entityId: String(treatment?.id ?? ''), // the RiskTreatment row the mutation returns
      payload: { treatmentId: treatment?.id, riskId: input.riskId, input },
    });

    return treatment;
  } catch (err) {
    await txn.rollback();
    throw err;
  }
}

async function createChangePlan(event: AppSyncEvent, tenantId: string, actor: string) {
  const input = event.arguments.input as Record<string, unknown>;
  const txn = await beginTenantTransaction(tenantId);

  try {
    const result = await txn.execute(
      `INSERT INTO m5.change_plans (tenant_id, standard, change_desc, impact_assessment, approval_status, created_by)
       VALUES (:tenantId, :standard, :changeDesc, :impact, 'draft', :actor)
       RETURNING id, tenant_id, standard, change_desc, impact_assessment, approval_status, created_at`,
      [
        { name: 'tenantId', value: { stringValue: tenantId } },
        { name: 'standard', value: { stringValue: input.standard as string } },
        { name: 'changeDesc', value: { stringValue: input.changeDesc as string } },
        { name: 'impact', value: { stringValue: (input.impactAssessment as string) ?? '' } },
        { name: 'actor', value: { stringValue: actor } },
      ],
    );
    await txn.commit();

    const plan = marshalOne(result);
    await publishAuditEvent({
      tenantId,
      actor,
      module: 'M5',
      clauseRef: 'ISO 9001 6.3',
      standard: 'ISO9001',
      detailType: 'Change.Planned',
      source: 'cumplify.m5.risk',
      entityId: String(plan?.id ?? ''),
      payload: { changePlanId: plan?.id, input },
    });

    return plan;
  } catch (err) {
    await txn.rollback();
    throw err;
  }
}

async function getRisk(event: AppSyncEvent, tenantId: string) {
  const id = event.arguments.id as string;
  const txn = await beginTenantTransaction(tenantId);
  try {
    const result = await txn.execute(`SELECT * FROM m5.risks WHERE id = :id::uuid`, [
      { name: 'id', value: { stringValue: id } },
    ]);
    await txn.commit();
    return marshalOne(result);
  } catch (err) {
    await txn.rollback();
    throw err;
  }
}

async function getCrossRegisterRiskView(event: AppSyncEvent, tenantId: string) {
  // risk_register_view accessed via SECURITY DEFINER function ONLY (design §6.4)
  // NEVER a direct SELECT on the materialized view.
  // FIXED 2026-07-14 (architect): the schema declares optional standard/category
  // filter args that were silently ignored — the M5 filter bar was a live no-op
  // (same bug class as the earlier m1.listDocuments fix).
  const clauses: string[] = [];
  const params: Array<{ name: string; value: { stringValue: string } }> = [];
  const standard = event.arguments.standard as string | undefined;
  const category = event.arguments.category as string | undefined;
  if (standard) {
    clauses.push('standard = :standard');
    params.push({ name: 'standard', value: { stringValue: standard } });
  }
  if (category) {
    clauses.push('category = :category');
    params.push({
      name: 'category',
      value: { stringValue: mapEnum(RISK_CATEGORY_MAP, category, 'category') },
    });
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const txn = await beginTenantTransaction(tenantId);
  try {
    const result = await txn.execute(
      `SELECT * FROM m5_views.get_risk_register_view() ${where} LIMIT ${LIST_QUERY_LIMIT}`,
      params,
    );
    await txn.commit();
    return marshalMany(result);
  } catch (err) {
    await txn.rollback();
    throw err;
  }
}

/**
 * Refresh the register materialized view AFTER the domain write's transaction
 * commits (M-effort, spec 2026-09 audit).
 *
 * Why post-commit: m5_views.refresh_risk_register_view() is a SECURITY DEFINER
 * accessor that REFRESHes the MV — a heavyweight, view-locking statement that
 * used to run INSIDE the write transaction. In-transaction it (a) serializes
 * concurrent writers on the MV lock for the whole txn, and (b) lets a refresh
 * failure roll back an otherwise-good domain write. Post-commit keeps the
 * write durable regardless; the register converges once the refresh finishes.
 * A failed refresh is logged loudly and swallowed — the next write re-runs it,
 * and get_risk_register_view() readers are never worse than one refresh stale.
 */
async function refreshRiskRegisterView(tenantId: string): Promise<void> {
  try {
    const txn = await beginTenantTransaction(tenantId);
    try {
      await txn.execute(`SELECT m5_views.refresh_risk_register_view()`);
      await txn.commit();
    } catch (err) {
      try {
        await txn.rollback();
      } catch {
        /* never mask */
      }
      throw err;
    }
  } catch (err) {
    logger.error('Post-commit risk-register refresh failed', {
      tenantId,
      error: (err as Error).message,
    });
  }
}
