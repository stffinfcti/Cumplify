/**
 * Unit tests for grounding retry + honest-miss flow — spec-35 Task 10.
 * Verifies: runGroundingFlow (pass/blocked), emitGroundingBlockedAndHonestMiss,
 * GROUNDING_RETRY_INSTRUCTION.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Bedrock Runtime (for checkGrounding)
const mockBedrockSend = vi.fn();
vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: class {
    send = mockBedrockSend;
  },
  ApplyGuardrailCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

// Mock EventBridge (for publish)
const mockEbSend = vi.fn();
vi.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: class {
    send = mockEbSend;
  },
  PutEventsCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

vi.stubEnv('AWS_REGION', 'us-east-1');
vi.stubEnv('BUS_NAME', 'cumplify-events');

const {
  runGroundingFlow,
  emitGroundingBlockedAndHonestMiss,
  GROUNDING_RETRY_INSTRUCTION,
  resetGroundingClient,
} = await import('../src/grounding.js');

describe('runGroundingFlow', () => {
  beforeEach(() => {
    mockBedrockSend.mockReset();
    mockEbSend.mockReset();
    resetGroundingClient();
    // FIX-V2: runGroundingFlow now emits Ai.GuardrailChecked per section check
    mockEbSend.mockResolvedValue({ FailedEntryCount: 0, Entries: [{ EventId: 'e1' }] });
  });

  it('returns pass result when grounding check passes', async () => {
    mockBedrockSend.mockResolvedValueOnce({
      action: 'NONE',
      assessments: [
        {
          contextualGroundingPolicy: {
            filters: [
              { type: 'GROUNDING', score: 0.92, action: 'NONE' },
              { type: 'RELEVANCE', score: 0.88, action: 'NONE' },
            ],
          },
        },
      ],
    });

    const result = await runGroundingFlow({
      guardrailConfig: { guardrailIdentifier: 'gid', guardrailVersion: '1' },
      groundingContext: { source: '[ISO 9001 4.1] Context chunk', query: 'What is 4.1?' },
      responseText: 'Clause 4.1 defines organizational context.',
      locale: 'en',
      tenantId: 't1',
      agent: 'guru-9001',
      module: 'M1',
    });

    expect(result.isHonestMiss).toBe(false);
    expect(result.flagged).toBe(false);
    expect(result.groundingScore).toBe(0.92);
    expect(result.relevanceScore).toBe(0.88);
    expect(result.text).toBe('Clause 4.1 defines organizational context.');
    expect(result.citations.length).toBeGreaterThan(0);
  });

  it('returns flagged result when grounding check blocks', async () => {
    mockBedrockSend.mockResolvedValueOnce({
      action: 'GUARDRAIL_INTERVENED',
      assessments: [
        {
          contextualGroundingPolicy: {
            filters: [
              { type: 'GROUNDING', score: 0.4, action: 'BLOCKED' },
              { type: 'RELEVANCE', score: 0.6, action: 'BLOCKED' },
            ],
          },
        },
      ],
    });

    const result = await runGroundingFlow({
      guardrailConfig: { guardrailIdentifier: 'gid', guardrailVersion: '1' },
      groundingContext: { source: 'some source', query: 'query' },
      responseText: 'A hallucinated response',
      locale: 'en',
      tenantId: 't1',
      agent: 'guru-9001',
      module: 'M1',
    });

    expect(result.flagged).toBe(true);
    expect(result.isHonestMiss).toBe(false); // orchestration decides honest-miss
    expect(result.groundingScore).toBe(0.4);
  });

  it('uses worst score across multiple sections', async () => {
    // Response > 5000 chars → splits into sections
    const longResponse =
      '## Section 1\n' + 'a'.repeat(3000) + '\n## Section 2\n' + 'b'.repeat(3000);

    // First section passes, second blocks
    mockBedrockSend
      .mockResolvedValueOnce({
        action: 'NONE',
        assessments: [
          {
            contextualGroundingPolicy: {
              filters: [
                { type: 'GROUNDING', score: 0.95, action: 'NONE' },
                { type: 'RELEVANCE', score: 0.9, action: 'NONE' },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        action: 'GUARDRAIL_INTERVENED',
        assessments: [
          {
            contextualGroundingPolicy: {
              filters: [
                { type: 'GROUNDING', score: 0.5, action: 'BLOCKED' },
                { type: 'RELEVANCE', score: 0.7, action: 'BLOCKED' },
              ],
            },
          },
        ],
      });

    const result = await runGroundingFlow({
      guardrailConfig: { guardrailIdentifier: 'gid', guardrailVersion: '1' },
      groundingContext: { source: 'source', query: 'q' },
      responseText: longResponse,
      locale: 'en',
      tenantId: 't1',
      agent: 'guru-9001',
      module: 'M1',
    });

    expect(result.flagged).toBe(true);
    expect(result.groundingScore).toBe(0.5); // worst of the two
    expect(result.relevanceScore).toBe(0.7);
    expect(mockBedrockSend).toHaveBeenCalledTimes(2); // two sections checked
  });
});

describe('emitGroundingBlockedAndHonestMiss', () => {
  beforeEach(() => {
    mockEbSend.mockReset();
    mockEbSend.mockResolvedValue({ FailedEntryCount: 0, Entries: [{ EventId: 'e1' }] });
  });

  it('publishes Ai.GroundingBlocked event and returns honest-miss template', async () => {
    const template = await emitGroundingBlockedAndHonestMiss({
      tenantId: 't1',
      agent: 'guru-9001',
      module: 'M1',
      groundingScore: 0.35,
      relevanceScore: 0.6,
      locale: 'en',
    });

    // Event published
    expect(mockEbSend).toHaveBeenCalledTimes(1);
    const entry = (
      mockEbSend.mock.calls[0][0] as {
        input: { Entries: Array<{ DetailType: string; Detail: string }> };
      }
    ).input.Entries[0];
    expect(entry.DetailType).toBe('Ai.GroundingBlocked');
    const detail = JSON.parse(entry.Detail);
    expect(detail.payload.groundingScore).toBe(0.35);
    expect(detail.payload.retryAttempted).toBe(true);
    expect(detail.payload.finalOutcome).toBe('honest-miss');
    expect(detail.entityId).toBe('');

    // Honest-miss template returned
    expect(template).toContain('unable to provide a sufficiently grounded answer');
  });

  it('returns Spanish template when locale is "es"', async () => {
    const template = await emitGroundingBlockedAndHonestMiss({
      tenantId: 't1',
      agent: 'guru-9001',
      module: 'M1',
      groundingScore: 0.4,
      relevanceScore: 0.55,
      locale: 'es',
    });

    expect(template).toContain('No fue posible proporcionar');
  });
});

describe('GROUNDING_RETRY_INSTRUCTION', () => {
  it('contains the "answer only from source" instruction', () => {
    expect(GROUNDING_RETRY_INSTRUCTION).toContain('Answer ONLY from the following source material');
    expect(GROUNDING_RETRY_INSTRUCTION).toContain('the standard does not specify this');
  });
});
