/**
 * Unit tests for store-token Lambda (Task 8R-2).
 * Verifies: upsert creates full HITL item with GSI9PK/GSI9SK + taskToken;
 * no ConditionExpression (native upsert); idempotent on re-delivery.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDdbSend = vi.fn();

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class {
    send = mockDdbSend;
  },
  UpdateItemCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

vi.mock('@aws-sdk/util-dynamodb', () => ({
  marshall: (obj: unknown) => obj, // pass-through for assertion simplicity
}));

vi.stubEnv('TABLE_NAME', 'CumplifyCore');

const { handler } = await import('../store-token.js');

describe('store-token handler', () => {
  beforeEach(() => {
    mockDdbSend.mockReset();
    mockDdbSend.mockResolvedValue({});
  });

  it('writes full HITL item with GSI9PK/GSI9SK (D-2 sparse projection)', async () => {
    const result = await handler({
      taskToken: 'sfn-token-abc-123',
      input: {
        tenantId: 'tenant-1',
        hitlItemId: '01HXYZ',
        agentName: 'CAPAGuru',
        proposedAction: { tool: 'capa-open', args: { ncId: 'nc-1' } },
        createdAt: '2026-07-09T12:00:00.000Z',
      },
    });

    expect(result).toEqual({ stored: true });

    const call = mockDdbSend.mock.calls[0][0];
    const params = call.input;

    // Key
    expect(params.Key.PK).toBe('TENANT#tenant-1#HITL');
    expect(params.Key.SK).toBe('PENDING#01HXYZ');

    // UpdateExpression sets all fields
    const expr: string = params.UpdateExpression;
    expect(expr).toContain('itemType = :itemType');
    expect(expr).toContain('agentName = :agentName');
    expect(expr).toContain('proposedAction = :proposedAction');
    expect(expr).toContain('createdAt = :createdAt');
    expect(expr).toContain('#status = :status');
    expect(expr).toContain('taskToken = :taskToken');
    expect(expr).toContain('tokenStoredAt = :tokenStoredAt');
    expect(expr).toContain('GSI9PK = :gsi9pk');
    expect(expr).toContain('GSI9SK = :gsi9sk');

    // Values
    const vals = params.ExpressionAttributeValues;
    expect(vals[':itemType']).toBe('HITL_PENDING');
    expect(vals[':agentName']).toBe('CAPAGuru');
    expect(vals[':proposedAction']).toEqual({ tool: 'capa-open', args: { ncId: 'nc-1' } });
    expect(vals[':createdAt']).toBe('2026-07-09T12:00:00.000Z');
    expect(vals[':status']).toBe('PENDING');
    expect(vals[':taskToken']).toBe('sfn-token-abc-123');
    expect(vals[':gsi9pk']).toBe('TENANT#tenant-1#HITL_PENDING');
    expect(vals[':gsi9sk']).toBe('2026-07-09T12:00:00.000Z');
  });

  it('upserts only while unresolved — re-delivery stays idempotent, never overwrites a resolved item', async () => {
    await handler({
      taskToken: 'token-xyz',
      input: {
        tenantId: 'tenant-2',
        hitlItemId: '02ABC',
        agentName: 'DocStudio',
        proposedAction: { tool: 'doc-publish', args: {} },
        createdAt: '2026-07-09T13:00:00.000Z',
      },
    });

    const call = mockDdbSend.mock.calls[0][0];
    // Condition allows create-or-refresh only while PENDING — a re-delivered
    // StoreToken still upserts, but a replay can never revert APPROVED/EXPIRED.
    expect(call.input.ConditionExpression).toBe(
      'attribute_not_exists(#status) OR #status = :pending',
    );

    // Replay after resolution: the write is conditionally rejected and the
    // handler swallows it as a no-op rather than failing the state machine.
    mockDdbSend.mockRejectedValueOnce(
      Object.assign(new Error('condition failed'), {
        name: 'ConditionalCheckFailedException',
      }),
    );
    await expect(
      handler({
        taskToken: 'token-xyz',
        input: {
          tenantId: 'tenant-2',
          hitlItemId: '02ABC',
          agentName: 'DocStudio',
          proposedAction: { tool: 'doc-publish', args: {} },
          createdAt: '2026-07-09T13:00:00.000Z',
        },
      }),
    ).resolves.toEqual({ stored: true });
  });

  it('GSI9PK uses TENANT# prefix (FF-5 convention)', async () => {
    await handler({
      taskToken: 'token-ff5',
      input: {
        tenantId: 'tenant-prefix-test',
        hitlItemId: '03DEF',
        agentName: 'RecordsVault',
        proposedAction: { tool: 'records-retention-schedule', args: {} },
        createdAt: '2026-07-09T14:00:00.000Z',
      },
    });

    const call = mockDdbSend.mock.calls[0][0];
    const vals = call.input.ExpressionAttributeValues;
    expect(vals[':gsi9pk']).toBe('TENANT#tenant-prefix-test#HITL_PENDING');
    expect(vals[':gsi9pk']).toMatch(/^TENANT#/);
  });

  it('writes sfnExecutionArn using if_not_exists (HITL-10)', async () => {
    // The ASL passes sfnExecutionArn as a SIBLING of taskToken
    // ('sfnExecutionArn.$': '$$.Execution.Id'), never inside input — the
    // prior version of this test pinned the wrong shape and the ARN was
    // silently 'unknown' on every real item (BUG-11c, found live at ACC-3).
    await handler({
      taskToken: 'token-arn-test',
      sfnExecutionArn: 'arn:aws:states:us-east-1:123:execution:hitl-sm:hitl-capa-04GHI',
      input: {
        tenantId: 'tenant-arn',
        hitlItemId: '04GHI',
        agentName: 'CAPAGuru',
        proposedAction: { tool: 'capa-open', args: {} },
        createdAt: '2026-07-09T15:00:00.000Z',
      },
    });

    const call = mockDdbSend.mock.calls[0][0];
    const params = call.input;

    // UpdateExpression includes sfnExecutionArn with if_not_exists
    expect(params.UpdateExpression).toContain(
      'sfnExecutionArn = if_not_exists(sfnExecutionArn, :sfnArn)',
    );
    // Value is the provided ARN
    expect(params.ExpressionAttributeValues[':sfnArn']).toBe(
      'arn:aws:states:us-east-1:123:execution:hitl-sm:hitl-capa-04GHI',
    );
  });

  it('defaults sfnExecutionArn to "unknown" when not provided (HITL-10)', async () => {
    await handler({
      taskToken: 'token-no-arn',
      input: {
        tenantId: 'tenant-no-arn',
        hitlItemId: '05JKL',
        agentName: 'DocStudio',
        proposedAction: { tool: 'doc-publish', args: {} },
        createdAt: '2026-07-09T16:00:00.000Z',
        // sfnExecutionArn intentionally omitted
      },
    });

    const call = mockDdbSend.mock.calls[0][0];
    const vals = call.input.ExpressionAttributeValues;
    expect(vals[':sfnArn']).toBe('unknown');
  });

  it('L5-1: writes guardrailEvidence to DDB when present (Task 31)', async () => {
    const evidence = {
      groundingScore: 0.88,
      relevanceScore: 0.92,
      arVerdict: null,
      arDetails: null,
      citations: [{ clauseRef: 'ISO 9001 4.1', sourceChunk: 'Context chunk...', score: 0.88 }],
      flagged: true,
    };

    await handler({
      taskToken: 'token-evidence',
      input: {
        tenantId: 'tenant-ev',
        hitlItemId: '06MNO',
        agentName: 'LeadAuditor',
        proposedAction: { tool: 'audit-finding-write', args: { ncId: 'nc-2' } },
        createdAt: '2026-07-16T20:00:00.000Z',
        guardrailEvidence: evidence,
      },
    });

    const call = mockDdbSend.mock.calls[0][0];
    const params = call.input;
    expect(params.UpdateExpression).toContain('guardrailEvidence = :evidence');
    expect(params.ExpressionAttributeValues[':evidence']).toEqual(evidence);
  });

  it('SOD-1 (RS-8): persists requestedBy when present — found dropped at the 2026-07-22 live witness', async () => {
    await handler({
      taskToken: 'token-sod',
      input: {
        tenantId: 'tenant-sod',
        hitlItemId: '08STU',
        agentName: 'CAPAGuru',
        proposedAction: { tool: 'capa-open', args: {} },
        createdAt: '2026-07-22T12:00:00.000Z',
        requestedBy: 'user-proposer-sub',
      },
    });

    const call = mockDdbSend.mock.calls[0][0];
    expect(call.input.UpdateExpression).toContain('requestedBy = :requestedBy');
    expect(call.input.ExpressionAttributeValues[':requestedBy']).toBe('user-proposer-sub');
  });

  it('SOD-1: omits requestedBy entirely for event-triggered runs (no empty-string write)', async () => {
    await handler({
      taskToken: 'token-no-sod',
      input: {
        tenantId: 'tenant-nosod',
        hitlItemId: '09VWX',
        agentName: 'CAPAGuru',
        proposedAction: { tool: 'capa-open', args: {} },
        createdAt: '2026-07-22T12:01:00.000Z',
      },
    });

    const call = mockDdbSend.mock.calls[0][0];
    expect(call.input.UpdateExpression).not.toContain('requestedBy');
    expect(call.input.ExpressionAttributeValues[':requestedBy']).toBeUndefined();
  });

  it('L5-1: omits guardrailEvidence from UpdateExpression when absent', async () => {
    await handler({
      taskToken: 'token-no-evidence',
      input: {
        tenantId: 'tenant-noev',
        hitlItemId: '07PQR',
        agentName: 'CAPAGuru',
        proposedAction: { tool: 'capa-open', args: {} },
        createdAt: '2026-07-16T21:00:00.000Z',
      },
    });

    const call = mockDdbSend.mock.calls[0][0];
    expect(call.input.UpdateExpression).not.toContain('guardrailEvidence');
    expect(call.input.ExpressionAttributeValues[':evidence']).toBeUndefined();
  });
});
