/**
 * RegenerateSectionFn (GEN-6, spec-40 — the regenerateSection wave).
 *
 * Invoked synchronously by QmsFn's regenerateSection resolver case by
 * DETERMINISTIC NAME (`cumplify-docgen-regen-<env>` — same no-cycle pattern
 * as the state machine: AiStack depends on ApiStack, so ApiStack constructs
 * the ARN by name). The compose step runs IN-PROCESS via the ComposeSection
 * handler import — one door to Bedrock, unchanged.
 *
 * Flow (GEN-6: "regenerate a single section without regenerating the manual,
 * producing a new document version"):
 *   1. Guards + reset: run must exist AND be finalized (manual_document_id
 *      set); section found by (run_id, harmonization_key). Section resets to
 *      'pending' with review state CLEARED — regenerated content must be
 *      re-reviewed (APR-1 integrity is not inheritable).
 *   2. Compose: the standard ComposeSection path (GAP-before-model-call,
 *      guardedText facts, deterministic checker + retry, honest failed).
 *   3. Version writeback in ONE txn: NEW manual version (assembled from ALL
 *      current sections), NEW clause-document version for the section (or a
 *      NEW clause document when the section was previously failed and shipped
 *      none; no clause version when it is STILL failed — failed prose never
 *      ships), correlation-matrix version when the section kind changed, and
 *      a REFRESHED master-list version with every entry re-pointed at its
 *      latest version (closes the Task-9 carry-forward: exports pinned clause
 *      docs at v1). Run status recomputed (failed>0 → partial, else complete)
 *      — regenerating a failed section to prose repairs a PARTIAL run.
 *
 * Assertion ledger: append-only by design — regeneration APPENDS the new
 * sentences' rows; prior rows remain as the historical record of what v(n-1)
 * asserted. Content keys are content-addressed per version (v<n>.json), so
 * old versions stay diffable (ACC-6).
 */

import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { Logger } from '@aws-lambda-powertools/logger';
import {
  beginTenantTransaction,
  marshalMany,
  publishAuditEvent,
} from '../../api/src/resolvers/shared.js';
import { handler as composeSection } from './compose-section.js';
import { sectionContentKey } from './seed-sections.js';
import { sha256Hex } from './facts.js';
import {
  assembleManualContent,
  deriveCorrelationMatrix,
  deriveMasterList,
  documentStandard,
  clauseDocTitle,
  buildFrontMatter,
  type SectionState,
  type MasterListEntry,
} from './derive.js';

const logger = new Logger({ serviceName: 'qms-regenerate-section' });
const s3 = new S3Client({});
const GENERAL_BUCKET = process.env.GENERAL_BUCKET!;

export interface RegenerateInput {
  tenantId: string;
  runId: string;
  harmonizationKey: string;
  actor: string;
  /**
   * S3 (Manual Studio): HITL-approved DocStudio section draft. When present,
   * the compose step is SKIPPED — the approved sentences ship as the section's
   * prose and every step-3 version derivation runs unchanged. No assertion-
   * ledger rows: approved drafts carry no factRefs; accountability lives in
   * the version author (agent:DocStudio+human:<sub>) and the audit trail.
   */
  override?: { sentences: Array<{ text: string }> };
}

type Txn = Awaited<ReturnType<typeof beginTenantTransaction>>;

function versionContentKey(tenantId: string, documentId: string, versionNo: number): string {
  return `tenants/${tenantId}/documents/${documentId}/v${versionNo}.json`;
}

async function getJson(key: string): Promise<Record<string, unknown>> {
  const obj = await s3.send(new GetObjectCommand({ Bucket: GENERAL_BUCKET, Key: key }));
  return JSON.parse(await obj.Body!.transformToString()) as Record<string, unknown>;
}

async function nextVersionNo(txn: Txn, documentId: string): Promise<number> {
  const res = await txn.execute(
    `SELECT COALESCE(MAX(version_no), 0) + 1 FROM m1.document_versions WHERE document_id = :docId::uuid`,
    [{ name: 'docId', value: { stringValue: documentId } }],
  );
  return Number((res.records![0][0] as { longValue?: number }).longValue ?? 1);
}

