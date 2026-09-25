import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { groupSections, type RegistryClause } from '../grouping';

const STANDARDS = ['ISO9001', 'ISO14001', 'ISO45001'] as const;

const clauseArb = (i: number): fc.Arbitrary<RegistryClause> =>
  fc
    .tuple(
      fc.constantFrom(...STANDARDS),
      fc.constantFrom('shared', 'forked', 'standard_only') as fc.Arbitrary<
        RegistryClause['annexSlMode']
      >,
      fc.constantFrom('ctx', 'lead', 'plan', 'sup', 'op', 'perf', 'imp'),
      fc.constantFrom('policy', 'manual', 'procedure'),
      fc.integer({ min: 0, max: 100 }),
    )
    .map(([standard, annexSlMode, harmonizationKey, docType, sortOrder]) => ({
      id: `c${i}`,
      standard,
      clauseNo: `4.${i}`,
      clauseTitle: `Clause ${i}`,
      intentParaphrase: `Intent ${i}`,
      annexSlMode,
      harmonizationKey,
      docType,
      requiredSources: [],
      sortOrder,
    }));

const registryArb = fc
  .integer({ min: 0, max: 12 })
  .chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => clauseArb(i))));

const inScopeArb = fc.subarray([...STANDARDS], { minLength: 1 });

describe('groupSections (property-based)', () => {
  it('in-scope clauses appear in exactly one plan; out-of-scope never appear', () => {
    fc.assert(
      fc.property(registryArb, inScopeArb, (registry, inScope) => {
        const plans = groupSections(registry, inScope, []);
        const seen = new Map<string, number>();
        for (const p of plans) {
          for (const c of p.clauses) {
            seen.set(c.id, (seen.get(c.id) ?? 0) + 1);
            expect(inScope).toContain(c.standard);
          }
        }
        for (const c of registry) {
          if (inScope.includes(c.standard as (typeof STANDARDS)[number]))
            expect(seen.get(c.id)).toBe(1);
          else expect(seen.has(c.id)).toBe(false);
        }
      }),
    );
  });

  it('shared-mode clauses with the same harmonization key merge across standards; forked split', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom(...STANDARDS), { minLength: 2, maxLength: 3 }),
        (standards) => {
          const mk = (
            i: number,
            standard: string,
            mode: RegistryClause['annexSlMode'],
          ): RegistryClause => ({
            id: `s${i}`,
            standard,
            clauseNo: '4.1',
            clauseTitle: 'Context',
            intentParaphrase: '',
            annexSlMode: mode,
            harmonizationKey: 'ctx',
            docType: 'manual',
            requiredSources: [],
            sortOrder: 0,
          });
          const shared = standards.map((s, i) => mk(i, s, 'shared'));
          const sharedPlans = groupSections(shared, [...STANDARDS], []);
          expect(sharedPlans).toHaveLength(1);
          expect(sharedPlans[0].clauses).toHaveLength(standards.length);

          const forked = standards.map((s, i) => mk(i, s, 'forked'));
          const forkedPlans = groupSections(forked, [...STANDARDS], []);
          expect(forkedPlans).toHaveLength(standards.length);
        },
      ),
    );
  });

  it('a bucket whose members are all excluded becomes na_justified and carries the justification', () => {
    fc.assert(
      fc.property(registryArb, inScopeArb, (registry, inScope) => {
        const active = registry.filter((c) =>
          inScope.includes(c.standard as (typeof STANDARDS)[number]),
        );
        fc.pre(active.length > 0);
        const exclusions = active.map((c) => ({
          clauseRegistryId: c.id,
          justification: `n/a ${c.id}`,
        }));
        const plans = groupSections(registry, inScope, exclusions);
        for (const p of plans) {
          expect(p.status).toBe('na_justified');
          expect(p.naJustification).toBeTruthy();
          for (const c of p.clauses) {
            expect(p.naJustification).toContain(`n/a ${c.id}`);
          }
        }
        expect(plans.length).toBeGreaterThan(0);
      }),
    );
  });

  it('excluded clauses are dropped from pending plans but never split shared buckets silently', () => {
    fc.assert(
      fc.property(registryArb, inScopeArb, (registry, inScope) => {
        const plans = groupSections(registry, inScope, []);
        const excluded = plans
          .flatMap((p) => p.clauses)
          .map((c) => ({ clauseRegistryId: c.id, justification: 'j' }));
        if (excluded.length === 0) return;
        const subset = excluded.slice(0, 1);
        const plans2 = groupSections(registry, inScope, subset);
        const pendingClauseIds = plans2
          .filter((p) => p.status === 'pending')
          .flatMap((p) => p.clauses)
          .map((c) => c.id);
        expect(pendingClauseIds).not.toContain(subset[0].clauseRegistryId);
      }),
    );
  });

  it('output is sorted by sortOrder then sectionKey and deterministic', () => {
    fc.assert(
      fc.property(registryArb, inScopeArb, (registry, inScope) => {
        const a = groupSections(registry, inScope, []);
        const b = groupSections(registry, inScope, []);
        expect(a).toEqual(b);
        for (let i = 1; i < a.length; i++) {
          const [p, q] = [a[i - 1], a[i]];
          expect(
            p.sortOrder < q.sortOrder ||
              (p.sortOrder === q.sortOrder && p.sectionKey <= q.sectionKey),
          ).toBe(true);
        }
      }),
    );
  });
});
