/**
 * Unit tests for the Lambda authorizer.
 * Tests cover: Pool B/C acceptance, Pool A rejection (Layer 1), expired tokens,
 * missing tenantId, bad signatures, ID-token-only enforcement.
 *
 * Strategy: mock `jose` jwtVerify + DynamoDB GetItem to isolate authorizer logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Set env FIRST (before any mocked module initialization)
vi.hoisted(() => {
  process.env.POOL_B_ID = 'us-east-1_PoolBxxx';
  process.env.POOL_C_ID = 'us-east-1_PoolCxxx';
  process.env.POOL_B_CLIENT_IDS = 'client-b-1,client-b-2';
  process.env.POOL_C_CLIENT_IDS = 'client-c-1';
  process.env.TABLE_NAME = 'CumplifyCore';
  process.env.REGION = 'us-east-1';
});

// Mock jose before importing authorizer
vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => vi.fn()),
  jwtVerify: vi.fn(),
}));

// Mock DynamoDB — use vi.hoisted to ensure mockDdbSend is available in factory
const { mockDdbSend } = vi.hoisted(() => {
  const mockDdbSend = vi.fn();
  return { mockDdbSend };
});

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class MockDDB {
    send = mockDdbSend;
  },
  GetItemCommand: class MockGetItem {
    constructor(public input: unknown) {}
  },
}));

import { handler } from '../src/authorizer.js';
import { jwtVerify } from 'jose';

const mockedJwtVerify = vi.mocked(jwtVerify);

const baseEvent = {
  authorizationToken: 'Bearer valid-token',
  requestContext: { apiId: 'test-api', accountId: '123', requestId: 'req-1' },
};

const validPoolBClaims = {
  sub: 'user-123',
  iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_PoolBxxx',
  token_use: 'id',
  'custom:tenantId': 'tenant-abc',
  'custom:role': 'QualityManager',
  'custom:poolClass': 'tenant-admin',
  'cognito:groups': ['QualityManager'],
  exp: Math.floor(Date.now() / 1000) + 3600,
};

const validPoolCClaims = {
  ...validPoolBClaims,
  iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_PoolCxxx',
  'custom:poolClass': 'tenant-user',
  'custom:role': 'Employee',
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default DDB response (entitlement)
  mockDdbSend.mockResolvedValue({
    Item: {
      plan: { S: 'Pro' },
      seats: { N: '25' },
      features: { SS: ['advanced-reporting'] },
    },
  });
});

describe('Lambda Authorizer', () => {
  it('should authorize a valid Pool B token', async () => {
    mockedJwtVerify.mockResolvedValueOnce({
      payload: validPoolBClaims,
      protectedHeader: { alg: 'RS256' },
    } as never);

    const result = await handler(baseEvent);

    expect(result.isAuthorized).toBe(true);
    expect(result.resolverContext).toMatchObject({
      tenantId: 'tenant-abc',
      role: 'QualityManager',
      poolClass: 'tenant-admin',
      sub: 'user-123',
    });
    expect(JSON.parse(result.resolverContext!.entitlement)).toMatchObject({
      plan: 'Pro',
      seats: 25,
    });
  });

  it('should authorize a valid Pool C token', async () => {
    // Pool B fails, Pool C succeeds
    mockedJwtVerify.mockRejectedValueOnce(new Error('issuer mismatch')).mockResolvedValueOnce({
      payload: validPoolCClaims,
      protectedHeader: { alg: 'RS256' },
    } as never);

    const result = await handler(baseEvent);

    expect(result.isAuthorized).toBe(true);
    expect(result.resolverContext?.poolClass).toBe('tenant-user');
    expect(result.resolverContext?.role).toBe('Employee');
  });

  it('should REJECT Pool A token (Layer 1 — before role logic)', async () => {
    // Neither Pool B nor Pool C verifies (Pool A issuer doesn't match either)
    mockedJwtVerify
      .mockRejectedValueOnce(new Error('issuer mismatch'))
      .mockRejectedValueOnce(new Error('issuer mismatch'));

    const result = await handler(baseEvent);

    expect(result.isAuthorized).toBe(false);
    expect(result.resolverContext).toBeUndefined();
  });

  it('should REJECT an expired token', async () => {
    mockedJwtVerify
      .mockRejectedValueOnce(new Error('JWTExpired'))
      .mockRejectedValueOnce(new Error('JWTExpired'));

    const result = await handler(baseEvent);

    expect(result.isAuthorized).toBe(false);
  });

  it('should REJECT a token with missing custom:tenantId', async () => {
    const claimsNoTenant = { ...validPoolBClaims, 'custom:tenantId': undefined };
    mockedJwtVerify.mockResolvedValueOnce({
      payload: claimsNoTenant,
      protectedHeader: { alg: 'RS256' },
    } as never);

    const result = await handler(baseEvent);

    expect(result.isAuthorized).toBe(false);
  });

  it('should REJECT a token with bad signature', async () => {
    mockedJwtVerify
      .mockRejectedValueOnce(new Error('JWSSignatureVerificationFailed'))
      .mockRejectedValueOnce(new Error('JWSSignatureVerificationFailed'));

    const result = await handler(baseEvent);

    expect(result.isAuthorized).toBe(false);
  });

  it('should REJECT an access token (ID token only — C-8)', async () => {
    const accessTokenClaims = { ...validPoolBClaims, token_use: 'access' };
    mockedJwtVerify.mockResolvedValueOnce({
      payload: accessTokenClaims,
      protectedHeader: { alg: 'RS256' },
    } as never);

    const result = await handler(baseEvent);

    expect(result.isAuthorized).toBe(false);
  });

  it('should REJECT if poolClass is internal (defense in depth)', async () => {
    const internalClaims = { ...validPoolBClaims, 'custom:poolClass': 'internal' };
    mockedJwtVerify.mockResolvedValueOnce({
      payload: internalClaims,
      protectedHeader: { alg: 'RS256' },
    } as never);

    const result = await handler(baseEvent);

    expect(result.isAuthorized).toBe(false);
  });

  it('should DENY if the entitlement read fails (fail-closed)', async () => {
    mockedJwtVerify.mockResolvedValueOnce({
      payload: validPoolBClaims,
      protectedHeader: { alg: 'RS256' },
    } as never);
    mockDdbSend.mockRejectedValueOnce(new Error('DDB timeout'));

    const result = await handler(baseEvent);

    expect(result.isAuthorized).toBe(false);
    expect(result.resolverContext).toBeUndefined();
  });

  it('should return the default Launch entitlement when the PLAN item is missing', async () => {
    mockedJwtVerify.mockResolvedValueOnce({
      payload: validPoolBClaims,
      protectedHeader: { alg: 'RS256' },
    } as never);
    mockDdbSend.mockResolvedValueOnce({ Item: undefined });

    const result = await handler(baseEvent);

    expect(result.isAuthorized).toBe(true);
    const entitlement = JSON.parse(result.resolverContext!.entitlement);
    expect(entitlement.plan).toBe('Launch');
    expect(entitlement.seats).toBe(5);
  });

  it('should handle missing authorization token', async () => {
    const result = await handler({
      ...baseEvent,
      authorizationToken: '',
    });

    expect(result.isAuthorized).toBe(false);
  });

  it('should REJECT a token with wrong audience (FIX-1)', async () => {
    // Both pools reject because audience doesn't match their client IDs
    mockedJwtVerify
      .mockRejectedValueOnce(new Error('unexpected "aud" claim value'))
      .mockRejectedValueOnce(new Error('unexpected "aud" claim value'));

    const result = await handler(baseEvent);

    expect(result.isAuthorized).toBe(false);
  });
});
