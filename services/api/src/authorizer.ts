/**
 * Lambda Authorizer for AppSync (AWS_LAMBDA auth mode).
 * [REQUIRES-HUMAN] — owner reviews this code before merge (C-2/AUTH-5).
 *
 * Responsibilities:
 * 1. Validates JWT from Pool B (tenant-admin) or Pool C (tenant-user).
 * 2. REJECTS Pool A (internal) tokens → 401 BEFORE any role logic (Layer 1).
 * 3. Verifies: signature (JWKS), issuer, expiry, custom:tenantId presence.
 * 4. Reads tenant metadata from CumplifyCore for static entitlement stamp (D-10).
 * 5. Returns resolverContext: {tenantId, role, poolClass, sub, entitlement}.
 *
 * Per design §1: ID token only (never access token). JWKS cached in-memory.
 */

import { Logger } from '@aws-lambda-powertools/logger';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

const logger = new Logger({ serviceName: 'api-authorizer' });

const POOL_B_ID = process.env.POOL_B_ID!;
const POOL_C_ID = process.env.POOL_C_ID!;
const TABLE_NAME = process.env.TABLE_NAME!;
const REGION = process.env.REGION!;
// FIX-1: audience validation — comma-separated app-client IDs per pool
const POOL_B_CLIENT_IDS = process.env.POOL_B_CLIENT_IDS!.split(',');
const POOL_C_CLIENT_IDS = process.env.POOL_C_CLIENT_IDS!.split(',');

// Construct JWKS URIs for Pool B and Pool C
const poolBIssuer = `https://cognito-idp.${REGION}.amazonaws.com/${POOL_B_ID}`;
const poolCIssuer = `https://cognito-idp.${REGION}.amazonaws.com/${POOL_C_ID}`;

// JWKS sets — cached in-memory across warm invocations (refreshed on miss)
const jwksB = createRemoteJWKSet(new URL(`${poolBIssuer}/.well-known/jwks.json`));
const jwksC = createRemoteJWKSet(new URL(`${poolCIssuer}/.well-known/jwks.json`));

const ddb = new DynamoDBClient({});

// Pool A issuer pattern — used for Layer 1 rejection
// Pool A ID is NOT in environment (we don't need to validate its tokens, only detect them)
// Detection: if the issuer doesn't match Pool B or Pool C, it's rejected.

interface AppSyncAuthEvent {
  authorizationToken: string;
  requestContext: {
    apiId: string;
    accountId: string;
    requestId: string;
  };
}

interface AuthResponse {
  isAuthorized: boolean;
  resolverContext?: Record<string, string>;
  deniedFields?: string[];
  ttlOverride?: number;
}

interface TokenClaims extends JWTPayload {
  'custom:tenantId'?: string;
  'custom:role'?: string;
  'custom:poolClass'?: string;
  'cognito:groups'?: string[];
  token_use?: string;
  sub?: string;
}

/**
 * Canonical role precedence — must stay in sync with ROLE_PRIORITY in
 * services/pre-token-gen/index.ts. Cognito's groups claim order is not
 * priority-ordered, so groups[0] was nondeterministic for multi-group users.
 */
const ROLE_PRIORITY: readonly string[] = [
  // PoolA (internal)
  'PlatformAdmin',
  'SecurityOps',
  'SupportEngineer',
  'FinanceOps',
  // PoolB (tenant-admin)
  'TopManagement',
  'IMSLead',
  'QualityManager',
  'EHSManager',
  'DocumentController',
  // PoolC (tenant-user)
  'InternalAuditor',
  'ProcessOwner',
  'Supervisor',
  'PartnerConsultant',
  'Contractor',
  'Employee',
  'ExternalAuditor',
];

/**
 * Reads tenant entitlement from CumplifyCore (PK=TENANT#<tenantId>#META, SK=PLAN).
 * Returns a static JSON string for resolverContext.entitlement.
 * P1 scope: static stamp. P2 upgrades to real-time lookup.
 */
