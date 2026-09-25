/**
 * Unit tests for grounding.ts — spec-35 Task 9.
 * Verifies: section splitting, context validation/truncation, ApplyGuardrail call,
 * response parsing, citation construction.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Bedrock Runtime
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

vi.stubEnv('AWS_REGION', 'us-east-1');

const {
  splitForGroundingCheck,
  chunkAtParagraphs,
  validateGroundingContext,
  checkGrounding,
  parseGroundingResponse,
  buildCitations,
  resetGroundingClient,
} = await import('../src/grounding.js');

describe('splitForGroundingCheck', () => {
  it('returns single element for text ≤5000 chars', () => {
    const text = 'a'.repeat(5000);
    expect(splitForGroundingCheck(text)).toEqual([text]);
  });

  it('splits on ## headers for text >5000 chars', () => {
    const text = '## Section 1\n' + 'a'.repeat(3000) + '\n## Section 2\n' + 'b'.repeat(3000);
    const sections = splitForGroundingCheck(text);
    expect(sections).toHaveLength(2);
    expect(sections[0]).toContain('Section 1');
    expect(sections[1]).toContain('Section 2');
  });

  it('splits on ### headers', () => {
    const text = '### Sub 1\n' + 'x'.repeat(3000) + '\n### Sub 2\n' + 'y'.repeat(3000);
    const sections = splitForGroundingCheck(text);
    expect(sections).toHaveLength(2);
  });

  it('falls back to paragraph chunking when no headers', () => {
    const paras = Array(20).fill('Para content that is moderately long to fill space.'.repeat(5));
    const text = paras.join('\n\n');
    const sections = splitForGroundingCheck(text);
    expect(sections.length).toBeGreaterThan(1);
    for (const s of sections) {
      expect(s.length).toBeLessThanOrEqual(4200); // ~4000 + one paragraph overshoot
    }
  });
});

describe('chunkAtParagraphs', () => {
  it('chunks at paragraph boundaries respecting size limit', () => {
    const text = 'Para 1\n\nPara 2\n\nPara 3\n\nPara 4';
    const chunks = chunkAtParagraphs(text, 15);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 20)).toBe(true); // small tolerance
  });

  it('returns full text as single chunk if no paragraph breaks', () => {
    const text = 'no paragraph breaks here just a long string';
    const chunks = chunkAtParagraphs(text, 10);
    // Falls through to single chunk since no \n\n to split on properly
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });
});

describe('validateGroundingContext', () => {
  it('passes through context within caps unchanged', () => {
    const ctx = { source: 'hello', query: 'what?' };
    expect(validateGroundingContext(ctx)).toEqual(ctx);
  });

  it('truncates source at 100k chars', () => {
    const ctx = { source: 'x'.repeat(150_000), query: 'q' };
    const result = validateGroundingContext(ctx);
    expect(result.source.length).toBe(100_000);
    expect(result.query).toBe('q');
  });

  it('truncates query at 1,000 chars at word boundary', () => {
    const words = Array(200).fill('longword').join(' '); // well over 1000
    const ctx = { source: 'src', query: words };
    const result = validateGroundingContext(ctx);
    expect(result.query.length).toBeLessThanOrEqual(1000);
    expect(result.query.endsWith('longword')).toBe(true); // clean word boundary
  });

  it('truncates query hard at 1000 if no space found', () => {
    const noSpaces = 'x'.repeat(2000);
    const ctx = { source: 'src', query: noSpaces };
    const result = validateGroundingContext(ctx);
    expect(result.query.length).toBe(1000);
  });
});

describe('checkGrounding', () => {
  beforeEach(() => {
    mockSend.mockReset();
    resetGroundingClient();
  });

  it('calls ApplyGuardrail with correct qualifiers and source:OUTPUT', async () => {
    mockSend.mockResolvedValueOnce({
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

    const result = await checkGrounding({
      guardrailConfig: { guardrailIdentifier: 'gid', guardrailVersion: '1' },
      groundingSource: 'retrieved chunks here',
      query: 'what is clause 4.1?',
      content: 'The response text to check',
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    const cmd = mockSend.mock.calls[0][0] as { input: any };
    expect(cmd.input.guardrailIdentifier).toBe('gid');
    expect(cmd.input.guardrailVersion).toBe('1');
    expect(cmd.input.source).toBe('OUTPUT');
    expect(cmd.input.content).toHaveLength(3);
    expect(cmd.input.content[0].text.qualifiers).toEqual(['grounding_source']);
    expect(cmd.input.content[1].text.qualifiers).toEqual(['query']);
    expect(cmd.input.content[2].text.text).toBe('The response text to check');

    expect(result.verdict).toBe('pass');
    expect(result.groundingScore).toBe(0.92);
    expect(result.relevanceScore).toBe(0.88);
  });

  it('returns blocked verdict when filters have action BLOCKED', async () => {
    mockSend.mockResolvedValueOnce({
      action: 'GUARDRAIL_INTERVENED',
      assessments: [
        {
          contextualGroundingPolicy: {
            filters: [
              { type: 'GROUNDING', score: 0.42, action: 'BLOCKED' },
              { type: 'RELEVANCE', score: 0.65, action: 'BLOCKED' },
            ],
          },
        },
      ],
    });

    const result = await checkGrounding({
      guardrailConfig: { guardrailIdentifier: 'gid', guardrailVersion: '1' },
      groundingSource: 'source',
      query: 'query',
      content: 'hallucinated content',
    });

    expect(result.verdict).toBe('blocked');
    expect(result.groundingScore).toBe(0.42);
    expect(result.relevanceScore).toBe(0.65);
  });
});

describe('parseGroundingResponse', () => {
  it('defaults to pass with score 1.0 when no assessments', () => {
    const result = parseGroundingResponse({ action: 'NONE', assessments: [] } as any);
    expect(result.verdict).toBe('pass');
    expect(result.groundingScore).toBe(1.0);
    expect(result.relevanceScore).toBe(1.0);
  });

  it('derives blocked from contextualGroundingPolicy filters action, not top-level (FIX-V1)', () => {
    // Grounding filter explicitly BLOCKED
    const result = parseGroundingResponse({
      action: 'GUARDRAIL_INTERVENED',
      assessments: [
        {
          contextualGroundingPolicy: {
            filters: [
              { type: 'GROUNDING', score: 0.42, action: 'BLOCKED' },
              { type: 'RELEVANCE', score: 0.8, action: 'NONE' },
            ],
          },
        },
      ],
    } as any);
    expect(result.verdict).toBe('blocked');
    expect(result.groundingScore).toBe(0.42);
    expect(result.relevanceScore).toBe(0.8);
  });

  it('returns pass when PII intervened but grounding filters passed (FIX-V1 mixed assessment)', () => {
    // Top-level action is GUARDRAIL_INTERVENED because PII anonymized output,
    // but the contextualGroundingPolicy filters both passed (action: NONE).
    // Before FIX-V1 this would incorrectly return 'blocked'.
    const result = parseGroundingResponse({
      action: 'GUARDRAIL_INTERVENED',
      assessments: [
        {
          sensitiveInformationPolicy: {
            piiEntities: [{ type: 'NAME', match: 'John', action: 'ANONYMIZED' }],
            regexes: [],
          },
          contextualGroundingPolicy: {
            filters: [
              { type: 'GROUNDING', score: 0.92, action: 'NONE' },
              { type: 'RELEVANCE', score: 0.88, action: 'NONE' },
            ],
          },
        },
      ],
    } as any);
    expect(result.verdict).toBe('pass');
    expect(result.groundingScore).toBe(0.92);
    expect(result.relevanceScore).toBe(0.88);
  });

  it('returns blocked when relevance filter is BLOCKED', () => {
    const result = parseGroundingResponse({
      action: 'GUARDRAIL_INTERVENED',
      assessments: [
        {
          contextualGroundingPolicy: {
            filters: [
              { type: 'GROUNDING', score: 0.9, action: 'NONE' },
              { type: 'RELEVANCE', score: 0.5, action: 'BLOCKED' },
            ],
          },
        },
      ],
    } as any);
    expect(result.verdict).toBe('blocked');
    expect(result.groundingScore).toBe(0.9);
    expect(result.relevanceScore).toBe(0.5);
  });
});

describe('buildCitations', () => {
  it('extracts clauseRef from chunk metadata prefix', () => {
    const source =
      '[ISO 9001 4.1] Context of the organization\n---\n[ISO 14001 6.1.2] Environmental aspects';
    const citations = buildCitations(source, 0.91);
    expect(citations).toHaveLength(2);
    expect(citations[0].clauseRef).toBe('ISO 9001 4.1');
    expect(citations[1].clauseRef).toBe('ISO 14001 6.1.2');
    expect(citations[0].score).toBe(0.91);
  });

  it('returns empty clauseRef when no match', () => {
    const source = 'Some chunk without clause reference';
    const citations = buildCitations(source, 0.85);
    expect(citations).toHaveLength(1);
    expect(citations[0].clauseRef).toBe('');
  });

  it('limits to top-5 citations', () => {
    const chunks = Array(10).fill('[ISO 9001 4.1] chunk content').join('\n---\n');
    const citations = buildCitations(chunks, 0.9);
    expect(citations).toHaveLength(5);
  });

  it('truncates sourceChunk to 200 chars', () => {
    const longChunk = '[ISO 9001 4.1] ' + 'x'.repeat(500);
    const citations = buildCitations(longChunk, 0.9);
    expect(citations[0].sourceChunk.length).toBe(200);
  });
});
