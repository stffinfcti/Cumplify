# Cumplify.ai — CDK Construct Recommendations & Stack-Separation Strategy

> **Audience:** Senior AWS engineer implementing the Cumplify.ai Integrated Management System (ISO 9001:2015 Quality + ISO 14001:2015 Environmental + ISO 45001:2018 OH&S) on the verified AWS stack.
> **Scope:** This is a handoff document. Every construct recommendation is grounded in Cumplify's verified stack facts. No console-click steps — all guidance is CDK (aws-cdk-lib v2) constructs and props. No AWS service is introduced outside the verified stack without an explicit one-line justification.
> **Region:** `us-east-1` primary, `us-west-2` DR replica (DynamoDB Global Tables, Secrets Manager replica).
> **Verified account topology:** mgmt/tooling account (owns the pipeline) → `dev` (697114252993), `staging` (889007427685), `prod` (077405654066). Each environment is a **separate AWS account with an isolated stack, no shared state** (per canonical Section 4 environments rule).

---

## Table of Contents
1. Stack Topology (per-env, cross-account, CDK Pipelines self-mutating)
2. Construct Recommendations Per Layer
   - 2.1 Identity — Cognito (3 User Pools, PreTokenGeneration V1_0, groups)
   - 2.2 API — AppSync (USER_POOL default + IAM + Lambda Authorizer + REGIONAL WAFv2 + CfnApiCache)
   - 2.3 AI — Bedrock (CfnAgent / CfnKnowledgeBase / CfnGuardrail, verified model IDs)
   - 2.4 Vector Search — OpenSearch Serverless (CfnCollection VECTORSEARCH + 3 policies + 45s cold-start client)
   - 2.5 Metadata Store — DynamoDB (TableV2 CMK, 6 KMS actions, LeadingKeys ABAC)
   - 2.6 System of Record — RDS PostgreSQL (VPC, Secrets Manager rotation)
   - 2.7 Eventing — SQS + DLQ + EventBridge
   - 2.8 Storage/CDN — S3 Object Lock COMPLIANCE + CloudFront OAC
   - 2.9 Long-Running Orchestration — ECS/Fargate
3. IAM Permission Boundaries — Per Module & Per Agent
4. CDK Nag, Bootstrap & Cross-Account Trust
5. Appendix — Construct-to-Clause / Construct-to-Module Traceability

---

## 1. Stack Topology

### 1.1 Design principles

- **One app, one pipeline, N environment accounts.** A single CDK app synthesizes all stacks. The **CDK Pipeline lives in the mgmt/tooling account** and self-mutates. It deploys `Stage` constructs (grouped stacks) into `dev` → `staging` → `prod` target accounts. This matches the verified PHASE-19 pipeline.
- **No shared state across environments.** Each env is a distinct account. There is no cross-env stack reference, no shared bucket, no shared table. Config is injected via **CDK context per env** (`cdk.context.json` / `-c env=<name>`), never hard-coded shared ARNs.
- **`crossAccountKeys: true` is mandatory.** Cross-account artifact bucket access requires the pipeline to create KMS keys for the artifact bucket. Without it, target-account CodeBuild/CloudFormation cannot read the source artifact. (Verified gotcha.)
- **CodeStar Connection must be manually authorized once** (status `PENDING → AVAILABLE`) before the first pipeline run. CDK can *create* the connection but cannot approve it. Treat this as a one-time out-of-band step documented in the runbook, not a console step in the deploy flow.

### 1.2 Stage decomposition

Group stacks into a `Stage` per environment. Recommended stack boundaries inside each stage (finer boundaries = smaller blast radius, but respect CloudFormation cross-stack export limits — prefer passing constructs via props over `Fn::ImportValue`):

| Stack | Contents |
|-------|----------|
| `NetworkStack` | VPC, subnets, VPC endpoints (incl. AOSS interface endpoint, execute-api, Secrets Manager, KMS, Bedrock), flow logs |
| `SecurityStack` | 10 KMS CMKs (dynamodb, s3-general, secrets, cloudwatch-logs, sns, sqs, eventbridge, bedrock, rds, elasticache), WAFv2 WebACLs (REGIONAL for AppSync, CLOUDFRONT/us-east-1 for CDN), Secrets Manager secrets |
| `DataStack` | DynamoDB `CumplifyCore` TableV2, RDS PostgreSQL cluster, ElastiCache Redis, OpenSearch Serverless collection + 3 policies, S3 Object Lock buckets |
| `IdentityStack` | 3 Cognito User Pools + clients + PreTokenGeneration Lambda + groups |
| `AiStack` | Bedrock CfnAgent (22 agents), CfnKnowledgeBase, CfnGuardrail, action-group Lambdas |
| `ApiStack` | AppSync GraphqlApi, Lambda Authorizer, resolvers, CfnApiCache, WAF association |
| `EventingStack` | EventBridge buses (app/security/safety), SQS queues + DLQs, rules, **SNS topics + SES** (compliance notifications) |
| `ComputeStack` | ECS/Fargate cluster + services for long-running agent orchestration |
| `EdgeStack` | CloudFront distribution (OAC), Route 53 records, ACM (us-east-1) |

> **Service-scope justification (SNS + SES):** These sit outside the task's headline stack list but are part of Cumplify's **existing `aws-messaging` layer (EventBridge + SQS + SNS + SES)**. They are included only for compliance **notifications** — SES for email (calibration/certificate expiry, CAPA-due, management-review reminders, competence-expiry) and SNS for fan-out/alerts (risk-threshold breach, incident escalation). No new datastore or compute service is introduced; all persistence remains RDS/DynamoDB/S3/OpenSearch/ElastiCache.

> **CDK Nag policy (Cumplify rule):** all CDK Nag warnings are treated as **failures**. Every suppression must carry a documented `reason`. Apply `AwsSolutionsChecks` at the `App` level (see §4).

### 1.3 Pipeline construct (mgmt account)

