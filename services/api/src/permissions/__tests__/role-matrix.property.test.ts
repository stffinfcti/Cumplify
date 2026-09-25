import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { canApprove, getApprovalModules, normalizeRole, KNOWN_ROLES } from '../role-matrix';

const roleArb = fc.constantFrom(...KNOWN_ROLES);
const unknownRoleArb = fc.string({ minLength: 1 }).filter((s) => !KNOWN_ROLES.includes(s));
const moduleArb = fc.string({ minLength: 1 });

describe('role-matrix (property-based)', () => {
  it('deny by default: unknown roles can never approve any module', () => {
    fc.assert(
      fc.property(unknownRoleArb, moduleArb, (role, module) => {
        expect(canApprove(role, module)).toBe(false);
        expect(getApprovalModules(role)).toEqual([]);
      }),
    );
  });

  it('canApprove iff module is in the role approval set', () => {
    fc.assert(
      fc.property(roleArb, moduleArb, (role, module) => {
        expect(canApprove(role, module)).toBe(getApprovalModules(role).includes(module));
      }),
    );
  });

  it('normalizeRole is deterministic and idempotent', () => {
    fc.assert(
      fc.property(fc.string(), (role) => {
        const once = normalizeRole(role);
        expect(normalizeRole(role)).toBe(once);
        expect(normalizeRole(once)).toBe(once);
      }),
    );
  });

  it('module coverage is consistent: every approvable module round-trips', () => {
    fc.assert(
      fc.property(roleArb, (role) => {
        for (const m of getApprovalModules(role)) {
          expect(canApprove(role, m)).toBe(true);
        }
      }),
    );
  });
});
