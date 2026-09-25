/**
 * Unit tests for the ISO KB content chunker (rewritten for iso-kb-content-depth).
 * D-4': Tests target chunkContentSources() — chunkIsoRequirementsMap is deleted.
 * T-1': Golden-SET fixture is AUTHORITATIVE (architect-derived, not content-derived).
 */

import { describe, it, expect } from 'vitest';
import { chunkContentSources, type ContentSource } from '../src/chunker.js';

// D-1: Build-time-equivalent static imports (vitest md-as-text plugin resolves these)
import iso9001Source from '../../../docs/kb/iso-9001.md';
import iso14001Source from '../../../docs/kb/iso-14001.md';
import iso45001Source from '../../../docs/kb/iso-45001.md';
import hlsSource from '../../../docs/kb/hls.md';

const CONTENT_SOURCES: ContentSource[] = [
  { source: iso9001Source, standard: 'ISO9001', stdNum: '9001' },
  { source: iso14001Source, standard: 'ISO14001', stdNum: '14001' },
  { source: iso45001Source, standard: 'ISO45001', stdNum: '45001' },
  { source: hlsSource, standard: 'HLS', stdNum: '' },
];

/**
 * T-1' AUTHORITATIVE FIXTURE — architect-derived, cross-checked vs live index
 * agg (50/26/32) AND clause-canon (108/108). Any change requires architect-
 * reviewed amendment with justification.
 */
const AUTHORITATIVE_CLAUSE_REFS: readonly string[] = [
  // ISO 9001 (50)
  'ISO 9001 4.1',
  'ISO 9001 4.2',
  'ISO 9001 4.3',
  'ISO 9001 4.4',
  'ISO 9001 5.1',
  'ISO 9001 5.2',
  'ISO 9001 5.3',
  'ISO 9001 6.1',
  'ISO 9001 6.2',
  'ISO 9001 6.3',
  'ISO 9001 7.1.1',
  'ISO 9001 7.1.2',
  'ISO 9001 7.1.3',
  'ISO 9001 7.1.4',
  'ISO 9001 7.1.5',
  'ISO 9001 7.1.6',
  'ISO 9001 7.2',
  'ISO 9001 7.3',
  'ISO 9001 7.4',
  'ISO 9001 7.5',
  'ISO 9001 8.1',
  'ISO 9001 8.2.1',
  'ISO 9001 8.2.2',
  'ISO 9001 8.2.3',
  'ISO 9001 8.2.4',
  'ISO 9001 8.3.1',
  'ISO 9001 8.3.2',
  'ISO 9001 8.3.3',
  'ISO 9001 8.3.4',
  'ISO 9001 8.3.5',
  'ISO 9001 8.3.6',
  'ISO 9001 8.4.1',
  'ISO 9001 8.4.2',
  'ISO 9001 8.4.3',
  'ISO 9001 8.5.1',
  'ISO 9001 8.5.2',
  'ISO 9001 8.5.3',
  'ISO 9001 8.5.4',
  'ISO 9001 8.5.5',
  'ISO 9001 8.5.6',
  'ISO 9001 8.6',
  'ISO 9001 8.7',
  'ISO 9001 9.1.1',
  'ISO 9001 9.1.2',
  'ISO 9001 9.1.3',
  'ISO 9001 9.2',
  'ISO 9001 9.3',
  'ISO 9001 10.1',
  'ISO 9001 10.2',
  'ISO 9001 10.3',
  // ISO 14001 (26)
  'ISO 14001 4.1',
  'ISO 14001 4.2',
  'ISO 14001 4.3',
  'ISO 14001 4.4',
  'ISO 14001 5.1',
  'ISO 14001 5.2',
  'ISO 14001 5.3',
  'ISO 14001 6.1.1',
  'ISO 14001 6.1.2',
  'ISO 14001 6.1.3',
  'ISO 14001 6.1.4',
  'ISO 14001 6.2',
  'ISO 14001 7.1',
  'ISO 14001 7.2',
  'ISO 14001 7.3',
  'ISO 14001 7.4',
  'ISO 14001 7.5',
  'ISO 14001 8.1',
  'ISO 14001 8.2',
  'ISO 14001 9.1.1',
  'ISO 14001 9.1.2',
  'ISO 14001 9.2',
  'ISO 14001 9.3',
  'ISO 14001 10.1',
  'ISO 14001 10.2',
  'ISO 14001 10.3',
  // ISO 45001 (32)
  'ISO 45001 4.1',
  'ISO 45001 4.2',
  'ISO 45001 4.3',
  'ISO 45001 4.4',
  'ISO 45001 5.1',
  'ISO 45001 5.2',
  'ISO 45001 5.3',
  'ISO 45001 5.4',
  'ISO 45001 6.1.1',
  'ISO 45001 6.1.2.1',
  'ISO 45001 6.1.2.2',
  'ISO 45001 6.1.2.3',
  'ISO 45001 6.1.3',
  'ISO 45001 6.1.4',
  'ISO 45001 6.2',
  'ISO 45001 7.1',
  'ISO 45001 7.2',
  'ISO 45001 7.3',
  'ISO 45001 7.4',
  'ISO 45001 7.5',
  'ISO 45001 8.1.1',
  'ISO 45001 8.1.2',
  'ISO 45001 8.1.3',
  'ISO 45001 8.1.4',
  'ISO 45001 8.2',
  'ISO 45001 9.1.1',
  'ISO 45001 9.1.2',
  'ISO 45001 9.2',
  'ISO 45001 9.3',
  'ISO 45001 10.1',
  'ISO 45001 10.2',
  'ISO 45001 10.3',
  // HLS (1)
  'Annex SL HLS',
] as const;

