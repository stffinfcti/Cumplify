/**
 * Unit tests for ar-check.ts — Layer 2 Automated Reasoning gate.
 * Spec-35 Tasks 27/28. Covers all 7 finding results from the gate mapping.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies ──────────────────────────────────────────────────────

const mockSend = vi.fn();
vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: class {
    send = mockSend;
  },
  ApplyGuardrailCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

const mockPublish = vi.fn().mockResolvedValue('evt-id');
vi.mock('../../../services/eventing/src/publisher.js', () => ({
  publish: (...args: unknown[]) => mockPublish(...args),
}));

vi.stubEnv('AWS_REGION', 'us-east-1');
vi.stubEnv('BUS_NAME', 'cumplify-events');
vi.stubEnv('ARCLAUSE_GUARDRAIL_ID', 'ar-clause-id');
vi.stubEnv('ARCLAUSE_GUARDRAIL_VERSION', '1');
vi.stubEnv('ARADVISORY_GUARDRAIL_ID', 'ar-advisory-id');
vi.stubEnv('ARADVISORY_GUARDRAIL_VERSION', '1');

const {
  checkArPolicy,
  mapFindingToDecision,
  extractArFinding,
  buildArRetryInstruction,
  emitArRejected,
  resolveArGuardrail,
  resetArCheckClient,
} = await import('../src/ar-check.js');

// ─── Helpers ────────────────────────────────────────────────────────────────

// Builds the LIVE tagged-union finding shape (FIX-T29-1) — mocks MUST mirror
// the real ApplyGuardrail payload, not an invented {result} object.
function mkFinding(result: string, claim?: string, ruleId?: string) {
  const key = {
    VALID: 'valid',
    SATISFIABLE: 'satisfiable',
    INVALID: 'invalid',
    IMPOSSIBLE: 'impossible',
    TRANSLATION_AMBIGUOUS: 'translationAmbiguous',
    NO_TRANSLATION: 'noTranslations',
    TOO_COMPLEX: 'tooComplex',
  }[result]!;
  if (result === 'INVALID' || result === 'IMPOSSIBLE') {
    return {
      [key]: {
        translation: { claims: [{ naturalLanguage: claim ?? 'test claim' }] },
        contradictingRules: [{ identifier: ruleId ?? 'TESTRULE0001' }],
      },
    };
  }
  return { [key]: {} };
}

function mockArResponse(result: string, claim?: string, ruleId?: string) {
  return {
    action: result === 'VALID' || result === 'SATISFIABLE' ? 'NONE' : 'GUARDRAIL_INTERVENED',
    assessments: [
      {
        automatedReasoningPolicy: {
          findings: result === 'VALID' ? [] : [mkFinding(result, claim, ruleId)],
        },
      },
    ],
  };
}

function baseParams(overrides?: Record<string, unknown>) {
  return {
    responseText: 'Clause 4.1 requires context of the organization.',
    invocationPath: 'clause-citing' as const,
    tenantId: 'tenant-test',
    agent: 'ISO9001Guru',
    module: 'advisory',
    feature: 'clause-qa',
    standard: 'ISO9001' as const,
    ...overrides,
  };
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockSend.mockReset();
  mockPublish.mockReset();
  resetArCheckClient();
});

// ─── Gate Mapping (all 7 results) ───────────────────────────────────────────

describe('mapFindingToDecision (gate mapping)', () => {
  it('VALID → pass', () => {
    expect(mapFindingToDecision('VALID')).toBe('pass');
  });

  it('SATISFIABLE → pass', () => {
    expect(mapFindingToDecision('SATISFIABLE')).toBe('pass');
  });

  it('INVALID → reject', () => {
    expect(mapFindingToDecision('INVALID')).toBe('reject');
  });

  it('IMPOSSIBLE → reject', () => {
    expect(mapFindingToDecision('IMPOSSIBLE')).toBe('reject');
  });

  it('TRANSLATION_AMBIGUOUS → flag_hitl', () => {
    expect(mapFindingToDecision('TRANSLATION_AMBIGUOUS')).toBe('flag_hitl');
  });

  it('NO_TRANSLATION → flag_hitl', () => {
    expect(mapFindingToDecision('NO_TRANSLATION')).toBe('flag_hitl');
  });

  it('TOO_COMPLEX → flag_hitl', () => {
    expect(mapFindingToDecision('TOO_COMPLEX')).toBe('flag_hitl');
  });
});

// ─── Guardrail Selection ────────────────────────────────────────────────────

describe('resolveArGuardrail', () => {
  it('clause-citing → ArClause guardrail', () => {
    const resolved = resolveArGuardrail('clause-citing');
    expect(resolved).toBeDefined();
    expect(resolved!.arPolicy).toBe('clause-canon');
    expect(resolved!.config.guardrailIdentifier).toBe('ar-clause-id');
  });

  it('role-advisory → ArAdvisory guardrail with role-permissions policy', () => {
    const resolved = resolveArGuardrail('role-advisory');
    expect(resolved).toBeDefined();
    expect(resolved!.arPolicy).toBe('role-permissions');
    expect(resolved!.config.guardrailIdentifier).toBe('ar-advisory-id');
  });

  it('plan-advisory → ArAdvisory guardrail with plan-entitlements policy', () => {
    const resolved = resolveArGuardrail('plan-advisory');
    expect(resolved).toBeDefined();
    expect(resolved!.arPolicy).toBe('plan-entitlements');
    expect(resolved!.config.guardrailIdentifier).toBe('ar-advisory-id');
  });
});

// ─── extractArFinding ───────────────────────────────────────────────────────

describe('extractArFinding', () => {
  it('extracts INVALID finding with claim and contradicting rule', () => {
    const response = mockArResponse('INVALID', 'Clause 99.9', 'No such clause');
    const finding = extractArFinding(response as any);
    expect(finding.result).toBe('INVALID');
    expect(finding.invalidClaim).toBe('Clause 99.9');
    expect(finding.reason).toBe('contradicts policy rule(s): No such clause');
    expect(finding.suggestedCorrection).toBeUndefined();
  });

  it('returns VALID when action=NONE and no findings', () => {
    const response = {
      action: 'NONE',
      assessments: [{ automatedReasoningPolicy: { findings: [] } }],
    };
    const finding = extractArFinding(response as any);
    expect(finding.result).toBe('VALID');
  });

  it('returns VALID when no AR assessment present and action=NONE', () => {
    const response = { action: 'NONE', assessments: [{}] };
    const finding = extractArFinding(response as any);
    expect(finding.result).toBe('VALID');
  });

  it('returns INVALID when action=GUARDRAIL_INTERVENED without detailed finding', () => {
    const response = { action: 'GUARDRAIL_INTERVENED', assessments: [{}] };
    const finding = extractArFinding(response as any);
    expect(finding.result).toBe('INVALID');
  });

  it('extracts TRANSLATION_AMBIGUOUS from finding result', () => {
    const response = mockArResponse('TRANSLATION_AMBIGUOUS');
    const finding = extractArFinding(response as any);
    expect(finding.result).toBe('TRANSLATION_AMBIGUOUS');
  });
});

// ─── checkArPolicy full flow ────────────────────────────────────────────────

describe('checkArPolicy', () => {
  it('VALID response → decision pass, Ai.GuardrailChecked emitted', async () => {
    mockSend.mockResolvedValueOnce(mockArResponse('VALID'));
    const result = await checkArPolicy(baseParams());

    expect(result.decision).toBe('pass');
    expect(result.finding.result).toBe('VALID');
    expect(result.arPolicy).toBe('clause-canon');

    // Ai.GuardrailChecked emitted
    expect(mockPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        detailType: 'Ai.GuardrailChecked',
        event: expect.objectContaining({
          payload: expect.objectContaining({
            guardrailPolicy: 'ar:clause-canon',
            verdict: 'pass',
          }),
        }),
      }),
    );
  });

  it('SATISFIABLE response → decision pass', async () => {
    mockSend.mockResolvedValueOnce({
      action: 'NONE',
      assessments: [{ automatedReasoningPolicy: { findings: [{ satisfiable: {} }] } }],
    });
    const result = await checkArPolicy(baseParams());
    expect(result.decision).toBe('pass');
    expect(result.finding.result).toBe('SATISFIABLE');
  });

  it('INVALID response → decision reject', async () => {
    mockSend.mockResolvedValueOnce(mockArResponse('INVALID', 'Clause 99.9', 'fabricated'));
    const result = await checkArPolicy(baseParams());

    expect(result.decision).toBe('reject');
    expect(result.finding.result).toBe('INVALID');
    expect(result.finding.invalidClaim).toBe('Clause 99.9');
  });

  it('IMPOSSIBLE response → decision reject', async () => {
    mockSend.mockResolvedValueOnce(mockArResponse('IMPOSSIBLE'));
    const result = await checkArPolicy(baseParams());
    expect(result.decision).toBe('reject');
    expect(result.finding.result).toBe('IMPOSSIBLE');
  });

  it('TRANSLATION_AMBIGUOUS → decision flag_hitl (never silently passes)', async () => {
    mockSend.mockResolvedValueOnce(mockArResponse('TRANSLATION_AMBIGUOUS'));
    const result = await checkArPolicy(baseParams());

    expect(result.decision).toBe('flag_hitl');
    expect(result.finding.result).toBe('TRANSLATION_AMBIGUOUS');

    // Ai.GuardrailChecked emitted with verdict 'flag'
    expect(mockPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        detailType: 'Ai.GuardrailChecked',
        event: expect.objectContaining({
          payload: expect.objectContaining({
            guardrailPolicy: 'ar:clause-canon',
            verdict: 'flag',
          }),
        }),
      }),
    );
  });

  it('NO_TRANSLATION → decision flag_hitl', async () => {
    mockSend.mockResolvedValueOnce(mockArResponse('NO_TRANSLATION'));
    const result = await checkArPolicy(baseParams());
    expect(result.decision).toBe('flag_hitl');
  });

  it('TOO_COMPLEX → decision flag_hitl', async () => {
    mockSend.mockResolvedValueOnce(mockArResponse('TOO_COMPLEX'));
    const result = await checkArPolicy(baseParams());
    expect(result.decision).toBe('flag_hitl');
  });

  it('unconfigured guardrail → passes through (dormant)', async () => {
    // Remove env vars to simulate pre-deploy
    vi.stubEnv('ARCLAUSE_GUARDRAIL_ID', '');
    resetArCheckClient();

    const result = await checkArPolicy(baseParams());
    expect(result.decision).toBe('pass');
    expect(result.arPolicy).toBe('unconfigured');
    expect(mockSend).not.toHaveBeenCalled();

    // Restore
    vi.stubEnv('ARCLAUSE_GUARDRAIL_ID', 'ar-clause-id');
  });

  it('role-advisory path uses ArAdvisory guardrail', async () => {
    mockSend.mockResolvedValueOnce(mockArResponse('VALID'));
    const result = await checkArPolicy(baseParams({ invocationPath: 'role-advisory' }));

    expect(result.arPolicy).toBe('role-permissions');
    expect(mockPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          payload: expect.objectContaining({
            guardrailPolicy: 'ar:role-permissions',
          }),
        }),
      }),
    );
  });

  it('plan-advisory path uses ArAdvisory guardrail with plan-entitlements', async () => {
    mockSend.mockResolvedValueOnce(mockArResponse('VALID'));
    const result = await checkArPolicy(baseParams({ invocationPath: 'plan-advisory' }));
    expect(result.arPolicy).toBe('plan-entitlements');
  });
});

// ─── buildArRetryInstruction ────────────────────────────────────────────────

describe('buildArRetryInstruction', () => {
  it('includes invalidClaim, reason, and suggestedCorrection', () => {
    const instruction = buildArRetryInstruction({
      result: 'INVALID',
      invalidClaim: 'Clause 99.9 exists',
      reason: 'No such clause in ISO 9001',
      suggestedCorrection: 'Remove the reference to clause 99.9',
    });
    expect(instruction).toContain('Clause 99.9 exists');
    expect(instruction).toContain('No such clause in ISO 9001');
    expect(instruction).toContain('Remove the reference to clause 99.9');
    expect(instruction).toContain('automated reasoning');
  });

  it('handles missing fields gracefully', () => {
    const instruction = buildArRetryInstruction({ result: 'INVALID' });
    expect(instruction).toContain('automated reasoning');
    expect(instruction).toContain('regenerate');
  });
});

// ─── emitArRejected ─────────────────────────────────────────────────────────

describe('emitArRejected', () => {
  it('publishes Ai.ArRejected event with correct payload', async () => {
    await emitArRejected({
      tenantId: 'tenant-1',
      agent: 'ISO9001Guru',
      module: 'advisory',
      standard: 'ISO9001',
      arPolicy: 'clause-canon',
      finding: { result: 'INVALID', invalidClaim: 'Clause 99.9', reason: 'fabricated' },
      retriedOnce: true,
      finalOutcome: 'hitl-deferred',
    });

    expect(mockPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        detailType: 'Ai.ArRejected',
        event: expect.objectContaining({
          tenantId: 'tenant-1',
          actor: 'ISO9001Guru',
          module: 'advisory',
          standard: 'ISO9001',
          payload: expect.objectContaining({
            arPolicy: 'clause-canon',
            invalidClaim: 'Clause 99.9',
            reason: 'fabricated',
            retriedOnce: true,
            finalOutcome: 'hitl-deferred',
          }),
        }),
      }),
    );
  });

  it('publishes corrected outcome', async () => {
    await emitArRejected({
      tenantId: 'tenant-1',
      agent: 'ISO9001Guru',
      module: 'advisory',
      arPolicy: 'clause-canon',
      finding: { result: 'INVALID', invalidClaim: 'wrong' },
      retriedOnce: true,
      finalOutcome: 'corrected',
    });

    const call = mockPublish.mock.calls[0][0];
    expect(call.event.payload.finalOutcome).toBe('corrected');
    expect(call.event.payload.retriedOnce).toBe(true);
  });
});

describe('FIX-T29-2: companion noTranslations findings (live shapes, probes 2026-07-17)', () => {
  it('[satisfiable, noTranslations] → SATISFIABLE (pass) — live valid-clause probe shape', () => {
    const finding = extractArFinding({
      action: 'NONE',
      assessments: [
        { automatedReasoningPolicy: { findings: [{ satisfiable: {} }, { noTranslations: {} }] } },
      ],
    } as any);
    expect(finding.result).toBe('SATISFIABLE');
    expect(mapFindingToDecision(finding.result)).toBe('pass');
  });

  it('[translationAmbiguous, noTranslations] → TRANSLATION_AMBIGUOUS (hitl) — live fabricated-clause probe shape', () => {
    const finding = extractArFinding({
      action: 'NONE',
      assessments: [
        {
          automatedReasoningPolicy: {
            findings: [{ translationAmbiguous: { options: [] } }, { noTranslations: {} }],
          },
        },
      ],
    } as any);
    expect(finding.result).toBe('TRANSLATION_AMBIGUOUS');
    expect(mapFindingToDecision(finding.result)).toBe('flag_hitl');
  });

  it('[invalid, noTranslations] → INVALID (reject)', () => {
    const finding = extractArFinding({
      action: 'GUARDRAIL_INTERVENED',
      assessments: [
        {
          automatedReasoningPolicy: {
            findings: [
              {
                invalid: {
                  translation: { claims: [{ naturalLanguage: 'clause 99.9 exists' }] },
                  contradictingRules: [{ identifier: 'CANONRULE001' }],
                },
              },
              { noTranslations: {} },
            ],
          },
        },
      ],
    } as any);
    expect(finding.result).toBe('INVALID');
    expect(finding.invalidClaim).toBe('clause 99.9 exists');
  });

  it('standalone [noTranslations] → NO_TRANSLATION (flag_hitl per gate mapping)', () => {
    const finding = extractArFinding({
      action: 'NONE',
      assessments: [{ automatedReasoningPolicy: { findings: [{ noTranslations: {} }] } }],
    } as any);
    expect(finding.result).toBe('NO_TRANSLATION');
    expect(mapFindingToDecision(finding.result)).toBe('flag_hitl');
  });
});
