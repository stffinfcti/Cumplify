/**
 * SeedSections Lambda — DocGenStateMachine step 1 (spec 40, design §4.1).
 *
 * Reads the run's PINNED profile version + applicability + registry, groups
 * in-scope clauses per grouping.ts (GEN-3 by construction), and inserts
 * section rows idempotently: ON CONFLICT (run_id, harmonization_key) DO
 * NOTHING, so re-running the machine re-seeds as a no-op and the Map picks
 * up only sections still 'pending' (GEN-5 resume semantics).
 *
 * N/A sections are written as `na_justified` directly, with a minimal
 * content JSON in S3 carrying the justification (the section row has no
 * justification column by design — S3 content is the single content plane).
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { Logger } from '@aws-lambda-powertools/logger';
import {
  beginTenantTransaction,
  marshalMany,
  rollbackQuietly,
} from '../../api/src/resolvers/shared.js';
import { groupSections, type RegistryClause, type Exclusion } from './grouping.js';
import { sha256Hex } from './facts.js';

const logger = new Logger({ serviceName: 'qms-seed-sections' });
const s3 = new S3Client({});
const GENERAL_BUCKET = process.env.GENERAL_BUCKET!;

export interface SeedInput {
  runId: string;
  tenantId: string;
}
export interface SeedOutput {
  runId: string;
  tenantId: string;
  sections: Array<{ sectionId: string; sectionKey: string }>;
}

export function sectionContentKey(tenantId: string, runId: string, sectionKey: string): string {
  return `tenants/${tenantId}/generation/${runId}/sections/${encodeURIComponent(sectionKey)}.json`;
}

export async function handler(event: SeedInput): Promise<SeedOutput> {
  const { runId, tenantId } = event;
  logger.appendKeys({ runId, tenantId });

  const txn = await beginTenantTransaction(tenantId);
  try {
    const runResult = await txn.execute(
      `SELECT profile_version, standards FROM qms.generation_runs WHERE id = :runId::uuid`,
      [{ name: 'runId', value: { stringValue: runId } }],
    );
    if (!runResult.records?.length) throw new Error(`RUN_NOT_FOUND: ${runId}`);
    const standards =
      (runResult.records[0][1] as { arrayValue?: { stringValues?: string[] } }).arrayValue
        ?.stringValues ?? [];

    const registryResult = await txn.execute(`
      SELECT id, standard, clause_no, clause_title, intent_paraphrase,
             annex_sl_mode, harmonization_key, doc_type, required_sources, sort_order
      FROM qms.clause_registry ORDER BY sort_order
    `);
    const registry: RegistryClause[] = marshalMany(registryResult).map((r) => ({
      id: r.id as string,
      standard: r.standard as string,
      clauseNo: r.clauseNo as string,
      clauseTitle: r.clauseTitle as string,
      intentParaphrase: r.intentParaphrase as string,
      annexSlMode: r.annexSlMode as RegistryClause['annexSlMode'],
      harmonizationKey: r.harmonizationKey as string,
      docType: r.docType as string,
      requiredSources: JSON.parse((r.requiredSources as string) || '[]') as string[],
      sortOrder: r.sortOrder as number,
    }));

    const exclusionResult = await txn.execute(
      `SELECT clause_registry_id, justification FROM qms.clause_applicability WHERE applicable = false`,
    );
    const exclusions: Exclusion[] = marshalMany(exclusionResult).map((r) => ({
      clauseRegistryId: r.clauseRegistryId as string,
      justification: (r.justification as string) ?? '',
    }));

    const plans = groupSections(registry, standards, exclusions);

    for (const plan of plans) {
      let contentKey: string | null = null;
      let contentSha: string | null = null;
      if (plan.status === 'na_justified') {
        const content = JSON.stringify({
          schemaVersion: 1,
          harmonizationKey: plan.sectionKey,
          clauseRefs: plan.clauses.map((c) => ({ standard: c.standard, clauseNo: c.clauseNo })),
          kind: 'na_justified',
          naJustification: plan.naJustification,
        });
        contentKey = sectionContentKey(tenantId, runId, plan.sectionKey);
        contentSha = sha256Hex(content);
        await s3.send(
          new PutObjectCommand({
            Bucket: GENERAL_BUCKET,
            Key: contentKey,
            Body: content,
            ContentType: 'application/json',
          }),
        );
      }

      // Data API has no array parameters — Postgres array literal + cast.
      const idsLiteral = `{${plan.clauses.map((c) => c.id).join(',')}}`;
      await txn.execute(
        `
        INSERT INTO qms.generation_sections
          (run_id, tenant_id, harmonization_key, clause_registry_ids, status,
           content_s3_key, content_sha256, created_by)
        VALUES (:runId::uuid, :tenantId, :sectionKey, :ids::uuid[], :status,
                :contentKey, :contentSha, :createdBy)
        ON CONFLICT (run_id, harmonization_key) DO NOTHING
      `,
        [
          { name: 'runId', value: { stringValue: runId } },
          { name: 'tenantId', value: { stringValue: tenantId } },
          { name: 'sectionKey', value: { stringValue: plan.sectionKey } },
          { name: 'ids', value: { stringValue: idsLiteral } },
          { name: 'status', value: { stringValue: plan.status } },
          {
            name: 'contentKey',
            value: contentKey ? { stringValue: contentKey } : { isNull: true },
          },
          {
            name: 'contentSha',
            value: contentSha ? { stringValue: contentSha } : { isNull: true },
          },
          { name: 'createdBy', value: { stringValue: 'docgen-state-machine' } },
        ],
      );
    }

    // GEN-5: the Map processes ONLY sections still pending (resume-safe)
    const pendingResult = await txn.execute(
      `SELECT id, harmonization_key FROM qms.generation_sections
       WHERE run_id = :runId::uuid AND status = 'pending' ORDER BY harmonization_key`,
      [{ name: 'runId', value: { stringValue: runId } }],
    );
    await txn.commit();

    const sections = marshalMany(pendingResult).map((r) => ({
      sectionId: r.id as string,
      sectionKey: r.harmonizationKey as string,
    }));
    logger.info('Seeded sections', { planned: plans.length, pending: sections.length });
    return { runId, tenantId, sections };
  } catch (err) {
    await rollbackQuietly(txn);
    throw err;
  }
}
