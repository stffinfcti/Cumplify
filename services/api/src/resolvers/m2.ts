/**
 * M2 CAPA (Corrective & Preventive Action) resolver.
 * RDS system-of-record via Data API (app_role).
 * C-2 INVARIANT: set_config FIRST in every transaction, transaction-local (true).
 * SCHEMA-5: tenantId from resolverContext only.
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
  jsonOut,
} from './shared.js';
import {
  mapEnum,
  NC_SOURCE_MAP,
  NC_TYPE_MAP,
  SEVERITY_MAP,
  DISPOSITION_MAP,
  RCA_METHOD_MAP,
} from './enum-mappings.js';

const logger = new Logger({ serviceName: 'resolver-m2' });
const lambdaClient = new LambdaClient({});

// M-effort: server-side bound on list queries (mirror forms' LIST_MAX_LIMIT).
const LIST_QUERY_LIMIT = 500;
const CAPA_GURU_FN_ARN = process.env.CAPA_GURU_FN_ARN ?? '';

interface AppSyncEvent {
  info: { fieldName: string };
  arguments: Record<string, unknown>;
  identity?: {
    resolverContext?: Record<string, string>;
    userArn?: string;
    username?: string;
  };
}

const AGENT_FIELDS = new Set(['agentTriageNC', 'agentProposeCorrectiveAction']);

export async function handler(event: AppSyncEvent): Promise<unknown> {
  // RS-7: agent* (@aws_iam) fields never carry resolverContext — branch
  // BEFORE extractContext, which would throw for them.
  if (AGENT_FIELDS.has(event.info.fieldName)) {
    const { tenantId, actor } = extractAgentContext(event.arguments, 'CAPAGuru', event.identity);
    logger.appendKeys({ tenantId, requestField: event.info.fieldName });
    return event.info.fieldName === 'agentTriageNC'
      ? agentTriageNC(event, tenantId, actor)
      : agentProposeCorrectiveAction(event, tenantId, actor);
  }

  const ctx = extractContext(event);
  const { tenantId, sub, role } = ctx;
  logger.appendKeys({ tenantId, requestField: event.info.fieldName });

  // M-effort: M2 write mutations are role-gated at entry (Part 13 matrix);
  // queries stay at the authenticated floor.
  switch (event.info.fieldName) {
    case 'raiseNonconformity':
      return requireModuleRole(role, 'M2', () => raiseNonconformity(event, tenantId, sub));
    case 'recordRootCause':
      return requireModuleRole(role, 'M2', () => recordRootCause(event, tenantId, sub));
    case 'createCorrectiveAction':
      return requireModuleRole(role, 'M2', () => createCorrectiveAction(event, tenantId, sub));
    case 'closeCapa':
      return requireModuleRole(role, 'M2', () => closeCapa(event, tenantId, sub));
    case 'verifyEffectiveness':
      return requireModuleRole(role, 'M2', () => verifyEffectiveness(event, tenantId, sub));
    case 'disposeNonconformingOutput':
      return requireModuleRole(role, 'M2', () => disposeNonconformingOutput(event, tenantId, sub));
    case 'runCapaAnalysis':
      return requireModuleRole(role, 'M2', () => runCapaAnalysis(event, tenantId, sub));
    case 'runNcIntake':
      return requireModuleRole(role, 'M2', () => runNcIntake(event, tenantId, sub));
    case 'runRootCauseAnalysis':
      return requireModuleRole(role, 'M2', () => runRootCauseAnalysis(event, tenantId, sub));
    case 'listRootCauseAnalyses':
      return listRootCauseAnalyses(event, tenantId);
    case 'getNonconformity':
      return getNonconformity(event, tenantId);
    case 'listNonconformities':
      return listNonconformities(event, tenantId);
    case 'listOpenCAPAs':
      return listOpenCAPAs(event, tenantId);
    case 'listCorrectiveActions':
      return listCorrectiveActions(event, tenantId);
    default:
      throw new Error(`Unknown field: ${event.info.fieldName}`);
  }
}

async function raiseNonconformity(event: AppSyncEvent, tenantId: string, actor: string) {
  const input = event.arguments.input as Record<string, unknown>;
  const source = mapEnum(NC_SOURCE_MAP, input.source as string, 'source');
  const ncType = mapEnum(NC_TYPE_MAP, input.ncType as string, 'ncType');
  const severity = mapEnum(SEVERITY_MAP, input.severity as string, 'severity');
  const txn = await beginTenantTransaction(tenantId);
  try {
    const result = await txn.execute(
      `INSERT INTO m2.nonconformities (tenant_id, standard, source, nc_type, description, clause_ref, severity, status, raised_by, raised_at, created_by)
       VALUES (:tenantId, :standard, :source, :ncType, :description, :clauseRef, :severity, 'open', :actor, NOW(), :actor)
       RETURNING *`,
      [
        { name: 'tenantId', value: { stringValue: tenantId } },
        { name: 'standard', value: { stringValue: input.standard as string } },
        { name: 'source', value: { stringValue: source } },
        { name: 'ncType', value: { stringValue: ncType } },
        { name: 'description', value: { stringValue: input.description as string } },
        { name: 'clauseRef', value: { stringValue: input.clauseRef as string } },
        { name: 'severity', value: { stringValue: severity } },
        { name: 'actor', value: { stringValue: actor } },
      ],
    );
    await txn.commit();
    const nc = marshalOne(result);
    await publishAuditEvent({
      tenantId,
      actor,
      module: 'M2',
      clauseRef: 'ISO 9001 10.2',
      standard: 'ISO9001',
      detailType: 'NC.Raised',
      source: 'cumplify.m2.capa',
      entityId: String(nc?.id ?? ''),
      // F-A fix: agents consuming NC.Raised need the real ncId (was input-only)
      payload: { ncId: nc?.id, input },
    });
    logger.info('Nonconformity raised', { tenantId });
    return nc;
  } catch (err) {
    await txn.rollback();
    throw err;
  }
}

async function recordRootCause(event: AppSyncEvent, tenantId: string, actor: string) {
  // FIXED 2026-07-14 (architect): previous SQL updated root_cause/root_cause_method
  // on m2.nonconformities — neither column exists; the ratified table is
  // m2.root_cause_analyses (migration 003). Input fields were also read from a
  // draft shape (nonconformityId/rootCause) — RecordRootCauseInput is
  // { ncId, method, findings, rootCauseSummary }. Return type RootCauseAnalysis!.
  const input = event.arguments.input as Record<string, unknown>;
  // method is String! in the schema; the DB CHECK allows ('5why','fishbone','fta').
  const method = RCA_METHOD_MAP[(input.method as string).toUpperCase()] ?? (input.method as string);
  const txn = await beginTenantTransaction(tenantId);
  try {
    const result = await txn.execute(
      `INSERT INTO m2.root_cause_analyses (tenant_id, nc_id, method, findings, root_cause_summary, created_by)
       VALUES (:tenantId, :ncId::uuid, :method, :findings, :rootCauseSummary, :actor)
       RETURNING *`,
      [
        { name: 'tenantId', value: { stringValue: tenantId } },
        { name: 'ncId', value: { stringValue: input.ncId as string } },
        { name: 'method', value: { stringValue: method } },
        { name: 'findings', value: { stringValue: input.findings as string } },
        { name: 'rootCauseSummary', value: { stringValue: input.rootCauseSummary as string } },
        { name: 'actor', value: { stringValue: actor } },
      ],
    );
    // Recording a root cause moves the NC into analysis: open → in_progress.
    // The M2 CAPA timeline derives its root-cause stage from NC status — there is
    // no read surface for root_cause_analyses rows.
    await txn.execute(
      `UPDATE m2.nonconformities SET status = 'in_progress', updated_at = NOW()
       WHERE id = :ncId::uuid AND status = 'open'`,
      [{ name: 'ncId', value: { stringValue: input.ncId as string } }],
    );
    await txn.commit();
    const rca = marshalOne(result);
    await publishAuditEvent({
      tenantId,
      actor,
      module: 'M2',
      clauseRef: 'ISO 9001 10.2',
      standard: 'ISO9001',
      detailType: 'CAPA.RootCauseRecorded',
      source: 'cumplify.m2.capa',
      entityId: String(rca?.id ?? ''), // the RootCauseAnalysis row the mutation returns
      payload: { rootCauseAnalysisId: rca?.id, ncId: input.ncId, method },
    });
    return rca;
  } catch (err) {
    await txn.rollback();
    throw err;
  }
}

async function createCorrectiveAction(event: AppSyncEvent, tenantId: string, actor: string) {
  const input = event.arguments.input as Record<string, unknown>;
  const txn = await beginTenantTransaction(tenantId);
  try {
    // FIXED 2026-07-14 (architect): column is nc_id, not nonconformity_id (the
    // listOpenCAPAs join had the same stale name and was fixed earlier — the
    // INSERT was missed); input field is ncId per CreateCorrectiveActionInput;
    // containmentFlag was silently dropped.
    const result = await txn.execute(
      `INSERT INTO m2.corrective_actions (tenant_id, nc_id, action_desc, owner_id, due_date, status, containment_flag, created_by)
       VALUES (:tenantId, :ncId::uuid, :actionDesc, :ownerId, :dueDate::timestamptz, 'open', :containmentFlag, :actor)
       RETURNING *`,
      [
        { name: 'tenantId', value: { stringValue: tenantId } },
        { name: 'ncId', value: { stringValue: input.ncId as string } },
        { name: 'actionDesc', value: { stringValue: input.actionDesc as string } },
        { name: 'ownerId', value: { stringValue: (input.ownerId as string) ?? actor } },
        { name: 'dueDate', value: { stringValue: input.dueDate as string } },
        { name: 'containmentFlag', value: { booleanValue: input.containmentFlag === true } },
        { name: 'actor', value: { stringValue: actor } },
      ],
    );
    await txn.commit();
    const ca = marshalOne(result);
    await publishAuditEvent({
      tenantId,
      actor,
      module: 'M2',
      clauseRef: 'ISO 9001 10.2',
      standard: 'ISO9001',
      detailType: 'CAPA.Opened',
      source: 'cumplify.m2.capa',
      entityId: String(ca?.id ?? ''), // the CorrectiveAction row the mutation returns
      payload: { correctiveActionId: ca?.id, ncId: input.ncId, input },
    });
    logger.info('Corrective action created', { tenantId });
    return ca;
  } catch (err) {
    await txn.rollback();
    throw err;
  }
}

/**
 * agentProposeCorrectiveAction (RS-7, CAPAGuru writeback door) — creates a
 * corrective action, mirroring createCorrectiveAction. Direct write, no
 * HITL gate: per architecture §8 the CAPA shall-workflow's approval gates
 * are STAGED (triage/root-cause/CA-plan/effectiveness), not at creation —
 * an agent-proposed CA becomes visible/actionable immediately, exactly as
 * a human-created one does today; RS-8's stage-aware runCapaAnalysis adds
 * the staged gates on top of this same substrate.
 * AgentProposeCorrectiveActionInput has no dueDate (unlike the human-facing
 * CreateCorrectiveActionInput) — defaults to +14 days, matching the
 * industry-norm CA turnaround; a human edits it at the plan-approval stage.
 */
