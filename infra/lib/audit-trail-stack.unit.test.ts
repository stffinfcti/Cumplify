/**
 * Template-assertion tests for AuditTrailStack (C-12).
 * Proves: ESM FilterCriteria, IAM Deny policy, absence of events:PutEvents.
 */

import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AuditTrailStack } from './audit-trail-stack.js';
import type { EnvConfig } from './env-config.js';

const testEnvConfig: EnvConfig = {
  envName: 'dev',
  account: '697114252993',
  alertEmail: 'test-alerts@example.com',
  region: 'us-east-1',
  availabilityZones: ['us-east-1b', 'us-east-1c'],
  globalTableReplica: false,
  drRegionStack: false,
  secretsReplica: false,
  s3Crr: false,
  aossStandby: false,
  auroraMinCapacity: 0,
  auroraMaxCapacity: 4,
  cacheMultiAz: false,
  cacheNodeType: 'cache.t4g.micro',
  auditArchiveRetentionDays: 1,
  evidenceRetentionDays: 1,
  evidenceRetentionMode: 'GOVERNANCE',
};

function createTemplate(): Template {
  const app = new cdk.App();

  // Create keys in a stack in the same env as AuditTrailStack
  const helperStack = new cdk.Stack(app, 'HelperStack', {
    env: { account: '697114252993', region: 'us-east-1' },
  });
  const ddbKey = new kms.Key(helperStack, 'DdbKey');
  const s3Key = new kms.Key(helperStack, 'S3Key');

  const auditTrailStack = new AuditTrailStack(app, 'AuditTrailStack', {
    envConfig: testEnvConfig,
    tableArn: 'arn:aws:dynamodb:us-east-1:697114252993:table/CumplifyCore',
    tableName: 'CumplifyCore',
    tableStreamArn:
      'arn:aws:dynamodb:us-east-1:697114252993:table/CumplifyCore/stream/2026-07-04T00:00:00.000',
    dynamodbKey: ddbKey,
    s3GeneralKey: s3Key,
    auditSinkQueueArn: 'arn:aws:sqs:us-east-1:697114252993:AuditSinkQueue.fifo',
    auditSinkDlqUrl: 'https://sqs.us-east-1.amazonaws.com/697114252993/AuditSinkDlq.fifo',
    auditSinkDlqArn: 'arn:aws:sqs:us-east-1:697114252993:AuditSinkDlq.fifo',
    opsAlertTopic: new sns.Topic(helperStack, 'OpsAlertTopic'),
    env: { account: '697114252993', region: 'us-east-1' },
  });

  return Template.fromStack(auditTrailStack);
}

describe('AuditTrailStack template assertions', () => {
  let template: Template;

  beforeAll(() => {
    template = createTemplate();
  });

  describe('Sealer ESM FilterCriteria (FIX-4)', () => {
    it('contains INSERT + itemType=AUDITLOG filter on NewImage', () => {
      // Find ESMs that have our sealer filter
      const esms = template.findResources('AWS::Lambda::EventSourceMapping', {
        Properties: {
          FilterCriteria: {
            Filters: Match.arrayWith([
              Match.objectLike({
                Pattern: Match.anyValue(),
              }),
            ]),
          },
        },
      });

      const esmKeys = Object.keys(esms);
      // Should have at least 2 DynamoDB ESMs (sealer + tripwire) + 1 SQS ESM
      expect(esmKeys.length).toBeGreaterThanOrEqual(2);

      // Find the sealer ESM (INSERT filter)
      const sealerPattern = JSON.stringify({
        eventName: ['INSERT'],
        dynamodb: { NewImage: { itemType: { S: ['AUDITLOG'] } } },
      });

      const hasSealerFilter = esmKeys.some((key) => {
        const filters = esms[key].Properties?.FilterCriteria?.Filters;
        return filters?.some((f: any) => f.Pattern === sealerPattern);
      });
      expect(hasSealerFilter).toBe(true);
    });
  });

  describe('Tripwire ESM FilterCriteria (FIX-4)', () => {
    it('contains MODIFY/REMOVE + itemType=AUDITLOG filter on OldImage', () => {
      const esms = template.findResources('AWS::Lambda::EventSourceMapping');

      const tripwirePattern = JSON.stringify({
        eventName: ['MODIFY', 'REMOVE'],
        dynamodb: { OldImage: { itemType: { S: ['AUDITLOG'] } } },
      });

      const hasTripwireFilter = Object.values(esms).some((esm: any) => {
        const filters = esm.Properties?.FilterCriteria?.Filters;
        return filters?.some((f: any) => f.Pattern === tripwirePattern);
      });
      expect(hasTripwireFilter).toBe(true);
    });
  });

  describe('IAM Deny Policy (FIX-2)', () => {
    it('contains DenyAuditLogMutation with 5 actions and ForAnyValue:StringLike condition', () => {
      template.hasResourceProperties('AWS::IAM::ManagedPolicy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Sid: 'DenyAuditLogMutation',
              Effect: 'Deny',
              Action: [
                'dynamodb:UpdateItem',
                'dynamodb:DeleteItem',
                'dynamodb:BatchWriteItem',
                'dynamodb:PartiQLUpdate',
                'dynamodb:PartiQLDelete',
              ],
              Condition: {
                'ForAnyValue:StringLike': {
                  'dynamodb:LeadingKeys': ['TENANT#*#AUDITLOG'],
                },
              },
            }),
          ]),
        },
      });
    });
  });

  describe('Loop Prevention (LOOP-3)', () => {
    it('no events:PutEvents grant exists anywhere in the template', () => {
      const templateJson = JSON.stringify(template.toJSON());
      expect(templateJson).not.toContain('events:PutEvents');
    });
  });

  describe('Least-privilege on AUDITLOG mutation (gate FINDING-1)', () => {
    it('no Allow statement grants dynamodb:UpdateItem or dynamodb:DeleteItem — those appear only in the Deny', () => {
      const json = template.toJSON() as {
        Resources: Record<string, { Type: string; Properties?: any }>;
      };
      const mutationActions = [
        'dynamodb:UpdateItem',
        'dynamodb:DeleteItem',
        'dynamodb:BatchWriteItem',
      ];
      const offenders: string[] = [];
      for (const [id, res] of Object.entries(json.Resources)) {
        if (res.Type !== 'AWS::IAM::Policy' && res.Type !== 'AWS::IAM::ManagedPolicy') continue;
        const statements = res.Properties?.PolicyDocument?.Statement ?? [];
        for (const st of statements) {
          if (st.Effect !== 'Allow') continue;
          const actions = Array.isArray(st.Action) ? st.Action : [st.Action];
          for (const a of actions) {
            if (mutationActions.includes(a)) offenders.push(`${id}: Allow ${a}`);
          }
        }
      }
      expect(
        offenders,
        `Allow statements must not grant AUDITLOG-mutation actions: ${offenders.join(', ')}`,
      ).toHaveLength(0);
    });
  });
});

// vitest globals
import { beforeAll } from 'vitest';
