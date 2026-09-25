/**
 * MarkRunFailed Lambda — DocGenStateMachine catch target (spec 40).
 *
 * Any unhandled failure in SeedSections / ComposeSections / FinalizeManual
 * previously left qms.generation_runs stuck at 'running' forever: the SFN
 * execution failed, but nobody flipped the row — the UI spinner never
 * resolved and regenerateSection/other run-state guards stayed blocked.
 * Each stage's addCatch routes here; the row goes 'failed' (only while it
 * is still 'running' — a late failure must never resurrect a terminal
 * run) and a run_complete progress event is published so subscribers see
 * the terminal state.
 */

import { Logger } from '@aws-lambda-powertools/logger';
import {
  assertTenantIdSafe,
  beginTenantTransaction,
  rollbackQuietly,
} from '../../api/src/resolvers/shared.js';
import { publishGenerationEvent } from './appsync-publish.js';

const logger = new Logger({ serviceName: 'qms-mark-run-failed' });

export interface MarkRunFailedInput {
  runId: string;
  tenantId: string;
}

export async function handler(event: MarkRunFailedInput): Promise<{ marked: boolean }> {
  const { runId, tenantId } = event;
  logger.appendKeys({ runId, tenantId });
  assertTenantIdSafe(tenantId);

  const txn = await beginTenantTransaction(tenantId);
  try {
    const result = await txn.execute(
      `UPDATE qms.generation_runs
         SET status = 'failed', finished_at = NOW(), updated_at = NOW()
       WHERE id = :runId::uuid AND tenant_id = :tenantId AND status = 'running'`,
      [
        { name: 'runId', value: { stringValue: runId } },
        { name: 'tenantId', value: { stringValue: tenantId } },
      ],
    );
    await txn.commit();
    const marked = (result.numberOfRecordsUpdated ?? 0) > 0;
    logger.info('Run failure recorded', { marked });

    if (marked) {
      await publishGenerationEvent({
        runId,
        tenantId,
        type: 'run_complete',
        summary: JSON.stringify({ status: 'failed' }),
      });
    }
    return { marked };
  } catch (err) {
    await rollbackQuietly(txn);
    throw err;
  }
}
