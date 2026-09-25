/**
 * PipelineStack regression pin — SMOKE-1 fix + SMOKE-2 content deploy.
 * Asserts the SmokeTest step:
 *   (a) does NOT contain `|| true` (failure must never be swallowed)
 *   (b) contains the content assertion `grep -q "<title>Cumplify</title>"`
 *   (c) wires FRONTEND_DOMAIN from the Staging FrontendStack output
 * Asserts DeployFrontendContent step (SMOKE-2 §4.1):
 *   - exists in Dev, Staging, and Prod stages
 *   - Staging SmokeTest depends on DeployFrontendContent (action RunOrder)
 *   - sts:AssumeRole grant on three exact deterministic ARNs (OQ-1 confirmation)
 *   - required env vars wired from envFromCfnOutputs on the Staging action
 */

import { describe, expect, it } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { PipelineStack } from './pipeline-stack.js';

// Shared setup — synth once, reuse across describe blocks
const app = new cdk.App({
  context: {
    codestarConnectionArn:
      'arn:aws:codestar-connections:us-east-1:157082218687:connection/test-conn-id',
  },
});
const stack = new PipelineStack(app, 'TestPipelineStack', {
  env: { account: '157082218687', region: 'us-east-1' },
});
const template = Template.fromStack(stack);

// ─── helpers ────────────────────────────────────────────────────────────────

function getPipelineStages(): Array<{ Name: string; Actions: any[] }> {
  const pipelineResources = template.findResources('AWS::CodePipeline::Pipeline');
  return Object.values(pipelineResources).flatMap(
    (p) => (p.Properties?.Stages ?? []) as Array<{ Name: string; Actions: any[] }>,
  );
}

function getSmokeTestBuildSpecs(): string[] {
  const codeBuildProjects = template.findResources('AWS::CodeBuild::Project');
  const buildSpecs: string[] = [];
  for (const [, resource] of Object.entries(codeBuildProjects)) {
    const source = resource.Properties?.Source;
    if (!source?.BuildSpec) continue;
    const spec =
      typeof source.BuildSpec === 'string' ? source.BuildSpec : JSON.stringify(source.BuildSpec);
    if (
      spec.includes('Cumplify') ||
      spec.includes('staging.cumplify.ai') ||
      spec.includes('|| true')
    ) {
      buildSpecs.push(spec);
    }
  }
  return buildSpecs;
}

// ─── SMOKE-1 regression ──────────────────────────────────────────────────────

describe('PipelineStack — SmokeTest step (SMOKE-1 regression)', () => {
  it('(a) SmokeTest buildspec does NOT contain "|| true"', () => {
    const specs = getSmokeTestBuildSpecs();
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) {
      expect(spec).not.toContain('|| true');
    }
  });

  it('(b) SmokeTest buildspec contains the content assertion grep', () => {
    const specs = getSmokeTestBuildSpecs();
    expect(specs.length).toBeGreaterThan(0);
    const hasGrep = specs.some(
      (s) => s.includes('grep -q') && s.includes('<title>Cumplify</title>'),
    );
    expect(hasGrep).toBe(true);
  });

  it('(c) SmokeTest buildspec wires FRONTEND_DOMAIN from Staging FrontendStack output', () => {
    const specs = getSmokeTestBuildSpecs();
    expect(specs.length).toBeGreaterThan(0);
    const hasDomainEnv = specs.some((s) => s.includes('FRONTEND_DOMAIN'));
    expect(hasDomainEnv).toBe(true);
  });
});

// ─── SMOKE-2 DeployFrontendContent ───────────────────────────────────────────

