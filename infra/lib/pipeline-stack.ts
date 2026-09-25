/**
 * PipelineStack — self-mutating CDK Pipeline in the management account.
 * Per AC-1.1 through AC-1.8, design §1.1.
 */

import * as cdk from 'aws-cdk-lib';
import * as pipelines from 'aws-cdk-lib/pipelines';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { CumplifyStage } from './cumplify-stage.js';
import { ENV_CONFIGS } from './env-config.js';
import { MgmtCostMonitor } from './mgmt-cost-monitor.js';

/**
 * Factory: creates the DeployFrontendContent CodeBuildStep for a given stage.
 * Builds the Next.js static export with env-specific config from envFromCfnOutputs,
 * assumes the per-env ContentDeployRole, syncs to S3, and invalidates CloudFront.
 * (SMOKE-2 design §2.4)
 */
function makeDeployFrontendStep(
  stage: CumplifyStage,
  envAccount: string,
  envName: string,
): pipelines.CodeBuildStep {
  // Synth-time ARN — deterministic role name enables IAM grant without runtime env vars (A-1)
  const contentDeployRoleArn = `arn:aws:iam::${envAccount}:role/cumplify-${envName}-frontend-content-deploy`;

  return new pipelines.CodeBuildStep('DeployFrontendContent', {
    envFromCfnOutputs: {
      NEXT_PUBLIC_GRAPHQL_URL: stage.graphqlApiUrlOutput,
      NEXT_PUBLIC_USER_POOL_ID: stage.poolBIdOutput,
      NEXT_PUBLIC_USER_POOL_CLIENT_ID: stage.poolBClientIdOutput,
      FRONTEND_BUCKET: stage.frontendBucketNameOutput,
      DISTRIBUTION_ID: stage.frontendDistributionIdOutput,
      CONTENT_DEPLOY_ROLE_ARN: stage.contentDeployRoleArnOutput,
    },
    // Explicit AssumeRole grant on the CodeBuild project role (not pipeline role).
    // CDK Pipelines does NOT auto-grant sts:AssumeRole for in-command assumes. (A-1)
    rolePolicyStatements: [
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['sts:AssumeRole'],
        resources: [contentDeployRoleArn],
      }),
    ],
    commands: [
      // cwd = repo root (CDK Pipelines default: source artifact at root)
      // NEXT_PUBLIC_* are already in OS env — load-env.mjs early-exits (§2.6)
      'cd frontend && npm ci && npm run build',
      // cwd is now frontend/ — out/ is relative here
      // Assume the env-account ContentDeployRole.
      // NEVER echo $CREDS or use set -x — credentials would appear in CloudWatch logs. (A-3)
      'CREDS=$(aws sts assume-role --role-arn "$CONTENT_DEPLOY_ROLE_ARN" --role-session-name pipeline-content-deploy --output json --no-cli-pager)',
      'export AWS_ACCESS_KEY_ID=$(echo "$CREDS" | jq -r .Credentials.AccessKeyId)',
      'export AWS_SECRET_ACCESS_KEY=$(echo "$CREDS" | jq -r .Credentials.SecretAccessKey)',
      'export AWS_SESSION_TOKEN=$(echo "$CREDS" | jq -r .Credentials.SessionToken)',
      // Sync static export to bucket; --delete removes stale objects (ghost-route prevention)
      'aws s3 sync out/ "s3://$FRONTEND_BUCKET/" --delete',
      // Invalidate CloudFront — fire-and-forget; propagation ~60s
      'aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" --paths "/*"',
    ],
    buildEnvironment: {
      buildImage: codebuild.LinuxBuildImage.fromCodeBuildImageId('aws/codebuild/standard:8.0'),
      computeType: codebuild.ComputeType.SMALL,
    },
  });
}

export class PipelineStack extends cdk.Stack {
  public readonly pipelineStages: cdk.Stage[] = [];
  public readonly pipeline: pipelines.CodePipeline;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // CodeStar Connection ARN from CDK context (AC-1.5 — never hardcoded)
    const connectionArn = this.node.tryGetContext('codestarConnectionArn') as string;

