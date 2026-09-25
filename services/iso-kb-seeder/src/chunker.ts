/**
 * Deterministic ISO KB content chunker.
 * Pure function — no I/O, no side effects.
 * Spec: iso-kb-content-depth, design §2.3.
 *
 * Parses per-standard content files (docs/kb/*.md) into discrete retrieval chunks,
 * one per sub-clause entry (1:1 clauseRef mapping, OQ-2 resolved).
 *
 * D-4': chunkIsoRequirementsMap is DELETED. The old iso-requirements-map.md is no
 * longer KB authority (OQ-1b). This file replaces the original chunker entirely.
 */

import { ISO_CANON_TENANT_ID } from '../../agents/shared/constants.js';

export type Standard = 'ISO9001' | 'ISO14001' | 'ISO45001' | 'HLS';

export interface ChunkMetadata {
  tenantId: string;
  standard: Standard;
  clauseRef: string;
  lang: string;
}

export interface Chunk {
  text: string;
  metadata: ChunkMetadata;
}

export interface ContentSource {
  /** Raw markdown content (esbuild text-loader inline) */
  source: string;
  /** Standard identifier */
  standard: Standard;
  /** Standard number for prefix composition ('9001', '14001', '45001', or '' for HLS) */
  stdNum: string;
}

/**
 * Chunk multiple content source files into retrieval units.
 * One chunk per entry (1:1 clauseRef mapping, OQ-2 resolved).
 * Deterministic: same inputs → same output (CONTENT-2d).
 *
 * @param sources - Array of content source descriptors (one per file)
 * @returns Array of chunks ready for embedding and indexing
 */
export function chunkContentSources(sources: ContentSource[]): Chunk[] {
  const chunks: Chunk[] = [];
  for (const src of sources) {
    if (src.standard === 'HLS') {
      chunks.push(...parseHlsSource(src.source));
    } else {
      chunks.push(...parseStandardSource(src.source, src.standard, src.stdNum));
    }
  }
  return chunks;
}

/**
 * Parse a per-standard content file into chunks.
 * Format: entries separated by blank lines; first line matches [ISO NNNN X.Y] title.
 */
function parseStandardSource(source: string, standard: Standard, stdNum: string): Chunk[] {
  const chunks: Chunk[] = [];
  const entries = splitEntries(source);

  for (const entry of entries) {
    const lines = entry.split('\n');
    const firstLine = lines[0];

    // Match prefix: [ISO NNNN X.Y.Z] Title
    const match = firstLine.match(/^\[ISO\s+\d{4,5}\s+(\d+(?:\.\d+)+)\]\s+(.+)$/);
    if (!match) continue; // Skip non-entry blocks (comments, etc.)

    const clauseNum = match[1];
    const guidanceBody = lines.slice(1).join('\n').trim();

    // Compose chunk text: prefix line + newline + guidance body
    const text = guidanceBody ? `${firstLine}\n${guidanceBody}` : firstLine;

    chunks.push({
      text,
      metadata: {
        tenantId: ISO_CANON_TENANT_ID,
        standard,
        clauseRef: `ISO ${stdNum} ${clauseNum}`,
        lang: 'en',
      },
    });
  }

  return chunks;
}

/**
 * Parse the HLS content file (single entry).
 * Format: [Annex SL HLS] Title followed by guidance body.
 */
function parseHlsSource(source: string): Chunk[] {
  const entries = splitEntries(source);
  const chunks: Chunk[] = [];

  for (const entry of entries) {
    const lines = entry.split('\n');
    const firstLine = lines[0];

    // Match prefix: [Annex SL HLS] Title
    const match = firstLine.match(/^\[Annex SL HLS\]\s+(.+)$/);
    if (!match) continue;

    const guidanceBody = lines.slice(1).join('\n').trim();
    const text = guidanceBody ? `${firstLine}\n${guidanceBody}` : firstLine;

    chunks.push({
      text,
      metadata: {
        tenantId: ISO_CANON_TENANT_ID,
        standard: 'HLS',
        clauseRef: 'Annex SL HLS',
        lang: 'en',
      },
    });
  }

  return chunks;
}

/**
 * Split source text into entry blocks separated by blank lines.
 * Handles both \n\n and \r\n\r\n separators.
 */
function splitEntries(source: string): string[] {
  return source
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
}
