/**
 * Schema guard — mechanical enforcement of schema invariants that were
 * previously discipline-only (constitution + steering 01/03). Runs in the
 * hermetic lane on every `npm run test`; also invoked by the Kiro hook
 * .kiro/hooks/schema-guard.json on any save of schema.graphql.
 *
 * Invariants:
 *  1. No `extend type` / `extend input` — AppSync SILENTLY IGNORES extend
 *     blocks (standing lesson; a resolver on an extended field 404s live).
 *  2. SCHEMA-5: no input type carries a tenantId field — resolvers inject
 *     tenant identity from the Lambda authorizer's resolverContext only.
 *  3. Every Subscription field declares a `tenantId: ID!` argument —
 *     AppSync only delivers when the mutation result carries a matching
 *     tenantId (BUG-12, found live at ACC-3).
 *  4. Every Query and Mutation field carries an explicit @aws_ auth
 *     directive — an undirectived field falls back to the default auth mode
 *     unreviewed.
 *  5. HitlApprovalResult keeps its tenantId field (BUG-12 regression guard:
 *     removing it silently kills onHitlItemResolved delivery).
 *
 * Dependency-free structural lint (no graphql parser in the dependency
 * tree); block extraction is anchored on the repo's own SDL formatting.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SCHEMA_PATH = resolve(__dirname, '../schema/schema.graphql');
const sdl = readFileSync(SCHEMA_PATH, 'utf8');

/** Extract the body of a top-level block, e.g. blockBody('type', 'Query'). */
function blockBody(kind: string, name: string): string {
  const re = new RegExp(`^${kind} ${name}\\b[^{]*\\{([\\s\\S]*?)^\\}`, 'm');
  const m = sdl.match(re);
  return m ? m[1] : '';
}

/** All input blocks as [name, body] pairs. */
function inputBlocks(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const re = /^input (\w+)[^{]*\{([\s\S]*?)^\}/gm;
  let m;
  while ((m = re.exec(sdl))) out.push([m[1], m[2]]);
  return out;
}

/** Field lines (non-comment, field-shaped) of a block body. */
function fieldLines(body: string): string[] {
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[a-zA-Z_]\w*\s*(\(|:)/.test(l));
}

describe('schema-guard: schema.graphql invariants', () => {
  it('schema file exists and is non-trivial', () => {
    expect(sdl.length).toBeGreaterThan(1000);
  });

  it('1. contains no extend blocks (AppSync silently ignores them)', () => {
    const extendMatches = sdl.match(/^extend\s+(type|input|interface|enum)\b/gm) ?? [];
    expect(extendMatches).toEqual([]);
  });

  it('2. SCHEMA-5: no input type carries a tenantId field (except @aws_iam agent-path allowlist)', () => {
    // Allowlist: inputs used ONLY by @aws_iam mutations where no resolverContext exists
    // and FORCE RLS forbids deriving tenant from a related row. These carry tenantId
    // because the agent's IAM principal tag IS the tenant identity on that path.
    const TENANT_ID_ALLOWLIST = new Set([
      'PublishGenerationEventInput', // @aws_iam passthrough; None-DS result = input; GenerationEvent.tenantId non-null
      // read-surface-completion RS-7 (owner-approved 2026-07-22): the six
      // agent* writeback-door mutations are @aws_iam-ONLY (no @aws_lambda
      // fallback) — AppSync's Lambda authorizer, the sole source of
      // resolverContext, never runs for IAM-signed calls, so there is no
      // session to derive tenantId from. Explicit input field instead.
      'AgentDraftDocumentInput',
      'AgentTriageNCInput',
      'AgentProposeCorrectiveActionInput',
      'AgentAssessRiskInput',
      // Same @aws_iam passthrough shape as PublishGenerationEventInput: the
      // noneDS VTL forwards input verbatim, so tenantId must ride the input
      // for subscription filters + resolver-side tenant binding.
      'DocumentEventInput',
      'CAPAEventInput',
      'AuditEventTriggerInput',
      'RiskEventInput',
    ]);

    const offenders = inputBlocks()
      .filter(([, body]) => /^\s*tenantId\s*:/m.test(body))
      .filter(([name]) => !TENANT_ID_ALLOWLIST.has(name))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });

  it('3. every Subscription field declares tenantId: ID! (BUG-12 delivery requirement)', () => {
    const body = blockBody('type', 'Subscription');
    expect(body.length).toBeGreaterThan(0);
    const offenders = fieldLines(body).filter((l) => !/\(\s*tenantId\s*:\s*ID!\s*\)/.test(l));
    expect(offenders).toEqual([]);
  });

  it('4. every Query and Mutation field carries an @aws_ auth directive', () => {
    for (const typeName of ['Query', 'Mutation']) {
      const body = blockBody('type', typeName);
      expect(body.length).toBeGreaterThan(0);
      const offenders = fieldLines(body).filter((l) => !/@aws_\w+/.test(l));
      expect({ type: typeName, offenders }).toEqual({ type: typeName, offenders: [] });
    }
  });

  it('5. HitlApprovalResult keeps its tenantId field (BUG-12 regression guard)', () => {
    const body = blockBody('type', 'HitlApprovalResult');
    expect(/^\s*tenantId\s*:\s*ID!/m.test(body)).toBe(true);
  });
});
