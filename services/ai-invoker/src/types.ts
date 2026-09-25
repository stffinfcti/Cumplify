/**
 * Types for the one-door AI Invoker module.
 * Design §1 — agents-existing-8.
 */

/** Seat identifiers matching contracts/model-register.md */
export type SeatId =
  | 'workhorse'
  | 'lightweight'
  | 'guru-9001'
  | 'guru-14001'
  | 'guru-45001'
  | 'micro'
  | 'snapshot'
  | 'editor-ai'
  | 'pain-distiller'
  | 'legal-ledger'
  | 'doc-composer';

/** Tier grouping for seat-specific logic (schema-retry, caching) */
export type SeatTier =
  | 'workhorse'
  | 'lightweight'
  | 'guru'
  | 'micro'
  | 'snapshot'
  | 'editor-ai'
  | 'pain-distiller'
  | 'legal-ledger'
  | 'doc-composer';

/** Register entry status */
export type RegisterStatus = 'ASSIGNED' | 'PROVISIONAL' | 'EXPIRED' | 'UNASSIGNED';

/** Build-time compiled register (from contracts/model-register.md) */
export interface CompiledRegister {
  seats: Record<SeatId, SeatEntry>;
  compiledAt: string;
  sourceCommit: string;
}

export interface SeatEntry {
  modelId: string;
  status: RegisterStatus;
  expiry: string | null; // ISO 8601 date or null for contingent
  marginHeadroom: number; // 0-1
  tier: SeatTier;
  cachingSupported: boolean; // Nova = true, qwen/kimi = false
}

/** DynamoDB MODELWEIGHT# item shape */
export interface ModelWeight {
  modelId: string;
  wIn: number; // credits per 1M input tokens
  wOut: number; // credits per 1M output tokens
  wCache: number | null; // credits per 1M cached-read tokens (null = not supported)
  effectiveFrom: string;
  sourceCommit: string;
}

/** Request to the one-door invoke() API */
export interface InvokeRequest {
  seat: SeatId;
  messages: ConversationMessage[];
  system?: string;
  tools?: ToolConfig[];
  /** JSON schema for response validation (Workhorse tier) */
  outputSchema?: Record<string, unknown>;
  /** Override temperature (defaults from seat config) */
  temperature?: number;
  /** Override maxTokens (defaults from seat config) */
  maxTokens?: number;
  /** Metadata for attribution */
  tenantId: string;
  agent: string;
  module: string;
  feature: string;
  /** Set true to skip credit pre-check (incident/HITL exemption) */
  creditExempt?: boolean;
  /** Retrieved KB chunks for grounding check (L1). Omit for non-grounded calls. */
  groundingContext?: {
    source: string; // concatenated retrieval chunks (≤100,000 chars)
    query: string; // original user question (≤1,000 chars)
  };
  /** Tenant document locale for honest-miss template (defaults to 'en') */
  locale?: 'en' | 'es' | 'pt';
  /** ISO standard for event attribution (FIX-V3: threaded to grounding events; defaults 'ISO9001') */
  standard?: 'ISO9001' | 'ISO14001' | 'ISO45001';
}

/** Converse API message shape */
export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

export type ContentBlock =
  | { text: string }
  | { toolUse: { toolUseId: string; name: string; input: unknown } }
  | { toolResult: { toolUseId: string; content: ContentBlock[]; status?: 'success' | 'error' } }
  /**
   * Selective guardrail evaluation (Bedrock guardContent): when ANY guardedText
   * block is present, input guardrail policies evaluate ONLY those blocks.
   * Callers wrap UNTRUSTED content (tenant-entered field values) in guardedText
   * and keep their own scaffolding (format instructions) in plain text blocks —
   * live-proven 2026-07-15: PROMPT_ATTACK HIGH blocks strict JSON-format
   * instructions when the whole prompt is evaluated (doc-composer seat).
   */
  | { guardedText: string };

/** Tool configuration for Converse API */
export interface ToolConfig {
  toolSpec: {
    name: string;
    description: string;
    inputSchema: { json: Record<string, unknown> };
  };
}

/** Response from the one-door invoke() API */
export interface InvokeResponse {
  text: string;
  toolUseBlocks: ToolUseBlock[];
  stopReason: string;
  usage: TokenUsage;
  credits: number;
  modelId: string;
  seat: SeatId;
  /** Guardrail evidence for HITL cards (L5). Present when groundingContext was provided. */
  guardrailEvidence?: GuardrailEvidenceData;
}

/** Guardrail evidence data attached to InvokeResponse for HITL cards */
export interface GuardrailEvidenceData {
  groundingScore: number | null;
  relevanceScore: number | null;
  arVerdict: 'pass' | 'fail' | 'error' | null;
  arDetails: string | null;
  citations: GuardrailCitation[];
  flagged: boolean;
}

export interface GuardrailCitation {
  clauseRef: string;
  sourceChunk: string;
  score: number;
}

export interface ToolUseBlock {
  toolUseId: string;
  name: string;
  input: unknown;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
}

/** Error codes returned by the invoker */
export type InvokeErrorCode =
  | 'MODEL_SEAT_EXPIRED'
  | 'MODEL_SEAT_UNASSIGNED'
  | 'PAUSED_FOR_CREDITS'
  | 'SCHEMA_VALIDATION_ERROR'
  | 'INVOCATION_ERROR'
  | 'GUARDRAIL_BLOCKED'
  | 'GROUNDING_BLOCKED'
  | 'AR_REJECTED'
  | 'HOP_BLOCKED'
  | 'STREAMING_BLOCKED';

export class InvokeError extends Error {
  constructor(
    public readonly code: InvokeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'InvokeError';
  }
}

/** Seat default configurations */
export interface SeatDefaults {
  temperature: number;
  maxTokens: number;
}

export const SEAT_DEFAULTS: Record<SeatTier, SeatDefaults> = {
  workhorse: { temperature: 0.3, maxTokens: 4096 },
  lightweight: { temperature: 0.2, maxTokens: 2048 },
  guru: { temperature: 0.1, maxTokens: 2048 },
  micro: { temperature: 0.0, maxTokens: 512 },
  snapshot: { temperature: 0.3, maxTokens: 4096 },
  'editor-ai': { temperature: 0.4, maxTokens: 4096 },
  'pain-distiller': { temperature: 0.2, maxTokens: 2048 },
  'legal-ledger': { temperature: 0.2, maxTokens: 4096 },
  // spec-40: fact-grounded prose — low temperature, full-section budget
  'doc-composer': { temperature: 0.2, maxTokens: 4096 },
};

// ─── Embed Door (spec-35, EMB-1..5) ───────────────────────────────────────

/** Request for the embed operation (dispatched via op:'embed') */
export interface EmbedRequest {
  tenantId: string;
  agent: string;
  module: string;
  feature: string;
  text: string;
  /** System operation — bypasses credit pre-check (SERVE-9 exempt), meters as COGS */
  systemOp?: boolean;
}

/** Result from the embed operation */
export interface EmbedResult {
  embedding: number[];
  tokenCount: number;
  credits: number;
}

/** Discriminated embed operation payload (op field present = embed path) */
export type EmbedOp = { op: 'embed' } & EmbedRequest;
