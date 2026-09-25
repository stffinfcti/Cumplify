import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { esc } from '../template';

const SPECIALS = /[&<>"']/;
const RAW_UNSAFE = /<(?!\/)[^&]*>|&(?!amp;|lt;|gt;|quot;|#39;)/;

describe('esc (property-based)', () => {
  it('output never contains unescaped markup-unsafe characters', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const out = esc(s);
        expect(out).not.toMatch(RAW_UNSAFE);
        expect(out).not.toContain('<');
        expect(out).not.toContain('>');
      }),
    );
  });

  it('strings without special chars pass through unchanged', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !SPECIALS.test(s)),
        (s) => {
          expect(esc(s)).toBe(s);
        },
      ),
    );
  });

  it('esc is deterministic', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(esc(s)).toBe(esc(s));
      }),
    );
  });

  it('every special character in input produces an entity in output', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('&', '<', '>', '"', "'"),
        fc.string({ maxLength: 20 }),
        fc.string({ maxLength: 20 }),
        (special, pre, post) => {
          const out = esc(pre + special + post);
          expect(out).toMatch(/&(amp|lt|gt|quot|#39);/);
        },
      ),
    );
  });

  it('non-string input coerces without throwing', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.integer(), fc.boolean(), fc.constant(null), fc.constant(undefined)),
        (v) => {
          expect(() => esc(v)).not.toThrow();
        },
      ),
    );
  });
});
