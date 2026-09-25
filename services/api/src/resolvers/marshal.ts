/**
 * Data API response marshalling (BUG-A fix) — split out of shared.ts.
 *
 * shared.ts keeps the isolation paths (tenant transaction, DDB credential
 * cache, context extraction); this module owns turning raw Data API
 * responses into GraphQL-shaped objects: column→camelCase, enum reverse
 * maps, timestamp/array unwrapping, and AWSJSON boundary validation.
 */

import { z } from 'zod';
import {
  RISK_CATEGORY_MAP,
  DOC_TYPE_MAP,
  DOC_STATUS_MAP,
  APPROVAL_DECISION_MAP,
  NC_SOURCE_MAP,
  NC_TYPE_MAP,
  SEVERITY_MAP,
  DISPOSITION_MAP,
  FINDING_TYPE_MAP,
  CAPA_STATUS_MAP,
  GENERATION_RUN_STATUS_MAP,
  SECTION_KIND_MAP,
} from './enum-mappings.js';

/** Reverse maps: DB lowercase → GraphQL UPPERCASE */
function invertMap(map: Record<string, string>): Record<string, string> {
  const inv: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    inv[v] = k;
  }
  return inv;
}

const REVERSE_ENUMS: Record<string, Record<string, string>> = {
  category: invertMap(RISK_CATEGORY_MAP),
  doc_type: invertMap(DOC_TYPE_MAP),
  // Overloaded `status` column: doc values (draft/in_review/approved/obsolete),
  // CAPA values (open/in_progress/closed/verified), qms run values
  // (running/complete/failed/partial), and section-kind values
  // (pending/prose/gap/na_justified/failed) are pairwise disjoint except
  // 'failed', which maps to FAILED in both qms maps — so one merged reverse
  // map serves DocumentStatus!, CAPAStatus!, GenerationRunStatus!, and
  // `status AS kind` aliases regardless of whether Data API reports the
  // alias or the underlying column name.
  status: {
    ...invertMap(DOC_STATUS_MAP),
    ...invertMap(CAPA_STATUS_MAP),
    ...invertMap(GENERATION_RUN_STATUS_MAP),
    ...invertMap(SECTION_KIND_MAP),
  },
  kind: invertMap(SECTION_KIND_MAP),
  decision: invertMap(APPROVAL_DECISION_MAP),
  source: invertMap(NC_SOURCE_MAP),
  nc_type: invertMap(NC_TYPE_MAP),
  severity: invertMap(SEVERITY_MAP),
  disposition: invertMap(DISPOSITION_MAP),
  finding_type: invertMap(FINDING_TYPE_MAP),
};

/** snake_case → camelCase */
export function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * RDS Data API returns TIMESTAMP/TIMESTAMPTZ as `YYYY-MM-DD HH:MM:SS[.ffffff]`
 * (UTC, no zone designator) — AppSync AWSDateTime rejects that shape AFTER
 * the resolver succeeds (AUD-1/BUG-18: 33 fields, every populated register).
 * Strict full-string match converts to ISO-8601 UTC; anything else passes
 * through untouched (AWSDate `YYYY-MM-DD` is already valid and unaffected).
 */
const SQL_TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/;

export function sqlTimestampToIso(value: string): string {
  const m = SQL_TIMESTAMP_RE.exec(value);
  if (!m) return value;
  const ms = (m[3] ?? '').padEnd(3, '0').slice(0, 3);
  return `${m[1]}T${m[2]}.${ms}Z`;
}

/**
 * Data API wraps array columns as {stringValues|longValues|doubleValues|
 * booleanValues|arrayValues} — unwrap to a plain array (recursive for
 * nested arrays) or GraphQL list/AWSJSON fields serialize the wrapper.
 */
