/**
 * CAPAGuru agent handler — TWO entry points sharing the same tool-loop/
 * prompt/tools plumbing (same pattern as guru-9001's handleQuery/handler
 * split): the ORIGINAL SQS consumer (CapaIntakeQueue, FIFO, event-triggered
 * NC intake) and a NEW direct-invoke path (RS-8, read-surface-completion —
 * m2.ts's runCapaAnalysis resolver invokes this Lambda by ARN with a plain
 * JSON payload, not an SQS event). Lambda always calls whatever `handler`
 * is configured as the function's entry point regardless of trigger type,
 * so `handler` dispatches on event shape: `'Records' in event` -> SQS path
 * (unchanged); else -> the new stage-aware direct path.
 *
 * Flow (either path): context (event payload or runCapaAnalysis's RDS
 * fetch) -> tool-loop (Converse, stage-aware prompt picks the NEXT
 * unresolved CAPA-shall-workflow stage) -> HITL gate on mutating tools
 * (nc-triage-write / capa-open / capa-verify-effectiveness) -> approval ->
 * ExecuteWriteback -> audit.
 *
 * Uses: createFifoHandler (eventing consumer lib), toolLoop (shared), retrieve (shared).
 * Calls AI Invoker via lambda:InvokeFunction (AgentHandlerReadOnlyPolicy).
 */

