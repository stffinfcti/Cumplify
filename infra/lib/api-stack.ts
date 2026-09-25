/**
 * ApiStack — AppSync GraphQL API for M1–M5.
 * Per spec: api-core (design R2, Tasks 7/8/9).
 *
 * Components:
 * - AppSync GraphQL API (AWS_LAMBDA default + AWS_IAM additional auth)
 * - Lambda authorizer (Pool B/C JWKS, Pool-A rejection, entitlement stamp)
 * - WAFv2 REGIONAL association
 * - Migration Custom Resource (executes SQL via Data API on deploy)
 * - app_role Secrets Manager secret (password-synced to DB role)
 * - Tenant-data IAM role (CARRY-1, created in Task 9)
 * - CfnOutputs for readback
 *
 * [REQUIRES-HUMAN] — authorizer code + IAM policies require owner review (C-2/AUTH-5).
 */

import * as cdk from 'aws-cdk-lib';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';
import { type EnvConfig } from './env-config.js';

export interface ApiStackProps extends cdk.StackProps {
  readonly envConfig: EnvConfig;
  // DataStack
  readonly tableArn: string;
  readonly tableName: string;
  readonly dynamodbKey: kms.IKey;
  readonly clusterArn: string;
  readonly clusterEndpoint: string;
  readonly dbSecretArn: string;
  readonly dbSecretKey: kms.IKey; // CMK encrypting the RDS master secret (secretsKey)
  // IdentityStack
  readonly poolBId: string;
  readonly poolBArn: string;
  readonly poolCId: string;
  readonly poolCArn: string;
  readonly poolBClientId: string;
  readonly poolCClientId: string;
  // SecurityStack
  readonly regionalWafArn: string;
  // EventingStack
  readonly busName: string;
  readonly busArn: string;
  // DataStack — S3 (spec 40 Task 7: diff reads document content from GeneralBucket)
  readonly generalBucketName: string;
  readonly generalBucketArn: string;
  readonly s3GeneralKey: kms.IKey;
  // DataStack — EvidenceVault (spec 40 Task 9: sealing on publishControlledDocument)
  readonly evidenceBucketName: string;
  readonly evidenceBucketArn: string;
}

export class ApiStack extends cdk.Stack {
  public readonly graphqlApiUrl: string;
  public readonly graphqlApiId: string;
  public readonly authorizerArn: string;
  public readonly tenantDataRoleArn: string;
  public readonly appRoleSecretArn: string;
  public readonly graphqlApiUrlOutput: cdk.CfnOutput;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const { envConfig } = props;

