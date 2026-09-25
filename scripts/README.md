# scripts/ — repo automation

| Script | Purpose |
| --- | --- |
| `verify.ts` (`npm run verify`) | Evidence gate: npm ci → tsc → lint+prettier+codegen drift → unit tests → cdk synth → targeted int tests |
| `audit-gate.ts` | `npm audit` with expiring allowlist (`audit-allowlist.json`; `expires` REQUIRED — missing/expired entries fail) |
| `gen-role-matrix.ts` (`npm run gen:role-matrix` / `check:role-matrix`) | Emits `frontend/src/lib/role-matrix.ts` from the authoritative `services/api/src/permissions/role-matrix.ts`; `--check` fails on drift (wired into verify step 3) |
| `test-int.ts` (`npm run test:int`) | Provisioning-aware runner for `*.int.test.ts` (live AWS); prints the env report then runs vitest.int.config.ts |
| `assert-legal-signoff.ts` | Legal sign-off assertion for the pipeline |
| `framer-sync.mjs` / `verify-framer.mjs` | Framer design sync helpers |

## Integration lane (`npm run test:int`)

`*.int.test.ts` files exercise live AWS and are excluded from `vitest run`.
Every suite loud-skips when its provisioning is absent, so an unprovisioned
lane reports a loud failure — never a false green.

Required/provisioning env vars (also in repo-root `.env.example`):

| Var | Needed by | Purpose |
| --- | --- | --- |
| `C7_AWS_PROFILE` | all live calls | AWS CLI profile (default `cumplify-dev-admin`); `''` → ambient job role (CI). Runner maps it to `AWS_PROFILE` for SDK clients. |
| `C7_CLUSTER_ARN` | api denial suite | Aurora cluster ARN for rds-data (RLS cases #3/#4) |
| `C7_APP_ROLE_SECRET_ARN` | api denial suite | Secrets Manager ARN of the RDS `app_role` secret |
| `C7_TENANT_DATA_ROLE_ARN` | api denial suite | Tenant-data role ARN (case #2, `iam:SimulatePrincipalPolicy`) |
| `C7_TABLE_ARN` | api denial suite | CumplifyCore DynamoDB table ARN |
| `C7_DB_NAME` | api denial suite | Aurora DB name (default `postgres`) |
| `C7_GRAPHQL_URL` | api denial suite | Deployed AppSync URL (subscription denial case #6) |
| `C7_POOL_A_TOKEN` | api denial suite | Legacy Pool-A Cognito ID token (case #1 — authorizer rejection proof) |
| `C7_POOL_B_TOKEN` | api denial suite | Pool-B Cognito ID token (case #6) |
| `LIVE_AOSS_ENDPOINT` | agents isolation suite | AOSS collection endpoint pre-seeded with tenant-A/B docs (REQ-RET-2) |

Deployed values come from `cdk-outputs.json` / stack outputs. No AWS resources
are created by the lane — provision first, then run.
