/**
 * M3 Audit Studio resolver.
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
} from './shared.js';
import { mapEnum, FINDING_TYPE_MAP } from './enum-mappings.js';

const logger = new Logger({ serviceName: 'resolver-m3' });
const lambdaClient = new LambdaClient({});

interface AppSyncEvent {
  info: { fieldName: string };
  arguments: Record<string, unknown>;
  identity?: {
    resolverContext?: Record<string, string>;
    userArn?: string;
    username?: string;
  };
}

const AGENT_FIELDS = new Set(['agentGenerateChecklist', 'agentScoreReadiness']);

// M-effort: server-side bound on list queries (mirror forms' LIST_MAX_LIMIT).
const LIST_QUERY_LIMIT = 500;

// M-effort: every id the resolver casts to ::uuid is validated as a UUID up
// front — a malformed id gets a clean VALIDATION error instead of a Postgres
// cast failure (or a silent no-match update).
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
function assertUuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new Error(`VALIDATION: ${field} must be a UUID`);
  }
}

export async function handler(event: AppSyncEvent): Promise<unknown> {
  // RS-7: agent* (@aws_iam) fields never carry resolverContext — branch
  // BEFORE extractContext, which would throw for them.
  if (AGENT_FIELDS.has(event.info.fieldName)) {
    const { tenantId, actor } = extractAgentContext(event.arguments, 'LeadAuditor', event.identity);
    logger.appendKeys({ tenantId, requestField: event.info.fieldName });
    return event.info.fieldName === 'agentGenerateChecklist'
      ? generateAuditChecklist(event, tenantId, actor) // one implementation, two entry points
      : agentScoreReadiness(event, tenantId, actor);
  }

  const ctx = extractContext(event);
  const { tenantId, sub, role } = ctx;
  logger.appendKeys({ tenantId, requestField: event.info.fieldName });

  // M-effort: M3 write mutations are role-gated at entry (Part 13 matrix);
  // queries stay at the authenticated floor.
  switch (event.info.fieldName) {
    case 'createAuditProgramme':
      return requireModuleRole(role, 'M3', () => createAuditProgramme(event, tenantId, sub));
    case 'scheduleAudit':
      return requireModuleRole(role, 'M3', () => scheduleAudit(event, tenantId, sub));
    case 'recordFinding':
      return requireModuleRole(role, 'M3', () => recordFinding(event, tenantId, sub));
    case 'completeAudit':
      return requireModuleRole(role, 'M3', () => completeAudit(event, tenantId, sub));
    case 'getAudit':
      return getAudit(event, tenantId);
    case 'listAudits':
      return listAudits(tenantId);
    case 'listAuditFindings':
      return listAuditFindings(event, tenantId);
    case 'listAuditChecklists':
      return listAuditChecklists(event, tenantId);
    case 'runAuditFindings':
      return requireModuleRole(role, 'M3', () => runAuditFindings(event, tenantId, sub));
    case 'getAuditReadiness':
      return getAuditReadiness(event, tenantId);
    case 'generateAuditChecklist':
      return requireModuleRole(role, 'M3', () =>
        generateAuditChecklist(event, tenantId, sub),
      );
    default:
      throw new Error(`Unknown field: ${event.info.fieldName}`);
  }
}

async function createAuditProgramme(event: AppSyncEvent, tenantId: string, actor: string) {
  const input = event.arguments.input as Record<string, unknown>;
  const txn = await beginTenantTransaction(tenantId);
  try {
    const result = await txn.execute(
      `INSERT INTO m3.audit_programmes (tenant_id, standard, year, frequency_plan, status, created_by)
       VALUES (:tenantId, :standard, :year, :frequencyPlan, 'active', :actor)
       RETURNING *`,
      [
        { name: 'tenantId', value: { stringValue: tenantId } },
        { name: 'standard', value: { stringValue: input.standard as string } },
        { name: 'year', value: { longValue: input.year as number } },
        {
          name: 'frequencyPlan',
          value: input.frequencyPlan
            ? { stringValue: input.frequencyPlan as string }
            : { isNull: true },
        },
        { name: 'actor', value: { stringValue: actor } },
      ],
    );
    await txn.commit();
    const programme = marshalOne(result);
    await publishAuditEvent({
      tenantId,
      actor,
      module: 'M3',
      clauseRef: 'ISO 9001 9.2',
      standard: 'ISO9001',
      detailType: 'Audit.ProgrammeCreated',
      source: 'cumplify.m3.audit-studio',
      entityId: String(programme?.id ?? ''),
      payload: { programmeId: programme?.id, input },
    });
    logger.info('Audit programme created', { tenantId });
    return programme;
  } catch (err) {
    await txn.rollback();
    throw err;
  }
}

async function scheduleAudit(event: AppSyncEvent, tenantId: string, actor: string) {
  const input = event.arguments.input as Record<string, unknown>;
  assertUuid(input.programmeId, 'programmeId');
  const txn = await beginTenantTransaction(tenantId);
  try {
    const result = await txn.execute(
      `INSERT INTO m3.audits (tenant_id, programme_id, standard, scope, lead_auditor_id, planned_date, status, created_by)
       VALUES (:tenantId, :programmeId::uuid, :standard, :scope, :leadAuditor, :plannedDate::timestamptz, 'planned', :actor)
       RETURNING *`,
      [
        { name: 'tenantId', value: { stringValue: tenantId } },
        { name: 'programmeId', value: { stringValue: input.programmeId as string } },
        { name: 'standard', value: { stringValue: input.standard as string } },
        { name: 'scope', value: { stringValue: input.scope as string } },
        { name: 'leadAuditor', value: { stringValue: input.leadAuditorId as string } },
        { name: 'plannedDate', value: { stringValue: input.plannedDate as string } },
        { name: 'actor', value: { stringValue: actor } },
      ],
    );
    await txn.commit();
    const audit = marshalOne(result);
    await publishAuditEvent({
      tenantId,
      actor,
      module: 'M3',
      clauseRef: 'ISO 9001 9.2',
      standard: 'ISO9001',
      detailType: 'Audit.Scheduled',
      source: 'cumplify.m3.audit-studio',
      entityId: String(audit?.id ?? ''), // the Audit row the mutation returns
      payload: {
        auditId: audit?.id,
        programmeId: input.programmeId,
        plannedDate: input.plannedDate,
      },
    });
    logger.info('Audit scheduled', { tenantId });
    return audit;
  } catch (err) {
    await txn.rollback();
    throw err;
  }
}

async function recordFinding(event: AppSyncEvent, tenantId: string, actor: string) {
  const input = event.arguments.input as Record<string, unknown>;
  assertUuid(input.auditId, 'auditId');
  if (input.checklistId !== undefined && input.checklistId !== null) {
    assertUuid(input.checklistId, 'checklistId');
  }
  const findingType = mapEnum(FINDING_TYPE_MAP, input.findingType as string, 'findingType');
  const txn = await beginTenantTransaction(tenantId);
  try {
    const result = await txn.execute(
      `INSERT INTO m3.audit_findings (tenant_id, audit_id, checklist_id, finding_type, clause_ref, description, evidence_ref, created_by)
       VALUES (:tenantId, :auditId::uuid, :checklistId::uuid, :findingType, :clauseRef, :description, :evidenceRef, :actor)
       RETURNING *`,
      [
        { name: 'tenantId', value: { stringValue: tenantId } },
        { name: 'auditId', value: { stringValue: input.auditId as string } },
        {
          name: 'checklistId',
          value: input.checklistId
            ? { stringValue: input.checklistId as string }
            : { isNull: true },
        },
        { name: 'findingType', value: { stringValue: findingType } },
        { name: 'clauseRef', value: { stringValue: input.clauseRef as string } },
        { name: 'description', value: { stringValue: input.description as string } },
        {
          name: 'evidenceRef',
          value: input.evidenceRef
            ? { stringValue: input.evidenceRef as string }
            : { isNull: true },
        },
        { name: 'actor', value: { stringValue: actor } },
      ],
    );
    await txn.commit();
    const finding = marshalOne(result);
    await publishAuditEvent({
      tenantId,
      actor,
      module: 'M3',
      clauseRef: 'ISO 9001 9.2',
      standard: 'ISO9001',
      detailType: 'Audit.FindingRaised',
      source: 'cumplify.m3.audit-studio',
      entityId: String(finding?.id ?? ''), // the AuditFinding row the mutation returns
      payload: {
        findingId: finding?.id,
        auditId: input.auditId,
        findingType: input.findingType,
        clauseRef: input.clauseRef,
      },
    });
    return finding;
  } catch (err) {
    await txn.rollback();
    throw err;
  }
}

async function completeAudit(event: AppSyncEvent, tenantId: string, actor: string) {
  const id = event.arguments.id as string;
  assertUuid(id, 'id');
  const txn = await beginTenantTransaction(tenantId);
  try {
    // M-effort: status predicate rides the UPDATE — a concurrent complete can
    // no longer double-complete (and double-emit Audit.Completed for) the row.
    const result = await txn.execute(
      `UPDATE m3.audits SET status = 'completed', actual_date = NOW(), updated_at = NOW()
       WHERE id = :id::uuid AND status <> 'completed' RETURNING *`,
      [{ name: 'id', value: { stringValue: id } }],
    );
    if (!result.records || result.records.length === 0) {
      throw new Error('AUDIT_NOT_FOUND_OR_ALREADY_COMPLETED');
    }
    await txn.commit();
    await publishAuditEvent({
      tenantId,
      actor,
      module: 'M3',
      clauseRef: 'ISO 9001 9.2',
      standard: 'ISO9001',
      detailType: 'Audit.Completed',
      source: 'cumplify.m3.audit-studio',
      entityId: id,
      payload: { auditId: id },
    });
    return marshalOne(result);
  } catch (err) {
    await txn.rollback();
    throw err;
  }
}

async function getAudit(event: AppSyncEvent, tenantId: string) {
  assertUuid(event.arguments.id, 'id');
  const txn = await beginTenantTransaction(tenantId);
  try {
    const result = await txn.execute(`SELECT * FROM m3.audits WHERE id = :id::uuid`, [
      { name: 'id', value: { stringValue: event.arguments.id as string } },
    ]);
    await txn.commit();
    return marshalOne(result);
  } catch (err) {
    await txn.rollback();
    throw err;
  }
}

async function getAuditReadiness(event: AppSyncEvent, tenantId: string) {
  const standard = event.arguments.standard as string;
  const txn = await beginTenantTransaction(tenantId);
  try {
    const result = await txn.execute(
      `SELECT * FROM m3.audit_readiness_scores WHERE standard = :standard ORDER BY clause_ref ASC`,
      [{ name: 'standard', value: { stringValue: standard } }],
    );
    await txn.commit();
    return marshalMany(result);
  } catch (err) {
    await txn.rollback();
    throw err;
  }
}

/**
 * agentScoreReadiness (RS-7, LeadAuditor writeback door) — upserts
 * m3.audit_readiness_scores from the honest generation-section status
 * (spec-40 BC-3: never fabricated). For every registry clause of the
 * standard, the LATEST qms.generation_sections row covering that clause
 * (across all this tenant's generation runs) determines the score: 'prose'
 * or 'na_justified' (a resolved, justified state) = 100; 'gap'/'failed'/
 * 'pending'/never-generated = 0. Direct write, no HITL gate — computed
 * scoring, not a compliance decision (matches getAuditReadiness's existing
 * flat, un-gated read).
 */
