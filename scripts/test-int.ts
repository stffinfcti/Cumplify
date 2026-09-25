/**
 * test-int — provisioning-aware runner for the *.int.test.ts lane.
 *
 * Int tests exercise LIVE AWS (AOSS, Aurora Data API, DDB, EventBridge, Cognito
 * tokens). They are excluded from `vitest run` (vitest.config.ts) and run via
 * vitest.int.config.ts. Every suite loud-skips when its provisioning is absent,
 * so an unprovisioned lane never reports a false green — this runner only adds
 * the up-front provisioning report and forwards args to vitest.
 *
 *   npm run test:int                                        # all int tests
 *   npm run test:int -- services/api/__tests__/cross-tenant-denial.int.test.ts
 *   C7_AWS_PROFILE=cumplify-dev-admin npm run test:int      # named CLI profile
 *   C7_AWS_PROFILE='' npm run test:int                      # ambient role (CI)
 *
 * Required env vars are ALSO documented in .env.example (repo root).
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

interface EnvSpec {
  name: string;
  neededBy: string;
  purpose: string;
}

const ENV_SPECS: EnvSpec[] = [
  {
    name: 'C7_AWS_PROFILE',
    neededBy: 'all live AWS calls (aws CLI in denial suite; mapped to AWS_PROFILE for SDK clients)',
    purpose:
      "AWS CLI profile for live calls. Default 'cumplify-dev-admin'; set '' to use the ambient job/CI role.",
  },
  {
    name: 'C7_CLUSTER_ARN',
    neededBy: 'cross-tenant-denial (RDS RLS cases #3/#4, rds-data)',
    purpose: 'Aurora cluster ARN for Data API calls (find in cdk-outputs.json / AWS console).',
  },
  {
    name: 'C7_APP_ROLE_SECRET_ARN',
    neededBy: 'cross-tenant-denial (rds-data app_role credentials)',
    purpose: 'Secrets Manager ARN of the RDS app_role secret (cumplify/<env>/rds/app-role*).',
  },
  {
    name: 'C7_TENANT_DATA_ROLE_ARN',
    neededBy: 'cross-tenant-denial (iam:SimulatePrincipalPolicy case #2)',
    purpose: 'Tenant-data role ARN — the DDB per-tenant scoping role being proven.',
  },
  {
    name: 'C7_TABLE_ARN',
    neededBy: 'cross-tenant-denial (DDB table policy simulation)',
    purpose: 'CumplifyCore DynamoDB table ARN.',
  },
  {
    name: 'C7_DB_NAME',
    neededBy: 'cross-tenant-denial (rds-data database name)',
    purpose: "Aurora database name. Default 'postgres'.",
  },
  {
    name: 'C7_GRAPHQL_URL',
    neededBy: 'cross-tenant-denial (subscription denial case #6)',
    purpose: 'Deployed AppSync GraphQL URL (cdk-outputs.json GraphqlApiUrl).',
  },
  {
    name: 'C7_POOL_A_TOKEN',
    neededBy: 'cross-tenant-denial (authorizer denial case #1)',
    purpose: 'Legacy Pool-A Cognito ID token (MFA-onboarded user) — proves authorizer rejects it.',
  },
  {
    name: 'C7_POOL_B_TOKEN',
    neededBy: 'cross-tenant-denial (subscription denial case #6)',
    purpose:
      'Pool-B Cognito ID token for a tenant-scoped user — proves cross-tenant subscription denial.',
  },
  {
    name: 'LIVE_AOSS_ENDPOINT',
    neededBy: 'cross-tenant-isolation (AOSS retrieval, REQ-RET-2)',
    purpose:
      'AOSS collection endpoint (https://<id>.<region>.aoss.amazonaws.com) pre-seeded with tenant-A/B docs.',
  },
];

function printProvisioningReport(): void {
  const profile = process.env.C7_AWS_PROFILE;
  const credsLine = profile
    ? `C7_AWS_PROFILE=${profile} (→ AWS_PROFILE for SDK clients)`
    : profile === ''
      ? 'ambient job/CI role (C7_AWS_PROFILE="")'
      : `unset (default 'cumplify-dev-admin' in suite code)`;
  console.log('=== test:int provisioning report ===');
  console.log(`credentials: ${credsLine}`);
  let set = 0;
  for (const spec of ENV_SPECS) {
    const present = Boolean(process.env[spec.name]);
    if (present) set += 1;
    console.log(`  ${present ? 'SET    ' : 'MISSING'} ${spec.name.padEnd(24)} ${spec.neededBy}`);
  }
  if (set === 0 && profile === undefined) {
    console.log(
      '  NOTE: nothing is provisioned — every int suite will LOUD-SKIP (this is ' +
        'by design: an unprovisioned lane reports a loud failure, not a green). ' +
        'See .env.example for the variable list.',
    );
  }
  console.log('====================================');
}

function main(): void {
  printProvisioningReport();

  // Map C7_AWS_PROFILE → AWS_PROFILE so default-credential-chain SDK clients
  // (EventBridgeClient in event-pattern, AOSS signer in cross-tenant-isolation)
  // use the same identity as the aws CLI calls in the denial suite.
  const env = { ...process.env };
  if (env.C7_AWS_PROFILE && !env.AWS_PROFILE) {
    env.AWS_PROFILE = env.C7_AWS_PROFILE;
  }

  const extraArgs = process.argv.slice(2).filter((a) => a !== '--');
  const vitestArgs = ['vitest', 'run', '--config', 'vitest.int.config.ts', ...extraArgs];
  const result = spawnSync('npx', vitestArgs, {
    cwd: ROOT,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  process.exit(result.status ?? 1);
}

main();