describe('PipelineStack — DeployFrontendContent step (SMOKE-2 §4.1)', () => {
  it('DeployFrontendContent action exists in Dev stage', () => {
    const stages = getPipelineStages();
    const dev = stages.find((s) => s.Name === 'Dev');
    expect(dev).toBeDefined();
    const deploy = dev!.Actions.find((a: any) => a.Name === 'DeployFrontendContent');
    expect(deploy).toBeDefined();
  });

  it('DeployFrontendContent action exists in Staging stage', () => {
    const stages = getPipelineStages();
    const staging = stages.find((s) => s.Name === 'Staging');
    expect(staging).toBeDefined();
    const deploy = staging!.Actions.find((a: any) => a.Name === 'DeployFrontendContent');
    expect(deploy).toBeDefined();
  });

  it('DeployFrontendContent action exists in Prod stage', () => {
    const stages = getPipelineStages();
    const prod = stages.find((s) => s.Name === 'Prod');
    expect(prod).toBeDefined();
    const deploy = prod!.Actions.find((a: any) => a.Name === 'DeployFrontendContent');
    expect(deploy).toBeDefined();
  });

  it('Staging SmokeTest runs after DeployFrontendContent (RunOrder)', () => {
    const stages = getPipelineStages();
    const staging = stages.find((s) => s.Name === 'Staging');
    expect(staging).toBeDefined();
    const deployAction = staging!.Actions.find((a: any) => a.Name === 'DeployFrontendContent');
    const smokeAction = staging!.Actions.find((a: any) => a.Name === 'SmokeTest');
    expect(deployAction).toBeDefined();
    expect(smokeAction).toBeDefined();
    // RunOrder: higher number = later; addStepDependency enforces this
    expect(smokeAction!.RunOrder).toBeGreaterThan(deployAction!.RunOrder);
  });

  it('step project role has sts:AssumeRole on three exact deterministic ContentDeployRole ARNs (OQ-1)', () => {
    const iamPolicies = template.findResources('AWS::IAM::Policy');
    const expectedArns = [
      'arn:aws:iam::697114252993:role/cumplify-dev-frontend-content-deploy',
      'arn:aws:iam::889007427685:role/cumplify-staging-frontend-content-deploy',
      'arn:aws:iam::077405654066:role/cumplify-prod-frontend-content-deploy',
    ];
    const matchedArns: string[] = [];
    for (const [, policy] of Object.entries(iamPolicies)) {
      const statements = policy.Properties?.PolicyDocument?.Statement ?? [];
      for (const stmt of statements) {
        if (
          stmt.Effect === 'Allow' &&
          (stmt.Action === 'sts:AssumeRole' ||
            (Array.isArray(stmt.Action) && stmt.Action.includes('sts:AssumeRole')))
        ) {
          const resources = Array.isArray(stmt.Resource) ? stmt.Resource : [stmt.Resource];
          for (const r of resources) {
            if (typeof r === 'string' && expectedArns.includes(r)) {
              matchedArns.push(r);
            }
          }
        }
      }
    }
    for (const arn of expectedArns) {
      expect(matchedArns, `Expected sts:AssumeRole grant on ${arn}`).toContain(arn);
    }
  });

  it('Staging DeployFrontendContent action wires required env vars from envFromCfnOutputs', () => {
    const stages = getPipelineStages();
    const staging = stages.find((s) => s.Name === 'Staging');
    expect(staging).toBeDefined();
    const deploy = staging!.Actions.find((a: any) => a.Name === 'DeployFrontendContent');
    expect(deploy).toBeDefined();
    const envVars = JSON.parse(deploy!.Configuration.EnvironmentVariables as string) as Array<{
      name: string;
      value: string;
    }>;
    const varNames = envVars.map((v) => v.name);
    expect(varNames).toContain('NEXT_PUBLIC_GRAPHQL_URL');
    expect(varNames).toContain('NEXT_PUBLIC_USER_POOL_ID');
    expect(varNames).toContain('NEXT_PUBLIC_USER_POOL_CLIENT_ID');
    expect(varNames).toContain('FRONTEND_BUCKET');
    expect(varNames).toContain('DISTRIBUTION_ID');
    expect(varNames).toContain('CONTENT_DEPLOY_ROLE_ARN');
  });
});
