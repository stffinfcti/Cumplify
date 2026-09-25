/**
 * PreTokenGeneration V1_0 Lambda — stamps custom claims into ID token.
 * Per design §2.1: injects tenantId, role, poolClass into the ID token ONLY.
 *
 * Runtime: Node.js 22.x, arm64, 5s timeout (Cognito trigger hard cap).
 *
 * Behavior:
 * 1. Reads custom:tenantId from the user's Cognito attributes.
 * 2. Reads the user's first Cognito group as the role.
 * 3. Determines poolClass by reading the pool-class-map from SSM Parameter
 *    Store (cached on cold start). SSM path is in POOL_CLASS_MAP_PARAM env var.
 * 4. Returns claimsToAddOrOverride with tenantId, role, poolClass.
 *
 * Fallback: If group membership is empty, falls back to 'Employee' and LOGS
 * the fallback (no silent paths per F-8 tightening).
 *
 * Dependency design: Lambda references SSM parameter by static path (no pool
 * IDs in env vars). Pools → SSM param (stores pool IDs). Acyclic.
 */

import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { ROLE_PRIORITY } from '../api/src/permissions/role-priority.js';

export interface PreTokenGenEvent {
  readonly request: {
    readonly userAttributes: Record<string, string>;
    readonly groupConfiguration: {
      readonly groupsToOverride?: string[];
    };
  };
  readonly response: {
    claimsOverrideDetails?: {
      claimsToAddOrOverride?: Record<string, string>;
    };
  };
  readonly callerContext: {
    readonly clientId: string;
  };
  readonly userPoolId: string;
  readonly userName: string;
}

export type PreTokenGenResult = PreTokenGenEvent;

// ---------------------------------------------------------------------------
// Pool-class resolution via SSM (cached on cold start)
// ---------------------------------------------------------------------------

let poolClassMapCache: Record<string, string> | null = null;

/**
 * Load the pool-class-map from SSM Parameter Store.
 * Cached after first invocation (cold start). The parameter contains a JSON
 * object mapping pool IDs to pool class names.
 */
async function loadPoolClassMap(): Promise<Record<string, string>> {
  if (poolClassMapCache) return poolClassMapCache;

  const paramName = process.env.POOL_CLASS_MAP_PARAM;
  if (!paramName) {
    console.warn('[PreTokenGen] POOL_CLASS_MAP_PARAM not set — poolClass will be "unknown"');
    poolClassMapCache = {};
    return poolClassMapCache;
  }

  try {
    // Static import (bundled by esbuild) — avoids the runtime module-resolution
    // cold-start cost that pushed the 128MB/external build past the 5s cap.
    const client = new SSMClient({});
    const response = await client.send(new GetParameterCommand({ Name: paramName }));
    const value = response.Parameter?.Value ?? '{}';
    poolClassMapCache = JSON.parse(value);
    return poolClassMapCache!;
  } catch (err) {
    console.error('[PreTokenGen] Failed to load pool-class-map from SSM:', err);
    poolClassMapCache = {};
    return poolClassMapCache;
  }
}

/**
 * Determine poolClass from the User Pool ID.
 * Reads from SSM-cached map. Defaults to 'unknown' if pool not found.
 */
export async function resolvePoolClass(
  userPoolId: string,
  map?: Record<string, string>,
): Promise<string> {
  const poolMap = map ?? (await loadPoolClassMap());
  return poolMap[userPoolId] ?? 'unknown';
}

/**
 * Resolve the user's role from Cognito group membership.
 * Highest-priority known group wins deterministically; unknown groups fall
 * back to lexical order of appearance, then 'Employee' with a log warning.
 */
export function resolveRole(groups: string[] | undefined): { role: string; fallback: boolean } {
  if (groups && groups.length > 0) {
    for (const role of ROLE_PRIORITY) {
      if (groups.includes(role)) return { role, fallback: false };
    }
    return { role: groups[0], fallback: false };
  }
  // Fallback — no silent paths (F-8 tightening)
  console.warn('[PreTokenGen] No group membership found. Falling back to Employee role.');
  return { role: 'Employee', fallback: true };
}

/**
 * Build the claims to inject into the ID token.
 */
export function buildClaims(
  tenantId: string | undefined,
  role: string,
  poolClass: string,
): Record<string, string> {
  return {
    'custom:tenantId': tenantId ?? '',
    'custom:role': role,
    'custom:poolClass': poolClass,
  };
}

/**
 * Lambda handler — PreTokenGeneration V1_0 trigger.
 */
export async function handler(event: PreTokenGenEvent): Promise<PreTokenGenResult> {
  const { request, userPoolId } = event;

  const tenantId = request.userAttributes['custom:tenantId'];
  const groups = request.groupConfiguration.groupsToOverride;

  const { role, fallback } = resolveRole(groups);
  const poolClass = await resolvePoolClass(userPoolId);
  const claims = buildClaims(tenantId, role, poolClass);

  if (fallback) {
    console.warn(
      `[PreTokenGen] user=${event.userName} pool=${userPoolId} — fallback role=Employee`,
    );
  }

  // Mutate event response per Cognito V1_0 contract
  event = {
    ...event,
    response: {
      claimsOverrideDetails: {
        claimsToAddOrOverride: claims,
      },
    },
  };

  return event;
}
