/**
 * ExecuteWriteback Lambda — invoked by Step Functions AFTER human approval.
 * The ONLY code path with RDS write permissions (via app_role, T4-F1).
 *
 * T-8a (BINDING): set_config('app.tenant_id', :tid, true) as the FIRST
 * statement of EVERY transaction (C-2/RLS scoping on the app_role path).
 *
 * T-8b (BINDING): this Lambda is invocable ONLY by the HITL state-machine role
 * (identity grant via grantInvoke — no resource-based policy).
 *
 * C-3 (Task 8R): SQL fixed against live migration schemas:
 *   - capa-open: includes due_date (NOT NULL in 003)
 *   - audit-checklist-gen: includes created_by (NOT NULL in 004)
 *   - audit-finding-write: maps finding_type hyphens→underscores at dispatch
 *   - ct-governance-write: BLOCKED-ON-DESIGN (no m1.roles_responsibilities table)
 *   - dispatch covers ALL HITL tools declared by handlers
 *
 * M-1 (Task 8R): BeginTransaction wrapped in Aurora resume-retry.
 * M-2 (Task 8R): created_by persists full actor (agent:<name>+human:<sub>).
 *
 * H-3 (Task 8R): uses publishAuditEvent from eventing publisher (ULID, registry).
 *
 * 2026-07-16 (owner-approved cleanup): Agent.WritebackCommitted now carries
 * the written row's id as envelope entityId (writtenRow captures RETURNING
 * id) — feeds the audit ledger's GSI1 per-entity lookup. records-retention-
 * schedule SQL rewritten to migration-005 truth (see fn comment).
 */

import {
  RDSDataClient,
  BeginTransactionCommand,
  ExecuteStatementCommand,
  CommitTransactionCommand,
  RollbackTransactionCommand,
} from '@aws-sdk/client-rds-data';
import { Logger } from '@aws-lambda-powertools/logger';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { publish } from '../../eventing/src/publisher.js';
import type { Context } from 'aws-lambda';
import { ulid } from 'ulid';

const logger = new Logger({ serviceName: 'execute-writeback' });
const rds = new RDSDataClient({});

const CLUSTER_ARN = process.env.CLUSTER_ARN!;
const SECRET_ARN = process.env.APP_ROLE_SECRET_ARN!; // T4-F1: app_role, NOT master
const DB_NAME = process.env.DB_NAME ?? 'postgres'; // C-3e: must match api-core
const BUS_NAME = process.env.BUS_NAME ?? 'cumplify-events';

export interface WritebackInput {
  tenantId: string;
  agentName: string;
  proposedAction: { tool: string; args: Record<string, unknown> };
  /**
   * SendTaskSuccess output from the approval Lambda — the owner-signed
   * frontend-app design §2.3 step 7a contract:
   * { decision:'APPROVE', approverSub, editedPayload?, justification? }.
   * (BUG-15: this module previously expected {approved, approver, role,
   * timestamp} — a shape only Task 11's hand-crafted CLI callback ever sent —
   * so every real human APPROVE was silently treated as rejected.)
   */
  approvalResult: {
    decision: 'APPROVE' | 'SEND_BACK';
    approverSub: string;
    justification?: string;
    editedPayload?: Record<string, unknown>;
  };
  hitlItemId: string;
}

// ─── Aurora resume-retry (M-1, ACC-1 pattern) ────────────────────────────────
// First call after 0-ACU auto-pause throws DatabaseResumingException.
const MAX_RESUME_RETRIES = 3;
const RESUME_DELAY_MS = 15_000;
// Minimum remaining execution time needed to attempt one more resume cycle
// (one request + one delay + margin for rollback/commit).
const MIN_REMAINING_MS = 30_000;

