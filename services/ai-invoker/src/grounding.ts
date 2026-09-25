/**
 * Contextual grounding check module — spec-35 L1.
 *
 * Post-response ApplyGuardrail call with qualifiers:
 * - grounding_source: retrieved chunks (≤100k chars)
 * - query: user question (≤1,000 chars)
 * - unqualified: response content to guard (≤5k chars per section)
 *
 * Returns numeric scores for HITL cards + pass/blocked verdict.
 */

import {
  BedrockRuntimeClient,
  ApplyGuardrailCommand,
  type ApplyGuardrailCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';
import { Logger } from '@aws-lambda-powertools/logger';
import type { GuardrailConfig } from './guardrail.js';

const logger = new Logger({ serviceName: 'ai-invoker-grounding' });

/** Singleton client */
let client: BedrockRuntimeClient | null = null;
function getClient(): BedrockRuntimeClient {
  if (!client) {
    client = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
  }
  return client;
}

/** Reset client (for testing) */
export function resetGroundingClient(): void {
  client = null;
}

// ─── API Caps (§0.3, M-3) ──────────────────────────────────────────────────

const MAX_SOURCE_CHARS = 100_000;
const MAX_QUERY_CHARS = 1_000;
const MAX_SECTION_CHARS = 5_000;
const FALLBACK_CHUNK_SIZE = 4_000;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface GroundingContext {
  source: string; // concatenated retrieval chunks (≤100k)
  query: string;  // user question (≤1,000)
}

export interface GroundingResult {
  verdict: 'pass' | 'blocked';
  groundingScore: number;
  relevanceScore: number;
}

export interface Citation {
  clauseRef: string;
  sourceChunk: string;
  score: number;
}

// ─── Validation (M-3) ──────────────────────────────────────────────────────

/**
 * Validate and truncate grounding context to API caps.
 * Mutates nothing — returns a sanitized copy.
 */
export function validateGroundingContext(ctx: GroundingContext): GroundingContext {
  let source = ctx.source;
  let query = ctx.query;

  if (source.length > MAX_SOURCE_CHARS) {
    logger.warn('Grounding source exceeds 100k chars, truncating', {
      originalLength: source.length,
    });
    source = source.slice(0, MAX_SOURCE_CHARS);
  }

  if (query.length > MAX_QUERY_CHARS) {
    // Truncate at word boundary
    const truncated = query.slice(0, MAX_QUERY_CHARS);
    const lastSpace = truncated.lastIndexOf(' ');
    query = lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated;
    logger.warn('Grounding query exceeds 1,000 chars, truncated at word boundary', {
      originalLength: ctx.query.length,
      truncatedLength: query.length,
    });
  }

  return { source, query };
}

// ─── Section Splitting (L1-6, INV-4) ────────────────────────────────────────

/**
 * Split response text into sections for grounding checks.
 * Primary: markdown headers (## / ###). Fallback: 4,000-char paragraph chunks.
 */
export function splitForGroundingCheck(text: string): string[] {
  if (text.length <= MAX_SECTION_CHARS) return [text];

  // Primary: split on ## or ### headers — but a single mega-section under one
  // header still blows past MAX_SECTION_CHARS, so re-chunk any oversized
  // piece (and hard-split paragraphs that overflow a chunk on their own).
  const headerSections = text.split(/(?=^#{2,3}\s)/m).filter((s) => s.trim());
  const pieces = headerSections.length > 1 ? headerSections : [text];
  const out: string[] = [];
  for (const piece of pieces) {
    if (piece.length <= MAX_SECTION_CHARS) {
      out.push(piece);
      continue;
    }
    for (const chunk of chunkAtParagraphs(piece, FALLBACK_CHUNK_SIZE)) {
      if (chunk.length <= MAX_SECTION_CHARS) {
        out.push(chunk);
      } else {
        // Last resort: a paragraph longer than the cap — hard char split.
        for (let i = 0; i < chunk.length; i += MAX_SECTION_CHARS) {
          out.push(chunk.slice(i, i + MAX_SECTION_CHARS));
        }
      }
    }
  }
  return out;
}

/**
 * Chunk text at paragraph boundaries (\n\n), targeting chunkSize chars.
 */
export function chunkAtParagraphs(text: string, chunkSize: number): string[] {
  const paragraphs = text.split(/\n\n/);
  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > chunkSize && current.length > 0) {
      chunks.push(current.trim());
      current = para;
    } else {
      current += (current ? '\n\n' : '') + para;
    }
  }
  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks.length > 0 ? chunks : [text];
}

// ─── Grounding Check (§3.3) ────────────────────────────────────────────────

/**
 * Check grounding of a response section via ApplyGuardrail.
 * Uses qualifiers to pass grounding_source and query separately.
 */
export async function checkGrounding(params: {
  guardrailConfig: GuardrailConfig;
  groundingSource: string;
  query: string;
  content: string;
}): Promise<GroundingResult> {
  const startMs = Date.now();

  const response = await getClient().send(
    new ApplyGuardrailCommand({
      guardrailIdentifier: params.guardrailConfig.guardrailIdentifier,
      guardrailVersion: params.guardrailConfig.guardrailVersion,
      source: 'OUTPUT',
      content: [
        { text: { text: params.groundingSource, qualifiers: ['grounding_source'] } },
        { text: { text: params.query, qualifiers: ['query'] } },
        { text: { text: params.content } }, // unqualified = content to guard
      ],
    }),
  );

  const latencyMs = Date.now() - startMs;
  const result = parseGroundingResponse(response);

  logger.info('Grounding check complete', {
    verdict: result.verdict,
    groundingScore: result.groundingScore,
    relevanceScore: result.relevanceScore,
    latencyMs,
  });

  return result;
}

/**
 * Parse ApplyGuardrail response to extract grounding/relevance scores and verdict.
 *
 * FIX-V1: verdict is derived from the contextualGroundingPolicy FILTERS' own
 * `action === 'BLOCKED'` (grounding + relevance), NOT the top-level ApplyGuardrail
 * action. The top-level action is GUARDRAIL_INTERVENED whenever ANY policy fires
 * (e.g. PII anonymization on output) — reading it as a grounding block causes
 * false retries/honest-miss on legitimate answers that merely had PII masked.
 */
export function parseGroundingResponse(response: ApplyGuardrailCommandOutput): GroundingResult {
  // Extract scores and per-filter action from contextualGroundingPolicy assessments
  let groundingScore = 1.0;
  let relevanceScore = 1.0;
  let groundingBlocked = false;

  const assessments = response.assessments ?? [];
  for (const assessment of assessments) {
    const filters =
      (assessment as any).contextualGroundingPolicy?.filters ?? [];
    for (const filter of filters) {
      if (filter.type === 'GROUNDING') {
        if (typeof filter.score === 'number') groundingScore = filter.score;
        if (filter.action === 'BLOCKED') groundingBlocked = true;
      }
      if (filter.type === 'RELEVANCE') {
        if (typeof filter.score === 'number') relevanceScore = filter.score;
        if (filter.action === 'BLOCKED') groundingBlocked = true;
      }
    }
  }

  const verdict: 'pass' | 'blocked' = groundingBlocked ? 'blocked' : 'pass';
  return { verdict, groundingScore, relevanceScore };
}

// ─── Citation Construction (§4.3) ──────────────────────────────────────────

const CHUNK_DELIMITER = '\n---\n';
const CLAUSE_REF_REGEX = /\[ISO\s+(\d{4,5})\s+(\d+(?:\.\d+)*)\]/;
const MAX_CITATIONS = 5;
const CHUNK_PREVIEW_LENGTH = 200;

/**
 * Build citations from grounding source chunks post-check.
 * Splits source on delimiter, extracts clauseRef from metadata prefix,
 * assigns scores, returns top-N sorted by score.
 */
export function buildCitations(
  groundingSource: string,
  groundingScore: number,
): Citation[] {
  const chunks = groundingSource.split(CHUNK_DELIMITER).filter((c) => c.trim());
  const citations: Citation[] = [];

  for (const chunk of chunks) {
    const match = chunk.match(CLAUSE_REF_REGEX);
    const clauseRef = match ? `ISO ${match[1]} ${match[2]}` : '';

    citations.push({
      clauseRef,
      sourceChunk: chunk.slice(0, CHUNK_PREVIEW_LENGTH),
      score: groundingScore, // Per-chunk scoring requires multiple checks; use section score
    });
  }

  // Sort by score descending (for future per-chunk scoring), take top-N
  return citations
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CITATIONS);
}