async function agentScoreReadiness(event: AppSyncEvent, tenantId: string, actor: string) {
  const standard = event.arguments.standard as string;
  const txn = await beginTenantTransaction(tenantId);
  try {
    const result = await txn.execute(
      `
      SELECT cr.clause_no, gs.status
      FROM qms.clause_registry cr
      LEFT JOIN LATERAL (
        SELECT status FROM qms.generation_sections
        WHERE tenant_id = :tenantId AND cr.id = ANY(clause_registry_ids)
        ORDER BY created_at DESC LIMIT 1
      ) gs ON true
      WHERE cr.standard = :standard
      ORDER BY cr.sort_order
    `,
      [
        { name: 'tenantId', value: { stringValue: tenantId } },
        { name: 'standard', value: { stringValue: standard } },
      ],
    );

    const rows = result.records ?? [];
    for (const row of rows) {
      const clauseRef = (row[0] as { stringValue?: string }).stringValue!;
      const status = (row[1] as { stringValue?: string; isNull?: boolean }).stringValue;
      const score = status === 'prose' || status === 'na_justified' ? 100.0 : 0.0;
      await txn.execute(
        `INSERT INTO m3.audit_readiness_scores (tenant_id, standard, clause_ref, score, assessed_at, created_by)
         VALUES (:tenantId, :standard, :clauseRef, :score, NOW(), :actor)
         ON CONFLICT (tenant_id, standard, clause_ref)
         DO UPDATE SET score = EXCLUDED.score, assessed_at = NOW(), updated_at = NOW(), version = m3.audit_readiness_scores.version + 1
         RETURNING id`,
        [
          { name: 'tenantId', value: { stringValue: tenantId } },
          { name: 'standard', value: { stringValue: standard } },
          { name: 'clauseRef', value: { stringValue: clauseRef } },
          { name: 'score', value: { doubleValue: score } },
          { name: 'actor', value: { stringValue: actor } },
        ],
      );
    }

    const scoresResult = await txn.execute(
      `SELECT * FROM m3.audit_readiness_scores WHERE standard = :standard AND tenant_id = :tenantId ORDER BY clause_ref ASC`,
      [
        { name: 'standard', value: { stringValue: standard } },
        { name: 'tenantId', value: { stringValue: tenantId } },
      ],
    );
    await txn.commit();

    await publishAuditEvent({
      tenantId,
      actor,
      module: 'M3',
      clauseRef: '9.1',
      standard: standard as 'ISO9001' | 'ISO14001' | 'ISO45001',
      detailType: 'Readiness.Scored',
      source: 'cumplify.m3.audit-studio',
      entityId: standard,
      payload: { standard, clauseCount: rows.length },
    });

    logger.info('Agent readiness scoring complete', { tenantId, standard, clauseCount: rows.length });
    return marshalMany(scoresResult);
  } catch (err) {
    await txn.rollback();
    throw err;
  }
}