import type { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import { createFifoHandler } from '../../eventing/src/consumer.js';
import { toolLoop } from '../shared/tool-loop.js';
import { createInvokeFn, createEmbedFn } from '../shared/invoke-transport.js';
import { retrieve } from '../shared/retrieval.js';
import type { CumplifyEvent } from '../../eventing/src/types.js';
import type { ContentBlock } from '../../ai-invoker/src/types.js';
import { CAPA_GURU_PROMPT } from './prompt.js';
import { CAPA_GURU_TOOLS } from './tools.js';

const DLQ_URL = process.env.DLQ_URL!;
const AOSS_ENDPOINT = process.env.AOSS_NC_HISTORY_ENDPOINT!;

const HITL_TOOLS = new Set([
  'nc-draft-write',
  'nc-triage-write',
  'rca-write',
  'capa-open',
  'capa-verify-effectiveness',
]);
const invokeFn = createInvokeFn();
const embedFn = createEmbedFn();

async function processEvent(event: CumplifyEvent, _detailType: string): Promise<void> {
  const { tenantId } = event;
  const ncDescription = ((event.payload as Record<string, unknown>).description as string) ?? '';

  // Retrieve similar past NCs for grounding (REQ-RET-6)
  let groundingContext = '';
  if (ncDescription) {
    try {
      // S2.1: real Titan embedding via the one-door embed path (guru-9001
      // precedent) — replaces the constant placeholder vector. Inside the
      // try: embed failure degrades to no-grounding, never blocks analysis.
      const { embedding } = await embedFn({
        tenantId,
        agent: 'CAPAGuru',
        module: 'M2',
        feature: 'capa-intake',
        text: ncDescription,
      });
      const results = await retrieve({
        tenantId,
        collectionEndpoint: AOSS_ENDPOINT,
        indexName: 'cumplify-nc-history',
        queryText: ncDescription,
        queryVector: embedding,
        topK: 3,
      });
      groundingContext = results.chunks.map((c) => c.text).join('\n---\n');
    } catch {
      // AOSS retrieval failure is non-blocking for CAPAGuru — proceed without grounding
    }
  }

  // Build initial message with event context + grounding
  const userMessage = [
    `A nonconformity has been raised. Analyze and propose a corrective action.`,
    `\nEvent: ${JSON.stringify(event.payload)}`,
    groundingContext ? `\nSimilar past NCs for reference:\n${groundingContext}` : '',
  ].join('');

  // Tool-loop: may invoke Converse multiple times, dispatch tools, enter HITL gate
  await toolLoop([{ role: 'user', content: [{ text: userMessage }] }], {
    seat: 'workhorse',
    systemPrompt: CAPA_GURU_PROMPT,
    tools: CAPA_GURU_TOOLS,
    tenantId,
    agent: 'CAPAGuru',
    module: 'M2',
    feature: 'capa-intake',
    hitlTools: HITL_TOOLS,
    invokeFn,
    dispatchTool: async (toolName, input, tid) => {
      // Non-HITL tools execute directly (read-only / advisory)
      // HITL tools are caught by the tool-loop and routed to the gate
      return { output: { toolName, input, tenantId: tid }, requiresHitl: false };
    },
  });
}

const sqsHandler = createFifoHandler({
  fifo: true,
  dlqUrl: DLQ_URL,
  handler: processEvent,
  idempotentErrors: [],
});

// ─── RS-8 direct-invoke path (runCapaAnalysis) ──────────────────────────────

export interface CapaAnalysisContext {
  nc: {
    description: string;
    ncType: string;
    severity: string;
    standard: 'ISO9001' | 'ISO14001' | 'ISO45001';
    status: string;
  };
  correctiveActions: Array<{ id: string; actionDesc: string; status: string; ownerId: string }>;
}

export interface RunAnalysisInput {
  tenantId: string;
  runId: string;
  ncId: string;
  /** RS-8 SOD-1: the human who clicked "AI: draft this" — threaded to enterHitlGate. */
  requestedBy: string;
  context: CapaAnalysisContext;
}

export interface RunAnalysisResult {
  runId: string;
  status: string;
}

export async function runCapaAnalysis(input: RunAnalysisInput): Promise<RunAnalysisResult> {
  const { tenantId, ncId, requestedBy, context } = input;

  const caSummary =
    context.correctiveActions.length > 0
      ? context.correctiveActions
          .map(
            (ca) => `  - ${ca.id}: "${ca.actionDesc}" (status=${ca.status}, owner=${ca.ownerId})`,
          )
          .join('\n')
      : '  (none yet)';

  const userMessage = [
    `Analyze this nonconformity's CURRENT state and act on its NEXT unresolved CAPA shall-workflow stage only.`,
    `\nNC ID: ${ncId}`,
    `Standard: ${context.nc.standard}`,
    `Current classification: ${context.nc.ncType}`,
    `Severity: ${context.nc.severity}`,
    `NC status: ${context.nc.status}`,
    `Description: ${context.nc.description}`,
    `\nExisting corrective actions:\n${caSummary}`,
  ].join('\n');

  const result = await toolLoop([{ role: 'user', content: [{ text: userMessage }] }], {
    seat: 'workhorse',
    systemPrompt: CAPA_GURU_PROMPT,
    tools: CAPA_GURU_TOOLS,
    tenantId,
    agent: 'CAPAGuru',
    module: 'M2',
    feature: 'capa-analysis',
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

// ─── S1 intake path (runNcIntake) ───────────────────────────────────────────

export interface RunIntakeInput {
  tenantId: string;
  runId: string;
  /** S1 SOD-1: the human who submitted the problem report. */
  requestedBy: string;
  intake: {
    description: string;
    evidenceNote?: string;
  };
}

/**
 * Stage-1 intake: a raw problem report, no NC exists yet. CAPAGuru
 * classifies, identifies the governing clause, sets severity/source and
 * proposes the full NC via the nc-draft-write HITL tool — the human
 * approver reviews (and can edit) every field before the NC is created.
 */
export async function runNcIntake(input: RunIntakeInput): Promise<RunAnalysisResult> {
  const { tenantId, requestedBy, intake } = input;

  // S2.1: selective guardrail evaluation — only the reporter-typed text rides
  // in guardedText; the trusted INTAKE-MODE framing stays out of PROMPT_ATTACK
  // evaluation (same fix as DocStudio's runDocDraft, found live 2026-07-22).
  const preamble = [
    `INTAKE MODE. A raw problem report follows — no nonconformity exists yet.`,
    `Draft the NC via nc-draft-write (classify, identify the governing clause,`,
    `set severity and source, rewrite the description audit-ready).`,
    `\nProblem report (user-entered):`,
  ].join('\n');
  const content: ContentBlock[] = [
    { text: preamble },
    { guardedText: intake.description },
    ...(intake.evidenceNote
      ? [{ text: `Reporter's evidence note (user-entered):` }, { guardedText: intake.evidenceNote }]
      : []),
  ];

  const result = await toolLoop([{ role: 'user', content }], {
    seat: 'workhorse',
    systemPrompt: CAPA_GURU_PROMPT,
    tools: CAPA_GURU_TOOLS,
    tenantId,
    agent: 'CAPAGuru',
    module: 'M2',
    feature: 'capa-intake',
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
 * Lambda entry point — dispatches on event shape. SQS always delivers
 * {Records: [...]}; runCapaAnalysis's direct invoke never does; the S1
 * intake payload is the only shape carrying `intake`.
 */
// ─── C1 RCA path (runRootCauseAnalysis) ─────────────────────────────────────

export interface RunRcaInput {
  tenantId: string;
  runId: string;
  requestedBy: string;
  rcaIntent: {
    ncId: string;
    /** DB value: 5why | fishbone | fta */
    method: string;
    nc: {
      standard?: string;
      source?: string;
      ncType?: string;
      description?: string;
      clauseRef?: string;
      severity?: string;
    };
  };
}

/**
 * C1 (owner directive 2026-07-22): structured root-cause analysis on an
 * existing NC — 5 Whys / Ishikawa fishbone / fault tree — proposed via the
 * rca-write HITL tool. The resolver read the NC; this agent never touches
 * the DB. The NC description is reporter-typed → guardedText (S2.1 lesson);
 * similar past NCs ground the causes when retrieval returns any.
 */
export async function runRootCauseAnalysis(input: RunRcaInput): Promise<RunAnalysisResult> {
  const { tenantId, requestedBy, rcaIntent } = input;
  const { ncId, method, nc } = rcaIntent;

  // Ground in similar past NCs (nc-history) — non-blocking, VPC path (S2.1)
  let groundingContext = '';
  if (nc.description) {
    try {
      const { embedding } = await embedFn({
        tenantId,
        agent: 'CAPAGuru',
        module: 'M2',
        feature: 'rca',
        text: nc.description,
      });
      const results = await retrieve({
        tenantId,
        collectionEndpoint: AOSS_ENDPOINT,
        indexName: 'cumplify-nc-history',
        queryText: nc.description,
        queryVector: embedding,
        topK: 3,
      });
      groundingContext = results.chunks.map((c) => c.text).join('\n---\n');
    } catch {
      /* retrieval failure is non-blocking */
    }
  }

  const preamble = [
    `RCA MODE. Perform a root-cause analysis on an EXISTING nonconformity`,
    `via rca-write, using EXACTLY the requested method.`,
    `ncId: ${ncId}`,
    `Requested method: ${method}`,
    `NC facts: standard=${nc.standard ?? '?'} clause=${nc.clauseRef ?? '?'} severity=${nc.severity ?? '?'} source=${nc.source ?? '?'} type=${nc.ncType ?? '?'}`,
    `\nNC description (reporter-entered):`,
  ].join('\n');
  const content: ContentBlock[] = [
    { text: preamble },
    { guardedText: nc.description ?? '' },
    ...(groundingContext ? [{ text: `Similar past NCs for reference:\n${groundingContext}` }] : []),
  ];

  const result = await toolLoop([{ role: 'user', content }], {
    seat: 'workhorse',
    systemPrompt: CAPA_GURU_PROMPT,
    tools: CAPA_GURU_TOOLS,
    tenantId,
    agent: 'CAPAGuru',
    module: 'M2',
    feature: 'rca',
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

export async function handler(
  event: SQSEvent | RunAnalysisInput | RunIntakeInput | RunRcaInput,
): Promise<SQSBatchResponse | RunAnalysisResult> {
  if ('Records' in event) {
    return sqsHandler(event);
  }
  if ('intake' in event) {
    return runNcIntake(event);
  }
  if ('rcaIntent' in event) {
    return runRootCauseAnalysis(event);
  }
  return runCapaAnalysis(event);
}
