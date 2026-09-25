/**
 * QMS Forms & Records Engine resolver (spec 41, design §2–5).
 *
 * Schema node dependency: FormTemplate, FormTemplateSection, FormTemplateField,
 * FormRecord, FormCompletion, FormRecordStatus, SaveFormRecordValuesInput,
 * SubmitFormRecordInput, ApproveFormRecordInput, ReopenFormRecordInput, ExportResult.
 *
 * Key invariants:
 * - FormCompletion is SERVER-COMPUTED (COUNT over record_values joined to
 *   template_fields) — the client never computes it.
 * - saveFormRecordValues: typed-column dispatch by field_type.
 * - Immutability guard: complete/approved status rejects writes.
 * - BC-1: sectionCount/fieldCount are COUNTs over catalog rows, never hardcoded.
 * - SCHEMA-5: tenantId from resolverContext only, never input.
 * - C-2: set_config is the FIRST statement in every transaction.
 *
 * Note: listFormRecords closes the standing BLOCKED listRecords item from
 * frontend-app Task 29.
 */

import { Logger } from '@aws-lambda-powertools/logger';
import { z } from 'zod';
import {
  beginTenantTransaction,
  getTenantDdbClient,
  snakeToCamel,
  unwrapField,
  jsonOut,
  JsonValueSchema,
  TABLE_NAME,
  type TenantTransaction,
  type DataApiResult,
} from '../shared.js';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { S3Client } from '@aws-sdk/client-s3';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
// PDF labels resolve from the SAME catalogs the UI renders (BC-7 single
// source): bundle-time JSON import — catalog edits ship with the next deploy,
// and the seed↔catalog contract is pinned hermetically (qms-forms-catalog).
import enMessages from '../../../../../frontend/messages/en.json';
import esMessages from '../../../../../frontend/messages/es.json';
import ptMessages from '../../../../../frontend/messages/pt.json';

export const logger = new Logger({ serviceName: 'resolver-forms' });
export const s3 = new S3Client({});
export const lambdaClient = new LambdaClient({});

// Task 8 (REC-7): record PDF export + approved-record sealing. Env mirrors
// the m1 sealing block (spec-40 Task 9) — GOVERNANCE dev / COMPLIANCE prod.
export const CONTENT_BUCKET = process.env.CONTENT_BUCKET ?? '';
export const EVIDENCE_BUCKET = process.env.EVIDENCE_BUCKET ?? '';
export const EVIDENCE_LOCK_MODE = process.env.EVIDENCE_LOCK_MODE ?? 'GOVERNANCE';
export const PDF_RENDER_FN = process.env.PDF_RENDER_FN ?? '';
export const DEFAULT_RETENTION_YEARS = 7;
export const EXPORT_URL_TTL_SECONDS = 15 * 60;

export const MESSAGES: Record<string, unknown> = { en: enMessages, es: esMessages, pt: ptMessages };

export interface AppSyncEvent {
  info: { fieldName: string };
  arguments: Record<string, unknown>;
  identity?: { resolverContext?: Record<string, string> };
}

// ─── Field type → value column dispatch map ──────────────────────────────────
export const FIELD_TYPE_COLUMN: Record<string, string> = {
  text: 'value_text',
  textarea: 'value_text',
  select: 'value_text',
  multiselect: 'value_json',
  radio: 'value_text',
  number: 'value_number',
  date: 'value_date',
  checkbox: 'value_bool',
  user: 'value_text',
  relation: 'value_uuid',
};

// Boundary shape for SaveFormRecordValuesInput.values (AWSJSON): a flat
// fieldKey → JSON-value map (M-effort, item 8).
export const FormValuesSchema = z.record(z.string(), JsonValueSchema);

// Immutable statuses — writes rejected on these (after marshal: uppercased)
export const IMMUTABLE_STATUSES = new Set(['COMPLETE', 'APPROVED']);

// Value column → SQL type cast (M3 lesson: RDS Data API binds stringValue as varchar)
export const VALUE_COLUMN_CAST: Record<string, string> = {
  value_uuid: '::uuid',
  value_date: '::timestamptz',
  value_json: '::jsonb',
  value_number: '::numeric',
};

