/**
 * Credit balance pre-check (SERVE-9).
 * Before invoking Bedrock, checks tenant's credit balance.
 * Exemptions: incident-reporting and HITL-approval flows NEVER block.
 *
 * Meter key: TENANT#<tenantId>#METER / MONTH#<yyyymm> (D-5).
 */

import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { Logger } from '@aws-lambda-powertools/logger';
import { InvokeError } from './types.js';

const logger = new Logger({ serviceName: 'ai-invoker-credit-precheck' });

const ddb = new DynamoDBClient({});
const TABLE_NAME = process.env.TABLE_NAME!;

/** Tenant credit limit shape (informational — loaded from DDB) */
export interface CreditLimit {
  monthlyGrant: number;
  paygoEnabled: boolean;
  planTier: 'trial' | 'launch' | 'ims-pro' | 'enterprise';
}

/**
 * The hard cap this check resolved for the tenant, if any.
 * Callers pass it to incrementMeter so the conditional meter write enforces
 * the SAME invariant the pre-check just read — closing the check-then-act
 * TOCTOU where two concurrent invokes could both pass the check and both
 * ADD past the grant. Absent = unbounded writes (exempt/enterprise/paygo).
 */
export interface CreditCap {
  hardCap?: number;
}

/**
 * Check if the tenant has credits available.
 * Returns the resolved credit cap (empty when the tenant is unbounded).
 * Throws InvokeError('PAUSED_FOR_CREDITS') if exhausted.
 *
 * @param creditExempt - If true, skip pre-check (incident/HITL exemption)
 */
export async function checkCreditBalance(
  tenantId: string,
  creditExempt: boolean,
): Promise<CreditCap> {
  // SERVE-9: incident-reporting and HITL-approval flows NEVER block on credits
  if (creditExempt) {
    logger.info('Credit pre-check skipped (exempt)', { tenantId });
    return {};
  }

  const yyyymm = new Date().toISOString().slice(0, 7).replace('-', '');
  const pk = `TENANT#${tenantId}#METER`;
  const sk = `MONTH#${yyyymm}`;

  // Read current meter
  const meterResult = await ddb.send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: { S: pk },
        SK: { S: sk },
      },
      ProjectionExpression: 'creditsUsed',
    }),
  );

  const creditsUsed = parseFloat(meterResult.Item?.creditsUsed?.N ?? '0');

  // Read tenant limit (from entitlement item)
  const limitResult = await ddb.send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: { S: `TENANT#${tenantId}#ENTITLEMENT` },
        SK: { S: 'CREDIT_LIMIT' },
      },
      ProjectionExpression: 'monthlyGrant, paygoEnabled, planTier',
    }),
  );

  if (!limitResult.Item) {
    // No entitlement record = default trial limits (trial has no paygo)
    logger.warn('No entitlement record found, applying trial defaults', { tenantId });
    const trialGrant = 15000; // Part 22: trial = 15,000 credits
    if (creditsUsed >= trialGrant) {
      throw new InvokeError(
        'PAUSED_FOR_CREDITS',
        `Tenant ${tenantId} credit balance exhausted (used: ${creditsUsed.toFixed(0)}, grant: ${trialGrant})`,
      );
    }
    return { hardCap: trialGrant };
  }

  const monthlyGrant = parseFloat(limitResult.Item.monthlyGrant?.N ?? '0');
  const paygoEnabled = limitResult.Item.paygoEnabled?.BOOL ?? false;
  const planTier = limitResult.Item.planTier?.S ?? 'trial';

  // F-6 OWNER-RESOLVED: serve & bill overage. Logic decoupled from autoRefill.
  // Enterprise: never block (contracted).
  if (planTier === 'enterprise') {
    return {};
  }

  // PAYG enabled: serve overage, meter + bill downstream.
  // NOTE: overage now accrues past grant — the telemetry.credits.consumed event
  // is the billing signal; the billing/entitlement consumer must handle overage line-items.
  if (paygoEnabled) {
    return {};
  }

  // Trial/Launch without paygo: hard-block at grant ceiling.
  if (creditsUsed >= monthlyGrant) {
    throw new InvokeError(
      'PAUSED_FOR_CREDITS',
      `Tenant ${tenantId} credit balance exhausted (used: ${creditsUsed.toFixed(0)}, grant: ${monthlyGrant})`,
    );
  }
  return { hardCap: monthlyGrant };
}
