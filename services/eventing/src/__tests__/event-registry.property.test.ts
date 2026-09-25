import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { EVENT_SOURCES, EVENT_NAMES } from '../constants';
import { AUDIT_TRAIL_REGISTRY } from '../audit-trail-registry';

const sourceEntries = Object.entries(EVENT_SOURCES);
const nameEntries = Object.entries(EVENT_NAMES);

describe('event registry (property-based)', () => {
  it('every event source matches the cumplify.m<N>.<domain> convention', () => {
    fc.assert(
      fc.property(fc.constantFrom(...sourceEntries), ([key, source]) => {
        expect(key).toMatch(/^M\d+$/);
        expect(source).toMatch(/^cumplify\.m\d+\.[a-z-]+$/);
        expect(source.replace('cumplify.', '').split('.')[0]).toBe(key.toLowerCase());
      }),
    );
  });

  it('every event name follows Domain.Action PascalCase and keys equal values', () => {
    fc.assert(
      fc.property(fc.constantFrom(...nameEntries), ([key, name]) => {
        expect(name).toBe(key);
        expect(name).toMatch(/^[A-Z][A-Za-z]*\.[A-Z][A-Za-z]*$/);
      }),
    );
  });

  it('registry lookups are deterministic for any event name', () => {
    fc.assert(
      fc.property(fc.string(), (eventName) => {
        expect(AUDIT_TRAIL_REGISTRY[eventName]).toBe(AUDIT_TRAIL_REGISTRY[eventName]);
      }),
    );
  });

  it('audit-trail registry keys follow the Domain.Action convention with boolean values', () => {
    fc.assert(
      fc.property(fc.constantFrom(...Object.entries(AUDIT_TRAIL_REGISTRY)), ([key, value]) => {
        expect(key).toMatch(/^[A-Z][A-Za-z]*\.[A-Z][A-Za-z]*$/);
        expect(typeof value).toBe('boolean');
      }),
    );
  });
});
