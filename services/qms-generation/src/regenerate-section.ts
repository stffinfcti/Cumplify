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
  assertTenantIdSafe,
  beginTenantTransaction,
  marshalMany,
  publishAuditEvent,
  versionContentKey,
  rollbackQuietly,
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
import { loadRun, loadSectionSkeletons } from './run-state.js';

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

async function getJson(key: string): Promise<Record<string, unknown>> {
  const obj = await s3.send(new GetObjectCommand({ Bucket: GENERAL_BUCKET, Key: key }));
  return JSON.parse(await obj.Body!.transformToString()) as Record<string, unknown>;
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
    await rollbackQuietly(txn);
    throw err;
  }
}

export async function handler(event: RegenerateInput): Promise<Record<string, unknown>> {
  const { tenantId, runId, harmonizationKey, actor } = event;
  assertTenantIdSafe(tenantId);
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
    await rollbackQuietly(txn1);
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

  // ── 3. Version writeback — one txn, serialized on the run row ───────────

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
    // Lock the run row FIRST: every concurrent regeneration of this run
    // serializes here, so the second observes the first's committed docs,
    // sections and contents instead of a prefetch snapshot taken before the
    // lock. Everything downstream — skeletons, content JSONs, doc ids, the
    // master list, the run-status flip — is read live inside this txn.
    const runLock = await txn2.execute(
      `SELECT id FROM qms.generation_runs WHERE id = :runId::uuid FOR UPDATE`,
      [{ name: 'runId', value: { stringValue: runId } }],
    );
    if (!runLock.records?.length) throw new Error('RUN_NOT_FOUND');

    const run = (await loadRun(txn2, runId))!;
    const manualId = run.manualDocumentId!;
    const locale = (run.profile.documentLocale as string) ?? 'en';

    const skeletons = await loadSectionSkeletons(txn2, runId);
    const contents = await Promise.all(
      skeletons.map((sk) => (sk.contentS3Key ? getJson(sk.contentS3Key) : null)),
    );
    const sections: SectionState[] = skeletons.map((sk, i) => ({
      sectionKey: sk.sectionKey,
      kind: sk.kind,
      clauses: sk.clauses,
      sortOrder: sk.sortOrder,
      content: contents[i],
    }));
    const section = sections.find((s) => s.sectionKey === harmonizationKey);
    if (!section) throw new Error('SECTION_NOT_FOUND');

    // Generated docs are uniquely keyed by harmonization_key (migration 019
    // partial unique index) — sentinel lookups, not DISTINCT-ON scans.
    let masterDocId: string | null = null;
    let matrixDocId: string | null = null;
    let clauseDocId: string | null = null;
    const docResult = await txn2.execute(
      `SELECT d.harmonization_key, d.id, d.doc_type
       FROM m1.documents d
       WHERE d.harmonization_key IN ('__MASTER_LIST__', '__CORRELATION_MATRIX__', :hkey)`,
      [{ name: 'hkey', value: { stringValue: harmonizationKey } }],
    );
    for (const row of marshalMany(docResult)) {
      if (row.harmonizationKey === '__MASTER_LIST__') {
        masterDocId = row.id as string;
      } else if (row.harmonizationKey === '__CORRELATION_MATRIX__') {
        matrixDocId = row.id as string;
      } else if (row.harmonizationKey === harmonizationKey) {
        clauseDocId = row.id as string;
      }
    }
    if (!masterDocId) throw new Error('MASTER_LIST_NOT_FOUND');

    // One batched MAX(version_no)+1 for every doc being versioned — the
    // document rows lock FOR UPDATE in id order (deterministic lock order
    // across concurrent regenerations) so a racing version writer lands on
    // migration 022's UNIQUE(document_id, version_no) instead of colliding
    // silently.
    const versionedDocIds = [
      ...new Set(
        [manualId, clauseDocId, newKind !== priorKind ? matrixDocId : null, masterDocId].filter(
          (id): id is string => !!id,
        ),
      ),
    ];
    const versionResult = await txn2.execute(
      `WITH lock AS (
         SELECT id FROM m1.documents WHERE id = ANY(:ids::uuid[]) ORDER BY id FOR UPDATE
       )
       SELECT l.id AS document_id, COALESCE(MAX(v.version_no), 0) + 1 AS next
       FROM lock l LEFT JOIN m1.document_versions v ON v.document_id = l.id
       GROUP BY l.id`,
      [{ name: 'ids', value: { stringValue: `{${versionedDocIds.join(',')}}` } }],
    );
    // LEFT JOIN FROM the lock set: the CTE is referenced (an unreferenced
    // SELECT CTE is planner-dropped — zero locks taken) and every locked doc
    // yields a row even with zero version rows (next = 1).
    const nextByDoc = new Map(
      marshalMany(versionResult).map((r) => [r.documentId as string, Number(r.next)]),
    );

    // 3c. New MANUAL version — assembled from ALL current sections
    const manualVersionNo = nextByDoc.get(manualId)!;
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
        const vNo = nextByDoc.get(clauseDocId)!;
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
          `INSERT INTO m1.documents
             (tenant_id, standard, doc_type, title, clause_refs, harmonization_key, owner_id, status, created_by)
           VALUES (:tenantId, :standard, :docType, :title, :clauseRefs::text[], :hkey, :owner, 'draft', :owner)
           RETURNING id`,
          [
            { name: 'tenantId', value: { stringValue: tenantId } },
            { name: 'standard', value: { stringValue: sectionStandard } },
            { name: 'docType', value: { stringValue: docType } },
            { name: 'title', value: { stringValue: title } },
            { name: 'clauseRefs', value: { stringValue: `{${clauseNos.join(',')}}` } },
            { name: 'hkey', value: { stringValue: harmonizationKey } },
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
        audit.clauseDocumentId = clauseDocId;
        audit.clauseVersionNo = 1;
        audit.clauseDocumentCreated = true;
      }
    }
    // still-failed: no clause version — failed prose never ships (design §4.3)

    // 3d. Correlation matrix — only when the section kind changed
    if (newKind !== priorKind && matrixDocId) {
      const vNo = nextByDoc.get(matrixDocId)!;
      await writeNewVersion(
        txn2,
        tenantId,
        matrixDocId,
        vNo,
        actor,
        `Section ${harmonizationKey} regenerated (${priorKind} → ${newKind})`,
        deriveCorrelationMatrix(matrixDocId, locale, run.standards, sections),
      );
      audit.matrixVersionNo = vNo;
    }

    // 3e. Master list REFRESH — rebuilt from live documents inside the run
    // lock, not carried forward from the prior S3 master JSON: a concurrent
    // regen's newly-created clause doc or bumped version lands in this
    // rewrite instead of being dropped by a stale snapshot. Order: manual,
    // clause docs in section order, matrix — same as finalize-manual.
    const hkeys = ['__MANUAL__', '__CORRELATION_MATRIX__', ...sections.map((s) => s.sectionKey)];
    const entryResult = await txn2.execute(
      `SELECT d.id, d.harmonization_key, d.title, d.doc_type, d.standard,
              d.clause_refs, d.status, v.version_no, v.content_ref
       FROM m1.documents d
       JOIN LATERAL (
         SELECT version_no, content_ref FROM m1.document_versions
         WHERE document_id = d.id ORDER BY version_no DESC LIMIT 1
       ) v ON true
       WHERE d.harmonization_key = ANY(:hkeys::text[])`,
      [{ name: 'hkeys', value: { stringValue: `{${hkeys.join(',')}}` } }],
    );
    const docByHkey = new Map(
      marshalMany(entryResult).map((r) => [r.harmonizationKey as string, r]),
    );
    const toEntry = (r: Record<string, unknown>): MasterListEntry => ({
      documentId: r.id as string,
      title: r.title as string,
      docType: r.docType as string,
      standard: r.standard as string,
      clauseRefs: (r.clauseRefs as string[]) ?? [],
      status: ((r.status as string) ?? 'draft').toLowerCase(),
      versionNo: r.versionNo as number,
      contentRef: r.contentRef as string,
    });
    const refreshed: MasterListEntry[] = [
      ...(docByHkey.get('__MANUAL__') ? [toEntry(docByHkey.get('__MANUAL__')!)] : []),
      ...sections
        .map((s) => docByHkey.get(s.sectionKey))
        .filter((r): r is Record<string, unknown> => !!r)
        .map(toEntry),
      ...(docByHkey.get('__CORRELATION_MATRIX__')
        ? [toEntry(docByHkey.get('__CORRELATION_MATRIX__')!)]
        : []),
    ];
    const masterVersionNo = nextByDoc.get(masterDocId)!;
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
    await rollbackQuietly(txn2);
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
