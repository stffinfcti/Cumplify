/**
 * forms — record lifecycle mutations + single-record fetch. Extracted from
 * forms.ts.
 */

import { beginTenantTransaction, publishAuditEvent, parseAwsJson, unwrapField } from '../shared.js';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { canApprove } from '../../permissions/role-matrix.js';
import {
  logger,
  CONTENT_BUCKET,
  EVIDENCE_BUCKET,
  PDF_RENDER_FN,
  marshalValues,
  marshalRecordRows,
  FormValuesSchema,
  FIELD_TYPE_COLUMN,
  IMMUTABLE_STATUSES,
  VALUE_COLUMN_CAST,
  RELATION_TARGET_TABLE,
  fetchTemplateFieldMeta,
  completionFrom,
  getFormRecordById,
  buildValueParam,
  marshalFieldMeta,
  marshalFieldMetaFull,
  type AppSyncEvent,
} from './common.js';
import { sealApprovedRecord } from './export.js';

/**
 * getFormRecord — single record with full values + server-computed completion.
 */
export async function getFormRecord(event: AppSyncEvent, tenantId: string): Promise<unknown> {
  const recordId = event.arguments.id as string;
  const txn = await beginTenantTransaction(tenantId);
  try {
    const recResult = await txn.execute(
      `
      SELECT r.id, r.template_id, r.status, r.opened_by, r.completed_by,
             r.m2_nc_id, r.created_at, r.updated_at
      FROM forms.records r WHERE r.id = :id::uuid
    `,
      [{ name: 'id', value: { stringValue: recordId } }],
    );

    const rows = marshalRecordRows(recResult);
    if (rows.length === 0) throw new Error('RECORD_NOT_FOUND');
    const rec = rows[0];

    // Fetch values
    const valResult = await txn.execute(
      `
      SELECT f.field_key, rv.value_text, rv.value_number, rv.value_date,
             rv.value_bool, rv.value_uuid, rv.value_json
      FROM forms.record_values rv
      JOIN forms.template_fields f ON rv.field_id = f.id
      WHERE rv.record_id = :id::uuid
    `,
      [{ name: 'id', value: { stringValue: recordId } }],
    );

    const values = marshalValues(valResult);
    rec.values = values; // object — AWSJSON slot serializes once
    // Task 10: completion from the values already fetched + one fields query
    // (was computeCompletion = 2 extra round trips per read).
    const fieldsMeta = await fetchTemplateFieldMeta(txn, rec.templateId as string);
    rec.completion = completionFrom(fieldsMeta, new Set(Object.keys(values)));

    await txn.commit();
    return rec;
  } catch (err) {
    try {
      await txn.rollback();
    } catch {
      /* never mask the original error */
    }
    throw err;
  }
}

// ─── Mutations ───────────────────────────────────────────────────────────────

/**
 * createFormRecord — creates a new record in draft status.
 */
export async function createFormRecord(
  event: AppSyncEvent,
  tenantId: string,
  actor: string,
): Promise<unknown> {
  const templateId = event.arguments.templateId as string;
  const txn = await beginTenantTransaction(tenantId);
  try {
    const result = await txn.execute(
      `
      INSERT INTO forms.records (tenant_id, template_id, status, opened_by)
      VALUES (:tenantId, :templateId::uuid, 'draft', :actor)
      RETURNING id, template_id, status, opened_by, completed_by, m2_nc_id, created_at, updated_at
    `,
      [
        { name: 'tenantId', value: { stringValue: tenantId } },
        { name: 'templateId', value: { stringValue: templateId } },
        { name: 'actor', value: { stringValue: actor } },
      ],
    );
    const rec = marshalRecordRows(result)[0];
    // BUG-1 fix: compute real completion from catalog (not hardcoded 0/0/[]).
    // Task 10: fresh record has zero filled fields — one fields query suffices.
    const fieldsMeta = await fetchTemplateFieldMeta(txn, templateId);
    rec.completion = completionFrom(fieldsMeta, new Set());
    rec.values = {};
    await txn.commit();
    return rec;
  } catch (err) {
    try {
      await txn.rollback();
    } catch {
      /* never mask the original error */
    }
    throw err;
  }
}