// ─── Retry + Honest-Miss Flow (L1-7, L1-8) ─────────────────────────────────

import { publish } from '../../eventing/src/publisher.js';
import { getHonestMissTemplate } from './honest-miss.js';

export interface GroundingFlowResult {
  /** The final response text (original, retried, or honest-miss template) */
  text: string;
  /** Whether the response was replaced with honest-miss */
  isHonestMiss: boolean;
  /** Whether the grounding check flagged this response (passed on retry) */
  flagged: boolean;
  /** Grounding score from the final check */
  groundingScore: number;
  /** Relevance score from the final check */
  relevanceScore: number;
  /** Built citations */
  citations: Citation[];
}

/**
 * Full grounding flow: check all sections → retry on block → honest-miss on double-fail.
 * L1-7: retry once with chunks + "answer only from source" instruction.
 * L1-8: on second failure, replace with honest-miss template + emit event.
 */
export async function runGroundingFlow(params: {
  guardrailConfig: GuardrailConfig;
  groundingContext: GroundingContext;
  responseText: string;
  locale?: string;
  /** ISO standard for event attribution (FIX-V3, defaults 'ISO9001') */
  standard?: 'ISO9001' | 'ISO14001' | 'ISO45001';
  /** For event attribution */
  tenantId: string;
  agent: string;
  module: string;
}): Promise<GroundingFlowResult> {
  const { guardrailConfig, groundingContext, responseText } = params;
  const validCtx = validateGroundingContext(groundingContext);

  // Split response into sections for checking
  const sections = splitForGroundingCheck(responseText);

  // Check each section
  let worstGrounding = 1.0;
  let worstRelevance = 1.0;
  let anyBlocked = false;

  for (const section of sections) {
    const startMs = Date.now();
    const result = await checkGrounding({
      guardrailConfig,
      groundingSource: validCtx.source,
      query: validCtx.query,
      content: section,
    });
    const latencyMs = Date.now() - startMs;

    // FIX-V2: Emit Ai.GuardrailChecked per section check (TEL-1)
    await publish({
      busName: process.env.BUS_NAME ?? 'cumplify-events',
      source: 'cumplify.ai-invoker',
      detailType: 'Ai.GuardrailChecked',
      event: {
        tenantId: params.tenantId,
        timestamp: new Date().toISOString(),
        actor: params.agent,
        module: params.module,
        clauseRef: '',
        standard: params.standard ?? 'ISO9001',
        entityId: '',
        payload: {
          guardrailPolicy: 'grounding',
          verdict: result.verdict,
          groundingScore: result.groundingScore,
          relevanceScore: result.relevanceScore,
          latencyMs,
        },
      },
    });

    if (result.groundingScore < worstGrounding) worstGrounding = result.groundingScore;
    if (result.relevanceScore < worstRelevance) worstRelevance = result.relevanceScore;
    if (result.verdict === 'blocked') anyBlocked = true;
  }

  // All sections passed — return with evidence
  if (!anyBlocked) {
    return {
      text: responseText,
      isHonestMiss: false,
      flagged: false,
      groundingScore: worstGrounding,
      relevanceScore: worstRelevance,
      citations: buildCitations(validCtx.source, worstGrounding),
    };
  }

  // Blocked — this is the FIRST failure. The retry happens at the orchestration
  // layer (invoke() re-calls converse with grounding injection). This function
  // is called AGAIN on the retry response. If called a second time and still
  // blocked, we emit the event and return honest-miss.
  // To handle this cleanly, the caller (invoke orchestration) manages the retry
  // loop and calls this function with a `retryAttempt` flag. For now, this function
  // returns the blocked state and the orchestration decides.
  return {
    text: responseText,
    isHonestMiss: false,
    flagged: true, // grounding below threshold
    groundingScore: worstGrounding,
    relevanceScore: worstRelevance,
    citations: buildCitations(validCtx.source, worstGrounding),
  };
}