```typescript
import * as pipelines from 'aws-cdk-lib/pipelines';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';

const ENVS = {
  dev:     { account: '697114252993', region: 'us-east-1' },
  staging: { account: '889007427685', region: 'us-east-1' },
  prod:    { account: '077405654066', region: 'us-east-1' },
};

const pipeline = new pipelines.CodePipeline(this, 'CumplifyPipeline', {
  pipelineName: 'CumplifyPipeline',
  crossAccountKeys: true,     // REQUIRED for cross-account artifact bucket (verified)
  enableKeyRotation: true,
  selfMutation: true,         // pipeline updates its own definition before deploying stages

  synth: new pipelines.ShellStep('Synth', {
    input: pipelines.CodePipelineSource.connection('stffinfcti/Cumplify', 'develop', {
      connectionArn: 'arn:aws:codestar-connections:us-east-1:MGMT_ACCOUNT:connection/UUID',
      // NOTE: connection must be AVAILABLE (manually authorized) before first run
    }),
    commands: [
      'npm ci',
      'cd frontend && npm ci && cd ..',
      'npm run test',
      'cd frontend && npm run i18n:check && cd ..',
      'npm run lint',
      'npm run typecheck',
      'npx tsx scripts/audit-gate.ts',
      'cd frontend && npm audit --audit-level=high && cd ..',
      'npx cdk synth --all',
      // CDK Nag runs as an Aspect during synth; a Nag error fails synth here.
    ],
  }),

  codeBuildDefaults: {
    buildEnvironment: {
      buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
      computeType: codebuild.ComputeType.SMALL,
    },
  },
});

// Dev — no gate
pipeline.addStage(new CumplifyStage(this, 'Dev', { env: ENVS.dev }));

// Staging — manual approval + smoke test
pipeline.addStage(new CumplifyStage(this, 'Staging', { env: ENVS.staging }), {
  pre: [ new pipelines.ManualApprovalStep('ApproveToStaging') ],
  post: [ new pipelines.ShellStep('SmokeTest', {
    commands: ['curl -f https://staging.cumplify.ai/health'],
  }) ],
});

// Prod — manual approval + hard legal sign-off gate + auto-rollback wiring
pipeline.addStage(new CumplifyStage(this, 'Prod', { env: ENVS.prod }), {
  pre: [
    new pipelines.ManualApprovalStep('ApproveToProd'),
    // LegalSignoffGuard is a ShellStep running scripts/assert-legal-signoff.mjs,
    // which blocks unless a committed legal-signoff/prod-approval.json record
    // attests attorney sign-off (verified PHASE-19 hard gate).
    new pipelines.ShellStep('LegalSignoffGuard', {
      commands: ['node scripts/assert-legal-signoff.mjs'],
    }),
  ],
});
```

> **Self-mutation failure mode (verified gotcha):** if the `Synth` step fails, the pipeline cannot self-mutate and is stuck until fixed manually in CodeBuild. Keep synth deterministic; never depend on live AWS lookups (`fromLookup`) inside synth in the pipeline — pre-resolve into `cdk.context.json`.

### 1.4 Bootstrap / trust (runbook, not console)

Each target account is bootstrapped to trust the mgmt/pipeline account. This is a CLI bootstrap command captured in the deploy runbook (executed once per account, per verified cross-account setup):

```
cdk bootstrap aws://697114252993/us-east-1 --trust MGMT_ACCOUNT \
  --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess
# repeat for 889007427685 and 077405654066
```

---

## 2. Construct Recommendations Per Layer

### 2.1 Identity — Cognito (3 User Pools)

Cumplify runs **3 Cognito User Pools** (verified Section 4). Each pool carries the same `custom:tenantId` **immutable** attribute and a **PreTokenGeneration V1_0** trigger. Cognito **groups map to the 5 roles** (Quality Manager, EHS Manager, Auditor, Employee, Executive). DynamoDB — not Cognito — is authoritative for runtime role/tier.

**Critical verified constraints:**
- `custom:tenantId` is `mutable: false`. It can be written **only at user creation** (SignUp / AdminCreateUser). A PostConfirmation Lambda calling `AdminUpdateUserAttributes` on it will always throw `InvalidParameterException`. Write mutable tenant metadata (role, tier) to DynamoDB in PostConfirmation instead.
- **PreTokenGeneration V1_0 injects claims into the ID token ONLY** — not the access token. Downstream (OAuth callback, Lambda Authorizer) must read `tenantId`/`role`/`tier` from the **ID token**.
- Lambda triggers have a **fixed 5-second timeout** (not configurable).

```typescript
import * as cognito from 'aws-cdk-lib/aws-cognito';

// PreTokenGeneration V1_0 Lambda — injects custom:tenantId, role, tier into ID token
const preTokenFn = new lambda.Function(this, 'PreTokenGen', {
  runtime: lambda.Runtime.NODEJS_22_X,
  timeout: cdk.Duration.seconds(5),   // Cognito trigger cap is 5s regardless
  handler: 'index.handler',
  code: lambda.Code.fromAsset('lambda/pre-token-gen'),
});

function buildUserPool(scope: Construct, id: string, groups: string[]): cognito.UserPool {
  const pool = new cognito.UserPool(scope, id, {
    featurePlan: cognito.FeaturePlan.PLUS,      // advanced threat protection (CDK Nag COG4)
    selfSignUpEnabled: false,
    signInAliases: { email: true },
    mfa: cognito.Mfa.REQUIRED,
    mfaSecondFactor: { otp: true, sms: false, email: false },
    accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
    passwordPolicy: { minLength: 12, requireLowercase: true, requireUppercase: true,
                      requireDigits: true, requireSymbols: true },
    standardAttributes: { email: { required: true, mutable: true } },
    customAttributes: {
      // IMMUTABLE — write once at signup only. Never AdminUpdateUserAttributes after confirm.
      tenantId: new cognito.StringAttribute({ mutable: false }),
    },
    lambdaTriggers: {
      preTokenGeneration: {
        handler: preTokenFn,
        lambdaVersion: cognito.LambdaVersion.V1_0,   // ID token ONLY (verified)
      },
    },
    deletionProtection: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });

  // Groups → roles (5 canonical roles). Group membership surfaces in cognito:groups.
  for (const g of groups) {
    new cognito.CfnUserPoolGroup(scope, `${id}${g}`, { userPoolId: pool.userPoolId, groupName: g });
  }
  return pool;
}

const ROLES = ['QualityManager', 'EHSManager', 'Auditor', 'Employee', 'Executive'];
const workforcePool = buildUserPool(this, 'WorkforcePool', ROLES); // primary app users
const adminPool     = buildUserPool(this, 'AdminPool', ['Executive']); // tenant admins/exec
const partnerPool   = buildUserPool(this, 'PartnerPool', ['Auditor']); // external auditors/partners
```

