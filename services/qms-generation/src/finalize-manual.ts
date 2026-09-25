/**
 * FinalizeManual Lambda — DocGenStateMachine step 3 (spec 40, Task 6).
 * GEN-4 / GEN-8 / BC-8: content_ref becomes REAL.
 *
 * Writes, in ONE tenant transaction (S3 puts interleaved before commit):
 *   1. ONE manual document (`doc_type='manual'`, standard='IMS' when the run
 *      spans >1 standard) — content JSON per design §3 with BC-1 disclaimer
 *      front matter and EVERY section (prose/gap/na_justified/failed marker).
 *   2. One clause document per non-failed section (doc_type from registry).
 *      Failed sections ship NO clause document — their checker-rejected prose
 *      is not shipped anywhere (design §4.3); they appear in the manual as an
 *      explicit failed marker and in the run summary.
 *   3. Standards Correlation Matrix + Documented-Information Master List —
 *      DERIVED (derive.ts), never model-authored.
 *   4. `generation_runs`: terminal status ('partial' when any section
 *      failed), finished_at, manual_document_id (Task 8's approval
 *      preconditions find the run through this).
 *
 * Idempotency (GEN-5): a run with manual_document_id already set is
 * finalized — the handler recomputes nothing and returns the stored state.
 */

import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { Logger } from '@aws-lambda-powertools/logger';
import {
  assertTenantIdSafe,
  beginTenantTransaction,
  publishAuditEvent,
  versionContentKey,
  rollbackQuietly,
} from '../../api/src/resolvers/shared.js';
import { publishGenerationEvent } from './appsync-publish.js';
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

const logger = new Logger({ serviceName: 'qms-finalize-manual' });
const s3 = new S3Client({});
const GENERAL_BUCKET = process.env.GENERAL_BUCKET!;

export interface FinalizeInput {
  runId: string;
  tenantId: string;
}
export interface FinalizeOutput {
  runId: string;
  status: string;
  summary: Record<string, number>;
  manualDocumentId: string | null;
  documentsCreated: number;
}

const MANUAL_TITLES: Record<string, string> = {
  IMS: 'Integrated Management System Manual',
  ISO9001: 'Quality Management System Manual',
  ISO14001: 'Environmental Management System Manual',
  ISO45001: 'OH&S Management System Manual',
};

type Txn = Awaited<ReturnType<typeof beginTenantTransaction>>;
import { loadRun, loadSectionSkeletons, type SectionSkeleton } from './run-state.js';