// ─── BC-2: Relation target → table allowlist (CODE constant, never from data) ─
// The target table name is NEVER interpolated from a catalog row or user input.
// 'user' is excluded — user references are stored as text (sub claim), not FK-probed.
// 'clause' → qms.clause_registry (lands in migration 011, same deploy wave).
export const RELATION_TARGET_TABLE: Record<string, string> = {
  nonconformity: 'm2.nonconformities',
  corrective_action: 'm2.corrective_actions',
  audit: 'm3.audits',
  risk: 'm5.risks',
  document: 'm1.documents',
  clause: 'qms.clause_registry', // migration 011 (spec-40 Task 1)
};

// ─── Helpers (marshal, coercion, locale, value plumbing) ────────────────────

export function recordContentKey(tenantId: string, recordId: string): string {
  return `tenants/${tenantId}/records/${recordId}.json`;
}

/**
 * Effective standard for a template's standards[] array: seed rows carry
 * 'IMS' alongside the concrete standards (BC-6), so strip it — exactly one
 * concrete standard left means a single-standard template, anything else
 * seals/renders as IMS.
 */
export function effectiveStandard(standards: string[]): string {
  const concrete = (standards ?? []).filter((s) => s !== 'IMS');
  return concrete.length === 1 ? concrete[0] : 'IMS';
}

/** Human display for a typed record value (labels/booleans localized). */
export function formatFieldValue(
  fieldType: string,
  relationTarget: string | null,
  raw: unknown,
  locale: string,
  clauseDisplay: Map<string, string>,
): string {
  switch (fieldType) {
    case 'checkbox':
      return raw === true
        ? resolveLabel(locale, 'forms.pdf.yes')
        : resolveLabel(locale, 'forms.pdf.no');
    case 'multiselect': {
      try {
        const arr = JSON.parse(String(raw)) as unknown;
        if (Array.isArray(arr)) return arr.map(String).join(', ');
      } catch {
        /* fall through to String(raw) */
      }
      return String(raw);
    }
    case 'date':
      return String(raw).slice(0, 10);
    case 'relation':
      if (relationTarget === 'clause') return clauseDisplay.get(String(raw)) ?? String(raw);
      return String(raw);
    default:
      return String(raw);
  }
}

/**
 * Tenant document locale (same DDB item getTenantSettings reads — META/ORG).
 * Defaults gracefully to 'en' like getTenantSettings itself: locale is a
 * rendering preference, not a correctness gate.
 */
export async function getTenantDocumentLocale(tenantId: string): Promise<string> {
  try {
    const ddb = await getTenantDdbClient(tenantId);
    const result = await ddb.send(
      new GetItemCommand({
        TableName: TABLE_NAME,
        Key: marshall({ PK: `TENANT#${tenantId}#META`, SK: 'ORG' }),
      }),
    );
    const loc = result.Item
      ? (unmarshall(result.Item).documentLocale as string | undefined)
      : undefined;
    return loc && loc in MESSAGES ? loc : 'en';
  } catch (err) {
    logger.warn('documentLocale read failed — defaulting to en', { error: (err as Error).message });
    return 'en';
  }
}

