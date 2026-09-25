import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { parseClauseRef } from '../clause-ref-parser';

const stdArb = fc.constantFrom('9001', '14001', '45001');
const clauseNumArb = fc
  .tuple(
    fc.integer({ min: 4, max: 10 }),
    fc.array(fc.integer({ min: 0, max: 99 }), { minLength: 1, maxLength: 3 }),
  )
  .map(([head, tail]) => [head, ...tail].join('.'));

describe('parseClauseRef (property-based)', () => {
  it('never throws on arbitrary input and is deterministic', () => {
    fc.assert(
      fc.property(fc.string(), (q) => {
        const first = parseClauseRef(q);
        const second = parseClauseRef(q);
        expect(first).toEqual(second);
      }),
    );
  });

  it('full ISO reference always yields clauseRef + standard + clauseNum', () => {
    fc.assert(
      fc.property(stdArb, clauseNumArb, (std, clause) => {
        const r = parseClauseRef(`what does ISO ${std} ${clause} require`);
        expect(r.clauseRef).toBe(`ISO ${std} ${clause}`);
        expect(r.standard).toBe(`ISO${std}`);
        expect(r.clauseNum).toBe(clause);
      }),
    );
  });

  it('labeled clause reference yields clauseNum with no standard', () => {
    fc.assert(
      fc.property(fc.constantFrom('clause', 'section'), clauseNumArb, (label, clause) => {
        const r = parseClauseRef(`explain ${label} ${clause} please`);
        expect(r.standard).toBeNull();
        expect(r.clauseRef).toBeNull();
        expect(r.clauseNum).toBe(clause);
      }),
    );
  });

  it('invariant: clauseRef non-null implies standard and clauseNum non-null', () => {
    fc.assert(
      fc.property(fc.string(), (q) => {
        const r = parseClauseRef(q);
        if (r.clauseRef !== null) {
          expect(r.standard).not.toBeNull();
          expect(r.clauseNum).not.toBeNull();
        }
      }),
    );
  });

  it('round-trip: a generated clauseRef re-parses to the same standard + clauseNum', () => {
    fc.assert(
      fc.property(stdArb, clauseNumArb, (std, clause) => {
        const first = parseClauseRef(`ISO ${std} ${clause}`);
        const second = parseClauseRef(`see ${first.clauseRef}`);
        expect(second.standard).toBe(first.standard);
        expect(second.clauseNum).toBe(first.clauseNum);
      }),
    );
  });
});