async function getEntitlementStamp(tenantId: string): Promise<string> {
  try {
    const result = await ddb.send(
      new GetItemCommand({
        TableName: TABLE_NAME,
        Key: {
          PK: { S: `TENANT#${tenantId}#META` },
          SK: { S: 'PLAN' },
        },
        ProjectionExpression: '#plan, seats, features',
        ExpressionAttributeNames: { '#plan': 'plan' },
      }),
    );

    if (result.Item) {
      return JSON.stringify({
        plan: result.Item.plan?.S ?? 'Launch',
        seats: Number(result.Item.seats?.N ?? '5'),
        features: result.Item.features?.SS ?? [],
      });
    }
  } catch (err) {
    logger.warn('Failed to read entitlement, using default', {
      tenantId,
      error: (err as Error).message,
    });
  }

  // Default entitlement (new tenants without a PLAN item yet)
  // TODO(P2): A-2 entitlement fail-open carry — when billing enforcement
  // activates (ai-core EXPIRED-flag), a missing/failed entitlement read must
  // block, not default to Launch. Tracked in P2 billing spec.
  return JSON.stringify({ plan: 'Launch', seats: 5, features: [] });
}

export async function handler(event: AppSyncAuthEvent): Promise<AuthResponse> {
  const token = event.authorizationToken;
  const requestId = event.requestContext.requestId;

  logger.appendKeys({ requestId });

  if (!token) {
    logger.warn('No authorization token provided');
    return { isAuthorized: false };
  }

  // Strip "Bearer " prefix if present
  const rawToken = token.startsWith('Bearer ') ? token.slice(7) : token;

  // Try Pool B first, then Pool C. If neither matches, reject (Layer 1).
  let claims: TokenClaims | null = null;
  let matchedPool: 'B' | 'C' | null = null;

  try {
    const { payload } = await jwtVerify(rawToken, jwksB, {
      issuer: poolBIssuer,
      audience: POOL_B_CLIENT_IDS,
    });
    claims = payload as TokenClaims;
    matchedPool = 'B';
  } catch {
    // Not Pool B — try Pool C
    try {
      const { payload } = await jwtVerify(rawToken, jwksC, {
        issuer: poolCIssuer,
        audience: POOL_C_CLIENT_IDS,
      });
      claims = payload as TokenClaims;
      matchedPool = 'C';
    } catch {
      // Neither Pool B nor Pool C — this covers:
      // - Pool A tokens (wrong issuer → rejected BEFORE role logic, Layer 1)
      // - Expired tokens (jose throws JWTExpired)
      // - Bad signatures (jose throws JWSSignatureVerificationFailed)
      // - Wrong audience (token's aud not in allowed client IDs for pool)
      logger.warn(
        'Token rejected: not issued by Pool B or Pool C, or wrong audience (Layer 1 rejection)',
        {
          requestId,
        },
      );
      return { isAuthorized: false };
    }
  }

  // At this point, claims is verified from Pool B or Pool C.
  // Verify it's an ID token (never access token — C-8)
  if (claims!.token_use !== 'id') {
    logger.warn('Token rejected: not an ID token (token_use != id)', {
      tokenUse: claims!.token_use,
    });
    return { isAuthorized: false };
  }

  // Check custom:tenantId presence (AUTH-2d)
  const tenantId = claims!['custom:tenantId'];
  if (!tenantId) {
    logger.warn('Token rejected: missing custom:tenantId');
    return { isAuthorized: false };
  }

  // Check poolClass — reject if somehow 'internal' leaked (defense in depth; Layer 1 already blocked)
  const poolClass =
    claims!['custom:poolClass'] ?? (matchedPool === 'B' ? 'tenant-admin' : 'tenant-user');

  if (poolClass === 'internal') {
    logger.warn('Token rejected: poolClass=internal (AUTH-4)');
    return { isAuthorized: false };
  }

  // Extract role: the custom:role claim (pre-token-gen, deterministic) or,
  // for tokens minted before the trigger, the highest-priority group —
  // Cognito's groups order is not priority-ordered, so groups[0] was
  // nondeterministic for multi-group users.
  const groups = claims!['cognito:groups'];
  const role =
    claims!['custom:role'] ??
    ROLE_PRIORITY.find((r) => groups?.includes(r)) ??
    groups?.[0] ??
    'Employee';

  const sub = claims!.sub ?? 'unknown';

  // Read entitlement stamp (D-10: static from CumplifyCore tenant metadata)
  const entitlement = await getEntitlementStamp(tenantId);

  logger.info('Authorization granted', { tenantId, role, poolClass, sub, matchedPool });

  return {
    isAuthorized: true,
    resolverContext: {
      tenantId,
      role,
      poolClass,
      sub,
      entitlement,
    },
  };
}