/**
 * generateAuditChecklist(auditId) — M3-native checklist generator (spec 41, Task 9).
 *
 * Validates audit exists (::uuid, tenant txn), reads audit.standard, queries
 * qms.clause_registry for that standard, INSERTs one m3.audit_checklists row per clause.
 * Idempotent: ON CONFLICT (audit_id, clause_ref) DO NOTHING (migration 015).
 * Findings link via existing m3.audit_findings.checklist_id — no new relation plumbing.
 *
 * clause_ref = clause_no from registry.
 * question = "Does the organization ... ?" wrapper around intent_paraphrase.
 * expected_evidence = required_sources tokens joined.
 */
async function generateAuditChecklist(event: AppSyncEvent, tenantId: string, actor: string) {
  const auditId = event.arguments.auditId as string;
  assertUuid(auditId, 'auditId');
  const txn = await beginTenantTransaction(tenantId);
  try {
    // 1. Validate audit exists and get its standard
    const auditResult = await txn.execute(
      `SELECT id, standard FROM m3.audits WHERE id = :id::uuid`,
      [{ name: 'id', value: { stringValue: auditId } }],
    );
    if (!auditResult.records || auditResult.records.length === 0) {
      throw new Error('AUDIT_NOT_FOUND');
    }
    const auditRow = auditResult.records[0];
    const standardIdx = auditResult.columnMetadata!.findIndex((c) => c.name === 'standard');
    const auditStandard = (auditRow[standardIdx] as { stringValue?: string }).stringValue!;

    // 2. Query clause registry for that standard
    const clauseResult = await txn.execute(
      `
      SELECT id, clause_no, clause_title, intent_paraphrase, required_sources
      FROM qms.clause_registry
      WHERE standard = :standard
      ORDER BY sort_order
    `,
      [{ name: 'standard', value: { stringValue: auditStandard } }],
    );

    if (!clauseResult.records || clauseResult.records.length === 0) {
      throw new Error('NO_CLAUSES_FOR_STANDARD');
    }

    // 3. INSERT one m3.audit_checklists row per clause (idempotent: ON CONFLICT skip)
    let insertedCount = 0;
    for (const row of clauseResult.records) {
      const clauseNo = (row[1] as { stringValue?: string }).stringValue!;
      const intentParaphrase = (row[3] as { stringValue?: string }).stringValue!;
      const requiredSourcesRaw = (row[4] as { stringValue?: string }).stringValue ?? '[]';

      // question: "Does the organization ...?" wrapper around our own paraphrase
      const question =
        `Does the organization ${intentParaphrase.charAt(0).toLowerCase()}${intentParaphrase.slice(1)}`.replace(
          /[.\s]*$/,
          '?',
        );
      // expected_evidence: join required_sources tokens
      let expectedEvidence: string;
      try {
        const sources = JSON.parse(requiredSourcesRaw) as string[];
        expectedEvidence = sources.length > 0 ? sources.join(', ') : (null as unknown as string);
      } catch {
        expectedEvidence = null as unknown as string;
      }

      const insertResult = await txn.execute(
        `
        INSERT INTO m3.audit_checklists (tenant_id, audit_id, clause_ref, question, expected_evidence, created_by)
        VALUES (:tenantId, :auditId::uuid, :clauseRef, :question, :expectedEvidence, :actor)
        ON CONFLICT (audit_id, clause_ref) DO NOTHING
        RETURNING id
      `,
        [
          { name: 'tenantId', value: { stringValue: tenantId } },
          { name: 'auditId', value: { stringValue: auditId } },
          { name: 'clauseRef', value: { stringValue: clauseNo } },
          { name: 'question', value: { stringValue: question } },
          {
            name: 'expectedEvidence',
            value: expectedEvidence ? { stringValue: expectedEvidence } : { isNull: true },
          },
          { name: 'actor', value: { stringValue: actor } },
        ],
      );
      if (insertResult.records && insertResult.records.length > 0) {
        insertedCount++;
      }
    }

    // 4. Fetch all checklist rows for this audit (includes pre-existing + newly inserted)
    const checklistResult = await txn.execute(
      `
      SELECT id, audit_id, clause_ref, question, expected_evidence
      FROM m3.audit_checklists
      WHERE audit_id = :auditId::uuid
      ORDER BY clause_ref
    `,
      [{ name: 'auditId', value: { stringValue: auditId } }],
    );

    await txn.commit();

    // 5. Publish advisory event (Audit.ChecklistGenerated already registered, auditTrail: false)
    await publishAuditEvent({
      tenantId,
      actor,
      module: 'M3',
      clauseRef: '9.2',
      standard: auditStandard as 'ISO9001' | 'ISO14001' | 'ISO45001',
      detailType: 'Audit.ChecklistGenerated',
      source: 'cumplify.m3.audit-studio',
      entityId: auditId, // checklist rows are many — the audit is the entity
      payload: {
        auditId,
        standard: auditStandard,
        clauseCount: clauseResult.records.length,
        insertedCount,
      },
    });

    logger.info('Audit checklist generated', {
      tenantId,
      auditId,
      standard: auditStandard,
      clauseCount: clauseResult.records.length,
    });
    return marshalMany(checklistResult);
  } catch (err) {
    try {
      await txn.rollback();
    } catch {
      /* never mask */
    }
    throw err;
  }
}


