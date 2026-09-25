/**
 * EventingStack — EventBridge bus, SQS consumer-queue topology, rules, FIFO-router,
 * demo consumer, and DLQ alarms for the Cumplify eventing backbone.
 *
 * Per spec: eventing-backbone (design.md R2, FIX-1..FIX-7 applied).
 * Spine reference: D.4 (SQS Topology of Compliance Events).
 */

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as destinations from 'aws-cdk-lib/aws-lambda-destinations';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NagSuppressions } from 'cdk-nag';
import type { EnvConfig } from './env-config.js';

export interface EventingStackProps extends cdk.StackProps {
  readonly envConfig: EnvConfig;
  readonly opsAlertTopic: sns.ITopic;
}

export class EventingStack extends cdk.Stack {
  public readonly auditSinkQueueArn: string;
  public readonly auditSinkDlqUrl: string;
  public readonly auditSinkDlqArn: string;
  public readonly busName: string;
  public readonly busArn: string;
  // New exports for AiStack (spec 4, agents-existing-8)
  public readonly deliveryFailureDlqArn: string;
  public readonly capaIntakeQueueArn: string;
  public readonly capaIntakeDlqUrl: string;
  public readonly recordsQueueArn: string;
  public readonly recordsDlqUrl: string;
  public readonly tenantDocsIndexerQueueArn: string;
  public readonly tenantDocsIndexerDlqUrl: string;