async function agentProposeCorrectiveAction(event: AppSyncEvent, tenantId: string, actor: string) {
  const input = event.arguments.input as Record<string, unknown>;
  const dueDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  const txn = await beginTenantTransaction(tenantId);
  try {
    const result = await txn.execute(
      `INSERT INTO m2.corrective_actions (tenant_id, nc_id, action_desc, owner_id, due_date, status, containment_flag, created_by)
       VALUES (:tenantId, :ncId::uuid, :actionDesc, :ownerId, :dueDate::timestamptz, 'open', false, :actor)
       RETURNING *`,
      [
        { name: 'tenantId', value: { stringValue: tenantId } },
        { name: 'ncId', value: { stringValue: input.ncId as string } },
        { name: 'actionDesc', value: { stringValue: input.actionDesc as string } },
        { name: 'ownerId', value: { stringValue: input.suggestedOwnerId as string } },
        { name: 'dueDate', value: { stringValue: dueDate } },
        { name: 'actor', value: { stringValue: actor } },
      ],
    );
    await txn.commit();
    const ca = marshalOne(result);
    await publishAuditEvent({
      tenantId,
      actor,
      module: 'M2',
      clauseRef: 'ISO 9001 10.2',
      standard: 'ISO9001',
      detailType: 'CAPA.Opened',
      source: 'cumplify.m2.capa',
      entityId: String(ca?.id ?? ''),
      payload: { correctiveActionId: ca?.id, ncId: input.ncId, input, agentProposed: true },
    });
    logger.info('Agent-proposed corrective action created', { tenantId });
    return ca;
  } catch (err) {
    await txn.rollback();
    throw err;
  }
}

