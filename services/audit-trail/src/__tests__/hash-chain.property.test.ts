import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { computePayloadHash, computePrevHash, GENESIS_HASH } from '../hash-chain';

const jsonValueArb: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  base: fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
  container: fc.oneof(
    fc.array(tie('node'), { maxLength: 8 }),
    fc.dictionary(fc.string({ minLength: 1 }), tie('node'), { maxKeys: 8 }),
  ),
  node: fc.oneof(tie('base'), tie('container')),
})).node;

const payloadArb = fc.dictionary(fc.string({ minLength: 1 }), jsonValueArb, {
  minKeys: 1,
  maxKeys: 12,
}) as fc.Arbitrary<Record<string, unknown>>;

describe('hash-chain (property-based)', () => {
  it('payload hash is deterministic', () => {
    fc.assert(
      fc.property(payloadArb, (payload) => {
        expect(computePayloadHash(payload)).toBe(computePayloadHash(payload));
      }),
    );
  });

  it('payload hash is insensitive to top-level key insertion order', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1 }), { minLength: 2, maxLength: 10 }),
        jsonValueArb,
        (keys, v) => {
          const a: Record<string, unknown> = {};
          const b: Record<string, unknown> = {};
          keys.forEach((k) => (a[k] = v));
          [...keys].reverse().forEach((k) => (b[k] = v));
          expect(computePayloadHash(a)).toBe(computePayloadHash(b));
        },
      ),
    );
  });

  it('any mutation inside before/after changes the hash', () => {
    fc.assert(
      fc.property(jsonValueArb, jsonValueArb, fc.string({ minLength: 1 }), (before, after, tag) => {
        const base = { before, after };
        const tamperedAfter = { before, after: { tampered: tag, original: after } };
        const tamperedBefore = { before: { tampered: tag, original: before }, after };
        const h = computePayloadHash(base);
        expect(computePayloadHash(tamperedAfter)).not.toBe(h);
        expect(computePayloadHash(tamperedBefore)).not.toBe(h);
      }),
    );
  });

  it('prev-hash is deterministic and sensitive to every input', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.string(), fc.string(), (pk, sk, ph, other) => {
        const h = computePrevHash(pk, sk, ph);
        expect(h).toBe(computePrevHash(pk, sk, ph));
        if (ph !== other) expect(h).not.toBe(computePrevHash(pk, sk, other));
        if (pk !== GENESIS_HASH || sk !== GENESIS_HASH || ph !== GENESIS_HASH) {
          expect(h).not.toBe(computePrevHash(GENESIS_HASH, GENESIS_HASH, GENESIS_HASH));
        }
      }),
    );
  });
});