// ─── S4 Audit Studio read surfaces + LeadAuditor findings dispatch ──────────

async function listAudits(tenantId: string) {
  const txn = await beginTenantTransaction(tenantId);
  try {
    const result = await txn.execute(
      `SELECT id, programme_id, standard, scope, lead_auditor_id, planned_date, actual_date, status
       FROM m3.audits ORDER BY planned_date DESC LIMIT ${LIST_QUERY_LIMIT}`,
    );
    await txn.commit();
    return marshalMany(result);
  } catch (err) {
    try {
      await txn.rollback();
    } catch {
      /* never mask */
    }
    throw err;
  }
}

async function listAuditFindings(event: AppSyncEvent, tenantId: string) {
  const auditId = (event.arguments.auditId as string) ?? '';
  assertUuid(auditId, 'auditId');
  const txn = await beginTenantTransaction(tenantId);
  try {
    const result = await txn.execute(
      `SELECT id, audit_id, checklist_id, finding_type, clause_ref, description, evidence_ref
       FROM m3.audit_findings WHERE audit_id = :auditId::uuid ORDER BY created_at DESC LIMIT ${LIST_QUERY_LIMIT}`,
      [{ name: 'auditId', value: { stringValue: auditId } }],
    );
    await txn.commit();
    // finding_type is stored lowercase-underscored; the enum is UPPERCASE
    return marshalMany(result).map((r) => ({
      ...r,
      findingType: String(r.findingType).toUpperCase(),
    }));
  } catch (err) {
    try {
      await txn.rollback();
    } catch {
      /* never mask */
    }
    throw err;
  }
}