/**
 * agentTriageNC (RS-7, CAPAGuru writeback door) — reclassifies an existing
 * NC's nc_type. Direct write: no SFN-token HITL gate is reachable from this
 * Lambda (ApiStack) without a circular stack dependency on AiStack's
 * HitlStateMachine (AiStack already depends on ApiStack for its DB/GraphQL
 * props) — found at RS-7 build time, documented in the evidence log. The
 * REAL compliance-gated triage path (architecture §4 CAPA stage 2: "QM/EHS
 * Mgr accepts classification") is RS-8's job: CAPAGuru's own tool-loop
 * (already living in AiStack, zero circularity) proposes via enterHitlGate,
 * and execute-writeback.ts's new 'nc-triage-write' case commits post-
 * approval — this direct mutation is a separate, ungated utility surface,
 * not that gated path.
 */
async function agentTriageNC(event: AppSyncEvent, tenantId: string, actor: string) {
  const input = event.arguments.input as Record<string, unknown>;
  const ncType = mapEnum(NC_TYPE_MAP, input.classification as string, 'classification');
  const txn = await beginTenantTransaction(tenantId);
  try {
    const result = await txn.execute(
      `UPDATE m2.nonconformities SET nc_type = :ncType, updated_at = NOW(), version = version + 1
       WHERE id = :ncId::uuid AND tenant_id = :tenantId
       RETURNING *`,
      [
        { name: 'ncType', value: { stringValue: ncType } },
        { name: 'ncId', value: { stringValue: input.ncId as string } },
        { name: 'tenantId', value: { stringValue: tenantId } },
      ],
    );
    if (!result.records || result.records.length === 0) {
      throw new Error('NC_NOT_FOUND');
    }
    await txn.commit();
    const nc = marshalOne(result);
    await publishAuditEvent({
      tenantId,
      actor,
      module: 'M2',
      clauseRef: 'ISO 9001 10.2',
      standard: 'ISO9001',
      detailType: 'NC.Triaged',
      source: 'cumplify.m2.capa',
      entityId: String(nc?.id ?? ''),
      payload: { ncId: nc?.id, classification: input.classification, agentTriaged: true },
    });
    logger.info('Agent-triaged NC reclassified', { tenantId, ncId: input.ncId });
    return nc;
  } catch (err) {
    await txn.rollback();
    throw err;
  }
}

