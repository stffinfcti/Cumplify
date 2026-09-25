import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { resolveExemptFlag } from '../exempt-principals';

const SYSTEM_AGENTS = ['iso-kb-seeder', 'TenantDocsIndexer'] as const;
const flagArb = fc.constantFrom('creditExempt' as const, 'systemOp' as const);
const nonSystemAgentArb = fc
  .string({ minLength: 1 })
  .filter((s) => !SYSTEM_AGENTS.includes(s as (typeof SYSTEM_AGENTS)[number]));

describe('resolveExemptFlag (property-based)', () => {
  it('unrequested flag is always false for any caller', () => {
    fc.assert(
      fc.property(fc.string(), flagArb, (agent, flag) => {
        expect(resolveExemptFlag(undefined, agent, flag)).toBe(false);
        expect(resolveExemptFlag(false, agent, flag)).toBe(false);
      }),
    );
  });

  it('non-system principals can never hold the flag, however they ask', () => {
    fc.assert(
      fc.property(nonSystemAgentArb, flagArb, (agent, flag) => {
        expect(resolveExemptFlag(true, agent, flag)).toBe(false);
      }),
    );
  });

  it('system principals get exactly the requested value', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SYSTEM_AGENTS),
        flagArb,
        fc.boolean(),
        (agent, flag, requested) => {
          expect(resolveExemptFlag(requested, agent, flag)).toBe(requested);
        },
      ),
    );
  });
});
