/**
 * qms — shared wiring extracted from qms.ts.
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

// The canonical AppSyncEvent lives in shared.ts — re-export so the
// `./common.js` import sites keep working.
export type { AppSyncEvent } from '../shared.js';