/**
 * saveFormRecordValues — partial autosave with typed-column dispatch.
 * Immutability guard: rejects writes on complete/approved status.
 * REC-3: no validation on save, only on submit.
 */
export async function saveFormRecordValues(
  event: AppSyncEvent,
  tenantId: string,
): Promise<unknown> {
  const input = event.arguments.input as {
    recordId: string;
    values: string | Record<string, unknown>;
  };
  const recordId = input.recordId;
  // AWSJSON arrives parsed (object) from AppSync, as a string from hermetic
  // fixtures — accept both (same wire-shape class as saveOrgProfile, found
  // live 2026-07-22). Boundary zod: values is a fieldKey→JSON-value map;
  // a top-level array/scalar is INVALID_PAYLOAD, not silent corruption.
  const values = parseAwsJson(FormValuesSchema, input.values, 'values');

  const txn = await beginTenantTransaction(tenantId);
  try {
    // Check record status — immutability guard. FOR UPDATE: the lock rides the
    // whole txn so a concurrent approve/submit can't flip the record between
    // this check and the value upserts (check-then-act, M-effort).
    const statusResult = await txn.execute(
      `SELECT status, template_id FROM forms.records WHERE id = :id::uuid FOR UPDATE`,
      [{ name: 'id', value: { stringValue: recordId } }],
    );
    const statusRows = marshalRecordRows(statusResult);
    if (statusRows.length === 0) throw new Error('RECORD_NOT_FOUND');

    const currentStatus = statusRows[0].status as string;
    if (IMMUTABLE_STATUSES.has(currentStatus)) {
      throw new Error('RECORD_IMMUTABLE');
    }

    const templateId = statusRows[0].templateId as string;

    // Update status to in_progress if still draft
    if (currentStatus === 'DRAFT') {
      await txn.execute(
        `UPDATE forms.records SET status = 'in_progress', updated_at = NOW() WHERE id = :id::uuid`,
        [{ name: 'id', value: { stringValue: recordId } }],
      );
    }

    // Resolve field metadata for typed dispatch
    const fieldsResult = await txn.execute(
      `
      SELECT f.id, f.field_key, f.field_type, f.relation_target
      FROM forms.template_fields f
      JOIN forms.template_sections s ON f.section_id = s.id
      WHERE s.template_id = :templateId::uuid
    `,
      [{ name: 'templateId', value: { stringValue: templateId } }],
    );

    const fieldMeta = marshalFieldMeta(fieldsResult);

    // Typed-column dispatch into two batched statements: one DELETE for
    // cleared fields, one multi-row upsert for written fields — was one
    // round-trip per field, which serialized every autosave flush.
    const deleteFieldIds: string[] = [];
    const upserts: Array<{ fieldId: string; column: string; param: SqlParameter }> = [];

    for (const [fieldKey, value] of Object.entries(values)) {
      const meta = fieldMeta.get(fieldKey);
      if (!meta) {
        logger.warn('Unknown fieldKey in saveFormRecordValues — skipping', { fieldKey, recordId });
        continue;
      }

      // BUG-2 fix: null value → DELETE the row (clearing a field)
      if (value === null || value === undefined) {
        deleteFieldIds.push(meta.fieldId);
        continue;
      }

      const valueColumn = FIELD_TYPE_COLUMN[meta.fieldType];
      if (!valueColumn) continue;

      // BC-2: Relation existence probe — inside the tenant transaction (RLS-enforced)
      if (meta.fieldType === 'relation' && meta.relationTarget) {
        const targetTable = RELATION_TARGET_TABLE[meta.relationTarget];
        if (!targetTable) {
          throw new Error(`INVALID_RELATION_TARGET: ${meta.relationTarget}`);
        }
        const probeResult = await txn.execute(
          `SELECT 1 FROM ${targetTable} WHERE id = :uuid::uuid`,
          [{ name: 'uuid', value: { stringValue: String(value) } }],
        );
        if (!probeResult.records || probeResult.records.length === 0) {
          throw new Error('LINK_TARGET_NOT_FOUND');
        }
      }

      upserts.push({
        fieldId: meta.fieldId,
        column: valueColumn,
        param: buildValueParam(valueColumn, value),
      });
    }

    if (deleteFieldIds.length > 0) {
      await txn.execute(
        `
        DELETE FROM forms.record_values
        WHERE record_id = :recordId::uuid
          AND field_id IN (${deleteFieldIds.map((_, i) => `:d${i}::uuid`).join(', ')})
      `,
        [
          { name: 'recordId', value: { stringValue: recordId } },
          ...deleteFieldIds.map((id, i) => ({ name: `d${i}`, value: { stringValue: id } })),
        ],
      );
    }

    if (upserts.length > 0) {
      // Each row carries its value in the column matching its field_type and
      // NULL elsewhere — DO UPDATE applies every column from EXCLUDED, which
      // sets the typed column and clears the rest (same effect as the old
      // per-field nullOtherColumns clause).
      const ALL_COLUMNS = [
        'value_text',
        'value_number',
        'value_date',
        'value_bool',
        'value_uuid',
        'value_json',
      ];
      const rowSql = upserts
        .map((u, i) => {
          const cells = ALL_COLUMNS.map((c) =>
            c === u.column ? `:v${i}${VALUE_COLUMN_CAST[c] ?? ''}` : 'NULL',
          ).join(', ');
          return `(:recordId::uuid, :tenantId, :f${i}::uuid, ${cells})`;
        })
        .join(',\n        ');
      await txn.execute(
        `
        INSERT INTO forms.record_values
          (record_id, tenant_id, field_id, ${ALL_COLUMNS.join(', ')})
        VALUES
        ${rowSql}
        ON CONFLICT (record_id, field_id)
        DO UPDATE SET ${ALL_COLUMNS.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}
      `,
        [
          { name: 'recordId', value: { stringValue: recordId } },
          { name: 'tenantId', value: { stringValue: tenantId } },
          ...upserts.flatMap((u, i) => [
            { name: `f${i}`, value: { stringValue: u.fieldId } },
            { ...u.param, name: `v${i}` },
          ]),
        ],
      );
    }

    // Update record timestamp
    await txn.execute(`UPDATE forms.records SET updated_at = NOW() WHERE id = :id::uuid`, [
      { name: 'id', value: { stringValue: recordId } },
    ]);

    // Re-read inside the txn so the returned record is exactly what commits
    const refreshed = await getFormRecordById(recordId, tenantId, txn);
    await txn.commit();
    return refreshed;
  } catch (err) {
    try {
      await txn.rollback();
    } catch {
      /* never mask the original error */
    }
    throw err;
  }
}

