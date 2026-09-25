/**
 * Unit tests for HITL gate module.
 *
 * Task 8R-2: enterHitlGate NO LONGER writes DDB — only starts SFN execution.
 * The DDB item is created by store-token.ts (first SFN state).
 * GSI9 assertions are in store-token.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSfnSend = vi.fn();
const mockDdbSend = vi.fn();

vi.mock('@aws-sdk/client-sfn', () => ({
  SFNClient: class {
    send = mockSfnSend;
  },
  StartExecutionCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

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
vi.stubEnv('HITL_STATE_MACHINE_ARN', 'arn:aws:states:us-east-1:123456:stateMachine:AgentHitl');

const { enterHitlGate, resolveHitlItem } = await import('../hitl.js');

describe('enterHitlGate', () => {
  beforeEach(() => {
    mockSfnSend.mockReset();
    mockDdbSend.mockReset();
  });

  it('starts SFN execution with correct input including item payload fields', async () => {
    mockSfnSend.mockResolvedValueOnce({
      executionArn: 'arn:aws:states:us-east-1:123:execution:hitl-test',
    });

    const result = await enterHitlGate({
      tenantId: 'tenant-1',
      agentName: 'CAPAGuru',
      proposedAction: { tool: 'capa-open', args: { ncId: 'nc-1' } },
      conversationState: [{ role: 'user', content: [{ text: 'hello' }] }],
    });

    expect(result.status).toBe('HITL_PENDING');
    expect(result.executionArn).toContain('hitl-test');
    expect(result.hitlItemId).toBeDefined();

    // Verify SFN was called
    const sfnCall = mockSfnSend.mock.calls[0][0];
    expect(sfnCall.input.stateMachineArn).toBe(
      'arn:aws:states:us-east-1:123456:stateMachine:AgentHitl',
    );
    const sfnInput = JSON.parse(sfnCall.input.input);
    expect(sfnInput.tenantId).toBe('tenant-1');
    expect(sfnInput.agentName).toBe('CAPAGuru');
    expect(sfnInput.proposedAction.tool).toBe('capa-open');
    expect(sfnInput.hitlItemId).toBe(result.hitlItemId);
    expect(sfnInput.createdAt).toBeDefined(); // ISO timestamp passed for store-token
  });

  it('does NOT write to DynamoDB (zero DDB permissions on handler)', async () => {
    mockSfnSend.mockResolvedValueOnce({ executionArn: 'arn:exec:123' });

    await enterHitlGate({
      tenantId: 'tenant-abc',
      agentName: 'DocStudio',
      proposedAction: { tool: 'doc-publish', args: { docId: 'd-1' } },
      conversationState: [],
    });

    // DDB should NOT be called at all from enterHitlGate
    expect(mockDdbSend).not.toHaveBeenCalled();
  });

  it('passes createdAt in SFN input for store-token to use', async () => {
    mockSfnSend.mockResolvedValueOnce({ executionArn: 'arn:exec:456' });

    await enterHitlGate({
      tenantId: 'tenant-x',
      agentName: 'LeadAuditor',
      proposedAction: { tool: 'audit-finding-write', args: {} },
      conversationState: [],
    });

    const sfnCall = mockSfnSend.mock.calls[0][0];
    const sfnInput = JSON.parse(sfnCall.input.input);
    // createdAt must be an ISO string
    expect(sfnInput.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('generates a ULID hitlItemId', async () => {
    mockSfnSend.mockResolvedValueOnce({ executionArn: 'arn:exec:789' });

    const result = await enterHitlGate({
      tenantId: 'tenant-1',
      agentName: 'CAPAGuru',
      proposedAction: { tool: 'capa-open', args: {} },
      conversationState: [],
    });

    // ULID is 26 chars, uppercase alphanumeric
    expect(result.hitlItemId).toMatch(/^[0-9A-Z]{26}$/);
  });
});

describe('resolveHitlItem', () => {
  beforeEach(() => {
    mockDdbSend.mockReset();
  });

  it('removes GSI attributes on resolution (sparse GSI pattern)', async () => {
    mockDdbSend.mockResolvedValueOnce({});

    await resolveHitlItem('tenant-1', 'hitl-001', 'APPROVED', 'user-sub-xyz', {
      send: mockDdbSend,
    });

    const ddbCall = mockDdbSend.mock.calls[0][0];
    const updateExpr: string = ddbCall.input.UpdateExpression;

    // Must REMOVE GSI9 attributes (sparse GSI pattern)
    expect(updateExpr).toContain('REMOVE GSI9PK, GSI9SK');
    // Must SET status + resolvedAt + approver + TTL
    expect(updateExpr).toContain('SET #status = :status');
    expect(ddbCall.input.ExpressionAttributeValues[':status']).toBe('APPROVED');
    expect(ddbCall.input.ExpressionAttributeValues[':approver']).toBe('user-sub-xyz');
  });

  it('sets TTL to ~30 days from now', async () => {
    mockDdbSend.mockResolvedValueOnce({});

    await resolveHitlItem('tenant-1', 'hitl-002', 'TIMED_OUT', undefined, {
      send: mockDdbSend,
    });

    const ddbCall = mockDdbSend.mock.calls[0][0];
    const ttl = ddbCall.input.ExpressionAttributeValues[':ttl'];
    const thirtyDaysFromNow = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
    expect(ttl).toBeGreaterThan(thirtyDaysFromNow - 10);
    expect(ttl).toBeLessThan(thirtyDaysFromNow + 10);
  });
});
