/**
 * qms — shared wiring extracted from qms.ts (mechanical decomposition —
 * no semantic changes).
 */

import { Logger } from '@aws-lambda-powertools/logger';
import { SFNClient } from '@aws-sdk/client-sfn';
import { LambdaClient } from '@aws-sdk/client-lambda';

export const logger = new Logger({ serviceName: 'resolver-qms' });
export const sfnClient = new SFNClient({});
export const lambdaClient = new LambdaClient({});
export const EXPORT_FN = process.env.EXPORT_FN ?? '';
// GEN-6: RegenerateSectionFn lives in AiStack — referenced by DETERMINISTIC
// name (same no-cycle pattern as DOCGEN_SFN_ARN).
export const REGEN_FN = process.env.REGEN_FN ?? '';

export interface AppSyncEvent {
  info: { fieldName: string };
  arguments: Record<string, unknown>;
  identity?: { resolverContext?: Record<string, string> };
}