/**
 * runCapaAnalysis (RS-8) — "AI: draft this" on the M2 CAPA drawer.
 * Fetches the NC's current state (this Lambda has RDS access; CAPAGuru does
 * not — AgentHandlerReadOnlyPolicy, T-1), then FIRE-AND-FORGET async-
 * invokes CAPAGuru (InvocationType 'Event') with that context. A
 * synchronous RequestResponse invoke would risk AppSync's ~30s direct-
 * Lambda-resolver ceiling under real Bedrock latency (the one-door
 * invoker's internal grounding/AR checks can retry). The HITL card
 * (listPendingHitlItems) is the real deliverable — this mutation only acks
 * successful dispatch.
 */
async function runCapaAnalysis(event: AppSyncEvent, tenantId: string, actor: string) {
  const ncId = event.arguments.ncId as string;
  const txn = await beginTenantTransaction(tenantId);
  let nc: Record<string, unknown> | null;
  let cas: Record<string, unknown>[];
  try {
    const ncResult = await txn.execute(
      `SELECT description, nc_type, severity, standard, status FROM m2.nonconformities WHERE id = :ncId::uuid`,
      [{ name: 'ncId', value: { stringValue: ncId } }],
    );
    nc = marshalOne(ncResult);
    if (!nc) throw new Error('NC_NOT_FOUND');

    const caResult = await txn.execute(
      `SELECT id, action_desc, status, owner_id FROM m2.corrective_actions WHERE nc_id = :ncId::uuid ORDER BY created_at ASC`,
      [{ name: 'ncId', value: { stringValue: ncId } }],
    );
    cas = marshalMany(caResult);
    await txn.commit();
  } catch (err) {
    await txn.rollback();
    throw err;
  }

  const runId = ulid();
  const payload = {
    tenantId,
    runId,
    ncId,
    requestedBy: actor,
    context: {
      nc: {
        description: nc.description,
        ncType: (nc.ncType as string).toLowerCase(),
        severity: (nc.severity as string).toLowerCase(),
        standard: nc.standard,
        status: (nc.status as string).toLowerCase(),
      },
      correctiveActions: cas.map((ca) => ({
        id: ca.id,
        actionDesc: ca.actionDesc,
        status: (ca.status as string).toLowerCase(),
        ownerId: ca.ownerId,
      })),
    },
  };

  await lambdaClient.send(
    new InvokeCommand({
      FunctionName: CAPA_GURU_FN_ARN,
      InvocationType: 'Event',
      Payload: JSON.stringify(payload),
    }),
  );

  logger.info('CAPA analysis dispatched', { tenantId, ncId, runId });
  return { runId, status: 'DISPATCHED' };
}

