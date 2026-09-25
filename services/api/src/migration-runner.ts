/**
 * Migration runner — executes numbered SQL migration files via RDS Data API.
 * Idempotent: tracks applied migrations in public._migrations table.
 * Each migration runs inside a transaction. Failed migrations abort the deploy.
 *
 * Per design §4: raw SQL + CDK Custom Resource; parameterized set_config (D-7).
 *
 * INVARIANT (C-2, review-blocking): Data API pools/reuses connections. Tenant
 * context MUST be set via set_config('app.tenant_id', :tenantId, true) as the
 * FIRST statement inside a BeginTransaction, EVERY request. The third argument
 * MUST be `true` (transaction-local). Never `false` (session-scoped), never a
 * bare ExecuteStatement for tenant-scoped data — either risks leaking the prior
 * tenant's context on a reused connection. The migrator itself does NOT set
 * tenant context (it operates as master/owner on DDL, not tenant data).
 */

import {
  RDSDataClient,
  ExecuteStatementCommand,
  BeginTransactionCommand,
  CommitTransactionCommand,
  RollbackTransactionCommand,
  type SqlParameter,
} from '@aws-sdk/client-rds-data';
import { createHash } from 'node:crypto';
import { Logger } from '@aws-lambda-powertools/logger';
import { splitStatements } from './sql-splitter.js';

const logger = new Logger({ serviceName: 'migration-runner' });

export interface MigrationConfig {
  clusterArn: string;
  secretArn: string;
  database: string;
}

export interface MigrationFile {
  filename: string;
  sql: string;
}

const client = new RDSDataClient({});

function computeChecksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex').substring(0, 16);
}

async function executeStatement(
  config: MigrationConfig,
  sql: string,
  transactionId?: string,
  parameters?: SqlParameter[],
): Promise<void> {
  await client.send(
    new ExecuteStatementCommand({
      resourceArn: config.clusterArn,
      secretArn: config.secretArn,
      database: config.database,
      sql,
      ...(transactionId ? { transactionId } : {}),
      ...(parameters ? { parameters } : {}),
    }),
  );
}

async function getAppliedMigrations(config: MigrationConfig): Promise<Map<string, string>> {
  try {
    // Ensure the _migrations table exists (idempotent for clean re-runs)
    await client.send(
      new ExecuteStatementCommand({
        resourceArn: config.clusterArn,
        secretArn: config.secretArn,
        database: config.database,
        sql: `CREATE TABLE IF NOT EXISTS public._migrations (
          filename TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          checksum TEXT NOT NULL
        )`,
      }),
    );

    const result = await client.send(
      new ExecuteStatementCommand({
        resourceArn: config.clusterArn,
        secretArn: config.secretArn,
        database: config.database,
        sql: 'SELECT filename, checksum FROM public._migrations',
      }),
    );
    const applied = new Map<string, string>();
    for (const record of result.records ?? []) {
      if (record[0]?.stringValue) {
        applied.set(record[0].stringValue, record[1]?.stringValue ?? '');
      }
    }
    return applied;
  } catch (err: unknown) {
    // Table might not exist on very first run (shouldn't happen now with CREATE IF NOT EXISTS)
    const message = (err as Error).message ?? '';
    if (message.includes('_migrations') && message.includes('does not exist')) {
      return new Map();
    }
    throw err;
  }
}

export async function runMigrations(
  config: MigrationConfig,
  migrations: MigrationFile[],
): Promise<{ applied: string[]; skipped: string[] }> {
  const applied: string[] = [];
  const skipped: string[] = [];

  // Sort by filename (numeric prefix ensures order)
  const sorted = [...migrations].sort((a, b) => a.filename.localeCompare(b.filename));

  const alreadyApplied = await getAppliedMigrations(config);

  for (const migration of sorted) {
    const appliedChecksum = alreadyApplied.get(migration.filename);
    if (appliedChecksum !== undefined) {
      // Drift guard: an already-applied file whose contents changed is a silent
      // schema divergence — fail loudly instead of skipping it.
      const currentChecksum = computeChecksum(migration.sql);
      if (appliedChecksum !== currentChecksum) {
        throw new Error(
          `MIGRATION_CHECKSUM_MISMATCH: '${migration.filename}' was already applied with ` +
            `checksum ${appliedChecksum} but the on-disk file has ${currentChecksum}. ` +
            'Applied migrations are immutable — ship a new numbered migration instead of editing.',
        );
      }
      skipped.push(migration.filename);
      logger.info('Migration already applied, skipping', { filename: migration.filename });
      continue;
    }

    logger.info('Applying migration', { filename: migration.filename });

    const transactionId = (
      await client.send(
        new BeginTransactionCommand({
          resourceArn: config.clusterArn,
          secretArn: config.secretArn,
          database: config.database,
        }),
      )
    ).transactionId!;

    try {
      // RDS Data API: EXACTLY ONE statement per ExecuteStatement call.
      // Split the migration file into individual statements (dollar-quote aware).
      const statements = splitStatements(migration.sql);
      logger.info('Executing migration statements', {
        filename: migration.filename,
        statementCount: statements.length,
      });

      for (const stmt of statements) {
        await executeStatement(config, stmt, transactionId);
      }

      // Record it in the _migrations table (parameterized — the filename is
      // ours but interpolating SQL anywhere is a habit that leaks).
      const checksum = computeChecksum(migration.sql);
      await executeStatement(
        config,
        'INSERT INTO public._migrations (filename, checksum) VALUES (:filename, :checksum)',
        transactionId,
        [
          { name: 'filename', value: { stringValue: migration.filename } },
          { name: 'checksum', value: { stringValue: checksum } },
        ],
      );

      await client.send(
        new CommitTransactionCommand({
          resourceArn: config.clusterArn,
          secretArn: config.secretArn,
          transactionId,
        }),
      );

      applied.push(migration.filename);
      logger.info('Migration applied successfully', { filename: migration.filename });
    } catch (err) {
      logger.error('Migration failed, rolling back', {
        filename: migration.filename,
        error: (err as Error).message,
      });

      await client.send(
        new RollbackTransactionCommand({
          resourceArn: config.clusterArn,
          secretArn: config.secretArn,
          transactionId,
        }),
      );

      throw new Error(`Migration ${migration.filename} failed: ${(err as Error).message}`);
    }
  }

  return { applied, skipped };
}
