/**
 * HITL Query resolver — lists pending human-in-the-loop items from GSI9.
 * Uses tenant-scoped DDB client (getTenantDdbClient) for isolation.
 * BC-8: taskToken is EXCLUDED from the response (security-sensitive).
 * SCHEMA-5: tenantId from resolverContext only.
 */

import { Logger } from '@aws-lambda-powertools/logger';
import { QueryCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { resolveModule } from '../permissions/role-matrix.js';
import { extractContext, getTenantDdbClient, TABLE_NAME, type AppSyncEvent } from './shared.js';

const logger = new Logger({ serviceName: 'resolver-hitl-query' });

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

interface PaginationInput {
  limit?: number;
  nextToken?: string;
}

export async function handler(event: AppSyncEvent): Promise<unknown> {
  const ctx = extractContext(event);
  const { tenantId } = ctx;
  logger.appendKeys({ tenantId, requestField: event.info.fieldName });

  switch (event.info.fieldName) {
    case 'listPendingHitlItems':
      return listPendingHitlItems(event, tenantId);
    default:
      throw new Error(`Unknown field: ${event.info.fieldName}`);
  }
}

async function listPendingHitlItems(event: AppSyncEvent, tenantId: string) {
  const pagination = (event.arguments.pagination as PaginationInput | null) ?? {};
  const limit = Math.min(pagination.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  let exclusiveStartKey: Record<string, unknown> | undefined;

  if (pagination.nextToken) {
    try {
      const decoded = JSON.parse(Buffer.from(pagination.nextToken, 'base64').toString('utf-8'));
      // Cross-tenant rejection: validate the decoded key belongs to this tenant
      if (
        !decoded.PK ||
        typeof decoded.PK !== 'string' ||
        !decoded.PK.startsWith(`TENANT#${tenantId}#`)
      ) {
        throw new Error('Cross-tenant pagination key rejected');
      }
      exclusiveStartKey = decoded;
    } catch (err) {
      if ((err as Error).message === 'Cross-tenant pagination key rejected') {
        throw err;
      }
      throw new Error('Invalid nextToken');
    }
  }

  const ddb = await getTenantDdbClient(tenantId);

  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI9',
      KeyConditionExpression: 'GSI9PK = :pk', // GSI9PK value is TENANT#<tenantId>#HITL_PENDING (reads only)
      ExpressionAttributeValues: marshall({ ':pk': `TENANT#${tenantId}#HITL_PENDING` }),
      Limit: limit,
      ScanIndexForward: true,
      ...(exclusiveStartKey ? { ExclusiveStartKey: marshall(exclusiveStartKey) } : {}),
    }),
  );

  const items = (result.Items ?? []).map((raw) => {
    const item = unmarshall(raw);
    const sk = item.SK as string;
    const hitlItemId = sk.split('PENDING#')[1] ?? sk;

    let proposedAction: Record<string, unknown> | undefined;
    if (item.proposedAction && typeof item.proposedAction === 'object') {
      proposedAction = item.proposedAction as Record<string, unknown>;
    }

    return {
      hitlItemId,
      agentName: item.agentName ?? null,
      clauseRef: proposedAction?.tool ?? null,
      standard: item.standard ?? null,
      // Schema module is String! and items carry no module field (enterHitlGate
      // omits it) — resolve via the same tool registry the approval path uses,
      // else the whole list query fails marshalling (BUG-13, found live at ACC-3).
      module: resolveModule(item),
      draftBody: proposedAction ? JSON.stringify(proposedAction) : null,
      status: item.status ?? 'PENDING',
      createdAt: item.createdAt ?? null,
      guardrailEvidence: item.guardrailEvidence ?? null,
      // BC-8: taskToken intentionally EXCLUDED
    };
  });

  const nextToken = result.LastEvaluatedKey
    ? Buffer.from(JSON.stringify(unmarshall(result.LastEvaluatedKey))).toString('base64')
    : null;

  return { items, nextToken };
}