/**
 * submitFormRecord — full validation + NCR→M2 mapping (BC-3 core, design §3).
 *
 * Status guard: only DRAFT/IN_PROGRESS/REOPENED can submit (else SUBMIT_INVALID_STATUS).
 * Full validation (REC-3): ALL required fields must be filled (VALIDATION_INCOMPLETE).
 * Mapped validation (BC-3): all maps_to_column required fields filled (MAPPING_INCOMPLETE).
 * Resubmit-after-reopen: if m2_nc_id already set, UPDATE existing NC row (not INSERT).
 *
 * ZERO hardcoded defaults for clause_ref/severity/source/standard/nc_type.
 */
export async function submitFormRecord(
  event: AppSyncEvent,
  tenantId: string,
  actor: string,
  role: string,
): Promise<unknown> {
  const input = event.arguments.input as { recordId: string };
  const recordId = input.recordId;

  const txn = await beginTenantTransaction(tenantId);
  try {
    // 1. Fetch record + template metadata. FOR UPDATE: serializes concurrent
    // submits — a second submit blocks on the lock, then re-reads the new
    // status and fails SUBMIT_INVALID_STATUS instead of double-writing the NC.
    const recResult = await txn.execute(
      `
      SELECT r.id, r.template_id, r.status, r.opened_by, r.m2_nc_id
      FROM forms.records r WHERE r.id = :id::uuid FOR UPDATE
    `,
      [{ name: 'id', value: { stringValue: recordId } }],
    );
    const recRows = marshalRecordRows(recResult);
    if (recRows.length === 0) throw new Error('RECORD_NOT_FOUND');
    const rec = recRows[0];
    const templateId = rec.templateId as string;
    const currentStatus = rec.status as string;
    const existingNcId = rec.m2NcId as string | null;

    // F1: Status guard — submit only from DRAFT/IN_PROGRESS/REOPENED
    const SUBMITTABLE_STATUSES = new Set(['DRAFT', 'IN_PROGRESS', 'REOPENED']);
    if (!SUBMITTABLE_STATUSES.has(currentStatus)) {
      throw new Error('SUBMIT_INVALID_STATUS');
    }

    // Check template maps_to + standards + clause_refs
    const tplResult = await txn.execute(
      `
      SELECT maps_to, standards, clause_refs FROM forms.templates WHERE id = :id::uuid
    `,
      [{ name: 'id', value: { stringValue: templateId } }],
    );
    const tplRows = marshalRecordRows(tplResult);
    const mapsTo = tplRows[0]?.mapsTo as string | null;
    const tplStandards = tplRows[0]?.standards as string[] | null;
    const tplClauseRefs = tplRows[0]?.clauseRefs as string[] | null;

    // Fetch all field metadata with maps_to_column
    const fieldMetaResult = await txn.execute(
      `
      SELECT f.id, f.field_key, f.field_type, f.required, f.maps_to_column, f.relation_target
      FROM forms.template_fields f
      JOIN forms.template_sections s ON f.section_id = s.id
      WHERE s.template_id = :templateId::uuid
    `,
      [{ name: 'templateId', value: { stringValue: templateId } }],
    );

    // Fetch all current record values
    const valuesResult = await txn.execute(
      `
      SELECT f.field_key, rv.value_text, rv.value_number, rv.value_date,
             rv.value_bool, rv.value_uuid, rv.value_json
      FROM forms.record_values rv
      JOIN forms.template_fields f ON rv.field_id = f.id
      WHERE rv.record_id = :recordId::uuid
    `,
      [{ name: 'recordId', value: { stringValue: recordId } }],
    );

    const currentValues = marshalValues(valuesResult);
    const fieldsMeta = marshalFieldMetaFull(fieldMetaResult);

    // BC-3: Validate mapped fields FIRST (MAPPING_INCOMPLETE is the BC-3 signal)
    if (mapsTo === 'm2_ncr') {
      const mappedFields = fieldsMeta.filter((f) => f.mapsToColumn !== null);
      const requiredMapped = mappedFields.filter((f) => f.required);

      for (const field of requiredMapped) {
        const value = currentValues[field.fieldKey];
        if (value === null || value === undefined || value === '') {
          throw new Error('MAPPING_INCOMPLETE');
        }
      }
    }

    // F3: Full validation (REC-3) — ALL required fields must be filled
    const allRequired = fieldsMeta.filter((f) => f.required);
    for (const field of allRequired) {
      const value = currentValues[field.fieldKey];
      if (value === null || value === undefined || value === '') {
        throw new Error('VALIDATION_INCOMPLETE');
      }
    }

    let refreshed: unknown;

    // NCR→M2 mapping path
    if (mapsTo === 'm2_ncr') {
      // Submitting through this template writes an M2 nonconformity row —
      // hold it to the M2 write matrix instead of the authenticated floor
      // the plain-record path uses.
      if (!canApprove(role, 'M2')) {
        throw new Error('UNAUTHORIZED');
      }
      // Resolve clause_ref UUID → clause_no TEXT from qms.clause_registry (pending 011)
      const clauseRefUuid = currentValues['clause_ref'] as string;
      const clauseResult = await txn.execute(
        `
        SELECT clause_no FROM qms.clause_registry WHERE id = :id::uuid
      `,
        [{ name: 'id', value: { stringValue: clauseRefUuid } }],
      );
      const clauseRows = marshalRecordRows(clauseResult);
      if (clauseRows.length === 0) throw new Error('LINK_TARGET_NOT_FOUND');
      const clauseNoText = clauseRows[0].clauseNo as string;

      // F1: Resubmit-after-reopen — if m2_nc_id already set, UPDATE existing NC (not INSERT)
      let ncId: string;
      if (existingNcId) {
        // UPDATE existing m2.nonconformities mapped columns (do NOT touch CA row — its lifecycle belongs to M2)
        await txn.execute(
          `
          UPDATE m2.nonconformities
          SET standard = :standard, source = :source, nc_type = :ncType,
              description = :description, clause_ref = :clauseRef, severity = :severity,
              updated_at = NOW()
          WHERE id = :ncId::uuid
        `,
          [
            { name: 'standard', value: { stringValue: currentValues['standard'] as string } },
            { name: 'source', value: { stringValue: currentValues['source'] as string } },
            { name: 'ncType', value: { stringValue: currentValues['nc_type'] as string } },
            {
              name: 'description',
              value: { stringValue: currentValues['nc_description'] as string },
            },
            { name: 'clauseRef', value: { stringValue: clauseNoText } },
            { name: 'severity', value: { stringValue: currentValues['severity'] as string } },
            { name: 'ncId', value: { stringValue: existingNcId } },
          ],
        );
        ncId = existingNcId;
      } else {
        // First submit: INSERT m2.nonconformities (real column names from migration 003)
        const ncResult = await txn.execute(
          `
          INSERT INTO m2.nonconformities (tenant_id, standard, source, nc_type, description, clause_ref, severity, raised_by, created_by)
          VALUES (:tenantId, :standard, :source, :ncType, :description, :clauseRef, :severity, :raisedBy, :actor)
          RETURNING id
        `,
          [
            { name: 'tenantId', value: { stringValue: tenantId } },
            { name: 'standard', value: { stringValue: currentValues['standard'] as string } },
            { name: 'source', value: { stringValue: currentValues['source'] as string } },
            { name: 'ncType', value: { stringValue: currentValues['nc_type'] as string } },
            {
              name: 'description',
              value: { stringValue: currentValues['nc_description'] as string },
            },
            { name: 'clauseRef', value: { stringValue: clauseNoText } },
            { name: 'severity', value: { stringValue: currentValues['severity'] as string } },
            { name: 'raisedBy', value: { stringValue: currentValues['raised_by'] as string } },
            { name: 'actor', value: { stringValue: actor } },
          ],
        );
        ncId = unwrapField((ncResult.records![0] as Array<Record<string, unknown>>)[0]) as string;

        // INSERT m2.corrective_actions (nc_id from INSERT; action_desc/owner_id/due_date NOT NULL)
        const containmentFlag =
          currentValues['containment_flag'] === true ||
          currentValues['containment_flag'] === 'true';
        await txn.execute(
          `
          INSERT INTO m2.corrective_actions (tenant_id, nc_id, action_desc, owner_id, due_date, containment_flag, created_by)
          VALUES (:tenantId, :ncId::uuid, :actionDesc, :ownerId, :dueDate::timestamptz, :containmentFlag, :actor)
        `,
          [
            { name: 'tenantId', value: { stringValue: tenantId } },
            { name: 'ncId', value: { stringValue: ncId } },
            {
              name: 'actionDesc',
              value: { stringValue: currentValues['corrective_action_desc'] as string },
            },
            { name: 'ownerId', value: { stringValue: currentValues['ca_owner'] as string } },
            { name: 'dueDate', value: { stringValue: currentValues['ca_due_date'] as string } },
            { name: 'containmentFlag', value: { booleanValue: containmentFlag } },
            { name: 'actor', value: { stringValue: actor } },
          ],
        );
      }

      // Stamp forms.records.m2_nc_id + mark complete
      await txn.execute(
        `
        UPDATE forms.records
        SET m2_nc_id = :ncId::uuid, status = 'complete', completed_by = :actor, completed_at = NOW(), updated_at = NOW()
        WHERE id = :id::uuid
      `,
        [
          { name: 'ncId', value: { stringValue: ncId } },
          { name: 'actor', value: { stringValue: actor } },
          { name: 'id', value: { stringValue: recordId } },
        ],
      );

      refreshed = await getFormRecordById(recordId, tenantId, txn);
      await txn.commit();

      // F2: Audit event — standard + clauseRef from mapped values (no literals)
      await publishAuditEvent({
        tenantId,
        actor,
        module: 'M4',
        clauseRef: clauseNoText,
        standard: currentValues['standard'] as 'ISO9001' | 'ISO14001' | 'ISO45001',
        detailType: 'FormRecord.Submitted',
        source: 'cumplify.forms',
        entityId: recordId,
        payload: { recordId, templateId, mapsTo, ncId },
      });
    } else {
      // Non-mapping template: just mark complete (no m2 writes)
      await txn.execute(
        `
        UPDATE forms.records
        SET status = 'complete', completed_by = :actor, completed_at = NOW(), updated_at = NOW()
        WHERE id = :id::uuid
      `,
        [
          { name: 'actor', value: { stringValue: actor } },
          { name: 'id', value: { stringValue: recordId } },
        ],
      );

      refreshed = await getFormRecordById(recordId, tenantId, txn);
      await txn.commit();

      // Audit event — standard/clauseRef from template metadata (impossible path fails loudly)
      // TODO-011: once IMS enum lands (spec-40), multi-standard templates use 'IMS'
      if (!tplStandards?.[0] || !tplClauseRefs?.[0]) {
        throw new Error('TEMPLATE_METADATA_MISSING');
      }
      await publishAuditEvent({
        tenantId,
        actor,
        module: 'M4',
        clauseRef: tplClauseRefs[0],
        standard: tplStandards[0] as 'ISO9001' | 'ISO14001' | 'ISO45001',
        detailType: 'FormRecord.Submitted',
        source: 'cumplify.forms',
        entityId: recordId,
        payload: { recordId, templateId, mapsTo },
      });
    }

    return refreshed;
  } catch (err) {
    try {
      await txn.rollback();
    } catch {
      /* never mask the original error */
    }
    throw err;
  }
}

