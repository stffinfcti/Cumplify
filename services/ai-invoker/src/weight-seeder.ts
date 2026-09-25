/**
 * MODELWEIGHT# seeding Lambda — custom resource handler.
 * Uses a static JSON import (esbuild inlines at bundle time).
 *
 * Does NOT call live Pricing API at deploy time (T-2 correction).
 * MUST run before Task 9 (first deploy that expects weights to exist).
 *
 * T3E-F2: static import `from '../data/model-weights-seed.json'` — esbuild's
 *   native JSON loader inlines the content. createRequire does NOT inline.
 * T3E-F3: ConditionalCheckFailedException caught per-item (already seeded = skip).
 * T3E-F4: payload includes seedHash for re-trigger detection.
 */

import { createHash } from 'node:crypto';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({ serviceName: 'weight-seeder' });
const ddb = new DynamoDBClient({});
const TABLE_NAME = process.env.TABLE_NAME!;

interface WeightSeed {
  capturedAt: string;
  sourceCommit: string;
  models: Record<
    string,
    {
      wIn: number;
      wOut: number;
      wCache: number | null;
    }
  >;
}

// T3E-F2 FIX: static default import — esbuild's json loader inlines the content
// at bundle time. createRequire does NOT inline (leaves a runtime require call).
// The placeholder file is committed; Task 2 overwrites with real data; Task 9
// re-bundles and picks up the real weights via the F4 fingerprint trigger.
import seedRaw from '../data/model-weights-seed.json' with { type: 'json' };
const seed = seedRaw as unknown as WeightSeed;

export async function handler(event: {
  action: string;
  seedHash?: string;
}): Promise<{ status: string; seeded: number; skipped: number }> {
  if (event.action !== 'seed') {
    return { status: 'skipped', seeded: 0, skipped: 0 };
  }

  if (Object.keys(seed.models).length === 0) {
    logger.warn('No models in seed data — Task 2 has not landed model-weights-seed.json yet');
    return { status: 'no-data', seeded: 0, skipped: 0 };
  }

  logger.info('Seeding MODELWEIGHT# items', {
    modelCount: Object.keys(seed.models).length,
    seedHash: event.seedHash,
  });

  let seeded = 0;
  let skipped = 0;
  const version = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  for (const [modelId, weights] of Object.entries(seed.models)) {
    const pk = `MODELWEIGHT#${modelId}`;
    const sk = `VERSION#${version}`;
    // F31: compare-and-swap on content — a same-day corrected seed file must
    // overwrite the row, not silently skip it (metering would keep pricing
    // with the stale weights). Same hash → no-op.
    const contentHash = createHash('sha256')
      .update(JSON.stringify({ modelId, wIn: weights.wIn, wOut: weights.wOut, wCache: weights.wCache }))
      .digest('hex');

    try {
      await ddb.send(
        new PutItemCommand({
          TableName: TABLE_NAME,
          Item: marshall(
            {
              PK: pk,
              SK: sk,
              modelId,
              wIn: weights.wIn,
              wOut: weights.wOut,
              ...(weights.wCache !== null ? { wCache: weights.wCache } : {}),
              effectiveFrom: seed.capturedAt,
              sourceCommit: seed.sourceCommit,
              contentHash,
              seededAt: new Date().toISOString(),
            },
            { removeUndefinedValues: true },
          ),
          // Put only when the row is absent or its stored weights differ.
          ConditionExpression:
            'attribute_not_exists(contentHash) OR contentHash <> :contentHash',
          ExpressionAttributeValues: marshall({ ':contentHash': contentHash }),
        }),
      );

      logger.info('Seeded weight', { modelId, pk, sk });
      seeded++;
    } catch (err: unknown) {
      // ConditionalCheckFailedException = same content already seeded, skip
      if ((err as Error).name === 'ConditionalCheckFailedException') {
        logger.info('Weight already seeded, skipping', { modelId, pk, sk });
        skipped++;
      } else {
        throw err;
      }
    }
  }

  return { status: 'success', seeded, skipped };
}