/**
 * runNcIntake (S1, studio wave) — stage-1 intake: the reporter describes
 * the problem in plain language; CAPAGuru classifies, identifies the
 * governing clause, sets severity/source and proposes the full NC via the
 * nc-draft-write HITL tool. Fire-and-forget Event invoke (runCapaAnalysis
 * pattern); the HITL card is the deliverable, this mutation only acks
 * dispatch. No DB reads — nothing exists yet.
 */
async function runNcIntake(event: AppSyncEvent, tenantId: string, actor: string) {
  const description = (event.arguments.description as string) ?? '';
  if (!description.trim()) throw new Error('VALIDATION: description is required');
  const evidenceNote = event.arguments.evidenceNote as string | undefined;

  const runId = ulid();
  await lambdaClient.send(
    new InvokeCommand({
      FunctionName: CAPA_GURU_FN_ARN,
      InvocationType: 'Event',
      Payload: JSON.stringify({
        tenantId,
        runId,
        requestedBy: actor,
        intake: { description, ...(evidenceNote ? { evidenceNote } : {}) },
      }),
    }),
  );

  logger.info('NC intake dispatched', { tenantId, runId });
  return { runId, status: 'DISPATCHED' };
}

/**
 * runRootCauseAnalysis (C1, CAPA Studio RCA — owner directive 2026-07-22:
 * "capa studio is missing the ai powered analysis, ishikawa, 5 whys").
 * Reads the NC (the agent never touches the DB), Event-invokes CAPAGuru in
 * RCA MODE with the chosen method; the rca-write HITL card is the
 * deliverable. Approval persists m2.root_cause_analyses via the writeback.
 */
