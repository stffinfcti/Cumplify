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
  beginTenantTransaction,
  marshalMany,
  publishAuditEvent,
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

function docContentKey(tenantId: string, documentId: string, versionNo: number): string {
  return `tenants/${tenantId}/documents/${documentId}/v${versionNo}.json`;
}

type Txn = Awaited<ReturnType<typeof beginTenantTransaction>>;

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
    // one CTE statement instead of two round-trips per document.
    const versionResult = await txn.execute(
      `WITH lock AS (SELECT id FROM m1.documents WHERE id = :docId::uuid FOR UPDATE)
       SELECT COALESCE(MAX(v.version_no), 0) + 1 AS next
       FROM m1.document_versions v
       WHERE v.document_id = :docId::uuid`,
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
  const contentRef = docContentKey(tenantId, documentId, versionNo);
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
  logger.appendKeys({ runId, tenantId });

  const txn = await beginTenantTransaction(tenantId);
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
  try {
    // Load run — idempotency guard first
    const runResult = await txn.execute(
      `SELECT gr.standards, gr.manual_document_id, gr.requested_by, opv.payload
       FROM qms.generation_runs gr
       JOIN qms.org_profiles op ON op.tenant_id = gr.tenant_id
       JOIN qms.org_profile_versions opv ON opv.profile_id = op.id AND opv.version_no = gr.profile_version
       WHERE gr.id = :runId::uuid`,
      [{ name: 'runId', value: { stringValue: runId } }],
    );
    if (!runResult.records?.length) throw new Error(`RUN_NOT_FOUND: ${runId}`);
    const rec = runResult.records[0];
    const standards =
      (rec[0] as { arrayValue?: { stringValues?: string[] } }).arrayValue?.stringValues ?? [];
    const existingManualId =
      (rec[1] as { stringValue?: string; isNull?: boolean }).stringValue ?? null;
    const owner = (rec[2] as { stringValue?: string }).stringValue ?? 'docgen-state-machine';
    const profile = JSON.parse((rec[3] as { stringValue?: string }).stringValue ?? '{}') as Record<
      string,
      unknown
    >;
    const locale = (profile.documentLocale as string) ?? 'en';

    // Section states + registry join
    const sectionsResult = await txn.execute(
      `SELECT id, harmonization_key, status, content_s3_key, clause_registry_ids
       FROM qms.generation_sections WHERE run_id = :runId::uuid ORDER BY harmonization_key`,
      [{ name: 'runId', value: { stringValue: runId } }],
    );
    // marshalMany reverse-maps the overloaded `status` column to GraphQL
    // UPPERCASE (d11d803) — normalize back to DB casing for internal logic.
    const sectionRows: Record<string, unknown>[] = marshalMany(sectionsResult).map((r) => ({
      ...r,
      status: (r.status as string).toLowerCase(),
    }));
    for (const row of sectionRows) {
      const s = row.status as string;
      summary[s] = (summary[s] ?? 0) + 1;
    }
    status = (summary.failed ?? 0) > 0 ? 'partial' : 'complete';

    if (existingManualId) {
      // Already finalized — GEN-5 idempotent re-entry
      await txn.commit();
      logger.info('Run already finalized — skipping document writes', { existingManualId });
      return { runId, status, summary, manualDocumentId: existingManualId, documentsCreated: 0 };
    }

    const registryResult = await txn.execute(
      `SELECT id, standard, clause_no, clause_title, annex_sl_mode, doc_type, sort_order
       FROM qms.clause_registry`,
    );
    const registryById = new Map(marshalMany(registryResult).map((r) => [r.id as string, r]));

    // Build SectionState[] — content JSONs from S3
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
          // doc_type is REVERSE_ENUMS-mapped to UPPERCASE by marshalMany —
          // normalize back to DB casing (same class as the status fix above)
          docType: (c.docType as string).toLowerCase(),
        }));
      const sortOrder = Math.min(
        ...clauseIds.map((id) => (registryById.get(id)?.sortOrder as number) ?? 9999),
      );
      let content: Record<string, unknown> | null = null;
      const key = row.contentS3Key as string | null;
      if (key) {
        const obj = await s3.send(new GetObjectCommand({ Bucket: GENERAL_BUCKET, Key: key }));
        content = JSON.parse(await obj.Body!.transformToString()) as Record<string, unknown>;
      }
      sections.push({
        sectionKey: row.harmonizationKey as string,
        kind: row.status as SectionState['kind'],
        clauses,
        content,
        sortOrder,
      });
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

    // 2. Clause documents — failed sections ship nothing
    for (const section of sections) {
      if (section.kind === 'failed') continue;
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
      documentsCreated++;
      masterEntries.push({
        documentId: docId,
        title,
        docType,
        standard: sectionStandard,
        clauseRefs: clauseNos,
        status: 'draft',
        versionNo: doc.versionNo,
        contentRef: version.contentRef,
      });
    }

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
    try {
      await txn.rollback();
    } catch {
      /* never mask */
    }
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
