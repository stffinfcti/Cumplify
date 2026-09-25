/**
 * qms — generation-run family (runs, section review, manual generation,
 * IMS export, regeneration, manual-section drafts). Extracted from qms.ts
 * (mechanical decomposition — no semantic changes).
 */

import { InvokeCommand } from '@aws-sdk/client-lambda';
import { StartExecutionCommand } from '@aws-sdk/client-sfn';
import { ulid } from 'ulid';
import { beginTenantTransaction, marshalOne, marshalMany, jsonOut } from '../shared.js';
import {
  logger,
  sfnClient,
  lambdaClient,
  EXPORT_FN,
  REGEN_FN,
  type AppSyncEvent,
} from './common.js';

export async function getGenerationRun(event: AppSyncEvent, tenantId: string) {
  const runId = event.arguments.id as string;
  const txn = await beginTenantTransaction(tenantId);
  try {
    const runResult = await txn.execute(
      `
      SELECT id, status, standards, manual_document_id, started_at, finished_at
      FROM qms.generation_runs WHERE id = :id::uuid
    `,
      [{ name: 'id', value: { stringValue: runId } }],
    );

    const sectionsResult = await txn.execute(
      `
      SELECT id, harmonization_key, status AS kind, clause_registry_ids AS clause_refs,
             content_sha256, reviewed_by, reviewed_at, error
      FROM qms.generation_sections WHERE run_id = :runId::uuid ORDER BY harmonization_key
    `,
      [{ name: 'runId', value: { stringValue: runId } }],
    );

    await txn.commit();

    const run = marshalOne(runResult);
    if (!run) return null;
    // clauseRefs is jsonb — parse for the AWSJSON slot (double-encode otherwise)
    const sections: Record<string, unknown>[] = marshalMany(sectionsResult).map((s) => ({
      ...s,
      clauseRefs: jsonOut(s.clauseRefs),
    }));

    // Compute gapCount from sections
    const gapCount = sections.filter((s) => s.kind === 'gap' || s.kind === 'GAP').length;

    return { ...run, sections, gapCount };
  } catch (err) {
    try {
      await txn.rollback();
    } catch {
      /* never mask */
    }
    throw err;
  }
}

export async function listGenerationRuns(event: AppSyncEvent, tenantId: string) {
  const limit = (event.arguments.limit as number) || 20;
  const txn = await beginTenantTransaction(tenantId);
  try {
    const result = await txn.execute(
      `
      SELECT id, status, standards, manual_document_id, started_at, finished_at
      FROM qms.generation_runs
      ORDER BY started_at DESC
      LIMIT :lim
    `,
      [{ name: 'lim', value: { longValue: limit } }],
    );
    await txn.commit();
    // Return without nested sections (lightweight list)
    return marshalMany(result).map((r) => ({ ...r, sections: [], gapCount: 0 }));
  } catch (err) {
    try {
      await txn.rollback();
    } catch {
      /* never mask */
    }
    throw err;
  }
}

// ─── Mutations ───────────────────────────────────────────────────────────────

/**
 * markSectionReviewed — stamps reviewed_by/reviewed_at on a generation section.
 * Role-gated to M1 authoring family (canApprove(role,'M1') — enforced server-side).
 * Rejects if the parent run is in a terminal state (complete/failed).
 */
