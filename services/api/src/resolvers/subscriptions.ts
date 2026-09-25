/**
 * Subscription resolvers — verify tenantId claim before delivery (C-6).
 * Plus 4 publish mutations (None data source) for subscription triggers.
 *
 * Per design §12: all subscriptions verify resolverContext.tenantId matches
 * the subscription's tenantId argument. A subscriber can NEVER receive
 * another tenant's events.
 *
 * M4 onCalibrationDue scheduler deferred (OQ-4) — mechanism only.
 */

import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({ serviceName: 'resolver-subscriptions' });

interface AppSyncEvent {
  info: { fieldName: string };
  arguments: Record<string, unknown>;
  identity?: { resolverContext?: Record<string, string> };
}

/**
 * Subscription authorization handler.
 * Called on subscription connect — verifies the requesting user's tenantId
 * matches the subscription's tenantId filter argument.
 * Returns null (allow) or throws (deny).
 */
export async function subscriptionAuth(event: AppSyncEvent): Promise<unknown> {
  const ctx = event.identity?.resolverContext;
  if (!ctx?.tenantId) {
    logger.warn('Subscription rejected: missing resolverContext.tenantId');
    throw new Error('Unauthorized');
  }

  const requestedTenantId = event.arguments.tenantId as string;
  if (requestedTenantId !== ctx.tenantId) {
    logger.warn('Subscription rejected: tenantId mismatch (C-6)', {
      requested: requestedTenantId,
      actual: ctx.tenantId,
    });
    throw new Error('Unauthorized: tenant mismatch');
  }

  logger.info('Subscription authorized', { tenantId: ctx.tenantId, field: event.info.fieldName });
  return null; // Allow subscription
}

/**
 * Publish mutations (None data source) — trigger subscription delivery.
 * These are @aws_iam mutations that simply pass through to trigger the
 * @aws_subscribe directive. No RDS/DDB access needed.
 *
 * The returned payload MUST carry tenantId — @aws_subscribe matches
 * subscription arguments (tenantId:) against the mutation's return value,
 * and event.arguments.input has no tenantId field (SCHEMA-5), so a bare
 * passthrough silently delivers nothing. tenantId comes from
 * resolverContext, never the caller's input.
 */
function withTenantId(event: AppSyncEvent): unknown {
  const tenantId = event.identity?.resolverContext?.tenantId;
  if (!tenantId) {
    logger.warn('Publish rejected: missing resolverContext.tenantId');
    throw new Error('Unauthorized');
  }
  return { ...(event.arguments.input as Record<string, unknown>), tenantId };
}

export async function publishDocumentEvent(event: AppSyncEvent): Promise<unknown> {
  return withTenantId(event);
}

export async function publishCAPAEvent(event: AppSyncEvent): Promise<unknown> {
  return withTenantId(event);
}

export async function publishAuditEvent(event: AppSyncEvent): Promise<unknown> {
  return withTenantId(event);
}

export async function publishRiskEvent(event: AppSyncEvent): Promise<unknown> {
  return withTenantId(event);
}

/**
 * Handler that routes subscription-related fields.
 */
export async function handler(event: AppSyncEvent): Promise<unknown> {
  const field = event.info.fieldName;

  switch (field) {
    // Subscription authorization (called on connect)
    case 'onDocumentStatusChanged':
    case 'onCAPAStatusChanged':
    case 'onFindingRecorded':
    case 'onCalibrationDue':
    case 'onRiskEscalated':
      return subscriptionAuth(event);

    // Publish mutations (None DS triggers)
    case 'publishDocumentEvent':
      return publishDocumentEvent(event);
    case 'publishCAPAEvent':
      return publishCAPAEvent(event);
    case 'publishAuditEvent':
      return publishAuditEvent(event);
    case 'publishRiskEvent':
      return publishRiskEvent(event);

    default:
      throw new Error(`Unknown subscription field: ${field}`);
  }
}