async function writeNewVersion(
  txn: Txn,
  tenantId: string,
  documentId: string,
  versionNo: number,
  author: string,
  changeSummary: string,
  content: Record<string, unknown>,
): Promise<{ contentRef: string; contentSha: string }> {
  const body = JSON.stringify(content);
  const contentRef = versionContentKey(tenantId, documentId, versionNo);
  const contentSha = sha256Hex(body);
  await s3.send(
    new PutObjectCommand({
      Bucket: GENERAL_BUCKET,
      Key: contentRef,
      Body: body,
      ContentType: 'application/json',
    }),
  );
  await txn.execute(
    `INSERT INTO m1.document_versions
       (tenant_id, document_id, version_no, content_ref, content_sha256, change_summary, author_id, created_by)
     VALUES (:tenantId, :docId::uuid, :versionNo::integer, :contentRef, :contentSha, :summary, :author, :author)`,
    [
      { name: 'tenantId', value: { stringValue: tenantId } },
      { name: 'docId', value: { stringValue: documentId } },
      { name: 'versionNo', value: { longValue: versionNo } },
      { name: 'contentRef', value: { stringValue: contentRef } },
      { name: 'contentSha', value: { stringValue: contentSha } },
      { name: 'summary', value: { stringValue: changeSummary } },
      { name: 'author', value: { stringValue: author } },
    ],
  );
  return { contentRef, contentSha };
}

/** Load all section states of a run (finalize-manual loader shape). */
async function loadSectionStates(txn: Txn, runId: string): Promise<SectionState[]> {
  const sectionsResult = await txn.execute(
    `SELECT id, harmonization_key, status, content_s3_key, clause_registry_ids
     FROM qms.generation_sections WHERE run_id = :runId::uuid ORDER BY harmonization_key`,
    [{ name: 'runId', value: { stringValue: runId } }],
  );
  const sectionRows: Record<string, unknown>[] = marshalMany(sectionsResult).map((r) => ({
    ...r,
    status: (r.status as string).toLowerCase(),
  }));

  const registryResult = await txn.execute(
    `SELECT id, standard, clause_no, clause_title, annex_sl_mode, doc_type, sort_order
     FROM qms.clause_registry`,
  );
  const registryById = new Map(marshalMany(registryResult).map((r) => [r.id as string, r]));

  const sections: SectionState[] = [];
  for (const row of sectionRows) {
    const clauseIds = (row.clauseRegistryIds as string[]) ?? [];
    const clauses = clauseIds
      .map((id) => registryById.get(id))
      .filter((c): c is NonNullable<typeof c> => !!c)
      .map((c) => ({
        standard: c.standard as string,
        clauseNo: c.clauseNo as string,
        clauseTitle: c.clauseTitle as string,
        annexSlMode: c.annexSlMode as string,
        docType: (c.docType as string).toLowerCase(),
      }));
    const sortOrder = Math.min(
      ...clauseIds.map((id) => (registryById.get(id)?.sortOrder as number) ?? 9999),
    );
    let content: Record<string, unknown> | null = null;
    const key = row.contentS3Key as string | null;
    if (key) content = await getJson(key);
    sections.push({
      sectionKey: row.harmonizationKey as string,
      kind: row.status as SectionState['kind'],
      clauses,
      content,
      sortOrder,
    });
  }
  return sections;
}

interface RunRow {
  standards: string[];
  manualDocumentId: string | null;
  status: string;
  profile: Record<string, unknown>;
}