App-client note: restrict per-attribute read/write so app clients cannot attempt to write `custom:tenantId` post-signup (avoids `NotAuthorizedException`). Resource-based policy wiring the trigger Lambda must scope `AWS:SourceArn` to the specific user-pool ARN and `AWS:SourceAccount` to the env account.

### 2.2 API — AppSync GraphqlApi

AppSync uses **USER_POOL as default auth** (user-facing), **IAM as additional mode** (agent-to-agent / service), and a **Lambda Authorizer** for ABAC (returns `resolverContext.tenantId`/`role`). WAFv2 is **REGIONAL** and attached via `graphQLEndpointArn`. Caching is a **separate `CfnApiCache`** construct (GraphqlApi does not expose it inline).

**Subscription/mutation auth-mode rule (verified, mandatory):**
- User-facing queries/mutations/subscriptions → `@aws_cognito_user_pools`.
- Agent-to-agent / service publish (e.g. `publishAgentMessage`) → `@aws_iam`.
- Subscriptions use a **None data source**; the subscription resolver **must verify the tenant claim** from the JWT/`resolverContext` before returning data (tenant isolation).

```typescript
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';

const api = new appsync.GraphqlApi(this, 'CumplifyGraphQLApi', {
  name: 'CumplifyGraphQLApi',
  definition: appsync.Definition.fromFile('graphql/schema.graphql'),
  authorizationConfig: {
    defaultAuthorization: {
      authorizationType: appsync.AuthorizationType.USER_POOL,   // user-facing default
      userPoolConfig: {
        userPool: workforcePool,
        defaultAction: appsync.UserPoolDefaultAction.ALLOW,
        appIdClientRegex: workforceClient.userPoolClientId,
      },
    },
    additionalAuthorizationModes: [
      { authorizationType: appsync.AuthorizationType.IAM },     // agent/service-to-service (@aws_iam)
      {
        authorizationType: appsync.AuthorizationType.LAMBDA,    // ABAC tenantId/role
        lambdaAuthorizerConfig: {
          handler: lambdaAuthorizer,
          resultsCacheTtl: cdk.Duration.minutes(5),
        },
      },
    ],
  },
  xrayEnabled: true,
  logConfig: {
    fieldLogLevel: appsync.FieldLogLevel.ERROR,   // ERROR in prod — ALL logs PII payloads
    excludeVerboseContent: true,
    retention: logs.RetentionDays.SEVEN_YEARS,
  },
  introspectionConfig: appsync.IntrospectionConfig.DISABLED,    // disable in prod
  queryDepthLimit: 10,
});

// Subscriptions publish channel — None data source; agent publishes via @aws_iam mutation.
api.addNoneDataSource('AgentPubSub');

// REGIONAL WAFv2 for AppSync (NOT CloudFront scope) — attach via graphQLEndpointArn.
const appSyncWaf = new wafv2.CfnWebAcl(this, 'AppSyncWaf', {
  scope: 'REGIONAL',
  defaultAction: { allow: {} },
  rules: [ /* CommonRuleSet, RateLimitPerIP(2000/5min), IpReputationList */ ],
  visibilityConfig: { sampledRequestsEnabled: true, cloudWatchMetricsEnabled: true, metricName: 'AppSyncWaf' },
});
new wafv2.CfnWebAclAssociation(this, 'AppSyncWafAssoc', {
  resourceArn: api.graphQLEndpointArn,   // NOT api.arn (verified)
  webAclArn: appSyncWaf.attrArn,
});

// Caching — separate CfnApiCache (verified F-19 fix).
new appsync.CfnApiCache(this, 'ApiCache', {
  apiId: api.apiId,
  type: 'T2_SMALL',
  ttl: 300,
  apiCachingBehavior: 'PER_RESOLVER_CACHING',
  atRestEncryptionEnabled: true,
  transitEncryptionEnabled: true,
  healthMetricsConfig: 'ENABLED',
});
```

Lambda Authorizer response shape (ABAC):
```jsonc
{ "isAuthorized": true,
  "resolverContext": { "tenantId": "tnt-001", "role": "QualityManager", "sub": "..." },
  "ttlOverride": 300 }
```
The authorizer result is cached for `resultsCacheTtl` — do not return per-request dynamic data that must not be cached.

### 2.3 AI — Bedrock (22-agent roster)

Bedrock hosts the verified 22-agent roster. **Model IDs are exact and non-negotiable:**
- Nova Pro heavy agents (ControlTower, DocStudio, LeadAuditor, CAPAGuru, RiskSentinel, AspectWarden, HazardScout, IncidentInvestigator, ReviewOrchestrator, ComplianceCopilot): `amazon.nova-pro-v1:0` (cross-region `us.amazon.nova-pro-v1:0`).
- Nova Lite support agents (RecordsVault, ObjectiveTracker, ContextCartographer, SupplierScout, CompetenceKeeper, EmergencyPlanner, WorkerVoice, NCTriage): `amazon.nova-lite-v1:0` / `us.amazon.nova-lite-v1:0`.
- Claude Sonnet 4.6 advisory (3 Domain Gurus, LegalLedger): **NOT available in-region in us-east-1 — MUST use `us.anthropic.claude-sonnet-4-6`.**
- Embeddings: Titan Text v2 `amazon.titan-embed-text-v2:0` = **1024 dims**.

**Verified IAM rules:**
- `bedrock:InvokeModel` requires **Resource `'*'`** (no resource-level conditions on models).
- Every action-group Lambda needs a **resource-based policy for `bedrock.amazonaws.com`** scoped to the agent ARN.
- Guardrails use PII `ANONYMIZE`/`BLOCK` + `PROMPT_ATTACK`.
- Mutating actions pause the agent (HITL) and resume via `returnControlInvocationResults`.

