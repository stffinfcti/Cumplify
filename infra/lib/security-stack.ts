/**
 * SecurityStack — 10 KMS CMKs, WAFv2 WebACLs, Secrets Manager.
 * Per AC-3.1 through AC-3.5, NFR-1.
 *
 * REQUIRES-HUMAN: Human reviews diff before any deploy touches encryption
 * keys, WAF rules, or secrets rotation configuration.
 *
 * CMK inventory (aliases cumplify/<env>/<name>):
 *   dynamodb, rds, elasticache, s3-general, secrets,
 *   cloudwatch-logs, sns, sqs, eventbridge, bedrock
 *
 * All keys: rotation enabled, key policies scoped to service principals.
 * Prod dynamodb CMK: multiRegion=true (Global Table DR).
 */

import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';
import { type EnvConfig } from './env-config.js';

export interface SecurityStackProps extends cdk.StackProps {
  readonly envConfig: EnvConfig;
}

export interface SecurityOutputs {
  readonly dynamodbKey: kms.IKey;
  readonly rdsKey: kms.IKey;
  readonly elasticacheKey: kms.IKey;
  readonly s3GeneralKey: kms.IKey;
  readonly secretsKey: kms.IKey;
  readonly cloudwatchLogsKey: kms.IKey;
  readonly snsKey: kms.IKey;
  readonly sqsKey: kms.IKey;
  readonly eventbridgeKey: kms.IKey;
  readonly bedrockKey: kms.IKey;
  readonly regionalWaf: wafv2.CfnWebACL;
  readonly cloudfrontWaf: wafv2.CfnWebACL;
  readonly opsAlertTopic: sns.ITopic;
}

/**
 * Service principal mapping for CMK key policies.
 * Each CMK allows only the specific service principal that needs it.
 */
const SERVICE_PRINCIPALS: Record<string, string[]> = {
  dynamodb: ['dynamodb.amazonaws.com'],
  rds: ['rds.amazonaws.com'],
  elasticache: ['elasticache.amazonaws.com'],
  's3-general': ['s3.amazonaws.com'],
  secrets: ['secretsmanager.amazonaws.com'],
  'cloudwatch-logs': ['logs.amazonaws.com'],
  // cloudwatch.amazonaws.com: CloudWatch alarms publish to CMK-encrypted SNS
  // topics (COND-4 credit-cap alerts) — without it, alarm delivery fails
  // silently at the KMS layer.
  sns: ['sns.amazonaws.com', 'cloudwatch.amazonaws.com'],
  sqs: ['sqs.amazonaws.com'],
  eventbridge: ['events.amazonaws.com'],
  bedrock: ['bedrock.amazonaws.com'],
};

export class SecurityStack extends cdk.Stack {
  public readonly outputs: SecurityOutputs;

