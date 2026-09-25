/**
 * forms — record PDF export + approved-record sealing. Extracted from
 * forms.ts.
 */

import { beginTenantTransaction, unwrapField } from '../shared.js';
import { GetObjectCommand, PutObjectCommand, CopyObjectCommand } from '@aws-sdk/client-s3';
import { InvokeCommand } from '@aws-sdk/client-lambda';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { TenantTransaction } from '../shared.js';
import {
  logger,
  s3,
  lambdaClient,
  CONTENT_BUCKET,
  EVIDENCE_BUCKET,
  EVIDENCE_LOCK_MODE,
  PDF_RENDER_FN,
  DEFAULT_RETENTION_YEARS,
  EXPORT_URL_TTL_SECONDS,
  recordContentKey,
  effectiveStandard,
  formatFieldValue,
  getTenantDocumentLocale,
  resolveLabel,
  marshalValues,
  marshalRecordRows,
  type AppSyncEvent,
} from './common.js';

// ─── Task 8 (REC-7): record PDF export + sealing ─────────────────────────────

/**
 * exportFormRecordPdf — REC-7: "export ANY record to PDF" (no status guard).
 * Builds the record content JSON (labels resolved to the tenant's document
 * locale), writes it to the GeneralBucket content plane, renders via the
 * shared PdfRenderFn (sha-cached: unchanged records skip chromium), and
 * returns a 15-minute presigned URL (STO-4 parity with requestImsExport).
 */
export async function exportFormRecordPdf(event: AppSyncEvent, tenantId: string): Promise<unknown> {
  const recordId = event.arguments.recordId as string;
  if (!recordId) throw new Error('BAD_REQUEST: recordId required');
  if (!CONTENT_BUCKET || !PDF_RENDER_FN) throw new Error('EXPORT_NOT_CONFIGURED');

  const locale = await getTenantDocumentLocale(tenantId);
  const txn = await beginTenantTransaction(tenantId);
  let built: BuiltRecordContent;
  try {
    built = await buildRecordContent(txn, recordId, locale);
    await txn.commit();
  } catch (err) {
    try {
      await txn.rollback();
    } catch {
      /* never mask the original error */
    }
    throw err;
  }

  const rendered = await renderRecordPdf(tenantId, recordId, built);
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: CONTENT_BUCKET, Key: rendered.pdfKey }),
    { expiresIn: EXPORT_URL_TTL_SECONDS },
  );
  const expiresAt = new Date(Date.now() + EXPORT_URL_TTL_SECONDS * 1000).toISOString();
  return { url, expiresAt };
}

/**
 * Seal an approved record (REC-7/ACC-7). Runs INSIDE approveFormRecord's
 * transaction AFTER the status flip (the content build re-reads the row, so
 * the sealed PDF shows APPROVED + approver). Mirrors the m1 STO-5 discipline:
 * per-object ObjectLockRetainUntilDate from the tenant's m4.retention_policies
 * row (default seeded if absent), m4.records pointer row carrying retain_until
 * == object_lock_until, forms.records.m4_record_id stamped in the SAME txn —
 * a failed seal rolls back the approval (no approved-but-unsealed records).
 */