```typescript
import * as bedrock from 'aws-cdk-lib/aws-bedrock';

// Supervisor agent — Nova Pro, cross-region profile.
const controlTower = new bedrock.CfnAgent(this, 'ControlTower', {
  agentName: 'CumplifyControlTower',
  foundationModel: 'us.amazon.nova-pro-v1:0',   // cross-region inference profile
  agentResourceRoleArn: agentRole.roleArn,
  instruction: 'You are the cross-standard IMS supervisor. Govern clauses 4.4, 5.1, 5.3 across ISO 9001/14001/45001...',
  idleSessionTtlInSeconds: 1800,
  knowledgeBases: [{ knowledgeBaseId: isoKb.attrKnowledgeBaseId,
                     description: 'ISO 9001/14001/45001 standards KB' }],
  guardrailConfiguration: { guardrailIdentifier: guardrail.attrGuardrailId, guardrailVersion: 'DRAFT' },
});

// Advisory Domain Guru — Claude Sonnet 4.6 MUST be cross-region.
new bedrock.CfnAgent(this, 'ISO45001Guru', {
  agentName: 'ISO45001DomainGuru',
  foundationModel: 'us.anthropic.claude-sonnet-4-6',  // in-region us-east-1 NOT available
  agentResourceRoleArn: guruRole.roleArn,
  instruction: 'Advisory Q&A on ISO 45001:2018 clauses (hazards, OH&S risks, workers, incidents)...',
});

// KB → OpenSearch Serverless + Titan Embed v2 (1024 dims).
const isoKb = new bedrock.CfnKnowledgeBase(this, 'ISOKb', {
  name: 'CumplifyISOKB',
  roleArn: kbRole.roleArn,
  knowledgeBaseConfiguration: {
    type: 'VECTOR',
    vectorKnowledgeBaseConfiguration: {
      embeddingModelArn: 'arn:aws:bedrock:us-east-1::foundation-model/amazon.titan-embed-text-v2:0',
      embeddingModelConfiguration: { bedrockEmbeddingModelConfiguration: { dimensions: 1024 } },
    },
  },
  storageConfiguration: {
    type: 'OPENSEARCH_SERVERLESS',
    opensearchServerlessConfiguration: {
      collectionArn: collection.attrArn,
      vectorIndexName: 'cumplify-iso-index',
      fieldMapping: { vectorField: 'vector', textField: 'text', metadataField: 'metadata' },
    },
  },
});

// Guardrail — PII anonymize/block + PROMPT_ATTACK (verified).
const guardrail = new bedrock.CfnGuardrail(this, 'Guardrail', {
  name: 'CumplifyGuardrail',
  blockedInputMessaging: 'I cannot process that request.',
  blockedOutputsMessaging: 'I cannot provide that information.',
  contentPolicyConfig: { filtersConfig: [
    { type: 'HATE', inputStrength: 'HIGH', outputStrength: 'HIGH' },
    { type: 'MISCONDUCT', inputStrength: 'HIGH', outputStrength: 'HIGH' },
    { type: 'PROMPT_ATTACK', inputStrength: 'HIGH', outputStrength: 'NONE' },
  ]},
  sensitiveInformationPolicyConfig: { piiEntitiesConfig: [
    { type: 'EMAIL', action: 'ANONYMIZE' },
    { type: 'NAME', action: 'ANONYMIZE' },
    { type: 'SSN', action: 'BLOCK' },
    { type: 'CREDIT_DEBIT_CARD_NUMBER', action: 'BLOCK' },
  ]},
});

// Action-group Lambda resource-based policy — REQUIRED so Bedrock can invoke it.
capaActionLambda.addPermission('AllowBedrock', {
  principal: new iam.ServicePrincipal('bedrock.amazonaws.com'),
  action: 'lambda:InvokeFunction',
  sourceArn: `arn:aws:bedrock:us-east-1:${this.account}:agent/${controlTower.attrAgentId}`,
});
```

**Orchestration:** ControlTower is the Bedrock multi-agent-collaboration **supervisor**. Event-driven fan-out is via EventBridge + SQS (§2.7). Verified chains — `NCTriage→CAPAGuru→RecordsVault`, `LeadAuditor→CAPAGuru`, `HazardScout→RiskSentinel→CAPAGuru`, `AspectWarden→RiskSentinel` — are implemented as EventBridge rules routing to per-agent SQS queues, not synchronous coupling.

### 2.4 Vector Search — OpenSearch Serverless (VECTORSEARCH, NextGen scale-to-zero)

`CfnCollection` type **VECTORSEARCH** backs the Bedrock KB (ISO standards + tenant docs), compliance-document semantic search, and audit-trail retrieval. **Three policies are required** (encryption, network, data-access) and the **Bedrock service role MUST be a Principal in the data-access policy** (verified — without it, KB sync fails).

> **45-second cold-start rule (mandatory for every AOSS reader).** NextGen scale-to-zero means a cold collection can take **up to 45 seconds** to serve the first request. **Every data-access path to AOSS MUST implement application-side retry with exponential backoff and a minimum 45-second cold-start timeout budget.** This applies to the KB sync path, the semantic-search Lambdas, and audit-trail retrieval alike.