async function runRootCauseAnalysis(event: AppSyncEvent, tenantId: string, actor: string) {
  const ncId = (event.arguments.ncId as string) ?? '';
  const methodEnum = (event.arguments.method as string) ?? '';
  const method = RCA_METHOD_MAP[methodEnum];
  if (!ncId.trim()) throw new Error('VALIDATION: ncId is required');
  if (!method) throw new Error(`VALIDATION: unknown RCA method '${methodEnum}'`);

  const txn = await beginTenantTransaction(tenantId);
  let nc: Record<string, unknown> | null;
  try {
    const result = await txn.execute(
      `SELECT id, standard, source, nc_type, description, clause_ref, severity, status
       FROM m2.nonconformities WHERE id = :id::uuid`,
      [{ name: 'id', value: { stringValue: ncId } }],
    );
    await txn.commit();
    nc = marshalOne(result);
  } catch (err) {
    try {
      await txn.rollback();
    } catch {
      /* never mask */
    }
    throw err;
  }
  if (!nc) throw new Error('NC_NOT_FOUND');

  const runId = ulid();
  await lambdaClient.send(
    new InvokeCommand({
      FunctionName: CAPA_GURU_FN_ARN,
      InvocationType: 'Event',
      Payload: JSON.stringify({
        tenantId,
        runId,
        requestedBy: actor,
        rcaIntent: {
          ncId,
          method,
          nc: {
            standard: nc.standard,
            source: nc.source,
            ncType: nc.ncType,
            description: nc.description,
            clauseRef: nc.clauseRef,
            severity: nc.severity,
          },
        },
      }),
    }),
  );

  logger.info('RCA dispatched', { tenantId, runId, ncId, method });
  return { runId, status: 'DISPATCHED' };
}

async function listRootCauseAnalyses(event: AppSyncEvent, tenantId: string) {
  const ncId = (event.arguments.ncId as string) ?? '';
  if (!ncId.trim()) throw new Error('VALIDATION: ncId is required');
  const txn = await beginTenantTransaction(tenantId);
  try {
    const result = await txn.execute(
      `SELECT id, nc_id, method, findings, root_cause_summary, created_by, created_at
       FROM m2.root_cause_analyses WHERE nc_id = :ncId::uuid ORDER BY created_at DESC LIMIT ${LIST_QUERY_LIMIT}`,
      [{ name: 'ncId', value: { stringValue: ncId } }],
    );
    await txn.commit();
    // findings is TEXT holding JSON — AWSJSON output must be the parsed
    // object (2026-07-22 wire rule: return objects, never re-stringified).
    return marshalMany(result).map((r) => ({ ...r, findings: jsonOut(r.findings) }));
  } catch (err) {
    try {
      await txn.rollback();
    } catch {
      /* never mask */
    }
    throw err;
  }
}

async function closeCapa(event: AppSyncEvent, tenantId: string, actor: string) {
  const input = event.arguments.input as Record<string, unknown>;
  const txn = await beginTenantTransaction(tenantId);
  try {
    // FIXED 2026-07-14 (architect): closed_at/closed_by columns do not exist on
    // m2.corrective_actions (migration 003); input field is id per CloseCapaInput.
    // closureNotes has no column — it is preserved in the audit-trail payload.
    // M-effort: status predicate rides the UPDATE — a concurrent close can no
    // longer double-close (and double-emit CAPA.Closed for) the same row.
    const result = await txn.execute(
      `UPDATE m2.corrective_actions SET status = 'closed', updated_at = NOW()
       WHERE id = :id::uuid AND status <> 'closed' RETURNING *`,
      [{ name: 'id', value: { stringValue: input.id as string } }],
    );
    if (!result.records || result.records.length === 0) {
      throw new Error('CAPA_NOT_FOUND_OR_ALREADY_CLOSED');
    }
    await txn.commit();
    await publishAuditEvent({
      tenantId,
      actor,
      module: 'M2',
      clauseRef: 'ISO 9001 10.2',
      standard: 'ISO9001',
      detailType: 'CAPA.Closed',
      source: 'cumplify.m2.capa',
      entityId: input.id as string,
      payload: {
        correctiveActionId: input.id,
        closureNotes: (input.closureNotes as string) ?? null,
      },
    });
    return marshalOne(result);
  } catch (err) {
    await txn.rollback();
    throw err;
  }
}