  constructor(scope: Construct, id: string, props: EventingStackProps) {
    super(scope, id, props);

    // ─── EventBridge Bus (explicit name per 07-events.md mandate) ───────────
    const bus = new events.EventBus(this, 'CumplifyEventsBus', {
      eventBusName: 'cumplify-events',
    });

    this.busName = bus.eventBusName;
    this.busArn = bus.eventBusArn;

    // ─── Delivery-failure DLQ (shared across all rule targets, REV-4) ───────
    const deliveryFailureDlq = this.createStdDlq('DeliveryFailureDlq');

    // ─── FIFO Queues ────────────────────────────────────────────────────────
    const capaIntakeDlq = this.createFifoDlq('CapaIntakeDlq');
    const capaIntakeQueue = new sqs.Queue(this, 'CapaIntakeQueue', {
      fifo: true,
      contentBasedDeduplication: false,
      enforceSSL: true,
      visibilityTimeout: cdk.Duration.seconds(360),
      deadLetterQueue: { queue: capaIntakeDlq, maxReceiveCount: 3 },
    });

    const auditSinkDlq = this.createFifoDlq('AuditSinkDlq');
    const auditSinkQueue = new sqs.Queue(this, 'AuditSinkQueue', {
      fifo: true,
      contentBasedDeduplication: false,
      enforceSSL: true,
      visibilityTimeout: cdk.Duration.seconds(360),
      deadLetterQueue: { queue: auditSinkDlq, maxReceiveCount: 3 },
    });

    this.auditSinkQueueArn = auditSinkQueue.queueArn;
    this.auditSinkDlqUrl = auditSinkDlq.queueUrl;
    this.auditSinkDlqArn = auditSinkDlq.queueArn;

    // ─── Standard Queues ────────────────────────────────────────────────────
    const ncTriageDlq = this.createStdDlq('NcTriageDlq');
    const ncTriageQueue = this.createStdQueue('NcTriageQueue', ncTriageDlq);

    const hazardDlq = this.createStdDlq('HazardDlq');
    const hazardQueue = this.createStdQueue('HazardQueue', hazardDlq);

    const aspectDlq = this.createStdDlq('AspectDlq');
    const aspectQueue = this.createStdQueue('AspectQueue', aspectDlq);

    const reviewFanoutDlq = this.createStdDlq('ReviewFanoutDlq');
    const reviewFanoutQueue = this.createStdQueue('ReviewFanoutQueue', reviewFanoutDlq);

    const recordsDlq = this.createStdDlq('RecordsDlq');
    const recordsQueue = this.createStdQueue('RecordsQueue', recordsDlq);

    // New exports for AiStack (agents-existing-8)
    this.deliveryFailureDlqArn = deliveryFailureDlq.queueArn;
    this.capaIntakeQueueArn = capaIntakeQueue.queueArn;
    this.capaIntakeDlqUrl = capaIntakeDlq.queueUrl;
    this.recordsQueueArn = recordsQueue.queueArn;
    this.recordsDlqUrl = recordsDlq.queueUrl;

    // ─── FIFO-Router Lambda (FIX-4: NODEJS_22_X, FIX-5: grants) ────────────
    const router = new NodejsFunction(this, 'FifoRouterFn', {
      entry: 'services/eventing/handlers/fifo-router.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      bundling: { externalModules: [], target: 'node22' },
      environment: {
        CAPA_INTAKE_QUEUE_URL: capaIntakeQueue.queueUrl,
        AUDIT_SINK_QUEUE_URL: auditSinkQueue.queueUrl,
        POWERTOOLS_SERVICE_NAME: 'fifo-router',
      },
      onFailure: new destinations.SqsDestination(deliveryFailureDlq),
    });

    // FIX-5: grants
    capaIntakeQueue.grantSendMessages(router);
    auditSinkQueue.grantSendMessages(router);
    deliveryFailureDlq.grantSendMessages(router);

    // ─── Demo Consumer Lambda (CON-8) ───────────────────────────────────────
    const demoConsumer = new NodejsFunction(this, 'DemoConsumerFn', {
      entry: 'services/eventing/handlers/demo-consumer.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(60),
      bundling: { externalModules: [], target: 'node22' },
      environment: {
        NC_TRIAGE_DLQ_URL: ncTriageDlq.queueUrl,
        POWERTOOLS_SERVICE_NAME: 'demo-consumer',
      },
    });
    ncTriageDlq.grantSendMessages(demoConsumer);
    demoConsumer.addEventSource(
      new SqsEventSource(ncTriageQueue, {
        batchSize: 10,
        reportBatchItemFailures: true,
      }),
    );

    // ─── EventBridge Rules ──────────────────────────────────────────────────
    // All direct-SQS rules use the canonical input transformer (FIX-1, FIX-2):
    //   body = {"detailType": "<dt>", "detail": <detail>}
    const canonicalTransformer = {
      inputPathsMap: { dt: '$.detail-type', detail: '$.detail' },
      inputTemplate: '{"detailType": "<dt>", "detail": <detail>}',
    };

    // R-2/R-3 router transformers include the targetQueue key (D-3)
    const capaRouterTransformer = {
      inputPathsMap: { dt: '$.detail-type', detail: '$.detail' },
      inputTemplate:
        '{"targetQueue": "CAPA_INTAKE_QUEUE_URL", "detailType": "<dt>", "detail": <detail>}',
    };
    const auditRouterTransformer = {
      inputPathsMap: { dt: '$.detail-type', detail: '$.detail' },
      inputTemplate:
        '{"targetQueue": "AUDIT_SINK_QUEUE_URL", "detailType": "<dt>", "detail": <detail>}',
    };

    // Shared target options
    const ruleRetryPolicy: targets.TargetBaseProps = {
      retryAttempts: 3,
      maxEventAge: cdk.Duration.hours(24),
      deadLetterQueue: deliveryFailureDlq,
    };

    // R-1: nc-triage-rule
    const ncTriageRule = new events.Rule(this, 'NcTriageRule', {
      eventBus: bus,
      eventPattern: {
        detailType: [
          'Audit.FindingRaised',
          'Incident.Reported',
          'EnvIncident.Reported',
          'Aspect.SignificantImpact',
        ],
      },
    });
    ncTriageRule.addTarget(
      new targets.SqsQueue(ncTriageQueue, {
        ...ruleRetryPolicy,
        messageGroupId: undefined, // standard queue
      }),
    );
    this.applyInputTransformer(ncTriageRule, canonicalTransformer);

    // R-2: capa-intake-rule → router
    const capaIntakeRule = new events.Rule(this, 'CapaIntakeRule', {
      eventBus: bus,
      eventPattern: {
        detailType: [
          'NC.Raised',
          'CAPA.Opened',
          'CAPA.Closed',
          'CAPA.EffectivenessVerified',
          'CAPA.ActionRequiresDocChange',
        ],
      },
    });
    capaIntakeRule.addTarget(
      new targets.LambdaFunction(router, {
        retryAttempts: 3,
        maxEventAge: cdk.Duration.hours(24),
        deadLetterQueue: deliveryFailureDlq,
      }),
    );
    this.applyInputTransformer(capaIntakeRule, capaRouterTransformer);

    // R-3: audit-sink-rule → router (OQ-5: routes on detail.auditTrail = true)
    const auditSinkRule = new events.Rule(this, 'AuditSinkRule', {
      eventBus: bus,
      eventPattern: {
        detail: {
          auditTrail: [true],
        },
      },
    });
    auditSinkRule.addTarget(
      new targets.LambdaFunction(router, {
        retryAttempts: 3,
        maxEventAge: cdk.Duration.hours(24),
        deadLetterQueue: deliveryFailureDlq,
      }),
    );
    this.applyInputTransformer(auditSinkRule, auditRouterTransformer);

    // R-4: hazard-rule
    const hazardRule = new events.Rule(this, 'HazardRule', {
      eventBus: bus,
      eventPattern: {
        detailType: [
          'Hazard.Identified',
          'Hazard.RiskEscalated',
          'Incident.Reported',
          'Safety.MetricLogged',
        ],
      },
    });
    hazardRule.addTarget(new targets.SqsQueue(hazardQueue, { ...ruleRetryPolicy }));
    this.applyInputTransformer(hazardRule, canonicalTransformer);

    // R-5: aspect-rule
    const aspectRule = new events.Rule(this, 'AspectRule', {
      eventBus: bus,
      eventPattern: {
        detailType: [
          'Aspect.SignificantImpact',
          'Enviro.MonitoringLogged',
          'EnvIncident.Reported',
          'EnvEmergency.PlanUpdated',
        ],
      },
    });
    aspectRule.addTarget(new targets.SqsQueue(aspectQueue, { ...ruleRetryPolicy }));
    this.applyInputTransformer(aspectRule, canonicalTransformer);

    // R-6: review-fanout-rule
    const reviewFanoutRule = new events.Rule(this, 'ReviewFanoutRule', {
      eventBus: bus,
      eventPattern: {
        detailType: [
          'Audit.Completed',
          'CAPA.Closed',
          'Objectives.Updated',
          'Aspect.SignificantImpact',
          'Incident.Reported',
          'Compliance.Evaluated',
          'Risk.Escalated',
          'Context.Updated',
        ],
      },
    });
    reviewFanoutRule.addTarget(new targets.SqsQueue(reviewFanoutQueue, { ...ruleRetryPolicy }));
    this.applyInputTransformer(reviewFanoutRule, canonicalTransformer);

    // R-7: records-rule (prefix matching)
    const recordsRule = new events.Rule(this, 'RecordsRule', {
      eventBus: bus,
      eventPattern: {
        detailType: [
          { prefix: 'CAPA.' },
          { prefix: 'Document.' },
          { prefix: 'Risk.' },
        ] as unknown as string[],
      },
    });
    recordsRule.addTarget(new targets.SqsQueue(recordsQueue, { ...ruleRetryPolicy }));
    this.applyInputTransformer(recordsRule, canonicalTransformer);

    // R-8: tenant-docs-indexer rule (B3: indexes published documents into AOSS)
    const tenantDocsIndexerDlq = this.createStdDlq('TenantDocsIndexerDlq');
    const tenantDocsIndexerQueue = this.createStdQueue(
      'TenantDocsIndexerQueue',
      tenantDocsIndexerDlq,
    );

    const tenantDocsIndexerRule = new events.Rule(this, 'TenantDocsIndexerRule', {
      eventBus: bus,
      eventPattern: {
        detailType: ['Document.Published'],
      },
    });
    tenantDocsIndexerRule.addTarget(
      new targets.SqsQueue(tenantDocsIndexerQueue, { ...ruleRetryPolicy }),
    );
    this.applyInputTransformer(tenantDocsIndexerRule, canonicalTransformer);

    this.tenantDocsIndexerQueueArn = tenantDocsIndexerQueue.queueArn;
    this.tenantDocsIndexerDlqUrl = tenantDocsIndexerDlq.queueUrl;

    // ─── CloudWatch DLQ Alarms (FIX-6: treatMissingData NOT_BREACHING) ──────
    const allDlqs = [
      { id: 'CapaIntakeDlqAlarm', dlq: capaIntakeDlq },
      { id: 'AuditSinkDlqAlarm', dlq: auditSinkDlq },
      { id: 'NcTriageDlqAlarm', dlq: ncTriageDlq },
      { id: 'HazardDlqAlarm', dlq: hazardDlq },
      { id: 'AspectDlqAlarm', dlq: aspectDlq },
      { id: 'ReviewFanoutDlqAlarm', dlq: reviewFanoutDlq },
      { id: 'RecordsDlqAlarm', dlq: recordsDlq },
      { id: 'TenantDocsIndexerDlqAlarm', dlq: tenantDocsIndexerDlq },
      { id: 'DeliveryFailureDlqAlarm', dlq: deliveryFailureDlq },
    ];

    for (const { id, dlq } of allDlqs) {
      const alarm = new cloudwatch.Alarm(this, id, {
        metric: dlq.metricApproximateNumberOfMessagesVisible({
          period: cdk.Duration.minutes(5),
        }),
        threshold: 1,
        evaluationPeriods: 3, // 15 min
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      alarm.addAlarmAction(new cwActions.SnsAction(props.opsAlertTopic));
    }

    // ─── CfnOutputs (C-6: everything readback needs) ────────────────────────
    new cdk.CfnOutput(this, 'EventBusName', { value: bus.eventBusName });
    new cdk.CfnOutput(this, 'EventBusArn', { value: bus.eventBusArn });

    // Queues
    const queueOutputs: [string, sqs.Queue, sqs.Queue][] = [
      ['CapaIntake', capaIntakeQueue, capaIntakeDlq],
      ['AuditSink', auditSinkQueue, auditSinkDlq],
      ['NcTriage', ncTriageQueue, ncTriageDlq],
      ['Hazard', hazardQueue, hazardDlq],
      ['Aspect', aspectQueue, aspectDlq],
      ['ReviewFanout', reviewFanoutQueue, reviewFanoutDlq],
      ['Records', recordsQueue, recordsDlq],
      ['TenantDocsIndexer', tenantDocsIndexerQueue, tenantDocsIndexerDlq],
    ];
    for (const [name, queue, dlq] of queueOutputs) {
      new cdk.CfnOutput(this, `${name}QueueUrl`, { value: queue.queueUrl });
      new cdk.CfnOutput(this, `${name}QueueArn`, { value: queue.queueArn });
      new cdk.CfnOutput(this, `${name}DlqArn`, { value: dlq.queueArn });
    }
    new cdk.CfnOutput(this, 'DeliveryFailureDlqArn', { value: deliveryFailureDlq.queueArn });

    // Rules
    const ruleOutputs: [string, events.Rule][] = [
      ['NcTriageRule', ncTriageRule],
      ['CapaIntakeRule', capaIntakeRule],
      ['AuditSinkRule', auditSinkRule],
      ['HazardRule', hazardRule],
      ['AspectRule', aspectRule],
      ['ReviewFanoutRule', reviewFanoutRule],
      ['RecordsRule', recordsRule],
      ['TenantDocsIndexerRule', tenantDocsIndexerRule],
    ];
    for (const [name, rule] of ruleOutputs) {
      new cdk.CfnOutput(this, `${name}Name`, { value: rule.ruleName });
    }

    // Lambdas
    new cdk.CfnOutput(this, 'FifoRouterArn', { value: router.functionArn });
    new cdk.CfnOutput(this, 'DemoConsumerArn', { value: demoConsumer.functionArn });
    new cdk.CfnOutput(this, 'DemoConsumerLogGroup', {
      value: demoConsumer.logGroup.logGroupName,
    });

    // ─── CDK Nag Suppressions ─────────────────────────────────────────────────
    NagSuppressions.addResourceSuppressions(
      this,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason:
            'Lambda execution roles use AWSLambdaBasicExecutionRole (CDK-generated). ' +
            'This is the standard minimal policy for Lambda logging.',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Lambda execution role and LogRetention custom resource have logs:* with ' +
            'wildcard on log stream name. Standard CDK pattern for Lambda logging.',
        },
        {
          id: 'AwsSolutions-L1',
          reason:
            'Lambda uses NODEJS_22_X which is the latest LTS runtime. CDK Nag rule ' +
            'may not recognize newer runtimes added after the rule was written.',
        },
      ],
      true,
    );
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private createStdDlq(id: string): sqs.Queue {
    const dlq = new sqs.Queue(this, id, { enforceSSL: true });
    NagSuppressions.addResourceSuppressions(dlq, [
      { id: 'AwsSolutions-SQS3', reason: 'This is a dead-letter queue — no redrive policy needed' },
    ]);
    return dlq;
  }

  private createFifoDlq(id: string): sqs.Queue {
    const dlq = new sqs.Queue(this, id, { fifo: true, enforceSSL: true });
    NagSuppressions.addResourceSuppressions(dlq, [
      { id: 'AwsSolutions-SQS3', reason: 'This is a dead-letter queue — no redrive policy needed' },
    ]);
    return dlq;
  }

  private createStdQueue(id: string, dlq: sqs.Queue): sqs.Queue {
    return new sqs.Queue(this, id, {
      enforceSSL: true,
      visibilityTimeout: cdk.Duration.seconds(360),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
    });
  }

  /**
   * Apply an input transformer to a rule's first target via addPropertyOverride.
   * L2 targets render lazily — cfnRule.targets is a Lazy token at synth time,
   * NOT a readable array. addPropertyOverride merges AFTER lazy resolution,
   * guaranteeing the transformer appears in the synthesized template.
   * (Incident: prior array-mutation approach silently no-oped due to Lazy token.)
   */
  private applyInputTransformer(
    rule: events.Rule,
    transformer: { inputPathsMap: Record<string, string>; inputTemplate: string },
  ): void {
    const cfnRule = rule.node.defaultChild as events.CfnRule;
    cfnRule.addPropertyOverride('Targets.0.InputTransformer', {
      InputPathsMap: transformer.inputPathsMap,
      InputTemplate: transformer.inputTemplate,
    });
  }
}