```typescript
import * as aoss from 'aws-cdk-lib/aws-opensearchserverless';

const collection = new aoss.CfnCollection(this, 'ISOCollection', {
  name: 'cumplify-iso-kb',
  type: 'VECTORSEARCH',
  standbyReplicas: 'ENABLED',   // prod; DISABLED in dev to scale to zero / save cost
});

// 1) Encryption policy (required)
const enc = new aoss.CfnSecurityPolicy(this, 'EncPolicy', {
  name: 'cumplify-kb-enc', type: 'encryption',
  policy: JSON.stringify({
    Rules: [{ ResourceType: 'collection', Resource: ['collection/cumplify-iso-kb'] }],
    KmsARN: bedrockKmsKey.keyArn,   // CMK from SecurityStack
  }),
});
// 2) Network policy (required) — private via VPC endpoint (no public access).
const net = new aoss.CfnSecurityPolicy(this, 'NetPolicy', {
  name: 'cumplify-kb-net', type: 'network',
  policy: JSON.stringify([{
    Rules: [
      { ResourceType: 'collection', Resource: ['collection/cumplify-iso-kb'] },
      { ResourceType: 'dashboard',  Resource: ['collection/cumplify-iso-kb'] },
    ],
    AllowFromPublic: false,
    SourceVPCEs: [aossVpcEndpoint.attrId],
  }]),
});
// 3) Data-access policy (required) — Bedrock role MUST be a Principal.
const dataAccess = new aoss.CfnAccessPolicy(this, 'DataAccessPolicy', {
  name: 'cumplify-kb-access', type: 'data',
  policy: JSON.stringify([{
    Rules: [
      { ResourceType: 'index', Resource: ['index/cumplify-iso-kb/*'],
        Permission: ['aoss:CreateIndex','aoss:DescribeIndex','aoss:UpdateIndex','aoss:ReadDocument','aoss:WriteDocument'] },
      { ResourceType: 'collection', Resource: ['collection/cumplify-iso-kb'],
        Permission: ['aoss:DescribeCollectionItems','aoss:CreateCollectionItems','aoss:UpdateCollectionItems'] },
    ],
    Principal: [kbRole.roleArn, searchLambdaRole.roleArn],  // Bedrock KB role in here (verified)
  }]),
});
collection.addDependency(enc); collection.addDependency(net); collection.addDependency(dataAccess);
```

AOSS client config in every reader Lambda (verified 45s budget):
```typescript
// Data-plane IAM: aoss:APIAccessAll on the collection ARN.
// Client MUST honor the 45s cold-start budget with exponential backoff.
const aossClient = new Client({
  ...AwsSigv4Signer({ region: 'us-east-1', service: 'aoss', getCredentials }),
  node: collectionEndpoint,
  requestTimeout: 50_000,          // > 45s cold-start budget
  maxRetries: 6,                   // exponential backoff across the 45s window
});
```

### 2.5 Metadata Store — DynamoDB (single-table `CumplifyCore`)

`TableV2`, on-demand, **customer-managed KMS**, PITR, deletion protection, **9 GSIs**. Holds tenant/user metadata, agent sessions, idempotency, rate limits, and the **append-only immutable audit-event mirror**. Tenant isolation is enforced by **`dynamodb:LeadingKeys` ABAC** with `ForAllValues:StringLike` against `aws:PrincipalTag/tenantId`.

**Two verified hard rules:**
1. **6 KMS actions** on the CMK for any Lambda touching the table — `Encrypt, Decrypt, ReEncrypt*, GenerateDataKey*, DescribeKey, CreateGrant`. Missing any one → KMS `AccessDenied` (error blames KMS, not DynamoDB).
2. **LeadingKeys uses `ForAllValues:StringLike`** (not `StringEquals`) so the `TENANT#...*` prefix wildcard matches all SKs in the tenant partition.

```typescript
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

const table = new dynamodb.TableV2(this, 'CumplifyCore', {
  tableName: 'CumplifyCore',
  partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
  sortKey:      { name: 'sk', type: dynamodb.AttributeType.STRING },
  billing: dynamodb.Billing.onDemand(),
  encryption: dynamodb.TableEncryptionV2.customerManagedKey(dynamoKmsKey),
  pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
  deletionProtection: true,
  removalPolicy: cdk.RemovalPolicy.RETAIN,
  dynamoStream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,  // records retained 24h only
  replicas: [{ region: 'us-east-1' }, { region: 'us-west-2' }],  // Global Table DR
  globalSecondaryIndexes: [ /* 9 GSIs: gsi1..gsi9, overloaded pk/sk */ ],
});
```

