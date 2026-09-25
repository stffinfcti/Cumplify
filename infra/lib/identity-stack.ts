/**
 * IdentityStack — 3 Cognito User Pools + PreTokenGeneration Lambda.
 * Per AC-5.1 through AC-5.5, NFR-2, design §2.1, §5.
 *
 * Pools:
 * - Pool A (cumplify-internal): MFA REQUIRED, internal staff (PlatformAdmin, etc.)
 * - Pool B (cumplify-tenant-admin): MFA OPTIONAL, tenant leadership
 * - Pool C (cumplify-tenant-user): MFA OPTIONAL, tenant workforce
 *
 * All pools: custom:tenantId immutable, PreTokenGeneration V1_0,
 * sign-in email, self-signup disabled, EMAIL_ONLY recovery,
 * deletion protection, RETAIN.
 *
 * Dependency design (avoids circular reference):
 *   Lambda (references SSM param path — static string, no pool refs)
 *   → Pools (declare Lambda as trigger)
 *   → SSM StringParameter (stores poolId→poolClass JSON map, depends on pools)
 * Nothing depends on the SSM param. Graph is acyclic.
 */

import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';
import { type EnvConfig } from './env-config.js';

export interface IdentityStackProps extends cdk.StackProps {
  readonly envConfig: EnvConfig;
  readonly tableName: string;
}

/** Pool configuration */
interface PoolConfig {
  id: string;
  poolName: string;
  mfa: cognito.Mfa;
  groups: string[];
  poolClass: string;
}

export class IdentityStack extends cdk.Stack {
  public readonly poolAId: string;
  public readonly poolBId: string;
  public readonly poolCId: string;
  public readonly poolBArn: string;
  public readonly poolCArn: string;
  public readonly poolBClientId: string;
  public readonly poolCClientId: string;
  public readonly poolBIdOutput: cdk.CfnOutput;
  public readonly poolBClientIdOutput: cdk.CfnOutput;

  constructor(scope: Construct, id: string, props: IdentityStackProps) {
    super(scope, id, props);

    const { envConfig, tableName } = props;

    // Static SSM parameter path — Lambda references this string (no pool IDs)
    const poolClassMapParamName = `/cumplify/${envConfig.envName}/identity/pool-class-map`;

    // -----------------------------------------------------------------------
    // PreTokenGeneration Lambda — Node.js 22.x, arm64, 5s timeout
    // Stamps tenantId + role + poolClass into ID token.
    // Reads pool-class-map from SSM on cold start (cached).
    // Falls back to Cognito group as role (logs fallback — no silent paths).
    // -----------------------------------------------------------------------
    // NodejsFunction esbuild-bundles index.ts -> index.js. The prior
    // lambda.Code.fromAsset('services/pre-token-gen') uploaded the raw .ts,
    // which the Node 22 runtime cannot load ("Cannot find module 'index'") —
    // the trigger threw on every token generation. Caught by direct invoke
    // 2026-07-04; readbacks never exercised the Lambda. @aws-sdk/* stays
    // external (present in runtime) so the dynamic client-ssm import resolves.
    const preTokenGenFn = new NodejsFunction(this, 'PreTokenGenFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      entry: 'services/pre-token-gen/index.ts',
      handler: 'handler',
      timeout: cdk.Duration.seconds(5), // Cognito trigger hard cap
      // 512MB (not 128) — memory-proportional CPU cuts SDK cold-start init; at
      // 128MB the cold invoke exceeded the 5s Cognito cap. client-ssm bundled
      // (not external) so cold start pays no runtime module resolution.
      memorySize: 512,
      bundling: {
        minify: true,
        target: 'node22',
        // NodejsFunction externalizes @aws-sdk/* by default (assumes runtime
        // copy). Override to [] so client-ssm is bundled inline — eliminates
        // the runtime module-resolution cold-start cost that broke the 5s cap.
        externalModules: [],
      },
      environment: {
        TABLE_NAME: tableName,
        POOL_CLASS_MAP_PARAM: poolClassMapParamName, // static path — no pool refs
      },
      description: 'PreTokenGeneration V1_0 — stamps tenantId/role/poolClass into ID token',
    });

