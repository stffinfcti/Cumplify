/**
 * Run-state loaders shared by finalize-manual and regenerate-section — the
 * run row (+ org-profile payload) and the section skeletons with resolved
 * clause metadata. Single source for both readers: regenerate's phase-3a
 * live read and finalize's phase-1 read used to carry two copies of the
 * same queries (the skeleton mapping alone was ~40 lines duplicated).
 */

import { marshalMany, type beginTenantTransaction } from '../../api/src/resolvers/shared.js';
import type { SectionState } from './derive.js';

export type RunTxn = Awaited<ReturnType<typeof beginTenantTransaction>>;

export interface RunRow {
  standards: string[];
  manualDocumentId: string | null;
  status: string;
  requestedBy: string | null;
  profile: Record<string, unknown>;
}

export async function loadRun(txn: RunTxn, runId: string): Promise<RunRow | null> {
  const runResult = await txn.execute(
    `SELECT gr.standards, gr.manual_document_id, gr.status, gr.requested_by, opv.payload
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
    manualDocumentId:
      (rec[1] as { stringValue?: string; isNull?: boolean } | undefined)?.stringValue ?? null,
    status: (
      (rec[2] as { stringValue?: string; isNull?: boolean } | undefined)?.stringValue ?? ''
    ).toLowerCase(),
    requestedBy:
      (rec[3] as { stringValue?: string; isNull?: boolean } | undefined)?.stringValue ?? null,
    profile: JSON.parse(
      (rec[4] as { stringValue?: string } | undefined)?.stringValue ?? '{}',
    ) as Record<string, unknown>,
  };
}

export interface SectionSkeleton extends Omit<SectionState, 'content'> {
  contentS3Key: string | null;
}

/** Section rows + resolved clause metadata — no S3. Content JSONs are
 * prefetched in parallel by the caller (a serial getJson per section inside
 * a write txn is seconds of S3 latency under the lock). */
export async function loadSectionSkeletons(txn: RunTxn, runId: string): Promise<SectionSkeleton[]> {
  const sectionsResult = await txn.execute(
    `SELECT id, harmonization_key, status, content_s3_key, clause_registry_ids
     FROM qms.generation_sections WHERE run_id = :runId::uuid ORDER BY harmonization_key`,
    [{ name: 'runId', value: { stringValue: runId } }],
  );
  // marshalMany reverse-maps the overloaded `status` column to GraphQL
  // UPPERCASE — normalize back to DB casing for internal logic.
  const sectionRows: Record<string, unknown>[] = marshalMany(sectionsResult).map((r) => ({
    ...r,
    status: (r.status as string).toLowerCase(),
  }));

  const registryResult = await txn.execute(
    `SELECT id, standard, clause_no, clause_title, annex_sl_mode, doc_type, sort_order
     FROM qms.clause_registry`,
  );
  const registryById = new Map(marshalMany(registryResult).map((r) => [r.id as string, r]));

  // `sortOrder` is the lowest clause registry sort_order (9999 when the
  // section maps no clauses — Math.min over an empty list returns Infinity).
  return sectionRows.map((row) => {
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
        // normalize back to DB casing (same class as the status fix above).
        docType: (c.docType as string).toLowerCase(),
      }));
    const sortOrder = clauseIds.length
      ? Math.min(...clauseIds.map((id) => (registryById.get(id)?.sortOrder as number) ?? 9999))
      : 9999;
    return {
      sectionKey: row.harmonizationKey as string,
      kind: row.status as SectionState['kind'],
      clauses,
      sortOrder,
      contentS3Key: (row.contentS3Key as string | null) ?? null,
    };
  });
}
