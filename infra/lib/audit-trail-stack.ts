/**
 * AuditTrailStack — Immutable audit trail infrastructure.
 * Per spec: immutable-trail (design.md R2, FIX-1..FIX-6 applied).
 *
 * Components:
 * - Audit-sink consumer Lambda (ESM on spec 2's audit-sink FIFO queue)
 * - WORM sealer Lambda (DynamoDB Streams ESM, INSERT + itemType='AUDITLOG')
 * - Tamper-tripwire Lambda (DynamoDB Streams ESM, MODIFY/REMOVE + itemType='AUDITLOG')
 * - Chain-verifier Lambda (EventBridge Scheduler, daily)
 * - Audit-archive S3 bucket (Object Lock COMPLIANCE)
 * - DLQs, alarms, IAM Deny policy
 */

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as destinations from 'aws-cdk-lib/aws-lambda-destinations';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { SqsEventSource, DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { FilterCriteria, FilterRule } from 'aws-cdk-lib/aws-lambda';
import { NagSuppressions } from 'cdk-nag';
import type { EnvConfig } from './env-config.js';

export interface AuditTrailStackProps extends cdk.StackProps {
  readonly envConfig: EnvConfig;
  readonly tableArn: string;
  readonly tableName: string;
  readonly tableStreamArn: string;
  readonly dynamodbKey: kms.IKey;
  readonly s3GeneralKey: kms.IKey;
  readonly auditSinkQueueArn: string;
  readonly auditSinkDlqUrl: string;
  readonly auditSinkDlqArn: string;
  readonly opsAlertTopic: sns.ITopic;
}

export class AuditTrailStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AuditTrailStackProps) {
    super(scope, id, props);

    const { envConfig } = props;