    // Grant ssm:GetParameter on the static path (acyclic — no pool references)
    preTokenGenFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${poolClassMapParamName}`],
      }),
    );

    // -----------------------------------------------------------------------
    // Pool definitions
    // -----------------------------------------------------------------------
    const pools: PoolConfig[] = [
      {
        id: 'PoolA',
        poolName: `cumplify-${envConfig.envName}-internal`,
        mfa: cognito.Mfa.REQUIRED,
        groups: ['PlatformAdmin', 'SupportEngineer', 'FinanceOps', 'SecurityOps'],
        poolClass: 'internal',
      },
      {
        id: 'PoolB',
        poolName: `cumplify-${envConfig.envName}-tenant-admin`,
        mfa: cognito.Mfa.OPTIONAL,
        groups: ['TopManagement', 'IMSLead', 'QualityManager', 'EHSManager', 'DocumentController'],
        poolClass: 'tenant-admin',
      },
      {
        id: 'PoolC',
        poolName: `cumplify-${envConfig.envName}-tenant-user`,
        mfa: cognito.Mfa.OPTIONAL,
        groups: [
          'InternalAuditor',
          'ExternalAuditor',
          'ProcessOwner',
          'Supervisor',
          'Employee',
          'Contractor',
          'PartnerConsultant',
        ],
        poolClass: 'tenant-user',
      },
    ];

    const createdPools: Record<string, cognito.UserPool> = {};
    let poolAClient: cognito.UserPoolClient | undefined;
    let poolBClient: cognito.UserPoolClient | undefined;
    let poolCClient: cognito.UserPoolClient | undefined;

    for (const poolConfig of pools) {
      const pool = new cognito.UserPool(this, poolConfig.id, {
        userPoolName: poolConfig.poolName,
        selfSignUpEnabled: false,
        signInAliases: { email: true },
        mfa: poolConfig.mfa,
        mfaSecondFactor: { otp: true, sms: false },
        accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
        passwordPolicy: {
          minLength: 12,
          requireLowercase: true,
          requireUppercase: true,
          requireDigits: true,
          requireSymbols: true,
        },
        standardAttributes: {
          email: { required: true, mutable: true },
        },
        customAttributes: {
          // IMMUTABLE — write once at signup only. Never AdminUpdateUserAttributes after confirm.
          tenantId: new cognito.StringAttribute({ mutable: false }),
        },
        lambdaTriggers: {
          preTokenGeneration: preTokenGenFn,
        },
        deletionProtection: true,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });

      // Create groups for this pool
      for (const groupName of poolConfig.groups) {
        new cognito.CfnUserPoolGroup(this, `${poolConfig.id}${groupName}`, {
          userPoolId: pool.userPoolId,
          groupName,
        });
      }

      // App client — authorization code flow (+ SRP for Pool B/C)
      const authFlows: cognito.AuthFlow =
        poolConfig.id === 'PoolA'
          ? { userSrp: false, custom: false, userPassword: false }
          : { userSrp: true, custom: false, userPassword: false };

      const client = pool.addClient(`${poolConfig.id}Client`, {
        userPoolClientName: `${poolConfig.poolName}-client`,
        authFlows,
        // Explicit list required: CDK's default was read back as ["COGNITO"]
        // only — late-registered SAML provider is NOT picked up implicitly
        // (verified against deployed client 2026-07-04, task 3.2).
        supportedIdentityProviders:
          poolConfig.id === 'PoolA' && envConfig.samlMetadataUrl
            ? [
                cognito.UserPoolClientIdentityProvider.COGNITO,
                cognito.UserPoolClientIdentityProvider.custom('CumplifyIdC'),
              ]
            : undefined,
        oAuth: {
          flows: { authorizationCodeGrant: true, implicitCodeGrant: false },
          scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
          // localhost stays registered so `next dev` sign-in works; the deployed
          // origin comes from envConfig.frontendDomain once the env is live.
          callbackUrls: [
            'http://localhost:3000/callback',
            ...(envConfig.frontendDomain ? [`https://${envConfig.frontendDomain}/callback`] : []),
          ],
          logoutUrls: [
            'http://localhost:3000/logout',
            ...(envConfig.frontendDomain ? [`https://${envConfig.frontendDomain}/logout`] : []),
          ],
        },
        preventUserExistenceErrors: true,
        readAttributes: new cognito.ClientAttributes().withStandardAttributes({
          email: true,
          emailVerified: true,
        }),
        writeAttributes: new cognito.ClientAttributes().withStandardAttributes({
          email: true,
        }),
      });

      if (poolConfig.id === 'PoolA') {
        poolAClient = client;
      } else if (poolConfig.id === 'PoolB') {
        poolBClient = client;
      } else if (poolConfig.id === 'PoolC') {
        poolCClient = client;
      }

      createdPools[poolConfig.id] = pool;

      // CDK Nag COG4/COG8 suppression
      NagSuppressions.addResourceSuppressions(pool, [
        {
          id: 'AwsSolutions-COG4',
          reason:
            'Cognito PLUS tier (advanced threat protection) not enabled. ESSENTIALS tier ' +
            'provides standard protections. PLUS adds ~$0.05/MAU/month cost that is not ' +
            'justified at this stage. Will be evaluated for prod hardening.',
        },
        {
          id: 'AwsSolutions-COG8',
          reason:
            'Cognito PLUS tier / feature plan not enabled. ESSENTIALS tier provides standard ' +
            'protections including MFA, password policies, and account recovery. PLUS tier ' +
            'cost (~$0.05/MAU/month) not justified at this stage.',
        },
      ]);
    }

    // -----------------------------------------------------------------------
    // Cognito Domain for Pool A (required for SAML federation — task 3.2)
    // Prefix must be globally unique, lowercase, no special chars except hyphens.
    // Pattern: cumplify-<env>-internal-auth
    // -----------------------------------------------------------------------
    createdPools['PoolA'].addDomain('PoolADomain', {
      cognitoDomain: {
        domainPrefix: `cumplify-${envConfig.envName}-internal-auth`,
      },
    });

    // -----------------------------------------------------------------------
    // IdC SAML federation for Pool A (task 3.2). Dormant until the owner copies
    // the IdC metadata URL (console-only) into envConfig.samlMetadataUrl.
    // Client's supportedIdentityProviders is Lazy — CDK includes providers
    // registered on the pool; explicit dependency enforces create order.
    // -----------------------------------------------------------------------
    if (envConfig.samlMetadataUrl) {
      const idcProvider = new cognito.UserPoolIdentityProviderSaml(this, 'PoolAIdCSaml', {
        userPool: createdPools['PoolA'],
        name: 'CumplifyIdC',
        metadata: cognito.UserPoolIdentityProviderSamlMetadata.url(envConfig.samlMetadataUrl),
        attributeMapping: {
          email: cognito.ProviderAttribute.other('email'),
        },
      });
      poolAClient!.node.addDependency(idcProvider);
      new cdk.CfnOutput(this, 'PoolASamlProviderName', {
        value: idcProvider.providerName,
      });
    }

    // -----------------------------------------------------------------------
    // SSM StringParameter — pool-class-map (depends on pools, nothing depends on it)
    // Stores JSON: { "<poolId>": "internal"|"tenant-admin"|"tenant-user", ... }
    // Lambda reads this on cold start via ssm:GetParameter.
    // -----------------------------------------------------------------------
    new ssm.StringParameter(this, 'PoolClassMapParam', {
      parameterName: poolClassMapParamName,
      description: 'Maps Cognito User Pool IDs to pool class names for PreTokenGen Lambda',
      stringValue: cdk.Lazy.string({
        produce: () =>
          JSON.stringify({
            [createdPools['PoolA'].userPoolId]: 'internal',
            [createdPools['PoolB'].userPoolId]: 'tenant-admin',
            [createdPools['PoolC'].userPoolId]: 'tenant-user',
          }),
      }),
    });

    // Export pool IDs
    this.poolAId = createdPools['PoolA'].userPoolId;
    this.poolBId = createdPools['PoolB'].userPoolId;
    this.poolCId = createdPools['PoolC'].userPoolId;
    this.poolBArn = createdPools['PoolB'].userPoolArn;
    this.poolCArn = createdPools['PoolC'].userPoolArn;
    this.poolBClientId = poolBClient!.userPoolClientId;
    this.poolCClientId = poolCClient!.userPoolClientId;

    // -----------------------------------------------------------------------
    // CfnOutputs — per design §2 / F-9 (consumed by readback via cdk-outputs.json)
    // -----------------------------------------------------------------------
    new cdk.CfnOutput(this, 'PoolAId', { value: this.poolAId });
    this.poolBIdOutput = new cdk.CfnOutput(this, 'PoolBId', { value: this.poolBId });
    new cdk.CfnOutput(this, 'PoolCId', { value: this.poolCId });
    new cdk.CfnOutput(this, 'PoolBArn', { value: this.poolBArn });
    new cdk.CfnOutput(this, 'PoolCArn', { value: this.poolCArn });
    this.poolBClientIdOutput = new cdk.CfnOutput(this, 'PoolBClientId', {
      value: this.poolBClientId,
    });
    new cdk.CfnOutput(this, 'PoolCClientId', { value: this.poolCClientId });
    new cdk.CfnOutput(this, 'PoolAClientId', {
      value: poolAClient!.userPoolClientId,
    });
    new cdk.CfnOutput(this, 'PoolADomainPrefix', {
      value: `cumplify-${envConfig.envName}-internal-auth`,
    });

    // -----------------------------------------------------------------------
    // CDK Nag suppressions
    // -----------------------------------------------------------------------
    NagSuppressions.addResourceSuppressions(
      this,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason:
            'PreTokenGeneration Lambda execution role uses AWSLambdaBasicExecutionRole ' +
            '(CDK-generated). This is the standard minimal policy for Lambda logging.',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Lambda execution role has logs:CreateLogGroup/PutLogEvents with wildcard on ' +
            'log stream name. This is the standard CDK pattern for Lambda logging.',
        },
        {
          id: 'AwsSolutions-COG1',
          reason:
            'Password policy meets all requirements (minLength 12, uppercase, lowercase, ' +
            'digits, symbols). CDK Nag may not detect the configuration on CfnUserPool.',
        },
        {
          id: 'AwsSolutions-COG2',
          reason:
            'MFA is configured per pool: Pool A REQUIRED, Pools B/C OPTIONAL. OPTIONAL ' +
            'allows tenant admins to enforce MFA at the organization level without blocking ' +
            'initial onboarding.',
        },
        {
          id: 'AwsSolutions-COG3',
          reason: 'AdvancedSecurityMode (PLUS tier) not enabled. See COG4 suppression reasoning.',
        },
        {
          id: 'AwsSolutions-L1',
          reason:
            'Lambda uses NODEJS_22_X which is the latest LTS runtime. CDK Nag rule may not ' +
            'recognize newer runtimes added after the rule was written.',
        },
      ],
      true,
    );
  }
}