/**
 * approveFormRecord — SoD enforcement (BC-4).
 * Only for requires_approval templates, only from COMPLETE status.
 * SoD: approver ≠ completed_by AND approver ≠ opened_by.
 * Violation → Security.SodViolationBlocked, writes NOTHING.
 */
export async function approveFormRecord(
  event: AppSyncEvent,
  tenantId: string,
  actor: string,
): Promise<unknown> {
  const input = event.arguments.input as { recordId: string };
  const recordId = input.recordId;

  const txn = await beginTenantTransaction(tenantId);
  try {
    // Fetch record. FOR UPDATE: serializes concurrent approvals (and an
    // approve/reopen race) — the loser re-reads the flipped status and fails
    // APPROVE_INVALID_STATUS instead of double-approving + double-sealing.
    const recResult = await txn.execute(
      `
      SELECT r.id, r.template_id, r.status, r.opened_by, r.completed_by
      FROM forms.records r WHERE r.id = :id::uuid FOR UPDATE
    `,
      [{ name: 'id', value: { stringValue: recordId } }],
    );
    const recRows = marshalRecordRows(recResult);
    if (recRows.length === 0) throw new Error('RECORD_NOT_FOUND');
    const rec = recRows[0];
    const templateId = rec.templateId as string;
    const currentStatus = rec.status as string;
    const openedBy = rec.openedBy as string;
    const completedBy = rec.completedBy as string | null;

    // Status guard: approve only from COMPLETE
    if (currentStatus !== 'COMPLETE') {
      throw new Error('APPROVE_INVALID_STATUS');
    }

    // Template guard: only requires_approval templates
    const tplResult = await txn.execute(
      `
      SELECT requires_approval, standards, clause_refs FROM forms.templates WHERE id = :id::uuid
    `,
      [{ name: 'id', value: { stringValue: templateId } }],
    );
    const tplRows = marshalRecordRows(tplResult);
    const requiresApproval = tplRows[0]?.requiresApproval;
    const tplStandards = tplRows[0]?.standards as string[] | null;
    const tplClauseRefs = tplRows[0]?.clauseRefs as string[] | null;

    if (!requiresApproval) {
      throw new Error('APPROVAL_NOT_REQUIRED');
    }

    // BC-4: SoD — approver ≠ completed_by AND approver ≠ opened_by
    if (actor === completedBy || actor === openedBy) {
      // Publish Security.SodViolationBlocked, write NOTHING
      try {
        await txn.rollback();
      } catch {
        /* never mask the original error */
      }
      await publishAuditEvent({
        tenantId,
        actor,
        module: 'M4',
        clauseRef:
          tplClauseRefs?.[0] ??
          (() => {
            throw new Error('TEMPLATE_METADATA_MISSING');
          })(),
        standard: (tplStandards?.[0] ??
          (() => {
            throw new Error('TEMPLATE_METADATA_MISSING');
          })()) as 'ISO9001' | 'ISO14001' | 'ISO45001',
        detailType: 'Security.SodViolationBlocked',
        source: 'cumplify.forms',
        entityId: recordId, // blocked events carry the targeted row id
        payload: {
          recordId,
          attemptedBy: actor,
          openedBy,
          completedBy,
          reason: 'approver must differ from opened_by and completed_by',
        },
      });
      throw new Error('SOD_VIOLATION');
    }

    // Approve: stamp approved_by/approved_at, status → approved
    await txn.execute(
      `
      UPDATE forms.records
      SET status = 'approved', approved_by = :actor, approved_at = NOW(), updated_at = NOW()
      WHERE id = :id::uuid
    `,
      [
        { name: 'actor', value: { stringValue: actor } },
        { name: 'id', value: { stringValue: recordId } },
      ],
    );

    // Task 8 (REC-7): seal the approved record — PDF → EvidenceVault with
    // per-object retention + m4.records pointer, SAME txn as the flip. A
    // seal failure rolls the approval back (catch below): no
    // approved-but-unsealed records. Unconfigured env (hermetic lane) skips
    // honestly — the audit payload carries sealed:false + reason.
    let sealed: Record<string, unknown> = { sealed: false, reason: 'SEAL_NOT_CONFIGURED' };
    if (CONTENT_BUCKET && EVIDENCE_BUCKET && PDF_RENDER_FN) {
      sealed = await sealApprovedRecord(
        txn,
        tenantId,
        recordId,
        actor,
        (tplStandards ?? []) as string[],
      );
    }

    const refreshed = await getFormRecordById(recordId, tenantId, txn);
    await txn.commit();

    // Audit event — dynamic standard/clauseRef from template
    if (!tplStandards?.[0] || !tplClauseRefs?.[0]) {
      throw new Error('TEMPLATE_METADATA_MISSING');
    }
    await publishAuditEvent({
      tenantId,
      actor,
      module: 'M4',
      clauseRef: tplClauseRefs[0],
      standard: tplStandards[0] as 'ISO9001' | 'ISO14001' | 'ISO45001',
      detailType: 'FormRecord.Approved',
      source: 'cumplify.forms',
      entityId: recordId,
      payload: { recordId, templateId, approvedBy: actor, ...sealed },
    });

    return refreshed;
  } catch (err) {
    if ((err as Error).message !== 'SOD_VIOLATION') {
      try {
        await txn.rollback();
      } catch {
        /* never mask the original error */
      }
    }
    throw err;
  }
}