    const pipeline = new pipelines.CodePipeline(this, 'CumplifyPipeline', {
      pipelineName: 'CumplifyPipeline',
      crossAccountKeys: true, // AC-1.2 — REQUIRED for cross-account artifact bucket
      enableKeyRotation: true, // AC-1.2
      selfMutation: true, // AC-1.2 — pipeline updates its own definition

      synth: new pipelines.ShellStep('Synth', {
        input: pipelines.CodePipelineSource.connection('stffinfcti/Cumplify', 'develop', {
          connectionArn,
        }),
        commands: [
          'npm ci',
          // frontend has its own package tree; `npm run test` chains its vitest
          // suite, which cannot start without these deps (build 19b6d892 failed
          // on UNRESOLVED_IMPORT @vitejs/plugin-react — root ci only). Plain cd
          // form — npm's --prefix flag has install-target quirks.
          'cd frontend && npm ci && cd ..',
          'npm run test',
          // i18n gate: CLAUDE.md promised this check in CI but it was never
          // wired — 5 violations shipped unnoticed before 2026-07-22.
          'cd frontend && npm run i18n:check && cd ..',
          'npm run lint',
          'npm run typecheck',
          // Hard audit gate with an explicit EXPIRING allowlist — raw
          // `npm audit --audit-level=high` cannot express exceptions for deps
          // bundled inside another package's tarball (aws-cdk-lib
          // bundleDependencies), which broke Synth on GHSA-3jxr-9vmj-r5cp.
          // The gate only inspects the root lockfile, so frontend deps get
          // their own audit pass.
          'npx tsx scripts/audit-gate.ts',
          'npx tsx scripts/audit-gate.ts frontend',
          'npx cdk synth --all',
          // CDK Nag runs as an Aspect during synth; a Nag error fails synth here.
        ],
      }),

      codeBuildDefaults: {
        buildEnvironment: {
          // standard:8.0 (Ubuntu 24.04, Node 22 default) — required: toolchain
          // needs Node >= 20 (aws-cdk-lib 2.261, vitest 4); standard:7.0 ships
          // Node 18 and failed `npm run test` (build cfd8a62d, 2026-07-04).
          // No STANDARD_8_0 constant in installed aws-cdk-lib; image existence
          // verified via codebuild list-curated-environment-images (us-east-1).
          buildImage: codebuild.LinuxBuildImage.fromCodeBuildImageId('aws/codebuild/standard:8.0'),
          computeType: codebuild.ComputeType.SMALL,
        },
      },
    });

    // Dev — no gate (AC-1.3); content deploy step kills hand-deploy debt (SMOKE-2)
    const devStage = new CumplifyStage(this, 'Dev', {
      env: { account: ENV_CONFIGS.dev.account, region: ENV_CONFIGS.dev.region },
      envConfig: ENV_CONFIGS.dev,
    });
    pipeline.addStage(devStage, {
      post: [makeDeployFrontendStep(devStage, ENV_CONFIGS.dev.account, 'dev')],
    });
    this.pipelineStages.push(devStage);

    // Staging — ManualApprovalStep (pre) + DeployFrontendContent → SmokeTest (post) (AC-1.3, SMOKE-2)
    const stagingStage = new CumplifyStage(this, 'Staging', {
      env: { account: ENV_CONFIGS.staging.account, region: ENV_CONFIGS.staging.region },
      envConfig: ENV_CONFIGS.staging,
    });
    const stagingDeployContent = makeDeployFrontendStep(
      stagingStage,
      ENV_CONFIGS.staging.account,
      'staging',
    );
    const smokeTest = new pipelines.ShellStep('SmokeTest', {
      envFromCfnOutputs: {
        FRONTEND_DOMAIN: stagingStage.frontendDistributionDomainOutput,
      },
      commands: [
        // Content assertion, not status: the distribution rewrites 403/404 ->
        // /index.html 200, so an -f status check passes on any path.
        'curl -fsS "https://$FRONTEND_DOMAIN/" | grep -q "<title>Cumplify</title>"',
      ],
    });
    // Post steps are unordered by default — SmokeTest must run AFTER content ships.
    smokeTest.addStepDependency(stagingDeployContent);
    pipeline.addStage(stagingStage, {
      pre: [new pipelines.ManualApprovalStep('ApproveToStaging')],
      post: [stagingDeployContent, smokeTest],
    });
    this.pipelineStages.push(stagingStage);

    // Prod — ManualApprovalStep + LegalSignoffGuard (pre) + DeployFrontendContent (post) (AC-1.3, SMOKE-2)
    // No Prod SmokeTest — OQ-3: Prod post-deploy verification is a separate GA-hardening decision.
    const prodStage = new CumplifyStage(this, 'Prod', {
      env: { account: ENV_CONFIGS.prod.account, region: ENV_CONFIGS.prod.region },
      envConfig: ENV_CONFIGS.prod,
    });
    pipeline.addStage(prodStage, {
      pre: [
        new pipelines.ManualApprovalStep('ApproveToProd'),
        new pipelines.ShellStep('LegalSignoffGuard', {
          commands: ['npx tsx scripts/assert-legal-signoff.ts'],
        }),
      ],
      post: [makeDeployFrontendStep(prodStage, ENV_CONFIGS.prod.account, 'prod')],
    });
    this.pipelineStages.push(prodStage);

    // Force eager construction of CodeBuild projects and IAM roles so that
    // CDK Nag aspects can visit them and NagSuppressions can be applied.
    pipeline.buildPipeline();

    this.pipeline = pipeline;

    // Detective control: alert if the mgmt account's spend jumps (would signal
    // a workload resource landing here out-of-band, bypassing the pipeline the
    // preventive account-boundary guardrail protects).
    const alertEmail =
      (this.node.tryGetContext('costAlertEmail') as string) ?? 'julio@mbdesignremodel.com';
    const mgmtBudgetUsd = Number(this.node.tryGetContext('mgmtBudgetLimitUsd') ?? 50);
    new MgmtCostMonitor(this, 'MgmtCostMonitor', {
      alertEmail,
      monthlyBudgetUsd: mgmtBudgetUsd,
    });
  }
}
