/**
 * LeadAuditor agent handler — SQS consumer (LeadAuditorQueue, standard).
 * Owns M3 Audit Studio: plans audits, generates checklists, records findings.
 *
 * Flow: SQS event → retrieve ISO KB + tenant docs (AOSS) → tool-loop (Converse) →
 * HITL gate on audit-finding-write/audit-checklist-gen → approval → ExecuteWriteback → audit.
 */

import { createHandler } from '../../eventing/src/consumer.js';
import { toolLoop } from '../shared/tool-loop.js';
import type { ContentBlock } from '../../ai-invoker/src/types.js';
import { createInvokeFn, createEmbedFn } from '../shared/invoke-transport.js';
import { retrieve } from '../shared/retrieval.js';
import type { CumplifyEvent } from '../../eventing/src/types.js';
import type { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import { ISO_CANON_TENANT_ID } from '../shared/constants.js';
import { LEAD_AUDITOR_PROMPT } from './prompt.js';
import { LEAD_AUDITOR_TOOLS } from './tools.js';

const DLQ_URL = process.env.LEAD_AUDITOR_DLQ_URL!;
const AOSS_ISO_KB_ENDPOINT = process.env.AOSS_ISO_KB_ENDPOINT!;
const AOSS_TENANT_DOCS_ENDPOINT = process.env.AOSS_TENANT_DOCS_ENDPOINT!;

const HITL_TOOLS = new Set(['audit-finding-write', 'audit-checklist-gen']);
const invokeFn = createInvokeFn();
const embedFn = createEmbedFn();

/**
 * S4: real Titan embeddings + canon-tenant iso-kb + allSettled legs (the
 * S2.1/S2.2 lessons applied at build time, not found live). tenant-docs
 * 404s until its indexer exists — degrades to an empty leg.
 */
async function retrieveGrounding(tenantId: string, text: string): Promise<string> {
  try {
    const { embedding } = await embedFn({
      tenantId,
      agent: 'LeadAuditor',
      module: 'M3',
      feature: 'audit-findings',
      text,
    });
    const [isoResults, tenantResults] = await Promise.allSettled([
      retrieve({
        tenantId: ISO_CANON_TENANT_ID,
        collectionEndpoint: AOSS_ISO_KB_ENDPOINT,
        indexName: 'cumplify-iso-kb',
        queryText: text,
        queryVector: embedding,
        topK: 3,
      }),
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

  // S2.1 lesson: event payloads carry tenant-typed text → guardedText; the
  // trusted framing and KB grounding stay out of PROMPT_ATTACK evaluation.
  const content: ContentBlock[] = [
    {
      text: `An audit task has been raised. Analyze and take appropriate action.\nEvent payload (tenant data):`,
    },
    { guardedText: JSON.stringify(event.payload) },
    ...(groundingContext ? [{ text: `\nRelevant context:\n${groundingContext}` }] : []),
  ];

  await toolLoop([{ role: 'user', content }], {
    seat: 'workhorse',
    systemPrompt: LEAD_AUDITOR_PROMPT,
    tools: LEAD_AUDITOR_TOOLS,
    tenantId,
    agent: 'LeadAuditor',
    module: 'M3',
    feature: 'audit-studio',
    hitlTools: HITL_TOOLS,
    invokeFn,
    dispatchTool: async (toolName, input, tid) => {
      return { output: { toolName, input, tenantId: tid }, requiresHitl: false };
    },
  });
}

const sqsHandler = createHandler({
  dlqUrl: DLQ_URL,
  handler: processEvent,
});

// ─── S4 direct-invoke path (runAuditFindings) ───────────────────────────────

export interface RunFindingsInput {
  tenantId: string;
  runId: string;
  requestedBy: string;
  findingsIntent: {
    auditId: string;
    audit: { standard?: string; scope?: string; status?: string };
    checklist: Array<{ clauseRef?: string; question?: string; expectedEvidence?: string }>;
    priorFindings: Array<{ findingType?: string; clauseRef?: string; description?: string }>;
  };
}

export interface RunFindingsResult {
  runId: string;
  status: string;
}

/**
 * S4: LeadAuditor reviews the audit's checklist + prior findings and
 * proposes the MOST SIGNIFICANT new finding via audit-finding-write. The
 * resolver read everything; this agent never touches the DB. Approving a
 * major/minor NC finding also opens the NC in CAPA Studio (writeback link).
 */
export async function runAuditFindings(input: RunFindingsInput): Promise<RunFindingsResult> {
  const { tenantId, requestedBy, findingsIntent } = input;
  const { auditId, audit, checklist, priorFindings } = findingsIntent;

  const checklistLines =
    checklist
      .map(
        (c) =>
          `- [${c.clauseRef ?? '?'}] ${c.question ?? ''} (evidence: ${c.expectedEvidence ?? 'unspecified'})`,
      )
      .join('\n') || '(no checklist yet — generate one first for stronger evidence)';
  const priorLines =
    priorFindings
      .map((f) => `- ${f.findingType ?? '?'} [${f.clauseRef ?? '?'}]: ${f.description ?? ''}`)
      .join('\n') || '(none)';

  const groundingContext = await retrieveGrounding(
    tenantId,
    `${audit.standard ?? ''} audit ${audit.scope ?? ''} ${checklist
      .slice(0, 5)
      .map((c) => c.clauseRef)
      .join(' ')}`,
  );

  // S2.1 lesson (found live AGAIN on the S4 witness, guardrail_intervened at
  // turn 0): scope/checklist/prior findings are tenant-typed → guardedText;
  // only the trusted FINDINGS-MODE framing and KB grounding ride plain.
  const preamble = [
    `FINDINGS MODE. Review this audit's state and propose the MOST SIGNIFICANT`,
    `NEW finding via audit-finding-write, exactly once.`,
    `auditId: ${auditId}`,
    `Audit: standard=${audit.standard ?? '?'} status=${audit.status ?? '?'}`,
    `\nAudit scope (tenant-entered):`,
  ].join('\n');
  const content: ContentBlock[] = [
    { text: preamble },
    { guardedText: audit.scope ?? '?' },
    { text: `\nChecklist (tenant-entered):` },
    { guardedText: checklistLines },
    { text: `\nPrior findings (do NOT duplicate them):` },
    { guardedText: priorLines },
    ...(groundingContext ? [{ text: `\nRelevant context:\n${groundingContext}` }] : []),
  ];

  const result = await toolLoop([{ role: 'user', content }], {
    seat: 'workhorse',
    systemPrompt: LEAD_AUDITOR_PROMPT,
    tools: LEAD_AUDITOR_TOOLS,
    tenantId,
    agent: 'LeadAuditor',
    module: 'M3',
    feature: 'audit-findings',
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

/**
 * Entry point — dispatches on event shape (capa-guru/doc-studio precedent):
 * SQS delivers {Records}; the S4 payload alone carries `findingsIntent`.
 */
export async function handler(
  event: SQSEvent | RunFindingsInput,
): Promise<SQSBatchResponse | RunFindingsResult | void> {
  if ('Records' in event) {
    return sqsHandler(event);
  }
  return runAuditFindings(event);
}
