/**
 * Template-assertion tests for NetworkStack.
 *
 * Created with spec-35 FIX-T20-3: this VPC is zero-NAT, so an in-VPC Lambda
 * has NO egress except the endpoint set below — a missing interface endpoint
 * silently breaks every AWS API call behind it (the guru→invoker
 * lambda:Invoke hop was the live casualty class). These tests pin the set
 * against future trimming.
 */

import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { NetworkStack } from './network-stack.js';
import { ENV_CONFIGS } from './env-config.js';

function createTestTemplate(): Template {
  const app = new cdk.App();
  const envConfig = ENV_CONFIGS.dev;
  const stack = new NetworkStack(app, 'TestNetworkStack', {
    envConfig,
    env: { account: envConfig.account, region: envConfig.region },
  });
  return Template.fromStack(stack);
}

describe('NetworkStack — zero-NAT endpoint topology (AC-2)', () => {
  const template = createTestTemplate();

  it('VPC has zero NAT gateways (AC-2.4 cost lever)', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
  });

  it('interface-endpoint set covers every service in-VPC Lambdas call, incl. Lambda (FIX-T20-3)', () => {
    const eps = template.findResources('AWS::EC2::VPCEndpoint');
    // ServiceName renders as an Fn::Join around the region token — match on
    // the literal service suffix segment.
    const rendered = Object.values(eps).map((e) =>
      JSON.stringify((e.Properties as { ServiceName: unknown }).ServiceName),
    );
    // S2.1: .states (HITL gate SFN StartExecution) + .sqs (consumer DLQ sends)
    // admit the VPC-placed SQS-consumer agents (CAPAGuru, DocStudio).
    for (const suffix of [
      '.aoss"',
      '.secretsmanager"',
      '.kms"',
      '.bedrock-runtime"',
      '.execute-api"',
      '.lambda"',
      '.states"',
      '.sqs"',
    ]) {
      expect(
        rendered.some((s) => s.includes(suffix)),
        `missing interface endpoint for ${suffix.replace(/"/g, '')}`,
      ).toBe(true);
    }
  });

  it('AOSS data-plane VPC endpoint exists (network policy SourceVPCEs target)', () => {
    template.resourceCountIs('AWS::OpenSearchServerless::VpcEndpoint', 1);
  });

  it('S3 + DynamoDB gateway endpoints exist (free tier of the egress set)', () => {
    const eps = template.findResources('AWS::EC2::VPCEndpoint');
    const gateways = Object.values(eps).filter(
      (e) => (e.Properties as { VpcEndpointType?: string }).VpcEndpointType === 'Gateway',
    );
    const rendered = gateways.map((e) =>
      JSON.stringify((e.Properties as { ServiceName: unknown }).ServiceName),
    );
    expect(rendered.some((s) => s.includes('.s3"'))).toBe(true);
    expect(rendered.some((s) => s.includes('.dynamodb"'))).toBe(true);
  });
});