async function withResumeRetry<T>(
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

// ─── Finding type mapping (C-3d) ────────────────────────────────────────────
// The model prompt uses hyphenated values (major-nc, minor-nc) but the DB
// CHECK constraint requires underscored values (major_nc, minor_nc).
// Map at the dispatch layer — do NOT re-prompt the model.
const FINDING_TYPE_MAP: Record<string, string> = {
  'major-nc': 'major_nc',
  'minor-nc': 'minor_nc',
  observation: 'observation',
  ofi: 'ofi',
};

function mapFindingType(raw: string): string {
  const mapped = FINDING_TYPE_MAP[raw];
  if (!mapped) {
    throw new Error(
      `Invalid finding_type: '${raw}'. Expected: ${Object.keys(FINDING_TYPE_MAP).join(', ')}`,
    );
  }
  return mapped;
}

export async function handler(
  event: WritebackInput | { Payload: WritebackInput },
  context?: Context,
): Promise<{ status: string; auditEventId?: string }> {
  // Task-11 hotfix: the SFN lambda:invoke integration with `'Payload.$': '$'`
  // delivers the STATE as the event — there is no {Payload:...} wrapper on
  // input (the wrapper exists only in state OUTPUT). Accept both shapes.
  const input: WritebackInput = 'Payload' in event ? event.Payload : event;
  const { tenantId, agentName, proposedAction, approvalResult } = input;

  if (approvalResult.decision !== 'APPROVE') {
    logger.info('Writeback rejected by human', {
      tenantId,
      agentName,
      hitlItemId: input.hitlItemId,
    });
    return { status: 'REJECTED' };
  }

  // M-2: full actor identity for provenance (persists into DB rows + audit)
  const actor = `agent:${agentName}+human:${approvalResult.approverSub}`;

  // Approve-with-edits: the approver's editedPayload overrides the agent's
  // proposed args field-by-field (design §2.3 — edits ride the task token,
  // never the DDB item).
  const effectiveAction = approvalResult.editedPayload
    ? { ...proposedAction, args: { ...proposedAction.args, ...approvalResult.editedPayload } }
    : proposedAction;

  logger.info('Executing approved writeback', {
    tenantId,
    agentName,
    tool: effectiveAction.tool,
    approver: approvalResult.approverSub,
    edited: Boolean(approvalResult.editedPayload),
  });

  // M-1: Begin transaction with Aurora resume-retry (bounded by the
  // remaining invocation budget so resume cycles cannot burn to hard timeout).
  const txnResult = await withResumeRetry(
    () =>
      rds.send(
        new BeginTransactionCommand({
          resourceArn: CLUSTER_ARN,
          secretArn: SECRET_ARN,
          database: DB_NAME,
        }),
      ),
    context?.getRemainingTimeInMillis.bind(context),
  );
  const transactionId = txnResult.transactionId!;

  try {
    // T-8a (BINDING, C-2): set_config FIRST — RLS scoping on the app_role path.
    await rds.send(
      new ExecuteStatementCommand({
        resourceArn: CLUSTER_ARN,
        secretArn: SECRET_ARN,
        database: DB_NAME,
        transactionId,
        sql: "SELECT set_config('app.tenant_id', :tid, true)",
        parameters: [{ name: 'tid', value: { stringValue: tenantId } }],
      }),
    );

    // Dispatch the tool-specific write
    const writeResult = await dispatchToolWrite(effectiveAction, tenantId, transactionId, actor);

    // Commit
    await rds.send(
      new CommitTransactionCommand({
        resourceArn: CLUSTER_ARN,
        secretArn: SECRET_ARN,
        transactionId,
      }),
    );

    // H-3: Emit audit event via publishAuditEvent (registered, ULID, correct standard)
    const standard = resolveStandard(effectiveAction);
    const auditEventId = await emitWritebackAuditEvent({
      tenantId,
      actor,
      agentName,
      proposedAction: effectiveAction,
      writeResult,
      standard,
    });

    logger.info('Writeback committed + audit emitted', {
      tenantId,
      agentName,
      tool: effectiveAction.tool,
      auditEventId,
    });

    return { status: 'COMMITTED', auditEventId };
  } catch (err) {
    await rds
      .send(
        new RollbackTransactionCommand({
          resourceArn: CLUSTER_ARN,
          secretArn: SECRET_ARN,
          transactionId,
        }),
      )
      .catch(() => {}); // Best-effort rollback
    logger.error('Writeback failed, rolled back', { tenantId, error: (err as Error).message });
    throw err;
  }
}

/**
 * Resolve the ISO standard from the proposed action context.
 * H-3: never hardcode 'ISO9001' — derive from tool args or agent context.
 * Normalizes model output (e.g., "ISO 9001:2015", "iso 14001") to enum values.
 */
function resolveStandard(proposedAction: {
  tool: string;
  args: Record<string, unknown>;
}): 'ISO9001' | 'ISO14001' | 'ISO45001' {
  const raw = proposedAction.args.standard as string | undefined;
  if (raw) {
    const normalized = normalizeStandard(raw);
    if (normalized) return normalized;
  }
  // Default per tool's owning module
  const toolModuleMap: Record<string, 'ISO9001' | 'ISO14001' | 'ISO45001'> = {
    'capa-open': 'ISO9001',
    'capa-verify-effectiveness': 'ISO9001',
    'manual-section-draft': 'ISO9001',
    'doc-publish': 'ISO9001',
    'doc-version-control': 'ISO9001',
    'audit-finding-write': 'ISO9001',
    'audit-checklist-gen': 'ISO9001',
    'records-retention-schedule': 'ISO9001',
  };
  return toolModuleMap[proposedAction.tool] ?? 'ISO9001';
}

/**
 * Normalize free-text standard references to canonical enum values.
 * Handles: "ISO 9001:2015", "ISO9001", "iso 14001", "ISO 45001:2018", etc.
 */
function normalizeStandard(raw: string): 'ISO9001' | 'ISO14001' | 'ISO45001' | null {
  const stripped = raw.replace(/[\s:-]/g, '').toUpperCase();
  if (stripped.includes('45001')) return 'ISO45001';
  if (stripped.includes('14001')) return 'ISO14001';
  if (stripped.includes('9001')) return 'ISO9001';
  return null;
}

/**
 * Dispatch the tool-specific SQL write.
 * C-3 (Task 8R): covers ALL HITL-gated tools declared by handlers.
 * ct-governance-write is BLOCKED-ON-DESIGN — throws with a clear message.
 */
async function dispatchToolWrite(
  action: { tool: string; args: Record<string, unknown> },
  tenantId: string,
  transactionId: string,
  actor: string,
): Promise<Record<string, unknown>> {
  switch (action.tool) {
    case 'capa-open':
      return executeCapaOpen(action.args, tenantId, transactionId, actor);
    case 'capa-verify-effectiveness':
      return executeCapaVerifyEffectiveness(action.args, tenantId, transactionId, actor);
    case 'doc-draft':
      return executeDocDraft(action.args, tenantId, transactionId, actor);
    case 'manual-section-draft':
      return executeManualSectionDraft(action.args, tenantId, actor);
    case 'doc-publish':
      return executeDocPublish(action.args, tenantId, transactionId);
    case 'doc-version-control':
      return executeDocVersionControl(action.args, tenantId, transactionId, actor);
    case 'audit-finding-write':
      return executeAuditFindingWrite(action.args, tenantId, transactionId, actor);
    case 'audit-checklist-gen':
      return executeChecklistGen(action.args, tenantId, transactionId, actor);
    case 'records-retention-schedule':
      return executeRecordsRetentionSchedule(action.args, tenantId, transactionId, actor);
    case 'nc-draft-write':
      return executeNcDraftWrite(action.args, tenantId, transactionId, actor);
    case 'rca-write':
      return executeRcaWrite(action.args, tenantId, transactionId, actor);
    case 'nc-triage-write':
      return executeNcTriageWrite(action.args, tenantId, transactionId, actor);
    case 'risk-assessment-write':
      return executeRiskAssessmentWrite(action.args, tenantId, transactionId, actor);
    case 'ct-governance-write':
      // C-3c: BLOCKED-ON-DESIGN — m1.roles_responsibilities does not exist in any migration.
      // Pending architect design ruling on the correct corpus target table.
      throw new Error(
        `Tool 'ct-governance-write' is BLOCKED-ON-DESIGN: target table m1.roles_responsibilities ` +
          `does not exist in migrations. Requires architect design ruling before implementation.`,
      );
    default:
      throw new Error(`Unknown writeback tool: '${action.tool}'`);
  }
}

// ─── Tool-specific write implementations ────────────────────────────────────

/**
 * Extract the written row's id from a RETURNING result (id is the FIRST
 * column of every tool's RETURNING clause). Feeds the envelope entityId on
 * Agent.WritebackCommitted — before 2026-07-16 these events carried no row
 * id at all, so neither the audit GSI nor the substring fallback could
 * associate them with an entity.
 */
function writtenRow(result: { records?: unknown[][] }): { records: number; id: string | null } {
  const first = result.records?.[0]?.[0] as { stringValue?: string } | undefined;
  return { records: result.records?.length ?? 0, id: first?.stringValue ?? null };
}

async function executeCapaOpen(
  args: Record<string, unknown>,
  _tenantId: string,
  transactionId: string,
  actor: string,
): Promise<Record<string, unknown>> {
  // C-3a: includes due_date (NOT NULL, no default in 003_m2_capa.sql:41)
  // M-2: created_by = full actor (agent:<name>+human:<sub>)
  const result = await rds.send(
    new ExecuteStatementCommand({
      resourceArn: CLUSTER_ARN,
      secretArn: SECRET_ARN,
      database: DB_NAME,
      transactionId,
      sql: `INSERT INTO m2.corrective_actions (tenant_id, nc_id, action_desc, owner_id, due_date, status, created_by)
          VALUES (current_setting('app.tenant_id'), :ncId::uuid, :actionDesc, :ownerId, :dueDate::timestamptz, 'open', :actor)
          RETURNING id, status, due_date`,
      parameters: [
        { name: 'ncId', value: { stringValue: args.ncId as string } },
        { name: 'actionDesc', value: { stringValue: args.actionDesc as string } },
        { name: 'ownerId', value: { stringValue: args.suggestedOwnerId as string } },
        { name: 'dueDate', value: { stringValue: args.dueDate as string } },
        { name: 'actor', value: { stringValue: actor } },
      ],
    }),
  );
  return writtenRow(result);
}

async function executeCapaVerifyEffectiveness(
  args: Record<string, unknown>,
  _tenantId: string,
  transactionId: string,
  actor: string,
): Promise<Record<string, unknown>> {
  const result = await rds.send(
    new ExecuteStatementCommand({
      resourceArn: CLUSTER_ARN,
      secretArn: SECRET_ARN,
      database: DB_NAME,
      transactionId,
      sql: `INSERT INTO m2.capa_effectiveness_checks (tenant_id, corrective_action_id, verification_method, verified_by, verified_at, effective, created_by)
          VALUES (current_setting('app.tenant_id'), :capaId::uuid, :verificationMethod, :verifiedBy, NOW(), :effective::boolean, :actor)
          RETURNING id, effective`,
      parameters: [
        { name: 'capaId', value: { stringValue: args.capaId as string } },
        { name: 'verificationMethod', value: { stringValue: args.verificationMethod as string } },
        { name: 'verifiedBy', value: { stringValue: actor } },
        { name: 'effective', value: { stringValue: String(args.effective) } },
        { name: 'actor', value: { stringValue: actor } },
      ],
    }),
  );
  return writtenRow(result);
}

const s3 = new S3Client({});
const CONTENT_BUCKET = process.env.CONTENT_BUCKET ?? '';
const lambdaClient = new LambdaClient({});
// S3 Manual Studio: the GEN-6 regeneration engine, invoked by deterministic
// name with the HITL-approved sentences as an override.
const REGEN_FN_NAME = process.env.REGEN_FN_NAME ?? '';

/**
 * S2 (studio wave): doc-draft — DocStudio's whole-document draft,
 * approved: create the document (status 'draft'), its version-1 row, and
 * the version-1 ContentJson in S3 — the same shape the generation plane
 * writes (sections with harmonizationKey/kind/sentences), so the Tiptap
 * editor and ControlledDocViewer consume it with zero adaptation. The S3
 * key mirrors m1's versionContentKey scheme. docType/standard arrive
 * DB-ready from the tool schema; CHECK constraints are the backstop.
 * rationale lives in the Agent.WritebackCommitted payload only.
 */
/**
 * rca-write (C1 CAPA Studio RCA): INSERT the HITL-approved root-cause
 * analysis. findings arrives structured (whys/categories/tree) and is stored
 * as JSON text in m2.root_cause_analyses.findings (TEXT NOT NULL, 003);
 * method must satisfy the 003 CHECK ('5why','fishbone','fta').
 */
async function executeRcaWrite(
  args: Record<string, unknown>,
  _tenantId: string,
  transactionId: string,
  actor: string,
): Promise<Record<string, unknown>> {
  const ncId = args.ncId as string;
  const method = args.method as string;
  const findings = args.findings;
  const rootCauseSummary = args.rootCauseSummary as string;
  if (!ncId || !rootCauseSummary) throw new Error('RCA_WRITE_MISSING_FIELDS');
  if (!['5why', 'fishbone', 'fta'].includes(method)) {
    throw new Error(`RCA_WRITE_BAD_METHOD: '${method}'`);
  }
  if (!findings || typeof findings !== 'object') throw new Error('RCA_WRITE_FINDINGS_REQUIRED');

  const result = await rds.send(
    new ExecuteStatementCommand({
      resourceArn: CLUSTER_ARN,
      secretArn: SECRET_ARN,
      database: DB_NAME,
      transactionId,
      sql: `INSERT INTO m2.root_cause_analyses (tenant_id, nc_id, method, findings, root_cause_summary, created_by)
            VALUES (current_setting('app.tenant_id'), :ncId::uuid, :method, :findings, :summary, :actor)
            RETURNING id, method, root_cause_summary`,
      parameters: [
        { name: 'ncId', value: { stringValue: ncId } },
        { name: 'method', value: { stringValue: method } },
        { name: 'findings', value: { stringValue: JSON.stringify(findings) } },
        { name: 'summary', value: { stringValue: rootCauseSummary } },
        { name: 'actor', value: { stringValue: actor } },
      ],
    }),
  );
  return writtenRow(result);
}

/**
 * manual-section-draft (S3 Manual Studio) — the ONE writeback that DELEGATES
 * instead of writing SQL here: the GEN-6 regeneration engine already owns the
 * single-txn version derivation (manual + clause doc + correlation matrix +
 * master list refresh + run recompute); duplicating that here would fork the
 * corpus shape. The engine runs with the HITL-approved sentences as an
 * override (compose is skipped — nothing un-reviewed regenerates). The
 * wrapper Data-API txn stays empty; the engine's own transactions carry the
 * writes, and a FunctionError fails this writeback so the approval surfaces
 * the engine's typed error (RUN_NOT_FOUND, SECTION_NOT_FOUND, ...) verbatim.
 */
async function executeManualSectionDraft(
  args: Record<string, unknown>,
  tenantId: string,
  actor: string,
): Promise<Record<string, unknown>> {
  const generationRunId = args.generationRunId as string;
  const harmonizationKey = args.harmonizationKey as string;
  const sentences = (args.sentences ?? []) as Array<{ text: string }>;
  if (!generationRunId || !harmonizationKey) throw new Error('MANUAL_SECTION_DRAFT_MISSING_TARGET');
  if (!Array.isArray(sentences) || sentences.length === 0)
    throw new Error('MANUAL_SECTION_DRAFT_EMPTY');
  if (!REGEN_FN_NAME) throw new Error('REGEN_FN_UNCONFIGURED');

  const invoke = await lambdaClient.send(
    new InvokeCommand({
      FunctionName: REGEN_FN_NAME,
      Payload: JSON.stringify({
        tenantId,
        runId: generationRunId,
        harmonizationKey,
        actor,
        override: { sentences: sentences.map((s) => ({ text: String(s.text) })) },
      }),
    }),
  );
  if (invoke.FunctionError) {
    const raw = new TextDecoder().decode(invoke.Payload);
    let msg = 'REGENERATE_FAILED';
    try {
      msg = (JSON.parse(raw) as { errorMessage?: string }).errorMessage ?? msg;
    } catch {
      /* raw not json */
    }
    throw new Error(msg);
  }
  const section = JSON.parse(new TextDecoder().decode(invoke.Payload)) as Record<string, unknown>;
  return { records: 1, id: (section.id as string) ?? null };
}

async function executeDocDraft(
  args: Record<string, unknown>,
  tenantId: string,
  transactionId: string,
  actor: string,
): Promise<Record<string, unknown>> {
  const sections = (args.sections ?? []) as Array<{
    clauseRef: string;
    heading: string;
    body: string;
  }>;
  if (!CONTENT_BUCKET) throw new Error('CONTENT_BUCKET_UNCONFIGURED');
  if (sections.length === 0) throw new Error('DOC_DRAFT_EMPTY');

  const docResult = await rds.send(
    new ExecuteStatementCommand({
      resourceArn: CLUSTER_ARN,
      secretArn: SECRET_ARN,
      database: DB_NAME,
      transactionId,
      sql: `INSERT INTO m1.documents (tenant_id, standard, doc_type, title, owner_id, status, created_by)
            VALUES (current_setting('app.tenant_id'), :standard, :docType, :title, :actor, 'draft', :actor)
            RETURNING id, title, doc_type, standard`,
      parameters: [
        { name: 'standard', value: { stringValue: args.standard as string } },
        { name: 'docType', value: { stringValue: args.docType as string } },
        { name: 'title', value: { stringValue: args.title as string } },
        { name: 'actor', value: { stringValue: actor } },
      ],
    }),
  );
  const doc = writtenRow(docResult);
  const documentId = String(doc.id ?? '');
  const contentRef = `tenants/${tenantId}/documents/${documentId}/v1.json`;

  // ContentJson in the generation-plane shape — one sentence per section
  // body keeps the editor (sentences[].text) and viewer rendering intact.
  const content = {
    schemaVersion: 1,
    documentId,
    versionNo: 1,
    locale: 'en',
    frontMatter: null,
    sections: sections.map((s) => ({
      harmonizationKey: s.clauseRef,
      clauseRefs: [s.clauseRef],
      kind: 'prose',
      heading: s.heading,
      sentences: [{ text: s.body }],
    })),
  };

  // S3 BEFORE the version row commits: if the put fails, the whole
  // transaction rolls back and no version points at missing content.
  await s3.send(
    new PutObjectCommand({
      Bucket: CONTENT_BUCKET,
      Key: contentRef,
      Body: JSON.stringify(content),
      ContentType: 'application/json',
    }),
  );

  await rds.send(
    new ExecuteStatementCommand({
      resourceArn: CLUSTER_ARN,
      secretArn: SECRET_ARN,
      database: DB_NAME,
      transactionId,
      sql: `INSERT INTO m1.document_versions (tenant_id, document_id, version_no, content_ref, change_summary, author_id, created_by)
            VALUES (current_setting('app.tenant_id'), :documentId::uuid, 1, :contentRef, 'Agent draft (Document Studio)', :actor, :actor)`,
      parameters: [
        { name: 'documentId', value: { stringValue: documentId } },
        { name: 'contentRef', value: { stringValue: contentRef } },
        { name: 'actor', value: { stringValue: actor } },
      ],
    }),
  );

  return { ...doc, contentRef, sectionCount: sections.length };
}

async function executeDocPublish(
  args: Record<string, unknown>,
  _tenantId: string,
  transactionId: string,
): Promise<Record<string, unknown>> {
  const result = await rds.send(
    new ExecuteStatementCommand({
      resourceArn: CLUSTER_ARN,
      secretArn: SECRET_ARN,
      database: DB_NAME,
      transactionId,
      sql: `UPDATE m1.documents SET status = 'approved', updated_at = NOW()
          WHERE id = :docId::uuid AND tenant_id = current_setting('app.tenant_id')
          RETURNING id, status`,
      parameters: [{ name: 'docId', value: { stringValue: args.docId as string } }],
    }),
  );
  return writtenRow(result);
}

async function executeDocVersionControl(
  args: Record<string, unknown>,
  _tenantId: string,
  transactionId: string,
  actor: string,
): Promise<Record<string, unknown>> {
  const result = await rds.send(
    new ExecuteStatementCommand({
      resourceArn: CLUSTER_ARN,
      secretArn: SECRET_ARN,
      database: DB_NAME,
      transactionId,
      sql: `INSERT INTO m1.document_versions (tenant_id, document_id, version_no, content_ref, change_summary, author_id, created_by)
          VALUES (current_setting('app.tenant_id'), :docId::uuid, :versionNo::integer, :contentRef, :changeSummary, :authorId, :actor)
          RETURNING id, version_no`,
      parameters: [
        { name: 'docId', value: { stringValue: args.docId as string } },
        { name: 'versionNo', value: { stringValue: String(args.newVersion ?? '1') } },
        // TRACKED-TODO(content-ref-tripwire): the agent HITL writeback has no
        // content plane yet — '' is the DOCUMENTED exemption pinned by
        // content-ref-tripwire.test.ts (spec-40 Task 6, BC-8). Closes when the
        // agent drafting flow writes real S3 content refs (DocStudio content
        // plane follow-up). Every OTHER writer must set a real content_ref.
        { name: 'contentRef', value: { stringValue: (args.contentRef as string) ?? '' } },
        { name: 'changeSummary', value: { stringValue: args.changeDescription as string } },
        { name: 'authorId', value: { stringValue: actor } },
        { name: 'actor', value: { stringValue: actor } },
      ],
    }),
  );
  return writtenRow(result);
}

async function executeAuditFindingWrite(
  args: Record<string, unknown>,
  _tenantId: string,
  transactionId: string,
  actor: string,
): Promise<Record<string, unknown>> {
  // C-3d: map finding_type hyphens→underscores at dispatch layer (not by re-prompting model)
  const findingType = mapFindingType(args.findingType as string);
  // M-2: created_by = full actor
  const result = await rds.send(
    new ExecuteStatementCommand({
      resourceArn: CLUSTER_ARN,
      secretArn: SECRET_ARN,
      database: DB_NAME,
      transactionId,
      sql: `INSERT INTO m3.audit_findings (tenant_id, audit_id, finding_type, clause_ref, description, created_by)
          VALUES (current_setting('app.tenant_id'), :auditId::uuid, :findingType, :clauseRef, :description, :actor)
          RETURNING id, finding_type`,
      parameters: [
        { name: 'auditId', value: { stringValue: args.auditId as string } },
        { name: 'findingType', value: { stringValue: findingType } },
        { name: 'clauseRef', value: { stringValue: (args.clauseRef ?? args.clause) as string } },
        { name: 'description', value: { stringValue: args.description as string } },
        { name: 'actor', value: { stringValue: actor } },
      ],
    }),
  );

  // S4 cross-studio link: an approved MAJOR/MINOR NC finding ALSO opens the
  // nonconformity in CAPA Studio — same txn, both rows or neither.
  // major → high severity, minor → medium; source 'audit' (10.2 loop).
  if (findingType === 'major_nc' || findingType === 'minor_nc') {
    const clause = String(args.clauseRef ?? args.clause ?? '');
    // "ISO 9001 8.5.1" → standard ISO9001 + numeric clause_ref 8.5.1
    const stdRaw = (args.standard as string) ?? clause;
    const standard = normalizeStandard(stdRaw) ?? 'ISO9001';
    const clauseNum = clause.replace(/ISO\s*\d{4,5}(:\d{4})?/i, '').trim() || clause;
    const ncResult = await rds.send(
      new ExecuteStatementCommand({
        resourceArn: CLUSTER_ARN,
        secretArn: SECRET_ARN,
        database: DB_NAME,
        transactionId,
        sql: `INSERT INTO m2.nonconformities (tenant_id, standard, source, nc_type, description, clause_ref, severity, status, raised_by, raised_at, created_by)
            VALUES (current_setting('app.tenant_id'), :standard, 'audit', 'nc', :description, :clauseRef, :severity, 'open', :actor, NOW(), :actor)
            RETURNING id`,
        parameters: [
          { name: 'standard', value: { stringValue: standard } },
          {
            name: 'description',
            value: { stringValue: `Audit finding (${findingType}): ${args.description as string}` },
          },
          { name: 'clauseRef', value: { stringValue: clauseNum } },
          {
            name: 'severity',
            value: { stringValue: findingType === 'major_nc' ? 'high' : 'medium' },
          },
          { name: 'actor', value: { stringValue: actor } },
        ],
      }),
    );
    const finding = writtenRow(result);
    const nc = writtenRow(ncResult);
    return { ...finding, spawnedNcId: nc.id };
  }
  return writtenRow(result);
}

async function executeChecklistGen(
  args: Record<string, unknown>,
  _tenantId: string,
  transactionId: string,
  actor: string,
): Promise<Record<string, unknown>> {
  // C-3b: includes created_by (NOT NULL in 004_m3_audit_studio.sql:41)
  const result = await rds.send(
    new ExecuteStatementCommand({
      resourceArn: CLUSTER_ARN,
      secretArn: SECRET_ARN,
      database: DB_NAME,
      transactionId,
      sql: `INSERT INTO m3.audit_checklists (tenant_id, audit_id, clause_ref, question, expected_evidence, created_by)
          VALUES (current_setting('app.tenant_id'), :auditId::uuid, :clauseRef, :question, :evidence, :actor)
          RETURNING id`,
      parameters: [
        { name: 'auditId', value: { stringValue: args.auditId as string } },
        { name: 'clauseRef', value: { stringValue: args.clauseRef as string } },
        { name: 'question', value: { stringValue: args.question as string } },
        {
          name: 'evidence',
          value: { stringValue: (args.expectedEvidence ?? args.checklistItems ?? '') as string },
        },
        { name: 'actor', value: { stringValue: actor } },
      ],
    }),
  );
  return writtenRow(result);
}

async function executeRecordsRetentionSchedule(
  args: Record<string, unknown>,
  _tenantId: string,
  transactionId: string,
  actor: string,
): Promise<Record<string, unknown>> {
  // REWRITTEN 2026-07-16 (architect, owner-approved cleanup): the previous SQL
  // targeted columns that never existed (record_category/retention_period/
  // justification — migration 005 is record_type/retention_years/
  // disposition_rule) AND used ON CONFLICT (tenant_id, record_category) with
  // NO unique constraint on the table — every live call failed. Same
  // stale-draft-schema class as dd605b0; never exercised (ACC-3 ran capa-open).
  //
  // Tool contract (records-vault/tools.ts): {category, retentionPeriod
  // ('7-year'|'permanent'|...), justification}. Mapping:
  // - record_type := category
  // - retention_years := leading integer of retentionPeriod; 'permanent' is
  //   UNREPRESENTABLE (retention_years INTEGER NOT NULL) → loud typed throw,
  //   never a silent sentinel (needs a schema decision if wanted).
  // - disposition_rule := 'review_before_disposal' (the platform default the
  //   m1 sealing path seeds — established convention, not invented data).
  // - justification has no column → preserved verbatim in the audit payload
  //   (closeCapa closureNotes precedent).
  // Upsert = SELECT then UPDATE-or-INSERT (no unique constraint to CONFLICT
  // on); RLS + explicit tenant filter scope both statements.
  const category = args.category as string;
  const rawPeriod = String(args.retentionPeriod ?? '');
  const yearsMatch = rawPeriod.match(/^(\d+)/);
  if (!yearsMatch) {
    throw new Error(
      `RETENTION_PERIOD_UNREPRESENTABLE: '${rawPeriod}' has no leading integer — ` +
        `m4.retention_policies.retention_years is INTEGER NOT NULL ('permanent' ` +
        `retention needs a schema decision before this tool can express it).`,
    );
  }
  const years = Number(yearsMatch[1]);

  const existing = await rds.send(
    new ExecuteStatementCommand({
      resourceArn: CLUSTER_ARN,
      secretArn: SECRET_ARN,
      database: DB_NAME,
      transactionId,
      sql: `SELECT id FROM m4.retention_policies
          WHERE tenant_id = current_setting('app.tenant_id') AND record_type = :recordType
          LIMIT 1`,
      parameters: [{ name: 'recordType', value: { stringValue: category } }],
    }),
  );
  const existingId = (existing.records?.[0]?.[0] as { stringValue?: string } | undefined)
    ?.stringValue;

  const result = existingId
    ? await rds.send(
        new ExecuteStatementCommand({
          resourceArn: CLUSTER_ARN,
          secretArn: SECRET_ARN,
          database: DB_NAME,
          transactionId,
          sql: `UPDATE m4.retention_policies
              SET retention_years = :years, updated_at = NOW(), version = version + 1
              WHERE id = :id::uuid AND tenant_id = current_setting('app.tenant_id')
              RETURNING id, record_type, retention_years`,
          parameters: [
            { name: 'years', value: { longValue: years } },
            { name: 'id', value: { stringValue: existingId } },
          ],
        }),
      )
    : await rds.send(
        new ExecuteStatementCommand({
          resourceArn: CLUSTER_ARN,
          secretArn: SECRET_ARN,
          database: DB_NAME,
          transactionId,
          sql: `INSERT INTO m4.retention_policies (tenant_id, record_type, retention_years, disposition_rule, created_by)
              VALUES (current_setting('app.tenant_id'), :recordType, :years, 'review_before_disposal', :actor)
              RETURNING id, record_type, retention_years`,
          parameters: [
            { name: 'recordType', value: { stringValue: category } },
            { name: 'years', value: { longValue: years } },
            { name: 'actor', value: { stringValue: actor } },
          ],
        }),
      );
  return writtenRow(result);
}

/**
 * S1 (studio wave): nc-draft-write — CAPAGuru's stage-1 intake proposal,
 * approved: create the NC the agent drafted (classification, clause,
 * severity, source all agent-identified, human-reviewed/edited).
 * Values arrive DB-lowercase from the tool schema (standard stays
 * uppercase — the column stores 'ISO9001' etc.); CHECK constraints are
 * the backstop. containmentNote/rationale have no register columns —
 * they live in the Agent.WritebackCommitted audit payload (writeResult
 * echoes args), same convention as risk-assessment-write's rationale.
 */
async function executeNcDraftWrite(
  args: Record<string, unknown>,
  _tenantId: string,
  transactionId: string,
  actor: string,
): Promise<Record<string, unknown>> {
  const result = await rds.send(
    new ExecuteStatementCommand({
      resourceArn: CLUSTER_ARN,
      secretArn: SECRET_ARN,
      database: DB_NAME,
      transactionId,
      sql: `INSERT INTO m2.nonconformities
              (tenant_id, standard, source, nc_type, description, clause_ref, severity, status, raised_by, raised_at, created_by)
            VALUES (current_setting('app.tenant_id'), :standard, :source, :ncType, :description, :clauseRef, :severity, 'open', :actor, NOW(), :actor)
            RETURNING id, nc_type, clause_ref, severity, standard`,
      parameters: [
        { name: 'standard', value: { stringValue: args.standard as string } },
        { name: 'source', value: { stringValue: args.source as string } },
        { name: 'ncType', value: { stringValue: args.ncType as string } },
        { name: 'description', value: { stringValue: args.description as string } },
        { name: 'clauseRef', value: { stringValue: args.clauseRef as string } },
        { name: 'severity', value: { stringValue: args.severity as string } },
        { name: 'actor', value: { stringValue: actor } },
      ],
    }),
  );
  return writtenRow(result);
}

/**
 * RS-8: nc-triage-write — CAPAGuru's stage-2 reclassification proposal,
 * approved. classification arrives DB-lowercase already (the tool's
 * inputSchema instructs the model directly — 'nonconforming_output'|'nc'|
 * 'incident' — the CHECK constraint on m2.nonconformities.nc_type is the
 * validation backstop, same as every other tool here).
 */
async function executeNcTriageWrite(
  args: Record<string, unknown>,
  _tenantId: string,
  transactionId: string,
  _actor: string,
): Promise<Record<string, unknown>> {
  const result = await rds.send(
    new ExecuteStatementCommand({
      resourceArn: CLUSTER_ARN,
      secretArn: SECRET_ARN,
      database: DB_NAME,
      transactionId,
      sql: `UPDATE m2.nonconformities SET nc_type = :classification, updated_at = NOW(), version = version + 1
          WHERE id = :ncId::uuid AND tenant_id = current_setting('app.tenant_id')
          RETURNING id, nc_type`,
      parameters: [
        { name: 'classification', value: { stringValue: args.classification as string } },
        { name: 'ncId', value: { stringValue: args.ncId as string } },
      ],
    }),
  );
  return writtenRow(result);
}

/**
 * RS-8: risk-assessment-write — RiskSentinel's likelihood/severity
 * proposal, approved. Refreshes risk_register_view in the SAME transaction
 * (createRisk's/agentAssessRisk's established pattern — app_role cannot
 * REFRESH the view directly, SECURITY DEFINER accessor only). rationale has
 * no m5.risks column (free-text narrative, not a register field) —
 * preserved in the Agent.WritebackCommitted audit payload only (writeResult
 * doesn't carry it; the caller's approvalResult.editedPayload/proposedAction
 * already ledgers the full proposal on the HITL approval event separately).
 */
async function executeRiskAssessmentWrite(
  args: Record<string, unknown>,
  _tenantId: string,
  transactionId: string,
  _actor: string,
): Promise<Record<string, unknown>> {
  const result = await rds.send(
    new ExecuteStatementCommand({
      resourceArn: CLUSTER_ARN,
      secretArn: SECRET_ARN,
      database: DB_NAME,
      transactionId,
      sql: `UPDATE m5.risks SET likelihood = :likelihood, severity = :severity, updated_at = NOW(), version = version + 1
          WHERE id = :riskId::uuid AND tenant_id = current_setting('app.tenant_id')
          RETURNING id, likelihood, severity`,
      parameters: [
        { name: 'likelihood', value: { longValue: Number(args.likelihood) } },
        { name: 'severity', value: { longValue: Number(args.severity) } },
        { name: 'riskId', value: { stringValue: args.riskId as string } },
      ],
    }),
  );
  await rds.send(
    new ExecuteStatementCommand({
      resourceArn: CLUSTER_ARN,
      secretArn: SECRET_ARN,
      database: DB_NAME,
      transactionId,
      sql: `SELECT m5_views.refresh_risk_register_view()`,
    }),
  );
  return writtenRow(result);
}

/**
 * H-3 (Task 8R): Emit audit event via the registered publisher.
 * Uses publishAuditEvent pattern: ULID eventId, registered detailType,
 * standard from proposedAction context, full actor identity.
 */
async function emitWritebackAuditEvent(opts: {
  tenantId: string;
  actor: string;
  agentName: string;
  proposedAction: { tool: string; args: Record<string, unknown> };
  writeResult: Record<string, unknown>;
  standard: 'ISO9001' | 'ISO14001' | 'ISO45001';
}): Promise<string> {
  const eventId = ulid(); // H-3: ULID — avoids FIFO dedup collision risk from timestamp-based IDs
  const moduleMap: Record<string, string> = {
    'capa-open': 'M2',
    'capa-verify-effectiveness': 'M2',
    'doc-draft': 'M1',
    'manual-section-draft': 'M1',
    'doc-publish': 'M1',
    'doc-version-control': 'M1',
    'audit-finding-write': 'M3',
    'audit-checklist-gen': 'M3',
    'records-retention-schedule': 'M4',
    'ct-governance-write': 'cross-standard',
    'nc-draft-write': 'M2',
    'nc-triage-write': 'M2',
    'rca-write': 'M2',
    'risk-assessment-write': 'M5',
  };
  const module = moduleMap[opts.proposedAction.tool] ?? opts.agentName;

  await publish({
    busName: BUS_NAME,
    source: `cumplify.agent.${opts.agentName.toLowerCase()}`,
    detailType: 'Agent.WritebackCommitted',
    event: {
      tenantId: opts.tenantId,
      eventId,
      timestamp: new Date().toISOString(),
      actor: opts.actor,
      module,
      clauseRef: 'agent-writeback',
      standard: opts.standard,
      // 2026-07-16: the written row's id (every tool's RETURNING has id first;
      // writtenRow captures it). Feeds the audit ledger's GSI1 per-entity key.
      entityId: String(opts.writeResult.id ?? ''),
      payload: {
        before: null,
        after: { tool: opts.proposedAction.tool, result: opts.writeResult },
      },
    },
  });

  return eventId;
}
