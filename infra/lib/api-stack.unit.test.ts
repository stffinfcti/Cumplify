/**
 * ApiStack template assertion tests.
 * Verifies resolver count matches schema fields (BLOCK-1 prevention).
 *
 * NOTE: Full CDK synthesis of ApiStack requires Lambda entry points and schema
 * file resolution. This test reads the source file to assert structural properties
 * without full synth (which is tested by `cdk synth` in CI).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const API_STACK_CODE = readFileSync(resolve(__dirname, 'api-stack.ts'), 'utf-8');
const AI_STACK_CODE = readFileSync(resolve(__dirname, 'ai-stack.ts'), 'utf-8');
const SCHEMA_CODE = readFileSync(
  resolve(__dirname, '../../services/api/schema/schema.graphql'),
  'utf-8',
);

describe('ApiStack template assertions (source-level)', () => {
  it('has createResolver calls for all Query fields in schema', () => {
    // Count Query fields in schema (one per line with a field name)
    const querySection = SCHEMA_CODE.match(/type Query \{([^}]+)\}/s);
    expect(querySection).not.toBeNull();
    const queryLines = querySection![1].split('\n').filter((l) => l.match(/^\s+\w+[(:]/));
    let queryFieldCount = queryLines.length;

    // Also count fields in `extend type Query` blocks
    const extendQuerySections = SCHEMA_CODE.matchAll(/extend type Query \{([^}]+)\}/gs);
    for (const m of extendQuerySections) {
      queryFieldCount += m[1].split('\n').filter((l) => l.match(/^\s+\w+[(:]/)).length;
    }

    // Count Query resolver attachments in api-stack + ai-stack (guru resolvers live in AiStack)
    const apiResolvers = (API_STACK_CODE.match(/typeName: 'Query'/g) ?? []).length;
    const aiResolvers = (AI_STACK_CODE.match(/typeName: 'Query'/g) ?? []).length;

    expect(apiResolvers + aiResolvers).toBe(queryFieldCount);
  });

  it('has createResolver calls for all Mutation fields in schema', () => {
    // Count Mutation fields in schema (one per line with a field name)
    const mutationSection = SCHEMA_CODE.match(/type Mutation \{([^}]+)\}/s);
    expect(mutationSection).not.toBeNull();
    // Count lines that have a field definition (word followed by '(' or ':')
    const mutationLines = mutationSection![1].split('\n').filter((l) => l.match(/^\s+\w+[(:]/));
    let mutationFieldCount = mutationLines.length;

    // Also count fields in `extend type Mutation` blocks
    const extendMutationSections = SCHEMA_CODE.matchAll(/extend type Mutation \{([^}]+)\}/gs);
    for (const m of extendMutationSections) {
      mutationFieldCount += m[1].split('\n').filter((l) => l.match(/^\s+\w+[(:]/)).length;
    }

    // Count Mutation resolver attachments in api-stack
    const mutationResolvers = API_STACK_CODE.match(/typeName: 'Mutation'/g) ?? [];

    expect(mutationResolvers.length).toBe(mutationFieldCount);
  });

  it('has NoneDataSource for subscription publish mutations', () => {
    expect(API_STACK_CODE).toContain("api.addNoneDataSource('NoneDataSource')");
    expect(API_STACK_CODE).toContain("fieldName: 'publishDocumentEvent'");
    expect(API_STACK_CODE).toContain("fieldName: 'publishCAPAEvent'");
    expect(API_STACK_CODE).toContain("fieldName: 'publishAuditEvent'");
    expect(API_STACK_CODE).toContain("fieldName: 'publishRiskEvent'");
  });

  it('has Lambda data sources for all 5 modules', () => {
    expect(API_STACK_CODE).toContain("api.addLambdaDataSource('M1DataSource'");
    expect(API_STACK_CODE).toContain("api.addLambdaDataSource('M2DataSource'");
    expect(API_STACK_CODE).toContain("api.addLambdaDataSource('M3DataSource'");
    expect(API_STACK_CODE).toContain("api.addLambdaDataSource('M4DataSource'");
    expect(API_STACK_CODE).toContain("api.addLambdaDataSource('M5DataSource'");
  });

  it('has WAFv2 association', () => {
    expect(API_STACK_CODE).toContain('CfnWebACLAssociation');
  });

  it('has AppSync API with AWS_LAMBDA default auth + IAM additional', () => {
    expect(API_STACK_CODE).toContain('AuthorizationType.LAMBDA');
    expect(API_STACK_CODE).toContain('AuthorizationType.IAM');
  });

  it('has 4+ CfnOutputs (API URL, API ID, Authorizer ARN, TenantDataRole ARN)', () => {
    expect(API_STACK_CODE).toContain("'GraphqlApiUrl'");
    expect(API_STACK_CODE).toContain("'GraphqlApiId'");
    expect(API_STACK_CODE).toContain("'AuthorizerArn'");
    expect(API_STACK_CODE).toContain("'TenantDataRoleArn'");
  });

  it('excludeVerboseContent is true (FIX-2)', () => {
    expect(API_STACK_CODE).toContain('excludeVerboseContent: true');
  });

  it('tenant-data role has DENY for # in tag value (FIX-4)', () => {
    expect(API_STACK_CODE).toContain("'aws:RequestTag/tenantId': '*#*'");
    expect(API_STACK_CODE).toContain('Effect.DENY');
  });

  it('tenant-data role UpdateItem is pinned to the HITL partition only (BUG-14)', () => {
    // Approval-path writes (RESOLVING guard + resolveHitlItem) need UpdateItem,
    // but ONLY on PK TENANT#<t>#HITL — exact LeadingKeys, no wildcard tail.
    expect(API_STACK_CODE).toContain("'dynamodb:UpdateItem'");
    expect(API_STACK_CODE).toContain("'TENANT#${aws:PrincipalTag/tenantId}#HITL'");
    // The broad tenant-wide statement must never gain UpdateItem — that would
    // open a same-tenant AUDITLOG modify surface.
    const broad = API_STACK_CODE.match(/actions: \[\s*'dynamodb:GetItem'[\s\S]*?\]/);
    expect(broad).toBeTruthy();
    expect(broad![0]).not.toContain('UpdateItem');
  });

  it('has createResolver calls for all 5 Subscription fields (BLOCK-2)', () => {
    // Subscription resolvers are created in a loop over subscriptionFields array
    expect(API_STACK_CODE).toContain("'onDocumentStatusChanged'");
    expect(API_STACK_CODE).toContain("'onCAPAStatusChanged'");
    expect(API_STACK_CODE).toContain("'onFindingRecorded'");
    expect(API_STACK_CODE).toContain("'onCalibrationDue'");
    expect(API_STACK_CODE).toContain("'onRiskEscalated'");
    expect(API_STACK_CODE).toContain("typeName: 'Subscription'");
  });

  it('total resolver count is 99 (source-counted; history in comments below)', () => {
    const queryCount = (API_STACK_CODE.match(/typeName: 'Query'/g) ?? []).length;
    const mutationCount = (API_STACK_CODE.match(/typeName: 'Mutation'/g) ?? []).length;
    // Subscription count: 5 fields in subscriptionFields array (loop-generated)
    const subscriptionFields = API_STACK_CODE.match(/subscriptionFields = \[([^\]]+)\]/s);
    const subLoopCount = subscriptionFields
      ? (subscriptionFields[1].match(/'/g) ?? []).length / 2
      : 0;
    // Plus individually-created subscription resolvers (Spec 9: onHitlItemResolved)
    const individualSubCount = (API_STACK_CODE.match(/typeName: 'Subscription'/g) ?? []).length - 1; // -1 for the loop template
    // 2026-07-13: +3 (listDocumentVersions, listNonconformities,
    // listCorrectiveActions — frontend-app Phase C read surface)
    // 2026-07-14: +1 (registerMeasuringResource — M4 calibration unblock)
    // 2026-07-14: +1 (getTenantSettings — Task 31 Settings unblock)
    // 2026-07-14: +10 (spec 41 forms engine: 4 Query + 6 Mutation)
    // 2026-07-15: +1 (spec 41 Task 9: generateAuditChecklist on M3)
    // 2026-07-15: +7 (spec 40 Task 3: 5 Query + 2 Mutation on QmsDS)
    // 2026-07-15: +5 (spec 40 Task 3: remaining mutations wired as stubs on QmsDS + noneDS)
    // 2026-07-15: +1 (spec 40 Task 7: onGenerationProgress subscription in loop)
    // 2026-07-15: +1 (getDocumentContent — Task 11 viewer read surface unblock)
    // 2026-07-16: -1 (appendAuditEvent facade removed — no handler case, zero callers; owner-approved)
    // 2026-07-21: +2 (RS-6 approval matrix: listApprovalMatrix Query + setApprovalMatrixEntry Mutation on m4DS)
    // 2026-07-22: +1 (RS-9: saveDocumentSectionEdit Mutation on m1DS)
    // 2026-07-22: +2 (RS-8: runCapaAnalysis Mutation on m2DS, runRiskAssessment Mutation on m5DS)
    // 2026-07-22: +1 (S1 studio wave: runNcIntake Mutation on m2DS)
    // 2026-07-22: +1 (S2 studio wave: runDocDraft Mutation on m1DS)
    // 2026-07-22: +1 (S3 studio wave: runManualSectionDraft Mutation on QmsDS)
    // 2026-07-22: +2 (C1 CAPA Studio RCA: runRootCauseAnalysis Mutation + listRootCauseAnalyses Query on m2DS)
    // 2026-07-22: +4 (S4 Audit Studio: listAudits/listAuditFindings/listAuditChecklists Queries + runAuditFindings Mutation on m3DS)
    // 2026-07-23: +1 (Billing: createBillingPortalSession Mutation on BillingDataSource — Stripe Customer Portal)
    expect(queryCount + mutationCount + subLoopCount + individualSubCount).toBe(99);
  });

  it('subscription resolvers enforce C-6 tenant-claim check via $util.unauthorized()', () => {
    expect(API_STACK_CODE).toContain(
      '$ctx.identity.resolverContext.tenantId != $ctx.args.tenantId',
    );
    expect(API_STACK_CODE).toContain('$util.unauthorized()');
  });

  it('approval Lambda holds SFN callback permissions (SendTaskSuccess + SendTaskFailure) with reasoned IAM5 suppression', () => {
    expect(API_STACK_CODE).toContain("'states:SendTaskSuccess', 'states:SendTaskFailure'");
    expect(API_STACK_CODE).toContain('scoped by the task token');
  });

  it("SendTask* stays on Resource '*' — AWS SAR gives these actions NO resource-level permissions", () => {
    // states:SendTaskSuccess/Failure support no resource types per the Service
    // Authorization Reference: any scoped ARN is non-authorizing, so '*' is
    // mandatory. This test pins both the '*' resource and the documented
    // justification so a future "scoping" edit fails loudly instead of
    // silently breaking every HITL approval.
    const stmt = API_STACK_CODE.match(
      /actions: \[\s*'states:SendTaskSuccess', 'states:SendTaskFailure'\s*\][\s\S]*?resources: \[([\s\S]*?)\]/,
    );
    expect(stmt).toBeTruthy();
    expect(stmt![1]).toBe("'*'");
    // The rationale is documented in-place (mandatory, not deferred debt).
    expect(API_STACK_CODE).toContain('NO resource-level permissions');
    expect(API_STACK_CODE).toContain('MANDATORY');
    // Execution-name wildcard intent is documented for the day AWS adds support.
    expect(API_STACK_CODE).toContain('execution:cumplify-hitl');
    // Only the two needed actions — SendTaskHeartbeat is deliberately absent
    // (7-day approval window needs no heartbeat).
    expect(API_STACK_CODE).not.toContain('states:SendTaskHeartbeat');
  });

  it('HITL sweeper is wired: NodejsFunction + 5-minute schedule + index-scoped Scan (never base-table Scan IAM)', () => {
    expect(API_STACK_CODE).toContain("entry: 'services/api/src/resolvers/hitl-sweeper.ts'");
    expect(API_STACK_CODE).toContain('events.Schedule.rate(cdk.Duration.minutes(5))');
    expect(API_STACK_CODE).toContain('/index/GSI9`');
    const scanStatements = API_STACK_CODE.match(/dynamodb:Scan/g) ?? [];
    expect(scanStatements.length).toBe(1);
  });

  it('every addLambdaDataSource is included in the Nag IAM5 suppression loop (Deploy-1 lesson)', () => {
    // Count all api.addLambdaDataSource calls
    const dsCreations = API_STACK_CODE.match(/api\.addLambdaDataSource\(/g) ?? [];
    // Count entries in the dataSources suppression array
    const dsArrayMatch = API_STACK_CODE.match(/const dataSources = \[([^\]]+)\]/);
    expect(dsArrayMatch).not.toBeNull();
    const dsEntries = dsArrayMatch![1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    // Every Lambda data source must be in the suppression array
    expect(dsEntries.length).toBe(dsCreations.length);
  });
});
