/**
 * forms — catalog + record read surface (templates, record listings,
 * single-record fetch). Extracted from forms.ts.
 */

import {
  beginTenantTransaction,
  clampListLimit,
  getCurrentOrgProfile,
  rollbackQuietly,
} from '../shared.js';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import {
  marshalTemplates,
  marshalTemplateDetail,
  marshalRecordRows,
  fetchTemplateFieldMeta,
  completionFrom,
  type AppSyncEvent,
} from './common.js';

// ─── Queries ─────────────────────────────────────────────────────────────────

/**
 * listFormTemplates — the tenant-less catalog, scoped to the tenant.
 * TPL-3 (ACC-1): filtered by the tenant's standards in scope from the
 * spec-40 org profile — a 9001-only tenant never sees 14001/45001-only
 * registers. Falls back to ALL templates until a profile exists (design §5).
 * The 'IMS' marker in seed standards[] is integration metadata, not a scope —
 * overlap is computed on CONCRETE standards only.
 * sectionCount/fieldCount are COUNTs over rows (BC-1).
 */
export async function listFormTemplates(tenantId: string): Promise<unknown[]> {
  const txn = await beginTenantTransaction(tenantId);
  try {
    const result = await txn.execute(`
      SELECT t.id, t.key, t.title_key, t.description_key, t.category,
             t.clause_refs, t.standards, t.requires_approval,
             (SELECT COUNT(*) FROM forms.template_sections s WHERE s.template_id = t.id) AS section_count,
             (SELECT COUNT(*) FROM forms.template_fields f
              JOIN forms.template_sections s2 ON f.section_id = s2.id
              WHERE s2.template_id = t.id) AS field_count
      FROM forms.templates t
      ORDER BY t.sort_order
    `);
    // Tenant scope (RLS-confined read; profile may not exist yet)
    const profile = await getCurrentOrgProfile(txn);
    await txn.commit();

    const templates = marshalTemplates(result);
    if (!profile) return templates; // no profile → all (design §5)
    const scope = (profile.payload as { standardsInScope?: string[] }).standardsInScope ?? [];
    if (scope.length === 0) return templates;

    const scopeSet = new Set(scope);
    return templates.filter((t) => {
      const concrete = ((t.standards as string[]) ?? []).filter((s) => s !== 'IMS');
      return concrete.some((s) => scopeSet.has(s));
    });
  } catch (err) {
    await rollbackQuietly(txn);
    throw err;
  }
}

/**
 * getFormTemplate — returns template with nested sections and fields.
 */
export async function getFormTemplate(event: AppSyncEvent): Promise<unknown> {
  const templateId = event.arguments.id as string;
  // Template is tenant-less; use a minimal transaction for consistency
  const txn = await beginTenantTransaction('__catalog__');
  try {
    const tplResult = await txn.execute(
      `
      SELECT t.id, t.key, t.title_key, t.description_key, t.category,
             t.clause_refs, t.standards, t.requires_approval,
             (SELECT COUNT(*) FROM forms.template_sections s WHERE s.template_id = t.id) AS section_count,
             (SELECT COUNT(*) FROM forms.template_fields f
              JOIN forms.template_sections s2 ON f.section_id = s2.id
              WHERE s2.template_id = t.id) AS field_count
      FROM forms.templates t WHERE t.id = :id::uuid
    `,
      [{ name: 'id', value: { stringValue: templateId } }],
    );

    const sectionsResult = await txn.execute(
      `
      SELECT s.id, s.section_key, s.title_key, s.sort_order
      FROM forms.template_sections s
      WHERE s.template_id = :id::uuid ORDER BY s.sort_order
    `,
      [{ name: 'id', value: { stringValue: templateId } }],
    );

    const fieldsResult = await txn.execute(
      `
      SELECT f.id, f.section_id, f.field_key, f.label_key, f.field_type,
             f.required, f.options, f.relation_target, f.validation, f.sort_order
      FROM forms.template_fields f
      JOIN forms.template_sections s ON f.section_id = s.id
      WHERE s.template_id = :id::uuid ORDER BY s.sort_order, f.sort_order
    `,
      [{ name: 'id', value: { stringValue: templateId } }],
    );

    await txn.commit();
    return marshalTemplateDetail(tplResult, sectionsResult, fieldsResult);
  } catch (err) {
    await rollbackQuietly(txn);
    throw err;
  }
}

/**
 * listFormRecords — tenant-scoped record listing per template.
 * NOTE: This closes the standing BLOCKED listRecords item from frontend-app Task 29.
 *
 * Task 10 (OQ-2 gate) rework: the original per-record computeCompletion was
 * 1 + 2N Data API round trips — a 30s Lambda timeout at 10k records. The
 * completion inputs now ride the listing itself (LATERAL aggregate per
 * returned row) + ONE template-fields query: 2 round trips regardless of
 * page size. Paginated (default 100, cap 500, newest first) — an unpaginated
 * 10k-row response would also breach the AppSync 1MB response limit.
 */
const LIST_DEFAULT_LIMIT = 100;
const LIST_MAX_LIMIT = 500;

export async function listFormRecords(event: AppSyncEvent, tenantId: string): Promise<unknown[]> {
  const templateId = event.arguments.templateId as string;
  const status = event.arguments.status as string | undefined;
  const limit = clampListLimit(
    event.arguments.limit as number | undefined,
    LIST_DEFAULT_LIMIT,
    LIST_MAX_LIMIT,
  );
  const offset = Math.max(0, (event.arguments.offset as number | undefined) ?? 0);
  const txn = await beginTenantTransaction(tenantId);
  try {
    let where = `WHERE r.template_id = :templateId::uuid`;
    const params: SqlParameter[] = [
      { name: 'templateId', value: { stringValue: templateId } },
      { name: 'limit', value: { longValue: limit } },
      { name: 'offset', value: { longValue: offset } },
    ];
    if (status) {
      where += ` AND r.status = :status`;
      params.push({ name: 'status', value: { stringValue: status.toLowerCase() } });
    }

    // Page FIRST (inner LIMIT), THEN the completion aggregate — a top-level
    // LATERAL runs for every candidate row BEFORE the sort+limit (measured:
    // 10k aggregate executions ≈ 340ms; paged: 100 ≈ 3ms). Ordered walk of
    // idx_forms_records_register (migration 017) serves the page directly.
    const result = await txn.execute(
      `
      SELECT page.*, c.filled_count, c.filled_keys
      FROM (
        SELECT r.id, r.template_id, r.status, r.opened_by, r.completed_by,
               r.m2_nc_id, r.created_at, r.updated_at
        FROM forms.records r
        ${where}
        ORDER BY r.created_at DESC
        LIMIT :limit OFFSET :offset
      ) page
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS filled_count, array_agg(f.field_key) AS filled_keys
        FROM forms.record_values rv
        JOIN forms.template_fields f ON rv.field_id = f.id
        WHERE rv.record_id = page.id
      ) c ON true
      ORDER BY page.created_at DESC
    `,
      params,
    );
    const fieldsMeta = await fetchTemplateFieldMeta(txn, templateId);
    await txn.commit();

    return marshalRecordRows(result).map((rec) => {
      const filledKeys = new Set((rec.filledKeys as string[] | null) ?? []);
      rec.completion = completionFrom(fieldsMeta, filledKeys);
      rec.values = {}; // Values returned on getFormRecord only (list is lightweight; object — AWSJSON slot)
      delete rec.filledCount;
      delete rec.filledKeys;
      return rec;
    });
  } catch (err) {
    await rollbackQuietly(txn);
    throw err;
  }
}
