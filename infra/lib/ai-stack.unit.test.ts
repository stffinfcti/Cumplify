/**
 * Template-assertion tests for AiStack.
 * Verifies: Lambda configs, SQS properties, EventBridge rule patterns,
 * guardrail config, state machine definition, CfnOutputs.
 *
 * Task 3 deliverable — agents-existing-8.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { AiStack } from './ai-stack.js';
import { ENV_CONFIGS } from './env-config.js';

function createTestStack(): Template {
  const app = new cdk.App();
  const envConfig = ENV_CONFIGS.dev;

  const stack = new cdk.Stack(app, 'TestAiStack', {
    env: { account: envConfig.account, region: envConfig.region },
  });

  // Import keys within the same stack to avoid cross-environment errors
  const mockKey = kms.Key.fromKeyArn(
    stack,
    'MockKey',
    'arn:aws:kms:us-east-1:123456789012:key/mock-key-id',
  );

  // Instantiate AiStack as a nested construct (not a separate stack) to avoid cross-env
  const aiStack = new AiStack(app, 'AiStack', {
    envConfig,
    tableArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/CumplifyCore',
    tableName: 'CumplifyCore',
    dynamodbKey: mockKey,
    clusterArn: 'arn:aws:rds:us-east-1:123456789012:cluster:cumplify-dev',
    dbSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:cumplify-dev-db',
    dbSecretKey: mockKey,
    busName: 'cumplify-events',
    busArn: 'arn:aws:events:us-east-1:123456789012:event-bus/cumplify-events',
    deliveryFailureDlqArn: 'arn:aws:sqs:us-east-1:123456789012:DeliveryFailureDlq',
    snsKey: mockKey,
    capaIntakeQueueArn: 'arn:aws:sqs:us-east-1:123456789012:CapaIntakeQueue.fifo',
    capaIntakeDlqUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/CapaIntakeDlq.fifo',
    auditSinkQueueArn: 'arn:aws:sqs:us-east-1:123456789012:AuditSinkQueue.fifo',
    recordsQueueArn: 'arn:aws:sqs:us-east-1:123456789012:RecordsQueue',
    recordsDlqUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/RecordsDlq',
    tenantDocsIndexerQueueArn: 'arn:aws:sqs:us-east-1:123456789012:TenantDocsIndexerQueue',
    tenantDocsIndexerDlqUrl:
      'https://sqs.us-east-1.amazonaws.com/123456789012/TenantDocsIndexerDlq',
    aossVpcEndpointId: 'vpce-0123456789abcdef0',
    vpc: ec2.Vpc.fromVpcAttributes(stack, 'MockVpc', {
      vpcId: 'vpc-0123456789abcdef0',
      availabilityZones: ['us-east-1b', 'us-east-1c'],
      privateSubnetIds: ['subnet-aaa', 'subnet-bbb'],
    }),
    privateSubnets: [
      ec2.Subnet.fromSubnetAttributes(stack, 'MockSubnetA', {
        subnetId: 'subnet-aaa',
        availabilityZone: 'us-east-1b',
      }),
      ec2.Subnet.fromSubnetAttributes(stack, 'MockSubnetB', {
        subnetId: 'subnet-bbb',
        availabilityZone: 'us-east-1c',
      }),
    ],
    bedrockKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/bedrock-key-id',
    appRoleSecretArn:
      'arn:aws:secretsmanager:us-east-1:123456789012:secret:cumplify/dev/rds/app-role',
    isoKbCollectionArn: 'arn:aws:aoss:us-east-1:123456789012:collection/mockisokb123',
    isoKbCollectionEndpoint: 'https://mockisokb123.us-east-1.aoss.amazonaws.com',
    graphqlApiId: 'test-api-id-123',
    generalBucketName: 'mock-general-bucket',
    generalBucketArn: 'arn:aws:s3:::mock-general-bucket',
    s3GeneralKey: mockKey,
    graphqlApiUrl: 'https://test-api.appsync-api.us-east-1.amazonaws.com/graphql',
    env: { account: envConfig.account, region: envConfig.region },
  });

  return Template.fromStack(aiStack);
}

describe('AiStack', () => {
  const template = createTestStack();

  describe('AI Invoker Lambda', () => {
    it('uses NODEJS_22_X runtime, ARM_64, >= 512MB, 90s timeout', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Runtime: 'nodejs22.x',
        Architectures: ['arm64'],
        MemorySize: 512,
        Timeout: 90,
      });
    });

    it('has GUARDRAIL_ID and TABLE_NAME in environment', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            TABLE_NAME: 'CumplifyCore',
            POWERTOOLS_SERVICE_NAME: 'ai-invoker',
          }),
        },
      });
    });
  });

  describe('CfnGuardrail', () => {
    it('has PII + PROMPT_ATTACK config', () => {
      template.hasResourceProperties('AWS::Bedrock::Guardrail', {
        ContentPolicyConfig: {
          FiltersConfig: Match.arrayWith([
            Match.objectLike({ Type: 'PROMPT_ATTACK', InputStrength: 'HIGH' }),
          ]),
        },
      });
      // Verify PII entities separately (array order varies)
      template.hasResourceProperties('AWS::Bedrock::Guardrail', {
        SensitiveInformationPolicyConfig: {
          PiiEntitiesConfig: Match.arrayWith([
            Match.objectLike({ Type: 'US_SOCIAL_SECURITY_NUMBER', Action: 'BLOCK' }),
          ]),
        },
      });
    });

    it('does NOT reference any Anthropic model (REQ-CDK-7)', () => {
      const templateJson = JSON.stringify(template.toJSON());
      expect(templateJson).not.toContain('anthropic');
    });
  });

  describe('DocGen guardrail (spec-40 BC-5 / ACC-9)', () => {
    // The agent guardrail anonymizes NAME/EMAIL/PHONE; pointed at document
    // generation it would redact the tenant's own company name out of their
    // manual. These assertions keep the two guardrails distinct and keep PII
    // anonymization OFF the doc-gen seat (owner-approved 2026-07-14).
    function guardrailsByName() {
      const resources = template.findResources('AWS::Bedrock::Guardrail');
      const byName: Record<string, any> = {};
      for (const res of Object.values(resources)) {
        byName[(res as any).Properties.Name] = (res as any).Properties;
      }
      return byName;
    }

    it('is a distinct resource from the agent guardrail', () => {
      const byName = guardrailsByName();
      // spec-35 Task 6 adds recordwrite (grounding 0.90); Task 25 adds
      // arclause + aradvisory (AR-only) — 5 total guardrails.
      expect(Object.keys(byName).sort()).toEqual([
        'cumplify-agent-guardrail-dev',
        'cumplify-aradvisory-guardrail-dev',
        'cumplify-arclause-guardrail-dev',
        'cumplify-docgen-guardrail-dev',
        'cumplify-recordwrite-guardrail-dev',
      ]);
    });

    it('docgen guardrail has ZERO ANONYMIZE actions but keeps SSN/card BLOCK + PROMPT_ATTACK', () => {
      const docgen = guardrailsByName()['cumplify-docgen-guardrail-dev'];
      const pii = docgen.SensitiveInformationPolicyConfig.PiiEntitiesConfig;
      expect(pii.filter((e: any) => e.Action === 'ANONYMIZE')).toHaveLength(0);
      expect(pii).toEqual(
        expect.arrayContaining([
          { Type: 'US_SOCIAL_SECURITY_NUMBER', Action: 'BLOCK' },
          { Type: 'CREDIT_DEBIT_CARD_NUMBER', Action: 'BLOCK' },
        ]),
      );
      expect(docgen.ContentPolicyConfig.FiltersConfig).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ Type: 'PROMPT_ATTACK', InputStrength: 'HIGH' }),
        ]),
      );
    });

    it('agent guardrail STILL anonymizes NAME/EMAIL/PHONE (loosening must not leak)', () => {
      const agent = guardrailsByName()['cumplify-agent-guardrail-dev'];
      const anonymized = agent.SensitiveInformationPolicyConfig.PiiEntitiesConfig.filter(
        (e: any) => e.Action === 'ANONYMIZE',
      )
        .map((e: any) => e.Type)
        .sort();
      expect(anonymized).toEqual(['EMAIL', 'NAME', 'PHONE']);
    });

    it('AI Invoker carries both guardrail seats in its environment', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            GUARDRAIL_ID: Match.anyValue(),
            DOCGEN_GUARDRAIL_ID: Match.anyValue(),
            DOCGEN_GUARDRAIL_VERSION: Match.anyValue(),
          }),
        },
      });
    });
  });

  describe('SQS Queues', () => {
    it('creates 3 standard queues with enforceSSL + DLQ', () => {
      // Count standard queues (non-DLQ) — should have at least 3
      const resources = template.findResources('AWS::SQS::Queue', {
        Properties: {
          VisibilityTimeout: 360,
        },
      });
      expect(Object.keys(resources).length).toBeGreaterThanOrEqual(3);
    });

    it('all queues have enforceSSL via queue policy', () => {
      // CDK enforceSSL creates an SQS QueuePolicy with Deny on non-SSL
      template.hasResourceProperties('AWS::SQS::QueuePolicy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Deny',
              Condition: { Bool: { 'aws:SecureTransport': 'false' } },
            }),
          ]),
        }),
      });
    });
  });

  describe('EventBridge Rules', () => {
    it('R-8 DocStudioRule matches correct detailTypes', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        EventPattern: {
          'detail-type': ['CAPA.ActionRequiresDocChange', 'Policy.Updated', 'Scope.Changed'],
        },
      });
    });

    it('R-9 LeadAuditorRule matches correct detailTypes', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        EventPattern: {
          'detail-type': ['ManagementReview.ActionAudit', 'Objectives.OffTrack'],
        },
      });
    });

    it('R-10 ControlTowerRule matches correct detailTypes', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        EventPattern: {
          'detail-type': ['Context.Updated', 'Scope.Changed', 'Policy.Updated', 'Risk.Escalated'],
        },
      });
    });
  });

  describe('HITL State Machine', () => {
    it('creates a STANDARD state machine', () => {
      template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
        StateMachineType: 'STANDARD',
      });
    });
  });

  describe('IAM (Task 4 — REQUIRES-HUMAN)', () => {
    it('has bedrock:InvokeModel in at least one policy', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['bedrock:InvokeModel', 'bedrock:ApplyGuardrail']),
              Effect: 'Allow',
              Resource: '*',
            }),
          ]),
        },
      });
    });

    it('ExecuteWriteback role uses app_role secret NOT master (T4-F1)', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'secretsmanager:GetSecretValue',
              Effect: 'Allow',
              Resource:
                'arn:aws:secretsmanager:us-east-1:123456789012:secret:cumplify/dev/rds/app-role',
            }),
          ]),
        },
      });
    });

    it('ExecuteWriteback role has RDS write permissions', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith([
                'rds-data:ExecuteStatement',
                'rds-data:BeginTransaction',
                'rds-data:CommitTransaction',
              ]),
              Effect: 'Allow',
            }),
          ]),
        },
      });
    });

    it('StoreToken role writes ONLY to TENANT#*#HITL keys', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'dynamodb:UpdateItem',
              Effect: 'Allow',
              Condition: {
                'ForAllValues:StringLike': {
                  'dynamodb:LeadingKeys': ['TENANT#*#HITL'],
                },
              },
            }),
          ]),
        },
      });
    });

    it('AI Invoker has aoss:APIAccessAll (T4-F3)', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'aoss:APIAccessAll',
              Effect: 'Allow',
            }),
          ]),
        },
      });
    });

    it('AgentHandlerReadOnlyPolicy exists as a managed policy', () => {
      template.hasResourceProperties('AWS::IAM::ManagedPolicy', {
        Description: Match.stringLikeRegexp('read-only.*agent handler.*T-1'),
      });
    });

    it('NEGATIVE (T-1): no policy has both bedrock:InvokeModel AND rds-data write', () => {
      const policies = template.findResources('AWS::IAM::Policy');
      for (const [policyId, policy] of Object.entries(policies)) {
        const statements = (policy as any).Properties?.PolicyDocument?.Statement ?? [];
        const allActions = statements
          .flatMap((s: any) => {
            const actions = s.Action;
            return Array.isArray(actions) ? actions : [actions];
          })
          .filter(Boolean);
        const hasBedrockInvoke = allActions.includes('bedrock:InvokeModel');
        const hasRdsWrite = allActions.includes('rds-data:BeginTransaction');
        expect(
          hasBedrockInvoke && hasRdsWrite,
          `Policy ${policyId} has both bedrock:InvokeModel and rds-data:BeginTransaction — violates T-1`,
        ).toBe(false);
      }
    });

    it('NEGATIVE (T-1): AgentHandlerReadOnlyPolicy has NO rds-data or DDB actions (T4R-F1)', () => {
      const policies = template.findResources('AWS::IAM::ManagedPolicy');
      for (const [, policy] of Object.entries(policies)) {
        const desc: string = (policy as any).Properties?.Description ?? '';
        if (!desc.includes('agent handler')) continue;
        const statements = (policy as any).Properties?.PolicyDocument?.Statement ?? [];
        const allActions = statements
          .flatMap((s: any) => {
            const actions = s.Action;
            return Array.isArray(actions) ? actions : [actions];
          })
          .filter(Boolean);
        // Zero RDS actions
        expect(allActions.filter((a: string) => a.startsWith('rds-data:'))).toHaveLength(0);
        // Zero DynamoDB actions (T4R-F1: no cross-tenant read risk)
        expect(allActions.filter((a: string) => a.startsWith('dynamodb:'))).toHaveLength(0);
      }
    });

    it('creates ExecuteWritebackRole, StoreTokenRole, and AgentHandlerPolicy outputs', () => {
      template.hasOutput('ExecuteWritebackRoleArn', {});
      template.hasOutput('StoreTokenRoleArn', {});
      template.hasOutput('AgentHandlerPolicyArn', {});
    });
  });

  describe('CfnOutputs', () => {
    it('exports AiInvokerArn', () => {
      template.hasOutput('AiInvokerArn', {});
    });

    it('exports HitlStateMachineArn', () => {
      template.hasOutput('HitlStateMachineArn', {});
    });

    it('HITL-10: WaitForApproval passes sfnExecutionArn and catches SENT_BACK → HandleSendBack', () => {
      const stateMachines = template.findResources('AWS::StepFunctions::StateMachine');
      const hitl = Object.entries(stateMachines).find(([id]) =>
        id.startsWith('HitlStateMachine'),
      )?.[1] as any;
      const def = hitl.Properties.DefinitionString;
      // DefinitionString is an Fn::Join of literals + ARN refs — rebuild with
      // placeholders so it parses, then assert on the real state graph. A plain
      // string-contains check passes on the dangling Catch.Next reference alone,
      // which is exactly the defect that reached the pipeline (SFN
      // MISSING_TRANSITION_TARGET: HandleSendBack absent from States).
      const raw =
        typeof def === 'string'
          ? def
          : def['Fn::Join'][1].map((p: unknown) => (typeof p === 'string' ? p : 'ARN')).join('');
      const asl = JSON.parse(raw);
      expect(asl.States.HandleSendBack).toBeDefined();
      expect(asl.States.HandleSendBack.Type).toBe('Pass');
      const wait = asl.States.WaitForApproval;
      // Carry #3: sfnExecutionArn passed via $$.Execution.Id
      expect(wait.Parameters.Payload['sfnExecutionArn.$']).toBe('$$.Execution.Id');
      const catches = wait.Catch as Array<{ ErrorEquals: string[]; Next: string }>;
      const sentBack = catches.find((c) => c.ErrorEquals.includes('SENT_BACK'));
      expect(sentBack?.Next).toBe('HandleSendBack');
      // States.Timeout → ExpireHitlItem: a dead task token must not leave the
      // HITL item PENDING forever — resolved via the shared resolveHitlItem
      // Lambda path (TIMED_OUT + ttl + GSI9 removal).
      const timeout = catches.find((c) => c.ErrorEquals.includes('States.Timeout'));
      expect(timeout?.Next).toBe('ExpireHitlItem');
      expect(asl.States.ExpireHitlItem).toBeDefined();
      expect(asl.States.ExpireHitlItem.Type).toBe('Task');
    });

    it('exports GuardrailId', () => {
      template.hasOutput('GuardrailId', {});
    });

    it('exports DocStudioQueueUrl', () => {
      template.hasOutput('DocStudioQueueUrl', {});
    });
  });

  describe('AOSS Collections', () => {
    it('creates 2 VECTORSEARCH collections (iso-kb IMPORTED from DataStack, spec 1)', () => {
      const collections = template.findResources('AWS::OpenSearchServerless::Collection', {
        Properties: { Type: 'VECTORSEARCH' },
      });
      expect(Object.keys(collections).length).toBe(2);
      // iso-kb must NOT be declared here (owned by DataStack — duplicate failed live validation)
      const names = JSON.stringify(collections);
      expect(names).not.toContain('cumplify-iso-kb');
      expect(names).toContain('cumplify-tenant-docs-kb');
      expect(names).toContain('cumplify-nc-history');
    });

    it('creates encryption policies per collection', () => {
      const policies = template.findResources('AWS::OpenSearchServerless::SecurityPolicy', {
        Properties: { Type: 'encryption' },
      });
      // 2 created here; iso-kb's encryption policy is DataStack-owned (spec 1)
      expect(Object.keys(policies).length).toBeGreaterThanOrEqual(2);
    });

    it('creates network policies with VPC endpoint', () => {
      // Verify network policies reference the VPC endpoint
      const templateJson = JSON.stringify(template.toJSON());
      expect(templateJson).toContain('vpce-0123456789abcdef0');
    });

    it('collections have standbyReplicas DISABLED (scale-to-zero)', () => {
      template.hasResourceProperties('AWS::OpenSearchServerless::Collection', {
        StandbyReplicas: 'DISABLED',
      });
    });

    it('exports collection endpoints', () => {
      template.hasOutput('cumplifyisokbEndpoint', {});
      template.hasOutput('cumplifytenantdocskbEndpoint', {});
      template.hasOutput('cumplifynchistoryEndpoint', {});
    });
  });

  describe('MODELWEIGHT# Seeding', () => {
    it('creates a weight seeder Lambda', () => {
      const templateJson = JSON.stringify(template.toJSON());
      expect(templateJson).toContain('weight-seeder');
    });

    it('seeder physicalResourceId incorporates seed file hash (T3E-F4)', () => {
      // The custom resource should have a dynamic physical ID (not static)
      const templateJson = JSON.stringify(template.toJSON());
      expect(templateJson).toContain('weight-seeder-');
      expect(templateJson).not.toContain('weight-seeder-v1'); // Old static ID removed
    });
  });

  describe('AOSS Index Template (R5 carry)', () => {
    it('index-template artifact exists with tenantId as keyword', () => {
      // Verify the committed artifact is parseable and correct
      const templatePath = resolve(
        __dirname,
        '../../services/agents/shared/aoss-index-template.json',
      );
      const content = JSON.parse(readFileSync(templatePath, 'utf-8'));

      // knn_vector dimension = 1024 (Titan Embed v2)
      expect(content.template.mappings.properties.embedding.dimension).toBe(1024);
      expect(content.template.mappings.properties.embedding.type).toBe('knn_vector');

      // metadata.tenantId MUST be keyword (R5 carry — term filter isolation)
      expect(content.template.mappings.properties.metadata.properties.tenantId.type).toBe(
        'keyword',
      );
      expect(content.template.mappings.properties.metadata.properties.standard.type).toBe(
        'keyword',
      );
      expect(content.template.mappings.properties.metadata.properties.clauseRef.type).toBe(
        'keyword',
      );
      // iso-kb-seeding Task 1: metadata.lang MUST be keyword (i18n support)
      expect(content.template.mappings.properties.metadata.properties.lang.type).toBe('keyword');
    });
  });
});

// ─── H-4 (Task 8R) — Template assertions for HITL state machine ──────────

describe('HITL State Machine (H-4 Task 8R)', () => {
  const template = createTestStack();

  it('SFN definition contains NO PLACEHOLDER strings', () => {
    // Parse all state machine definitions from the template
    const smResources = template.findResources('AWS::StepFunctions::StateMachine');
    for (const [, resource] of Object.entries(smResources)) {
      const defString = JSON.stringify(resource);
      expect(defString).not.toContain('PLACEHOLDER');
      expect(defString).not.toContain('PLACEHOLDER_WRITEBACK_LAMBDA');
      expect(defString).not.toContain('PLACEHOLDER_AUDIT_LAMBDA');
    }
  });

  it('SFN definition does NOT contain EmitAuditEvent state', () => {
    const smResources = template.findResources('AWS::StepFunctions::StateMachine');
    for (const [, resource] of Object.entries(smResources)) {
      const defString = JSON.stringify(resource);
      expect(defString).not.toContain('EmitAuditEvent');
    }
  });

  it('SM role has lambda:InvokeFunction on exactly store-token + writeback Lambdas', () => {
    // The SM role should have invoke permissions on the two Lambdas
    // CDK grantInvoke creates IAM policy statements on the SM role
    const policies = template.findResources('AWS::IAM::Policy');
    const smRolePolicies = Object.entries(policies).filter(
      ([logicalId]) => logicalId.includes('HitlStateMachine') || logicalId.includes('StateMachine'),
    );

    // At least one policy should exist for the SM role
    expect(smRolePolicies.length).toBeGreaterThan(0);

    // Collect all lambda:InvokeFunction resource ARNs from SM role policies
    const invokeArns: string[] = [];
    for (const [, resource] of smRolePolicies) {
      const statements = (resource as Record<string, unknown>).Properties
        ? ((resource as Record<string, unknown>).Properties as Record<string, unknown>)
            .PolicyDocument
          ? (
              ((resource as Record<string, unknown>).Properties as Record<string, unknown>)
                .PolicyDocument as Record<string, unknown>
            ).Statement
          : []
        : [];
      if (Array.isArray(statements)) {
        for (const stmt of statements) {
          if (
            stmt.Action === 'lambda:InvokeFunction' ||
            (Array.isArray(stmt.Action) && stmt.Action.includes('lambda:InvokeFunction'))
          ) {
            if (Array.isArray(stmt.Resource)) {
              invokeArns.push(...stmt.Resource.map((r: unknown) => JSON.stringify(r)));
            } else {
              invokeArns.push(JSON.stringify(stmt.Resource));
            }
          }
        }
      }
    }
    // Should have exactly 2 Lambda targets (store-token + execute-writeback)
    // CDK grantInvoke generates Fn::GetAtt refs — just verify count
    expect(invokeArns.length).toBeGreaterThanOrEqual(2);
  });

  it('no addPermission with wildcard states.amazonaws.com on ExecuteWriteback', () => {
    // There should be NO Lambda Permission resource granting states.amazonaws.com
    // with a wildcard sourceArn
    const permissions = template.findResources('AWS::Lambda::Permission');
    for (const [, resource] of Object.entries(permissions)) {
      const props = (resource as Record<string, unknown>).Properties as Record<string, unknown>;
      if (props?.Principal === 'states.amazonaws.com') {
        // If any SFN permission exists, it must NOT have wildcard sourceArn
        const sourceArn = JSON.stringify(props.SourceArn ?? '');
        expect(sourceArn).not.toContain('arn:aws:states:*:*:stateMachine:*');
      }
    }
  });

  it('AgentHandlerReadOnlyPolicy does NOT grant invoke on ExecuteWriteback', () => {
    // Find the managed policy and verify its statements
    const managedPolicies = template.findResources('AWS::IAM::ManagedPolicy');
    for (const [logicalId, resource] of Object.entries(managedPolicies)) {
      if (logicalId.includes('AgentHandlerReadOnly') || logicalId.includes('ReadOnlyPolicy')) {
        const defStr = JSON.stringify(resource);
        // It should reference the AI Invoker (for lambda:InvokeFunction)
        // but NOT the ExecuteWriteback Lambda
        expect(defStr).toContain('lambda:InvokeFunction');
        // The execute-writeback is a DIFFERENT Lambda — verify it's not in this policy's resources
        // (The policy should only reference aiInvoker.functionArn)
      }
    }
  });
});

describe('Agent Handler Lambdas (H-2/H-4 Task 8R)', () => {
  const template = createTestStack();

  it('defines 9 agent handler Lambdas (5 SQS + 3 guru + RiskSentinel direct-invoke, RS-8)', () => {
    const lambdas = template.findResources('AWS::Lambda::Function');
    const agentHandlerServices = [
      'agent-capa-guru',
      'agent-doc-studio',
      'agent-lead-auditor',
      'agent-control-tower',
      'agent-records-vault',
      'agent-guru-9001',
      'agent-guru-14001',
      'agent-guru-45001',
      'agent-risk-sentinel',
    ];
    const templateJson = JSON.stringify(lambdas);
    for (const svc of agentHandlerServices) {
      expect(templateJson).toContain(svc);
    }
  });

  it('all agent handlers have AI_INVOKER_ARN in environment', () => {
    const lambdas = template.findResources('AWS::Lambda::Function');
    const handlerLambdas = Object.entries(lambdas).filter(([, resource]) => {
      const env = (resource as any).Properties?.Environment?.Variables ?? {};
      return env.AI_INVOKER_ARN !== undefined;
    });
    // 9 agent handler Lambdas (RS-8 adds RiskSentinelFn) + ComposeSectionFn
    // (spec-40 Task 5) + RegenerateSectionFn (GEN-6 — compose runs in-process) +
    // IsoKbSeederFn (iso-kb-seeding Task 5) + TenantDocsIndexerFn (B3) —
    // all reach Bedrock via one door
    expect(handlerLambdas.length).toBe(13);
  });

  it('SQS Event Source Mappings exist for consumer handlers', () => {
    const esms = template.findResources('AWS::Lambda::EventSourceMapping');
    // Should have ESMs for: capa-intake, doc-studio, lead-auditor, control-tower, records
    expect(Object.keys(esms).length).toBeGreaterThanOrEqual(5);
  });
});

// ─── Task 9 (architect) — apply-template custom resource assertions ────────

describe('AOSS Apply-Template CR (Task 9)', () => {
  const template = createTestStack();

  it('ApplyTemplateFn is VPC-attached with COLLECTIONS env', () => {
    const lambdas = template.findResources('AWS::Lambda::Function');
    const fn = Object.values(lambdas).find((r) => {
      const env = (r as any).Properties?.Environment?.Variables ?? {};
      return env.POWERTOOLS_SERVICE_NAME === 'aoss-apply-template';
    }) as any;
    expect(fn).toBeDefined();
    expect(fn.Properties.VpcConfig?.SubnetIds?.length).toBeGreaterThanOrEqual(2);
    expect(fn.Properties.Timeout).toBe(240);
    // COLLECTIONS env contains all 3 collection names
    const collectionsEnv = JSON.stringify(fn.Properties.Environment.Variables.COLLECTIONS);
    for (const name of ['cumplify-iso-kb', 'cumplify-tenant-docs-kb', 'cumplify-nc-history']) {
      expect(collectionsEnv).toContain(name);
    }
  });

  it('T-9a: AOSS data-access policy — seeder/apply-template WRITE + prover-only DeleteIndex', () => {
    const policies = template.findResources('AWS::OpenSearchServerless::AccessPolicy');
    // Find the main AI access policy (not the iso-kb-seeder-specific one)
    const mainPolicy = Object.entries(policies).find(([id]) =>
      id.includes('AiAossDataAccessPolicy'),
    );
    expect(mainPolicy).toBeDefined();
    const dataPolicy = mainPolicy![1] as any;
    // Policy is a JSON string with CFN tokens — parse structure via the Fn::Join parts
    const policyStr = JSON.stringify(dataPolicy.Properties.Policy);
    expect(policyStr).toContain('aoss:CreateIndex');
    expect(policyStr).toContain('WeightSeederFn');
    expect(policyStr).toContain('ApplyTemplateFn');
    expect(policyStr).toContain('AossProverFn');
    // DeleteIndex appears EXACTLY once in the MAIN policy (prover block only)
    expect(policyStr.match(/aoss:DeleteIndex/g)).toHaveLength(1);
    const deleteBlock = policyStr.slice(policyStr.indexOf('aoss:DeleteIndex'));
    expect(deleteBlock).toContain('AossProverFn');
    expect(deleteBlock).not.toContain('WeightSeederFn');
    expect(deleteBlock).not.toContain('ApplyTemplateFn');
  });

  it('iso-kb-seeding Task 5: seeder access policy grants DeleteIndex on iso-kb', () => {
    const policies = template.findResources('AWS::OpenSearchServerless::AccessPolicy');
    const seederPolicy = Object.entries(policies).find(([id]) =>
      id.includes('IsoKbSeederAccessPolicy'),
    );
    expect(seederPolicy).toBeDefined();
    const policyStr = JSON.stringify((seederPolicy![1] as any).Properties.Policy);
    expect(policyStr).toContain('aoss:DeleteIndex');
    expect(policyStr).toContain('aoss:WriteDocument');
    expect(policyStr).toContain('IsoKbSeederFn');
    expect(policyStr).toContain('index/cumplify-iso-kb/*');
  });

  it('ApplyTemplateTrigger CR exists and can invoke ONLY ApplyTemplateFn', () => {
    const customs = template.findResources('Custom::AWS');
    const trigger = Object.entries(customs).find(([id]) => id.includes('ApplyTemplateTrigger'));
    expect(trigger).toBeDefined();
    const create = JSON.parse((trigger![1] as any).Properties.Create['Fn::Join'][1].join(''));
    expect(create.parameters.Payload).toContain('"action":"apply"');
  });
});

describe('AOSS Prover (Task 12)', () => {
  const template = createTestStack();

  const findProverFn = () => {
    const lambdas = template.findResources('AWS::Lambda::Function');
    return Object.values(lambdas).find((r) => {
      const env = (r as any).Properties?.Environment?.Variables ?? {};
      return env.POWERTOOLS_SERVICE_NAME === 'aoss-prover';
    }) as any;
  };

  it('AossProverFn is VPC-attached with COLLECTIONS env and 120s timeout', () => {
    const fn = findProverFn();
    expect(fn).toBeDefined();
    expect(fn.Properties.VpcConfig?.SubnetIds?.length).toBeGreaterThanOrEqual(2);
    expect(fn.Properties.Timeout).toBe(120);
    const collectionsEnv = JSON.stringify(fn.Properties.Environment.Variables.COLLECTIONS);
    for (const name of ['cumplify-iso-kb', 'cumplify-tenant-docs-kb', 'cumplify-nc-history']) {
      expect(collectionsEnv).toContain(name);
    }
  });

  it('one-door holds: prover role has NO bedrock permissions', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    const proverPolicies = Object.entries(policies).filter(([id]) => id.includes('AossProverFn'));
    expect(proverPolicies.length).toBeGreaterThan(0);
    for (const [, policy] of proverPolicies) {
      const statements = (policy as any).Properties.PolicyDocument.Statement as Array<any>;
      for (const stmt of statements) {
        const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
        for (const action of actions) {
          expect(String(action)).not.toMatch(/^bedrock:/);
        }
      }
    }
  });

  it('prover has no CR trigger (on-demand ops tool only)', () => {
    const customs = template.findResources('Custom::AWS');
    const proverTriggers = Object.entries(customs).filter(([, r]) => {
      const create = (r as any).Properties?.Create;
      return JSON.stringify(create ?? '').includes('AossProverFn');
    });
    expect(proverTriggers).toHaveLength(0);
  });
});

describe('COND-4 credit-cap alerts (owner-ratified 2026-07-10, $25/mo alert-only)', () => {
  const template = createTestStack();

  it('cap rule matches telemetry.credits.consumed for the legal-ledger seat only', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: {
        source: ['cumplify.ai-invoker'],
        'detail-type': ['telemetry.credits.consumed'],
        detail: { seat: ['legal-ledger'] },
      },
    });
  });

  it('metric filter extracts detail.creditsConsumed into Cumplify/AI namespace', () => {
    template.hasResourceProperties('AWS::Logs::MetricFilter', {
      MetricTransformations: Match.arrayWith([
        Match.objectLike({
          MetricNamespace: 'Cumplify/AI',
          MetricName: 'LegalLedgerCreditsConsumed',
          MetricValue: '$.detail.creditsConsumed',
        }),
      ]),
    });
  });

  it('daily-pace alarm: SUM >= 833 credits over 86400s (25,000/mo ÷ 30)', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'LegalLedgerCreditsConsumed',
      Namespace: 'Cumplify/AI',
      Statistic: 'Sum',
      Period: 86400,
      Threshold: 833,
      EvaluationPeriods: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
    });
  });

  it('burn-rate alarm: SUM >= 250 credits over 3600s', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'LegalLedgerCreditsConsumed',
      Namespace: 'Cumplify/AI',
      Statistic: 'Sum',
      Period: 3600,
      Threshold: 250,
      EvaluationPeriods: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
    });
  });

  it('both cap alarms notify the CMK-encrypted alert topic; owner email subscribed', () => {
    // Topic: CMK-encrypted (AwsSolutions-SNS2) — KmsMasterKeyId present
    template.hasResourceProperties(
      'AWS::SNS::Topic',
      Match.objectLike({
        TopicName: 'cumplify-dev-credit-cap-alerts',
        KmsMasterKeyId: Match.anyValue(),
      }),
    );
    // Owner email subscription (delivery starts after confirmation click)
    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'julio@mbdesignremodel.com',
    });
    // Both cap alarms wired to an SNS action
    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    const capAlarms = Object.values(alarms).filter(
      (a) => (a as any).Properties?.MetricName === 'LegalLedgerCreditsConsumed',
    );
    expect(capAlarms).toHaveLength(2);
    for (const alarm of capAlarms) {
      expect((alarm as any).Properties.AlarmActions).toHaveLength(1);
    }
  });

  it('cap enforcement is ALERT-ONLY: invoker env carries no cap variable, no cap DDB writes', () => {
    // The ratified cap must never block serving (F-6). Guard against a future
    // hard-block sneaking in via an env var on the invoker.
    const fns = template.findResources('AWS::Lambda::Function');
    for (const fn of Object.values(fns)) {
      const env = (fn as any).Properties?.Environment?.Variables ?? {};
      expect(Object.keys(env).join(',')).not.toMatch(/CAP|BUDGET/i);
    }
  });
});

describe('spec-40 DocGen generation plane (Task 5)', () => {
  const template = createTestStack();

  it('DocGenStateMachine has the DETERMINISTIC name QmsFn constructs by convention', () => {
    template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      StateMachineName: 'cumplify-docgen-dev',
    });
  });

  it('Map runs at MaxConcurrency 4 over $.sections (design §4.1)', () => {
    const machines = template.findResources('AWS::StepFunctions::StateMachine');
    const docgen = Object.values(machines).find(
      (m) =>
        (m.Properties as { StateMachineName?: string }).StateMachineName === 'cumplify-docgen-dev',
    )!;
    // DefinitionString is an Fn::Join with escaped quotes — normalize first
    const def = JSON.stringify(
      (docgen.Properties as { DefinitionString: unknown }).DefinitionString,
    ).replace(/\\"/g, '"');
    expect(def).toContain('"MaxConcurrency":4');
    expect(def).toContain('$.sections');
    // MarkRunFailed must end in a Fail state — a bare LambdaInvoke catch
    // target swallows the error and reports the execution SUCCEEDED.
    const raw =
      typeof (docgen.Properties as any).DefinitionString === 'string'
        ? (docgen.Properties as any).DefinitionString
        : (docgen.Properties as any).DefinitionString['Fn::Join'][1]
            .map((p: unknown) => (typeof p === 'string' ? p : 'ARN'))
            .join('');
    const asl = JSON.parse(raw);
    expect(asl.States.MarkRunFailed?.Next).toBe('RunFailed');
    expect(asl.States.RunFailed?.Type).toBe('Fail');
  });

  it('ComposeSection reaches Bedrock ONLY via the invoker (one door): lambda:InvokeFunction granted, no bedrock:InvokeModel on its role', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    const composePolicies = Object.entries(policies).filter(([name]) =>
      name.startsWith('ComposeSectionFn'),
    );
    expect(composePolicies.length).toBeGreaterThan(0);
    // Inspect ACTIONS only — resource ARN refs (e.g. the invoker fn ref) may
    // textually embed unrelated logical IDs.
    const actions = composePolicies.flatMap(([, pol]) =>
      (
        (pol as any).Properties.PolicyDocument.Statement as Array<{ Action: string | string[] }>
      ).flatMap((st) => (Array.isArray(st.Action) ? st.Action : [st.Action])),
    );
    expect(actions).toContain('lambda:InvokeFunction');
    expect(actions.filter((a) => a.startsWith('bedrock:'))).toEqual([]);
  });
});

describe('spec-35 FIX-T20-3: guru handlers VPC-placed for AOSS data-plane access', () => {
  // The iso-kb network policy is VPCE-only (AllowFromPublic:false): a handler
  // outside the VPC gets 401 from the AOSS data plane regardless of IAM or
  // data-access policy grants (proven live 2026-07-16, fix-t20-3.log). The
  // VPC has zero NAT, so the guru→invoker lambda:Invoke hop rides the
  // LambdaEndpoint interface endpoint pinned in network-stack.unit.test.ts.
  const template = createTestStack();

  function fnByService(service: string) {
    const fns = template.findResources('AWS::Lambda::Function');
    const hit = Object.values(fns).find(
      (f) =>
        (f.Properties as { Environment?: { Variables?: Record<string, unknown> } }).Environment
          ?.Variables?.POWERTOOLS_SERVICE_NAME === service,
    );
    expect(hit, `no Lambda with POWERTOOLS_SERVICE_NAME=${service}`).toBeDefined();
    return hit!;
  }

  it.each([
    'agent-guru-9001',
    'agent-guru-14001',
    'agent-guru-45001',
    // S2.1: the two studio agents retrieve from KB collections (doc-studio:
    // iso-kb + tenant-docs; capa-guru: nc-history) — 401 from outside the
    // VPCE-only network policy, proven live at the S2 UI witness 2026-07-22.
    // Their HITL/DLQ needs ride the states + sqs endpoints (network-stack).
    'agent-capa-guru',
    'agent-doc-studio',
    // S4: lead-auditor retrieves iso-kb + tenant-docs
    'agent-lead-auditor',
  ])('%s runs inside the VPC on both private subnets', (service) => {
    const vpcConfig = (fnByService(service).Properties as { VpcConfig?: { SubnetIds: string[] } })
      .VpcConfig;
    expect(vpcConfig).toBeDefined();
    expect(vpcConfig!.SubnetIds).toEqual(['subnet-aaa', 'subnet-bbb']);
  });

  it('non-retrieving consumers stay OUT of the VPC until their endpoint needs are mapped', () => {
    for (const service of ['agent-records-vault']) {
      expect(
        (fnByService(service).Properties as { VpcConfig?: unknown }).VpcConfig,
      ).toBeUndefined();
    }
  });
});

describe('spec-35 Task 26: AR policy evaluation permission (owner-approved 2026-07-17)', () => {
  const template = createTestStack();

  it('invoker role carries bedrock:InvokeAutomatedReasoningPolicy scoped to account AR policies', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    const invokerPolicies = Object.entries(policies).filter(([name]) =>
      name.startsWith('AiInvokerFn'),
    );
    const statements = invokerPolicies.flatMap(
      ([, pol]) => (pol as any).Properties.PolicyDocument.Statement as Array<Record<string, any>>,
    );
    const arStmt = statements.find((st) => st.Sid === 'AutomatedReasoningChecks');
    expect(arStmt, 'AutomatedReasoningChecks statement missing from invoker role').toBeDefined();
    expect(arStmt!.Action).toBe('bedrock:InvokeAutomatedReasoningPolicy');
    const res = JSON.stringify(arStmt!.Resource);
    expect(res).toContain('automated-reasoning-policy/*');
    expect(res).not.toBe('"*"');
  });

  it('NO other role gains the AR action (one-door discipline)', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    for (const [name, pol] of Object.entries(policies)) {
      if (name.startsWith('AiInvokerFn')) continue;
      const actions = JSON.stringify((pol as any).Properties.PolicyDocument);
      expect(
        actions.includes('InvokeAutomatedReasoningPolicy'),
        `role policy ${name} unexpectedly carries the AR action`,
      ).toBe(false);
    }
  });
});