const EXPECTED_CHUNK_COUNT = 109; // 108 ISO + 1 HLS

describe('chunkContentSources', () => {
  const chunks = chunkContentSources(CONTENT_SOURCES);

  it('golden count = 109', () => {
    expect(chunks).toHaveLength(EXPECTED_CHUNK_COUNT);
  });

  it("golden-SET equality: clauseRef set === authoritative fixture (T-1')", () => {
    const actualRefs = new Set(chunks.map((c) => c.metadata.clauseRef));
    const expectedRefs = new Set(AUTHORITATIVE_CLAUSE_REFS);
    expect(actualRefs).toEqual(expectedRefs);
  });

  it('per-standard count pins: ISO9001=50, ISO14001=26, ISO45001=32, HLS=1', () => {
    const bySt = (std: string) => chunks.filter((c) => c.metadata.standard === std).length;
    expect(bySt('ISO9001')).toBe(50);
    expect(bySt('ISO14001')).toBe(26);
    expect(bySt('ISO45001')).toBe(32);
    expect(bySt('HLS')).toBe(1);
  });

  it('every ISO chunk text >= 200 chars (N-5: full text incl. prefix)', () => {
    const isoChunks = chunks.filter((c) => c.metadata.standard !== 'HLS');
    for (const chunk of isoChunks) {
      expect(chunk.text.length).toBeGreaterThanOrEqual(200);
    }
  });

  it('every ISO chunk starts with [ISO NNNN C.C] prefix', () => {
    const isoChunks = chunks.filter((c) => c.metadata.standard !== 'HLS');
    for (const chunk of isoChunks) {
      expect(chunk.text).toMatch(/^\[ISO \d{4,5} \d+(?:\.\d+)+\]/);
    }
  });

  it('HLS chunk starts with [Annex SL HLS] (R-4: NOT [ISO HLS)', () => {
    const hlsChunks = chunks.filter((c) => c.metadata.standard === 'HLS');
    expect(hlsChunks).toHaveLength(1);
    expect(hlsChunks[0].text).toMatch(/^\[Annex SL HLS\]/);
    expect(hlsChunks[0].text).not.toMatch(/^\[ISO HLS/);
  });

  it('every chunk has correct metadata fields', () => {
    for (const chunk of chunks) {
      expect(chunk.metadata.tenantId).toBe('__ISO_CANON__');
      expect(chunk.metadata.lang).toBe('en');
      expect(['ISO9001', 'ISO14001', 'ISO45001', 'HLS']).toContain(chunk.metadata.standard);
      expect(chunk.metadata.clauseRef).toBeTruthy();
    }
  });

  it('no empty guidance bodies', () => {
    for (const chunk of chunks) {
      // Each chunk should have content beyond just the prefix line
      const lines = chunk.text.split('\n');
      expect(lines.length).toBeGreaterThan(1);
      const body = lines.slice(1).join('\n').trim();
      expect(body.length).toBeGreaterThan(0);
    }
  });

  it('determinism: two calls yield identical output', () => {
    const first = chunkContentSources(CONTENT_SOURCES);
    const second = chunkContentSources(CONTENT_SOURCES);
    expect(first).toEqual(second);
  });
});
