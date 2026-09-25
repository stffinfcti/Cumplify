/**
 * Unit tests for prompt-library.ts — spec-35 Task 17.
 * Verifies: buildSystemPrompt prepends all four shared blocks before base prompt.
 */

import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, PROMPT_BLOCKS } from '../src/prompt-library.js';

describe('buildSystemPrompt', () => {
  it('prepends all four shared blocks before the base prompt', () => {
    const base = 'You are the ISO 9001 Domain Guru.';
    const result = buildSystemPrompt(base);

    // All four blocks present in order before the base
    const structIdx = result.indexOf(PROMPT_BLOCKS.STRUCTURAL_HONESTY);
    const uncertIdx = result.indexOf(PROMPT_BLOCKS.LICENSED_UNCERTAINTY);
    const retriIdx = result.indexOf(PROMPT_BLOCKS.RETRIEVAL_FIRST);
    const dateIdx = result.indexOf(PROMPT_BLOCKS.RELATIVE_DATE);
    const baseIdx = result.indexOf(base);

    expect(structIdx).toBeGreaterThanOrEqual(0);
    expect(uncertIdx).toBeGreaterThan(structIdx);
    expect(retriIdx).toBeGreaterThan(uncertIdx);
    expect(dateIdx).toBeGreaterThan(retriIdx);
    expect(baseIdx).toBeGreaterThan(dateIdx);
  });

  it('contains all four shared instruction files content', () => {
    const result = buildSystemPrompt('base');

    expect(result).toContain('Structural Honesty');
    expect(result).toContain('Licensed Uncertainty');
    expect(result).toContain('Retrieval-First');
    expect(result).toContain('Relative Date');
  });

  it('contains the base prompt at the end', () => {
    const base = 'Custom agent instructions go here.';
    const result = buildSystemPrompt(base);

    expect(result).toContain(base);
    expect(result.endsWith(base)).toBe(true);
  });

  it('handles empty base prompt gracefully', () => {
    const result = buildSystemPrompt('');
    // Should still have the four blocks
    expect(result).toContain('Structural Honesty');
    expect(result).toContain('Licensed Uncertainty');
  });
});

describe('PROMPT_BLOCKS', () => {
  it('STRUCTURAL_HONESTY contains citation-or-silence rule', () => {
    expect(PROMPT_BLOCKS.STRUCTURAL_HONESTY).toContain('Citation-or-Silence');
  });

  it('LICENSED_UNCERTAINTY contains rewarded pattern', () => {
    expect(PROMPT_BLOCKS.LICENSED_UNCERTAINTY).toContain('The standard does not specify this');
  });

  it('RETRIEVAL_FIRST contains retrieval-before-assertion rule', () => {
    expect(PROMPT_BLOCKS.RETRIEVAL_FIRST).toContain('retrieve relevant source material BEFORE');
  });

  it('RELATIVE_DATE contains prohibition on absolute dates from memory', () => {
    expect(PROMPT_BLOCKS.RELATIVE_DATE).toContain('Never state absolute dates');
  });

  it('none of the blocks contain specific ISO clause numbers (factual-claim-free)', () => {
    // Blocks may mention the format "ISO XXXXX X.X.X" as an example pattern,
    // but must NOT state actual standard facts like "ISO 9001 4.1 requires..."
    const clausePattern =
      /ISO\s+(?:9001|14001|45001)\s+\d+\.\d+\s+(?:requires|states|specifies|mandates)/i;
    for (const [, content] of Object.entries(PROMPT_BLOCKS)) {
      expect(content).not.toMatch(clausePattern);
    }
  });
});

// ─── Parity: inline constants MUST match prompts/shared/*.md (single source) ─
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('prompt-library parity with prompts/shared/ (bundling-safety)', () => {
  const REPO_ROOT = resolve(__dirname, '../../..');
  const cases: Array<[keyof typeof PROMPT_BLOCKS, string]> = [
    ['STRUCTURAL_HONESTY', 'structural-honesty.md'],
    ['LICENSED_UNCERTAINTY', 'licensed-uncertainty.md'],
    ['RETRIEVAL_FIRST', 'retrieval-first.md'],
    ['RELATIVE_DATE', 'relative-date.md'],
  ];

  it.each(cases)('%s matches prompts/shared/%s verbatim', (constName, file) => {
    const fileContent = readFileSync(resolve(REPO_ROOT, 'prompts', 'shared', file), 'utf-8').trim();
    expect(PROMPT_BLOCKS[constName]).toBe(fileContent);
  });

  it('no block is empty (the runtime-read variant silently degraded to empty in Lambda)', () => {
    for (const v of Object.values(PROMPT_BLOCKS)) expect(v.length).toBeGreaterThan(100);
  });
});