export async function sealApprovedRecord(
  txn: TenantTransaction,
  tenantId: string,
  recordId: string,
  actor: string,
  templateStandards: string[],
): Promise<Record<string, unknown>> {
  // Tenant retention policy (RLS-scoped); seed the default row if absent.
  const polRes = await txn.execute(
    `SELECT retention_years FROM m4.retention_policies
     WHERE record_type = 'form_record' LIMIT 1`,
  );
  let years = DEFAULT_RETENTION_YEARS;
  const polRows = marshalRecordRows(polRes);
  if (polRows.length > 0) {
    years = polRows[0].retentionYears as number;
  } else {
    await txn.execute(
      `INSERT INTO m4.retention_policies (tenant_id, record_type, retention_years, disposition_rule, created_by)
       VALUES (:tenantId, 'form_record', :years, 'review_before_disposal', :actor)`,
      [
        { name: 'tenantId', value: { stringValue: tenantId } },
        { name: 'years', value: { longValue: DEFAULT_RETENTION_YEARS } },
        { name: 'actor', value: { stringValue: actor } },
      ],
    );
  }

  const locale = await getTenantDocumentLocale(tenantId);
  const built = await buildRecordContent(txn, recordId, locale);
  const rendered = await renderRecordPdf(tenantId, recordId, built);

  const retainUntil = new Date(Date.now() + years * 365.25 * 24 * 3600 * 1000);
  const sealedKey = `tenants/${tenantId}/sealed/records/${recordId}-${rendered.sha256.slice(0, 12)}.pdf`;
  await s3.send(
    new CopyObjectCommand({
      Bucket: EVIDENCE_BUCKET,
      Key: sealedKey,
      CopySource: encodeURIComponent(`${CONTENT_BUCKET}/${rendered.pdfKey}`),
      ObjectLockMode: EVIDENCE_LOCK_MODE as 'GOVERNANCE' | 'COMPLIANCE',
      ObjectLockRetainUntilDate: retainUntil,
    }),
  );

  // BC-6: multi-standard templates seal as 'IMS' (m4.records CHECK widened in 011).
  const effective = effectiveStandard(templateStandards);
  const m4Res = await txn.execute(
    `INSERT INTO m4.records
       (tenant_id, standard, record_type, source_module, retention_class,
        retain_until, s3_object_ref, object_lock_until, created_by)
     VALUES (:tenantId, :standard, 'form_record', 'M4', :retClass,
             :retainUntil::timestamptz, :objectRef, :retainUntil::timestamptz, :actor)
     RETURNING id`,
    [
      { name: 'tenantId', value: { stringValue: tenantId } },
      { name: 'standard', value: { stringValue: effective } },
      { name: 'retClass', value: { stringValue: `${years}y` } },
      { name: 'retainUntil', value: { stringValue: retainUntil.toISOString() } },
      { name: 'objectRef', value: { stringValue: `s3://${EVIDENCE_BUCKET}/${sealedKey}` } },
      { name: 'actor', value: { stringValue: actor } },
    ],
  );
  const m4RecordId = unwrapField(
    (m4Res.records![0] as Array<Record<string, unknown>>)[0],
  ) as string;

  // ACC-7: pointer stamped in the SAME transaction as the approval flip.
  await txn.execute(
    `UPDATE forms.records SET m4_record_id = :m4Id::uuid, updated_at = NOW() WHERE id = :id::uuid`,
    [
      { name: 'm4Id', value: { stringValue: m4RecordId } },
      { name: 'id', value: { stringValue: recordId } },
    ],
  );

  return {
    sealed: true,
    sealedKey,
    m4RecordId,
    retentionYears: years,
    lockMode: EVIDENCE_LOCK_MODE,
    retainUntil: retainUntil.toISOString(),
  };
}

interface BuiltRecordContent {
  content: Record<string, unknown>;
  title: string;
  standard: string;
  versionNo: number;
}

/** Upload the content JSON and render it through the shared PdfRenderFn. */
async function renderRecordPdf(
  tenantId: string,
  recordId: string,
  built: BuiltRecordContent,
): Promise<{ pdfKey: string; sha256: string }> {
  const contentKey = recordContentKey(tenantId, recordId);
  await s3.send(
    new PutObjectCommand({
      Bucket: CONTENT_BUCKET,
      Key: contentKey,
      Body: JSON.stringify(built.content),
      ContentType: 'application/json',
    }),
  );

  const invoke = await lambdaClient.send(
    new InvokeCommand({
      FunctionName: PDF_RENDER_FN,
      Payload: JSON.stringify({
        tenantId,
        documents: [
          {
            documentId: recordId,
            versionId: `${recordId}-v${built.versionNo}`,
            contentKey,
            title: built.title,
            docType: 'form_record',
            standard: built.standard,
            versionNo: built.versionNo,
          },
        ],
      }),
    }),
  );
  if (invoke.FunctionError) {
    logger.error('record PDF render failed', { raw: new TextDecoder().decode(invoke.Payload) });
    throw new Error('RENDER_FAILED');
  }
  const { results } = JSON.parse(new TextDecoder().decode(invoke.Payload)) as {
    results: Array<{ pdfKey: string; sha256: string }>;
  };
  if (!results?.[0]?.pdfKey) throw new Error('RENDER_FAILED');
  return { pdfKey: results[0].pdfKey, sha256: results[0].sha256 };
}

/**
 * Build the form_record content JSON (pdf-export template contract). All
 * labels are resolved HERE from the shared i18n catalogs — the PDF service
 * renders strings it is given. Reads run inside the caller's transaction, so
 * a seal after the approval UPDATE sees the approved row.
 */
