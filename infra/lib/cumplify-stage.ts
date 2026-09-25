/**
 * CumplifyStage — per-environment stage containing all stacks.
 * Stack ordering: Network → Security → Data → Identity (via addDependency).
 * Per design §1.3 (F-8 resolution).
 */

import * as cdk from 'aws-cdk-lib';
import { Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { Construct } from 'constructs';
import { type EnvConfig, DR_REGION, MGMT_ACCOUNT } from './env-config.js';
import { NetworkStack } from './network-stack.js';
import { SecurityStack } from './security-stack.js';
import { DataStack } from './data-stack.js';
import { IdentityStack } from './identity-stack.js';
import { DrRegionStack } from './dr-region-stack.js';
import { EventingStack } from './eventing-stack.js';
import { AuditTrailStack } from './audit-trail-stack.js';
import { ApiStack } from './api-stack.js';
import { AiStack } from './ai-stack.js';
import { FrontendStack } from './frontend-stack.js';

export interface CumplifyStageProps extends cdk.StageProps {
  readonly envConfig: EnvConfig;
}

export class CumplifyStage extends cdk.Stage {
  public readonly frontendDistributionDomainOutput: cdk.CfnOutput;
  public readonly graphqlApiUrlOutput: cdk.CfnOutput;
  public readonly poolBIdOutput: cdk.CfnOutput;
  public readonly poolBClientIdOutput: cdk.CfnOutput;
  public readonly frontendBucketNameOutput: cdk.CfnOutput;
  public readonly frontendDistributionIdOutput: cdk.CfnOutput;
  public readonly contentDeployRoleArnOutput: cdk.CfnOutput;

  constructor(scope: Construct, id: string, props: CumplifyStageProps) {
    super(scope, id, props);

    const { envConfig } = props;

    // GUARDRAIL: a workload stage must never target the management account.
    // mgmt hosts ONLY the pipeline; SCPs can't restrict mgmt, so this synth-time
    // check is the enforced control. Owner policy 2026-07-04. See env-config.ts
    // assertWorkloadAccountBoundary() + 06-cdk-conventions.md.
    if (envConfig.account === MGMT_ACCOUNT) {
      throw new Error(
        `CumplifyStage '${id}' resolves to the management account ${MGMT_ACCOUNT}. ` +
          `Application stacks must never deploy to mgmt — use dev/staging/prod.`,
      );
    }

    const networkStack = new NetworkStack(this, 'NetworkStack', { envConfig });

    const securityStack = new SecurityStack(this, 'SecurityStack', { envConfig });

    // DrRegionStack — prod-only, cross-region DR in us-west-2 (AC-1.8)
    // Must be created before DataStack to provide replica key + CRR destination ARNs.
    let drRegionStack: DrRegionStack | undefined;
    if (envConfig.drRegionStack) {
      drRegionStack = new DrRegionStack(this, 'DrRegionStack', {
        envConfig,
        primaryDynamodbKeyArn: securityStack.outputs.dynamodbKey.keyArn,
        env: { account: envConfig.account, region: DR_REGION },
      });
      drRegionStack.addDependency(securityStack);
    }

    const dataStack = new DataStack(this, 'DataStack', {
      envConfig,
      vpc: networkStack.vpc,
      aossVpcEndpointId: networkStack.aossVpcEndpointId,
      securityOutputs: securityStack.outputs,
      ...(drRegionStack
        ? {
            drReplicaKeyArn: drRegionStack.replicaKeyArn,
            crrDestinationBucketArn: drRegionStack.crrDestinationBucketArn,
          }
        : {}),
    });
    dataStack.addDependency(networkStack);
    dataStack.addDependency(securityStack);
    if (drRegionStack) {
      dataStack.addDependency(drRegionStack);
    }

    const identityStack = new IdentityStack(this, 'IdentityStack', {
      envConfig,
      tableName: dataStack.tableName,
    });
    identityStack.addDependency(dataStack);

    // EventingStack — depends on SecurityStack only for the shared ops-alert
    // topic that its DLQ alarms publish to.
    const eventingStack = new EventingStack(this, 'EventingStack', {
      envConfig,
      opsAlertTopic: securityStack.outputs.opsAlertTopic,
    });
    eventingStack.addDependency(securityStack);

    // AuditTrailStack — cross-stack deps: DataStack, SecurityStack, EventingStack.
    const auditTrailStack = new AuditTrailStack(this, 'AuditTrailStack', {
      envConfig,
      tableArn: dataStack.tableArn,
      tableName: dataStack.tableName,
      tableStreamArn: dataStack.tableStreamArn,
      dynamodbKey: securityStack.outputs.dynamodbKey,
      s3GeneralKey: securityStack.outputs.s3GeneralKey,
      auditSinkQueueArn: eventingStack.auditSinkQueueArn,
      auditSinkDlqUrl: eventingStack.auditSinkDlqUrl,
      auditSinkDlqArn: eventingStack.auditSinkDlqArn,
      opsAlertTopic: securityStack.outputs.opsAlertTopic,
    });
    auditTrailStack.addDependency(dataStack);
    auditTrailStack.addDependency(securityStack);
    auditTrailStack.addDependency(eventingStack);

    // ApiStack — AppSync GraphQL API for M1–M5 (spec 3: api-core)
    const apiStack = new ApiStack(this, 'ApiStack', {
      envConfig,
      tableArn: dataStack.tableArn,
      tableName: dataStack.tableName,
      dynamodbKey: securityStack.outputs.dynamodbKey,
      dbSecretKey: securityStack.outputs.secretsKey,
      clusterArn: dataStack.clusterArn,
      clusterEndpoint: dataStack.clusterEndpoint,
      dbSecretArn: dataStack.dbSecretArn,
      poolBId: identityStack.poolBId,
      poolBArn: identityStack.poolBArn,
      poolCId: identityStack.poolCId,
      poolCArn: identityStack.poolCArn,
      poolBClientId: identityStack.poolBClientId,
      poolCClientId: identityStack.poolCClientId,
      regionalWafArn: securityStack.outputs.regionalWaf.attrArn,
      busName: eventingStack.busName,
      busArn: eventingStack.busArn,
      generalBucketName: dataStack.generalBucketName,
      generalBucketArn: dataStack.generalBucketArn,
      s3GeneralKey: securityStack.outputs.s3GeneralKey,
      evidenceBucketName: dataStack.evidenceBucketName,
      evidenceBucketArn: dataStack.evidenceBucketArn,
    });
    apiStack.addDependency(dataStack);
    apiStack.addDependency(identityStack);
    apiStack.addDependency(securityStack);
    apiStack.addDependency(eventingStack);

    // AiStack — AI agents infrastructure (spec 4: agents-existing-8)
    const aiStack = new AiStack(this, 'AiStack', {
      envConfig,
      tableArn: dataStack.tableArn,
      tableName: dataStack.tableName,
      dynamodbKey: securityStack.outputs.dynamodbKey,
      clusterArn: dataStack.clusterArn,
      dbSecretArn: dataStack.dbSecretArn,
      dbSecretKey: securityStack.outputs.secretsKey,
      busName: eventingStack.busName,
      busArn: eventingStack.busArn,
      deliveryFailureDlqArn: eventingStack.deliveryFailureDlqArn,
      snsKey: securityStack.outputs.snsKey,
      capaIntakeQueueArn: eventingStack.capaIntakeQueueArn,
      capaIntakeDlqUrl: eventingStack.capaIntakeDlqUrl,
      auditSinkQueueArn: eventingStack.auditSinkQueueArn,
      recordsQueueArn: eventingStack.recordsQueueArn,
      recordsDlqUrl: eventingStack.recordsDlqUrl,
      tenantDocsIndexerQueueArn: eventingStack.tenantDocsIndexerQueueArn,
      tenantDocsIndexerDlqUrl: eventingStack.tenantDocsIndexerDlqUrl,
      aossVpcEndpointId: networkStack.aossVpcEndpointId,
      vpc: networkStack.vpc,
      privateSubnets: networkStack.privateSubnets,
      bedrockKeyArn: securityStack.outputs.bedrockKey.keyArn,
      appRoleSecretArn: apiStack.appRoleSecretArn,
      isoKbCollectionArn: dataStack.isoKbCollectionArn,
      isoKbCollectionEndpoint: dataStack.isoKbCollectionEndpoint,
      graphqlApiId: apiStack.graphqlApiId,
      graphqlApiUrl: apiStack.graphqlApiUrl,
      generalBucketName: dataStack.generalBucketName,
      generalBucketArn: dataStack.generalBucketArn,
      s3GeneralKey: securityStack.outputs.s3GeneralKey,
    });
    aiStack.addDependency(dataStack);
    aiStack.addDependency(apiStack);
    aiStack.addDependency(eventingStack);
    aiStack.addDependency(auditTrailStack);
    // RS-8 (2026-07-22, attempted then reverted): the original design tried
    // reversing this to apiStack.addDependency(aiStack) with both stacks
    // importing each other's NEW exports via Fn.importValue, so ApiStack's
    // m2/m5 resolvers could invoke CAPAGuru/RiskSentinel directly. That
    // deadlocked on the FIRST real deploy: whichever stack goes first
    // (per the single addDependency direction) looks up the OTHER's export
    // before it exists yet ("No export named cumplify-dev-graphql-api-id
    // found" — AiStack failed, cleanly rolled back, live evidence log has
    // the full incident). Fixed by NOT reversing this dependency at all —
    // CapaGuruFn/RiskSentinelFn get deterministic functionName props
    // instead (ai-stack.ts), and api-stack.ts constructs their ARNs via
    // formatArn (same proven no-cycle pattern already used here for
    // DocGenStateMachine/RegenerateSectionFn) — zero new cross-stack
    // references in either direction, so no ordering hazard exists.

    // FrontendStack — S3 + CloudFront for static SPA hosting (spec 5: frontend-app)
    const frontendStack = new FrontendStack(this, 'FrontendStack', {
      envConfig,
      apiUrl: apiStack.graphqlApiUrl,
      cloudfrontWafArn: securityStack.outputs.cloudfrontWaf.attrArn,
    });
    frontendStack.addDependency(apiStack);
    frontendStack.addDependency(securityStack);

    // Expose for pipeline SmokeTest (envFromCfnOutputs)
    this.frontendDistributionDomainOutput = frontendStack.distributionDomainOutput;

    // Expose for pipeline DeployFrontendContent step (envFromCfnOutputs, SMOKE-2 §2.3)
    this.graphqlApiUrlOutput = apiStack.graphqlApiUrlOutput;
    this.poolBIdOutput = identityStack.poolBIdOutput;
    this.poolBClientIdOutput = identityStack.poolBClientIdOutput;
    this.frontendBucketNameOutput = frontendStack.bucketNameOutput;
    this.frontendDistributionIdOutput = frontendStack.distributionIdOutput;
    this.contentDeployRoleArnOutput = frontendStack.contentDeployRoleArnOutput;

    // AC-1.6: CDK Nag also applied at stage level.
    // Required because CDK Pipelines stages are separate cloud assemblies —
    // App-level Aspects do not propagate into stage assemblies (verified:
    // Nag reports are only generated for PipelineStack when Aspect is at app
    // level alone; stage stacks produce no findings/reports without this).
    Aspects.of(this).add(new AwsSolutionsChecks({ verbose: true }));
  }
}
