/**
 * Unit tests for clause-ref parser.
 * Spec: iso-kb-content-depth, Task 1.
 */

import { describe, it, expect } from 'vitest';
import { parseClauseRef } from '../clause-ref-parser.js';

describe('parseClauseRef', () => {
  describe('Priority 1 — full ISO reference', () => {
    it('extracts "ISO 9001 4.1"', () => {
      const result = parseClauseRef('What does ISO 9001 4.1 require?');
      expect(result).toEqual({
        clauseRef: 'ISO 9001 4.1',
        standard: 'ISO9001',
        clauseNum: '4.1',
      });
    });

    it('extracts "ISO 14001:2015 clause 6.1.2"', () => {
      const result = parseClauseRef('Explain ISO 14001:2015 clause 6.1.2 requirements');
      expect(result).toEqual({
        clauseRef: 'ISO 14001 6.1.2',
        standard: 'ISO14001',
        clauseNum: '6.1.2',
      });
    });

    it('extracts "ISO 45001 6.1.2.1" (deep sub-clause)', () => {
      const result = parseClauseRef('How does ISO 45001 6.1.2.1 apply?');
      expect(result).toEqual({
        clauseRef: 'ISO 45001 6.1.2.1',
        standard: 'ISO45001',
        clauseNum: '6.1.2.1',
      });
    });

    it('extracts with "section" prefix: "ISO 9001:2015 section 8.3.4"', () => {
      const result = parseClauseRef('Tell me about ISO 9001:2015 section 8.3.4');
      expect(result).toEqual({
        clauseRef: 'ISO 9001 8.3.4',
        standard: 'ISO9001',
        clauseNum: '8.3.4',
      });
    });

    it('is case-insensitive: "iso 9001 4.1"', () => {
      const result = parseClauseRef('What does iso 9001 4.1 mean?');
      expect(result).toEqual({
        clauseRef: 'ISO 9001 4.1',
        standard: 'ISO9001',
        clauseNum: '4.1',
      });
    });
  });

  describe('Priority 2 — labeled reference (no standard)', () => {
    it('extracts "clause 4.1"', () => {
      const result = parseClauseRef('What does clause 4.1 require?');
      expect(result).toEqual({
        clauseRef: null,
        standard: null,
        clauseNum: '4.1',
      });
    });

    it('extracts "section 7.1.5.2"', () => {
      const result = parseClauseRef('Explain section 7.1.5.2');
      expect(result).toEqual({
        clauseRef: null,
        standard: null,
        clauseNum: '7.1.5.2',
      });
    });

    it('is case-insensitive: "Clause 10.2"', () => {
      const result = parseClauseRef('What is Clause 10.2 about?');
      expect(result).toEqual({
        clauseRef: null,
        standard: null,
        clauseNum: '10.2',
      });
    });
  });

  describe('Priority 3 — bare clause number', () => {
    it('extracts bare "4.1"', () => {
      const result = parseClauseRef('Tell me about 4.1');
      expect(result).toEqual({
        clauseRef: null,
        standard: null,
        clauseNum: '4.1',
      });
    });

    it('extracts "8.3.6" (deep bare number)', () => {
      const result = parseClauseRef('What is 8.3.6?');
      expect(result).toEqual({
        clauseRef: null,
        standard: null,
        clauseNum: '8.3.6',
      });
    });

    it('does NOT match numbers outside clause range (3.1)', () => {
      const result = parseClauseRef('Version 3.1 of the software');
      expect(result).toEqual({
        clauseRef: null,
        standard: null,
        clauseNum: null,
      });
    });
  });

  describe('N-1 — false-positive awareness', () => {
    it('"improve efficiency by 4.1 percent" → clauseNum="4.1" (known, safe via fallback)', () => {
      const result = parseClauseRef('We need to improve efficiency by 4.1 percent');
      expect(result.clauseNum).toBe('4.1');
      // This is a known false positive — RETRIEVAL-2f fallback makes it safe
      expect(result.clauseRef).toBeNull();
      expect(result.standard).toBeNull();
    });
  });

  describe("D-3' — cross-standard: parsed standard wins", () => {
    it('"ISO 14001 4.1" → standard="ISO14001" (not the guru\'s own ISO9001)', () => {
      // When ISO9001Guru receives this question, the PARSER returns ISO14001.
      // The guru handler must use parsed.standard, not override with its own.
      const result = parseClauseRef('What does ISO 14001 4.1 require?');
      expect(result.standard).toBe('ISO14001');
      expect(result.clauseRef).toBe('ISO 14001 4.1');
    });
  });

  describe('RETRIEVAL-1c — first match wins', () => {
    it('multiple refs: returns first one', () => {
      const result = parseClauseRef('Compare ISO 9001 4.1 and ISO 14001 4.2');
      expect(result).toEqual({
        clauseRef: 'ISO 9001 4.1',
        standard: 'ISO9001',
        clauseNum: '4.1',
      });
    });
  });

  describe('No match', () => {
    it('topic question returns all null', () => {
      const result = parseClauseRef('How do I improve quality in my organization?');
      expect(result).toEqual({
        clauseRef: null,
        standard: null,
        clauseNum: null,
      });
    });

    it('empty string returns all null', () => {
      const result = parseClauseRef('');
      expect(result).toEqual({
        clauseRef: null,
        standard: null,
        clauseNum: null,
      });
    });
  });
});