    // ─── Audit-Archive S3 Bucket ────────────────────────────────────────────
    const accessLogsBucket = new s3.Bucket(this, 'AuditArchiveAccessLogs', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ expiration: cdk.Duration.days(365) }],
    });
    NagSuppressions.addResourceSuppressions(accessLogsBucket, [
      { id: 'AwsSolutions-S1', reason: 'This IS the access-logs bucket for audit-archive.' },
    ]);

    const auditArchiveBucket = new s3.Bucket(this, 'AuditArchiveBucket', {
      versioned: true,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: props.s3GeneralKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      objectLockEnabled: true,
      objectLockDefaultRetention: s3.ObjectLockRetention.compliance(
        cdk.Duration.days(envConfig.auditArchiveRetentionDays),
      ),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      eventBridgeEnabled: true,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: 'audit-archive/',
    });

    // ─── DLQs ───────────────────────────────────────────────────────────────
    const sealerDlq = new sqs.Queue(this, 'SealerDlq', { enforceSSL: true });
    NagSuppressions.addResourceSuppressions(sealerDlq, [
      { id: 'AwsSolutions-SQS3', reason: 'This is a dead-letter queue — no redrive policy needed' },
    ]);

    const tripwireDlq = new sqs.Queue(this, 'TripwireDlq', { enforceSSL: true });
    NagSuppressions.addResourceSuppressions(tripwireDlq, [
      { id: 'AwsSolutions-SQS3', reason: 'This is a dead-letter queue — no redrive policy needed' },
    ]);

    // ─── Import table for ESM ───────────────────────────────────────────────
    const table = dynamodb.Table.fromTableAttributes(this, 'CumplifyCore', {
      tableArn: props.tableArn,
      tableStreamArn: props.tableStreamArn,
    });

    // Import audit-sink queue for consumer ESM
    const auditSinkQueue = sqs.Queue.fromQueueArn(this, 'AuditSinkQueue', props.auditSinkQueueArn);

    // Import audit-sink DLQ for poison send grant
    const auditSinkDlq = sqs.Queue.fromQueueArn(this, 'AuditSinkDlq', props.auditSinkDlqArn);

    // ─── Shared Lambda props ────────────────────────────────────────────────
    const commonLambdaProps = {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      bundling: { externalModules: [] as string[], target: 'node22' },
    };

    // ─── Consumer Lambda ────────────────────────────────────────────────────
    const consumerFn = new NodejsFunction(this, 'AuditSinkConsumerFn', {
      ...commonLambdaProps,
      entry: 'services/audit-trail/handlers/consumer.ts',
      handler: 'handler',
      memorySize: 512,
      timeout: cdk.Duration.seconds(60),
      environment: {
        TABLE_NAME: props.tableName,
        AUDIT_SINK_DLQ_URL: props.auditSinkDlqUrl,
        POWERTOOLS_SERVICE_NAME: 'audit-trail-consumer',
      },
    });

    // Consumer needs EXACTLY: Query (prevHash lookup) + PutItem (the TransactWriteItems
    // chain-item + dedup-marker, both conditional Puts). NOT UpdateItem/DeleteItem/
    // BatchWriteItem — the append path never mutates existing items. (Gate FINDING-1:
    // grantReadWriteData was over-broad, allowing UpdateItem on non-audit partitions.)
    table.grant(consumerFn, 'dynamodb:Query', 'dynamodb:PutItem');
    props.dynamodbKey.grant(
      consumerFn,
      'kms:Encrypt',
      'kms:Decrypt',
      'kms:ReEncrypt*',
      'kms:GenerateDataKey*',
      'kms:DescribeKey',
      'kms:CreateGrant',
    );
    auditSinkDlq.grantSendMessages(consumerFn);

    // Consumer ESM on audit-sink FIFO queue
    consumerFn.addEventSource(
      new SqsEventSource(auditSinkQueue, {
        batchSize: 5,
        reportBatchItemFailures: true,
      }),
    );

    // ─── WORM Sealer Lambda ─────────────────────────────────────────────────
    const sealerFn = new NodejsFunction(this, 'WormSealerFn', {
      ...commonLambdaProps,
      entry: 'services/audit-trail/handlers/sealer.ts',
      handler: 'handler',
      memorySize: 512,
      timeout: cdk.Duration.seconds(60),
      environment: {
        AUDIT_ARCHIVE_BUCKET: auditArchiveBucket.bucketName,
        RETENTION_DAYS: String(envConfig.auditArchiveRetentionDays),
        POWERTOOLS_SERVICE_NAME: 'audit-trail-sealer',
      },
    });

    // Sealer needs: KMS decrypt (stream), S3 put + retention, KMS encrypt (S3)
    props.dynamodbKey.grantDecrypt(sealerFn);
    auditArchiveBucket.grantPut(sealerFn);
    sealerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObjectRetention'],
        resources: [auditArchiveBucket.arnForObjects('*')],
      }),
    );
    props.s3GeneralKey.grantEncrypt(sealerFn);

    // Sealer ESM (FIX-4: itemType filter, FIX-5: native FilterCriteria)
    sealerFn.addEventSource(
      new DynamoEventSource(table, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 10,
        maxBatchingWindow: cdk.Duration.seconds(5),
        bisectBatchOnError: true,
        retryAttempts: 3,
        onFailure: new destinations.SqsDestination(sealerDlq),
        filters: [
          FilterCriteria.filter({
            eventName: FilterRule.isEqual('INSERT'),
            dynamodb: {
              NewImage: {
                itemType: { S: FilterRule.isEqual('AUDITLOG') },
              },
            },
          }),
        ],
      }),
    );

    // ─── Tamper-Tripwire Lambda ─────────────────────────────────────────────
    const tripwireFn = new NodejsFunction(this, 'TamperTripwireFn', {
      ...commonLambdaProps,
      entry: 'services/audit-trail/handlers/tripwire.ts',
      handler: 'handler',
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      environment: {
        POWERTOOLS_SERVICE_NAME: 'audit-trail-tripwire',
      },
    });

    // Tripwire needs: KMS decrypt (stream), CloudWatch PutMetricData
    props.dynamodbKey.grantDecrypt(tripwireFn);
    tripwireFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'cloudwatch:namespace': 'Cumplify/AuditTrail' },
        },
      }),
    );
    NagSuppressions.addResourceSuppressions(
      tripwireFn.role!,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'cloudwatch:PutMetricData does not support resource-level permissions (AWS API limitation). Scoped by namespace condition.',
        },
      ],
      true,
    );

    // Tripwire ESM (FIX-4: itemType on OldImage, FIX-5: native FilterCriteria, AMEND-2)
    tripwireFn.addEventSource(
      new DynamoEventSource(table, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 10,
        bisectBatchOnError: true,
        retryAttempts: 3,
        onFailure: new destinations.SqsDestination(tripwireDlq),
        filters: [
          FilterCriteria.filter({
            eventName: FilterRule.or('MODIFY', 'REMOVE'),
            dynamodb: {
              OldImage: {
                itemType: { S: FilterRule.isEqual('AUDITLOG') },
              },
            },
          }),
        ],
      }),
    );

    // ─── Chain-Verifier Lambda ──────────────────────────────────────────────
    const verifierFn = new NodejsFunction(this, 'ChainVerifierFn', {
      ...commonLambdaProps,
      entry: 'services/audit-trail/handlers/verifier.ts',
      handler: 'handler',
      memorySize: 1024,
      timeout: cdk.Duration.seconds(900),
      environment: {
        TABLE_NAME: props.tableName,
        AUDIT_ARCHIVE_BUCKET: auditArchiveBucket.bucketName,
        POWERTOOLS_SERVICE_NAME: 'audit-trail-verifier',
      },
    });

    // Verifier needs EXACTLY: Query (tenant discovery + chain walk) + GetItem
    // (watermark read) + PutItem (watermark write). NOT UpdateItem/DeleteItem —
    // it is read-only over the trail; watermark is an append-once/overwrite Put.
    // (Gate FINDING-1: grantReadWriteData was over-broad.)
    table.grant(verifierFn, 'dynamodb:Query', 'dynamodb:GetItem', 'dynamodb:PutItem');
    props.dynamodbKey.grant(
      verifierFn,
      'kms:Encrypt',
      'kms:Decrypt',
      'kms:ReEncrypt*',
      'kms:GenerateDataKey*',
      'kms:DescribeKey',
      'kms:CreateGrant',
    );
    auditArchiveBucket.grantRead(verifierFn);
    props.s3GeneralKey.grantDecrypt(verifierFn);
    verifierFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'cloudwatch:namespace': 'Cumplify/AuditTrail' },
        },
      }),
    );
    NagSuppressions.addResourceSuppressions(
      verifierFn.role!,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'cloudwatch:PutMetricData does not support resource-level permissions. S3 read grant uses /* suffix (CDK default). Both scoped appropriately.',
        },
      ],
      true,
    );

    // ─── IAM Deny Policy (FIX-2: 5 actions) — REQUIRES-HUMAN ───────────────
    const auditLogDenyPolicy = new iam.ManagedPolicy(this, 'AuditLogDenyPolicy', {
      statements: [
        new iam.PolicyStatement({
          sid: 'DenyAuditLogMutation',
          effect: iam.Effect.DENY,
          actions: [
            'dynamodb:UpdateItem',
            'dynamodb:DeleteItem',
            'dynamodb:BatchWriteItem',
            'dynamodb:PartiQLUpdate',
            'dynamodb:PartiQLDelete',
          ],
          resources: [props.tableArn],
          conditions: {
            'ForAnyValue:StringLike': {
              'dynamodb:LeadingKeys': ['TENANT#*#AUDITLOG'],
            },
          },
        }),
      ],
    });

    consumerFn.role!.addManagedPolicy(auditLogDenyPolicy);
    sealerFn.role!.addManagedPolicy(auditLogDenyPolicy);
    tripwireFn.role!.addManagedPolicy(auditLogDenyPolicy);
    verifierFn.role!.addManagedPolicy(auditLogDenyPolicy);

    // ─── EventBridge Scheduler (daily verifier) ─────────────────────────────
    const schedulerRole = new iam.Role(this, 'VerifierSchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });
    verifierFn.grantInvoke(schedulerRole);

    const schedule = new scheduler.CfnSchedule(this, 'DailyVerifierSchedule', {
      scheduleExpression: 'cron(0 2 * * ? *)',
      flexibleTimeWindow: { mode: 'OFF' },
      target: {
        arn: verifierFn.functionArn,
        roleArn: schedulerRole.roleArn,
        input: '{}',
      },
      state: 'ENABLED',
    });

    // ─── CloudWatch Alarms ──────────────────────────────────────────────────
    const sealerDlqAlarm = new cloudwatch.Alarm(this, 'SealerDlqAlarm', {
      metric: sealerDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const tamperAlarm = new cloudwatch.Alarm(this, 'AuditTamperAttemptAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'Cumplify/AuditTrail',
        metricName: 'AuditTamperAttempt',
        period: cdk.Duration.minutes(1),
        statistic: 'Sum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const chainBrokenAlarm = new cloudwatch.Alarm(this, 'AuditChainBrokenAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'Cumplify/AuditTrail',
        metricName: 'AuditChainBroken',
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    for (const alarm of [sealerDlqAlarm, tamperAlarm, chainBrokenAlarm]) {
      alarm.addAlarmAction(new cwActions.SnsAction(props.opsAlertTopic));
    }

    // ─── CfnOutputs ────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'AuditArchiveBucketName', { value: auditArchiveBucket.bucketName });
    new cdk.CfnOutput(this, 'ConsumerFnArn', { value: consumerFn.functionArn });
    new cdk.CfnOutput(this, 'ConsumerRoleArn', { value: consumerFn.role!.roleArn });
    new cdk.CfnOutput(this, 'SealerFnArn', { value: sealerFn.functionArn });
    new cdk.CfnOutput(this, 'TripwireFnArn', { value: tripwireFn.functionArn });
    new cdk.CfnOutput(this, 'VerifierFnArn', { value: verifierFn.functionArn });
    new cdk.CfnOutput(this, 'VerifierRoleArn', { value: verifierFn.role!.roleArn });
    new cdk.CfnOutput(this, 'SealerDlqArn', { value: sealerDlq.queueArn });
    new cdk.CfnOutput(this, 'SealerDlqUrl', { value: sealerDlq.queueUrl });
    new cdk.CfnOutput(this, 'TripwireDlqArn', { value: tripwireDlq.queueArn });
    new cdk.CfnOutput(this, 'ScheduleName', { value: schedule.ref });
    new cdk.CfnOutput(this, 'SealerDlqAlarmName', { value: sealerDlqAlarm.alarmName });
    new cdk.CfnOutput(this, 'TamperAlarmName', { value: tamperAlarm.alarmName });
    new cdk.CfnOutput(this, 'ChainBrokenAlarmName', { value: chainBrokenAlarm.alarmName });
    new cdk.CfnOutput(this, 'ConsumerLogGroup', { value: consumerFn.logGroup.logGroupName });

    // ─── CDK Nag Suppressions ───────────────────────────────────────────────
    NagSuppressions.addResourceSuppressions(
      this,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason:
            'Lambda execution roles use AWSLambdaBasicExecutionRole (CDK-generated). Standard minimal policy for Lambda logging.',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Lambda roles have wildcard on log stream name (CDK default), KMS grants use /* for key resources, and S3 grants use /* for object ARNs. All scoped to specific resources.',
        },
        {
          id: 'AwsSolutions-L1',
          reason: 'Lambda uses NODEJS_22_X — latest LTS. CDK Nag may not recognize newer runtimes.',
        },
        {
          id: 'AwsSolutions-S1',
          reason:
            'Audit-archive bucket has access logging enabled (to dedicated access-logs bucket). Only the access-logs bucket itself lacks self-logging (suppressed separately).',
        },
      ],
      true,
    );
  }
}
