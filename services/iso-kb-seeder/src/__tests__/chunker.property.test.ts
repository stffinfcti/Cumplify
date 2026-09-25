import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { chunkContentSources, type ContentSource, type Standard } from '../chunker';

const stdArb = fc
  .tuple(
    fc.constantFrom('ISO9001', 'ISO14001', 'ISO45001') as fc.Arbitrary<Standard>,
    fc.constantFrom('9001', '14001', '45001'),
  )
  .filter(([std, num]) => std === `ISO${num}`);

const clauseNumArb = fc
  .tuple(
    fc.integer({ min: 4, max: 10 }),
    fc.array(fc.integer({ min: 0, max: 99 }), { minLength: 1, maxLength: 3 }),
  )
  .map(([h, t]) => [h, ...t].join('.'));

const titleArb = fc
  .string({ minLength: 1, maxLength: 60 })
  .filter((s) => !s.includes('\n') && s.trim().length > 0);
const bodyArb = fc
  .array(
    fc.string({ maxLength: 60 }).filter((s) => !s.includes('\n\n')),
    { maxLength: 4 },
  )
  .map((ls) => ls.join('\n'));

const entryArb = fc
  .tuple(stdArb, clauseNumArb, titleArb, bodyArb)
  .map(([[, num], clause, title, body]) => {
    const first = `[ISO ${num} ${clause}] ${title}`;
    return { clause, num, source: body ? `${first}\n${body}` : first };
  });

const sourceArb = fc
  .tuple(stdArb, fc.array(entryArb, { minLength: 1, maxLength: 8 }))
  .map(([[std, num], entries]) => {
    const src: ContentSource = {
      source: entries.map((e) => e.source).join('\n\n'),
      standard: std,
      stdNum: num,
    };
    return { src, entries };
  });

describe('chunkContentSources (property-based)', () => {
  it('parses every well-formed entry into exactly one chunk', () => {
    fc.assert(
      fc.property(fc.array(sourceArb, { minLength: 1, maxLength: 4 }), (sources) => {
        const chunks = chunkContentSources(sources.map((s) => s.src));
        expect(chunks.length).toBe(sources.reduce((n, s) => n + s.entries.length, 0));
      }),
    );
  });

  it('every chunk carries full metadata: canonical tenant, standard, clauseRef, lang', () => {
    fc.assert(
      fc.property(fc.array(sourceArb, { minLength: 1, maxLength: 4 }), (sources) => {
        const chunks = chunkContentSources(sources.map((s) => s.src));
        const expected = sources.flatMap((s) =>
          s.entries.map((e) => ({ std: s.src.standard, num: s.src.stdNum, clause: e.clause })),
        );
        chunks.forEach((c, i) => {
          expect(c.text.length).toBeGreaterThan(0);
          expect(c.metadata.standard).toBe(expected[i].std);
          expect(c.metadata.clauseRef).toBe(`ISO ${expected[i].num} ${expected[i].clause}`);
          expect(c.metadata.lang).toBe('en');
          expect(c.metadata.tenantId).toBeTruthy();
        });
      }),
    );
  });

  it('chunking is deterministic', () => {
    fc.assert(
      fc.property(fc.array(sourceArb, { minLength: 1, maxLength: 4 }), (sources) => {
        const input = sources.map((s) => s.src);
        expect(chunkContentSources(input)).toEqual(chunkContentSources(input));
      }),
    );
  });

  it('arbitrary malformed content never throws and yields only well-formed chunks', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const chunks = chunkContentSources([{ source: raw, standard: 'ISO9001', stdNum: '9001' }]);
        for (const c of chunks) {
          expect(c.text.startsWith('[ISO')).toBe(true);
          expect(c.metadata.clauseRef).toMatch(/^ISO 9001 \d+(\.\d+)+$/);
        }
      }),
    );
  });
});