async function verifyEffectiveness(event: AppSyncEvent, tenantId: string, actor: string) {
  const input = event.arguments.input as Record<string, unknown>;
  const txn = await beginTenantTransaction(tenantId);
  try {
    // FIXED 2026-07-14 (architect): previous SQL set effectiveness_* columns that
    // do not exist on m2.corrective_actions; the ratified home for verification
    // is m2.capa_effectiveness_checks (migration 003). Input fields per
    // VerifyEffectivenessInput { correctiveActionId, verificationMethod, effective };
    // return type CapaEffectivenessCheck!. An effective check also advances the
    // CA to 'verified' (CHECK includes it; the M2 timeline derives from CA status).
    const effective = input.effective === true;
    const result = await txn.execute(
      `INSERT INTO m2.capa_effectiveness_checks (tenant_id, corrective_action_id, verification_method, verified_by, verified_at, effective, created_by)
       VALUES (:tenantId, :caId::uuid, :method, :actor, NOW(), :effective, :actor)
       RETURNING *`,
      [
        { name: 'tenantId', value: { stringValue: tenantId } },
        { name: 'caId', value: { stringValue: input.correctiveActionId as string } },
        { name: 'method', value: { stringValue: input.verificationMethod as string } },
        { name: 'effective', value: { booleanValue: effective } },
        { name: 'actor', value: { stringValue: actor } },
      ],
    );
    if (effective) {
      await txn.execute(
        `UPDATE m2.corrective_actions SET status = 'verified', updated_at = NOW()
         WHERE id = :caId::uuid AND status <> 'closed'`,
        [{ name: 'caId', value: { stringValue: input.correctiveActionId as string } }],
      );
    }
    await txn.commit();
    const check = marshalOne(result);
    await publishAuditEvent({
      tenantId,
      actor,
      module: 'M2',
      clauseRef: 'ISO 9001 10.2',
      standard: 'ISO9001',
      detailType: 'CAPA.EffectivenessVerified',
      source: 'cumplify.m2.capa',
      entityId: String(check?.id ?? ''), // the CapaEffectivenessCheck row the mutation returns
      payload: {
        effectivenessCheckId: check?.id,
        correctiveActionId: input.correctiveActionId,
        effective,
      },
    });
    return check;
  } catch (err) {
    await txn.rollback();
    throw err;
  }
}

async function disposeNonconformingOutput(event: AppSyncEvent, tenantId: string, actor: string) {
  const input = event.arguments.input as Record<string, unknown>;
  const disposition = mapEnum(DISPOSITION_MAP, input.disposition as string, 'disposition');
  const txn = await beginTenantTransaction(tenantId);
  try {
    const result = await txn.execute(
      `INSERT INTO m2.nonconforming_outputs (tenant_id, nc_id, disposition, authorized_by, created_by)
       VALUES (:tenantId, :ncId::uuid, :disposition, :actor, :actor)
       RETURNING *`,
      [
        { name: 'tenantId', value: { stringValue: tenantId } },
        { name: 'ncId', value: { stringValue: input.ncId as string } },
        { name: 'disposition', value: { stringValue: disposition } },
        { name: 'actor', value: { stringValue: actor } },
      ],
    );
    await txn.commit();
    const output = marshalOne(result);
    await publishAuditEvent({
      tenantId,
      actor,
      module: 'M2',
      clauseRef: 'ISO 9001 8.7',
      standard: 'ISO9001',
      detailType: 'CAPA.OutputDisposed',
      source: 'cumplify.m2.capa',
      entityId: String(output?.id ?? ''), // the NonconformingOutput row the mutation returns
      payload: {
        nonconformingOutputId: output?.id,
        ncId: input.ncId,
        disposition: input.disposition,
      },
    });
    return output;
  } catch (err) {
    await txn.rollback();
    throw err;
  }
}

