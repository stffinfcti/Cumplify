/**
 * Property-based tests for PreTokenGeneration Lambda handler.
 * Per 13-testing.md: property-based tests mandatory on services/* code.
 *
 * Properties verified:
 * 1. Output always contains valid token claims (tenantId, role, poolClass)
 * 2. Role is never empty — either group-derived or 'Employee' fallback
 * 3. TenantId passthrough: whatever is in userAttributes appears in claims
 * 4. No exceptions thrown for any valid input shape
 * 5. resolvePoolClass returns known value or 'unknown' given a map
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  handler,
  resolveRole,
  resolvePoolClass,
  buildClaims,
  type PreTokenGenEvent,
} from './index.js';

// Arbitrary generators
const tenantIdArb = fc.oneof(fc.stringMatching(/^tnt-[a-z0-9]{3,20}$/), fc.constant(undefined));

const groupArb = fc.stringMatching(/^[A-Z][a-zA-Z]{2,30}$/);

const groupsArb = fc.oneof(
  fc.array(groupArb, { minLength: 1, maxLength: 5 }),
  fc.constant(undefined),
  fc.constant([] as string[]),
);

const userPoolIdArb = fc.stringMatching(/^us-east-1_[A-Za-z0-9]{8,12}$/);

function buildEvent(
  tenantId: string | undefined,
  groups: string[] | undefined,
  userPoolId: string,
): PreTokenGenEvent {
  return {
    request: {
      userAttributes: {
        ...(tenantId !== undefined ? { 'custom:tenantId': tenantId } : {}),
        email: 'test@example.com',
      },
      groupConfiguration: {
        groupsToOverride: groups,
      },
    },
    response: {},
    callerContext: { clientId: 'test-client-id' },
    userPoolId,
    userName: 'test-user',
  };
}

describe('PreTokenGen handler (property-based)', () => {
  // Set SSM param env to empty — handler will use empty map (no SSM call in tests)
  // resolvePoolClass falls back to 'unknown' when map is empty
  it('always produces valid claims structure for any input', async () => {
    // Remove POOL_CLASS_MAP_PARAM so handler uses empty cache
    delete process.env.POOL_CLASS_MAP_PARAM;

    await fc.assert(
      fc.asyncProperty(tenantIdArb, groupsArb, userPoolIdArb, async (tenantId, groups, poolId) => {
        const event = buildEvent(tenantId, groups, poolId);
        const result = await handler(event);

        // Claims structure must exist
        expect(result.response.claimsOverrideDetails).toBeDefined();
        expect(result.response.claimsOverrideDetails!.claimsToAddOrOverride).toBeDefined();

        const claims = result.response.claimsOverrideDetails!.claimsToAddOrOverride!;

        // All three custom claims must be present
        expect(claims).toHaveProperty('custom:tenantId');
        expect(claims).toHaveProperty('custom:role');
        expect(claims).toHaveProperty('custom:poolClass');

        // Role is never empty
        expect(claims['custom:role'].length).toBeGreaterThan(0);
      }),
    );
  });

  it('tenantId in claims matches userAttributes passthrough', async () => {
    delete process.env.POOL_CLASS_MAP_PARAM;

    await fc.assert(
      fc.asyncProperty(tenantIdArb, groupsArb, userPoolIdArb, async (tenantId, groups, poolId) => {
        const event = buildEvent(tenantId, groups, poolId);
        const result = await handler(event);
        const claims = result.response.claimsOverrideDetails!.claimsToAddOrOverride!;

        // tenantId should pass through exactly (or empty if undefined)
        expect(claims['custom:tenantId']).toBe(tenantId ?? '');
      }),
    );
  });

  it('role is one of the groups and deterministic for the same input', () => {
    fc.assert(
      fc.property(fc.array(groupArb, { minLength: 1, maxLength: 5 }), (groups) => {
        const first = resolveRole(groups);
        const second = resolveRole(groups);
        expect(groups).toContain(first.role);
        expect(first.role).toBe(second.role);
        expect(first.fallback).toBe(false);
      }),
    );
  });

  it('multi-group users get the highest-priority role regardless of group order', () => {
    expect(resolveRole(['Employee', 'PlatformAdmin']).role).toBe('PlatformAdmin');
    expect(resolveRole(['PlatformAdmin', 'Employee']).role).toBe('PlatformAdmin');
    expect(resolveRole(['Contractor', 'TopManagement', 'Employee']).role).toBe('TopManagement');
    expect(resolveRole(['Employee', 'ExternalAuditor']).role).toBe('Employee');
  });

  it('duplicate groups in the input do not affect role resolution', () => {
    expect(resolveRole(['PlatformAdmin', 'PlatformAdmin']).role).toBe('PlatformAdmin');
    expect(resolveRole(['Employee', 'Employee', 'Contractor']).role).toBe('Contractor');
  });

  it('role falls back to Employee when groups are empty or undefined', () => {
    fc.assert(
      fc.property(fc.oneof(fc.constant(undefined), fc.constant([] as string[])), (groups) => {
        const { role, fallback } = resolveRole(groups);
        expect(role).toBe('Employee');
        expect(fallback).toBe(true);
      }),
    );
  });

  it('resolvePoolClass returns mapped value or unknown given explicit map', async () => {
    const testMap = {
      'us-east-1_Pool1': 'internal',
      'us-east-1_Pool2': 'tenant-admin',
      'us-east-1_Pool3': 'tenant-user',
    };

    await fc.assert(
      fc.asyncProperty(userPoolIdArb, async (poolId) => {
        const poolClass = await resolvePoolClass(poolId, testMap);
        expect(typeof poolClass).toBe('string');
        expect(poolClass.length).toBeGreaterThan(0);
        // Must be one of the mapped values or 'unknown'
        expect(['internal', 'tenant-admin', 'tenant-user', 'unknown']).toContain(poolClass);
      }),
    );
  });

  it('buildClaims always returns exactly 3 keys', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.constant(undefined)),
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        (tenantId, role, poolClass) => {
          const claims = buildClaims(tenantId, role, poolClass);
          expect(Object.keys(claims)).toHaveLength(3);
          expect(claims['custom:tenantId']).toBe(tenantId ?? '');
          expect(claims['custom:role']).toBe(role);
          expect(claims['custom:poolClass']).toBe(poolClass);
        },
      ),
    );
  });
});
