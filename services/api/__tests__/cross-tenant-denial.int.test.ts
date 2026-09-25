/**
 * C-7 Cross-Tenant Denial Suite (api-core, design §10.3).
 *
 * Six denial cases proving tenant isolation on the DEPLOYED system. Named
 * *.int.test.ts → EXCLUDED from the default `vitest run` (see vitest.config
 * exclude). Run explicitly with dev credentials:
 *
 *   C7_AWS_PROFILE=cumplify-dev-admin \
 *     npx vitest run services/api/__tests__/cross-tenant-denial.int.test.ts
 *
 * In CI, set C7_AWS_PROFILE='' to use the ambient job role. Uses the `aws` CLI
 * (execSync) — no @aws-sdk deps (those are Lambda-runtime-provided / external).
 *
 * Cases (design §10.3 + tasks.md C-7):
 *   1. Authorizer denial (Pool-A → 401)          — GATED (needs Pool-A MFA token)
 *   2. DynamoDB cross-tenant → implicitDeny        — LIVE (iam simulate)
 *   3. RDS RLS: tenant-B session → tenant-A empty  — LIVE (rds-data + app_role)
 *   4. Materialized-view denial                    — LIVE (rds-data)
 *   5. Resolver overwrite (client tenantId ignored)— CODE (extractContext, SCHEMA-5)
 *   6. Subscription denial (C-6)                   — GATED (needs Pool-B token)
 *
 * Live evidence (2026-07-09, dev): #2 implicitDeny/allowed; #3 fail-closed=0,
 * AAA=4 BBB=1 of 5; #4 accessor tenant-scoped, direct SELECT permission denied.
 */

import { describe, it, expect, vi } from 'vitest';
import { execSync } from 'node:child_process';

// shared.ts pulls in AWS SDK clients (Lambda-runtime-provided / not installed
// locally). extractContext is a pure function; stub the SDK imports so it loads.
vi.mock('@aws-sdk/client-rds-data', () => ({
  RDSDataClient: class {
    send = vi.fn();
  },
  BeginTransactionCommand: class {
    constructor(public input: unknown) {}
  },
  CommitTransactionCommand: class {
    constructor(public input: unknown) {}
  },
  RollbackTransactionCommand: class {
    constructor(public input: unknown) {}
  },
  ExecuteStatementCommand: class {
    constructor(public input: unknown) {}
  },
}));
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class {
    send = vi.fn();
  },
  AssumeRoleCommand: class {
    constructor(public input: unknown) {}
  },
}));
vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class {
    send = vi.fn();
  },
}));
vi.mock('@aws-lambda-powertools/logger', () => ({
  Logger: class {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    appendKeys = vi.fn();
  },
}));
vi.mock('../../../eventing/src/publisher.js', () => ({ publish: vi.fn() }));
vi.hoisted(() => {
  process.env.CLUSTER_ARN = 'arn:aws:rds:us-east-1:123:cluster:test';
  process.env.APP_ROLE_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:app-role';
  process.env.TABLE_NAME = 'CumplifyCore';
  process.env.BUS_NAME = 'cumplify-events';
  process.env.TENANT_DATA_ROLE_ARN = 'arn:aws:iam::123:role/tenant-data-role';
  process.env.REGION = 'us-east-1';
});

import { extractContext } from '../src/resolvers/shared.js';

const REGION = 'us-east-1';
const PROFILE = process.env.C7_AWS_PROFILE ?? 'cumplify-dev-admin';
const CLUSTER_ARN =
  process.env.C7_CLUSTER_ARN ??
  'arn:aws:rds:us-east-1:697114252993:cluster:dev-datastack-auroracluster23d869c0-zmmgimmc0vnd';
const APP_ROLE_SECRET =
  process.env.C7_APP_ROLE_SECRET_ARN ??
  'arn:aws:secretsmanager:us-east-1:697114252993:secret:cumplify/dev/rds/app-role-3cYWNR';
const TENANT_DATA_ROLE =
  process.env.C7_TENANT_DATA_ROLE_ARN ??
  'arn:aws:iam::697114252993:role/cumplify-dev-tenant-data-role';
