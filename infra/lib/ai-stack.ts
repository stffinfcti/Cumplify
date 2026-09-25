/**
 * AiStack — AI agents infrastructure for agents-existing-8.
 * Design §7 — Option B (custom Converse loop, no CfnAgent).
 *
 * Resources: AI Invoker Lambda, CfnGuardrail, HITL State Machine,
 * 3 new SQS queues + DLQs (DocStudio, LeadAuditor, ControlTower),
 * 3 EventBridge rules (R-8/R-9/R-10), DLQ alarms,
 * MODELWEIGHT# seeding custom resource, inference profiles.
 *
 * Joins CumplifyStage with addDependency on DataStack, ApiStack,
 * EventingStack, AuditTrailStack.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as opensearchserverless from 'aws-cdk-lib/aws-opensearchserverless';
import * as cr from 'aws-cdk-lib/custom-resources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NagSuppressions } from 'cdk-nag';
import type { EnvConfig } from './env-config.js';

export interface AiStackProps extends cdk.StackProps {
  readonly envConfig: EnvConfig;
  // Cross-stack imports
  readonly tableArn: string;
  readonly tableName: string;
  readonly dynamodbKey: kms.IKey;
  readonly clusterArn: string;
  readonly dbSecretArn: string;
  readonly dbSecretKey: kms.IKey;
  readonly busName: string;
  readonly busArn: string;
  readonly deliveryFailureDlqArn: string;
  // SNS CMK (from SecurityStack) — credit-cap alert topic encryption (COND-4)
  readonly snsKey: kms.IKey;
  // Existing queues consumed by agents
  readonly capaIntakeQueueArn: string;
  readonly capaIntakeDlqUrl: string;
  readonly auditSinkQueueArn: string;
  readonly recordsQueueArn: string;
  readonly recordsDlqUrl: string;
  // B3: tenant-docs indexer
  readonly tenantDocsIndexerQueueArn: string;
  readonly tenantDocsIndexerDlqUrl: string;
  // AOSS infra (from NetworkStack + SecurityStack)
  readonly aossVpcEndpointId: string;
  // VPC placement for the apply-template Lambda (AOSS is VPC-endpoint-only)
  readonly vpc: ec2.IVpc;
  readonly privateSubnets: ec2.ISubnet[];
  readonly bedrockKeyArn: string;
  // App-role secret for RLS-safe writes (from ApiStack, T4-F1)
  readonly appRoleSecretArn: string;
  // Existing iso-kb AOSS collection (OWNED by DataStack, spec 1 — imported here)
  readonly isoKbCollectionArn: string;
  readonly isoKbCollectionEndpoint: string;
  // AppSync API (from ApiStack) — guru resolver wiring
  readonly graphqlApiId: string;
  readonly graphqlApiUrl: string;
  // spec 40 — generation plane working storage (GeneralBucket, CMK)
  readonly generalBucketName: string;
  readonly generalBucketArn: string;
  readonly s3GeneralKey: kms.IKey;
}

export class AiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AiStackProps) {
    super(scope, id, props);

    const { envConfig, appRoleSecretArn, graphqlApiId, graphqlApiUrl } = props;

    // ─── Import existing resources ─────────────────────────────────────────
    const bus = events.EventBus.fromEventBusAttributes(this, 'ImportedBus', {
      eventBusName: props.busName,
      eventBusArn: props.busArn,
      eventBusPolicy: '',
    });

    const deliveryFailureDlq = sqs.Queue.fromQueueArn(
      this,
      'ImportedDeliveryDlq',
      props.deliveryFailureDlqArn,
    );

    // ─── CfnGuardrail (PII + PROMPT_ATTACK + Contextual Grounding) ──────────
    const guardrail = new bedrock.CfnGuardrail(this, 'AgentGuardrail', {
      name: `cumplify-agent-guardrail-${envConfig.envName}`,
      blockedInputMessaging: 'Request blocked by content policy.',
      blockedOutputsMessaging: 'Response blocked by content policy.',
      contentPolicyConfig: {
        filtersConfig: [{ type: 'PROMPT_ATTACK', inputStrength: 'HIGH', outputStrength: 'NONE' }],
      },
      sensitiveInformationPolicyConfig: {
        piiEntitiesConfig: [
          { type: 'EMAIL', action: 'ANONYMIZE' },
          { type: 'PHONE', action: 'ANONYMIZE' },
          { type: 'NAME', action: 'ANONYMIZE' },
          { type: 'US_SOCIAL_SECURITY_NUMBER', action: 'BLOCK' },
          { type: 'CREDIT_DEBIT_CARD_NUMBER', action: 'BLOCK' },
        ],
      },
      // spec-35 L1-1: contextual grounding (advisory threshold 0.85, relevance 0.75)
      // NO CrossRegionConfig (grounding-only; AR quarantined to separate guardrails)
      contextualGroundingPolicyConfig: {
        filtersConfig: [
          { type: 'GROUNDING', threshold: 0.85 },
          { type: 'RELEVANCE', threshold: 0.75 },
        ],
      },
    });

    // ─── Record-write CfnGuardrail (spec-35 CDK-4: grounding 0.90) ────────
    // Higher grounding threshold for record-writing drafts (Part 35 L1).
    // Same content + PII policies as AgentGuardrail. NO CrossRegionConfig.
    const recordWriteGuardrail = new bedrock.CfnGuardrail(this, 'RecordWriteGuardrail', {
      name: `cumplify-recordwrite-guardrail-${envConfig.envName}`,
      blockedInputMessaging: 'Request blocked by content policy.',
      blockedOutputsMessaging: 'Response blocked by content policy.',
      contentPolicyConfig: {
        filtersConfig: [{ type: 'PROMPT_ATTACK', inputStrength: 'HIGH', outputStrength: 'NONE' }],
      },
      sensitiveInformationPolicyConfig: {
        piiEntitiesConfig: [
          { type: 'EMAIL', action: 'ANONYMIZE' },
          { type: 'PHONE', action: 'ANONYMIZE' },
          { type: 'NAME', action: 'ANONYMIZE' },
          { type: 'US_SOCIAL_SECURITY_NUMBER', action: 'BLOCK' },
          { type: 'CREDIT_DEBIT_CARD_NUMBER', action: 'BLOCK' },
        ],
      },
      contextualGroundingPolicyConfig: {
        filtersConfig: [
          { type: 'GROUNDING', threshold: 0.9 },
          { type: 'RELEVANCE', threshold: 0.75 },
        ],
      },
    });

    // ─── Doc-gen CfnGuardrail (spec-40 BC-5, owner-approved 2026-07-14) ───
    // The agent guardrail anonymizes NAME/EMAIL/PHONE. Applied to document
    // generation it would redact the tenant's own company name and quality
    // manager out of their manual — the doc-gen seat gets its own guardrail:
    // PROMPT_ATTACK and SSN/card BLOCK retained, PII anonymization off.
    const docGenGuardrail = new bedrock.CfnGuardrail(this, 'DocGenGuardrail', {
      name: `cumplify-docgen-guardrail-${envConfig.envName}`,
      blockedInputMessaging: 'Request blocked by content policy.',
      blockedOutputsMessaging: 'Response blocked by content policy.',
      contentPolicyConfig: {
        filtersConfig: [{ type: 'PROMPT_ATTACK', inputStrength: 'HIGH', outputStrength: 'NONE' }],
      },
      sensitiveInformationPolicyConfig: {
        piiEntitiesConfig: [
          { type: 'US_SOCIAL_SECURITY_NUMBER', action: 'BLOCK' },
          { type: 'CREDIT_DEBIT_CARD_NUMBER', action: 'BLOCK' },
        ],
      },
    });

    // ─── AR Policies (spec-35 Task 25: L2 Automated Reasoning) ─────────────
    // Read pre-authored PolicyDefinition from exported JSON files at synth time.
    // These JSONs were built via headless CLI in Tasks 22-24 and exported verbatim.
    const arPoliciesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../data/ar-policies');
    const clauseCanonDef = JSON.parse(
      readFileSync(resolve(arPoliciesDir, 'clause-canon.json'), 'utf-8'),
    ).policyDefinition;
    const rolePermissionsDef = JSON.parse(
      readFileSync(resolve(arPoliciesDir, 'role-permissions.json'), 'utf-8'),
    ).policyDefinition;
    const planEntitlementsDef = JSON.parse(
      readFileSync(resolve(arPoliciesDir, 'plan-entitlements.json'), 'utf-8'),
    ).policyDefinition;

    const clauseCanonPolicy = new bedrock.CfnAutomatedReasoningPolicy(this, 'ClauseCanonPolicy', {
      name: `cumplify-clause-canon-${envConfig.envName}`,
      description:
        'Clause-canon AR policy: validates ISO clause references (152 tuples: 9001/14001/45001)',
      policyDefinition: clauseCanonDef,
    });

    const rolePermissionsPolicy = new bedrock.CfnAutomatedReasoningPolicy(
      this,
      'RolePermissionsPolicy',
      {
        name: `cumplify-role-permissions-${envConfig.envName}`,
        description:
          'Role-permissions AR policy: validates Part 13 v2 12-role RBAC + SoD assertions',
        policyDefinition: rolePermissionsDef,
      },
    );

    const planEntitlementsPolicy = new bedrock.CfnAutomatedReasoningPolicy(
      this,
      'PlanEntitlementsPolicy',
      {
        name: `cumplify-plan-entitlements-${envConfig.envName}`,
        description: 'Plan-entitlements AR policy: validates Part 17.2 pricing tier feature gates',
        policyDefinition: planEntitlementsDef,
      },
    );

    // ─── AR-clause CfnGuardrail (spec-35 §1.1: clause-canon only) ──────────
    // One AR policy (clause-canon). CrossRegionConfig required for AR.
    // NO content/PII/grounding policies — AR-only evaluation (design H-1 D3).
    const arClauseGuardrail = new bedrock.CfnGuardrail(this, 'ArClauseGuardrail', {
      name: `cumplify-arclause-guardrail-${envConfig.envName}`,
      blockedInputMessaging: 'Response contains invalid clause citation.',
      blockedOutputsMessaging: 'Response contains invalid clause citation.',
      crossRegionConfig: {
        guardrailProfileArn: `arn:aws:bedrock:us-east-1:${this.account}:guardrail-profile/us.guardrail.v1:0`,
      },
      automatedReasoningPolicyConfig: {
        policies: [clauseCanonPolicy.attrPolicyArn],
        confidenceThreshold: 0.9,
      },
    });

    // ─── AR-advisory CfnGuardrail (spec-35 §1.1: role-perms + plan-ent) ────
    // Two AR policies (maxItems:2 satisfied). CrossRegionConfig required.
    // NO content/PII/grounding policies — AR-only evaluation (design H-1 D3).
    const arAdvisoryGuardrail = new bedrock.CfnGuardrail(this, 'ArAdvisoryGuardrail', {
      name: `cumplify-aradvisory-guardrail-${envConfig.envName}`,
      blockedInputMessaging: 'Response contains invalid advisory claim.',
      blockedOutputsMessaging: 'Response contains invalid advisory claim.',
      crossRegionConfig: {
        guardrailProfileArn: `arn:aws:bedrock:us-east-1:${this.account}:guardrail-profile/us.guardrail.v1:0`,
      },
      automatedReasoningPolicyConfig: {
        policies: [rolePermissionsPolicy.attrPolicyArn, planEntitlementsPolicy.attrPolicyArn],
        confidenceThreshold: 0.9,
      },
    });

    // ─── AI Invoker Lambda (the ONE DOOR) ──────────────────────────────────
    const aiInvoker = new NodejsFunction(this, 'AiInvokerFn', {
      entry: 'services/ai-invoker/src/index.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(90),
      bundling: { externalModules: [], target: 'node22' },
      environment: {
        TABLE_NAME: props.tableName,
        BUS_NAME: props.busName,
        GUARDRAIL_ID: guardrail.attrGuardrailId,
        GUARDRAIL_VERSION: guardrail.attrVersion,
        DOCGEN_GUARDRAIL_ID: docGenGuardrail.attrGuardrailId,
        DOCGEN_GUARDRAIL_VERSION: docGenGuardrail.attrVersion,
        RECORDWRITE_GUARDRAIL_ID: recordWriteGuardrail.attrGuardrailId,
        RECORDWRITE_GUARDRAIL_VERSION: recordWriteGuardrail.attrVersion,
        ARCLAUSE_GUARDRAIL_ID: arClauseGuardrail.attrGuardrailId,
        ARCLAUSE_GUARDRAIL_VERSION: arClauseGuardrail.attrVersion,
        ARADVISORY_GUARDRAIL_ID: arAdvisoryGuardrail.attrGuardrailId,
        ARADVISORY_GUARDRAIL_VERSION: arAdvisoryGuardrail.attrVersion,
        POWERTOOLS_SERVICE_NAME: 'ai-invoker',
      },
    });

    // AI Invoker IAM: bedrock:InvokeModel (ONLY role with this permission)
    aiInvoker.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:InvokeModel', 'bedrock:ApplyGuardrail'],
        resources: ['*'], // Required by Bedrock
      }),
    );

    // Task 26 (spec-35, OWNER-APPROVED 2026-07-17): AR policy evaluation for
    // the two AR guardrails (design §5.5). Scoped to this account's AR
    // policies — unlike InvokeModel, AR policy ARNs are scopeable.
    aiInvoker.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'AutomatedReasoningChecks',
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:InvokeAutomatedReasoningPolicy'],
        resources: [`arn:aws:bedrock:us-east-1:${this.account}:automated-reasoning-policy/*`],
      }),
    );

    // DynamoDB: TENANT#*#METER read/write + MODELWEIGHT# read
    aiInvoker.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:Query'],
        resources: [props.tableArn, `${props.tableArn}/index/*`],
        conditions: {
          'ForAllValues:StringLike': {
            'dynamodb:LeadingKeys': ['TENANT#*#METER', 'MODELWEIGHT#*', 'TENANT#*#ENTITLEMENT'],
          },
        },
      }),
    );
    props.dynamodbKey.grantEncryptDecrypt(aiInvoker);

    // EventBridge: PutEvents for telemetry
    aiInvoker.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['events:PutEvents'],
        resources: [props.busArn],
      }),
    );

    // ─── Store-Token Lambda (T-8d: persists taskToken into DDB HITL item) ──
    const storeTokenLambda = new NodejsFunction(this, 'StoreTokenFn', {
      entry: 'services/agents/shared/store-token.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      bundling: { externalModules: [], target: 'node22' },
      environment: {
        TABLE_NAME: props.tableName,
        POWERTOOLS_SERVICE_NAME: 'store-token',
      },
    });

    // ─── ExpireHitlItem Lambda (SFN timeout catch — shared resolveHitlItem)
    const expireHitlItemFn = new NodejsFunction(this, 'ExpireHitlItemFn', {
      entry: 'services/agents/shared/expire-hitl-item.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      bundling: { externalModules: [], target: 'node22' },
      environment: {
        TABLE_NAME: props.tableName,
        POWERTOOLS_SERVICE_NAME: 'expire-hitl-item',
      },
    });

    // ─── ExecuteWriteback Lambda (T-8a/T-8b) ───────────────────────────────
    const executeWritebackLambda = new NodejsFunction(this, 'ExecuteWritebackFn', {
      entry: 'services/agents/shared/execute-writeback.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(60),
      bundling: { externalModules: [], target: 'node22' },
      environment: {
        CLUSTER_ARN: props.clusterArn,
        APP_ROLE_SECRET_ARN: appRoleSecretArn,
        DB_NAME: 'postgres', // C-3e: must match api-core DATABASE setting
        BUS_NAME: props.busName,
        // S2 (studio wave): doc-draft writeback writes the version-1
        // ContentJson to S3 (same key scheme as m1's versionContentKey).
        CONTENT_BUCKET: props.generalBucketName,
        POWERTOOLS_SERVICE_NAME: 'execute-writeback',
      },
    });
    // S2: content writes are tenant-scoped, mirroring the DocGen plane's grant.
    executeWritebackLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['s3:PutObject', 's3:GetObject'],
        resources: [`${props.generalBucketArn}/tenants/*`],
      }),
    );
    props.s3GeneralKey.grantEncryptDecrypt(executeWritebackLambda);

    // S3 (studio wave): the manual-section-draft writeback DELEGATES to the
    // GEN-6 regeneration engine (defined later in this stack) by
    // DETERMINISTIC name — override mode skips compose, so the engine's
    // version derivations fit inside this Lambda's 60s timeout.
    const regenFnNameForWriteback = `cumplify-docgen-regen-${envConfig.envName}`;
    executeWritebackLambda.addEnvironment('REGEN_FN_NAME', regenFnNameForWriteback);
    executeWritebackLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['lambda:InvokeFunction'],
        resources: [
          cdk.Stack.of(this).formatArn({
            service: 'lambda',
            resource: 'function',
            resourceName: regenFnNameForWriteback,
            arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
          }),
        ],
      }),
    );

    // ─── HITL State Machine (Step Functions Standard, waitForTaskToken) ─────
    // C-2 (Task 8R): No EmitAuditEvent state — execute-writeback.ts emits
    // the audit event post-commit. A second emitter would double-write the sealed trail.
    const recordProposal = new sfn.Pass(this, 'RecordProposal', {
      comment: 'Record the proposed action metadata',
    });

    const waitForApproval = new sfn.CustomState(this, 'WaitForApproval', {
      stateJson: {
        Type: 'Task',
        Resource: 'arn:aws:states:::lambda:invoke.waitForTaskToken',
        Parameters: {
          // T-8d: StoreToken Lambda persists $$.Task.Token into DDB HITL item.
          FunctionName: storeTokenLambda.functionArn,
          Payload: {
            'taskToken.$': '$$.Task.Token',
            'input.$': '$',
            // HITL-10 carry #3: SFN execution ARN for tracing
            'sfnExecutionArn.$': '$$.Execution.Id',
          },
        },
        TimeoutSeconds: 604800, // 7 days
        ResultPath: '$.approvalResult',
        Retry: [
          {
            ErrorEquals: [
              'Lambda.ServiceException',
              'Lambda.AWSLambdaException',
              'Lambda.SdkClientException',
            ],
            IntervalSeconds: 2,
            MaxAttempts: 3,
            BackoffRate: 2,
          },
        ],
        // HITL-10 Catch added via addCatch() below, NOT raw stateJson — see HandleSendBack.
      },
    });

    const executeWriteback = new sfn.CustomState(this, 'ExecuteWriteback', {
      stateJson: {
        Type: 'Task',
        Resource: 'arn:aws:states:::lambda:invoke',
        Parameters: {
          // C-2 (Task 8R): wired to the actual ExecuteWriteback Lambda ARN.
          FunctionName: executeWritebackLambda.functionArn,
          'Payload.$': '$',
        },
        ResultPath: '$.writebackResult',
        Retry: [
          {
            ErrorEquals: [
              'Lambda.ServiceException',
              'Lambda.AWSLambdaException',
              'Lambda.SdkClientException',
              'DatabaseResumingException',
            ],
            IntervalSeconds: 5,
            MaxAttempts: 3,
            BackoffRate: 2,
          },
        ],
      },
    });

    // Timeout: a 7d unanswered approval previously failed the execution and
    // left the DDB item PENDING forever — the approval queue card stayed
    // clickable but the task token was dead, so APPROVE 404'd. Catch
    // States.Timeout → ExpireHitlItem flips the item through the shared
    // resolveHitlItem path (TIMED_OUT + 30-day ttl + GSI9 removal — same
    // vocabulary the resolver-side timeout path uses; a second hand-rolled
    // UpdateItem would drift vocabulary and never TTL-expire).
    const expireHitlItem = new tasks.LambdaInvoke(this, 'ExpireHitlItem', {
      lambdaFunction: expireHitlItemFn,
      outputPath: '$.Payload',
    });
    waitForApproval.addCatch(expireHitlItem, {
      errors: ['States.Timeout'],
      resultPath: '$.timeoutError',
    });

    // HITL-10: SENT_BACK (SendTaskFailure from the approval Lambda) → terminal Pass.
    // Must be wired via addCatch, not a raw stateJson Catch: CDK renders only states
    // reachable through graph edges, so a stateJson-only Next leaves the target out
    // of the definition and SFN rejects it (MISSING_TRANSITION_TARGET).
    const handleSendBack = new sfn.Pass(this, 'HandleSendBack', {
      comment: 'HITL-10: Handle send-back decision. Agent re-draft logic TBD (agents-existing-8).',
    });
    waitForApproval.addCatch(handleSendBack, {
      errors: ['SENT_BACK'],
      resultPath: '$.sendBackError',
    });

    const definition = recordProposal.next(waitForApproval).next(executeWriteback);

    const hitlStateMachine = new sfn.StateMachine(this, 'HitlStateMachine', {
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      stateMachineType: sfn.StateMachineType.STANDARD,
      timeout: cdk.Duration.days(8), // Slightly over 7d to allow for processing
    });

    // H-1 (Task 8R): Identity grant to the HITL SM role ONLY.
    // SFN task states sign with the state-machine role's credentials — this is
    // the correct auth path (NOT a resource-based policy on the Lambda).
    // No wildcard addPermission. No other principal may invoke ExecuteWriteback.
    storeTokenLambda.grantInvoke(hitlStateMachine.role);
    executeWritebackLambda.grantInvoke(hitlStateMachine.role);
    expireHitlItemFn.grantInvoke(hitlStateMachine.role);
    // ExpireHitlItem writes the HITL item via the shared resolveHitlItem path.
    expireHitlItemFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:UpdateItem'],
        resources: [props.tableArn],
        conditions: {
          // Can only ever touch HITL-prefixed partitions.
          'ForAllValues:StringLike': {
            'dynamodb:LeadingKeys': ['TENANT#*#HITL'],
          },
        },
      }),
    );
    props.dynamodbKey.grantEncryptDecrypt(expireHitlItemFn);

    // ─── New SQS Queues + DLQs (DocStudio, LeadAuditor, ControlTower) ──────
    const docStudioDlq = this.createStdDlq('DocStudioDlq');
    const docStudioQueue = this.createStdQueue('DocStudioQueue', docStudioDlq);

    const leadAuditorDlq = this.createStdDlq('LeadAuditorDlq');
    const leadAuditorQueue = this.createStdQueue('LeadAuditorQueue', leadAuditorDlq);

    const controlTowerDlq = this.createStdDlq('ControlTowerDlq');
    const controlTowerQueue = this.createStdQueue('ControlTowerQueue', controlTowerDlq);

    // ─── EventBridge Rules (R-8/R-9/R-10) ──────────────────────────────────
    const ruleRetryPolicy: targets.TargetBaseProps = {
      retryAttempts: 3,
      maxEventAge: cdk.Duration.hours(24),
      deadLetterQueue: deliveryFailureDlq as sqs.IQueue,
    };

    const canonicalTransformer = {
      inputPathsMap: { dt: '$.detail-type', detail: '$.detail' },
      inputTemplate: '{"detailType": "<dt>", "detail": <detail>}',
    };

    // R-8: DocStudioRule
    const docStudioRule = new events.Rule(this, 'DocStudioRule', {
      eventBus: bus,
      eventPattern: {
        detailType: ['CAPA.ActionRequiresDocChange', 'Policy.Updated', 'Scope.Changed'],
      },
    });
    docStudioRule.addTarget(new targets.SqsQueue(docStudioQueue, { ...ruleRetryPolicy }));
    this.applyInputTransformer(docStudioRule, canonicalTransformer);

    // R-9: LeadAuditorRule
    const leadAuditorRule = new events.Rule(this, 'LeadAuditorRule', {
      eventBus: bus,
      eventPattern: {
        detailType: ['ManagementReview.ActionAudit', 'Objectives.OffTrack'],
      },
    });
    leadAuditorRule.addTarget(new targets.SqsQueue(leadAuditorQueue, { ...ruleRetryPolicy }));
    this.applyInputTransformer(leadAuditorRule, canonicalTransformer);

    // R-10: ControlTowerRule
    const controlTowerRule = new events.Rule(this, 'ControlTowerRule', {
      eventBus: bus,
      eventPattern: {
        detailType: ['Context.Updated', 'Scope.Changed', 'Policy.Updated', 'Risk.Escalated'],
      },
    });
    controlTowerRule.addTarget(new targets.SqsQueue(controlTowerQueue, { ...ruleRetryPolicy }));
    this.applyInputTransformer(controlTowerRule, canonicalTransformer);

    // ─── DLQ Alarms (depth > 0 for 15 min) ─────────────────────────────────
    const dlqAlarms = [
      { id: 'DocStudioDlqAlarm', dlq: docStudioDlq },
      { id: 'LeadAuditorDlqAlarm', dlq: leadAuditorDlq },
      { id: 'ControlTowerDlqAlarm', dlq: controlTowerDlq },
    ];
    for (const { id, dlq } of dlqAlarms) {
      new cloudwatch.Alarm(this, id, {
        metric: dlq.metricApproximateNumberOfMessagesVisible({
          period: cdk.Duration.minutes(5),
        }),
        threshold: 1,
        evaluationPeriods: 3, // 15 min
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    }

    // ─── COND-4: LegalLedger credit-cap alerts (owner-ratified 2026-07-10) ──
    // $25/mo platform-wide, ALERT-ONLY (never blocks serving — F-6 ruling).
    // Hook is the canonical billing signal (telemetry.credits.consumed), not
    // Lambda log lines: rule filters detail.seat, log-group target + metric
    // filter turn detail.creditsConsumed into a CloudWatch metric.
    // 1,000 credits ≈ $1.00 raw Bedrock (metering §1.4), so $25/mo = 25,000
    // credits/mo. A strict calendar-month total is not expressible as a CW
    // alarm window — the daily-pace alarm (25,000/30 ≈ 833/day) fires on the
    // first day of any pattern that would breach the month; the hourly-burn
    // alarm catches runaway loops within the hour.
    const capLogGroup = new logs.LogGroup(this, 'LegalLedgerCapLogGroup', {
      logGroupName: `/cumplify/${envConfig.envName}/credit-cap/legal-ledger`,
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const capRule = new events.Rule(this, 'LegalLedgerCapRule', {
      eventBus: bus,
      description: 'COND-4: route legal-ledger credit telemetry to the cap metric log group',
      eventPattern: {
        source: ['cumplify.ai-invoker'],
        detailType: ['telemetry.credits.consumed'],
        detail: { seat: ['legal-ledger'] },
      },
    });
    capRule.addTarget(new targets.CloudWatchLogGroup(capLogGroup));

    capLogGroup.addMetricFilter('LegalLedgerCreditsFilter', {
      filterPattern: logs.FilterPattern.stringValue('$.detail.seat', '=', 'legal-ledger'),
      metricNamespace: 'Cumplify/AI',
      metricName: 'LegalLedgerCreditsConsumed',
      metricValue: '$.detail.creditsConsumed',
      unit: cloudwatch.Unit.NONE,
    });

    const capMetric = new cloudwatch.Metric({
      namespace: 'Cumplify/AI',
      metricName: 'LegalLedgerCreditsConsumed',
      statistic: 'Sum',
    });

    const creditCapAlertTopic = new sns.Topic(this, 'CreditCapAlertTopic', {
      topicName: `cumplify-${envConfig.envName}-credit-cap-alerts`,
      masterKey: props.snsKey,
      enforceSSL: true,
    });
    creditCapAlertTopic.addSubscription(
      new snsSubscriptions.EmailSubscription(envConfig.alertEmail),
    );

    const capDailyPaceAlarm = new cloudwatch.Alarm(this, 'LegalLedgerDailyPaceAlarm', {
      alarmDescription:
        'COND-4: legal-ledger seat spend on pace to exceed the ratified $25/mo cap ' +
        '(≥833 credits ≈ $0.83 in one day). Alert-only — serving is never blocked.',
      metric: capMetric.with({ period: cdk.Duration.days(1) }),
      threshold: 833,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    const capBurnRateAlarm = new cloudwatch.Alarm(this, 'LegalLedgerBurnRateAlarm', {
      alarmDescription:
        'COND-4: anomalous legal-ledger burn (≥250 credits ≈ 50 tasks in one hour vs ' +
        '~1/hr organic) — runaway loop or abuse. Alert-only.',
      metric: capMetric.with({ period: cdk.Duration.hours(1) }),
      threshold: 250,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    capDailyPaceAlarm.addAlarmAction(new cwActions.SnsAction(creditCapAlertTopic));
    capBurnRateAlarm.addAlarmAction(new cwActions.SnsAction(creditCapAlertTopic));

    // ─── AOSS Collections ──────────────────────────────────────────────────
    // Design §4.2: ISO-KB, TENANT-DOCS-KB, NC-HISTORY.
    // Task-9 deploy correction: cumplify-iso-kb is OWNED BY DataStack (spec 1,
    // deployed 2026-07-03; its data-access placeholder says "specs 4/5 add real
    // principals"). AiStack IMPORTS it (arn+endpoint props) and creates ONLY
    // the two new collections. Duplicate declaration failed live change-set
    // validation ("identifier encryption|cumplify-iso-kb-enc already exists").
    const collectionNames = [
      'cumplify-iso-kb',
      'cumplify-tenant-docs-kb',
      'cumplify-nc-history',
    ] as const;
    const newCollectionNames = ['cumplify-tenant-docs-kb', 'cumplify-nc-history'] as const;

    const aossCollections: Record<string, opensearchserverless.CfnCollection> = {};

    for (const name of newCollectionNames) {
      // Encryption policy (per collection)
      const encPolicy = new opensearchserverless.CfnSecurityPolicy(this, `${name}-enc`, {
        name: `${name}-enc`,
        type: 'encryption',
        policy: JSON.stringify({
          Rules: [{ ResourceType: 'collection', Resource: [`collection/${name}`] }],
          AWSOwnedKey: false,
          KmsARN: props.bedrockKeyArn,
        }),
      });

      // Network policy — VPC endpoint only (Option B: no Bedrock→AOSS managed path)
      const netPolicy = new opensearchserverless.CfnSecurityPolicy(this, `${name}-net`, {
        name: `${name}-net`,
        type: 'network',
        policy: JSON.stringify([
          {
            Rules: [
              { ResourceType: 'collection', Resource: [`collection/${name}`] },
              { ResourceType: 'dashboard', Resource: [`collection/${name}`] },
            ],
            AllowFromPublic: false,
            // SourceVPCEs: AWS::OpenSearchServerless::VpcEndpoint ID (NOT EC2 interface endpoint)
            SourceVPCEs: [props.aossVpcEndpointId],
          },
        ]),
      });

      // Collection
      const collection = new opensearchserverless.CfnCollection(this, `Aoss-${name}`, {
        name,
        type: 'VECTORSEARCH',
        description: `Cumplify AI agents: ${name} (Titan Embed v2, 1024 dims, scale-to-zero)`,
        standbyReplicas: 'DISABLED', // NextGen scale-to-zero
      });
      collection.addDependency(encPolicy);
      collection.addDependency(netPolicy);

      aossCollections[name] = collection;
    }

    // ─── AOSS Data-Access Policy (Task 4, REQUIRES-HUMAN) ────────────────
    // T4-F2 FIX: AOSS requires EXACT ARNs — no globs. Seeder ARN is known now;
    // agent-handler + apply-template roles are AMENDED in Task 8 / Task 9 with
    // exact ARNs once those roles exist.
    const collectionResources = collectionNames.map((n) => `collection/${n}`);
    const indexResources = collectionNames.map((n) => `index/${n}/*`);
    // iso-kb imported from DataStack; the two new collections resolved from attrs
    const collectionArns = [
      props.isoKbCollectionArn,
      ...newCollectionNames.map((n) => aossCollections[n].attrArn),
    ];
    const collectionEndpoints: Record<string, string> = {
      'cumplify-iso-kb': props.isoKbCollectionEndpoint,
      'cumplify-tenant-docs-kb': aossCollections['cumplify-tenant-docs-kb'].attrCollectionEndpoint,
      'cumplify-nc-history': aossCollections['cumplify-nc-history'].attrCollectionEndpoint,
    };

    // READ access policy (invoker — seeder WRITE added post-declaration below)
    // Full data-access policy assembled after weightSeeder is defined (avoid forward ref).

    // ─── Agent Handler Read-Only Policy Factory (T4-F4, T-1 gate b) ────────
    // Agent handlers get: lambda:Invoke(invoker), SFN start, AOSS read.
    // They have ZERO RDS access, ZERO DynamoDB access (context via SQS event
    // payload + AOSS retrieval). NO dynamodb:PutItem/UpdateItem/DeleteItem.
    // NO dynamodb:GetItem/Query (T4R-F1: avoids cross-tenant reads; handler
    // proposes then pauses — frontend polls HITL status, not the handler).
    // SQS consume permissions auto-granted by CDK SqsEventSource in Task 8.
    //
    // Exported as a reusable managed policy so Task 8 attaches it to each handler.
    const agentHandlerPolicy = new iam.ManagedPolicy(this, 'AgentHandlerReadOnlyPolicy', {
      description: 'Shared read-only policy for agent handler Lambdas (T-1: zero write, zero DDB).',
      statements: [
        // lambda:InvokeFunction on AI Invoker only
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['lambda:InvokeFunction'],
          resources: [aiInvoker.functionArn],
        }),
        // SFN: StartExecution on HITL state machine
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['states:StartExecution'],
          resources: [hitlStateMachine.stateMachineArn],
        }),
        // AOSS: APIAccessAll for retrieval (read path)
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['aoss:APIAccessAll'],
          resources: collectionArns,
        }),
      ],
    });

    // ─── ExecuteWriteback Role (post-HITL, the ONLY write path) ────────────
    // T4-F1 FIX: uses app_role secret (NOT master) → RLS enforced.
    // T4-F5 carry: invoke-permission restricted to HITL state-machine role in Task 8.
    // Role policies attached to the CDK-generated Lambda execution role.
    executeWritebackLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'rds-data:ExecuteStatement',
          'rds-data:BatchExecuteStatement',
          'rds-data:BeginTransaction',
          'rds-data:CommitTransaction',
          'rds-data:RollbackTransaction',
        ],
        resources: [props.clusterArn],
      }),
    );
    executeWritebackLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue'],
        resources: [appRoleSecretArn],
      }),
    );
    props.dynamodbKey.grantDecrypt(executeWritebackLambda);
    executeWritebackLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['events:PutEvents'],
        resources: [props.busArn],
      }),
    );

    // ─── Store-Token Lambda Role (gate c) ──────────────────────────────────
    // Writes ONLY the taskToken field into the DDB HITL item, tenant-scoped.
    storeTokenLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['dynamodb:UpdateItem'],
        resources: [props.tableArn],
        conditions: {
          'ForAllValues:StringLike': {
            'dynamodb:LeadingKeys': ['TENANT#*#HITL'],
          },
        },
      }),
    );
    props.dynamodbKey.grantEncryptDecrypt(storeTokenLambda);

    // ─── 8 Agent Handler Lambdas + Roles (H-2, Task 8R) ───────────────────
    // Each handler gets AgentHandlerReadOnlyPolicy attached.
    // SQS consumers get ESMs on their respective queues.
    // Guru resolvers are AppSync-invoked (no ESM).
    // BLOCKED-ON-DESIGN: embedding path — handlers use placeholder vectors.
    // The AI Invoker needs an embed() door (Titan Embed v2, 1024-dim) before
    // retrieval-grounding is real. Flagged as design amendment, not faked.

    const capaIntakeQueue = sqs.Queue.fromQueueArn(
      this,
      'ImportedCapaIntakeQueue',
      props.capaIntakeQueueArn,
    );
    const recordsQueue = sqs.Queue.fromQueueArn(
      this,
      'ImportedRecordsQueue',
      props.recordsQueueArn,
    );

    // Shared env for all agent handlers
    const agentHandlerBaseEnv = {
      AI_INVOKER_ARN: aiInvoker.functionArn,
      TABLE_NAME: props.tableName,
      HITL_STATE_MACHINE_ARN: hitlStateMachine.stateMachineArn,
      POWERTOOLS_LOG_LEVEL: 'INFO',
    };

    // AOSS endpoint env vars
    const aossEndpoints = {
      AOSS_ISO_KB_ENDPOINT: collectionEndpoints['cumplify-iso-kb'],
      AOSS_TENANT_DOCS_ENDPOINT: collectionEndpoints['cumplify-tenant-docs-kb'],
      AOSS_NC_HISTORY_ENDPOINT: collectionEndpoints['cumplify-nc-history'],
    };

    // Helper: create an agent handler Lambda with the managed policy
    const createAgentHandler = (
      id: string,
      entry: string,
      env: Record<string, string>,
      opts?: { fifo?: boolean; vpcPlaced?: boolean; functionName?: string },
    ) => {
      const fn = new NodejsFunction(this, id, {
        entry,
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 512,
        timeout: cdk.Duration.seconds(60),
        ...(opts?.functionName && { functionName: opts.functionName }),
        bundling: { externalModules: [], target: 'node22', loader: { '.md': 'text' } },
        environment: { ...agentHandlerBaseEnv, ...env },
        // FIX-T20-3 (spec-35): the AOSS network policy is VPCE-only
        // (AllowFromPublic:false), so a handler that queries a KB collection
        // gets 401 from the data plane unless it runs inside the VPC —
        // IAM and data-access policy grants cannot compensate. The zero-NAT
        // VPC reaches the Lambda API via the LambdaEndpoint interface
        // endpoint (network-stack). S2.1: states + sqs endpoints now exist,
        // so HITL-gating SQS consumers (CAPAGuru, DocStudio) are VPC-placed
        // too; remaining consumers move in as their endpoint needs are mapped.
        ...(opts?.vpcPlaced && {
          vpc: props.vpc,
          vpcSubnets: { subnets: props.privateSubnets },
        }),
      });
      fn.role!.addManagedPolicy(agentHandlerPolicy);
      return fn;
    };

    // ── SQS Consumer Handlers ──

    // 1. CAPAGuru (FIFO queue: capa-intake)
    // RS-8: deterministic functionName (same no-cycle pattern as
    // RegenerateSectionFn/DocGenStateMachine below — ApiStack constructs the
    // ARN from this exact name via formatArn, no cross-stack CDK reference
    // needed; AiStack keeps depending on ApiStack, unchanged).
    const capaGuruFnName = `cumplify-capa-guru-${envConfig.envName}`;
    const capaGuruHandler = createAgentHandler(
      'CapaGuruFn',
      'services/agents/capa-guru/handler.ts',
      {
        ...aossEndpoints,
        DLQ_URL: props.capaIntakeDlqUrl,
        POWERTOOLS_SERVICE_NAME: 'agent-capa-guru',
      },
      // S2.1: VPC-placed — its nc-history retrieval 401'd from outside the
      // VPCE-only AOSS network policy (silently degrading grounding to '').
      { functionName: capaGuruFnName, vpcPlaced: true },
    );
    capaGuruHandler.addEventSource(
      new SqsEventSource(capaIntakeQueue, {
        batchSize: 1,
        reportBatchItemFailures: true,
      }),
    );

    // RiskSentinel (RS-8, read-surface-completion) — Workhorse seat, Nova
    // Pro per Part 30 (contracts/model-register.md: already registered for
    // this agent, PROVISIONAL, expiry 2026-10-06 — no new Register row
    // needed). No SQS trigger yet (hazard/aspect event triggers are
    // catalogued roadmap, agent-catalog.md:198-212) — synchronous direct-
    // invoke only, from m5.ts's runRiskAssessment, deterministic name
    // (same pattern as CapaGuruFn above).
    const riskSentinelFnName = `cumplify-risk-sentinel-${envConfig.envName}`;
    const riskSentinelHandler = createAgentHandler(
      'RiskSentinelFn',
      'services/agents/risk-sentinel/handler.ts',
      { POWERTOOLS_SERVICE_NAME: 'agent-risk-sentinel' },
      { functionName: riskSentinelFnName },
    );

    // 2. DocStudio (standard queue). Deterministic name (S2 studio wave):
    // m1's runDocDraft resolver in ApiStack constructs the ARN by this name
    // via formatArn — same no-cycle pattern as cumplify-capa-guru.
    const docStudioHandler = createAgentHandler(
      'DocStudioHandlerFn',
      'services/agents/doc-studio/handler.ts',
      {
        ...aossEndpoints,
        DOC_STUDIO_DLQ_URL: docStudioDlq.queueUrl,
        DLQ_URL: docStudioDlq.queueUrl,
        POWERTOOLS_SERVICE_NAME: 'agent-doc-studio',
      },
      // S2.1: VPC-placed — found at the S2 UI witness: both KB retrievals
      // 401'd from outside the VPCE-only AOSS network policy.
      { functionName: `cumplify-doc-studio-${envConfig.envName}`, vpcPlaced: true },
    );
    docStudioHandler.addEventSource(
      new SqsEventSource(docStudioQueue, {
        batchSize: 1,
        reportBatchItemFailures: true,
      }),
    );

    // 3. LeadAuditor (standard queue)
    const leadAuditorHandler = createAgentHandler(
      'LeadAuditorHandlerFn',
      'services/agents/lead-auditor/handler.ts',
      {
        ...aossEndpoints,
        LEAD_AUDITOR_DLQ_URL: leadAuditorDlq.queueUrl,
        DLQ_URL: leadAuditorDlq.queueUrl,
        POWERTOOLS_SERVICE_NAME: 'agent-lead-auditor',
      },
      // S4: deterministic name (m3's runAuditFindings dispatches by ARN) +
      // VPC-placed (its KB retrievals 401 outside the VPCE-only AOSS policy).
      { functionName: `cumplify-lead-auditor-${envConfig.envName}`, vpcPlaced: true },
    );
    leadAuditorHandler.addEventSource(
      new SqsEventSource(leadAuditorQueue, {
        batchSize: 1,
        reportBatchItemFailures: true,
      }),
    );

    // 4. ControlTower (standard queue)
    const controlTowerHandler = createAgentHandler(
      'ControlTowerHandlerFn',
      'services/agents/control-tower/handler.ts',
      {
        ...aossEndpoints,
        CONTROL_TOWER_DLQ_URL: controlTowerDlq.queueUrl,
        DLQ_URL: controlTowerDlq.queueUrl,
        POWERTOOLS_SERVICE_NAME: 'agent-control-tower',
      },
    );
    controlTowerHandler.addEventSource(
      new SqsEventSource(controlTowerQueue, {
        batchSize: 1,
        reportBatchItemFailures: true,
      }),
    );

    // 5. RecordsVault (standard queue: records)
    const recordsVaultHandler = createAgentHandler(
      'RecordsVaultHandlerFn',
      'services/agents/records-vault/handler.ts',
      {
        RECORDS_VAULT_DLQ_URL: props.recordsDlqUrl,
        DLQ_URL: props.recordsDlqUrl,
        POWERTOOLS_SERVICE_NAME: 'agent-records-vault',
      },
    );
    recordsVaultHandler.addEventSource(
      new SqsEventSource(recordsQueue, {
        batchSize: 1,
        reportBatchItemFailures: true,
      }),
    );

    // ── Guru Handlers (AppSync-invoked, no ESM) ──

    // 6. ISO9001Guru
    const guru9001Handler = createAgentHandler(
      'Guru9001Fn',
      'services/agents/guru-9001/handler.ts',
      {
        AOSS_ISO_KB_ENDPOINT: collectionEndpoints['cumplify-iso-kb'],
        POWERTOOLS_SERVICE_NAME: 'agent-guru-9001',
      },
      { vpcPlaced: true },
    );

    // 7. ISO14001Guru
    const guru14001Handler = createAgentHandler(
      'Guru14001Fn',
      'services/agents/guru-14001/handler.ts',
      {
        AOSS_ISO_KB_ENDPOINT: collectionEndpoints['cumplify-iso-kb'],
        POWERTOOLS_SERVICE_NAME: 'agent-guru-14001',
      },
      { vpcPlaced: true },
    );

    // 8. ISO45001Guru
    const guru45001Handler = createAgentHandler(
      'Guru45001Fn',
      'services/agents/guru-45001/handler.ts',
      {
        AOSS_ISO_KB_ENDPOINT: collectionEndpoints['cumplify-iso-kb'],
        POWERTOOLS_SERVICE_NAME: 'agent-guru-45001',
      },
      { vpcPlaced: true },
    );

    // Collect all handler role ARNs for AOSS data-access amendment
    const agentHandlerRoleArns = [
      capaGuruHandler.role!.roleArn,
      docStudioHandler.role!.roleArn,
      leadAuditorHandler.role!.roleArn,
      controlTowerHandler.role!.roleArn,
      recordsVaultHandler.role!.roleArn,
      guru9001Handler.role!.roleArn,
      guru14001Handler.role!.roleArn,
      guru45001Handler.role!.roleArn,
    ];

    // ─── Guru AppSync Data Sources + Resolvers (Task 8R-2) ──────────────────
    // Import the existing AppSync API (created by ApiStack — AiStack depends on it).
    // Auth mode: @aws_lambda (user-facing, consistent with all other Query fields).
    const importedApi = appsync.GraphqlApi.fromGraphqlApiAttributes(this, 'ImportedApi', {
      graphqlApiId,
    });

    const guru9001DS = importedApi.addLambdaDataSource('Guru9001DataSource', guru9001Handler);
    const guru14001DS = importedApi.addLambdaDataSource('Guru14001DataSource', guru14001Handler);
    const guru45001DS = importedApi.addLambdaDataSource('Guru45001DataSource', guru45001Handler);

    guru9001DS.createResolver('AskISO9001Resolver', {
      typeName: 'Query',
      fieldName: 'askISO9001',
    });
    guru14001DS.createResolver('AskISO14001Resolver', {
      typeName: 'Query',
      fieldName: 'askISO14001',
    });
    guru45001DS.createResolver('AskISO45001Resolver', {
      typeName: 'Query',
      fieldName: 'askISO45001',
    });

    // ─── B3: Tenant-docs indexer (Document.Published → embed → AOSS write) ──
    // L1 MANDATE: MUST be vpcPlaced — AOSS VPCE-only network policy.
    // Separate from agent handlers: needs RDS + S3 + AOSS write + embed invoke.
    const tenantDocsIndexerQueue = sqs.Queue.fromQueueArn(
      this,
      'ImportedTenantDocsIndexerQueue',
      props.tenantDocsIndexerQueueArn,
    );
    const tenantDocsIndexerDlq = props.tenantDocsIndexerDlqUrl;

    const tenantDocsIndexerFn = new NodejsFunction(this, 'TenantDocsIndexerFn', {
      entry: 'services/indexer/tenant-docs/handler.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(90), // 02-aoss-rule: timeout >= 60s
      bundling: { externalModules: [], target: 'node22' },
      environment: {
        CONTENT_BUCKET: props.generalBucketName,
        AOSS_TENANT_DOCS_ENDPOINT: collectionEndpoints['cumplify-tenant-docs-kb'],
        AI_INVOKER_ARN: aiInvoker.functionArn,
        DLQ_URL: tenantDocsIndexerDlq,
        POWERTOOLS_SERVICE_NAME: 'indexer-tenant-docs',
      },
      // L1: VPC-placed — AOSS rejects public data-plane calls
      vpc: props.vpc,
      vpcSubnets: { subnets: props.privateSubnets },
    });

    // SQS event source
    tenantDocsIndexerFn.addEventSource(
      new SqsEventSource(tenantDocsIndexerQueue, {
        batchSize: 1,
        reportBatchItemFailures: true,
      }),
    );

    // S3: read document content
    tenantDocsIndexerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [`${props.generalBucketArn}/*`],
      }),
    );
    // KMS decrypt (S3 SSE-KMS)
    props.s3GeneralKey.grantDecrypt(tenantDocsIndexerFn);
    // Lambda invoke: AI Invoker (one-door embed path)
    tenantDocsIndexerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [aiInvoker.functionArn],
      }),
    );
    // AOSS: write (APIAccessAll on tenant-docs-kb collection)
    tenantDocsIndexerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['aoss:APIAccessAll'],
        resources: collectionArns,
      }),
    );

    // Add indexer role to AOSS data-access policy principals
    const indexerRoleArn = tenantDocsIndexerFn.role!.roleArn;

    // ─── Spec 40: DocGen generation plane (design §4.1) ────────────────────
    // SeedSections → Map(ComposeSection, MaxConcurrency 4) → FinalizeManual.
    // State machine name is DETERMINISTIC (`cumplify-docgen-<env>`): QmsFn in
    // ApiStack constructs the ARN by name — no CFN cross-stack cycle
    // (AiStack already depends on ApiStack for the AppSync URL).
    const genEnv = {
      CLUSTER_ARN: props.clusterArn,
      APP_ROLE_SECRET_ARN: appRoleSecretArn,
      TABLE_NAME: props.tableName,
      BUS_NAME: props.busName,
      GENERAL_BUCKET: props.generalBucketName,
      APPSYNC_URL: graphqlApiUrl,
    };

    const seedSectionsFn = new NodejsFunction(this, 'SeedSectionsFn', {
      entry: 'services/qms-generation/src/seed-sections.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(60),
      bundling: { externalModules: [], target: 'node22' },
      environment: { ...genEnv, POWERTOOLS_SERVICE_NAME: 'qms-seed-sections' },
    });

    const composeSectionFn = new NodejsFunction(this, 'ComposeSectionFn', {
      entry: 'services/qms-generation/src/compose-section.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      // one-door invoke is 90s; compose may call twice (checker retry)
      timeout: cdk.Duration.seconds(240),
      bundling: { externalModules: [], target: 'node22' },
      environment: {
        ...genEnv,
        AI_INVOKER_ARN: aiInvoker.functionArn,
        POWERTOOLS_SERVICE_NAME: 'qms-compose-section',
      },
    });

    const markRunFailedFn = new NodejsFunction(this, 'MarkRunFailedFn', {
      entry: 'services/qms-generation/src/mark-run-failed.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(60),
      bundling: { externalModules: [], target: 'node22' },
      environment: { ...genEnv, POWERTOOLS_SERVICE_NAME: 'qms-mark-run-failed' },
    });

    const finalizeManualFn = new NodejsFunction(this, 'FinalizeManualFn', {
      entry: 'services/qms-generation/src/finalize-manual.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      // Task 6: ~40 document writes (S3 get+put per section/doc) in one run
      timeout: cdk.Duration.seconds(120),
      bundling: { externalModules: [], target: 'node22' },
      environment: { ...genEnv, POWERTOOLS_SERVICE_NAME: 'qms-finalize-manual' },
    });

    // RegenerateSectionFn (GEN-6): single-section recompose + version
    // writeback, invoked synchronously by QmsFn's regenerateSection case.
    // DETERMINISTIC NAME — ApiStack constructs the ARN by name (the SFN's
    // no-cycle pattern; AiStack depends on ApiStack). Compose runs
    // IN-PROCESS (compose-section handler import), so this function carries
    // compose's env + grants; timeout matches ComposeSectionFn (one-door
    // invoke is 90s and compose may call twice).
    const regenerateSectionFn = new NodejsFunction(this, 'RegenerateSectionFn', {
      entry: 'services/qms-generation/src/regenerate-section.ts',
      handler: 'handler',
      functionName: `cumplify-docgen-regen-${envConfig.envName}`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(240),
      bundling: { externalModules: [], target: 'node22' },
      environment: {
        ...genEnv,
        AI_INVOKER_ARN: aiInvoker.functionArn,
        POWERTOOLS_SERVICE_NAME: 'qms-regenerate-section',
      },
    });

    const publishGenerationEventArn = cdk.Stack.of(this).formatArn({
      service: 'appsync',
      resource: 'apis',
      resourceName: `${graphqlApiId}/types/Mutation/fields/publishGenerationEvent`,
    });

    for (const fn of [
      seedSectionsFn,
      composeSectionFn,
      finalizeManualFn,
      regenerateSectionFn,
      markRunFailedFn,
    ]) {
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'rds-data:ExecuteStatement',
            'rds-data:BeginTransaction',
            'rds-data:CommitTransaction',
            'rds-data:RollbackTransaction',
          ],
          resources: [props.clusterArn],
        }),
      );
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['secretsmanager:GetSecretValue'],
          resources: [appRoleSecretArn],
        }),
      );
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['events:PutEvents'],
          resources: [props.busArn],
        }),
      );
      // The app-role secret is encrypted with the dynamodb/secrets CMK
      // (api-stack.ts AppRoleSecret encryptionKey) — NOT the master-secret
      // key. Live-proven 2026-07-15: dbSecretKey grant alone → KMS denial.
      props.dynamodbKey.grantDecrypt(fn);
    }

    // Working content lives under tenants/* only — no bucket-wide access.
    // Finalize reads section JSONs AND writes document JSONs (Task 6).
    for (const fn of [seedSectionsFn, composeSectionFn, finalizeManualFn, regenerateSectionFn]) {
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['s3:PutObject', 's3:GetObject'],
          resources: [`${props.generalBucketArn}/tenants/*`],
        }),
      );
      props.s3GeneralKey.grantEncryptDecrypt(fn);
    }

    // GEN-5 progress events: compose + finalize publish the @aws_iam mutation
    for (const fn of [composeSectionFn, finalizeManualFn, regenerateSectionFn, markRunFailedFn]) {
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['appsync:GraphQL'],
          resources: [publishGenerationEventArn],
        }),
      );
    }

    // ONE DOOR: ComposeSection reaches Bedrock only via the invoker Lambda
    aiInvoker.grantInvoke(composeSectionFn);
    aiInvoker.grantInvoke(regenerateSectionFn); // compose runs in-process (GEN-6)

    const seedTask = new tasks.LambdaInvoke(this, 'SeedSections', {
      lambdaFunction: seedSectionsFn,
      outputPath: '$.Payload',
    });
    seedTask.addRetry({
      errors: ['States.ALL'],
      maxAttempts: 2,
      interval: cdk.Duration.seconds(10),
      backoffRate: 2,
    });

    const composeTask = new tasks.LambdaInvoke(this, 'ComposeSection', {
      lambdaFunction: composeSectionFn,
      outputPath: '$.Payload',
    });
    composeTask.addRetry({
      errors: ['States.ALL'],
      maxAttempts: 2,
      interval: cdk.Duration.seconds(15),
      backoffRate: 2,
    });

    const composeMap = new sfn.Map(this, 'ComposeSections', {
      maxConcurrency: 4,
      itemsPath: '$.sections',
      itemSelector: {
        runId: sfn.JsonPath.stringAt('$.runId'),
        tenantId: sfn.JsonPath.stringAt('$.tenantId'),
        sectionId: sfn.JsonPath.stringAt('$$.Map.Item.Value.sectionId'),
        sectionKey: sfn.JsonPath.stringAt('$$.Map.Item.Value.sectionKey'),
      },
      resultPath: sfn.JsonPath.DISCARD, // {runId, tenantId} flows on to Finalize
    });
    composeMap.itemProcessor(composeTask);

    const finalizeTask = new tasks.LambdaInvoke(this, 'FinalizeManual', {
      lambdaFunction: finalizeManualFn,
      outputPath: '$.Payload',
    });
    finalizeTask.addRetry({
      errors: ['States.ALL'],
      maxAttempts: 2,
      interval: cdk.Duration.seconds(10),
      backoffRate: 2,
    });

    // Any stage dying post-retry previously stranded the run at 'running'
    // forever (the SFN failed but nobody touched qms.generation_runs).
    // Catch-all on every stage → MarkRunFailed flips the row 'failed'.
    const markRunFailed = new tasks.LambdaInvoke(this, 'MarkRunFailed', {
      lambdaFunction: markRunFailedFn,
      outputPath: '$.Payload',
    });
    // MarkRunFailed is a catch target — without a terminal Fail it would
    // swallow the error and report the execution SUCCEEDED.
    const runFailed = new sfn.Fail(this, 'RunFailed', {
      error: 'StageError',
      causePath: sfn.JsonPath.stringAt('$.stageError'),
    });
    const markRunFailedThenFail = markRunFailed.next(runFailed);
    seedTask.addCatch(markRunFailedThenFail, {
      errors: ['States.ALL'],
      resultPath: '$.stageError',
    });
    composeMap.addCatch(markRunFailedThenFail, {
      errors: ['States.ALL'],
      resultPath: '$.stageError',
    });
    finalizeTask.addCatch(markRunFailedThenFail, {
      errors: ['States.ALL'],
      resultPath: '$.stageError',
    });

    const docGenStateMachine = new sfn.StateMachine(this, 'DocGenStateMachine', {
      stateMachineName: `cumplify-docgen-${envConfig.envName}`,
      definitionBody: sfn.DefinitionBody.fromChainable(
        seedTask.next(composeMap).next(finalizeTask),
      ),
      stateMachineType: sfn.StateMachineType.STANDARD,
      timeout: cdk.Duration.hours(2),
    });

    new cdk.CfnOutput(this, 'DocGenStateMachineArn', { value: docGenStateMachine.stateMachineArn });
    new cdk.CfnOutput(this, 'RecordWriteGuardrailId', {
      value: recordWriteGuardrail.attrGuardrailId,
    });
    new cdk.CfnOutput(this, 'RecordWriteGuardrailVersion', {
      value: recordWriteGuardrail.attrVersion,
    });
    new cdk.CfnOutput(this, 'SeedSectionsFnArn', { value: seedSectionsFn.functionArn });
    new cdk.CfnOutput(this, 'ComposeSectionFnArn', { value: composeSectionFn.functionArn });
    new cdk.CfnOutput(this, 'FinalizeManualFnArn', { value: finalizeManualFn.functionArn });
    new cdk.CfnOutput(this, 'RegenerateSectionFnArn', { value: regenerateSectionFn.functionArn });

    // ─── CfnOutputs for IAM roles ──────────────────────────────────────────
    new cdk.CfnOutput(this, 'ExecuteWritebackRoleArn', {
      value: executeWritebackLambda.role!.roleArn,
    });
    new cdk.CfnOutput(this, 'StoreTokenRoleArn', { value: storeTokenLambda.role!.roleArn });
    new cdk.CfnOutput(this, 'AgentHandlerPolicyArn', {
      value: agentHandlerPolicy.managedPolicyArn,
    });
    new cdk.CfnOutput(this, 'ExecuteWritebackLambdaArn', {
      value: executeWritebackLambda.functionArn,
    });
    new cdk.CfnOutput(this, 'StoreTokenLambdaArn', { value: storeTokenLambda.functionArn });
    // Agent handler outputs
    new cdk.CfnOutput(this, 'CapaGuruHandlerArn', { value: capaGuruHandler.functionArn });
    new cdk.CfnOutput(this, 'RiskSentinelHandlerArn', { value: riskSentinelHandler.functionArn });
    new cdk.CfnOutput(this, 'DocStudioHandlerArn', { value: docStudioHandler.functionArn });
    new cdk.CfnOutput(this, 'LeadAuditorHandlerArn', { value: leadAuditorHandler.functionArn });
    new cdk.CfnOutput(this, 'ControlTowerHandlerArn', { value: controlTowerHandler.functionArn });
    new cdk.CfnOutput(this, 'RecordsVaultHandlerArn', { value: recordsVaultHandler.functionArn });
    new cdk.CfnOutput(this, 'Guru9001HandlerArn', { value: guru9001Handler.functionArn });
    new cdk.CfnOutput(this, 'Guru14001HandlerArn', { value: guru14001Handler.functionArn });
    new cdk.CfnOutput(this, 'Guru45001HandlerArn', { value: guru45001Handler.functionArn });

    // ─── Index Mapping (R5 carry — metadata.tenantId as keyword) ──────────
    // Committed artifact: services/agents/shared/aoss-index-template.json
    // Defines: knn_vector 1024-dim (faiss/hnsw), metadata.tenantId/standard/clauseRef
    // as keyword (filterable). The term filter in retrieval.ts only isolates tenants
    // if tenantId is keyword (non-analyzed).
    //
    // The apply-template custom resource (Task 9 deliverable):
    // A VPC-attached, SigV4-signing Lambda PUTs _index_template to each collection
    // endpoint BEFORE any document seeding. Requires Task-4 AOSS data-access grant.
    // Task 12 seeding must fail-closed if the template is absent (GET _index_template
    // first — never index against an auto-mapped field).

    // ─── MODELWEIGHT# Seeding Custom Resource (T-2/T3-F3) ──────────────────
    // Reads services/ai-invoker/data/model-weights-seed.json (committed by Task 2,
    // architect-witnessed) and writes MODELWEIGHT# items to DynamoDB.
    // Does NOT call live Pricing API at deploy time (T-2 correction).
    const weightSeeder = new NodejsFunction(this, 'WeightSeederFn', {
      entry: 'services/ai-invoker/src/weight-seeder.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      bundling: { externalModules: [], target: 'node22' },
      environment: {
        TABLE_NAME: props.tableName,
        POWERTOOLS_SERVICE_NAME: 'weight-seeder',
      },
    });
    weightSeeder.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['dynamodb:PutItem'],
        resources: [props.tableArn],
        conditions: {
          'ForAllValues:StringLike': {
            'dynamodb:LeadingKeys': ['MODELWEIGHT#*'],
          },
        },
      }),
    );
    props.dynamodbKey.grantEncryptDecrypt(weightSeeder);

    // Custom resource trigger (runs on deploy)
    // T3E-F4: incorporate hash of seed file into physicalResourceId so a changed
    // seed file triggers re-seeding. ConditionalCheckFailed is handled (F3).
    const seedFileHash = cdk.FileSystem.fingerprint(
      'services/ai-invoker/data/model-weights-seed.json',
    );
    new cr.AwsCustomResource(this, 'WeightSeederTrigger', {
      onCreate: {
        service: 'Lambda',
        action: 'invoke',
        parameters: {
          FunctionName: weightSeeder.functionName,
          InvocationType: 'RequestResponse',
          Payload: JSON.stringify({ action: 'seed', seedHash: seedFileHash }),
        },
        physicalResourceId: cr.PhysicalResourceId.of(`weight-seeder-${seedFileHash}`),
      },
      onUpdate: {
        service: 'Lambda',
        action: 'invoke',
        parameters: {
          FunctionName: weightSeeder.functionName,
          InvocationType: 'RequestResponse',
          Payload: JSON.stringify({ action: 'seed', seedHash: seedFileHash }),
        },
        physicalResourceId: cr.PhysicalResourceId.of(`weight-seeder-${seedFileHash}`),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: [weightSeeder.functionArn],
        }),
      ]),
    });

    // ─── AOSS Apply-Template Lambda (Task 9, T3E-F1 part 2, architect) ─────
    // VPC-attached (AOSS network policy = VPC endpoint only), SigV4-signing.
    // PUTs services/agents/shared/aoss-index-template.json to each collection
    // and GET-verifies (1024 dims + tenantId keyword) — fail-closed.
    const applyTemplateFn = new NodejsFunction(this, 'ApplyTemplateFn', {
      entry: 'services/agents/shared/aoss-apply-template.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(240), // in-Lambda retries cover policy propagation
      bundling: { externalModules: [], target: 'node22' },
      vpc: props.vpc,
      vpcSubnets: { subnets: props.privateSubnets },
      environment: {
        COLLECTIONS: JSON.stringify(
          collectionNames.map((n) => ({
            name: n,
            endpoint: collectionEndpoints[n],
          })),
        ),
        POWERTOOLS_SERVICE_NAME: 'aoss-apply-template',
      },
    });
    applyTemplateFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['aoss:APIAccessAll'],
        resources: collectionArns,
      }),
    );

    // ─── AOSS Prover Lambda (Task 12, ACC-4, architect ops tool) ──────────
    // VPC-attached, SigV4-signing. Executes the Task-12 proof sequence
    // (template-check / seed / query-via-retrieve() / search-control /
    // delete-index). ONE-DOOR: never touches Bedrock — embedding vectors
    // arrive in the invocation payload. seed/delete refuse indexes not
    // prefixed 'task12-'. Invoked on demand by the architect, no CR trigger.
    const aossProverFn = new NodejsFunction(this, 'AossProverFn', {
      entry: 'services/agents/shared/aoss-prover.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(120), // retrieve() ceiling 45s + cold-start margin
      bundling: { externalModules: [], target: 'node22' },
      vpc: props.vpc,
      vpcSubnets: { subnets: props.privateSubnets },
      environment: {
        COLLECTIONS: JSON.stringify(
          collectionNames.map((n) => ({
            name: n,
            endpoint: collectionEndpoints[n],
          })),
        ),
        POWERTOOLS_SERVICE_NAME: 'aoss-prover',
      },
    });
    aossProverFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['aoss:APIAccessAll'],
        resources: collectionArns,
      }),
    );

    // ─── ISO KB Seeder Lambda (iso-kb-seeding Task 5) ─────────────────────
    // VPC-attached (AOSS network policy = VPC endpoint only), esbuild .md text loader.
    // Seeds docs/kb/ content files into cumplify-iso-kb index (iso-kb-content-depth).
    // FIX-P12-3: CFN-direct custom resource (serviceToken) — failed seed FAILS deploy.
    const isoKbSeederFn = new NodejsFunction(this, 'IsoKbSeederFn', {
      entry: 'services/iso-kb-seeder/src/cfn-handler.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(300), // SEED-1f: >= 300s (embed 106 chunks + AOSS cold-start)
      bundling: {
        externalModules: [],
        target: 'node22',
        loader: { '.md': 'text' }, // D-1: esbuild text loader — build-time inline
      },
      vpc: props.vpc,
      vpcSubnets: { subnets: props.privateSubnets }, // SEED-1a: VPC-placed
      environment: {
        AOSS_ENDPOINT: collectionEndpoints['cumplify-iso-kb'],
        AOSS_INDEX_NAME: 'cumplify-iso-kb',
        AI_INVOKER_ARN: aiInvoker.functionArn,
        POWERTOOLS_SERVICE_NAME: 'iso-kb-seeder',
      },
    });

    // One-door: invoke AI Invoker for embeddings
    aiInvoker.grantInvoke(isoKbSeederFn);

    // AOSS: write access on iso-kb collection (ACCESS-1a)
    isoKbSeederFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['aoss:APIAccessAll'],
        resources: [props.isoKbCollectionArn],
      }),
    );

    // AOSS data-access policy for seeder (ACCESS-1b) — additive union with
    // the main policy below (D-4: no priority, AOSS policies are additive).
    const isoKbSeederAccessPolicy = new opensearchserverless.CfnAccessPolicy(
      this,
      'IsoKbSeederAccessPolicy',
      {
        name: `iso-kb-seeder-access`,
        type: 'data',
        policy: JSON.stringify([
          {
            Rules: [
              {
                ResourceType: 'collection',
                Resource: ['collection/cumplify-iso-kb'],
                Permission: [
                  'aoss:CreateCollectionItems',
                  'aoss:UpdateCollectionItems',
                  'aoss:DescribeCollectionItems',
                ],
              },
              {
                ResourceType: 'index',
                Resource: ['index/cumplify-iso-kb/*'],
                Permission: [
                  'aoss:CreateIndex',
                  'aoss:DeleteIndex',
                  'aoss:UpdateIndex',
                  'aoss:DescribeIndex',
                  'aoss:ReadDocument',
                  'aoss:WriteDocument',
                ],
              },
            ],
            Principal: [isoKbSeederFn.role!.roleArn],
          },
        ]),
      },
    );

    // FIX-P12-3: CFN-direct CustomResource — serviceToken invokes Lambda directly.
    // No provider Lambda, no invoke policy, no IAM propagation race.
    // SourceHash in properties → CFN detects change → Update fires → re-seed.
    // Failed seed → FAILED response → deploy rolls back (ACC-5 restored).
    // iso-kb-content-depth: fingerprint the docs/kb/ directory (covers all content files)
    const isoKbSourceHash = cdk.FileSystem.fingerprint('docs/kb');

    // CFN needs permission to invoke the seeder Lambda as a service token
    isoKbSeederFn.addPermission('CfnInvoke', {
      principal: new iam.ServicePrincipal('cloudformation.amazonaws.com'),
      action: 'lambda:InvokeFunction',
    });

    const isoKbSeederTrigger = new cdk.CustomResource(this, 'IsoKbSeederTrigger', {
      serviceToken: isoKbSeederFn.functionArn,
      resourceType: 'Custom::IsoKbSeed',
      properties: {
        SourceHash: isoKbSourceHash,
      },
    });
    // Seeder must run AFTER template is applied — dependency added post-declaration below

    new cdk.CfnOutput(this, 'IsoKbSeederFnArn', { value: isoKbSeederFn.functionArn });

    // ─── AOSS Data-Access Policy (assembled post-seeder to avoid forward ref) ──
    // H-2 (Task 8R): READ block amended with exact agent-handler role ARNs.
    // iso-kb-seeding Task 5: seeder role added to WRITE block for cumplify-iso-kb.
    const aossDataAccessPolicy = new opensearchserverless.CfnAccessPolicy(
      this,
      'AiAossDataAccessPolicy',
      {
        name: `cumplify-ai-access-${envConfig.envName}`,
        type: 'data',
        policy: JSON.stringify([
          {
            // READ access: AI Invoker + all 8 agent handler roles
            Rules: [
              {
                ResourceType: 'collection',
                Resource: collectionResources,
                Permission: ['aoss:DescribeCollectionItems'],
              },
              {
                ResourceType: 'index',
                Resource: indexResources,
                Permission: ['aoss:DescribeIndex', 'aoss:ReadDocument'],
              },
            ],
            Principal: [aiInvoker.role!.roleArn, ...agentHandlerRoleArns, indexerRoleArn],
          },
          {
            // WRITE access: weight-seeder + apply-template (T-9a exact role ARNs)
            Rules: [
              {
                ResourceType: 'collection',
                Resource: collectionResources,
                Permission: [
                  'aoss:CreateCollectionItems',
                  'aoss:UpdateCollectionItems',
                  'aoss:DescribeCollectionItems',
                ],
              },
              {
                ResourceType: 'index',
                Resource: indexResources,
                Permission: [
                  'aoss:CreateIndex',
                  'aoss:UpdateIndex',
                  'aoss:DescribeIndex',
                  'aoss:ReadDocument',
                  'aoss:WriteDocument',
                ],
              },
            ],
            Principal: [weightSeeder.role!.roleArn, applyTemplateFn.role!.roleArn, indexerRoleArn],
          },
          {
            // Task-12 prover: own block because cleanup needs aoss:DeleteIndex,
            // which the seeder/template principals must NOT gain (live-found:
            // delete-index 403'd without it). Code-level task1[2-4]- prefix
            // guard keeps deletes off production indexes.
            Rules: [
              {
                ResourceType: 'collection',
                Resource: collectionResources,
                Permission: [
                  'aoss:CreateCollectionItems',
                  'aoss:UpdateCollectionItems',
                  'aoss:DescribeCollectionItems',
                ],
              },
              {
                ResourceType: 'index',
                Resource: indexResources,
                Permission: [
                  'aoss:CreateIndex',
                  'aoss:UpdateIndex',
                  'aoss:DeleteIndex',
                  'aoss:DescribeIndex',
                  'aoss:ReadDocument',
                  'aoss:WriteDocument',
                ],
              },
            ],
            Principal: [aossProverFn.role!.roleArn],
          },
        ]),
      },
    );

    // Apply-template trigger — runs on create AND whenever the committed
    // template artifact changes (fingerprint in physicalResourceId).
    // Policy-propagation timing is additionally covered by in-Lambda retries.
    const templateFileHash = cdk.FileSystem.fingerprint(
      'services/agents/shared/aoss-index-template.json',
    );
    const applyTemplateTrigger = new cr.AwsCustomResource(this, 'ApplyTemplateTrigger', {
      onCreate: {
        service: 'Lambda',
        action: 'invoke',
        parameters: {
          FunctionName: applyTemplateFn.functionName,
          InvocationType: 'RequestResponse',
          Payload: JSON.stringify({ action: 'apply', templateHash: templateFileHash }),
        },
        physicalResourceId: cr.PhysicalResourceId.of(`aoss-apply-template-${templateFileHash}`),
      },
      onUpdate: {
        service: 'Lambda',
        action: 'invoke',
        parameters: {
          FunctionName: applyTemplateFn.functionName,
          InvocationType: 'RequestResponse',
          Payload: JSON.stringify({ action: 'apply', templateHash: templateFileHash }),
        },
        physicalResourceId: cr.PhysicalResourceId.of(`aoss-apply-template-${templateFileHash}`),
      },
      timeout: cdk.Duration.minutes(5),
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: [applyTemplateFn.functionArn],
        }),
      ]),
    });
    applyTemplateTrigger.node.addDependency(aossDataAccessPolicy);
    for (const name of newCollectionNames) {
      applyTemplateTrigger.node.addDependency(aossCollections[name]);
    }
    // iso-kb-seeding Task 5: seeder runs AFTER template is applied
    isoKbSeederTrigger.node.addDependency(applyTemplateTrigger);
    // FIX-P12-2: seeder must wait for BOTH access policies to exist (propagation)
    isoKbSeederTrigger.node.addDependency(isoKbSeederAccessPolicy);
    isoKbSeederTrigger.node.addDependency(aossDataAccessPolicy);

    // T4-F3 FIX: aoss:APIAccessAll in IAM (data-plane access to AOSS collections)
    aiInvoker.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['aoss:APIAccessAll'],
        resources: collectionArns,
      }),
    );
    weightSeeder.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['aoss:APIAccessAll'],
        resources: collectionArns,
      }),
    );

    // ─── CfnOutputs ────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'ApplyTemplateFnArn', { value: applyTemplateFn.functionArn });
    new cdk.CfnOutput(this, 'AossProverFnArn', { value: aossProverFn.functionArn });
    new cdk.CfnOutput(this, 'AiInvokerArn', { value: aiInvoker.functionArn });
    new cdk.CfnOutput(this, 'AiInvokerRoleArn', { value: aiInvoker.role!.roleArn });
    new cdk.CfnOutput(this, 'GuardrailId', { value: guardrail.attrGuardrailId });
    new cdk.CfnOutput(this, 'GuardrailVersion', { value: guardrail.attrVersion });
    new cdk.CfnOutput(this, 'DocGenGuardrailId', { value: docGenGuardrail.attrGuardrailId });
    new cdk.CfnOutput(this, 'DocGenGuardrailVersion', { value: docGenGuardrail.attrVersion });
    new cdk.CfnOutput(this, 'ArClauseGuardrailId', { value: arClauseGuardrail.attrGuardrailId });
    new cdk.CfnOutput(this, 'ArClauseGuardrailVersion', { value: arClauseGuardrail.attrVersion });
    new cdk.CfnOutput(this, 'ArAdvisoryGuardrailId', {
      value: arAdvisoryGuardrail.attrGuardrailId,
    });
    new cdk.CfnOutput(this, 'ArAdvisoryGuardrailVersion', {
      value: arAdvisoryGuardrail.attrVersion,
    });
    new cdk.CfnOutput(this, 'HitlStateMachineArn', { value: hitlStateMachine.stateMachineArn });

    new cdk.CfnOutput(this, 'DocStudioQueueUrl', { value: docStudioQueue.queueUrl });
    new cdk.CfnOutput(this, 'DocStudioQueueArn', { value: docStudioQueue.queueArn });
    new cdk.CfnOutput(this, 'DocStudioDlqArn', { value: docStudioDlq.queueArn });
    new cdk.CfnOutput(this, 'LeadAuditorQueueUrl', { value: leadAuditorQueue.queueUrl });
    new cdk.CfnOutput(this, 'LeadAuditorQueueArn', { value: leadAuditorQueue.queueArn });
    new cdk.CfnOutput(this, 'LeadAuditorDlqArn', { value: leadAuditorDlq.queueArn });
    new cdk.CfnOutput(this, 'ControlTowerQueueUrl', { value: controlTowerQueue.queueUrl });
    new cdk.CfnOutput(this, 'ControlTowerQueueArn', { value: controlTowerQueue.queueArn });
    new cdk.CfnOutput(this, 'ControlTowerDlqArn', { value: controlTowerDlq.queueArn });

    new cdk.CfnOutput(this, 'DocStudioRuleName', { value: docStudioRule.ruleName });
    new cdk.CfnOutput(this, 'LeadAuditorRuleName', { value: leadAuditorRule.ruleName });
    new cdk.CfnOutput(this, 'ControlTowerRuleName', { value: controlTowerRule.ruleName });
    new cdk.CfnOutput(this, 'CreditCapAlertTopicArn', { value: creditCapAlertTopic.topicArn });
    new cdk.CfnOutput(this, 'LegalLedgerCapRuleName', { value: capRule.ruleName });
    new cdk.CfnOutput(this, 'LegalLedgerDailyPaceAlarmName', {
      value: capDailyPaceAlarm.alarmName,
    });
    new cdk.CfnOutput(this, 'LegalLedgerBurnRateAlarmName', { value: capBurnRateAlarm.alarmName });

    // AOSS collection outputs (iso-kb imported from DataStack; others created here)
    const collectionArnByName: Record<string, string> = {
      'cumplify-iso-kb': props.isoKbCollectionArn,
      'cumplify-tenant-docs-kb': aossCollections['cumplify-tenant-docs-kb'].attrArn,
      'cumplify-nc-history': aossCollections['cumplify-nc-history'].attrArn,
    };
    for (const name of collectionNames) {
      const safeName = name.replace(/-/g, '');
      new cdk.CfnOutput(this, `${safeName}Endpoint`, { value: collectionEndpoints[name] });
      new cdk.CfnOutput(this, `${safeName}Arn`, { value: collectionArnByName[name] });
    }

    // ─── CDK Nag Suppressions ──────────────────────────────────────────────
    NagSuppressions.addResourceSuppressions(
      this,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason:
            'Lambda execution roles use AWSLambdaBasicExecutionRole (CDK-generated). ' +
            'Standard minimal policy for Lambda logging.',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'bedrock:InvokeModel requires Resource: * (AWS Bedrock constraint). ' +
            'Lambda log stream wildcard is CDK standard pattern.',
        },
        {
          id: 'AwsSolutions-L1',
          reason: 'Lambda uses NODEJS_22_X (latest LTS). CDK Nag may not recognize newer runtimes.',
        },
        {
          id: 'AwsSolutions-SF1',
          reason:
            'HITL state machine logging deferred to observability spec (spec 14). ' +
            'Non-blocking for functional correctness.',
        },
        {
          id: 'AwsSolutions-SF2',
          reason:
            'X-Ray tracing deferred to observability spec (spec 14). ' +
            'Non-blocking for functional correctness.',
        },
      ],
      true,
    );
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private createStdDlq(id: string): sqs.Queue {
    const dlq = new sqs.Queue(this, id, { enforceSSL: true });
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