async function loadRun(txn: Txn, runId: string): Promise<RunRow | null> {
  const runResult = await txn.execute(
    `SELECT gr.standards, gr.manual_document_id, gr.status, opv.payload
     FROM qms.generation_runs gr
     JOIN qms.org_profiles op ON op.tenant_id = gr.tenant_id
     JOIN qms.org_profile_versions opv ON opv.profile_id = op.id AND opv.version_no = gr.profile_version
     WHERE gr.id = :runId::uuid`,
    [{ name: 'runId', value: { stringValue: runId } }],
  );
  if (!runResult.records?.length) return null;
  const rec = runResult.records[0];
  return {
    standards:
      (rec[0] as { arrayValue?: { stringValues?: string[] } }).arrayValue?.stringValues ?? [],
    manualDocumentId: (rec[1] as { stringValue?: string; isNull?: boolean }).stringValue ?? null,
    status: ((rec[2] as { stringValue?: string }).stringValue ?? '').toLowerCase(),
    profile: JSON.parse((rec[3] as { stringValue?: string }).stringValue ?? '{}') as Record<
      string,
      unknown
    >,
  };
}

/**
 * S3 (Manual Studio): write a HITL-approved section draft in the EXACT shape
 * compose-section ships prose — content JSON {schemaVersion, harmonizationKey,
 * clauseRefs, kind:'prose', sentences} at sectionContentKey + generation_
 * sections row update — so step 3's version derivations consume it
 * identically. Own txn (compose parity).
 */
async function applyApprovedDraft(
  tenantId: string,
  runId: string,
  sectionId: string,
  sectionKey: string,
  sentences: Array<{ text: string }>,
): Promise<'prose'> {
  const txn = await beginTenantTransaction(tenantId);
  try {
    const secResult = await txn.execute(
      `SELECT clause_registry_ids FROM qms.generation_sections WHERE id = :id::uuid`,
      [{ name: 'id', value: { stringValue: sectionId } }],
    );
    const clauseIds = (
      (marshalMany(secResult)[0]?.clauseRegistryIds as string[] | undefined) ?? []
    ).filter(Boolean);
    let clauseRefs: Array<{ standard: string; clauseNo: string }> = [];
    if (clauseIds.length) {
      const clausesResult = await txn.execute(
        `SELECT standard, clause_no FROM qms.clause_registry WHERE id = ANY(:ids::uuid[]) ORDER BY standard`,
        [{ name: 'ids', value: { stringValue: `{${clauseIds.join(',')}}` } }],
      );
      clauseRefs = marshalMany(clausesResult).map((r) => ({
        standard: r.standard as string,
        clauseNo: r.clauseNo as string,
      }));
    }

    const content = JSON.stringify({
      schemaVersion: 1,
      harmonizationKey: sectionKey,
      clauseRefs,
      kind: 'prose',
      sentences: sentences.map((s) => ({ text: s.text })),
    });
    const contentKey = sectionContentKey(tenantId, runId, sectionKey);
    const contentSha = sha256Hex(content);
    await s3.send(
      new PutObjectCommand({
        Bucket: GENERAL_BUCKET,
        Key: contentKey,
        Body: content,
        ContentType: 'application/json',
      }),
    );
    await txn.execute(
      `UPDATE qms.generation_sections
       SET status = 'prose', content_s3_key = :key, content_sha256 = :sha, updated_at = NOW()
       WHERE id = :id::uuid`,
      [
        { name: 'key', value: { stringValue: contentKey } },
        { name: 'sha', value: { stringValue: contentSha } },
        { name: 'id', value: { stringValue: sectionId } },
      ],
    );
    await txn.commit();
    return 'prose';
  } catch (err) {
    try {
      await txn.rollback();
    } catch {
      /* never mask */
    }
    throw err;
  }
}