Per-Lambda ABAC + 6 KMS actions (attach to every handler role that reads/writes the table):
```typescript
lambdaRole.addToPolicy(new iam.PolicyStatement({
  actions: ['dynamodb:GetItem','dynamodb:PutItem','dynamodb:UpdateItem','dynamodb:DeleteItem',
            'dynamodb:Query','dynamodb:BatchGetItem','dynamodb:BatchWriteItem'],
  resources: [table.tableArn, `${table.tableArn}/index/*`],
  conditions: { 'ForAllValues:StringLike': {
    'dynamodb:LeadingKeys': ['TENANT#${aws:PrincipalTag/tenantId}*'] } },  // tenant ABAC
}));
lambdaRole.addToPolicy(new iam.PolicyStatement({
  actions: ['kms:Encrypt','kms:Decrypt','kms:ReEncrypt*','kms:GenerateDataKey*','kms:DescribeKey','kms:CreateGrant'],
  resources: [dynamoKmsKey.keyArn],   // all 6 — missing one = KMS AccessDenied (verified)
}));
```

Idempotency: mutating handlers use `PutItem` with `ConditionExpression: 'attribute_not_exists(pk)'`; treat `ConditionalCheckFailedException` as "already processed," not an error. The append-only audit mirror never issues `UpdateItem`/`DeleteItem` on audit items — write-once, sealed to S3 Object Lock (§2.8).

### 2.6 System of Record — RDS PostgreSQL (in VPC, Secrets Manager rotation)

RDS PostgreSQL is the relational **system-of-record for ISO domain entities** — the registers with rich relationships/joins/reporting (legal register, aspects/impacts, hazard register, objectives, suppliers, competence, CAPA relations). It lives in **private subnets** with credentials in **Secrets Manager with rotation** encrypted by the secrets CMK.

```typescript
import * as rds from 'aws-cdk-lib/aws-rds';

const dbSecret = new secretsmanager.Secret(this, 'DbSecret', {
  secretName: `/cumplify/${envName}/rds/master`,
  encryptionKey: secretsKmsKey,
  generateSecretString: {
    secretStringTemplate: JSON.stringify({ username: 'cumplify_admin' }),
    generateStringKey: 'password',
    excludeCharacters: '"@/\\',
    passwordLength: 32,
  },
  removalPolicy: cdk.RemovalPolicy.RETAIN,
  replicaRegions: [{ region: 'us-west-2' }],   // DR
});

const cluster = new rds.DatabaseCluster(this, 'IsoSor', {
  engine: rds.DatabaseClusterEngine.auroraPostgres({ version: rds.AuroraPostgresEngineVersion.VER_16_4 }),
  vpc, vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
  credentials: rds.Credentials.fromSecret(dbSecret),
  storageEncrypted: true,
  storageEncryptionKey: rdsKmsKey,     // dedicated CMK (or reuse per key policy)
  writer: rds.ClusterInstance.serverlessV2('Writer'),
  readers: [rds.ClusterInstance.serverlessV2('Reader', { scaleWithWriter: true })],
  deletionProtection: true,
  removalPolicy: cdk.RemovalPolicy.RETAIN,
});

// Native Secrets Manager rotation (30-day) — CDK wires the rotation Lambda + schedule.
cluster.addRotationSingleUser({ automaticallyAfter: cdk.Duration.days(30) });
```

> **Justification note (within stack):** `rds.DatabaseCluster` (Aurora Serverless v2 PostgreSQL) is the CDK construct for the verified "RDS PostgreSQL" line item; serverless v2 is chosen for cost elasticity per tenant load. No new service introduced. Lambdas reach RDS over the VPC; the Lambda role gets `secretsmanager:GetSecretValue` on the `-*`-suffixed secret ARN (Secrets Manager ARNs carry a 6-char random suffix — use the wildcard).

ElastiCache (Redis) caches hot compliance registers (legal register, approved-supplier list, hazard register, objectives dashboard) in the same VPC/private subnets; use `elasticache.CfnReplicationGroup` with `atRestEncryptionEnabled`/`transitEncryptionEnabled: true` and the SecurityStack CMK.

### 2.7 Eventing — SQS + DLQ + EventBridge

Event-driven agent orchestration uses **3 EventBridge buses** (`cumplify.app.*`, `cumplify.security.*`, `cumplify.safety.*`) and per-agent **SQS queues, each with a DLQ** (Cumplify rule: always configure a DLQ — also satisfies CDK Nag `SQS3`). Queues and buses are KMS-encrypted and `enforceSSL: true`.

```typescript
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';

const dlq = new sqs.Queue(this, 'CapaDlq', {
  retentionPeriod: cdk.Duration.days(14),
  encryption: sqs.QueueEncryption.KMS, encryptionMasterKey: sqsKmsKey, enforceSSL: true,
});
const capaQueue = new sqs.Queue(this, 'CapaQueue', {
  visibilityTimeout: cdk.Duration.seconds(90),   // MUST be >= consumer Lambda timeout
  encryption: sqs.QueueEncryption.KMS, encryptionMasterKey: sqsKmsKey, enforceSSL: true,
  receiveMessageWaitTime: cdk.Duration.seconds(20),
  deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
});

const appBus = new events.EventBus(this, 'AppBus', {
  eventBusName: 'CumplifyAppBus', kmsKey: eventBridgeKmsKey, deadLetterQueue: dlq,
});

// Verified chain NCTriage → CAPAGuru: nonconformity events route to CAPAGuru's queue.
new events.Rule(this, 'NcToCapa', {
  eventBus: appBus,
  eventPattern: { source: ['cumplify.app'], detailType: ['nonconformity.triaged'],
                  detail: { tenantId: [{ exists: true }] } },
  targets: [ new targets.SqsQueue(capaQueue, { deadLetterQueue: dlq }) ],
});
```

SQS→Lambda ESM: set `reportBatchItemFailures: true` for partial-batch retry; keep queue `visibilityTimeout >= Lambda timeout + buffer` or messages get reprocessed. ReviewOrchestrator's parallel 9.3.2 fan-out is modeled as one rule → multiple agent queues.

### 2.8 Storage/CDN — S3 Object Lock COMPLIANCE + CloudFront OAC

WORM document/evidence storage and the **sealed audit-event archive** use **S3 Object Lock COMPLIANCE mode** (7-year / 2555-day default retention). COMPLIANCE mode = **nobody, including root, can delete before expiry** — the only path is deleting the account. Object Lock **requires versioning**. CloudFront delivers via **OAC** (required because buckets are KMS-CMK encrypted; **OAI does not support SSE-KMS**).

```typescript
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';

const evidenceVault = new s3.Bucket(this, 'EvidenceVault', {
  objectLockEnabled: true,
  objectLockDefaultRetention: s3.ObjectLockRetention.compliance(cdk.Duration.days(2555)), // 7yr
  versioned: true,                     // required for Object Lock
  encryption: s3.BucketEncryption.KMS, encryptionKey: s3GeneralKmsKey, bucketKeyEnabled: true,
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
  serverAccessLogsPrefix: 'access-logs/',   // satisfies CDK Nag S1
  eventBridgeEnabled: true,
  removalPolicy: cdk.RemovalPolicy.RETAIN, autoDeleteObjects: false,
});

const distribution = new cloudfront.Distribution(this, 'AppDist', {
  defaultBehavior: {
    origin: origins.S3BucketOrigin.withOriginAccessControl(staticBucket, {
      originAccessLevels: [cloudfront.AccessLevel.READ],   // OAC — supports SSE-KMS (OAI does not)
    }),
    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
    responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
  },
  additionalBehaviors: {
    '/api/*': { origin: new origins.HttpOrigin('api.cumplify.ai', { protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY }),
                cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED },
  },
  domainNames: ['cumplify.ai', 'www.cumplify.ai'],
  certificate: acmCertUsEast1,                       // ACM MUST be us-east-1 for CloudFront
  minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
  httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
  webAclId: cloudfrontWaf.attrArn,                   // CLOUDFRONT-scope WebACL in us-east-1
});
```

> **Two scope facts to keep straight:** the CloudFront WebACL is **CLOUDFRONT scope in us-east-1**; the AppSync WebACL (§2.2) is **REGIONAL**. The ACM cert for CloudFront must be in **us-east-1** regardless of where traffic is served. Presigned evidence URLs signed by a Lambda role expire when the **STS session** expires, even if a longer `expiresIn` is requested — size the session accordingly.

### 2.9 Long-Running Orchestration — ECS/Fargate

Long-running / fan-out agent orchestration that exceeds Lambda's 15-minute ceiling (e.g. ReviewOrchestrator gathering 9.3.2 inputs across many agents in parallel, LeadAuditor bulk checklist generation) runs on **ECS/Fargate** in private subnets. The task role gets the same tenant-scoped Bedrock/DynamoDB/AOSS permissions (with the 45s AOSS budget and 6 KMS actions), and secrets injected from Secrets Manager.

```typescript
import * as ecs from 'aws-cdk-lib/aws-ecs';

const cluster = new ecs.Cluster(this, 'AgentCluster', { vpc, containerInsightsV2: ecs.ContainerInsights.ENABLED });

const taskDef = new ecs.FargateTaskDefinition(this, 'OrchestratorTask', {
  cpu: 1024, memoryLimitMiB: 2048,
  taskRole: orchestratorTaskRole,        // tenant-scoped: Bedrock '*', DDB LeadingKeys, AOSS APIAccessAll, 6 KMS
});
taskDef.addContainer('Orchestrator', {
  image: ecs.ContainerImage.fromEcrRepository(repo, 'latest'),
  logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'orchestrator', logRetention: logs.RetentionDays.SEVEN_YEARS }),
  secrets: { DB_CREDS: ecs.Secret.fromSecretsManager(dbSecret) },
});
new ecs.FargateService(this, 'OrchestratorSvc', {
  cluster, taskDefinition: taskDef, desiredCount: 2,
  vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
});
```

---

## 3. IAM Permission Boundaries — Per Module & Per Agent

Cumplify enforces **defense in depth**: every module Lambda and every agent role runs under a **permission boundary** that caps its maximum privilege, *and* tenant isolation is enforced at request time via **`dynamodb:LeadingKeys` + `aws:PrincipalTag/tenantId`** session tags.

### 3.1 Baseline permission boundary (applies to all module/agent roles)

```typescript
const cumplifyBoundary = new iam.ManagedPolicy(this, 'CumplifyBoundary', {
  managedPolicyName: `cumplify-${envName}-boundary`,
  statements: [
    // Allow only the services in the verified stack.
    new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: [
      'dynamodb:*','bedrock:*','aoss:*','s3:*','sqs:*','events:*','secretsmanager:GetSecretValue',
      'kms:Encrypt','kms:Decrypt','kms:ReEncrypt*','kms:GenerateDataKey*','kms:DescribeKey','kms:CreateGrant',
      'logs:*','xray:*','ses:SendEmail','rds-db:connect','elasticache:*','appsync:*','cognito-idp:Admin*',
    ], resources: ['*'] }),
    // Hard deny: any tenant DynamoDB access NOT scoped by the caller's tenant tag.
    new iam.PolicyStatement({ effect: iam.Effect.DENY,
      actions: ['dynamodb:GetItem','dynamodb:PutItem','dynamodb:UpdateItem','dynamodb:DeleteItem','dynamodb:Query'],
      resources: [table.tableArn],
      conditions: { 'ForAllValues:StringNotLike': {
        'dynamodb:LeadingKeys': ['TENANT#${aws:PrincipalTag/tenantId}*'] } } }),
    // Deny anything outside the verified service set (belt-and-suspenders).
    new iam.PolicyStatement({ effect: iam.Effect.DENY,
      notActions: ['dynamodb:*','bedrock:*','aoss:*','s3:*','sqs:*','events:*','secretsmanager:*','kms:*',
                   'logs:*','xray:*','ses:*','rds-db:*','elasticache:*','appsync:*','cognito-idp:*','ecs:*'],
      resources: ['*'] }),
  ],
});
// Attach to every module/agent role:  new iam.Role(this, 'X', { permissionsBoundary: cumplifyBoundary, ... })
```

### 3.2 Per-module boundaries (13 modules)

Grant each module role only the resources it owns. Boundaries below are illustrative of the tightening applied per module (each also inherits §3.1 and the tenant tag condition):

| Module | Owns (clauses) | Resource grants |
|--------|----------------|-----------------|
| M1 Document Studio | 4.3, 5.2, 7.5 (all 3) | RDS docs schema, S3 doc bucket (OAC), DDB doc items, AOSS read (45s budget) |
| M2 CAPA | 8.7(9001), 10.2 (all 3, incl. 45001 incident) | RDS capa schema, DDB capa items, CapaQueue consume, EventBridge put |
| M3 Audit Studio | 9.2 (all 3) | RDS audit schema, S3 evidence (Object Lock), DDB audit items |
| M4 Records Mgmt | 7.5, 7.1.5 (9001 calibration) | S3 Object Lock COMPLIANCE (WORM), DDB append-only audit mirror (no Update/Delete) |
| M5 Risk Mgmt | 6.1 (all 3), 6.3(9001)/8.1.3(45001) | RDS risk register, ElastiCache hazard/risk cache |
| M6 Context & Stakeholder | 4.1, 4.2 (all 3), 7.4 | RDS context schema, AppSync subscriptions (comms) |
| M7 Objectives & Targets | 6.2 (all 3), 9.1.1 | RDS objectives, ElastiCache objectives dashboard |
| M8 Compliance Obligations (Legal Register) | 14001 6.1.3, 45001 6.1.3, 9.1.2 | RDS legal register, ElastiCache legal register cache |
| M9 EnviroStudio | 14001 6.1.2, 8.1, 8.2, 9.1.1 | RDS aspects/impacts, DDB monitoring items |
| M10 Safety Ops | 45001 6.1.2, 8.1.2/8.1.3/8.1.4, 8.2, 10.2, 5.4 | RDS hazard register, ElastiCache hazard cache, safety EventBridge bus |
| M11 Management Review | 9.3 (all 3) | RDS review schema, EventBridge fan-out consume (9.3.2 inputs) |
| M12 Supplier & External Provider | 8.4(9001), 14001 8.1, 45001 8.1.4 | RDS supplier register, ElastiCache approved-supplier list |
| M13 Competence & Training | 7.2, 7.3 (all 3) | RDS competence schema, DDB training/expiry items |

### 3.3 Per-agent boundaries (22 agents)

Every agent role includes `bedrock:InvokeModel` on Resource `'*'` (models don't support resource conditions), plus **only** the module resources it owns. Model ID is pinned per agent.

| Agent | Model ID | Scoped resource grants |
|-------|----------|------------------------|
| ControlTower (supervisor) | `us.amazon.nova-pro-v1:0` | `bedrock:InvokeAgent` to all agents; cross-standard governance read on RDS/DDB |
| DocStudio | `us.amazon.nova-pro-v1:0` | M1 grants |
| LeadAuditor | `us.amazon.nova-pro-v1:0` | M3 grants; publishes findings → CAPAGuru queue |
| CAPAGuru | `us.amazon.nova-pro-v1:0` | M2 grants; consumes CapaQueue |
| RecordsVault | `us.amazon.nova-lite-v1:0` | M4, M13 grants; S3 Object Lock read |
| ISO9001 / ISO14001 / ISO45001 Domain Gurus | `us.anthropic.claude-sonnet-4-6` | advisory: AOSS read only (45s budget), no writes |
| RiskSentinel | `us.amazon.nova-pro-v1:0` | M5 grants |
| AspectWarden | `us.amazon.nova-pro-v1:0` | M9 grants; publishes → RiskSentinel |
| HazardScout | `us.amazon.nova-pro-v1:0` | M10 grants; publishes → RiskSentinel |
| IncidentInvestigator | `us.amazon.nova-pro-v1:0` | M2, M10 grants |
| LegalLedger | `us.anthropic.claude-sonnet-4-6` | M8 grants |
| ObjectiveTracker | `us.amazon.nova-lite-v1:0` | M7 grants |
| ReviewOrchestrator | `us.amazon.nova-pro-v1:0` | M11 grants; Fargate task role for parallel fan-out |
| ContextCartographer | `us.amazon.nova-lite-v1:0` | M6 grants |
| SupplierScout | `us.amazon.nova-lite-v1:0` | M12 grants |
| CompetenceKeeper | `us.amazon.nova-lite-v1:0` | M13 grants |
| EmergencyPlanner | `us.amazon.nova-lite-v1:0` | M9, M10 grants (14001 8.2 / 45001 8.2) |
| WorkerVoice | `us.amazon.nova-lite-v1:0` | M10 grants (45001 5.4 only) |
| NCTriage | `us.amazon.nova-lite-v1:0` | M2 grants; feeds CAPAGuru |
| ComplianceCopilot | `us.amazon.nova-pro-v1:0` | routes to 3 Domain Gurus (advisory) |

Agent-to-agent invocation flows over AppSync using the **IAM auth mode** (`@aws_iam`) or `bedrock:InvokeAgent`; user-facing calls use the **USER_POOL** mode (`@aws_cognito_user_pools`). Mutating agent actions pause for **HITL** and resume via `returnControlInvocationResults`.

---

## 4. CDK Nag, Bootstrap & Cross-Account Trust

```typescript
import { Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';

Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));  // warnings = failures (Cumplify rule)

// Every suppression MUST document a reason (example: Bedrock InvokeModel wildcard is unavoidable).
NagSuppressions.addResourceSuppressions(agentRole, [{
  id: 'AwsSolutions-IAM5',
  reason: 'bedrock:InvokeModel requires Resource "*"; models do not support resource-level conditions (verified).',
  appliesTo: ['Resource::*'],
}]);
```

Relevant Nag rules to expect and how the constructs above satisfy them: `IAM5` (wildcards — suppress with reason only where verified-mandatory, e.g. Bedrock), `SQS3` (DLQ — always configured, §2.7), `DDB3` (PITR — enabled, §2.5), `S1` (S3 access logging — `serverAccessLogsPrefix`, §2.8), `COG4` (Cognito advanced security — `FeaturePlan.PLUS`, §2.1), `L1` (Node 22 LTS — suppress with reason if Nag lags the runtime).

CI/CD chain (verified PHASE-19): `synth (npm ci/test/audit/cdk synth/CDK Nag) → self-mutate → Dev → ManualApproval + SmokeTest → Staging → LegalSignoffGuard (hard gate) → Prod → RollbackInitiator (auto-rollback on alarm)`.

---

## 5. Appendix — Construct-to-Clause / Construct-to-Module Traceability

| Layer / Construct | Serves modules | Serves clauses (with terminology kept distinct) |
|-------------------|----------------|--------------------------------------------------|
| Cognito 3 User Pools + groups | all | 5.3 roles/responsibilities/authorities (all 3); role gating for Quality/EHS/Auditor/Employee/Executive |
| AppSync GraphqlApi + subscriptions | all | user-facing IMS surface; agent comms; 7.4 Communication (all 3) |
| Bedrock CfnAgent roster | M1–M13 | detect→draft→route→verify→close across 9001 (product/customer), 14001 (aspects/impacts/obligations), 45001 (hazards/workers/incidents) |
| Bedrock CfnKnowledgeBase + Titan v2 (1024) | advisory | ISO 9001/14001/45001 clause Q&A grounding |
| OpenSearch VECTORSEARCH (45s budget) | M1, M4 | compliance-doc semantic search + audit-trail retrieval |
| DynamoDB CumplifyCore (LeadingKeys) | M4 | 7.5 control of documented information; **immutable audit trail** (append-only mirror) |
| RDS PostgreSQL (system of record) | M5, M7, M8, M9, M10, M12, M13, M2 | ISO domain registers with relationships/joins/reporting |
| ElastiCache Redis | M5, M8, M10, M7, M12 | hot registers: legal register, approved-supplier list, hazard register, objectives dashboard |
| S3 Object Lock COMPLIANCE + CloudFront OAC | M1, M3, M4 | WORM evidence/records; sealed audit archive; 7.1.5 calibration records (9001) |
| SQS + DLQ + EventBridge (3 buses) | M2, M10, M11 | agent chains (NCTriage→CAPAGuru→RecordsVault; HazardScout→RiskSentinel→CAPAGuru); 9.3.2 parallel input gathering |
| ECS/Fargate | M11, M3 | long-running 9.3 (all 3) input fan-out; bulk 9.2 checklist generation |

**Terminology guardrail honored throughout:** Quality = ISO 9001:2015 (product/service conformity, customer); Environmental = ISO 14001:2015 (environmental aspects, impacts, compliance obligations); OH&S = ISO 45001:2018 (hazards, OH&S risks, workers, incidents — clause 5.4 Consultation and participation of workers and clause 10.2 Incident, nonconformity and corrective action are unique to 45001). No clause number in this document is invented; all trace to the canonical Annex SL HLS structure in the spine.