    // ─── app_role Secret (C-1 remediation) ─────────────────────────────────────
    // Password sync: secret is created with a generated password. The migrator
    // Custom Resource runs ALTER ROLE app_role PASSWORD '<value>' using the
    // master secret (DDL-capable) after migration 009 creates the role.
    // Resolvers use this secret for Data API calls (not master).
    //
    // FIX-5 NOTE: The ALTER ROLE password value transits Data API SQL text
    // (not parameterizable for DDL). This is acceptable because:
    // (a) CloudTrail data events for rds-data are NOT enabled in dev.
    // (b) The SQL is executed server-side; it does not appear in CloudWatch logs.
    // CARRY: Enable Secrets Manager single-user rotation (VPC-attached rotation
    // Lambda) to eliminate the plaintext-in-SQL path. Named follow-up for
    // prod hardening (requires VPC Lambda + rotation configuration).
    const appRoleSecret = new secretsmanager.Secret(this, 'AppRoleSecret', {
      secretName: `cumplify/${envConfig.envName}/rds/app-role`,
      description: 'RDS app_role credentials for resolver Data API access',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'app_role' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 32,
      },
      encryptionKey: props.dynamodbKey, // reuse secrets CMK (same key policy)
    });
    this.appRoleSecretArn = appRoleSecret.secretArn;

    // ─── Lambda Authorizer ───────────────────────────────────────────────────
    const authorizerFn = new NodejsFunction(this, 'AuthorizerFn', {
      entry: 'services/api/src/authorizer.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(10), // AppSync authorizer timeout limit
      bundling: { externalModules: [], target: 'node22' },
      environment: {
        POOL_B_ID: props.poolBId,
        POOL_C_ID: props.poolCId,
        POOL_B_CLIENT_IDS: props.poolBClientId, // FIX-1: audience validation
        POOL_C_CLIENT_IDS: props.poolCClientId, // FIX-1: audience validation
        TABLE_NAME: props.tableName,
        REGION: cdk.Stack.of(this).region,
        POWERTOOLS_SERVICE_NAME: 'api-authorizer',
      },
    });

    // Authorizer DDB policy (T-4): GetItem for tenant metadata reads.
    // Cannot use tenant-data role — no tenant context exists at auth time.
    // LeadingKeys 'TENANT#*' allows reading any tenant's metadata (the
    // authorizer needs to read the requesting tenant's plan/entitlement).
    authorizerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem'],
        resources: [props.tableArn],
        conditions: {
          'ForAllValues:StringLike': {
            'dynamodb:LeadingKeys': ['TENANT#*'],
          },
        },
      }),
    );

    // KMS decrypt for DynamoDB CMK (required for GetItem on encrypted table)
    props.dynamodbKey.grantDecrypt(authorizerFn);

    this.authorizerArn = authorizerFn.functionArn;

    // ─── AppSync GraphQL API ───────────────────────────────────────────────────
    const api = new appsync.GraphqlApi(this, 'CumplifyApi', {
      name: `cumplify-${envConfig.envName}-api`,
      definition: appsync.Definition.fromFile('services/api/schema/schema.graphql'),
      authorizationConfig: {
        defaultAuthorization: {
          authorizationType: appsync.AuthorizationType.LAMBDA,
          lambdaAuthorizerConfig: {
            handler: authorizerFn,
            // 60s: caps role/entitlement revocation lag at ~1 min. The dev
            // 300s carry (OQ-3) let a disabled user keep calling for 5 min.
            resultsCacheTtl: cdk.Duration.seconds(60),
          },
        },
        additionalAuthorizationModes: [{ authorizationType: appsync.AuthorizationType.IAM }],
      },
      xrayEnabled: true,
      logConfig: {
        fieldLogLevel: appsync.FieldLogLevel.ALL,
        excludeVerboseContent: true, // FIX-2: prevents JWTs/headers/resolverContext in CloudWatch
      },
    });

    this.graphqlApiUrl = api.graphqlUrl;
    this.graphqlApiId = api.apiId;

    // ─── WAFv2 Association ───────────────────────────────────────────────────
    new wafv2.CfnWebACLAssociation(this, 'WafAssociation', {
      resourceArn: api.arn,
      webAclArn: props.regionalWafArn,
    });

    // ─── Migration Custom Resource ───────────────────────────────────────────
    // Executes SQL migrations via Data API on every deploy (Create/Update).
    // Uses MASTER secret (DDL-capable). Also syncs app_role password.
    const migratorFn = new NodejsFunction(this, 'MigratorFn', {
      entry: 'services/api/src/migrator.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.minutes(5), // migrations may take time on first run
      bundling: {
        externalModules: [],
        target: 'node22',
        // Bundle the migrations directory alongside the handler
        commandHooks: {
          beforeBundling: () => [],
          afterBundling: (inputDir: string, outputDir: string) => [
            `cp -r ${inputDir}/services/api/migrations ${outputDir}/migrations`,
          ],
          beforeInstall: () => [],
        },
      },
      environment: {
        CLUSTER_ARN: props.clusterArn,
        SECRET_ARN: props.dbSecretArn, // master secret for DDL
        APP_ROLE_SECRET_ARN: appRoleSecret.secretArn,
        DATABASE: 'postgres',
        POWERTOOLS_SERVICE_NAME: 'migrator',
      },
    });

    // Migrator needs rds-data:* on the cluster + secrets read
    migratorFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'rds-data:ExecuteStatement',
          'rds-data:BeginTransaction',
          'rds-data:CommitTransaction',
          'rds-data:RollbackTransaction',
          'rds-data:BatchExecuteStatement',
        ],
        resources: [props.clusterArn],
      }),
    );

    // Read master secret + app_role secret (for password sync)
    migratorFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [props.dbSecretArn, appRoleSecret.secretArn],
      }),
    );

    // KMS decrypt for secrets + DDB.
    // dynamodbKey encrypts the app_role secret; dbSecretKey (secretsKey) encrypts
    // the RDS MASTER secret — the migrator reads BOTH (master for DDL, app_role for
    // the password sync), so it needs decrypt on both keys. Data API fails with
    // "Access to KMS is not allowed" without the master-secret key grant.
    props.dynamodbKey.grantDecrypt(migratorFn);
    props.dbSecretKey.grantDecrypt(migratorFn);

    const migratorProvider = new cr.Provider(this, 'MigratorProvider', {
      onEventHandler: migratorFn,
    });

    // NAG: Custom Resource provider role uses lambda:InvokeFunction on <handlerArn>:*
    NagSuppressions.addResourceSuppressions(
      migratorProvider,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'CDK Custom Resource Provider service role invokes the handler Lambda with ' +
            'lambda:InvokeFunction on <fnArn>:*. CDK-generated, cannot scope further.',
          appliesTo: [{ regex: '/^Resource::.*\\*$/g' }],
        },
        {
          id: 'AwsSolutions-IAM4',
          reason: 'Custom Resource framework Lambda uses AWSLambdaBasicExecutionRole.',
        },
        {
          id: 'AwsSolutions-L1',
          reason: 'Custom Resource framework Lambda runtime is CDK-managed.',
        },
      ],
      true,
    );

    new cdk.CustomResource(this, 'MigrationResource', {
      serviceToken: migratorProvider.serviceToken,
      properties: {
        // Force re-run on every deploy by including a timestamp
        deployTimestamp: Date.now().toString(),
      },
    });

    // ─── Resolver Lambdas (M1–M5) ─────────────────────────────────────────────
    // One Lambda per module. Task 10 implements the handler logic.
    const resolverModules = ['m1', 'm2', 'm3', 'm4', 'm5'] as const;
    const resolverFns: NodejsFunction[] = [];

    for (const mod of resolverModules) {
      const fn = new NodejsFunction(this, `Resolver${mod.toUpperCase()}Fn`, {
        entry: `services/api/src/resolvers/${mod}.ts`,
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 512,
        timeout: cdk.Duration.seconds(30), // Aurora resume budget
        bundling: { externalModules: [], target: 'node22' },
        environment: {
          CLUSTER_ARN: props.clusterArn,
          APP_ROLE_SECRET_ARN: appRoleSecret.secretArn, // C-1: app_role, NOT master
          TABLE_NAME: props.tableName,
          BUS_NAME: props.busName,
          REGION: cdk.Stack.of(this).region,
          POWERTOOLS_SERVICE_NAME: `resolver-${mod}`,
        },
      });

      // Data API access for resolvers (using app_role secret)
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: [
            'rds-data:ExecuteStatement',
            'rds-data:BeginTransaction',
            'rds-data:CommitTransaction',
            'rds-data:RollbackTransaction',
          ],
          resources: [props.clusterArn],
        }),
      );

      // Read app_role secret
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['secretsmanager:GetSecretValue'],
          resources: [appRoleSecret.secretArn],
        }),
      );

      // EventBridge publish (for audit events)
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['events:PutEvents'],
          resources: [props.busArn],
        }),
      );

      // KMS decrypt for secrets + DDB
      props.dynamodbKey.grantDecrypt(fn);

      resolverFns.push(fn);
    }

    // ─── RS-8: runCapaAnalysis/runRiskAssessment invoke plane ───────────────
    // m2 (index 1) and m5 (index 4) synchronously fetch RDS context then
    // async-invoke CAPAGuru/RiskSentinel (AiStack) to propose via HITL.
    // Deterministic-name ARN construction (same no-cycle pattern as
    // DocGenStateMachine/RegenerateSectionFn below: AiStack depends on
    // ApiStack, not the other way — an earlier attempt at Fn.importValue in
    // BOTH directions simultaneously deadlocked on first deploy, since
    // whichever stack deploys first would look up an export the OTHER
    // hasn't created yet. formatArn needs no export/import at all — the
    // ARN is derivable from the name alone, matching AiStack's
    // `functionName: cumplify-capa-guru-${env}` / `cumplify-risk-sentinel-
    // ${env}`). Same-account Lambda:InvokeFunction only needs the CALLER'S
    // identity-based policy — no resource policy needed on the target.
    const capaGuruFnArn = cdk.Stack.of(this).formatArn({
      service: 'lambda',
      resource: 'function',
      resourceName: `cumplify-capa-guru-${envConfig.envName}`,
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    });
    const riskSentinelFnArn = cdk.Stack.of(this).formatArn({
      service: 'lambda',
      resource: 'function',
      resourceName: `cumplify-risk-sentinel-${envConfig.envName}`,
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    });
    // S2 (studio wave): m1's runDocDraft dispatches DocStudio the same way.
    const docStudioFnArn = cdk.Stack.of(this).formatArn({
      service: 'lambda',
      resource: 'function',
      resourceName: `cumplify-doc-studio-${envConfig.envName}`,
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    });
    resolverFns[0].addEnvironment('DOC_STUDIO_FN_ARN', docStudioFnArn);
    resolverFns[0].addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['lambda:InvokeFunction'],
        resources: [docStudioFnArn],
      }),
    );
    resolverFns[1].addEnvironment('CAPA_GURU_FN_ARN', capaGuruFnArn);
    resolverFns[1].addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [capaGuruFnArn],
      }),
    );
    // S4 (Audit Studio): m3's runAuditFindings dispatches LeadAuditor the
    // same way (deterministic name, no-cycle pattern).
    const leadAuditorFnArn = cdk.Stack.of(this).formatArn({
      service: 'lambda',
      resource: 'function',
      resourceName: `cumplify-lead-auditor-${envConfig.envName}`,
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    });
    resolverFns[2].addEnvironment('LEAD_AUDITOR_FN_ARN', leadAuditorFnArn);
    resolverFns[2].addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['lambda:InvokeFunction'],
        resources: [leadAuditorFnArn],
      }),
    );
    resolverFns[4].addEnvironment('RISK_SENTINEL_FN_ARN', riskSentinelFnArn);
    resolverFns[4].addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [riskSentinelFnArn],
      }),
    );

    // ─── Tenant-Data Role (Task 9 — CARRY-1) ────────────────────────────────
    // Trust: resolver execution roles + sts:TagSession (bare-tenantId session tag, FF-3).
    // Policy: DDB LeadingKeys condition wraps TENANT#${aws:PrincipalTag/tenantId}#*.
    // GSI grant included: all 9 GSIs use TENANT#-prefixed partition keys (FF-5 design constraint).
    // TRUST REWRITE (2026-07-11, owner re-sign): the per-principal enumeration
    // (one ArnPrincipal per resolver role) reached 1981 of the 2048-byte
    // ACLSizePerRole quota with 5 roles; adding spec-9's 3 functions failed the
    // deploy, and every future module spec adds more. Compact, scalable form:
    // account principal gated by an aws:PrincipalArn pattern. TWO-KEY MODEL —
    // matching the pattern is necessary but NOT sufficient: the caller's own
    // identity policy must ALSO grant sts:AssumeRole on this role, and only
    // the resolver/HITL/profile functions receive that grant (loops below).
    // FF-3 tenantId-tag requirement and the FIX-4 '#'-injection DENY are
    // preserved verbatim in effect.
    const tenantDataRole = new iam.Role(this, 'TenantDataRole', {
      roleName: `cumplify-${envConfig.envName}-tenant-data-role`,
      assumedBy: new iam.SessionTagsPrincipal(
        new iam.PrincipalWithConditions(new iam.AccountRootPrincipal(), {
          StringLike: {
            'aws:PrincipalArn': `arn:aws:iam::${cdk.Stack.of(this).account}:role/${cdk.Stack.of(this).stackName}-*`,
            // Bare tenantId = UUID format; NOT TENANT#-prefixed (FF-3)
            'aws:RequestTag/tenantId': '*',
          },
        }),
      ),
      description: 'Tenant-scoped DDB role assumed per-request with tenantId session tag (CARRY-1)',
    });

    // FIX-4: DENY any tag value containing '#' — prevents TENANT#-prefixed injection
    // that would bypass LeadingKeys matching (applies to every caller).
    tenantDataRole.assumeRolePolicy!.addStatements(
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        actions: ['sts:TagSession'],
        principals: [new iam.AnyPrincipal()],
        conditions: {
          StringLike: {
            'aws:RequestTag/tenantId': '*#*',
          },
        },
      }),
      // '*' and '?' are IAM wildcard chars: a session tag containing them turns
      // the verbatim-substituted LeadingKeys pattern `TENANT#<tag>#*` into a
      // match-every-tenant selector. `${*}`/`${?}` are the IAM literal-char
      // escapes — the array is OR'd.
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        actions: ['sts:TagSession'],
        principals: [new iam.AnyPrincipal()],
        conditions: {
          StringLike: {
            'aws:RequestTag/tenantId': ['*${*}*', '*${?}*'],
          },
        },
      }),
    );

    // Inline policy: DDB actions with LeadingKeys condition
    tenantDataRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:Query',
          // TransactWriteItems deliberately absent: LeadingKeys is not
          // evaluated for transactions (with ForAllValues an absent key
          // passes true), so a transaction grant would be an unscoped
          // cross-tenant write door.
        ],
        resources: [
          props.tableArn,
          // GSI grant — all 9 GSIs are TENANT#-prefixed by design constraint (FF-5).
          // Cross-tenant GSI query denial proven at ACC-2 Task 14 GSI probe.
          // DO NOT sign CARRY-1 green until that probe shows cross-tenant = denied.
          `${props.tableArn}/index/*`,
        ],
        conditions: {
          'ForAllValues:StringLike': {
            'dynamodb:LeadingKeys': ['TENANT#${aws:PrincipalTag/tenantId}#*'],
          },
        },
      }),
    );

    // UpdateItem pinned to the caller-tenant's HITL partition ONLY (exact
    // LeadingKeys, no wildcard tail) — the approval Lambda's PENDING→RESOLVING
    // guard and resolveHitlItem bookkeeping both write PK TENANT#<t>#HITL.
    // Deliberately NOT added to the statement above: a tenant-wide UpdateItem
    // would open a same-tenant AUDITLOG modify surface (BUG-14 fix, ACC-3).
    tenantDataRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:UpdateItem'],
        resources: [props.tableArn],
        conditions: {
          'ForAllValues:StringLike': {
            'dynamodb:LeadingKeys': ['TENANT#${aws:PrincipalTag/tenantId}#HITL'],
          },
        },
      }),
    );

    // KMS decrypt for DDB CMK (required for GetItem/PutItem on encrypted table)
    props.dynamodbKey.grantDecrypt(tenantDataRole);

    this.tenantDataRoleArn = tenantDataRole.roleArn;

    // Export tenant-data role ARN to resolver environment
    for (const fn of resolverFns) {
      fn.addEnvironment('TENANT_DATA_ROLE_ARN', tenantDataRole.roleArn);
    }

    // ─── STS AssumeRole grant for resolvers → tenant-data role ───────────────
    for (const fn of resolverFns) {
      fn.role!.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ['sts:AssumeRole', 'sts:TagSession'],
          resources: [tenantDataRole.roleArn],
        }),
      );
    }

    // ─── AppSync Data Sources & Resolver Attachments (BLOCK-1) ────────────────

    // M1 resolver needs S3 read for getDocumentVersionDiff (spec 40, Task 7)
    // AND write for saveDocumentSectionEdit's new-version ContentJson (RS-9)
    // — found live 2026-07-22 at the D1 witness: the mutation shipped with
    // tests but zero callers, so the missing PutObject grant was invisible
    // until the first real Save click (AccessDenied).
    resolverFns[0].addEnvironment('CONTENT_BUCKET', props.generalBucketName);
    resolverFns[0].addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:PutObject'],
        resources: [`${props.generalBucketArn}/tenants/*`],
      }),
    );
    props.s3GeneralKey.grantEncryptDecrypt(resolverFns[0]);

    // ─── Spec 40 Task 9: PDF render + IMS export + sealing ───────────────────
    // PdfRenderFn: puppeteer-core + @sparticuz/chromium. X86_64 ONLY — the
    // sparticuz chromium build is not ARM; this function alone diverges from
    // the repo's ARM default (design §5, documented). Chromium ships via
    // bundling.nodeModules (installed into the asset's node_modules — the
    // binary must stay a real file, never esbuild-bundled).
    const pdfRenderFn = new NodejsFunction(this, 'PdfRenderFn', {
      entry: 'services/pdf-export/src/render.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.X86_64,
      memorySize: 2048,
      timeout: cdk.Duration.seconds(120),
      bundling: {
        externalModules: [],
        target: 'node22',
        nodeModules: ['@sparticuz/chromium', 'puppeteer-core'],
      },
      environment: {
        CONTENT_BUCKET: props.generalBucketName,
        POWERTOOLS_SERVICE_NAME: 'pdf-render',
      },
    });
    pdfRenderFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:PutObject'],
        resources: [`${props.generalBucketArn}/tenants/*`],
      }),
    );
    props.s3GeneralKey.grantEncryptDecrypt(pdfRenderFn);

    // ExportFn (STO-4): assembles the IMS ZIP + presigned URL. No chromium —
    // stays on the ARM default. Invoked by QmsFn's requestImsExport case.
    const exportFn = new NodejsFunction(this, 'ExportFn', {
      entry: 'services/pdf-export/src/export.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 1024,
      timeout: cdk.Duration.seconds(60),
      bundling: { externalModules: [], target: 'node22' },
      environment: {
        CONTENT_BUCKET: props.generalBucketName,
        PDF_RENDER_FN: pdfRenderFn.functionName,
        POWERTOOLS_SERVICE_NAME: 'ims-export',
      },
    });
    exportFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:PutObject'],
        resources: [`${props.generalBucketArn}/tenants/*`],
      }),
    );
    props.s3GeneralKey.grantEncryptDecrypt(exportFn);
    pdfRenderFn.grantInvoke(exportFn);

    // M1 sealing (STO-5): render final PDF + CopyObject → EvidenceVault with
    // per-object ObjectLockRetainUntilDate (BC-10: bucket default = safety
    // net only). Source-side s3:GetObject on GeneralBucket already granted
    // above (Task 7); EvidenceVault shares s3GeneralKey, so grantEncrypt
    // covers the destination write.
    resolverFns[0].addEnvironment('EVIDENCE_BUCKET', props.evidenceBucketName);
    resolverFns[0].addEnvironment('EVIDENCE_LOCK_MODE', envConfig.evidenceRetentionMode);
    resolverFns[0].addEnvironment('PDF_RENDER_FN', pdfRenderFn.functionName);
    resolverFns[0].addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject', 's3:PutObjectRetention'],
        resources: [`${props.evidenceBucketArn}/tenants/*`],
      }),
    );
    props.s3GeneralKey.grantEncrypt(resolverFns[0]);
    pdfRenderFn.grantInvoke(resolverFns[0]);

    // ─── Billing resolver (Stripe Customer Portal) ────────────────────────────
    // Standalone Lambda, NOT VPC-placed on purpose: the zero-NAT VPC has no
    // egress to api.stripe.com, so this fn runs outside the VPC and reaches
    // Stripe over the default managed egress (rds-data/Secrets Manager are
    // public AWS endpoints, so nothing here needs the VPC). Reads the Stripe
    // secret (key + portal config + tenant→customer map) at runtime.
    const stripeSecretName = `cumplify/${envConfig.envName}/stripe`;
    const billingFn = new NodejsFunction(this, 'BillingFn', {
      entry: 'services/api/src/resolvers/billing.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(15),
      bundling: { externalModules: [], target: 'node22' },
      environment: {
        STRIPE_SECRET_NAME: stripeSecretName,
        POWERTOOLS_SERVICE_NAME: 'resolver-billing',
      },
    });
    // Scoped to ONLY the Stripe secret — read + write (the resolver writes back
    // new tenant→customer mappings so repeat portal calls reuse the Stripe
    // customer instead of duplicating it). The secret uses the default
    // AWS-managed KMS key (no CMK), so no extra kms grant is needed. It is
    // provisioned out-of-band per env (cumplify/<env>/stripe); if absent in
    // an env the resolver throws STRIPE_NOT_CONFIGURED (billing stays inert).
    const stripeSecret = secretsmanager.Secret.fromSecretNameV2(this, 'StripeSecret', stripeSecretName);
    stripeSecret.grantRead(billingFn);
    // persistCustomerMapping needs only PutSecretValue — grantWrite would also
    // allow RotateSecret/UpdateSecret/CancelRotation on the shared Stripe key.
    billingFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:PutSecretValue'],
        resources: [stripeSecret.secretArn],
      }),
    );

    // Lambda data sources — one per module
    const m1DS = api.addLambdaDataSource('M1DataSource', resolverFns[0]);
    const m2DS = api.addLambdaDataSource('M2DataSource', resolverFns[1]);
    const m3DS = api.addLambdaDataSource('M3DataSource', resolverFns[2]);
    const m4DS = api.addLambdaDataSource('M4DataSource', resolverFns[3]);
    const m5DS = api.addLambdaDataSource('M5DataSource', resolverFns[4]);

    // Billing data source (Stripe Customer Portal — standalone fn, not a module)
    const billingDS = api.addLambdaDataSource('BillingDataSource', billingFn);

    // None data source — for subscription publish mutations AND subscription resolvers
    const noneDS = api.addNoneDataSource('NoneDataSource');

    // ─── Query resolvers ─────────────────────────────────────────────────────
    // M1
    m1DS.createResolver('GetDocument', { typeName: 'Query', fieldName: 'getDocument' });
    m1DS.createResolver('ListDocuments', { typeName: 'Query', fieldName: 'listDocuments' });
    // New field 2026-07-13 (frontend-app Phase C read surface) — MUST carry the
    // schema dependency below, or CFN races the schema update (BUG at 9d9c90a1).
    const listDocVersionsResolver = m1DS.createResolver('ListDocumentVersions', {
      typeName: 'Query',
      fieldName: 'listDocumentVersions',
    });
    m1DS.createResolver('GetDocumentVersionDiff', {
      typeName: 'Query',
      fieldName: 'getDocumentVersionDiff',
    });
    // New field 2026-07-15 (spec-40 Task 11 viewer read surface)
    const getDocumentContentResolver = m1DS.createResolver('GetDocumentContent', {
      typeName: 'Query',
      fieldName: 'getDocumentContent',
    });
    // M2
    m2DS.createResolver('GetNonconformity', { typeName: 'Query', fieldName: 'getNonconformity' });
    const listNcResolver = m2DS.createResolver('ListNonconformities', {
      typeName: 'Query',
      fieldName: 'listNonconformities',
    });
    m2DS.createResolver('ListOpenCAPAs', { typeName: 'Query', fieldName: 'listOpenCAPAs' });
    const listCaResolver = m2DS.createResolver('ListCorrectiveActions', {
      typeName: 'Query',
      fieldName: 'listCorrectiveActions',
    });
    // M3
    m3DS.createResolver('GetAudit', { typeName: 'Query', fieldName: 'getAudit' });
    // S4 (Audit Studio) — register + per-audit reads + LeadAuditor dispatch.
    const listAuditsResolver = m3DS.createResolver('ListAudits', {
      typeName: 'Query',
      fieldName: 'listAudits',
    });
    const listAuditFindingsResolver = m3DS.createResolver('ListAuditFindings', {
      typeName: 'Query',
      fieldName: 'listAuditFindings',
    });
    const listAuditChecklistsResolver = m3DS.createResolver('ListAuditChecklists', {
      typeName: 'Query',
      fieldName: 'listAuditChecklists',
    });
    const runAuditFindingsResolver = m3DS.createResolver('RunAuditFindings', {
      typeName: 'Mutation',
      fieldName: 'runAuditFindings',
    });
    m3DS.createResolver('GetAuditReadiness', { typeName: 'Query', fieldName: 'getAuditReadiness' });
    // M4
    m4DS.createResolver('GetRecord', { typeName: 'Query', fieldName: 'getRecord' });
    m4DS.createResolver('ListCalibrationsDue', {
      typeName: 'Query',
      fieldName: 'listCalibrationsDue',
    });
    m4DS.createResolver('GetAuditTrail', { typeName: 'Query', fieldName: 'getAuditTrail' });
    // M5
    m5DS.createResolver('GetRisk', { typeName: 'Query', fieldName: 'getRisk' });
    m5DS.createResolver('GetCrossRegisterRiskView', {
      typeName: 'Query',
      fieldName: 'getCrossRegisterRiskView',
    });

    // ─── Mutation resolvers (user-facing, @aws_lambda) ───────────────────────
    // M1
    m1DS.createResolver('CreateDocumentDraft', {
      typeName: 'Mutation',
      fieldName: 'createDocumentDraft',
    });
    m1DS.createResolver('SubmitDocumentForApproval', {
      typeName: 'Mutation',
      fieldName: 'submitDocumentForApproval',
    });
    m1DS.createResolver('ApproveDocumentVersion', {
      typeName: 'Mutation',
      fieldName: 'approveDocumentVersion',
    });
    m1DS.createResolver('PublishControlledDocument', {
      typeName: 'Mutation',
      fieldName: 'publishControlledDocument',
    });
    m1DS.createResolver('UpdatePolicy', { typeName: 'Mutation', fieldName: 'updatePolicy' });
    m1DS.createResolver('UpdateImsScope', { typeName: 'Mutation', fieldName: 'updateImsScope' });
    // RS-9 (Collaboration Law persistence) — new field, needs the schema
    // node dependency below (9d9c90a1 lesson).
    const saveDocumentSectionEditResolver = m1DS.createResolver('SaveDocumentSectionEdit', {
      typeName: 'Mutation',
      fieldName: 'saveDocumentSectionEdit',
    });
    // M2
    m2DS.createResolver('RaiseNonconformity', {
      typeName: 'Mutation',
      fieldName: 'raiseNonconformity',
    });
    m2DS.createResolver('RecordRootCause', { typeName: 'Mutation', fieldName: 'recordRootCause' });
    m2DS.createResolver('CreateCorrectiveAction', {
      typeName: 'Mutation',
      fieldName: 'createCorrectiveAction',
    });
    m2DS.createResolver('CloseCapa', { typeName: 'Mutation', fieldName: 'closeCapa' });
    m2DS.createResolver('VerifyEffectiveness', {
      typeName: 'Mutation',
      fieldName: 'verifyEffectiveness',
    });
    m2DS.createResolver('DisposeNonconformingOutput', {
      typeName: 'Mutation',
      fieldName: 'disposeNonconformingOutput',
    });
    // RS-8 — new field, needs the schema node dependency below (9d9c90a1 lesson).
    const runCapaAnalysisResolver = m2DS.createResolver('RunCapaAnalysis', {
      typeName: 'Mutation',
      fieldName: 'runCapaAnalysis',
    });
    // S1 (studio wave) — stage-1 intake dispatch, same m2 DS + invoke grant.
    const runNcIntakeResolver = m2DS.createResolver('RunNcIntake', {
      typeName: 'Mutation',
      fieldName: 'runNcIntake',
    });
    // C1 (CAPA Studio RCA) — 5 Whys / Ishikawa / FTA via CAPAGuru + read surface.
    const runRcaResolver = m2DS.createResolver('RunRootCauseAnalysis', {
      typeName: 'Mutation',
      fieldName: 'runRootCauseAnalysis',
    });
    const listRcaResolver = m2DS.createResolver('ListRootCauseAnalyses', {
      typeName: 'Query',
      fieldName: 'listRootCauseAnalyses',
    });
    // S2 (studio wave) — Document Studio drafting dispatch on m1 DS.
    const runDocDraftResolver = m1DS.createResolver('RunDocDraft', {
      typeName: 'Mutation',
      fieldName: 'runDocDraft',
    });
    // M3
    m3DS.createResolver('CreateAuditProgramme', {
      typeName: 'Mutation',
      fieldName: 'createAuditProgramme',
    });
    m3DS.createResolver('ScheduleAudit', { typeName: 'Mutation', fieldName: 'scheduleAudit' });
    m3DS.createResolver('RecordFinding', { typeName: 'Mutation', fieldName: 'recordFinding' });
    m3DS.createResolver('CompleteAudit', { typeName: 'Mutation', fieldName: 'completeAudit' });
    m3DS.createResolver('GenerateAuditChecklist', {
      typeName: 'Mutation',
      fieldName: 'generateAuditChecklist',
    });
    // M4
    m4DS.createResolver('RegisterRecord', { typeName: 'Mutation', fieldName: 'registerRecord' });
    // New field 2026-07-14 (architect follow-up, M4 calibration unblock) — MUST
    // carry the schema dependency below (9d9c90a1 lesson).
    const registerMeasuringResourceResolver = m4DS.createResolver('RegisterMeasuringResource', {
      typeName: 'Mutation',
      fieldName: 'registerMeasuringResource',
    });
    m4DS.createResolver('RecordCalibration', {
      typeName: 'Mutation',
      fieldName: 'recordCalibration',
    });
    m4DS.createResolver('CreateRetentionPolicy', {
      typeName: 'Mutation',
      fieldName: 'createRetentionPolicy',
    });
    // RS-6 approval matrix (governance items; tenant-data role's TENANT#<id>#*
    // session policy already covers the GOVERNANCE partition)
    const listApprovalMatrixResolver = m4DS.createResolver('ListApprovalMatrix', {
      typeName: 'Query',
      fieldName: 'listApprovalMatrix',
    });
    const setApprovalMatrixEntryResolver = m4DS.createResolver('SetApprovalMatrixEntry', {
      typeName: 'Mutation',
      fieldName: 'setApprovalMatrixEntry',
    });
    // M5
    m5DS.createResolver('CreateRisk', { typeName: 'Mutation', fieldName: 'createRisk' });
    m5DS.createResolver('AddRiskTreatment', {
      typeName: 'Mutation',
      fieldName: 'addRiskTreatment',
    });
    m5DS.createResolver('CreateChangePlan', {
      typeName: 'Mutation',
      fieldName: 'createChangePlan',
    });
    // RS-8 — new field, needs the schema node dependency below (9d9c90a1 lesson).
    const runRiskAssessmentResolver = m5DS.createResolver('RunRiskAssessment', {
      typeName: 'Mutation',
      fieldName: 'runRiskAssessment',
    });

    // Billing — new field, needs the schema node dependency below (9d9c90a1 lesson).
    const createBillingPortalSessionResolver = billingDS.createResolver('CreateBillingPortalSession', {
      typeName: 'Mutation',
      fieldName: 'createBillingPortalSession',
    });

    // ─── Mutation resolvers (agent-path, @aws_iam) ───────────────────────────
    m1DS.createResolver('AgentDraftDocument', {
      typeName: 'Mutation',
      fieldName: 'agentDraftDocument',
    });
    m2DS.createResolver('AgentTriageNC', { typeName: 'Mutation', fieldName: 'agentTriageNC' });
    m2DS.createResolver('AgentProposeCorrectiveAction', {
      typeName: 'Mutation',
      fieldName: 'agentProposeCorrectiveAction',
    });
    m3DS.createResolver('AgentGenerateChecklist', {
      typeName: 'Mutation',
      fieldName: 'agentGenerateChecklist',
    });
    m3DS.createResolver('AgentScoreReadiness', {
      typeName: 'Mutation',
      fieldName: 'agentScoreReadiness',
    });
    m5DS.createResolver('AgentAssessRisk', { typeName: 'Mutation', fieldName: 'agentAssessRisk' });
    // appendAuditEvent REMOVED 2026-07-16 (owner-approved): the field+resolver
    // shipped with no m4.ts handler case and zero callers — every call threw
    // 'Unknown field'. Agents publish audit events via the eventing publisher.

    // ─── Subscription publish mutations (None data source, passthrough) ──────
    const passthroughRequestMapping = appsync.MappingTemplate.fromString(
      '{"version":"2017-02-28","payload":$util.toJson($context.arguments.input)}',
    );
    const passthroughResponseMapping = appsync.MappingTemplate.fromString(
      '$util.toJson($context.result)',
    );

    noneDS.createResolver('PublishDocumentEvent', {
      typeName: 'Mutation',
      fieldName: 'publishDocumentEvent',
      requestMappingTemplate: passthroughRequestMapping,
      responseMappingTemplate: passthroughResponseMapping,
    });
    noneDS.createResolver('PublishCAPAEvent', {
      typeName: 'Mutation',
      fieldName: 'publishCAPAEvent',
      requestMappingTemplate: passthroughRequestMapping,
      responseMappingTemplate: passthroughResponseMapping,
    });
    noneDS.createResolver('PublishAuditEventTrigger', {
      typeName: 'Mutation',
      fieldName: 'publishAuditEvent',
      requestMappingTemplate: passthroughRequestMapping,
      responseMappingTemplate: passthroughResponseMapping,
    });
    noneDS.createResolver('PublishRiskEvent', {
      typeName: 'Mutation',
      fieldName: 'publishRiskEvent',
      requestMappingTemplate: passthroughRequestMapping,
      responseMappingTemplate: passthroughResponseMapping,
    });

    // ─── Subscription resolvers (C-6: tenant-claim enforcement) ──────────────
    // The Lambda authorizer authorizes the CONNECTION but cannot compare field
    // args to the caller's claim. These resolvers enforce C-6 at the field level:
    // a subscriber whose resolverContext.tenantId != the subscription's tenantId
    // argument is rejected with $util.unauthorized().
    const subscriptionRequestTemplate = appsync.MappingTemplate.fromString(
      `#if($ctx.identity.resolverContext.tenantId != $ctx.args.tenantId)
  $util.unauthorized()
#end
{"version":"2017-02-28","payload":{}}`,
    );
    const subscriptionResponseTemplate = appsync.MappingTemplate.fromString('$util.toJson(null)');

    const subscriptionFields = [
      'onDocumentStatusChanged',
      'onCAPAStatusChanged',
      'onFindingRecorded',
      'onCalibrationDue',
      'onRiskEscalated',
      'onGenerationProgress', // Spec 40 Task 7 — C-6 tenantId auth, same pattern
    ];

    for (const field of subscriptionFields) {
      noneDS.createResolver(`Sub${field}`, {
        typeName: 'Subscription',
        fieldName: field,
        requestMappingTemplate: subscriptionRequestTemplate,
        responseMappingTemplate: subscriptionResponseTemplate,
      });
    }

    // ─── Spec 9 (frontend-app): HITL + Profile Resolvers ──────────────────────

    // HITL Approval Lambda — owns approveHitlItem mutation
    const hitlApprovalFn = new NodejsFunction(this, 'HitlApprovalFn', {
      entry: 'services/api/src/resolvers/hitl-approval.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      bundling: { externalModules: [], target: 'node22' },
      environment: {
        TABLE_NAME: props.tableName,
        BUS_NAME: props.busName,
        TENANT_DATA_ROLE_ARN: tenantDataRole.roleArn,
        REGION: cdk.Stack.of(this).region,
        POWERTOOLS_SERVICE_NAME: 'resolver-hitl-approval',
      },
    });

    // HITL Query Lambda — owns listPendingHitlItems query
    const hitlQueryFn = new NodejsFunction(this, 'HitlQueryFn', {
      entry: 'services/api/src/resolvers/hitl-query.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      bundling: { externalModules: [], target: 'node22' },
      environment: {
        TABLE_NAME: props.tableName,
        BUS_NAME: props.busName,
        TENANT_DATA_ROLE_ARN: tenantDataRole.roleArn,
        REGION: cdk.Stack.of(this).region,
        POWERTOOLS_SERVICE_NAME: 'resolver-hitl-query',
      },
    });

    // Profile Lambda — owns getProfile + updateProfile
    const profileFn = new NodejsFunction(this, 'ProfileFn', {
      entry: 'services/api/src/resolvers/profile.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      bundling: { externalModules: [], target: 'node22' },
      environment: {
        TABLE_NAME: props.tableName,
        BUS_NAME: props.busName,
        TENANT_DATA_ROLE_ARN: tenantDataRole.roleArn,
        REGION: cdk.Stack.of(this).region,
        POWERTOOLS_SERVICE_NAME: 'resolver-profile',
      },
    });

    // IAM: all 3 new Lambdas need STS AssumeRole + DDB via tenant-data role
    for (const fn of [hitlApprovalFn, hitlQueryFn, profileFn]) {
      fn.role!.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ['sts:AssumeRole', 'sts:TagSession'],
          resources: [tenantDataRole.roleArn],
        }),
      );
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['events:PutEvents'],
          resources: [props.busArn],
        }),
      );
      props.dynamodbKey.grantDecrypt(fn);
      fn.addEnvironment('TENANT_DATA_ROLE_ARN', tenantDataRole.roleArn);
    }

    // Spec-9 functions are covered by the PrincipalArn-pattern trust above;
    // their identity-policy sts:AssumeRole grants (the second key) are added in
    // the loop over [hitlApprovalFn, hitlQueryFn, profileFn] above.

    // SFN task-callback permissions for the approval Lambda (design §2.3).
    // Authorization rides on the task token (an unguessable capability). These
    // actions DO support execution-ARN scoping, but the HITL state machine has
    // no deterministic name today; scoping needs `execution:<name>:*` and is
    // deferred until the machine is explicitly named.
    hitlApprovalFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['states:SendTaskSuccess', 'states:SendTaskFailure'],
        resources: ['*'],
      }),
    );
    NagSuppressions.addResourceSuppressions(
      hitlApprovalFn.role!,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'states:SendTaskSuccess/SendTaskFailure support resource-level permissions only for activities; callback-pattern authorization is scoped by the task token, which the Lambda obtains exclusively from the tenant-scoped HITL item (BC-8).',
          appliesTo: ['Resource::*'],
        },
      ],
      true,
    );

    // HITL RESOLVING-cleanup sweeper (Task 8) — system-level scheduled recovery.
    // Cross-tenant BY DESIGN (resets stale RESOLVING locks for every tenant), so
    // it uses a direct, narrowly-scoped policy instead of the tenant-data role:
    // Scan restricted to the sparse GSI9 index + UpdateItem on CumplifyCore only.
    const hitlSweeperFn = new NodejsFunction(this, 'HitlSweeperFn', {
      entry: 'services/api/src/resolvers/hitl-sweeper.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(60),
      bundling: { externalModules: [], target: 'node22' },
      environment: {
        TABLE_NAME: props.tableName,
        POWERTOOLS_SERVICE_NAME: 'hitl-sweeper',
      },
    });
    hitlSweeperFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:Scan'],
        resources: [`${props.tableArn}/index/GSI9`],
      }),
    );
    hitlSweeperFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:UpdateItem'],
        resources: [props.tableArn],
      }),
    );
    props.dynamodbKey.grantDecrypt(hitlSweeperFn);
    new events.Rule(this, 'HitlSweeperSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new targets.LambdaFunction(hitlSweeperFn)],
      description: 'HITL sweeper: reset stale RESOLVING items to PENDING (Task 8)',
    });

    // Data sources
    const hitlApprovalDS = api.addLambdaDataSource('HitlApprovalDS', hitlApprovalFn);
    const hitlQueryDS = api.addLambdaDataSource('HitlQueryDS', hitlQueryFn);
    const profileDS = api.addLambdaDataSource('ProfileDS', profileFn);

    // Query resolvers (Spec 9)
    const listHitlResolver = hitlQueryDS.createResolver('ListPendingHitlItems', {
      typeName: 'Query',
      fieldName: 'listPendingHitlItems',
    });
    const getProfileResolver = profileDS.createResolver('GetProfile', {
      typeName: 'Query',
      fieldName: 'getProfile',
    });
    // New field 2026-07-14 (Task 31 Settings unblock) — MUST carry the schema
    // dependency below (9d9c90a1 lesson).
    const getTenantSettingsResolver = profileDS.createResolver('GetTenantSettings', {
      typeName: 'Query',
      fieldName: 'getTenantSettings',
    });

    // Mutation resolvers (Spec 9)
    const approveHitlResolver = hitlApprovalDS.createResolver('ApproveHitlItem', {
      typeName: 'Mutation',
      fieldName: 'approveHitlItem',
    });
    const updateProfileResolver = profileDS.createResolver('UpdateProfile', {
      typeName: 'Mutation',
      fieldName: 'updateProfile',
    });

    // ─── Spec 41: QMS Forms & Records Engine ──────────────────────────────────

    const formsFn = new NodejsFunction(this, 'FormsFn', {
      entry: 'services/api/src/resolvers/forms.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      bundling: { externalModules: [], target: 'node22' },
      environment: {
        CLUSTER_ARN: props.clusterArn,
        APP_ROLE_SECRET_ARN: appRoleSecret.secretArn,
        TABLE_NAME: props.tableName,
        BUS_NAME: props.busName,
        TENANT_DATA_ROLE_ARN: tenantDataRole.roleArn,
        REGION: cdk.Stack.of(this).region,
        POWERTOOLS_SERVICE_NAME: 'resolver-forms',
      },
    });

    // IAM: RDS Data API + EventBridge + STS
    formsFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'rds-data:ExecuteStatement',
          'rds-data:BeginTransaction',
          'rds-data:CommitTransaction',
          'rds-data:RollbackTransaction',
        ],
        resources: [props.clusterArn],
      }),
    );
    formsFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [appRoleSecret.secretArn],
      }),
    );
    formsFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['events:PutEvents'],
        resources: [props.busArn],
      }),
    );
    formsFn.role!.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole', 'sts:TagSession'],
        resources: [tenantDataRole.roleArn],
      }),
    );
    props.dynamodbKey.grantDecrypt(formsFn);

    // Spec-41 Task 8 (REC-7): record PDF export + approved-record sealing.
    // Mirrors the m1 STO-5 block above: content JSON + PDFs live in the
    // GeneralBucket tenant prefix (Get for CopyObject source + presigned
    // reads, Put for the record content JSON); sealed copies land in the
    // EvidenceVault with per-object retention. Both buckets share
    // s3GeneralKey, so grantEncryptDecrypt covers writes and presigned GETs.
    formsFn.addEnvironment('CONTENT_BUCKET', props.generalBucketName);
    formsFn.addEnvironment('EVIDENCE_BUCKET', props.evidenceBucketName);
    formsFn.addEnvironment('EVIDENCE_LOCK_MODE', envConfig.evidenceRetentionMode);
    formsFn.addEnvironment('PDF_RENDER_FN', pdfRenderFn.functionName);
    formsFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:PutObject'],
        resources: [`${props.generalBucketArn}/tenants/*`],
      }),
    );
    formsFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject', 's3:PutObjectRetention'],
        resources: [`${props.evidenceBucketArn}/tenants/*`],
      }),
    );
    props.s3GeneralKey.grantEncryptDecrypt(formsFn);
    pdfRenderFn.grantInvoke(formsFn);
    // formsFn stays OUTSIDE the blanket lambdaResources IAM5 list (qmsFn
    // philosophy: future real wildcards must still fail synth) — every
    // suppression here is a targeted appliesTo:
    // 1. grantInvoke emits lambda:InvokeFunction on <fnArn>:* (qmsFn→ExportFn class).
    // 2. Tenant-prefix S3 access is inherently /tenants/* — object keys are
    //    per-tenant/per-record; the same scoping every PDF-pipeline fn uses.
    NagSuppressions.addResourceSuppressions(
      formsFn,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'grantInvoke(PdfRenderFn) emits lambda:InvokeFunction on <fnArn>:* for ' +
            'versioned Lambda invocation. CDK-generated; cannot be scoped further.',
          appliesTo: [{ regex: '/^Resource::<PdfRenderFn.*\\.Arn>:\\*$/g' }],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Record content JSONs, cached PDFs and sealed copies live under per-tenant ' +
            'object keys — access is scoped to the tenants/ prefix of the two content ' +
            'buckets, the same pattern as PdfRenderFn/ExportFn/M1.',
          appliesTo: [{ regex: '/^Resource::.*\\.Arn>\\/tenants\\/\\*$/g' }],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'kms.grantEncryptDecrypt on the S3 content CMK emits the standard ' +
            'kms:ReEncrypt*/kms:GenerateDataKey* action wildcards (CDK-generated, ' +
            'key-scoped resource).',
          appliesTo: ['Action::kms:ReEncrypt*', 'Action::kms:GenerateDataKey*'],
        },
      ],
      true,
    );

    const formsDS = api.addLambdaDataSource('FormsDataSource', formsFn);

    // Query resolvers (Spec 41)
    const listFormTemplatesResolver = formsDS.createResolver('ListFormTemplates', {
      typeName: 'Query',
      fieldName: 'listFormTemplates',
    });
    const getFormTemplateResolver = formsDS.createResolver('GetFormTemplate', {
      typeName: 'Query',
      fieldName: 'getFormTemplate',
    });
    const listFormRecordsResolver = formsDS.createResolver('ListFormRecords', {
      typeName: 'Query',
      fieldName: 'listFormRecords',
    });
    const getFormRecordResolver = formsDS.createResolver('GetFormRecord', {
      typeName: 'Query',
      fieldName: 'getFormRecord',
    });

    // Mutation resolvers (Spec 41)
    const createFormRecordResolver = formsDS.createResolver('CreateFormRecord', {
      typeName: 'Mutation',
      fieldName: 'createFormRecord',
    });
    const saveFormRecordValuesResolver = formsDS.createResolver('SaveFormRecordValues', {
      typeName: 'Mutation',
      fieldName: 'saveFormRecordValues',
    });
    const submitFormRecordResolver = formsDS.createResolver('SubmitFormRecord', {
      typeName: 'Mutation',
      fieldName: 'submitFormRecord',
    });
    const approveFormRecordResolver = formsDS.createResolver('ApproveFormRecord', {
      typeName: 'Mutation',
      fieldName: 'approveFormRecord',
    });
    const reopenFormRecordResolver = formsDS.createResolver('ReopenFormRecord', {
      typeName: 'Mutation',
      fieldName: 'reopenFormRecord',
    });
    const exportFormRecordPdfResolver = formsDS.createResolver('ExportFormRecordPdf', {
      typeName: 'Mutation',
      fieldName: 'exportFormRecordPdf',
    });

    // ─── Spec 40: QMS Document Engine ─────────────────────────────────────────

    // DocGenStateMachine lives in AiStack, which depends on THIS stack — the
    // ARN is constructed from its DETERMINISTIC name (no CFN cycle). QmsFn
    // throws GENERATION_UNAVAILABLE until AiStack's machine exists.
    const docGenSfnArn = cdk.Stack.of(this).formatArn({
      service: 'states',
      resource: 'stateMachine',
      resourceName: `cumplify-docgen-${props.envConfig.envName}`,
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    });

    // GEN-6: RegenerateSectionFn — same deterministic-name pattern as the
    // state machine (AiStack fn, ARN constructed by name; no CFN cycle).
    const regenFnName = `cumplify-docgen-regen-${props.envConfig.envName}`;
    const regenFnArn = cdk.Stack.of(this).formatArn({
      service: 'lambda',
      resource: 'function',
      resourceName: regenFnName,
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    });

    const qmsFn = new NodejsFunction(this, 'QmsFn', {
      entry: 'services/api/src/resolvers/qms.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      bundling: { externalModules: [], target: 'node22' },
      environment: {
        CLUSTER_ARN: props.clusterArn,
        APP_ROLE_SECRET_ARN: appRoleSecret.secretArn,
        TABLE_NAME: props.tableName,
        BUS_NAME: props.busName,
        TENANT_DATA_ROLE_ARN: tenantDataRole.roleArn,
        REGION: cdk.Stack.of(this).region,
        DOCGEN_SFN_ARN: docGenSfnArn,
        REGEN_FN: regenFnName,
        POWERTOOLS_SERVICE_NAME: 'resolver-qms',
      },
    });

    qmsFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['states:StartExecution'],
        resources: [docGenSfnArn],
      }),
    );
    qmsFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [regenFnArn],
      }),
    );
    // S3 (studio wave): runManualSectionDraft Event-invokes DocStudio — same
    // deterministic-name pattern as m1's runDocDraft.
    qmsFn.addEnvironment('DOC_STUDIO_FN_ARN', docStudioFnArn);
    qmsFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [docStudioFnArn],
      }),
    );

    qmsFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'rds-data:ExecuteStatement',
          'rds-data:BeginTransaction',
          'rds-data:CommitTransaction',
          'rds-data:RollbackTransaction',
        ],
        resources: [props.clusterArn],
      }),
    );
    qmsFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [appRoleSecret.secretArn],
      }),
    );
    qmsFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['events:PutEvents'],
        resources: [props.busArn],
      }),
    );
    qmsFn.role!.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole', 'sts:TagSession'],
        resources: [tenantDataRole.roleArn],
      }),
    );
    props.dynamodbKey.grantDecrypt(qmsFn);
    // Task 9: requestImsExport dispatches to ExportFn (SQL in QmsFn, S3/zip there)
    qmsFn.addEnvironment('EXPORT_FN', exportFn.functionName);
    exportFn.grantInvoke(qmsFn);

    const qmsDS = api.addLambdaDataSource('QmsDataSource', qmsFn);

    // Query resolvers (Spec 40)
    const getOrgProfileResolver = qmsDS.createResolver('GetOrgProfile', {
      typeName: 'Query',
      fieldName: 'getOrgProfile',
    });
    const listClauseRegistryResolver = qmsDS.createResolver('ListClauseRegistry', {
      typeName: 'Query',
      fieldName: 'listClauseRegistry',
    });
    const listClauseApplicabilityResolver = qmsDS.createResolver('ListClauseApplicability', {
      typeName: 'Query',
      fieldName: 'listClauseApplicability',
    });
    const getGenerationRunResolver = qmsDS.createResolver('GetGenerationRun', {
      typeName: 'Query',
      fieldName: 'getGenerationRun',
    });
    const listGenerationRunsResolver = qmsDS.createResolver('ListGenerationRuns', {
      typeName: 'Query',
      fieldName: 'listGenerationRuns',
    });

    // Mutation resolvers (Spec 40 — user-facing)
    const saveOrgProfileResolver = qmsDS.createResolver('SaveOrgProfile', {
      typeName: 'Mutation',
      fieldName: 'saveOrgProfile',
    });
    const setClauseApplicabilityResolver = qmsDS.createResolver('SetClauseApplicability', {
      typeName: 'Mutation',
      fieldName: 'setClauseApplicability',
    });
    const generateImsManualResolver = qmsDS.createResolver('GenerateImsManual', {
      typeName: 'Mutation',
      fieldName: 'generateImsManual',
    });
    const regenerateSectionResolver = qmsDS.createResolver('RegenerateSection', {
      typeName: 'Mutation',
      fieldName: 'regenerateSection',
    });
    const markSectionReviewedResolver = qmsDS.createResolver('MarkSectionReviewed', {
      typeName: 'Mutation',
      fieldName: 'markSectionReviewed',
    });
    const requestImsExportResolver = qmsDS.createResolver('RequestImsExport', {
      typeName: 'Mutation',
      fieldName: 'requestImsExport',
    });
    // S3 (studio wave) — Manual Studio gap burn-down dispatch on the qms DS.
    const runManualSectionDraftResolver = qmsDS.createResolver('RunManualSectionDraft', {
      typeName: 'Mutation',
      fieldName: 'runManualSectionDraft',
    });
    // @aws_iam — publishGenerationEvent routed through None DS (passthrough)
    noneDS.createResolver('PublishGenerationEvent', {
      typeName: 'Mutation',
      fieldName: 'publishGenerationEvent',
      requestMappingTemplate: passthroughRequestMapping,
      responseMappingTemplate: passthroughResponseMapping,
    });

    // Subscription resolver (Spec 9, C-6 tenant verification via VTL)
    const subHitlResolver = noneDS.createResolver('SubOnHitlItemResolved', {
      typeName: 'Subscription',
      fieldName: 'onHitlItemResolved',
      requestMappingTemplate: subscriptionRequestTemplate,
      responseMappingTemplate: subscriptionResponseTemplate,
    });

    // CFN ordering: new resolvers MUST wait for the schema UPDATE to land —
    // without an explicit dependency, CloudFormation creates resolvers in
    // parallel with the schema update and AppSync 404s on the new fields
    // (live failure 2026-07-11, exec 9d9c90a1: "No field named
    // onHitlItemResolved found on type Subscription").
    const schemaResource = api.node.findChild('Schema') as cdk.CfnResource;
    for (const r of [
      listHitlResolver,
      getProfileResolver,
      approveHitlResolver,
      updateProfileResolver,
      subHitlResolver,
      listDocVersionsResolver,
      listNcResolver,
      listCaResolver,
      registerMeasuringResourceResolver,
      getTenantSettingsResolver,
      listFormTemplatesResolver,
      getFormTemplateResolver,
      listFormRecordsResolver,
      getFormRecordResolver,
      createFormRecordResolver,
      saveFormRecordValuesResolver,
      submitFormRecordResolver,
      approveFormRecordResolver,
      reopenFormRecordResolver,
      exportFormRecordPdfResolver,
      getOrgProfileResolver,
      listClauseRegistryResolver,
      listClauseApplicabilityResolver,
      getGenerationRunResolver,
      listGenerationRunsResolver,
      saveOrgProfileResolver,
      setClauseApplicabilityResolver,
      generateImsManualResolver,
      regenerateSectionResolver,
      markSectionReviewedResolver,
      requestImsExportResolver,
      getDocumentContentResolver,
      listApprovalMatrixResolver,
      setApprovalMatrixEntryResolver,
      saveDocumentSectionEditResolver,
      runCapaAnalysisResolver,
      runNcIntakeResolver,
      runRcaResolver,
      listRcaResolver,
      listAuditsResolver,
      listAuditFindingsResolver,
      listAuditChecklistsResolver,
      runAuditFindingsResolver,
      runDocDraftResolver,
      runManualSectionDraftResolver,
      runRiskAssessmentResolver,
      createBillingPortalSessionResolver,
    ]) {
      r.node.addDependency(schemaResource);
    }

    // ─── CfnOutputs ─────────────────────────────────────────────────────────
    this.graphqlApiUrlOutput = new cdk.CfnOutput(this, 'GraphqlApiUrl', { value: this.graphqlApiUrl });
    new cdk.CfnOutput(this, 'GraphqlApiId', { value: this.graphqlApiId });
    new cdk.CfnOutput(this, 'AuthorizerArn', { value: this.authorizerArn });
    new cdk.CfnOutput(this, 'TenantDataRoleArn', { value: this.tenantDataRoleArn });
    new cdk.CfnOutput(this, 'AppRoleSecretArn', { value: appRoleSecret.secretArn });

    // ─── CDK Nag Suppressions ────────────────────────────────────────────────
    // FIX-3: path-scoped suppressions instead of stack-wide blanket
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
          id: 'AwsSolutions-L1',
          reason: 'Lambda uses NODEJS_22_X (latest LTS). CDK Nag may not recognize newer runtimes.',
        },
      ],
      true,
    );

    // FIX-3(a): IAM5 on Lambda log-group wildcards only (not the DDB grant)
    const lambdaResources = [
      authorizerFn,
      migratorFn,
      ...resolverFns,
      hitlApprovalFn,
      hitlQueryFn,
      profileFn,
      pdfRenderFn,
      exportFn,
    ];
    for (const fn of lambdaResources) {
      NagSuppressions.addResourceSuppressions(
        fn,
        [
          {
            id: 'AwsSolutions-IAM5',
            reason:
              'Lambda execution role has logs:CreateLogGroup/PutLogEvents with wildcard on ' +
              'log stream name. Standard CDK pattern for Lambda logging.',
          },
        ],
        true,
      );
    }

    // FIX-3(b): IAM5 on TenantDataRole — explicit justification for index/* wildcard
    NagSuppressions.addResourceSuppressions(
      tenantDataRole,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'GSI access uses ${tableArn}/index/* wildcard. Tenant isolation is enforced by ' +
            'the dynamodb:LeadingKeys condition (TENANT#${aws:PrincipalTag/tenantId}#*). ' +
            'Cross-tenant GSI query denial proven at ACC-2 GSI probe (Task 14).',
        },
      ],
      true,
    );

    // NAG-1: app_role secret rotation deferred (owner-approved FIX-5 decision)
    NagSuppressions.addResourceSuppressions(appRoleSecret, [
      {
        id: 'AwsSolutions-SMG4',
        reason:
          'Rotation deferred as named prod carry (tasks-7-9-signoff.md); ' +
          'dev uses deploy-time password sync. Single-user rotation Lambda requires ' +
          'VPC attachment — will be added for prod hardening.',
      },
    ]);

    // NAG-2: AppSync ASC3 false positive — LogConfig IS set (verified in synthesized
    // template: FieldLogLevel=ALL, CloudWatchLogsRoleArn present, ExcludeVerboseContent=true).
    // CDK Nag ASC3 rule does not detect the L2 logConfig property correctly.
    NagSuppressions.addResourceSuppressions(api, [
      {
        id: 'AwsSolutions-ASC3',
        reason:
          'LogConfig is set: FieldLogLevel=ALL, CloudWatchLogsRoleArn=auto-created role, ' +
          'ExcludeVerboseContent=true. Verified in synthesized template — CDK Nag ASC3 ' +
          'rule does not detect L2 GraphqlApi logConfig property. False positive.',
      },
    ]);

    // NAG-3: IAM5[Resource::*] from xrayEnabled — AppSync/X-Ray integration adds
    // xray:PutTraceSegments + xray:PutTelemetryRecords with Resource:* (AWS-managed behavior).
    // IAM5[Resource::<FnArn>:*] from AppSync data source service roles — lambda:InvokeFunction
    // on <fnArn>:* for versioned invocation (CDK-generated, cannot scope further).
    const dataSources = [
      m1DS,
      m2DS,
      m3DS,
      m4DS,
      m5DS,
      billingDS,
      hitlApprovalDS,
      hitlQueryDS,
      profileDS,
      formsDS,
      qmsDS,
    ];
    for (const ds of dataSources) {
      NagSuppressions.addResourceSuppressions(
        ds,
        [
          {
            id: 'AwsSolutions-IAM5',
            reason:
              'AppSync Lambda data source service role uses lambda:InvokeFunction on ' +
              '<fnArn>:* for versioned Lambda invocation. This is CDK-generated behavior ' +
              'that cannot be scoped further without breaking AppSync resolver invocation.',
            appliesTo: [{ regex: '/^Resource::.*\\*$/g' }],
          },
        ],
        true,
      );
    }

    // Task 9: qmsFn invokes ExportFn via grantInvoke — CDK grants
    // lambda:InvokeFunction on <fnArn>:* for versioned invocation (same class
    // as NAG-3). Targeted appliesTo, NOT a blanket: qmsFn stays outside
    // lambdaResources so future real wildcards on it still fail synth.
    NagSuppressions.addResourceSuppressions(
      qmsFn,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'grantInvoke(ExportFn) emits lambda:InvokeFunction on <fnArn>:* for ' +
            'versioned Lambda invocation. CDK-generated; cannot be scoped further.',
          appliesTo: [{ regex: '/^Resource::<ExportFn.*\\.Arn>:\\*$/g' }],
        },
      ],
      true,
    );

    // X-Ray tracing role (attached to Lambda execution roles by xrayEnabled)
    for (const fn of lambdaResources) {
      NagSuppressions.addResourceSuppressions(
        fn,
        [
          {
            id: 'AwsSolutions-IAM5',
            reason:
              'X-Ray tracing (xrayEnabled: true) requires xray:PutTraceSegments and ' +
              'xray:PutTelemetryRecords with Resource::*. AWS-managed behavior.',
            appliesTo: ['Resource::*'],
          },
        ],
        true,
      );
    }

    // LogRetention custom resource (CDK-internal, manages CloudWatch log group retention)
    // Its service role has logs:* with Resource::* — CDK-generated, cannot scope.
    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'LogRetention custom resource (CDK-internal) service role uses logs:PutRetentionPolicy ' +
          'and logs:DeleteRetentionPolicy with Resource::*. CDK framework-generated behavior ' +
          'for CloudWatch log group retention management. Cannot be scoped further.',
        appliesTo: ['Resource::*'],
      },
    ]);
  }
}