/** Resolve an i18n catalog key to the locale's string (en fallback, then the key itself). */
export function resolveLabel(locale: string, key: string): string {
  const walk = (root: unknown): unknown =>
    key
      .split('.')
      .reduce<unknown>(
        (o, part) =>
          o && typeof o === 'object' ? (o as Record<string, unknown>)[part] : undefined,
        root,
      );
  const v = walk(MESSAGES[locale] ?? MESSAGES.en) ?? walk(MESSAGES.en);
  if (typeof v === 'string') return v;
  logger.warn('i18n key missing from catalogs — rendering the key', { key, locale });
  return key;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Template field metadata for completion (Task 10 shape: fetched ONCE per
 * call, completion computed in code — never per-record round trips).
 */
export async function fetchTemplateFieldMeta(
  txn: TenantTransaction,
  templateId: string,
): Promise<Array<{ fieldKey: string; required: boolean }>> {
  const result = await txn.execute(
    `
    SELECT f.field_key, f.required
    FROM forms.template_fields f
    JOIN forms.template_sections s ON f.section_id = s.id
    WHERE s.template_id = :templateId::uuid
  `,
    [{ name: 'templateId', value: { stringValue: templateId } }],
  );
  const allKeys = extractFieldKeys(result);
  const requiredKeys = new Set(extractRequiredFieldKeys(result));
  return allKeys.map((k) => ({ fieldKey: k, required: requiredKeys.has(k) }));
}

/** Compute FormCompletion (design §2.4) from field meta + filled keys. */
export function completionFrom(
  fieldsMeta: Array<{ fieldKey: string; required: boolean }>,
  filledKeys: Set<string>,
): { fieldsFilled: number; fieldsTotal: number; requiredMissing: string[] } {
  return {
    fieldsFilled: filledKeys.size,
    fieldsTotal: fieldsMeta.length,
    requiredMissing: fieldsMeta
      .filter((f) => f.required && !filledKeys.has(f.fieldKey))
      .map((f) => f.fieldKey),
  };
}

/** Get a record by ID (after mutation, for return value). */
export async function getFormRecordById(recordId: string, tenantId: string): Promise<unknown> {
  const txn = await beginTenantTransaction(tenantId);
  try {
    const result = await txn.execute(
      `
      SELECT r.id, r.template_id, r.status, r.opened_by, r.completed_by,
             r.m2_nc_id, r.created_at, r.updated_at
      FROM forms.records r WHERE r.id = :id::uuid
    `,
      [{ name: 'id', value: { stringValue: recordId } }],
    );
    const rows = marshalRecordRows(result);
    if (rows.length === 0) throw new Error('RECORD_NOT_FOUND');
    const rec = rows[0];

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

/** Build the value SqlParameter based on the target column. */
export function buildValueParam(valueColumn: string, value: unknown): SqlParameter {
  switch (valueColumn) {
    case 'value_text':
      return { name: 'val', value: { stringValue: String(value) } };
    case 'value_number':
      return { name: 'val', value: { stringValue: String(value) } }; // Data API uses stringValue for numeric
    case 'value_date':
      return { name: 'val', value: { stringValue: String(value) } }; // ISO timestamp string
    case 'value_bool':
      return { name: 'val', value: { booleanValue: Boolean(value) } };
    case 'value_uuid':
      return { name: 'val', value: { stringValue: String(value) } }; // UUID as string
    case 'value_json':
      return { name: 'val', value: { stringValue: JSON.stringify(value) } }; // JSONB
    default:
      return { name: 'val', value: { stringValue: String(value) } };
  }
}

/** Generate SET clause to null out all other value columns. */
export function nullOtherColumns(activeColumn: string): string {
  const ALL_VALUE_COLUMNS = [
    'value_text',
    'value_number',
    'value_date',
    'value_bool',
    'value_uuid',
    'value_json',
  ];
  return ALL_VALUE_COLUMNS.filter((c) => c !== activeColumn)
    .map((c) => `${c} = NULL`)
    .join(', ');
}

// ─── Data API Marshalling (forms-specific shapes over shared primitives) ─────

export function marshalTemplates(result: DataApiResult): Record<string, unknown>[] {
  if (!result.records || !result.columnMetadata) return [];
  return result.records.map((row) => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < result.columnMetadata!.length; i++) {
      const col = result.columnMetadata![i].name ?? `col${i}`;
      obj[snakeToCamel(col)] = unwrapField(row[i]);
    }
    // Rename for SDL compliance
    obj.clauseRefs = obj.clauseRefs ?? [];
    obj.standards = obj.standards ?? [];
    obj.sections = []; // Not loaded in list view
    return obj;
  });
}

export function marshalTemplateDetail(
  tplResult: DataApiResult,
  sectionsResult: DataApiResult,
  fieldsResult: DataApiResult,
): Record<string, unknown> | null {
  const templates = marshalTemplates(tplResult);
  if (templates.length === 0) return null;
  const tpl = templates[0];

  const sections: Record<string, unknown>[] = [];
  if (sectionsResult.records && sectionsResult.columnMetadata) {
    for (const row of sectionsResult.records) {
      const sec: Record<string, unknown> = {};
      for (let i = 0; i < sectionsResult.columnMetadata.length; i++) {
        const col = sectionsResult.columnMetadata[i].name ?? `col${i}`;
        sec[snakeToCamel(col)] = unwrapField(row[i]);
      }
      sec.fields = [];
      sections.push(sec);
    }
  }

  // Attach fields to their sections
  if (fieldsResult.records && fieldsResult.columnMetadata) {
    const sectionMap = new Map(sections.map((s) => [s.id as string, s]));
    for (const row of fieldsResult.records) {
      const field: Record<string, unknown> = {};
      for (let i = 0; i < fieldsResult.columnMetadata.length; i++) {
        const col = fieldsResult.columnMetadata[i].name ?? `col${i}`;
        field[snakeToCamel(col)] = unwrapField(row[i]);
      }
      // options/validation are jsonb — parse for the AWSJSON slot
      // (double-encoded on the wire otherwise, found 2026-07-22)
      if (field.options != null) field.options = jsonOut(field.options);
      if (field.validation != null) field.validation = jsonOut(field.validation);
      const sec = sectionMap.get(field.sectionId as string);
      if (sec) (sec.fields as Record<string, unknown>[]).push(field);
    }
  }

  tpl.sections = sections;
  return tpl;
}

export function marshalRecordRows(result: DataApiResult): Record<string, unknown>[] {
  if (!result.records || !result.columnMetadata) return [];
  return result.records.map((row) => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < result.columnMetadata!.length; i++) {
      const col = result.columnMetadata![i].name ?? `col${i}`;
      const camel = snakeToCamel(col);
      obj[camel] = unwrapField(row[i]);
    }
    // Map status to uppercase enum
    if (typeof obj.status === 'string') {
      obj.status = obj.status.toUpperCase().replace(/_/g, '_');
    }
    return obj;
  });
}

