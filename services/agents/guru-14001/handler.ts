/**
 * ISO14001Guru agent handler — AppSync resolver (user-triggered, NOT SQS consumer).
 * Advisory-only: retrieves ISO 14001 clause context and answers questions.
 *
 * Flow: AppSync query → embed(question) → retrieve ISO KB (AOSS, 45s budget) →
 * invoke Converse via Lambda transport (one-door) with groundingContext → return answer.
 * No tool-loop needed (no tools, advisory only).
 *
 * C-1 (BINDING): uses createInvokeFn() + createEmbedFn() Lambda transport.
 * NEVER imports invoke() or embed() directly from ai-invoker.
 *
 * Task 19: embed→retrieve→groundingContext wiring (spec-35 L1-11).
 */

import { retrieve } from '../shared/retrieval.js';
import { createInvokeFn, createEmbedFn } from '../shared/invoke-transport.js';
import { ISO_CANON_TENANT_ID } from '../shared/constants.js';
import { parseClauseRef } from '../shared/clause-ref-parser.js';
import { ISO14001_GURU_PROMPT } from './prompt.js';

const AOSS_ISO_KB_ENDPOINT = process.env.AOSS_ISO_KB_ENDPOINT!;

const GURU_STANDARD = 'ISO14001';
const GURU_STD_NUM = '14001';

const invokeFn = createInvokeFn();
const embedFn = createEmbedFn();

export async function handleQuery(
  tenantId: string,
  question: string,
  locale?: 'en' | 'es' | 'pt',
): Promise<string> {
  // Task 19 step 4: truncate query to 1,000 chars for grounding context
  const truncatedQuery = question.slice(0, 1000);

  // LEG-2: parse clause reference from question (iso-kb-content-depth)
  const parsed = parseClauseRef(truncatedQuery);
  // D-3': parsed standard WINS when question names one explicitly (priority 1)
  const clauseRef =
    parsed.clauseRef ?? (parsed.clauseNum ? `ISO ${GURU_STD_NUM} ${parsed.clauseNum}` : null);
  const standard = parsed.standard ?? (clauseRef ? GURU_STANDARD : undefined);

  // Task 19 step 2: embed the question via the one-door embed path
  const { embedding } = await embedFn({
    tenantId,
    agent: 'ISO14001Guru',
    module: 'advisory',
    feature: 'clause-qa',
    text: truncatedQuery,
  });

  // Task 19 step 3: retrieve under the 45s budget (L1-11, 02-aoss-rule)
  let groundingSource = '';
  try {
    const results = await retrieve({
      tenantId: ISO_CANON_TENANT_ID,
      collectionEndpoint: AOSS_ISO_KB_ENDPOINT,
      indexName: 'cumplify-iso-kb',
      queryText: truncatedQuery,
      queryVector: embedding,
      topK: 5,
      // LEG-2: hybrid clause-ref filtering (null/undefined values omitted)
      ...(clauseRef && {
        hybrid: { clauseRef, standard },
      }),
    });
    // Task 19 step 4: chunks joined with '\n---\n'
    groundingSource = results.chunks.map((c) => c.text).join('\n---\n');
  } catch {
    // Retrieval failure (incl. AOSS cold-start timeout) — respond without grounding.
    // The invoker's dormant path handles the absent groundingContext gracefully.
  }

  // FIX-T20-2: Include retrieved chunks in the model prompt so the first-pass
  // answer is grounded (pre-Task-19 pattern). groundingContext still carries the
  // same source for the post-check — both paths see the chunks.
  const userContent: Array<{ text: string }> = [{ text: question }];
  if (groundingSource) {
    userContent.push({ text: `\nRelevant ISO 14001 clauses:\n${groundingSource}` });
  }

  const response = await invokeFn({
    seat: 'guru-14001',
    system: ISO14001_GURU_PROMPT,
    messages: [{ role: 'user', content: userContent }],
    tools: [],
    tenantId,
    agent: 'ISO14001Guru',
    module: 'advisory',
    feature: 'clause-qa',
    // Task 19 step 5: locale + standard threaded (FIX-V3)
    locale: locale ?? 'en',
    standard: 'ISO14001',
    // groundingContext: present when retrieval succeeded → triggers L1 grounding check
    ...(groundingSource && {
      groundingContext: {
        source: groundingSource,
        query: truncatedQuery,
      },
    }),
  });

  return response.text || 'Unable to generate a response.';
}

/**
 * AppSync direct-Lambda-resolver entrypoint.
 * - question comes from event.arguments (schema: askISO14001).
 * - tenantId comes ONLY from the Lambda authorizer's resolverContext (verified
 *   claim) — NEVER from client arguments. Fail-closed if absent.
 */
interface AppSyncGuruEvent {
  arguments: { question: string; locale?: string };
  identity?: { resolverContext?: { tenantId?: string } };
}

export async function handler(event: AppSyncGuruEvent): Promise<string> {
  const tenantId = event.identity?.resolverContext?.tenantId;
  if (!tenantId) {
    throw new Error('Unauthorized: missing tenantId in resolver context');
  }
  const locale = (event.arguments.locale as 'en' | 'es' | 'pt') ?? undefined;
  return handleQuery(tenantId, event.arguments.question, locale);
}