export async function handler(event: RegenerateInput): Promise<Record<string, unknown>> {
  const { tenantId, runId, harmonizationKey, actor } = event;
  logger.appendKeys({ tenantId, runId, harmonizationKey });

  // ── 1. Guards + reset to pending (review state cleared — APR-1) ───────────
  let sectionId: string;
  let priorKind: string;
  const txn1 = await beginTenantTransaction(tenantId);
  try {
    const run = await loadRun(txn1, runId);
    if (!run) throw new Error('RUN_NOT_FOUND');
    if (!run.manualDocumentId) throw new Error('RUN_NOT_FINALIZED');

    const secResult = await txn1.execute(
      `SELECT id, status FROM qms.generation_sections
       WHERE run_id = :runId::uuid AND harmonization_key = :hkey`,
      [
        { name: 'runId', value: { stringValue: runId } },
        { name: 'hkey', value: { stringValue: harmonizationKey } },
      ],
    );
    if (!secResult.records?.length) throw new Error('SECTION_NOT_FOUND');
    sectionId = (secResult.records[0][0] as { stringValue?: string }).stringValue!;
    priorKind = (
      (secResult.records[0][1] as { stringValue?: string }).stringValue ?? ''
    ).toLowerCase();

    await txn1.execute(
      `UPDATE qms.generation_sections
       SET status = 'pending', error = NULL, reviewed_by = NULL, reviewed_at = NULL, updated_at = NOW()
       WHERE id = :id::uuid`,
      [{ name: 'id', value: { stringValue: sectionId } }],
    );
    await txn1.commit();
  } catch (err) {
    try {
      await txn1.rollback();
    } catch {
      /* never mask */
    }
    throw err;
  }

  // ── 2. Compose (in-process; opens its own txn; honest failed on terminal) —
  //      or apply the HITL-approved DocStudio draft (S3 Manual Studio) ───────
  let newKind: string;
  if (event.override?.sentences?.length) {
    newKind = await applyApprovedDraft(
      tenantId,
      runId,
      sectionId,
      harmonizationKey,
      event.override.sentences,
    );
  } else {
    const composed = await composeSection({
      runId,
      tenantId,
      sectionId,
      sectionKey: harmonizationKey,
    });
    newKind = composed.status; // prose | gap | failed
  }

  // ── 3. Version writeback ──────────────────────────────────────────────────
  const txn2 = await beginTenantTransaction(tenantId);
  const audit: Record<string, unknown> = {
    runId,
    harmonizationKey,
    priorKind,
    kind: newKind,
    ...(event.override ? { source: 'manual-section-draft' } : {}),
  };
  let sectionRow: Record<string, unknown>;
  try {
    const run = (await loadRun(txn2, runId))!;
    const manualId = run.manualDocumentId!;
    const locale = (run.profile.documentLocale as string) ?? 'en';
    const sections = await loadSectionStates(txn2, runId);
    const section = sections.find((s) => s.sectionKey === harmonizationKey)!;

    // 3a. New MANUAL version — assembled from ALL current sections
    const manualVersionNo = await nextVersionNo(txn2, manualId);
    const manualContent = assembleManualContent(
      manualId,
      locale,
      run.profile,
      run.standards,
      sections,
    );
    await writeNewVersion(
      txn2,
      tenantId,
      manualId,
      manualVersionNo,
      actor,
      `Section ${harmonizationKey} regenerated`,
      manualContent,
    );
    audit.manualDocumentId = manualId;
    audit.manualVersionNo = manualVersionNo;

    // 3b. Locate this run's master list + entries (the linkage lives in the
    // master-list content — same resolution ExportFn performs).
    const mlResult = await txn2.execute(
      `SELECT DISTINCT ON (d.id) d.id, v.content_ref
       FROM m1.documents d JOIN m1.document_versions v ON v.document_id = d.id
       WHERE d.doc_type = 'master_list'
       ORDER BY d.id, v.version_no DESC`,
    );
    let masterDocId: string | null = null;
    let entries: MasterListEntry[] = [];
    for (const row of marshalMany(mlResult)) {
      const content = await getJson(row.contentRef as string);
      const candidate = (content.entries ?? []) as MasterListEntry[];
      if (candidate.some((e) => e.documentId === manualId)) {
        masterDocId = row.id as string;
        entries = candidate;
        break;
      }
    }
    if (!masterDocId) throw new Error('MASTER_LIST_NOT_FOUND');

    // 3c. Clause document for this section — matched by harmonizationKey in
    // the candidate's CURRENT content (clauseRefs overlap narrows the fetches).
    const sectionClauseNos = new Set(section.clauses.map((c) => c.clauseNo));
    let clauseDocId: string | null = null;
    for (const entry of entries) {
      if (entry.docType === 'manual' || entry.docType === 'correlation_matrix') continue;
      if (!entry.clauseRefs.some((c) => sectionClauseNos.has(c))) continue;
      const latestRef = await txn2.execute(
        `SELECT content_ref FROM m1.document_versions
         WHERE document_id = :docId::uuid ORDER BY version_no DESC LIMIT 1`,
        [{ name: 'docId', value: { stringValue: entry.documentId } }],
      );
      const ref = (latestRef.records?.[0]?.[0] as { stringValue?: string })?.stringValue;
      if (!ref) continue;
      const content = await getJson(ref);
      const hkey = (content.sections as Array<{ harmonizationKey?: string }> | undefined)?.[0]
        ?.harmonizationKey;
      if (hkey === harmonizationKey) {
        clauseDocId = entry.documentId;
        break;
      }
    }

    const clauseDocContent = (docId: string, versionNo: number) => ({
      schemaVersion: 1,
      documentId: docId,
      versionNo,
      locale,
      frontMatter: buildFrontMatter(run.profile, run.standards),
      sections: [
        {
          harmonizationKey: section.sectionKey,
          clauseRefs: section.clauses.map((c) => ({ standard: c.standard, clauseNo: c.clauseNo })),
          kind: section.kind,
          ...(section.content?.sentences !== undefined
            ? { sentences: section.content.sentences }
            : {}),
          ...(section.content?.gap !== undefined ? { gap: section.content.gap } : {}),
          ...(section.content?.naJustification !== undefined
            ? { naJustification: section.content.naJustification }
            : {}),
        },
      ],
    });

    if (newKind !== 'failed') {
      if (clauseDocId) {
        const vNo = await nextVersionNo(txn2, clauseDocId);
        await writeNewVersion(
          txn2,
          tenantId,
          clauseDocId,
          vNo,
          actor,
          `Section ${harmonizationKey} regenerated`,
          clauseDocContent(clauseDocId, vNo),
        );
        audit.clauseDocumentId = clauseDocId;
        audit.clauseVersionNo = vNo;
      } else {
        // Previously-failed section shipped NO clause document — create it
        // now (regeneration is the PARTIAL-run repair path).
        const sectionStandard = documentStandard([
          ...new Set(section.clauses.map((c) => c.standard)),
        ]);
        const docType = section.clauses[0]?.docType ?? 'procedure';
        const title = clauseDocTitle(section);
        const clauseNos = [...new Set(section.clauses.map((c) => c.clauseNo))];
        const insertRes = await txn2.execute(
          `INSERT INTO m1.documents (tenant_id, standard, doc_type, title, clause_refs, owner_id, status, created_by)
           VALUES (:tenantId, :standard, :docType, :title, :clauseRefs::text[], :owner, 'draft', :owner)
           RETURNING id`,
          [
            { name: 'tenantId', value: { stringValue: tenantId } },
            { name: 'standard', value: { stringValue: sectionStandard } },
            { name: 'docType', value: { stringValue: docType } },
            { name: 'title', value: { stringValue: title } },
            { name: 'clauseRefs', value: { stringValue: `{${clauseNos.join(',')}}` } },
            { name: 'owner', value: { stringValue: actor } },
          ],
        );
        clauseDocId = (insertRes.records![0][0] as { stringValue?: string }).stringValue!;
        await writeNewVersion(
          txn2,
          tenantId,
          clauseDocId,
          1,
          actor,
          `Section ${harmonizationKey} regenerated (document created)`,
          clauseDocContent(clauseDocId, 1),
        );
        entries.push({
          documentId: clauseDocId,
          title,
          docType,
          standard: sectionStandard,
          clauseRefs: clauseNos,
          status: 'draft',
          versionNo: 1,
          contentRef: versionContentKey(tenantId, clauseDocId, 1),
        });
        audit.clauseDocumentId = clauseDocId;
        audit.clauseVersionNo = 1;
        audit.clauseDocumentCreated = true;
      }
    }
    // still-failed: no clause version — failed prose never ships (design §4.3)

    // 3d. Correlation matrix — only when the section kind changed
    if (newKind !== priorKind) {
      const matrixEntry = entries.find((e) => e.docType === 'correlation_matrix');
      if (matrixEntry) {
        const vNo = await nextVersionNo(txn2, matrixEntry.documentId);
        await writeNewVersion(
          txn2,
          tenantId,
          matrixEntry.documentId,
          vNo,
          actor,
          `Section ${harmonizationKey} regenerated (${priorKind} → ${newKind})`,
          deriveCorrelationMatrix(matrixEntry.documentId, locale, run.standards, sections),
        );
        audit.matrixVersionNo = vNo;
      }
    }

    // 3e. Master list REFRESH — every entry re-pointed at its latest version
    // (closes the Task-9 carry-forward: exports no longer pin clause docs at v1).
    const entryIds = entries.map((e) => e.documentId);
    const latestResult = await txn2.execute(
      `SELECT DISTINCT ON (v.document_id) v.document_id, v.version_no, v.content_ref, d.status
       FROM m1.document_versions v JOIN m1.documents d ON d.id = v.document_id
       WHERE v.document_id = ANY(:ids::uuid[])
       ORDER BY v.document_id, v.version_no DESC`,
      [{ name: 'ids', value: { stringValue: `{${entryIds.join(',')}}` } }],
    );
    const latestByDoc = new Map(marshalMany(latestResult).map((r) => [r.documentId as string, r]));
    const refreshed: MasterListEntry[] = entries.map((e) => {
      const latest = latestByDoc.get(e.documentId);
      return latest
        ? {
            ...e,
            versionNo: latest.versionNo as number,
            contentRef: latest.contentRef as string,
            status: ((latest.status as string) ?? e.status).toLowerCase(),
          }
        : e;
    });
    const masterVersionNo = await nextVersionNo(txn2, masterDocId);
    await writeNewVersion(
      txn2,
      tenantId,
      masterDocId,
      masterVersionNo,
      actor,
      `Section ${harmonizationKey} regenerated — entries refreshed`,
      deriveMasterList(masterDocId, locale, refreshed),
    );
    audit.masterListVersionNo = masterVersionNo;

    // 3f. Run status recompute — failed>0 → partial, else complete
    const failedCount = sections.filter((s) => s.kind === 'failed').length;
    const newRunStatus = failedCount > 0 ? 'partial' : 'complete';
    if (newRunStatus !== run.status) {
      await txn2.execute(
        `UPDATE qms.generation_runs SET status = :status, updated_at = NOW() WHERE id = :runId::uuid`,
        [
          { name: 'status', value: { stringValue: newRunStatus } },
          { name: 'runId', value: { stringValue: runId } },
        ],
      );
    }
    audit.runStatus = newRunStatus;

    // Return the section in the GraphQL GenerationSection shape (same SELECT
    // as getGenerationRun — kind reverse-enum-maps to UPPERCASE in marshal).
    const rowResult = await txn2.execute(
      `SELECT id, harmonization_key, status AS kind, clause_registry_ids AS clause_refs,
              content_sha256, reviewed_by, reviewed_at, error
       FROM qms.generation_sections WHERE id = :id::uuid`,
      [{ name: 'id', value: { stringValue: sectionId } }],
    );
    sectionRow = marshalMany(rowResult)[0];

    await txn2.commit();
  } catch (err) {
    try {
      await txn2.rollback();
    } catch {
      /* never mask */
    }
    throw err;
  }

  await publishAuditEvent({
    tenantId,
    actor,
    module: 'M1',
    clauseRef: harmonizationKey,
    standard: 'IMS',
    detailType: 'Generation.SectionRegenerated',
    source: 'cumplify.qms.docgen',
    entityId: sectionId,
    payload: audit,
  });

  logger.info('Section regenerated', audit);
  return sectionRow;
}