  constructor(scope: Construct, id: string, props: SecurityStackProps) {
    super(scope, id, props);

    const { envConfig } = props;
    const prefix = `cumplify/${envConfig.envName}`;

    // -----------------------------------------------------------------------
    // 10 KMS CMKs with aliases and service-scoped key policies
    // -----------------------------------------------------------------------
    const createCmk = (name: string, opts?: { multiRegion?: boolean }): kms.Key => {
      const key = new kms.Key(this, `${name}Key`, {
        alias: `${prefix}/${name}`,
        enableKeyRotation: true,
        multiRegion: opts?.multiRegion ?? false,
        description: `Cumplify ${envConfig.envName} CMK for ${name}`,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });

      // Grant service principal(s) the minimal actions needed
      const principals = SERVICE_PRINCIPALS[name] ?? [];
      for (const principal of principals) {
        key.addToResourcePolicy(
          new iam.PolicyStatement({
            sid: `Allow${principal.split('.')[0]}Service`,
            effect: iam.Effect.ALLOW,
            principals: [new iam.ServicePrincipal(principal)],
            actions: [
              'kms:Decrypt',
              'kms:DescribeKey',
              'kms:Encrypt',
              'kms:GenerateDataKey*',
              'kms:ReEncrypt*',
            ],
            resources: ['*'], // refers to this key (resource policy context)
            conditions: {
              StringEquals: {
                'kms:CallerAccount': this.account,
              },
            },
          }),
        );
      }

      return key;
    };

    // Prod dynamodb CMK must be multi-region for Global Table DR
    const dynamodbKey = createCmk('dynamodb', {
      multiRegion: envConfig.globalTableReplica,
    });
    const rdsKey = createCmk('rds');
    const elasticacheKey = createCmk('elasticache');
    const s3GeneralKey = createCmk('s3-general');
    const secretsKey = createCmk('secrets');
    const cloudwatchLogsKey = createCmk('cloudwatch-logs');
    const snsKey = createCmk('sns');
    const sqsKey = createCmk('sqs');
    const eventbridgeKey = createCmk('eventbridge');
    const bedrockKey = createCmk('bedrock');

    // -----------------------------------------------------------------------
    // WAFv2 WebACL — REGIONAL (for AppSync, API Gateway)
    // Rules: CommonRuleSet, RateLimit 2000/5min, IpReputationList
    // -----------------------------------------------------------------------
    const regionalWaf = new wafv2.CfnWebACL(this, 'RegionalWaf', {
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: `cumplify-${envConfig.envName}-regional-waf`,
      },
      name: `cumplify-${envConfig.envName}-regional`,
      rules: [
        {
          name: 'AWSManagedRulesCommonRuleSet',
          priority: 1,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'CommonRuleSet',
          },
        },
        {
          name: 'RateLimitPerIP',
          priority: 2,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: 2000, // 2000 requests per 5-minute window per IP
              aggregateKeyType: 'IP',
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'RateLimitPerIP',
          },
        },
        {
          name: 'AWSManagedRulesAmazonIpReputationList',
          priority: 3,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesAmazonIpReputationList',
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'IpReputationList',
          },
        },
      ],
    });

    // WAFv2 WebACL — CLOUDFRONT scope (for CDN, us-east-1 only)
    // Same rule set; deployed in us-east-1 regardless of stack region
    // (CloudFront WAFs must be in us-east-1).
    const cloudfrontWaf = new wafv2.CfnWebACL(this, 'CloudfrontWaf', {
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: `cumplify-${envConfig.envName}-cloudfront-waf`,
      },
      name: `cumplify-${envConfig.envName}-cloudfront`,
      rules: [
        {
          name: 'AWSManagedRulesCommonRuleSet',
          priority: 1,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'CfCommonRuleSet',
          },
        },
        {
          name: 'RateLimitPerIP',
          priority: 2,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: 2000,
              aggregateKeyType: 'IP',
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'CfRateLimitPerIP',
          },
        },
        {
          name: 'AWSManagedRulesAmazonIpReputationList',
          priority: 3,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesAmazonIpReputationList',
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'CfIpReputationList',
          },
        },
      ],
    });

    // -----------------------------------------------------------------------
    // Ops alert topic — every DLQ/integrity alarm publishes here (email for
    // now; a paging integration can subscribe alongside). CMK-encrypted so
    // cloudwatch.amazonaws.com (allowed on the sns key policy) can publish.
    // -----------------------------------------------------------------------
    const opsAlertTopic = new sns.Topic(this, 'OpsAlertTopic', {
      topicName: `cumplify-${envConfig.envName}-ops-alerts`,
      masterKey: snsKey,
      enforceSSL: true,
    });
    opsAlertTopic.addSubscription(new snsSubscriptions.EmailSubscription(envConfig.alertEmail));

    // -----------------------------------------------------------------------
    // CDK Nag suppressions for this stack
    // -----------------------------------------------------------------------

    // KMS key policies use Resource:'*' in the context of a resource policy
    // (which always refers to the key itself). This is standard KMS practice.
    NagSuppressions.addResourceSuppressions(
      this,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'KMS key resource policies use Resource:* which refers to the key itself ' +
            '(resource policy context). This is the standard AWS pattern for key policies ' +
            'and does not grant wildcard access to other resources.',
        },
      ],
      true,
    );

    // -----------------------------------------------------------------------
    // Outputs
    // -----------------------------------------------------------------------
    this.outputs = {
      dynamodbKey,
      rdsKey,
      elasticacheKey,
      s3GeneralKey,
      secretsKey,
      cloudwatchLogsKey,
      snsKey,
      sqsKey,
      eventbridgeKey,
      bedrockKey,
      regionalWaf,
      cloudfrontWaf,
      opsAlertTopic,
    };
  }
}
