/**
 * ExpireHitlItem Lambda — SFN WaitForApproval timeout catch target.
 *
 * A 7d unanswered approval previously failed the execution and left the DDB
 * item PENDING forever: the approval queue card stayed clickable but the
 * task token was dead, so APPROVE 404'd. This flips the item through the
 * shared resolveHitlItem path — TIMED_OUT status, 30-day ttl, GSI9 removal —
 * identical vocabulary to the resolver-side timeout path (hitl-approval.ts)
 * instead of a second hand-rolled write.
 *
 * Write scope: TENANT#<tenantId>#HITL items (LeadingKeys-scoped role).
 */

import { Logger } from '@aws-lambda-powertools/logger';
import { assertTenantIdSafe } from '../../api/src/resolvers/shared.js';
import { ambientDdb, resolveHitlItem } from './hitl.js';

const logger = new Logger({ serviceName: 'expire-hitl-item' });

export interface ExpireHitlItemInput {
  tenantId: string;
  hitlItemId: string;
}

export async function handler(event: ExpireHitlItemInput): Promise<{ resolved: true }> {
  const { tenantId, hitlItemId } = event;
  logger.appendKeys({ tenantId, hitlItemId });
  assertTenantIdSafe(tenantId);

  // This Lambda's own role carries the LeadingKeys-scoped write grant —
  // the ambient client is the correct credential path here (unlike resolvers).
  await resolveHitlItem(tenantId, hitlItemId, 'TIMED_OUT', 'sfn-timeout', ambientDdb);
  return { resolved: true };
}