/** map with bounded concurrency — Data API round-trips on one transaction
 * can overlap on the wire (each per-document chain stays internally
 * sequential), but unbounded fan-out would throttle. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let idx = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (idx < items.length) {
        const i = idx++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

async function insertDocument(
  txn: Txn,
  tenantId: string,
  opts: {
    standard: string;
    docType: string;
    title: string;
    clauseRefs: string[];
    owner: string;
    harmonizationKey?: string;
  },
): Promise<{ documentId: string; versionNo: number }> {
  if (opts.harmonizationKey) {
    // B2 (ruling C): idempotent finalize per harmonizationKey — ON CONFLICT
    // updates the existing document instead of creating a duplicate.
    const result = await txn.execute(
      `INSERT INTO m1.documents (tenant_id, standard, doc_type, title, clause_refs, harmonization_key, owner_id, status, created_by)
       VALUES (:tenantId, :standard, :docType, :title, :clauseRefs::text[], :hk, :owner, 'draft', :owner)
       ON CONFLICT (tenant_id, harmonization_key) WHERE harmonization_key IS NOT NULL
       DO UPDATE SET title = EXCLUDED.title, clause_refs = EXCLUDED.clause_refs,
                     standard = EXCLUDED.standard, updated_at = NOW(), version = m1.documents.version + 1
       RETURNING id`,
      [
        { name: 'tenantId', value: { stringValue: tenantId } },
        { name: 'standard', value: { stringValue: opts.standard } },
        { name: 'docType', value: { stringValue: opts.docType } },
        { name: 'title', value: { stringValue: opts.title } },
        { name: 'clauseRefs', value: { stringValue: `{${opts.clauseRefs.join(',')}}` } },
        { name: 'hk', value: { stringValue: opts.harmonizationKey } },
        { name: 'owner', value: { stringValue: opts.owner } },
      ],
    );
    const [idCol] = result.records![0] as [{ stringValue?: string }];
    const documentId = idCol.stringValue!;
    // document_versions.version_no counts ALL writers (section edits in m1.ts
    // too), while documents.version counts finalize upserts only — reusing it
    // would collide with edited versions and overwrite their S3 content key.
    // Lock the document row, then take MAX(version_no)+1 (m1.ts:826 pattern) —
    // one CTE statement instead of two round-trips per document. The LEFT JOIN
    // FROM the lock CTE keeps it load-bearing (Postgres skips unreferenced
    // SELECT CTEs → no lock taken) and yields a row even with zero versions.
    const versionResult = await txn.execute(
      `WITH lock AS (SELECT id FROM m1.documents WHERE id = :docId::uuid FOR UPDATE)
       SELECT COALESCE(MAX(v.version_no), 0) + 1 AS next
       FROM lock l LEFT JOIN m1.document_versions v ON v.document_id = l.id
       GROUP BY l.id`,
      [{ name: 'docId', value: { stringValue: documentId } }],
    );
    const versionNo = Number((versionResult.records![0][0] as { longValue?: number }).longValue);
    return { documentId, versionNo };
  }

  // Non-generated documents (manual creation, no harmonizationKey)
  const result = await txn.execute(
    `INSERT INTO m1.documents (tenant_id, standard, doc_type, title, clause_refs, owner_id, status, created_by)
     VALUES (:tenantId, :standard, :docType, :title, :clauseRefs::text[], :owner, 'draft', :owner)
     RETURNING id`,
    [
      { name: 'tenantId', value: { stringValue: tenantId } },
      { name: 'standard', value: { stringValue: opts.standard } },
      { name: 'docType', value: { stringValue: opts.docType } },
      { name: 'title', value: { stringValue: opts.title } },
      { name: 'clauseRefs', value: { stringValue: `{${opts.clauseRefs.join(',')}}` } },
      { name: 'owner', value: { stringValue: opts.owner } },
    ],
  );
  return {
    documentId: (result.records![0][0] as { stringValue?: string }).stringValue!,
    versionNo: 1,
  };
}

async function writeVersion(
  txn: Txn,
  tenantId: string,
  documentId: string,
  versionNo: number,
  owner: string,
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
  // versionNo is MAX(document_versions.version_no)+1 taken under the
  // documents row lock, so a re-finalize appends vN+1 instead of colliding
  // with section edits or overwriting sealed content.
  await txn.execute(
    `INSERT INTO m1.document_versions
       (tenant_id, document_id, version_no, content_ref, content_sha256, change_summary, author_id, created_by)
     VALUES (:tenantId, :docId::uuid, :versionNo::integer, :contentRef, :contentSha, 'Generated by DocGen run', :owner, :owner)`,
    [
      { name: 'tenantId', value: { stringValue: tenantId } },
      { name: 'docId', value: { stringValue: documentId } },
      { name: 'versionNo', value: { stringValue: String(versionNo) } },
      { name: 'contentRef', value: { stringValue: contentRef } },
      { name: 'contentSha', value: { stringValue: contentSha } },
      { name: 'owner', value: { stringValue: owner } },
    ],
  );
  return { contentRef, contentSha };
}

export async function handler(event: FinalizeInput): Promise<FinalizeOutput> {
  const { runId, tenantId } = event;
  assertTenantIdSafe(tenantId);
  logger.appendKeys({ runId, tenantId });

  let status: string;
  let manualDocumentId: string | null = null;
  let documentsCreated = 0;
  const summary: Record<string, number> = {
    prose: 0,
    gap: 0,
    na_justified: 0,
    failed: 0,
    pending: 0,
  };

  // ── Phase 1 (read txn): run + sections + registry. The ~40 section
  // content GetObjects used to serialize INSIDE this txn — a Data-API
  // session slot held across seconds of S3 latency. They prefetch in
  // parallel in phase 2 instead; document writes move to phase 3, which
  // re-checks the idempotency guard under the run row's FOR UPDATE lock.
  let standards: string[];
  let owner: string;
  let profile: Record<string, unknown>;
  let skeletons: SectionSkeleton[];
  const readTxn = await beginTenantTransaction(tenantId);
  try {
    // Load run — idempotency guard first
    const run = await loadRun(readTxn, runId);
    if (!run) throw new Error(`RUN_NOT_FOUND: ${runId}`);
    standards = run.standards;
    const existingManualId = run.manualDocumentId;
    owner = run.requestedBy ?? 'docgen-state-machine';
    profile = run.profile;

    skeletons = await loadSectionSkeletons(readTxn, runId);
    for (const sk of skeletons) {
      summary[sk.kind] = (summary[sk.kind] ?? 0) + 1;
    }
    status = (summary.failed ?? 0) > 0 ? 'partial' : 'complete';

    if (existingManualId) {
      // Already finalized — GEN-5 idempotent re-entry
      await readTxn.commit();
      logger.info('Run already finalized — skipping document writes', { existingManualId });
      return { runId, status, summary, manualDocumentId: existingManualId, documentsCreated: 0 };
    }
    await readTxn.commit();
  } catch (err) {
    await rollbackQuietly(readTxn);
    throw err;
  }

  // ── Phase 2 (no txn): every section content JSON in parallel.
  const contents = await Promise.all(
    skeletons.map(async (sk) => {
      if (!sk.contentS3Key) return null;
      const obj = await s3.send(
        new GetObjectCommand({ Bucket: GENERAL_BUCKET, Key: sk.contentS3Key }),
      );
      return JSON.parse(await obj.Body!.transformToString()) as Record<string, unknown>;
    }),
  );
  const sections: SectionState[] = skeletons.map((sk, i) => ({
    sectionKey: sk.sectionKey,
    kind: sk.kind,
    clauses: sk.clauses,
    sortOrder: sk.sortOrder,
    content: contents[i],
  }));
  const locale = (profile.documentLocale as string) ?? 'en';

  // ── Phase 3 (write txn): re-check idempotency under the run row's lock,
  // then every document write. A concurrent finalize that committed between
  // phase 1 and this lock wins — we return its manual id.
  const txn = await beginTenantTransaction(tenantId);
  try {
    const recheck = await txn.execute(
      `SELECT manual_document_id FROM qms.generation_runs WHERE id = :runId::uuid FOR UPDATE`,
      [{ name: 'runId', value: { stringValue: runId } }],
    );
    const racedManualId =
      ((recheck.records?.[0]?.[0] as { stringValue?: string; isNull?: boolean }) ?? {})
        .stringValue ?? null;
    if (racedManualId) {
      await txn.commit();
      logger.info('Run finalized by a concurrent invocation — returning its manual id', {
        racedManualId,
      });
      return {
        runId,
        status,
        summary,
        manualDocumentId: racedManualId,
        documentsCreated: 0,
      };
    }

    const manualStandard = documentStandard(standards);
    const allClauseNos = [
      ...new Set(sections.flatMap((s) => s.clauses.map((c) => c.clauseNo))),
    ].sort();
    const masterEntries: MasterListEntry[] = [];

    // 1. Manual
    const manualDoc = await insertDocument(txn, tenantId, {
      standard: manualStandard,
      docType: 'manual',
      title: MANUAL_TITLES[manualStandard] ?? MANUAL_TITLES.IMS,
      clauseRefs: allClauseNos,
      owner,
      harmonizationKey: '__MANUAL__',
    });
    manualDocumentId = manualDoc.documentId;
    const manualContent = assembleManualContent(
      manualDocumentId,
      locale,
      profile,
      standards,
      sections,
    );
    const manualVersion = await writeVersion(
      txn,
      tenantId,
      manualDocumentId,
      manualDoc.versionNo,
      owner,
      manualContent,
    );
    documentsCreated++;
    masterEntries.push({
      documentId: manualDocumentId,
      title: MANUAL_TITLES[manualStandard] ?? MANUAL_TITLES.IMS,
      docType: 'manual',
      standard: manualStandard,
      clauseRefs: allClauseNos,
      status: 'draft',
      versionNo: manualDoc.versionNo,
      contentRef: manualVersion.contentRef,
    });

    // 2. Clause documents — failed sections ship nothing. Each section's
    // chain (insert → lock+MAX+1 → S3 → version insert) is independent of
    // every other doc's, so chains overlap at bounded concurrency instead of
    // ~3 serial round-trips each (~120 sequential calls on a full run).
    const clauseEntries = await mapLimit(
      sections.filter((section) => section.kind !== 'failed'),
      8,
      async (section) => {
        const sectionStandard = documentStandard([
          ...new Set(section.clauses.map((c) => c.standard)),
        ]);
        const docType = section.clauses[0]?.docType ?? 'procedure';
        const title = clauseDocTitle(section);
        const clauseNos = [...new Set(section.clauses.map((c) => c.clauseNo))];
        const doc = await insertDocument(txn, tenantId, {
          standard: sectionStandard,
          docType,
          title,
          clauseRefs: clauseNos,
          owner,
          harmonizationKey: section.sectionKey,
        });
        const docId = doc.documentId;
        const content = {
          schemaVersion: 1,
          documentId: docId,
          versionNo: doc.versionNo,
          locale,
          frontMatter: buildFrontMatter(profile, standards),
          sections: [
            {
              harmonizationKey: section.sectionKey,
              clauseRefs: section.clauses.map((c) => ({
                standard: c.standard,
                clauseNo: c.clauseNo,
              })),
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
        };
        const version = await writeVersion(txn, tenantId, docId, doc.versionNo, owner, content);
        return {
          documentId: docId,
          title,
          docType,
          standard: sectionStandard,
          clauseRefs: clauseNos,
          status: 'draft' as const,
          versionNo: doc.versionNo,
          contentRef: version.contentRef,
        };
      },
    );
    documentsCreated += clauseEntries.length;
    masterEntries.push(...clauseEntries);

    // 3. Correlation matrix + master list (derived, never authored)
    const matrixDoc = await insertDocument(txn, tenantId, {
      standard: manualStandard,
      docType: 'correlation_matrix',
      title: 'Standards Correlation Matrix',
      clauseRefs: allClauseNos,
      owner,
      harmonizationKey: '__CORRELATION_MATRIX__',
    });
    const matrixId = matrixDoc.documentId;
    const matrixVersion = await writeVersion(
      txn,
      tenantId,
      matrixId,
      matrixDoc.versionNo,
      owner,
      deriveCorrelationMatrix(matrixId, locale, standards, sections),
    );
    documentsCreated++;
    masterEntries.push({
      documentId: matrixId,
      title: 'Standards Correlation Matrix',
      docType: 'correlation_matrix',
      standard: manualStandard,
      clauseRefs: allClauseNos,
      status: 'draft',
      versionNo: matrixDoc.versionNo,
      contentRef: matrixVersion.contentRef,
    });

    const masterDoc = await insertDocument(txn, tenantId, {
      standard: manualStandard,
      docType: 'master_list',
      title: 'Documented Information Master List',
      clauseRefs: ['7.5'],
      owner,
      harmonizationKey: '__MASTER_LIST__',
    });
    const masterId = masterDoc.documentId;
    await writeVersion(
      txn,
      tenantId,
      masterId,
      masterDoc.versionNo,
      owner,
      deriveMasterList(masterId, locale, masterEntries),
    );
    documentsCreated++;

    // 4. Terminal run state + manual pointer (Task 8 finds the run via this)
    await txn.execute(
      `UPDATE qms.generation_runs
       SET status = :status, finished_at = NOW(), manual_document_id = :manualId::uuid, updated_at = NOW()
       WHERE id = :runId::uuid`,
      [
        { name: 'status', value: { stringValue: status } },
        { name: 'manualId', value: { stringValue: manualDocumentId } },
        { name: 'runId', value: { stringValue: runId } },
      ],
    );
    await txn.commit();
  } catch (err) {
    await rollbackQuietly(txn);
    throw err;
  }

  await publishAuditEvent({
    tenantId,
    actor: 'docgen-state-machine',
    module: 'M1',
    clauseRef: 'run',
    standard: 'IMS',
    detailType: 'Generation.RunCompleted',
    source: 'cumplify.qms.docgen',
    entityId: runId,
    payload: { runId, status, summary, manualDocumentId, documentsCreated },
  });
  await publishGenerationEvent({
    runId,
    tenantId,
    type: 'run_complete',
    summary: JSON.stringify({ status, manualDocumentId, documentsCreated, ...summary }),
  });

  logger.info('Run finalized', { status, summary, manualDocumentId, documentsCreated });
  return { runId, status, summary, manualDocumentId, documentsCreated };
}