async function getNonconformity(event: AppSyncEvent, tenantId: string) {
  const txn = await beginTenantTransaction(tenantId);
  try {
    const result = await txn.execute(`SELECT * FROM m2.nonconformities WHERE id = :id::uuid`, [
      { name: 'id', value: { stringValue: event.arguments.id as string } },
    ]);
    await txn.commit();
    return marshalOne(result);
  } catch (err) {
    await txn.rollback();
    throw err;
  }
}

async function listOpenCAPAs(event: AppSyncEvent, tenantId: string) {
  // FIXED 2026-07-13 (architect): previous SQL referenced nc.title (column
  // does not exist) and joined on ca.nonconformity_id (column is nc_id) —
  // the query errored on every live call. Filters (standard, severity) are
  // declared in the schema and honored here; both live on the NC row.
  const clauses: string[] = [`ca.status IN ('open', 'in_progress')`];
  const params: Array<{ name: string; value: { stringValue: string } }> = [];
  const standard = event.arguments.standard as string | undefined;
  const severity = event.arguments.severity as string | undefined;
  if (standard) {
    clauses.push('nc.standard = :standard');
    params.push({ name: 'standard', value: { stringValue: standard } });
  }
  if (severity) {
    clauses.push('nc.severity = :severity');
    params.push({
      name: 'severity',
      value: { stringValue: mapEnum(SEVERITY_MAP, severity, 'severity') },
    });
  }
  const txn = await beginTenantTransaction(tenantId);
  try {
    const result = await txn.execute(
      `SELECT ca.* FROM m2.corrective_actions ca
       JOIN m2.nonconformities nc ON nc.id = ca.nc_id
       WHERE ${clauses.join(' AND ')} ORDER BY ca.due_date ASC LIMIT ${LIST_QUERY_LIMIT}`,
      params,
    );
    await txn.commit();
    return marshalMany(result);
  } catch (err) {
    await txn.rollback();
    throw err;
  }
}

async function listNonconformities(event: AppSyncEvent, tenantId: string) {
  const clauses: string[] = [];
  const params: Array<{ name: string; value: { stringValue: string } }> = [];
  const standard = event.arguments.standard as string | undefined;
  const severity = event.arguments.severity as string | undefined;
  if (standard) {
    clauses.push('standard = :standard');
    params.push({ name: 'standard', value: { stringValue: standard } });
  }
  if (severity) {
    clauses.push('severity = :severity');
    params.push({
      name: 'severity',
      value: { stringValue: mapEnum(SEVERITY_MAP, severity, 'severity') },
    });
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const txn = await beginTenantTransaction(tenantId);
  try {
    const result = await txn.execute(
      `SELECT * FROM m2.nonconformities ${where} ORDER BY raised_at DESC LIMIT ${LIST_QUERY_LIMIT}`,
      params,
    );
    await txn.commit();
    return marshalMany(result);
  } catch (err) {
    await txn.rollback();
    throw err;
  }
}

async function listCorrectiveActions(event: AppSyncEvent, tenantId: string) {
  const txn = await beginTenantTransaction(tenantId);
  try {
    const result = await txn.execute(
      `SELECT * FROM m2.corrective_actions WHERE nc_id = :ncId::uuid ORDER BY created_at ASC LIMIT ${LIST_QUERY_LIMIT}`,
      [{ name: 'ncId', value: { stringValue: event.arguments.ncId as string } }],
    );
    await txn.commit();
    return marshalMany(result);
  } catch (err) {
    await txn.rollback();
    throw err;
  }
}
