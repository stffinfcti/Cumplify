/**
 * ComposeSection Lambda — DocGenStateMachine Map iterator (spec 40, §4.2/§4.3).
 *
 * Order of operations per section:
 *   1. pending guard (idempotent — a Map retry of a finished section no-ops)
 *   2. GAP decision BEFORE any model call — empty source ⇒ gap block, $0
 *   3. fact assembly → doc-composer seat via the ONE DOOR (AI_INVOKER_ARN);
 *      tenant facts ride in guardedText (PROMPT_ATTACK stays HIGH — the
 *      2026-07-15 live finding), scaffolding in plain text
 *   4. deterministic checker (code, not model) → one retry with violations
 *      appended → still failing ⇒ status='failed' (never silently gapped)
 *   5. S3 content JSON + assertion-ledger rows + section row in ONE txn,
 *      then audit event + progress event (best-effort) after commit
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { Logger } from '@aws-lambda-powertools/logger';
import {
  beginTenantTransaction,
  marshalMany,
  publishAuditEvent,
  rollbackQuietly,
} from '../../api/src/resolvers/shared.js';
import { DOC_COMPOSER_OUTPUT_SCHEMA } from '../../ai-invoker/src/doc-composer-schema.js';
import type { InvokeRequest, InvokeResponse, ContentBlock } from '../../ai-invoker/src/types.js';
import { decideGap, REGISTER_TABLE_MAP } from './gap.js';
import { checkSection, type ComposedSentence } from './checker.js';
import { assembleFacts, sha256Hex, type Fact, type RegisterData } from './facts.js';
import { publishGenerationEvent } from './appsync-publish.js';
import { sectionContentKey } from './seed-sections.js';

const logger = new Logger({ serviceName: 'qms-compose-section' });
const s3 = new S3Client({});
const lambdaClient = new LambdaClient({});

const GENERAL_BUCKET = process.env.GENERAL_BUCKET!;
const AI_INVOKER_ARN = process.env.AI_INVOKER_ARN!;

export interface ComposeInput {
  runId: string;
  tenantId: string;
  sectionId: string;
  sectionKey: string;
}

interface ClauseRow {
  id: string;
  standard: string;
  clauseNo: string;
  clauseTitle: string;
  intentParaphrase: string;
  requiredSources: string[];
}

async function invokeComposer(request: InvokeRequest): Promise<InvokeResponse> {
  const result = await lambdaClient.send(
    new InvokeCommand({
      FunctionName: AI_INVOKER_ARN,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify(request)),
    }),
  );
  if (result.FunctionError) {
    const payload = result.Payload ? JSON.parse(Buffer.from(result.Payload).toString()) : {};
    throw new Error(`AI Invoker error: ${payload.errorMessage ?? result.FunctionError}`);
  }
  return JSON.parse(Buffer.from(result.Payload!).toString()) as InvokeResponse;
}

function composerMessages(
  clauses: ClauseRow[],
  facts: Fact[],
  locale: string,
  retryViolations?: string[],
): InvokeRequest['messages'] {
  const clauseContext = clauses
    .map((c) => `${c.standard} ${c.clauseNo} (${c.clauseTitle}): ${c.intentParaphrase}`)
    .join('\n');

  const scaffolding =
    `You compose management-system manual prose for an organization, in ${locale}. ` +
    `Write 3-8 sentences of integrated prose addressing this clause intent:\n${clauseContext}\n\n` +
    `Rules: the organization is the subject; never use "shall"; no bullet points; no placeholders; ` +
    `state only what the numbered facts support. ` +
    `Respond with ONLY a JSON object of the form {"sentences":[{"text":"...","factRefs":["F1"]}]} — ` +
    `every sentence must list the F-numbers of the facts it uses in its factRefs array, and ` +
    `factRefs must never be empty. The sentence text itself must never contain F-numbers or ` +
    `citations like "(F1, F3)" — citations go in factRefs, prose stays clean. The facts follow:`;

  const factsText = facts.map((f) => `${f.key}: ${f.text}`).join('\n');

  const content: ContentBlock[] = [
    { text: scaffolding },
    // Tenant-sourced data rides in guardContent — selective guardrail evaluation
    { guardedText: factsText },
  ];
  if (retryViolations?.length) {
    content.push({
      text: `Your previous draft failed these deterministic checks — fix every one:\n- ${retryViolations.join('\n- ')}`,
    });
  }
  return [{ role: 'user', content }];
}

export async function handler(event: ComposeInput): Promise<{ sectionId: string; status: string }> {
  const { runId, tenantId, sectionId, sectionKey } = event;
  logger.appendKeys({ runId, tenantId, sectionId, sectionKey });

  const txn = await beginTenantTransaction(tenantId);
  let sectionStatus = 'failed';
  let contentKey: string | null = null;
  let auditPayload: Record<string, unknown> = {};
  try {
    // 1. Pending guard — idempotent iterator
    const sectionResult = await txn.execute(
      `SELECT status, clause_registry_ids FROM qms.generation_sections WHERE id = :id::uuid`,
      [{ name: 'id', value: { stringValue: sectionId } }],
    );
    if (!sectionResult.records?.length) throw new Error(`SECTION_NOT_FOUND: ${sectionId}`);
    const currentStatus = (sectionResult.records[0][0] as { stringValue?: string }).stringValue;
    if (currentStatus !== 'pending') {
      await txn.commit();
      logger.info('Section not pending — skipping (idempotent retry)', { currentStatus });
      return { sectionId, status: currentStatus ?? 'unknown' };
    }
    const clauseIds =
      (sectionResult.records[0][1] as { arrayValue?: { stringValues?: string[] } }).arrayValue
        ?.stringValues ?? [];

    await publishGenerationEvent({
      runId,
      tenantId,
      type: 'section_started',
      harmonizationKey: sectionKey,
    });

    // Load run (pinned profile version) + profile payload
    const runResult = await txn.execute(
      `SELECT gr.profile_version, opv.payload
       FROM qms.generation_runs gr
       JOIN qms.org_profiles op ON op.tenant_id = gr.tenant_id
       JOIN qms.org_profile_versions opv ON opv.profile_id = op.id AND opv.version_no = gr.profile_version
       WHERE gr.id = :runId::uuid`,
      [{ name: 'runId', value: { stringValue: runId } }],
    );
    if (!runResult.records?.length) throw new Error(`PINNED_PROFILE_NOT_FOUND for run ${runId}`);
    const profile = JSON.parse(
      (runResult.records[0][1] as { stringValue?: string }).stringValue ?? '{}',
    ) as Record<string, unknown>;

    // Member clauses
    const idsLiteral = `{${clauseIds.join(',')}}`;
    const clausesResult = await txn.execute(
      `SELECT id, standard, clause_no, clause_title, intent_paraphrase, required_sources
       FROM qms.clause_registry WHERE id = ANY(:ids::uuid[]) ORDER BY standard`,
      [{ name: 'ids', value: { stringValue: idsLiteral } }],
    );
    const clauses: ClauseRow[] = marshalMany(clausesResult).map((r) => ({
      id: r.id as string,
      standard: r.standard as string,
      clauseNo: r.clauseNo as string,
      clauseTitle: r.clauseTitle as string,
      intentParaphrase: r.intentParaphrase as string,
      requiredSources: JSON.parse((r.requiredSources as string) || '[]') as string[],
    }));
    const requiredSources = [...new Set(clauses.flatMap((c) => c.requiredSources))];

    // 2. GAP decision — register counts + samples, RLS-scoped inside this txn
    const registerNames = requiredSources
      .filter((s) => s.startsWith('register.'))
      .map((s) => s.slice('register.'.length));
    const registerCounts: Record<string, number> = {};
    const registerData: RegisterData[] = [];
    for (const name of registerNames) {
      const spec = REGISTER_TABLE_MAP[name];
      if (!spec) {
        registerCounts[name] = 0;
        continue;
      } // module not built — definitionally empty
      const countResult = await txn.execute(`SELECT COUNT(*) FROM ${spec.table}`);
      const count = Number((countResult.records![0][0] as { longValue?: number }).longValue ?? 0);
      registerCounts[name] = count;
      if (count > 0) {
        const sampleResult = await txn.execute(
          `SELECT ${spec.titleExpr} FROM ${spec.table} ORDER BY created_at DESC LIMIT 3`,
        );
        const samples = (sampleResult.records ?? [])
          .map((row) => (row[0] as { stringValue?: string }).stringValue ?? '')
          .filter(Boolean);
        registerData.push({ name, count, samples });
      }
    }

    const clauseRefs = clauses.map((c) => ({ standard: c.standard, clauseNo: c.clauseNo }));
    const gapDecision = decideGap(requiredSources, profile, registerCounts);

    if (gapDecision.gap) {
      // 2a. GAP block — zero model invocation, $0 (ACC-4 by construction)
      const content = JSON.stringify({
        schemaVersion: 1,
        harmonizationKey: sectionKey,
        clauseRefs,
        kind: 'gap',
        gap: { missingSources: gapDecision.missingSources },
      });
      contentKey = sectionContentKey(tenantId, runId, sectionKey);
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
         SET status = 'gap', content_s3_key = :key, content_sha256 = :sha, updated_at = NOW()
         WHERE id = :id::uuid`,
        [
          { name: 'key', value: { stringValue: contentKey } },
          { name: 'sha', value: { stringValue: contentSha } },
          { name: 'id', value: { stringValue: sectionId } },
        ],
      );
      sectionStatus = 'gap';
      auditPayload = { kind: 'gap', missingSources: gapDecision.missingSources };
    } else {
      // 3. Compose via the one door — facts guarded, scaffolding plain
      const facts = assembleFacts(profile, registerData);
      const locale = (profile.documentLocale as string) ?? 'en';
      const orgName = (profile.legalName as string) ?? 'the organization';

      const invokeOnce = (retryViolations?: string[]) =>
        invokeComposer({
          seat: 'doc-composer',
          messages: composerMessages(clauses, facts, locale, retryViolations),
          outputSchema: DOC_COMPOSER_OUTPUT_SCHEMA as Record<string, unknown>,
          tenantId,
          agent: 'doc-composer',
          module: 'M1',
          feature: 'ims-manual-generation',
        });

      const factKeys = new Set(facts.map((f) => f.key));
      // Golden-eval round-2 finding (Task 12): a terminal AI-invoker error
      // (schema retries exhausted, guardrail hard block) on ONE section must
      // never kill the whole run — eval-09's 8.3 crashed the execution and
      // left the run stuck 'running'. Route it into the SAME honest path as
      // checker exhaustion: section failed, run finishes PARTIAL.
      let response: Awaited<ReturnType<typeof invokeOnce>> | null = null;
      let sentences: ComposedSentence[] = [];
      let check: ReturnType<typeof checkSection>;
      try {
        response = await invokeOnce();
        sentences = (JSON.parse(response.text) as { sentences: ComposedSentence[] }).sentences;
        check = checkSection({ sentences, factKeys, orgName });

        if (!check.pass) {
          // 4. ONE retry with the checker's violations appended
          logger.info('Checker failed — one retry', { violations: check.violations });
          response = await invokeOnce(check.violations);
          sentences = (JSON.parse(response.text) as { sentences: ComposedSentence[] }).sentences;
          check = checkSection({ sentences, factKeys, orgName });
        }
      } catch (invokeErr) {
        logger.error('Composer terminal error — marking section failed', {
          error: (invokeErr as Error).message,
        });
        check = {
          pass: false,
          violations: [`composer error: ${(invokeErr as Error).message}`.slice(0, 500)],
        };
      }

      if (!check.pass) {
        await txn.execute(
          `UPDATE qms.generation_sections
           SET status = 'failed', error = :err, updated_at = NOW() WHERE id = :id::uuid`,
          [
            { name: 'err', value: { stringValue: check.violations.join('; ').slice(0, 2000) } },
            { name: 'id', value: { stringValue: sectionId } },
          ],
        );
        sectionStatus = 'failed';
        auditPayload = { kind: 'failed', violations: check.violations };
      } else {
        // 5. Content JSON + ledger rows + section row
        const content = JSON.stringify({
          schemaVersion: 1,
          harmonizationKey: sectionKey,
          clauseRefs,
          kind: 'prose',
          sentences,
        });
        contentKey = sectionContentKey(tenantId, runId, sectionKey);
        const contentSha = sha256Hex(content);
        await s3.send(
          new PutObjectCommand({
            Bucket: GENERAL_BUCKET,
            Key: contentKey,
            Body: content,
            ContentType: 'application/json',
          }),
        );

        const factsByKey = new Map(facts.map((f) => [f.key, f]));
        for (let i = 0; i < sentences.length; i++) {
          for (const ref of sentences[i].factRefs) {
            const fact = factsByKey.get(ref)!;
            await txn.execute(
              `INSERT INTO qms.assertion_ledger
                 (tenant_id, section_id, sentence_idx, sentence_sha256, fact_key, fact_source, fact_value_sha256, created_by)
               VALUES (:tenantId, :sectionId::uuid, :idx::integer, :ssha, :fkey, :fsource, :fsha, :createdBy)`,
              [
                { name: 'tenantId', value: { stringValue: tenantId } },
                { name: 'sectionId', value: { stringValue: sectionId } },
                { name: 'idx', value: { longValue: i } },
                { name: 'ssha', value: { stringValue: sha256Hex(sentences[i].text) } },
                { name: 'fkey', value: { stringValue: ref } },
                { name: 'fsource', value: { stringValue: fact.source } },
                { name: 'fsha', value: { stringValue: sha256Hex(fact.text) } },
                { name: 'createdBy', value: { stringValue: 'docgen-state-machine' } },
              ],
            );
          }
        }

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
        sectionStatus = 'prose';
        auditPayload = {
          kind: 'prose',
          sentenceCount: sentences.length,
          // check.pass === true is only reachable after a successful invoke
          credits: response!.credits,
          contentSha256: contentSha,
        };
      }
    }

    await txn.commit();
  } catch (err) {
    await rollbackQuietly(txn);
    throw err;
  }

  // After commit: durable audit event, then best-effort progress event
  const kindUpper = sectionStatus.toUpperCase() as 'PROSE' | 'GAP' | 'FAILED';
  await publishAuditEvent({
    tenantId,
    actor: 'docgen-state-machine',
    module: 'M1',
    clauseRef: sectionKey,
    standard: 'IMS',
    detailType:
      sectionStatus === 'failed' ? 'Generation.SectionFailed' : 'Generation.SectionComposed',
    source: 'cumplify.qms.docgen',
    entityId: sectionId,
    payload: { runId, sectionId, harmonizationKey: sectionKey, ...auditPayload },
  });
  await publishGenerationEvent({
    runId,
    tenantId,
    type: sectionStatus === 'failed' ? 'section_failed' : 'section_complete',
    harmonizationKey: sectionKey,
    kind: kindUpper,
    summary: JSON.stringify(auditPayload),
  });

  return { sectionId, status: sectionStatus };
}