export function marshalValues(result: DataApiResult): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  if (!result.records || !result.columnMetadata) return obj;
  for (const row of result.records) {
    let fieldKey = '';
    let value: unknown = null;
    for (let i = 0; i < result.columnMetadata.length; i++) {
      const col = result.columnMetadata[i].name ?? '';
      const v = unwrapField(row[i]);
      if (col === 'field_key') {
        fieldKey = v as string;
        continue;
      }
      if (v !== null && col !== 'field_key') {
        value = v;
      }
    }
    if (fieldKey) obj[fieldKey] = value;
  }
  return obj;
}

export interface FieldMeta {
  fieldId: string;
  fieldType: string;
  relationTarget: string | null;
}

export interface FieldMetaFull {
  fieldKey: string;
  fieldType: string;
  required: boolean;
  mapsToColumn: string | null;
  relationTarget: string | null;
}

export function marshalFieldMetaFull(result: DataApiResult): FieldMetaFull[] {
  const fields: FieldMetaFull[] = [];
  if (!result.records || !result.columnMetadata) return fields;
  for (const row of result.records) {
    let key = '',
      type = '',
      mapsTo: string | null = null,
      relTarget: string | null = null;
    let required = false;
    for (let i = 0; i < result.columnMetadata.length; i++) {
      const col = result.columnMetadata[i].name ?? '';
      const v = unwrapField(row[i]);
      if (col === 'field_key') key = v as string;
      if (col === 'field_type') type = v as string;
      if (col === 'required') required = v === true;
      if (col === 'maps_to_column') mapsTo = v as string | null;
      if (col === 'relation_target') relTarget = v as string | null;
    }
    if (key)
      fields.push({
        fieldKey: key,
        fieldType: type,
        required,
        mapsToColumn: mapsTo,
        relationTarget: relTarget,
      });
  }
  return fields;
}

export function marshalFieldMeta(result: DataApiResult): Map<string, FieldMeta> {
  const map = new Map<string, FieldMeta>();
  if (!result.records || !result.columnMetadata) return map;
  for (const row of result.records) {
    let id = '',
      key = '',
      type = '',
      relTarget: string | null = null;
    for (let i = 0; i < result.columnMetadata.length; i++) {
      const col = result.columnMetadata[i].name ?? '';
      const v = unwrapField(row[i]);
      if (col === 'id') id = v as string;
      if (col === 'field_key') key = v as string;
      if (col === 'field_type') type = v as string;
      if (col === 'relation_target') relTarget = v as string | null;
    }
    if (key) map.set(key, { fieldId: id, fieldType: type, relationTarget: relTarget });
  }
  return map;
}

export function extractFieldKeys(result: DataApiResult): string[] {
  const keys: string[] = [];
  if (!result.records || !result.columnMetadata) return keys;
  const keyIdx = result.columnMetadata.findIndex((c) => c.name === 'field_key');
  if (keyIdx < 0) return keys;
  for (const row of result.records) {
    keys.push(unwrapField(row[keyIdx]) as string);
  }
  return keys;
}

export function extractRequiredFieldKeys(result: DataApiResult): string[] {
  const keys: string[] = [];
  if (!result.records || !result.columnMetadata) return keys;
  const keyIdx = result.columnMetadata.findIndex((c) => c.name === 'field_key');
  const reqIdx = result.columnMetadata.findIndex((c) => c.name === 'required');
  if (keyIdx < 0 || reqIdx < 0) return keys;
  for (const row of result.records) {
    if (unwrapField(row[reqIdx]) === true) {
      keys.push(unwrapField(row[keyIdx]) as string);
    }
  }
  return keys;
}
