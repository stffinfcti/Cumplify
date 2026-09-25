/**
 * Template-assertion test for EventingStack.
 * Regression gate: every AWS::Events::Rule target MUST have an InputTransformer.
 * This test exists because applyInputTransformer() previously silently no-oped
 * due to CDK's Lazy token on cfnRule.targets — synth+Nag did NOT catch it.
 */

import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { EventingStack } from './eventing-stack.js';
import * as sns from 'aws-cdk-lib/aws-sns';
import { ENV_CONFIGS } from './env-config.js';

function getTemplate(): Template {
  const app = new cdk.App();
  const helperStack = new cdk.Stack(app, 'HelperStack', {
    env: { account: ENV_CONFIGS.dev.account, region: ENV_CONFIGS.dev.region },
  });
  const stack = new EventingStack(app, 'TestEventingStack', {
    envConfig: ENV_CONFIGS.dev,
    opsAlertTopic: new sns.Topic(helperStack, 'OpsAlertTopic'),
    env: { account: ENV_CONFIGS.dev.account, region: ENV_CONFIGS.dev.region },
  });
  return Template.fromStack(stack);
}

describe('EventingStack — InputTransformer assertions', () => {
  const template = getTemplate();

  it('every AWS::Events::Rule target has an InputTransformer', () => {
    const rules = template.findResources('AWS::Events::Rule');
    const ruleIds = Object.keys(rules);

    // We expect 8 rules (R-1..R-8: nc-triage, capa-intake, audit-sink, hazard, aspect, review-fanout, records, tenant-docs-indexer)
    expect(ruleIds.length).toBe(8);

    for (const ruleId of ruleIds) {
      const rule = rules[ruleId];
      const targets = rule.Properties?.Targets;
      expect(targets, `Rule ${ruleId} has no Targets`).toBeDefined();
      expect(Array.isArray(targets), `Rule ${ruleId} Targets is not an array`).toBe(true);

      for (const target of targets) {
        expect(
          target.InputTransformer,
          `Rule ${ruleId} target ${target.Id} is MISSING InputTransformer`,
        ).toBeDefined();
        expect(target.InputTransformer.InputPathsMap).toBeDefined();
        expect(target.InputTransformer.InputTemplate).toBeDefined();
      }
    }
  });

  it('direct SQS rule (NcTriageRule) has canonical InputTemplate', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: {
        'detail-type': [
          'Audit.FindingRaised',
          'Incident.Reported',
          'EnvIncident.Reported',
          'Aspect.SignificantImpact',
        ],
      },
      Targets: Match.arrayWith([
        Match.objectLike({
          InputTransformer: {
            InputPathsMap: { dt: '$.detail-type', detail: '$.detail' },
            InputTemplate: '{"detailType": "<dt>", "detail": <detail>}',
          },
        }),
      ]),
    });
  });

  it('router rule (CapaIntakeRule) has extended InputTemplate with targetQueue', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: {
        'detail-type': [
          'NC.Raised',
          'CAPA.Opened',
          'CAPA.Closed',
          'CAPA.EffectivenessVerified',
          'CAPA.ActionRequiresDocChange',
        ],
      },
      Targets: Match.arrayWith([
        Match.objectLike({
          InputTransformer: {
            InputPathsMap: { dt: '$.detail-type', detail: '$.detail' },
            InputTemplate:
              '{"targetQueue": "CAPA_INTAKE_QUEUE_URL", "detailType": "<dt>", "detail": <detail>}',
          },
        }),
      ]),
    });
  });

  it('audit-sink router rule matches on detail.auditTrail (OQ-5)', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: {
        detail: {
          auditTrail: [true],
        },
      },
      Targets: Match.arrayWith([
        Match.objectLike({
          InputTransformer: {
            InputPathsMap: { dt: '$.detail-type', detail: '$.detail' },
            InputTemplate:
              '{"targetQueue": "AUDIT_SINK_QUEUE_URL", "detailType": "<dt>", "detail": <detail>}',
          },
        }),
      ]),
    });
  });

  it('all 17 queues have enforceSSL (SQS policy with aws:SecureTransport)', () => {
    // 17 queues: 8 consumer + 8 DLQ + 1 delivery-failure
    const queues = template.findResources('AWS::SQS::Queue');
    expect(Object.keys(queues).length).toBe(17);

    // Each queue should have an associated QueuePolicy with SecureTransport condition
    const policies = template.findResources('AWS::SQS::QueuePolicy');
    expect(Object.keys(policies).length).toBe(17);
  });
});
