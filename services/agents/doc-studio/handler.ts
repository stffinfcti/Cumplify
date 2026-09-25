/**
 * DocStudio agent handler — SQS consumer (DocStudioQueue, standard) + the
 * S2 direct-invoke drafting path (runDocDraft).
 * Owns M1 Document Studio: drafts, versions, and publishes IMS documents.
 *
 * SQS flow: event → retrieve ISO KB + tenant docs (AOSS) → tool-loop →
 * HITL gate on doc-draft/doc-version-control/doc-publish → approval →
 * ExecuteWriteback → audit.
 * Direct-invoke flow (S2): m1's runDocDraft resolver Event-invokes this
 * Lambda by deterministic name with a `draftIntent` payload; DocStudio
 * drafts the COMPLETE document and proposes it via doc-draft.
 */

import { createHandler } from '../../eventing/src/consumer.js';
import { toolLoop } from '../shared/tool-loop.js';
import { createInvokeFn, createEmbedFn } from '../shared/invoke-transport.js';
import { retrieve } from '../shared/retrieval.js';
import type { CumplifyEvent } from '../../eventing/src/types.js';
import type { ContentBlock } from '../../ai-invoker/src/types.js';
import type { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import { ISO_CANON_TENANT_ID } from '../shared/constants.js';
import { DOC_STUDIO_PROMPT } from './prompt.js';
import { assertTenantIdSafe } from '../../api/src/resolvers/shared.js';
import { DOC_STUDIO_TOOLS } from './tools.js';

const DLQ_URL = process.env.DOC_STUDIO_DLQ_URL!;
const AOSS_ISO_KB_ENDPOINT = process.env.AOSS_ISO_KB_ENDPOINT!;
const AOSS_TENANT_DOCS_ENDPOINT = process.env.AOSS_TENANT_DOCS_ENDPOINT!;

const HITL_TOOLS = new Set([
  'doc-draft',
  'manual-section-draft',
  'doc-publish',
  'doc-version-control',
]);
const invokeFn = createInvokeFn();
const embedFn = createEmbedFn();

async function retrieveGrounding(tenantId: string, text: string): Promise<string> {
  try {
    // S2.1: real Titan embedding via the one-door embed path (guru-9001
    // precedent). Inside the try — an embed failure degrades to no-grounding,
    // it never blocks the draft.
    const { embedding } = await embedFn({
      tenantId,
      agent: 'DocStudio',
      module: 'M1',
      feature: 'doc-draft',
      text,
    });
    // S2.2 (found live at the S2.1 witness readback): the two legs are
    // independent — allSettled, so a failing leg never discards the other's
    // chunks (Promise.all threw away a SUCCEEDED iso-kb result live).
    const [isoResults, tenantResults] = await Promise.allSettled([
      // ISO canon chunks are stored under the canon tenant (guru precedent) —
      // filtering iso-kb by the caller's tenantId guarantees 0 results.
      retrieve({
        tenantId: ISO_CANON_TENANT_ID,
        collectionEndpoint: AOSS_ISO_KB_ENDPOINT,
        indexName: 'cumplify-iso-kb',
        queryText: text,
        queryVector: embedding,
        topK: 3,
      }),
      // Tenant docs ARE tenant-scoped. No indexer writes this index yet —
      // it 404s until the first tenant document is indexed (roadmap), which
      // allSettled degrades to an empty leg.
      retrieve({
        tenantId,
        collectionEndpoint: AOSS_TENANT_DOCS_ENDPOINT,
        indexName: 'cumplify-tenant-docs',
        queryText: text,
        queryVector: embedding,
        topK: 3,
      }),
    ]);
    const isoContext =
      isoResults.status === 'fulfilled'
        ? isoResults.value.chunks.map((c) => c.text).join('\n---\n')
        : '';
    const tenantContext =
      tenantResults.status === 'fulfilled'
        ? tenantResults.value.chunks.map((c) => c.text).join('\n---\n')
        : '';
    return [isoContext, tenantContext].filter(Boolean).join('\n===\n');
  } catch {
    // Retrieval failure is non-blocking
    return '';
  }
}

async function processEvent(event: CumplifyEvent, _detailType: string): Promise<void> {
  const { tenantId } = event;
  const description = ((event.payload as Record<string, unknown>).description as string) ?? '';

  const groundingContext = description ? await retrieveGrounding(tenantId, description) : '';

  const userMessage = [
    `A document task has been raised. Analyze and take appropriate action.`,
    `\nEvent: ${JSON.stringify(event.payload)}`,
    groundingContext ? `\nRelevant context:\n${groundingContext}` : '',
  ].join('');

  await toolLoop([{ role: 'user', content: [{ text: userMessage }] }], {
    seat: 'workhorse',
    systemPrompt: DOC_STUDIO_PROMPT,
    tools: DOC_STUDIO_TOOLS,
    tenantId,
    agent: 'DocStudio',
    module: 'M1',
    feature: 'document-studio',
    hitlTools: HITL_TOOLS,
    invokeFn,
    dispatchTool: async (toolName, input, tid) => {
      return { output: { toolName, input, tenantId: tid }, requiresHitl: false };
    },
  });
}

// ─── S2 direct-invoke drafting path (runDocDraft) ───────────────────────────

export interface RunDocDraftInput {
  tenantId: string;
  runId: string;
  /** S2 SOD-1: the human who described the document — cannot approve the draft. */
  requestedBy: string;
  draftIntent: {
    intent: string;
    docType?: string;
    standard?: string;
    /** S2.3: current org profile — the draft names the tenant, never "[Organization Name]" */
    orgProfile?: Record<string, unknown>;
  };
}

export interface RunDocDraftResult {
  runId: string;
  status: string;
}

export async function runDocDraft(input: RunDocDraftInput): Promise<RunDocDraftResult> {
  const { tenantId, requestedBy, draftIntent } = input;
  assertTenantIdSafe(tenantId);

  const groundingContext = await retrieveGrounding(tenantId, draftIntent.intent);

  // S2.1: selective guardrail evaluation — ONLY the tenant-entered intent
  // rides in guardedText (PROMPT_ATTACK evaluates just that block). With no
  // guardContent block, Bedrock evaluates the WHOLE message as untrusted
  // input, and this trusted DRAFT-MODE framing itself trips PROMPT_ATTACK
  // (live 2026-07-22: "Guardrail intervened on input" at the S2 UI witness).
  const preamble = [
    `DRAFT MODE. The user needs a NEW controlled document — draft it WHOLE`,
    `via doc-draft (title, governing clauses, complete section prose).`,
    ...(draftIntent.docType ? [`Requested docType: ${draftIntent.docType}`] : []),
    ...(draftIntent.standard ? [`Requested standard: ${draftIntent.standard}`] : []),
    `\nRequested document (user-entered):`,
  ].join('\n');
  const content: ContentBlock[] = [
    { text: preamble },
    { guardedText: draftIntent.intent },
    // S2.3: the tenant's profile grounds the draft — write the real legal
    // name, sites, and processes; "[Organization Name]" shipped on a live
    // card before this. Tenant-typed → guardedText (S2.1 lesson).
    ...(draftIntent.orgProfile
      ? [
          { text: `Organization profile (ground truth — never contradict it; tenant-entered):` },
          { guardedText: JSON.stringify(draftIntent.orgProfile) },
        ]
      : []),
    ...(groundingContext ? [{ text: `Relevant context:\n${groundingContext}` }] : []),
  ];

  const result = await toolLoop([{ role: 'user', content }], {
    seat: 'workhorse',
    systemPrompt: DOC_STUDIO_PROMPT,
    tools: DOC_STUDIO_TOOLS,
    tenantId,
    agent: 'DocStudio',
    module: 'M1',
    feature: 'doc-draft',
    hitlTools: HITL_TOOLS,
    requestedBy,
    invokeFn,
    dispatchTool: async (toolName, toolInput, tid) => ({
      output: { toolName, input: toolInput, tenantId: tid },
      requiresHitl: false,
    }),
  });

  return {
    runId: input.runId,
    status: result.hitlResult ? 'PENDING_APPROVAL' : 'NO_PROPOSAL',
  };
}

export interface RunSectionDraftInput {
  tenantId: string;
  runId: string;
  requestedBy: string;
  sectionDraftIntent: {
    generationRunId: string;
    harmonizationKey: string;
    sectionKind: string;
    clauses: Array<{
      standard?: string;
      clauseNo?: string;
      clauseTitle?: string;
      intentParaphrase?: string;
      requiredSources?: unknown;
    }>;
    orgProfile: Record<string, unknown>;
  };
}

/**
 * S3 Manual Studio: draft prose for ONE generation-run section. The resolver
 * already read the run's pinned org profile + the section's clause intents —
 * they arrive in the payload; this agent never touches the DB. The org
 * profile carries tenant-typed free text, so it rides in guardedText
 * (selective PROMPT_ATTACK evaluation — the S2.1 lesson: with no
 * guardContent block the trusted SECTION-MODE framing itself gets evaluated
 * as untrusted input and tripped the guardrail live).
 */
export async function runSectionDraft(input: RunSectionDraftInput): Promise<RunDocDraftResult> {
  const { tenantId, requestedBy, sectionDraftIntent } = input;
  assertTenantIdSafe(tenantId);
  const { generationRunId, harmonizationKey, sectionKind, clauses, orgProfile } =
    sectionDraftIntent;

  const clauseLines = clauses
    .map(
      (c) =>
        `- ${c.standard ?? ''} ${c.clauseNo ?? ''} ${c.clauseTitle ?? ''}: ${c.intentParaphrase ?? ''}`,
    )
    .join('\n');

  const groundingContext = await retrieveGrounding(
    tenantId,
    `${harmonizationKey} ${clauses.map((c) => `${c.clauseNo} ${c.clauseTitle}`).join(' ')}`,
  );

  const preamble = [
    `SECTION MODE. Draft prose for ONE section of the generated IMS manual`,
    `via manual-section-draft.`,
    `generationRunId: ${generationRunId}`,
    `harmonizationKey: ${harmonizationKey}`,
    `Current section state: ${sectionKind}`,
    `\nClause intents this section must answer:\n${clauseLines || '(none on record)'}`,
    `\nOrganization profile (ground truth — never contradict it; tenant-entered):`,
  ].join('\n');
  const content: ContentBlock[] = [
    { text: preamble },
    { guardedText: JSON.stringify(orgProfile) },
    ...(groundingContext ? [{ text: `Relevant context:\n${groundingContext}` }] : []),
  ];

  const result = await toolLoop([{ role: 'user', content }], {
    seat: 'workhorse',
    systemPrompt: DOC_STUDIO_PROMPT,
    tools: DOC_STUDIO_TOOLS,
    tenantId,
    agent: 'DocStudio',
    module: 'M1',
    feature: 'manual-section-draft',
    hitlTools: HITL_TOOLS,
    requestedBy,
    invokeFn,
    dispatchTool: async (toolName, toolInput, tid) => ({
      output: { toolName, input: toolInput, tenantId: tid },
      requiresHitl: false,
    }),
  });

  return {
    runId: input.runId,
    status: result.hitlResult ? 'PENDING_APPROVAL' : 'NO_PROPOSAL',
  };
}

const sqsHandler = createHandler({
  dlqUrl: DLQ_URL,
  handler: processEvent,
});

/**
 * Lambda entry point — dispatches on event shape (capa-guru precedent):
 * SQS always delivers {Records}; the S2 draft payload alone carries
 * `draftIntent`; the S3 section payload alone carries `sectionDraftIntent`.
 */
export async function handler(
  event: SQSEvent | RunDocDraftInput | RunSectionDraftInput,
): Promise<SQSBatchResponse | RunDocDraftResult | void> {
  if ('Records' in event) {
    return sqsHandler(event);
  }
  if ('sectionDraftIntent' in event) {
    return runSectionDraft(event);
  }
  return runDocDraft(event);
}