async function buildRecordContent(
  txn: TenantTransaction,
  recordId: string,
  locale: string,
): Promise<BuiltRecordContent> {
  const recResult = await txn.execute(
    `
    SELECT r.id, r.template_id, r.status, r.opened_by, r.completed_by, r.completed_at,
           r.approved_by, r.approved_at, r.m2_nc_id, r.version, r.created_at, r.updated_at
    FROM forms.records r WHERE r.id = :id::uuid
  `,
    [{ name: 'id', value: { stringValue: recordId } }],
  );
  const recRows = marshalRecordRows(recResult);
  if (recRows.length === 0) throw new Error('RECORD_NOT_FOUND');
  const rec = recRows[0];
  const templateId = rec.templateId as string;

  const tplResult = await txn.execute(
    `
    SELECT key, title_key, category, clause_refs, standards, requires_approval
    FROM forms.templates WHERE id = :id::uuid
  `,
    [{ name: 'id', value: { stringValue: templateId } }],
  );
  const tpl = marshalRecordRows(tplResult)[0];
  if (!tpl) throw new Error('TEMPLATE_METADATA_MISSING');
  const standards = (tpl.standards as string[]) ?? [];
  const title = resolveLabel(locale, tpl.titleKey as string);

  const sectionsResult = await txn.execute(
    `
    SELECT s.id, s.section_key, s.title_key
    FROM forms.template_sections s
    WHERE s.template_id = :id::uuid ORDER BY s.sort_order
  `,
    [{ name: 'id', value: { stringValue: templateId } }],
  );
  const sections = marshalRecordRows(sectionsResult);

  const fieldsResult = await txn.execute(
    `
    SELECT f.id, f.section_id, f.field_key, f.label_key, f.field_type, f.required, f.relation_target
    FROM forms.template_fields f
    JOIN forms.template_sections s ON f.section_id = s.id
    WHERE s.template_id = :id::uuid ORDER BY s.sort_order, f.sort_order
  `,
    [{ name: 'id', value: { stringValue: templateId } }],
  );
  const fields = marshalRecordRows(fieldsResult);

  const valuesResult = await txn.execute(
    `
    SELECT f.field_key, rv.value_text, rv.value_number, rv.value_date,
           rv.value_bool, rv.value_uuid, rv.value_json
    FROM forms.record_values rv
    JOIN forms.template_fields f ON rv.field_id = f.id
    WHERE rv.record_id = :id::uuid
  `,
    [{ name: 'id', value: { stringValue: recordId } }],
  );
  const values = marshalValues(valuesResult);

  // Clause relations render as "ISO9001 8.7 — Title", not a bare UUID.
  // Other relation targets render the UUID (display resolution per target
  // table is a named carry-forward, not silently pretty-printed).
  const clauseDisplay = new Map<string, string>();
  for (const f of fields) {
    if (f.relationTarget !== 'clause') continue;
    const v = values[f.fieldKey as string];
    if (typeof v !== 'string' || clauseDisplay.has(v)) continue;
    const clauseRes = await txn.execute(
      `SELECT standard, clause_no, clause_title FROM qms.clause_registry WHERE id = :id::uuid`,
      [{ name: 'id', value: { stringValue: v } }],
    );
    const row = marshalRecordRows(clauseRes)[0];
    if (row) clauseDisplay.set(v, `${row.standard} ${row.clauseNo} — ${row.clauseTitle}`);
  }

  const recordSections = sections.map((sec) => ({
    key: sec.sectionKey as string,
    title: resolveLabel(locale, sec.titleKey as string),
    fields: fields
      .filter((f) => f.sectionId === sec.id)
      .map((f) => {
        const raw = values[f.fieldKey as string];
        const filled = raw !== null && raw !== undefined;
        return {
          key: f.fieldKey as string,
          label: resolveLabel(locale, f.labelKey as string),
          type: f.fieldType as string,
          required: f.required === true,
          filled,
          display: filled
            ? formatFieldValue(
                f.fieldType as string,
                f.relationTarget as string | null,
                raw,
                locale,
                clauseDisplay,
              )
            : '',
        };
      }),
  }));

  const content = {
    kind: 'form_record',
    locale,
    template: {
      key: tpl.key,
      title,
      category: tpl.category,
      clauseRefs: tpl.clauseRefs ?? [],
      standards,
      requiresApproval: tpl.requiresApproval === true,
    },
    record: {
      id: rec.id,
      status: rec.status,
      openedBy: rec.openedBy,
      completedBy: rec.completedBy ?? null,
      completedAt: rec.completedAt ?? null,
      approvedBy: rec.approvedBy ?? null,
      approvedAt: rec.approvedAt ?? null,
      m2NcId: rec.m2NcId ?? null,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
    },
    recordSections,
  };

  return {
    content,
    title,
    standard: effectiveStandard(standards),
    versionNo: (rec.version as number) ?? 1,
  };
}