function unwrapArray(av: Record<string, unknown>): unknown[] {
  if (Array.isArray(av.arrayValues)) {
    return (av.arrayValues as Record<string, unknown>[]).map(unwrapArray);
  }
  return (av.stringValues ??
    av.longValues ??
    av.doubleValues ??
    av.booleanValues ??
    []) as unknown[];
}

/** Unwrap a Data API field value */
export function unwrapField(field: Record<string, unknown>): unknown {
  if (field.stringValue !== undefined)
    return typeof field.stringValue === 'string'
      ? sqlTimestampToIso(field.stringValue)
      : field.stringValue;
  if (field.longValue !== undefined) return field.longValue;
  if (field.doubleValue !== undefined) return field.doubleValue;
  if (field.booleanValue !== undefined) return field.booleanValue;
  if (field.isNull) return null;
  if (field.arrayValue !== undefined)
    return unwrapArray(field.arrayValue as Record<string, unknown>);
  // Blob or other — return as-is
  return Object.values(field)[0] ?? null;
}

export interface DataApiResult {
  records?: Array<Array<Record<string, unknown>>>;
  columnMetadata?: Array<{ name?: string; label?: string }>;
  numberOfRecordsUpdated?: number;
}

/**
 * Marshal a Data API response into a plain object (or array of objects)
 * with camelCase keys and GraphQL enum casing.
 */
export function marshalRow(
  row: Array<Record<string, unknown>>,
  columns: Array<{ name?: string; label?: string }>,
): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < columns.length; i++) {
    const colName = columns[i].name ?? columns[i].label ?? `col${i}`;
    let value = unwrapField(row[i]);

    // Reverse-map enum columns: DB lowercase → GraphQL UPPERCASE
    if (typeof value === 'string' && REVERSE_ENUMS[colName]?.[value]) {
      value = REVERSE_ENUMS[colName][value];
    }

    obj[snakeToCamel(colName)] = value;
  }
  return obj;
}

/**
 * Marshal a full Data API result into an array of objects.
 * For mutations (RETURNING), typically returns one row.
 */
export function marshalResult(result: DataApiResult): Record<string, unknown>[] {
  if (!result.records || !result.columnMetadata) return [];
  return result.records.map((row) => marshalRow(row, result.columnMetadata!));
}

/**
 * Marshal and return a single object (for create/get mutations) or null.
 */
export function marshalOne(result: DataApiResult): Record<string, unknown> | null {
  const rows = marshalResult(result);
  return rows[0] ?? null;
}

/**
 * Marshal and return an array (for list queries).
 */
export function marshalMany(result: DataApiResult): Record<string, unknown>[] {
  return marshalResult(result);
}

/**
 * Prepare a jsonb-derived value for an AWSJSON response field.
 *
 * AppSync serializes the resolver's return value into the AWSJSON slot
 * exactly once: return the parsed object/array and the client receives
 * parsed JSON; return the Data-API jsonb STRING and the client receives a
 * double-encoded string (found live 2026-07-22 — getDocumentContent,
 * OrgProfile.payload, GenerationSection.clauseRefs all arrived
 * double-encoded while array-returning clauseRefs arrived correctly).
 */
export function jsonOut(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

// ─── AWSJSON boundary validation (M-effort, item 8) ──────────────────────────
/**
 * Recursive JSON value — the declared shape of every free-form AWSJSON slot.
 */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

/**
 * Parse + shape-check an AWSJSON mutation input at the resolver boundary.
 * AWSJSON arrives parsed (object) from AppSync, as a string from hermetic
 * fixtures — accept both (same wire-shape class as saveOrgProfile, found
 * live 2026-07-22). Errors are INVALID_PAYLOAD, mirroring OrgProfileSchema.
 */
export function parseAwsJson<T>(schema: z.ZodType<T>, raw: unknown, field: string): T {
  const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new Error(
      `INVALID_PAYLOAD: ${field} failed shape check (${result.error.issues[0]?.message ?? 'invalid'})`,
    );
  }
  return result.data;
}