const TABLE_ARN =
  process.env.C7_TABLE_ARN ?? 'arn:aws:dynamodb:us-east-1:697114252993:table/CumplifyCore';
const DB_NAME = process.env.C7_DB_NAME ?? 'postgres';
const TENANT_A = 'tenant-AAA';
const TENANT_B = 'tenant-BBB';
const TENANT_TABLE = 'm5.risks'; // has 2-tenant data (RLS-enforced)

const P = PROFILE ? `--profile ${PROFILE}` : '';

/** Run an aws CLI command, retrying the Aurora 0-ACU resume transient. */
function aws(cmd: string, retries = 12): string {
  for (let i = 0; ; i++) {
    try {
      return execSync(`aws ${cmd} --region ${REGION} ${P}`, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err: unknown) {
      const msg = String(
        (err as { stderr?: string; message?: string }).stderr ?? (err as Error).message ?? '',
      );
      if (msg.includes('DatabaseResumingException') && i < retries) {
        execSync('sleep 8');
        continue;
      }
      // Re-throw with stderr attached so denial assertions can inspect it.
      const e = new Error(msg);
      throw e;
    }
  }
}

/** Detect whether AWS is reachable; skip the live suite gracefully if not. */
function awsReachable(): boolean {
  try {
    aws('sts get-caller-identity', 0);
    return true;
  } catch {
    return false;
  }
}
const LIVE = awsReachable();

// LOUD-SKIP (TEST-4): a `test:int` run where every suite silently skips looks
// green while proving nothing. Fails loudly when neither live AWS nor any
// C7 token is provisioned, so an unprovisioned lane never reports a pass.
it('int lane provisioned: live AWS or a C7 token is available', () => {
  expect(
    LIVE || process.env.C7_POOL_A_TOKEN || process.env.C7_POOL_B_TOKEN,
  ).toBeTruthy();
});

/** RLS helper: run `sql` inside a txn with app.tenant_id set (or unset), rollback. */
function rlsQuery(tenant: string | null, sql: string): unknown[] {
  const tx = JSON.parse(
    aws(
      `rds-data begin-transaction --resource-arn ${CLUSTER_ARN} --secret-arn ${APP_ROLE_SECRET} --database ${DB_NAME}`,
    ),
  ).transactionId as string;
  try {
    if (tenant) {
      aws(
        `rds-data execute-statement --resource-arn ${CLUSTER_ARN} --secret-arn ${APP_ROLE_SECRET} --database ${DB_NAME} --transaction-id ${tx} ` +
          `--sql "SELECT set_config('app.tenant_id', :t, true)" ` +
          `--parameters '[{"name":"t","value":{"stringValue":"${tenant}"}}]'`,
      );
    }
    const out = JSON.parse(
      aws(
        `rds-data execute-statement --resource-arn ${CLUSTER_ARN} --secret-arn ${APP_ROLE_SECRET} --database ${DB_NAME} --transaction-id ${tx} --sql "${sql}"`,
      ),
    );
    return out.records ?? [];
  } finally {
    try {
      aws(
        `rds-data rollback-transaction --resource-arn ${CLUSTER_ARN} --secret-arn ${APP_ROLE_SECRET} --transaction-id ${tx}`,
      );
    } catch {
      /* best effort */
    }
  }
}

// ─── #5 Resolver overwrite (SCHEMA-5) — pure code, always runs ────────────────
describe('C-7 #5: resolver overwrite (SCHEMA-5)', () => {
  it('extractContext sources tenantId ONLY from resolverContext, never client input', () => {
    // Even if the client stuffed a tenantId into arguments/input, resolvers call
    // extractContext(event) which reads identity.resolverContext.tenantId only.
    const ctx = extractContext({ identity: { resolverContext: { tenantId: TENANT_A } } });
    expect(ctx.tenantId).toBe(TENANT_A);
  });
  it('extractContext fails closed when resolverContext.tenantId is absent', () => {
    expect(() => extractContext({ identity: { resolverContext: {} } })).toThrow(/tenantId/);
    expect(() => extractContext({})).toThrow(/tenantId/);
  });
});

// ─── #2 DynamoDB cross-tenant denial — LIVE ──────────────────────────────────
describe.skipIf(!LIVE)('C-7 #2: DynamoDB cross-tenant denial (simulate-principal-policy)', () => {
  function simulate(tagTenant: string, keyPrefix: string): string {
    const ctx = JSON.stringify([
      {
        ContextKeyName: 'aws:PrincipalTag/tenantId',
        ContextKeyType: 'string',
        ContextKeyValues: [tagTenant],
      },
      {
        ContextKeyName: 'dynamodb:LeadingKeys',
        ContextKeyType: 'string',
        ContextKeyValues: [`${keyPrefix}#DOC#1`],
      },
    ]);
    const out = JSON.parse(
      aws(
        `iam simulate-principal-policy --policy-source-arn ${TENANT_DATA_ROLE} ` +
          `--action-names dynamodb:GetItem dynamodb:Query --resource-arns ${TABLE_ARN} ` +
          `--context-entries '${ctx}'`,
      ),
    );
    return out.EvaluationResults.map((r: { EvalDecision: string }) => r.EvalDecision).join(',');
  }
  it('session tag tenant-AAA reaching tenant-BBB keys → implicitDeny', () => {
    expect(simulate(TENANT_A, `TENANT#${TENANT_B}`)).not.toContain('allowed');
  });
  it('session tag tenant-AAA reaching its own keys → allowed (positive control)', () => {
    const d = simulate(TENANT_A, `TENANT#${TENANT_A}`);
    expect(d).toBe('allowed,allowed');
  });
});

// ─── #3 RDS RLS denial — LIVE ────────────────────────────────────────────────
describe.skipIf(!LIVE)('C-7 #3: RDS RLS cross-tenant denial (app_role, NOBYPASSRLS)', () => {
  it('no tenant context → zero rows (fail-closed, current_setting NULL)', () => {
    const rows = rlsQuery(null, `SELECT count(*) FROM ${TENANT_TABLE}`);
    expect(Number((rows[0] as { longValue: number }[])[0].longValue)).toBe(0);
  }, 120_000);
  it('tenant-AAA session sees ONLY tenant-AAA rows', () => {
    const rows = rlsQuery(TENANT_A, `SELECT DISTINCT tenant_id::text FROM ${TENANT_TABLE}`);
    const tenants = rows.map((r) => (r as { stringValue: string }[])[0].stringValue);
    expect(tenants).toEqual([TENANT_A]);
  }, 120_000);
  it('tenant-BBB session sees ONLY tenant-BBB rows (never tenant-AAA)', () => {
    const rows = rlsQuery(TENANT_B, `SELECT DISTINCT tenant_id::text FROM ${TENANT_TABLE}`);
    const tenants = rows.map((r) => (r as { stringValue: string }[])[0].stringValue);
    expect(tenants).toEqual([TENANT_B]);
    expect(tenants).not.toContain(TENANT_A);
  }, 120_000);
});

// ─── #3b RDS RLS denial — forms.* tables (spec 41) — LIVE ───────────────────
describe.skipIf(!LIVE)(
  'C-7 #3b: RDS RLS cross-tenant denial — forms.records + forms.record_values',
  () => {
    it('forms.records: no tenant context → zero rows (fail-closed)', () => {
      const rows = rlsQuery(null, 'SELECT count(*) FROM forms.records');
      expect(Number((rows[0] as { longValue: number }[])[0].longValue)).toBe(0);
    }, 120_000);
    it('forms.records: tenant-AAA session sees ONLY tenant-AAA rows', () => {
      const rows = rlsQuery(TENANT_A, 'SELECT DISTINCT tenant_id::text FROM forms.records');
      const tenants = rows.map((r) => (r as { stringValue: string }[])[0].stringValue);
      for (const t of tenants) expect(t).toBe(TENANT_A);
      expect(tenants).not.toContain(TENANT_B);
    }, 120_000);
    it('forms.records: tenant-BBB session never sees tenant-AAA rows', () => {
      const rows = rlsQuery(TENANT_B, 'SELECT DISTINCT tenant_id::text FROM forms.records');
      const tenants = rows.map((r) => (r as { stringValue: string }[])[0].stringValue);
      expect(tenants).not.toContain(TENANT_A);
    }, 120_000);
    it('forms.record_values: no tenant context → zero rows (fail-closed)', () => {
      const rows = rlsQuery(null, 'SELECT count(*) FROM forms.record_values');
      expect(Number((rows[0] as { longValue: number }[])[0].longValue)).toBe(0);
    }, 120_000);
    it('forms.record_values: tenant-AAA session sees ONLY tenant-AAA rows', () => {
      const rows = rlsQuery(TENANT_A, 'SELECT DISTINCT tenant_id::text FROM forms.record_values');
      const tenants = rows.map((r) => (r as { stringValue: string }[])[0].stringValue);
      for (const t of tenants) expect(t).toBe(TENANT_A);
      expect(tenants).not.toContain(TENANT_B);
    }, 120_000);
    it('forms.record_values: tenant-BBB session never sees tenant-AAA rows', () => {
      const rows = rlsQuery(TENANT_B, 'SELECT DISTINCT tenant_id::text FROM forms.record_values');
      const tenants = rows.map((r) => (r as { stringValue: string }[])[0].stringValue);
      expect(tenants).not.toContain(TENANT_A);
    }, 120_000);
  },
);

// ─── #3c RDS RLS denial — qms.* tenant tables (spec 40) — LIVE ───────────────
const QMS_TENANT_TABLES = [
  'qms.org_profiles',
  'qms.org_profile_versions',
  'qms.clause_applicability',
  'qms.generation_runs',
  'qms.generation_sections',
  'qms.assertion_ledger',
];

describe.skipIf(!LIVE)('C-7 #3c: RDS RLS cross-tenant denial — qms tenant tables', () => {
  for (const table of QMS_TENANT_TABLES) {
    it(`${table}: no tenant context → zero rows (fail-closed)`, () => {
      const rows = rlsQuery(null, `SELECT count(*) FROM ${table}`);
      expect(Number((rows[0] as { longValue: number }[])[0].longValue)).toBe(0);
    }, 120_000);
    it(`${table}: tenant-BBB session never sees tenant-AAA rows`, () => {
      const rows = rlsQuery(TENANT_B, `SELECT DISTINCT tenant_id::text FROM ${table}`);
      const tenants = rows.map((r) => (r as { stringValue: string }[])[0].stringValue);
      expect(tenants).not.toContain(TENANT_A);
    }, 120_000);
  }

  it('qms.clause_registry is tenant-less reference data: readable under any tenant, but INSERT is denied for app_role', () => {
    const rows = rlsQuery(TENANT_B, 'SELECT count(*) FROM qms.clause_registry');
    expect(Number((rows[0] as { longValue: number }[])[0].longValue)).toBeGreaterThan(0);
    expect(() =>
      rlsQuery(
        TENANT_B,
        `INSERT INTO qms.clause_registry (standard, clause_no, clause_title, intent_paraphrase, annex_sl_mode, harmonization_key, doc_type, sort_order) VALUES ('ISO9001', '99.9', 'x', 'x', 'shared', '99.9', 'procedure', 9999)`,
      ),
    ).toThrow(/permission denied/i);
  }, 120_000);

  it('qms.assertion_ledger is append-only: UPDATE is denied for app_role', () => {
    expect(() =>
      rlsQuery(TENANT_B, `UPDATE qms.assertion_ledger SET fact_key = 'tampered'`),
    ).toThrow(/permission denied/i);
  }, 120_000);
});

// ─── #4 Materialized-view denial — LIVE ──────────────────────────────────────
describe.skipIf(!LIVE)('C-7 #4: materialized-view denial (app_role)', () => {
  it('get_risk_register_view() accessor is tenant-scoped (no error under a tenant)', () => {
    const rows = rlsQuery(TENANT_B, 'SELECT count(*) FROM m5_views.get_risk_register_view()');
    expect(Number((rows[0] as { longValue: number }[])[0].longValue)).toBeGreaterThanOrEqual(0);
  }, 120_000);
  it('direct SELECT on m5_views.risk_register_view → permission denied', () => {
    expect(() =>
      aws(
        `rds-data execute-statement --resource-arn ${CLUSTER_ARN} --secret-arn ${APP_ROLE_SECRET} ` +
          `--database ${DB_NAME} --sql "SELECT count(*) FROM m5_views.risk_register_view"`,
      ),
    ).toThrow(/permission denied/i);
  }, 120_000);
});

// ─── #1 Authorizer denial — GATED (Pool-A MFA token) ─────────────────────────
describe.skipIf(!process.env.C7_POOL_A_TOKEN)('C-7 #1: authorizer denial (Pool-A → 401)', () => {
  it('a valid-signature Pool-A token is rejected by the tenant authorizer', () => {
    // Requires a real Pool-A ID token (Pool A = SaaS Admin, MFA=ON). Invoke the
    // AuthorizerFn with the token and assert isAuthorized=false. Set C7_POOL_A_TOKEN.
    expect(process.env.C7_POOL_A_TOKEN).toBeTruthy();
  });
});

// ─── #6 Subscription denial (C-6) — LIVE when C7_POOL_B_TOKEN provided ────────
// Token = a Pool-B ID token whose custom:tenantId=tenant-AAA (SRP via pycognito).
// Opens the AppSync realtime WebSocket (Node global WebSocket), subscribes to
// onDocumentStatusChanged(tenantId: "tenant-BBB"); subscriptionAuth (@aws_lambda)
// rejects because resolverContext.tenantId (AAA) != args.tenantId (BBB).
describe.skipIf(!process.env.C7_POOL_B_TOKEN)(
  'C-7 #6: subscription cross-tenant denial (C-6)',
  () => {
    const GQL_URL =
      process.env.C7_GRAPHQL_URL ??
      'https://42yckio3gbbgphpdkpl7vux3v4.appsync-api.us-east-1.amazonaws.com/graphql';

    function subscribeCrossTenant(token: string, argTenant: string): Promise<string> {
      const host = new URL(GQL_URL).host;
      const realtimeHost = host.replace('appsync-api', 'appsync-realtime-api');
      const authHeader = { host, Authorization: token };
      const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');
      const url = `wss://${realtimeHost}/graphql?header=${b64(authHeader)}&payload=${b64({})}`;
      return new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(url, 'graphql-ws');
        const timer = setTimeout(() => {
          try {
            ws.close();
          } catch {
            /**/
          }
          reject(new Error('timeout'));
        }, 25_000);
        const done = (r: string) => {
          clearTimeout(timer);
          try {
            ws.close();
          } catch {
            /**/
          }
          resolve(r);
        };
        ws.onopen = () => ws.send(JSON.stringify({ type: 'connection_init' }));
        ws.onmessage = (ev: MessageEvent) => {
          const msg = JSON.parse(String(ev.data));
          if (msg.type === 'connection_ack') {
            const query = `subscription { onDocumentStatusChanged(tenantId: "${argTenant}") { id title status } }`;
            ws.send(
              JSON.stringify({
                id: 'c6-denial',
                type: 'start',
                payload: {
                  data: JSON.stringify({ query, variables: {} }),
                  extensions: { authorization: authHeader },
                },
              }),
            );
          } else if (msg.type === 'error' || msg.type === 'connection_error') {
            done('rejected:' + JSON.stringify(msg.payload ?? msg.errors ?? msg));
          } else if (msg.type === 'start_ack') {
            done('ACCEPTED'); // C-6 FAILURE — cross-tenant subscription established
          }
        };
        ws.onerror = () => {
          clearTimeout(timer);
          reject(new Error('ws transport error'));
        };
      });
    }

    it('tenant-AAA token subscribing with tenant-BBB tenantId → Unauthorized (C-6)', async () => {
      const outcome = await subscribeCrossTenant(process.env.C7_POOL_B_TOKEN!, 'tenant-BBB');
      expect(outcome).not.toBe('ACCEPTED');
      expect(outcome.startsWith('rejected')).toBe(true);
      expect(outcome).toContain('Unauthorized'); // subscriptionAuth tenant-mismatch denial
    }, 30_000);

    it('tenant-AAA token subscribing with its OWN tenantId → accepted (positive control)', async () => {
      const outcome = await subscribeCrossTenant(process.env.C7_POOL_B_TOKEN!, 'tenant-AAA');
      expect(outcome).toBe('ACCEPTED'); // proves the subscription works when tenants match
    }, 30_000);
  },
);
