/**
 * Guardrail config builder — 5-guardrail topology (spec-35 §1.1).
 *
 * Routing priority:
 * 1. doc-composer seat → DocGen guardrail (no grounding, no AR)
 * 2. feature === 'doc-draft' → DocGen guardrail (S2.1: whole-document
 *    drafting has the spec-40 BC-5 problem — Agent-guardrail PII
 *    anonymization would redact the tenant's own names out of their draft)
 * 3. feature === 'record-write' → RecordWrite guardrail (grounding 0.90)
 * 4. All other seats → Agent guardrail (grounding 0.85)
 *
 * AR guardrails (ArClause + ArAdvisory) are invoked post-response by ar-check.ts
 * via buildArClauseGuardrailConfig() / buildArAdvisoryGuardrailConfig() — NOT
 * attached to the inline Converse guardrailConfig.
 */

import type { SeatId } from './types.js';

export interface GuardrailConfig {
  guardrailIdentifier: string;
  guardrailVersion: string;
}

/**
 * Resolve a guardrail config from environment variable prefix.
 * Returns undefined if the guardrail is not configured (dev/test environments
 * without deployment, or AR guardrails before Task 25).
 */
function envGuardrail(prefix: string): GuardrailConfig | undefined {
  const guardrailId = process.env[`${prefix}_ID`];
  const guardrailVersion = process.env[`${prefix}_VERSION`] ?? 'DRAFT';

  if (!guardrailId) {
    return undefined;
  }

  return {
    guardrailIdentifier: guardrailId,
    guardrailVersion,
  };
}

/**
 * Build the inline Converse guardrailConfig for a seat + feature.
 * This is the guardrail passed to the Converse API call (content + PII + grounding).
 */
export function buildGuardrailConfig(seat: SeatId, feature?: string): GuardrailConfig | undefined {
  // Priority 1: doc-composer → DocGen guardrail (no grounding, no AR)
  if (seat === 'doc-composer') {
    return envGuardrail('DOCGEN_GUARDRAIL');
  }
  // Priority 2: document-generation features → DocGen guardrail (S2.1/S3).
  // DocStudio's drafting (whole documents AND manual sections) is document
  // generation on the workhorse seat: the Agent guardrail would anonymize
  // NAME/EMAIL/PHONE out of the tenant's own draft — the org profile's
  // legalName included (spec-40 BC-5 rationale). PROMPT_ATTACK + SSN/card
  // BLOCK stay.
  if (feature === 'doc-draft' || feature === 'manual-section-draft') {
    return envGuardrail('DOCGEN_GUARDRAIL');
  }
  // Priority 3: record-write feature → RecordWrite guardrail (grounding 0.90)
  if (feature === 'record-write') {
    return envGuardrail('RECORDWRITE_GUARDRAIL');
  }
  // Priority 4: all other seats → Agent guardrail (grounding 0.85)
  return envGuardrail('GUARDRAIL');
}

/**
 * Build AR-clause guardrail config (clause-canon policy only).
 * Invoked post-response by ar-check.ts on clause-citing paths.
 */
export function buildArClauseGuardrailConfig(): GuardrailConfig | undefined {
  return envGuardrail('ARCLAUSE_GUARDRAIL');
}

/**
 * Build AR-advisory guardrail config (role-permissions + plan-entitlements).
 * Invoked post-response by ar-check.ts on role/plan advisory paths.
 */
export function buildArAdvisoryGuardrailConfig(): GuardrailConfig | undefined {
  return envGuardrail('ARADVISORY_GUARDRAIL');
}