/**
 * Emit Ai.GroundingBlocked event and return the honest-miss template.
 * Called by the orchestration layer after retry also fails.
 */
export async function emitGroundingBlockedAndHonestMiss(params: {
  tenantId: string;
  agent: string;
  module: string;
  groundingScore: number;
  relevanceScore: number;
  locale?: string;
  /** ISO standard for event attribution (FIX-V3, defaults 'ISO9001') */
  standard?: 'ISO9001' | 'ISO14001' | 'ISO45001';
}): Promise<string> {
  const { tenantId, agent, module, groundingScore, relevanceScore, locale, standard } = params;

  await publish({
    busName: process.env.BUS_NAME ?? 'cumplify-events',
    source: 'cumplify.ai-invoker',
    detailType: 'Ai.GroundingBlocked',
    event: {
      tenantId,
      timestamp: new Date().toISOString(),
      actor: agent,
      module,
      clauseRef: '',
      // FIX-V3: Use the standard passed from the invoking handler; defaults ISO9001
      // until Task 19 handlers pass theirs explicitly.
      standard: standard ?? 'ISO9001',
      entityId: '',
      payload: {
        tenantId,
        agent,
        module,
        groundingScore,
        relevanceScore,
        retryAttempted: true,
        finalOutcome: 'honest-miss',
      },
    },
  });

  return getHonestMissTemplate(locale);
}

/** The "answer only from source" instruction injected on grounding retry (L1-7) */
export const GROUNDING_RETRY_INSTRUCTION =
  'Your previous response did not meet the grounding threshold. ' +
  'Answer ONLY from the following source material. If the source does not contain ' +
  'the answer, respond with "the standard does not specify this."';