async function listAuditChecklists(event: AppSyncEvent, tenantId: string) {
  const auditId = (event.arguments.auditId as string) ?? '';
  assertUuid(auditId, 'auditId');
  const txn = await beginTenantTransaction(tenantId);
  try {
    const result = await txn.execute(
      `SELECT id, audit_id, clause_ref, question, expected_evidence
       FROM m3.audit_checklists WHERE audit_id = :auditId::uuid ORDER BY clause_ref LIMIT ${LIST_QUERY_LIMIT}`,
      [{ name: 'auditId', value: { stringValue: auditId } }],
    );
    await txn.commit();
    return marshalMany(result);
  } catch (err) {
    try {
      await txn.rollback();
    } catch {
      /* never mask */
    }
    throw err;
  }
}

/**
 * runAuditFindings (S4 Audit Studio) — LeadAuditor reviews the audit's
 * checklist + prior findings and proposes the MOST SIGNIFICANT new finding
 * via the audit-finding-write HITL card. Fire-and-forget Event invoke
 * (runNcIntake pattern); reads ride in the payload — the agent never touches
 * the DB. Approving a major/minor NC finding also opens the NC in CAPA
 * Studio (writeback cross-studio link).
 */
async function runAuditFindings(event: AppSyncEvent, tenantId: string, actor: string) {
  const leadAuditorFnArn = process.env.LEAD_AUDITOR_FN_ARN ?? '';
  const auditId = (event.arguments.auditId as string) ?? '';
  assertUuid(auditId, 'auditId');
  if (!leadAuditorFnArn) throw new Error('LEAD_AUDITOR_NOT_AVAILABLE');

  const txn = await beginTenantTransaction(tenantId);
  let audit: Record<string, unknown> | null;
  let checklist: Array<Record<string, unknown>>;
  let priorFindings: Array<Record<string, unknown>>;
  try {
    const auditResult = await txn.execute(
      `SELECT id, standard, scope, status FROM m3.audits WHERE id = :id::uuid`,
      [{ name: 'id', value: { stringValue: auditId } }],
    );
    audit = marshalOne(auditResult);
    if (!audit) {
      await txn.commit();
      throw new Error('AUDIT_NOT_FOUND');
    }
    const clResult = await txn.execute(
      `SELECT clause_ref, question, expected_evidence FROM m3.audit_checklists
       WHERE audit_id = :id::uuid ORDER BY clause_ref LIMIT 50`,
      [{ name: 'id', value: { stringValue: auditId } }],
    );
    checklist = marshalMany(clResult);
    const fResult = await txn.execute(
      `SELECT finding_type, clause_ref, description FROM m3.audit_findings
       WHERE audit_id = :id::uuid ORDER BY created_at DESC LIMIT 20`,
      [{ name: 'id', value: { stringValue: auditId } }],
    );
    priorFindings = marshalMany(fResult);
    await txn.commit();
  } catch (err) {
    try {
      await txn.rollback();
    } catch {
      /* never mask */
    }
    throw err;
  }

  const runId = ulid();
  await lambdaClient.send(
    new InvokeCommand({
      FunctionName: leadAuditorFnArn,
      InvocationType: 'Event',
      Payload: JSON.stringify({
        tenantId,
        runId,
        requestedBy: actor,
        findingsIntent: {
          auditId,
          audit: { standard: audit.standard, scope: audit.scope, status: audit.status },
          checklist,
          priorFindings,
        },
      }),
    }),
  );

  logger.info('Audit findings run dispatched', { tenantId, runId, auditId });
  return { runId, status: 'DISPATCHED' };
}