export async function markSectionReviewed(event: AppSyncEvent, tenantId: string, actor: string) {
  const input = event.arguments.input as { sectionId: string };
  const sectionId = input.sectionId;

  const txn = await beginTenantTransaction(tenantId);
  try {
    // Fetch section + parent run status
    const sectionResult = await txn.execute(
      `
      SELECT gs.id, gs.run_id, gs.reviewed_at, gr.status AS run_status
      FROM qms.generation_sections gs
      JOIN qms.generation_runs gr ON gr.id = gs.run_id
      WHERE gs.id = :sectionId::uuid
    `,
      [{ name: 'sectionId', value: { stringValue: sectionId } }],
    );

    if (!sectionResult.records || sectionResult.records.length === 0) {
      throw new Error('SECTION_NOT_FOUND');
    }

    // Check run status — reject on terminal states
    const runStatusIdx = sectionResult.columnMetadata!.findIndex((c) => c.name === 'run_status');
    const runStatus = (sectionResult.records[0][runStatusIdx] as { stringValue?: string })
      .stringValue;
    // Review happens AFTER generation (document exists post-FinalizeManual).
    // ALLOW: complete, partial (content is final).
    // REJECT: running (retry could replace content), failed (nothing to review).
    if (runStatus === 'running' || runStatus === 'failed') {
      throw new Error('RUN_NOT_REVIEWABLE');
    }

    // Stamp reviewed_by/reviewed_at
    const result = await txn.execute(
      `
      UPDATE qms.generation_sections
      SET reviewed_by = :actor, reviewed_at = NOW(), updated_at = NOW()
      WHERE id = :sectionId::uuid
      RETURNING id, harmonization_key, status AS kind, clause_registry_ids AS clause_refs,
                content_sha256, reviewed_by, reviewed_at, error
    `,
      [
        { name: 'actor', value: { stringValue: actor } },
        { name: 'sectionId', value: { stringValue: sectionId } },
      ],
    );

    await txn.commit();
    return marshalOne(result);
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
 * generateImsManual (spec-40 Task 5) — inserts the run row with the PINNED
 * profile version, then starts DocGenStateMachine (ARN by deterministic name,
 * env DOCGEN_SFN_ARN — no CFN cross-stack cycle).
 *
 * Ordering: run row COMMITS first (the state machine reads it), then
 * StartExecution, then a best-effort UPDATE stamps sfn_execution_arn.
 * StartExecution failure marks the run 'failed' and throws
 * GENERATION_UNAVAILABLE — a run row must never sit 'running' with no
 * execution behind it.
 */
export async function generateImsManual(event: AppSyncEvent, tenantId: string, actor: string) {
  const input = (event.arguments.input ?? {}) as { standards?: string[] };
  const sfnArn = process.env.DOCGEN_SFN_ARN;
  if (!sfnArn) throw new Error('GENERATION_UNAVAILABLE');

  const txn = await beginTenantTransaction(tenantId);
  let run: Record<string, unknown>;
  try {
    const profileResult = await txn.execute(
      `SELECT op.current_version, opv.payload
       FROM qms.org_profiles op
       JOIN qms.org_profile_versions opv
         ON opv.profile_id = op.id AND opv.version_no = op.current_version`,
    );
    if (!profileResult.records?.length) throw new Error('ORG_PROFILE_REQUIRED');
    const currentVersion = Number(
      (profileResult.records[0][0] as { longValue?: number }).longValue ?? 0,
    );
    if (currentVersion < 1) throw new Error('ORG_PROFILE_REQUIRED');
    const payload = JSON.parse(
      (profileResult.records[0][1] as { stringValue?: string }).stringValue ?? '{}',
    ) as { standardsInScope?: string[] };

    const standards = input.standards?.length ? input.standards : (payload.standardsInScope ?? []);
    if (standards.length === 0) throw new Error('NO_STANDARDS_IN_SCOPE');

    const runResult = await txn.execute(
      `INSERT INTO qms.generation_runs
         (tenant_id, profile_version, standards, status, requested_by, created_by)
       VALUES (:tenantId, :pv::integer, :standards::text[], 'running', :actor, :actor)
       RETURNING id, status, standards, manual_document_id, started_at, finished_at`,
      [
        { name: 'tenantId', value: { stringValue: tenantId } },
        { name: 'pv', value: { longValue: currentVersion } },
        { name: 'standards', value: { stringValue: `{${standards.join(',')}}` } },
        { name: 'actor', value: { stringValue: actor } },
      ],
    );
    run = marshalOne(runResult)!;
    await txn.commit();
  } catch (err) {
    try {
      await txn.rollback();
    } catch {
      /* never mask */
    }
    throw err;
  }

  const runId = run.id as string;
  try {
    const exec = await sfnClient.send(
      new StartExecutionCommand({
        stateMachineArn: sfnArn,
        name: `run-${runId}`,
        input: JSON.stringify({ runId, tenantId }),
      }),
    );
    const stamp = await beginTenantTransaction(tenantId);
    try {
      await stamp.execute(
        `UPDATE qms.generation_runs SET sfn_execution_arn = :arn, updated_at = NOW() WHERE id = :id::uuid`,
        [
          { name: 'arn', value: { stringValue: exec.executionArn! } },
          { name: 'id', value: { stringValue: runId } },
        ],
      );
      await stamp.commit();
    } catch (err) {
      try {
        await stamp.rollback();
      } catch {
        /* never mask */
      }
      logger.warn('Failed to stamp sfn_execution_arn (run continues)', { runId });
    }
  } catch (err) {
    // Never leave a 'running' row with no execution behind it
    const mark = await beginTenantTransaction(tenantId);
    try {
      await mark.execute(
        `UPDATE qms.generation_runs SET status = 'failed', finished_at = NOW(), updated_at = NOW() WHERE id = :id::uuid`,
        [{ name: 'id', value: { stringValue: runId } }],
      );
      await mark.commit();
    } catch (markErr) {
      try {
        await mark.rollback();
      } catch {
        /* never mask */
      }
    }
    logger.error('StartExecution failed', { runId, error: (err as Error).message });
    throw new Error('GENERATION_UNAVAILABLE');
  }

  return run;
}

// ─── STO-4: IMS ZIP export (spec-40 Task 9) ──────────────────────────────────
// SQL here, S3/zip in ExportFn. The export SET is resolved by ExportFn from
// the master-list content (SQL cannot link master list → manual; that linkage
// lives only in the master-list entries JSON).
export async function requestImsExport(event: AppSyncEvent, tenantId: string) {
  const documentId = event.arguments.documentId as string;
  if (!documentId) throw new Error('BAD_REQUEST: documentId required');
  if (!EXPORT_FN) throw new Error('EXPORT_NOT_AVAILABLE');

  const txn = await beginTenantTransaction(tenantId);
  let manual: Record<string, unknown> | null = null;
  let candidates: Record<string, unknown>[] = [];
  try {
    const manualRes = await txn.execute(
      `SELECT d.id AS document_id, d.title, d.doc_type, d.standard,
              v.id AS version_id, v.version_no, v.content_ref
       FROM m1.documents d
       JOIN m1.document_versions v ON v.document_id = d.id
       WHERE d.id = :documentId::uuid
       ORDER BY v.version_no DESC LIMIT 1`,
      [{ name: 'documentId', value: { stringValue: documentId } }],
    );
    manual = marshalOne(manualRes) as Record<string, unknown> | null;
    const candRes = await txn.execute(
      `SELECT DISTINCT ON (d.id)
              d.id AS document_id, d.title, d.standard,
              v.id AS version_id, v.version_no, v.content_ref
       FROM m1.documents d
       JOIN m1.document_versions v ON v.document_id = d.id
       WHERE d.doc_type = 'master_list'
       ORDER BY d.id, v.version_no DESC`,
    );
    candidates = marshalMany(candRes) as Record<string, unknown>[];
    await txn.commit();
  } catch (err) {
    try {
      await txn.rollback();
    } catch {
      /* never mask */
    }
    throw err;
  }

  if (!manual || !manual.contentRef) throw new Error('DOCUMENT_NOT_FOUND');
  if (candidates.length === 0) throw new Error('EXPORT_SET_NOT_FOUND');

  const payload = {
    tenantId,
    manual: {
      documentId: manual.documentId,
      versionId: manual.versionId,
      contentKey: manual.contentRef,
      title: manual.title,
      docType: manual.docType,
      standard: manual.standard,
      versionNo: manual.versionNo,
    },
    masterListCandidates: candidates.map((c) => ({
      documentId: c.documentId,
      versionId: c.versionId,
      contentKey: c.contentRef,
      title: c.title,
      standard: c.standard,
      versionNo: c.versionNo,
    })),
  };
  const invoke = await lambdaClient.send(
    new InvokeCommand({
      FunctionName: EXPORT_FN,
      Payload: JSON.stringify(payload),
    }),
  );
  if (invoke.FunctionError) {
    const raw = new TextDecoder().decode(invoke.Payload);
    logger.error('ExportFn failed', { raw });
    // Relay ExportFn's typed errors (EXPORT_SET_NOT_FOUND etc.) to the client
    try {
      const parsed = JSON.parse(raw) as { errorMessage?: string };
      throw new Error(parsed.errorMessage ?? 'EXPORT_FAILED');
    } catch (e) {
      if (e instanceof Error && e.message !== raw) throw e;
      throw new Error('EXPORT_FAILED');
    }
  }
  return JSON.parse(new TextDecoder().decode(invoke.Payload)) as { url: string; expiresAt: string };
}

/**
 * regenerateSection (GEN-6) — thin dispatch to RegenerateSectionFn (AiStack,
 * deterministic name; requestImsExport→ExportFn pattern). The worker resets
 * the section (review state cleared — APR-1), re-composes through the one
 * door, and writes NEW versions on the affected documents; it returns the
 * section in the GraphQL GenerationSection shape verbatim.
 */
export async function regenerateSection(event: AppSyncEvent, tenantId: string, actor: string) {
  const input = event.arguments.input as { runId: string; harmonizationKey: string };
  if (!input?.runId || !input?.harmonizationKey)
    throw new Error('BAD_REQUEST: runId and harmonizationKey required');
  if (!REGEN_FN) throw new Error('REGENERATE_NOT_AVAILABLE');

  const invoke = await lambdaClient.send(
    new InvokeCommand({
      FunctionName: REGEN_FN,
      Payload: JSON.stringify({
        tenantId,
        runId: input.runId,
        harmonizationKey: input.harmonizationKey,
        actor,
      }),
    }),
  );
  if (invoke.FunctionError) {
    const raw = new TextDecoder().decode(invoke.Payload);
    logger.error('RegenerateSectionFn failed', { raw });
    // Relay the worker's typed errors (RUN_NOT_FOUND, RUN_NOT_FINALIZED,
    // SECTION_NOT_FOUND, ...) to the client
    try {
      const parsed = JSON.parse(raw) as { errorMessage?: string };
      throw new Error(parsed.errorMessage ?? 'REGENERATE_FAILED');
    } catch (e) {
      if (e instanceof Error && e.message !== raw) throw e;
      throw new Error('REGENERATE_FAILED');
    }
  }
  return JSON.parse(new TextDecoder().decode(invoke.Payload));
}

/**
 * runManualSectionDraft (S3, studio wave) — Manual Studio's gap burn-down
 * door. The user points at ONE generation-run section (GAP, FAILED, or a
 * prose redraft); DocStudio drafts its prose grounded in the run's pinned
 * org profile + the section's clause intents, and proposes it via the
 * manual-section-draft HITL tool. Fire-and-forget Event invoke (runDocDraft
 * pattern) — the HITL card is the deliverable; approval drives the GEN-6
 * regeneration engine with the approved sentences (no re-compose).
 * READS ONLY here: run finalized guard + section + clauses + profile ride
 * in the payload so the agent never touches the DB.
 */
export async function runManualSectionDraft(event: AppSyncEvent, tenantId: string, actor: string) {
  // Read at call time (not module load) — hermetic tests set the env after
  // the hoisted import has already evaluated the module body.
  const docStudioFnArn = process.env.DOC_STUDIO_FN_ARN ?? '';
  const generationRunId = (event.arguments.runId as string) ?? '';
  const harmonizationKey = (event.arguments.harmonizationKey as string) ?? '';
  if (!generationRunId.trim() || !harmonizationKey.trim())
    throw new Error('BAD_REQUEST: runId and harmonizationKey required');
  if (!docStudioFnArn) throw new Error('DOC_STUDIO_NOT_AVAILABLE');

  const txn = await beginTenantTransaction(tenantId);
  let sectionKind: string;
  let clauses: Array<Record<string, unknown>>;
  let profile: Record<string, unknown>;
  try {
    const runResult = await txn.execute(
      `SELECT gr.manual_document_id, opv.payload
       FROM qms.generation_runs gr
       JOIN qms.org_profiles op ON op.tenant_id = gr.tenant_id
       JOIN qms.org_profile_versions opv ON opv.profile_id = op.id AND opv.version_no = gr.profile_version
       WHERE gr.id = :runId::uuid`,
      [{ name: 'runId', value: { stringValue: generationRunId } }],
    );
    if (!runResult.records?.length) throw new Error('RUN_NOT_FOUND');
    const manualDocId = (runResult.records[0][0] as { stringValue?: string; isNull?: boolean })
      .stringValue;
    if (!manualDocId) throw new Error('RUN_NOT_FINALIZED');
    profile = JSON.parse(
      (runResult.records[0][1] as { stringValue?: string }).stringValue ?? '{}',
    ) as Record<string, unknown>;

    const secResult = await txn.execute(
      `SELECT status, clause_registry_ids FROM qms.generation_sections
       WHERE run_id = :runId::uuid AND harmonization_key = :hkey`,
      [
        { name: 'runId', value: { stringValue: generationRunId } },
        { name: 'hkey', value: { stringValue: harmonizationKey } },
      ],
    );
    const section = marshalOne(secResult) as {
      status: string;
      clauseRegistryIds: string[] | null;
    } | null;
    if (!section) throw new Error('SECTION_NOT_FOUND');
    sectionKind = section.status.toLowerCase();
    // A section still being composed has no stable identity to draft against
    if (sectionKind === 'pending') throw new Error('SECTION_STILL_COMPOSING');

    const clauseIds = (section.clauseRegistryIds ?? []).filter(Boolean);
    if (clauseIds.length) {
      const clausesResult = await txn.execute(
        `SELECT standard, clause_no, clause_title, intent_paraphrase, required_sources
         FROM qms.clause_registry WHERE id = ANY(:ids::uuid[]) ORDER BY standard`,
        [{ name: 'ids', value: { stringValue: `{${clauseIds.join(',')}}` } }],
      );
      clauses = marshalMany(clausesResult);
    } else {
      clauses = [];
    }
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
      FunctionName: docStudioFnArn,
      InvocationType: 'Event',
      Payload: JSON.stringify({
        tenantId,
        runId,
        requestedBy: actor,
        sectionDraftIntent: {
          generationRunId,
          harmonizationKey,
          sectionKind,
          clauses,
          orgProfile: profile,
        },
      }),
    }),
  );

  // No audit event at dispatch — parity with runNcIntake/runDocDraft: the
  // HITL plane audits gate-entry/approval, and the registry is fail-closed
  // (found live 2026-07-22: unregistered 'Agent.RunRequested' threw AFTER the
  // Event-invoke, erroring the mutation while the agent run proceeded).
  logger.info('Manual section draft dispatched', {
    tenantId,
    runId,
    generationRunId,
    harmonizationKey,
  });
  return { runId, status: 'DISPATCHED' };
}
