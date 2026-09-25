/**
 * Profile resolver — user locale preferences stored in DynamoDB.
 * Uses tenant-scoped DDB client (getTenantDdbClient) for isolation.
 * SCHEMA-5: tenantId from resolverContext only.
 */

import { Logger } from '@aws-lambda-powertools/logger';
import { GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { extractContext, getTenantDdbClient, TABLE_NAME, type AppSyncEvent } from './shared.js';

const logger = new Logger({ serviceName: 'resolver-profile' });

const VALID_LOCALES = ['en', 'es', 'pt'] as const;

export async function handler(event: AppSyncEvent): Promise<unknown> {
  const ctx = extractContext(event);
  const { tenantId, sub } = ctx;
  logger.appendKeys({ tenantId, requestField: event.info.fieldName });

  switch (event.info.fieldName) {
    case 'getProfile':
      return getProfile(tenantId, sub);
    case 'updateProfile':
      return updateProfile(event, tenantId, sub);
    case 'getTenantSettings':
      return getTenantSettings(tenantId);
    default:
      throw new Error(`Unknown field: ${event.info.fieldName}`);
  }
}

/**
 * getTenantSettings — read-only tenant name + default document-locale
 * (Task 31 Settings → Organization panel, AM-3 read side only). Item lives
 * at TENANT#<tenantId>#META / SK=ORG, a sibling of the entitlement item the
 * authorizer reads (SK=PLAN) — see authorizer.ts getEntitlementStamp for the
 * precedent. No writer exists yet (tenant provisioning is out of scope here,
 * NAMED CARRY to settings-ui) — defaults gracefully like getEntitlementStamp
 * does, rather than erroring, so this works before any tenant has an ORG item.
 */
async function getTenantSettings(tenantId: string) {
  const ddb = await getTenantDdbClient(tenantId);
  const result = await ddb.send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({
        PK: `TENANT#${tenantId}#META`,
        SK: 'ORG',
      }),
    }),
  );

  if (!result.Item) {
    return { tenantName: tenantId, documentLocale: 'en' };
  }

  const item = unmarshall(result.Item);
  return {
    tenantName: (item.tenantName as string) ?? tenantId,
    documentLocale: (item.documentLocale as string) ?? 'en',
  };
}

async function getProfile(tenantId: string, sub: string) {
  const ddb = await getTenantDdbClient(tenantId);
  const result = await ddb.send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({
        PK: `TENANT#${tenantId}#PROFILE`,
        SK: `USER#${sub}`,
      }),
    }),
  );

  if (!result.Item) {
    return { userId: sub, locale: 'en', updatedAt: null };
  }

  const item = unmarshall(result.Item);
  return { userId: sub, locale: item.locale, updatedAt: item.updatedAt };
}

async function updateProfile(event: AppSyncEvent, tenantId: string, sub: string) {
  const input = event.arguments.input as Record<string, unknown>;
  const locale = input.locale as string;

  if (!VALID_LOCALES.includes(locale as (typeof VALID_LOCALES)[number])) {
    throw new Error(`Invalid locale "${locale}". Must be one of: ${VALID_LOCALES.join(', ')}`);
  }

  const updatedAt = new Date().toISOString();
  const ddb = await getTenantDdbClient(tenantId);

  await ddb.send(
    new PutItemCommand({
      TableName: TABLE_NAME,
      Item: marshall({
        PK: `TENANT#${tenantId}#PROFILE`,
        SK: `USER#${sub}`,
        locale,
        updatedAt,
      }),
    }),
  );

  return { userId: sub, locale, updatedAt };
}