/**
 * reopenFormRecord — explicit reopen with justification (REC-4, BC-5).
 * Status complete/approved → reopened. Audit-logged with justification.
 */
export async function reopenFormRecord(
  event: AppSyncEvent,
  tenantId: string,
  actor: string,
): Promise<unknown> {
  const input = event.arguments.input as { recordId: string; justification: string };
  const { recordId, justification } = input;

  if (!justification || justification.trim().length === 0) {
    throw new Error('JUSTIFICATION_REQUIRED');
  }

  const txn = await beginTenantTransaction(tenantId);
  try {
    // Verify record exists and is in a completable state. FOR UPDATE:
    // serializes a reopen/reopen and reopen/approve race — the loser re-reads
    // the flipped status and fails REOPEN_INVALID_STATUS.
    const recResult = await txn.execute(
      `
      SELECT r.id, r.template_id, r.status
      FROM forms.records r WHERE r.id = :id::uuid FOR UPDATE
    `,
      [{ name: 'id', value: { stringValue: recordId } }],
    );
    const recRows = marshalRecordRows(recResult);
    if (recRows.length === 0) throw new Error('RECORD_NOT_FOUND');

    const currentStatus = recRows[0].status as string;
    if (currentStatus !== 'COMPLETE' && currentStatus !== 'APPROVED') {
      throw new Error('REOPEN_INVALID_STATUS');
    }

    const templateId = recRows[0].templateId as string;

    // Fetch template metadata for audit event (no literal standards)
    const tplResult = await txn.execute(
      `
      SELECT standards, clause_refs FROM forms.templates WHERE id = :id::uuid
    `,
      [{ name: 'id', value: { stringValue: templateId } }],
    );
    const tplRows = marshalRecordRows(tplResult);
    const tplStandards = tplRows[0]?.standards as string[] | null;
    const tplClauseRefs = tplRows[0]?.clauseRefs as string[] | null;

    // Transition to reopened
    await txn.execute(
      `
      UPDATE forms.records
      SET status = 'reopened', completed_by = NULL, completed_at = NULL, updated_at = NOW()
      WHERE id = :id::uuid
    `,
      [{ name: 'id', value: { stringValue: recordId } }],
    );

    const refreshed = await getFormRecordById(recordId, tenantId, txn);
    await txn.commit();

    // Audit event — standard/clauseRef from template metadata (impossible path fails loudly)
    // TODO-011: once IMS enum lands (spec-40), multi-standard templates use 'IMS'
    if (!tplStandards?.[0] || !tplClauseRefs?.[0]) {
      throw new Error('TEMPLATE_METADATA_MISSING');
    }
    await publishAuditEvent({
      tenantId,
      actor,
      module: 'M4',
      clauseRef: tplClauseRefs[0],
      standard: tplStandards[0] as 'ISO9001' | 'ISO14001' | 'ISO45001',
      detailType: 'FormRecord.Reopened',
      source: 'cumplify.forms',
      entityId: recordId,
      payload: { recordId, justification },
    });

    return refreshed;
  } catch (err) {
    try {
      await txn.rollback();
    } catch {
      /* never mask the original error */
    }
    throw err;
  }
}
