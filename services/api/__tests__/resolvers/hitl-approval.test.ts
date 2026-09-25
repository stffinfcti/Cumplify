/**
 * Unit tests for hitl-approval resolver.
 * Tests: happy-path approve, happy-path send-back, 403 wrong role,
 * 404 not found, 409 race, 410 expired, justification passthrough.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDdbSend, mockSfnSend, mockResolveHitlItem, mockPublishAuditEvent } = vi.hoisted(() => {
  process.env.CLUSTER_ARN = 'arn:aws:rds:us-east-1:123:cluster:test';
  process.env.APP_ROLE_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:app-role';
  process.env.TABLE_NAME = 'CumplifyCore';
  process.env.BUS_NAME = 'cumplify-events';
  process.env.TENANT_DATA_ROLE_ARN = 'arn:aws:iam::123:role/tenant-data-role';
  process.env.REGION = 'us-east-1';

  const mockDdbSend = vi.fn();
  const mockSfnSend = vi.fn();
  const mockResolveHitlItem = vi.fn();
  const mockPublishAuditEvent = vi.fn();
  return { mockDdbSend, mockSfnSend, mockResolveHitlItem, mockPublishAuditEvent };
});

vi.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: class {
    send = vi.fn().mockResolvedValue({ FailedEntryCount: 0, Entries: [{ EventId: 'evt-test-1' }] });
  },
  PutEventsCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class {
    send = mockDdbSend;
  },
  GetItemCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
  UpdateItemCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

vi.mock('@aws-sdk/client-sfn', () => ({
  SFNClient: class {
    send = mockSfnSend;
  },
  SendTaskSuccessCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
  SendTaskFailureCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class {
    send = vi.fn().mockResolvedValue({
      Credentials: {
        AccessKeyId: 'AKIA_TEST',
        SecretAccessKey: 'secret',
        SessionToken: 'token',
        Expiration: new Date(Date.now() + 900_000),
      },
    });
  },
  AssumeRoleCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('@aws-sdk/client-rds-data', () => ({
  RDSDataClient: class {
    send = vi.fn();
  },
  BeginTransactionCommand: class {
    constructor(public input: unknown) {}
  },
  CommitTransactionCommand: class {
    constructor(public input: unknown) {}
  },
  RollbackTransactionCommand: class {
    constructor(public input: unknown) {}
  },
  ExecuteStatementCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('@aws-lambda-powertools/logger', () => ({
  Logger: class {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    appendKeys = vi.fn();
  },
}));

vi.mock('../../../../eventing/src/publisher.js', () => ({
  publish: vi.fn().mockResolvedValue('mock-event-id'),
}));

vi.mock('../../../agents/shared/hitl.js', () => ({
  resolveHitlItem: mockResolveHitlItem,
}));

import { handler } from '../../src/resolvers/hitl-approval.js';
import { marshall } from '@aws-sdk/util-dynamodb';

const TENANT_ID = 'tenant-001';

function makeEvent(args: Record<string, unknown>, role = 'management-rep') {
  return {
    info: { fieldName: 'approveHitlItem' },
    arguments: args,
    identity: {
      resolverContext: {
        tenantId: TENANT_ID,
        sub: 'approver-user-1',
        role,
        poolClass: 'tenant-user',
        entitlement: '{}',
      },
    },
  };
}

function makeDdbItem(overrides: Record<string, unknown> = {}) {
  return marshall({
    PK: `TENANT#${TENANT_ID}#HITL`,
    SK: 'PENDING#hitl-item-123',
    GSI9PK: `TENANT#${TENANT_ID}#HITL_PENDING`,
    GSI9SK: '2024-01-15T10:00:00.000Z',
    agentName: 'risk-agent',
    standard: 'ISO9001',
    module: 'M5',
    proposedAction: { tool: 'clause-7.1.2', args: { severity: 'HIGH' } },
    status: 'PENDING',
    createdAt: '2024-01-15T10:00:00.000Z',
    taskToken: 'sfn-task-token-abc123',
    sfnExecutionArn: 'arn:aws:states:us-east-1:123:execution:hitl-sm:hitl-risk-01',
    ...overrides,
  });
}

beforeEach(() => {
  mockDdbSend.mockReset();
  mockSfnSend.mockReset();
  mockResolveHitlItem.mockReset();
  mockPublishAuditEvent.mockReset();
  mockResolveHitlItem.mockResolvedValue(undefined);
  mockSfnSend.mockResolvedValue({});
  mockPublishAuditEvent.mockResolvedValue('01TESTEVENTULID0000000000');
});

describe('hitl-approval resolver — happy path approve', () => {
  it('approves a pending HITL item successfully', async () => {
    // GetItem returns the pending item
    mockDdbSend.mockResolvedValueOnce({ Item: makeDdbItem() });
    // UpdateItem (conditional) succeeds
    mockDdbSend.mockResolvedValueOnce({});

    const result = await handler(
      makeEvent({
        input: {
          hitlItemId: 'hitl-item-123',
          decision: 'APPROVE',
          justification: 'Looks good',
        },
      }),
    );

    // Schema shape — every field non-nullable in HitlApprovalResult, and
    // tenantId is the onHitlItemResolved(tenantId:) delivery-filter field
    // (BUG-12/12b: the old {success,...} shape failed response marshalling
    // after SendTaskSuccess had already fired).
    expect(result.hitlItemId).toBe('hitl-item-123');
    expect(result.tenantId).toBe(TENANT_ID);
    expect(result.decision).toBe('APPROVE');
    expect(result.auditEventId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // real ULID from the publisher
    expect(result.auditEventTimestamp).toBeTruthy();
    expect(result.resolvedBy).toBe('approver-user-1');
    expect(result.resolvedAt).toBeTruthy();
    expect((result as unknown as Record<string, unknown>).success).toBeUndefined();

    // Verify SFN SendTaskSuccess was called
    expect(mockSfnSend).toHaveBeenCalledTimes(1);
    const sfnCmd = mockSfnSend.mock.calls[0][0];
    expect(sfnCmd.input.taskToken).toBe('sfn-task-token-abc123');
    const output = JSON.parse(sfnCmd.input.output);
    expect(output.decision).toBe('APPROVE');
    expect(output.approverSub).toBe('approver-user-1');
    expect(output.justification).toBe('Looks good');

    // Verify resolveHitlItem was called with the tenant-scoped client (BUG-14:
    // the ambient role has no DDB grants)
    expect(mockResolveHitlItem).toHaveBeenCalledWith(
      TENANT_ID,
      'hitl-item-123',
      'APPROVED',
      'approver-user-1',
      expect.anything(),
    );
  });

  it('passes editedPayload in SFN output when provided', async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: makeDdbItem() });
    mockDdbSend.mockResolvedValueOnce({});

    await handler(
      makeEvent({
        input: {
          hitlItemId: 'hitl-item-123',
          decision: 'APPROVE',
          editedPayload: { severity: 'MEDIUM' },
        },
      }),
    );

    const sfnCmd = mockSfnSend.mock.calls[0][0];
    const output = JSON.parse(sfnCmd.input.output);
    expect(output.editedPayload).toEqual({ severity: 'MEDIUM' });
  });
});

describe('hitl-approval resolver — happy path send-back', () => {
  it('sends back a pending HITL item successfully', async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: makeDdbItem() });
    mockDdbSend.mockResolvedValueOnce({});

    const result = await handler(
      makeEvent({
        input: {
          hitlItemId: 'hitl-item-123',
          decision: 'SEND_BACK',
          justification: 'Needs more detail',
        },
      }),
    );

    expect(result.decision).toBe('SEND_BACK');
    expect(result.tenantId).toBe(TENANT_ID);
    expect(result.auditEventId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(result.resolvedBy).toBe('approver-user-1');

    // Verify SFN SendTaskFailure was called
    expect(mockSfnSend).toHaveBeenCalledTimes(1);
    const sfnCmd = mockSfnSend.mock.calls[0][0];
    expect(sfnCmd.input.taskToken).toBe('sfn-task-token-abc123');
    expect(sfnCmd.input.error).toBe('SENT_BACK');
    expect(sfnCmd.input.cause).toBe('Needs more detail');

    // Verify resolveHitlItem was called with REJECTED + the tenant-scoped client
    expect(mockResolveHitlItem).toHaveBeenCalledWith(
      TENANT_ID,
      'hitl-item-123',
      'REJECTED',
      'approver-user-1',
      expect.anything(),
    );
  });
});

describe('hitl-approval resolver — 403 wrong role', () => {
  it('rejects when role lacks approval permission for the module', async () => {
    // Item has module M5, employee can only approve M10
    mockDdbSend.mockResolvedValueOnce({ Item: makeDdbItem({ module: 'M5' }) });

    await expect(
      handler(
        makeEvent(
          {
            input: {
              hitlItemId: 'hitl-item-123',
              decision: 'APPROVE',
            },
          },
          'employee',
        ),
      ),
    ).rejects.toThrow(/cannot approve/);
  });
});

describe('hitl-approval resolver — 404 not found', () => {
  it('throws 404 when item does not exist', async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: undefined });

    await expect(
      handler(
        makeEvent({
          input: {
            hitlItemId: 'nonexistent-item',
            decision: 'APPROVE',
          },
        }),
      ),
    ).rejects.toThrow(/not found/);
  });
});

describe('hitl-approval resolver — 409 race condition', () => {
  it('throws 409 when conditional update fails (item already being resolved)', async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: makeDdbItem() });
    // UpdateItem throws ConditionalCheckFailedException
    const condErr = new Error('Conditional check failed');
    (condErr as unknown as Record<string, string>).name = 'ConditionalCheckFailedException';
    mockDdbSend.mockRejectedValueOnce(condErr);

    await expect(
      handler(
        makeEvent({
          input: {
            hitlItemId: 'hitl-item-123',
            decision: 'APPROVE',
          },
        }),
      ),
    ).rejects.toThrow(/already resolved/);
  });
});

describe('hitl-approval resolver — 410 SFN expired', () => {
  it('throws 410 when SFN task does not exist', async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: makeDdbItem() });
    mockDdbSend.mockResolvedValueOnce({});
    const sfnErr = new Error('Task does not exist');
    (sfnErr as unknown as Record<string, string>).name = 'TaskDoesNotExist';
    mockSfnSend.mockRejectedValueOnce(sfnErr);

    await expect(
      handler(
        makeEvent({
          input: {
            hitlItemId: 'hitl-item-123',
            decision: 'APPROVE',
          },
        }),
      ),
    ).rejects.toThrow(/expired/);
  });

  it('throws 410 when SFN task has timed out', async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: makeDdbItem() });
    mockDdbSend.mockResolvedValueOnce({});
    const sfnErr = new Error('Task timed out');
    (sfnErr as unknown as Record<string, string>).name = 'TaskTimedOut';
    mockSfnSend.mockRejectedValueOnce(sfnErr);

    await expect(
      handler(
        makeEvent({
          input: {
            hitlItemId: 'hitl-item-123',
            decision: 'APPROVE',
          },
        }),
      ),
    ).rejects.toThrow(/expired/);
  });
});

describe('hitl-approval resolver — justification passthrough', () => {
  it('passes justification in APPROVE output', async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: makeDdbItem() });
    mockDdbSend.mockResolvedValueOnce({});

    await handler(
      makeEvent({
        input: {
          hitlItemId: 'hitl-item-123',
          decision: 'APPROVE',
          justification: 'Reviewed and acceptable per clause 7.1.2',
        },
      }),
    );

    const sfnCmd = mockSfnSend.mock.calls[0][0];
    const output = JSON.parse(sfnCmd.input.output);
    expect(output.justification).toBe('Reviewed and acceptable per clause 7.1.2');
  });

  it('uses default cause when justification is absent in SEND_BACK', async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: makeDdbItem() });
    mockDdbSend.mockResolvedValueOnce({});

    await handler(
      makeEvent({
        input: {
          hitlItemId: 'hitl-item-123',
          decision: 'SEND_BACK',
        },
      }),
    );

    const sfnCmd = mockSfnSend.mock.calls[0][0];
    expect(sfnCmd.input.cause).toBe('No reason provided');
  });
});

describe('hitl-approval resolver — L5-2 flagged justification enforcement (Task 32)', () => {
  it('throws 400 when approving flagged item without justification', async () => {
    // Item has guardrailEvidence.flagged = true
    mockDdbSend.mockResolvedValueOnce({
      Item: makeDdbItem({ guardrailEvidence: { flagged: true, groundingScore: 0.4 } }),
    });
    mockDdbSend.mockResolvedValueOnce({}); // conditional update

    await expect(
      handler(
        makeEvent({
          input: {
            hitlItemId: 'hitl-item-123',
            decision: 'APPROVE',
            // justification intentionally omitted
          },
        }),
      ),
    ).rejects.toThrow(/Justification required/);
  });

  it('approves flagged item when justification is provided + stamps flaggedApproval on audit event', async () => {
    mockDdbSend.mockResolvedValueOnce({
      Item: makeDdbItem({
        guardrailEvidence: { flagged: true, groundingScore: 0.42, relevanceScore: 0.6 },
      }),
    });
    mockDdbSend.mockResolvedValueOnce({}); // conditional update

    const result = await handler(
      makeEvent({
        input: {
          hitlItemId: 'hitl-item-123',
          decision: 'APPROVE',
          justification:
            'Reviewed with domain expert — content is accurate despite low grounding score',
        },
      }),
    );

    expect(result.decision).toBe('APPROVE');
    // SFN called successfully
    expect(mockSfnSend).toHaveBeenCalledTimes(1);
  });

  it('does NOT require justification when item is NOT flagged', async () => {
    // Item has guardrailEvidence.flagged = false
    mockDdbSend.mockResolvedValueOnce({
      Item: makeDdbItem({ guardrailEvidence: { flagged: false, groundingScore: 0.92 } }),
    });
    mockDdbSend.mockResolvedValueOnce({}); // conditional update

    const result = await handler(
      makeEvent({
        input: {
          hitlItemId: 'hitl-item-123',
          decision: 'APPROVE',
          // no justification — should be fine because not flagged
        },
      }),
    );

    expect(result.decision).toBe('APPROVE');
  });

  it('does NOT require justification for SEND_BACK on flagged items', async () => {
    mockDdbSend.mockResolvedValueOnce({
      Item: makeDdbItem({ guardrailEvidence: { flagged: true, groundingScore: 0.3 } }),
    });
    mockDdbSend.mockResolvedValueOnce({}); // conditional update

    const result = await handler(
      makeEvent({
        input: {
          hitlItemId: 'hitl-item-123',
          decision: 'SEND_BACK',
          // no justification needed for send-back
        },
      }),
    );

    expect(result.decision).toBe('SEND_BACK');
  });
});

describe('hitl-approval resolver — SOD-1 author≠approver (architecture §8)', () => {
  it('403 when the proposer attempts to approve their own item', async () => {
    mockDdbSend.mockResolvedValueOnce({
      Item: makeDdbItem({ requestedBy: 'approver-user-1' }),
    });

    await expect(
      handler(makeEvent({ input: { hitlItemId: 'hitl-item-123', decision: 'APPROVE' } }) as never),
    ).rejects.toThrow(/SoD violation/);
    // blocked BEFORE the RESOLVING update and BEFORE SFN
    expect(mockSfnSend).not.toHaveBeenCalled();
  });

  it('proceeds when the approver is a different identity', async () => {
    mockDdbSend.mockResolvedValueOnce({
      Item: makeDdbItem({ requestedBy: 'someone-else' }),
    });
    mockDdbSend.mockResolvedValueOnce({}); // RESOLVING update

    const result = (await handler(
      makeEvent({ input: { hitlItemId: 'hitl-item-123', decision: 'APPROVE' } }) as never,
    )) as { decision: string };
    expect(result.decision).toBe('APPROVE');
  });

  it('SEND_BACK by the proposer is allowed (only self-APPROVAL is SoD)', async () => {
    mockDdbSend.mockResolvedValueOnce({
      Item: makeDdbItem({ requestedBy: 'approver-user-1' }),
    });
    mockDdbSend.mockResolvedValueOnce({}); // RESOLVING update

    const result = (await handler(
      makeEvent({ input: { hitlItemId: 'hitl-item-123', decision: 'SEND_BACK' } }) as never,
    )) as { decision: string };
    expect(result.decision).toBe('SEND_BACK');
  });
});

describe('hitl-approval resolver — RS-6 approval-matrix narrowing', () => {
  const capaItem = (overrides: Record<string, unknown> = {}) =>
    makeDdbItem({
      module: 'M2',
      proposedAction: { tool: 'capa-open', args: {} },
      ...overrides,
    });
  const matrixEntryItem = (approveRole: string) =>
    marshall({
      PK: `TENANT#${TENANT_ID}#GOVERNANCE`,
      SK: 'APPROVALMATRIX#capa#ISO9001',
      artifactType: 'capa',
      standard: 'ISO9001',
      steps: JSON.stringify([{ roleSlug: approveRole, action: 'approve' }]),
      version: 1,
    });

  it('matrix narrows: floor-passing role denied when entry excludes it', async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: capaItem() }); // HITL item
    mockDdbSend.mockResolvedValueOnce({ Item: matrixEntryItem('top-management') }); // matrix

    await expect(
      handler(
        makeEvent(
          { input: { hitlItemId: 'hitl-item-123', decision: 'APPROVE' } },
          'quality-manager', // passes the M2 floor — narrowed out by matrix
        ) as never,
      ),
    ).rejects.toThrow(/Approval matrix/);
    expect(mockSfnSend).not.toHaveBeenCalled();
  });

  it('no matrix entry → floor alone governs (approve succeeds)', async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: capaItem() }); // HITL item
    mockDdbSend.mockResolvedValueOnce({}); // exact-standard matrix miss
    mockDdbSend.mockResolvedValueOnce({}); // ANY fallback miss
    mockDdbSend.mockResolvedValueOnce({}); // RESOLVING update

    const result = (await handler(
      makeEvent(
        { input: { hitlItemId: 'hitl-item-123', decision: 'APPROVE' } },
        'quality-manager',
      ) as never,
    )) as { decision: string };
    expect(result.decision).toBe('APPROVE');
  });

  it('THE FLOOR INVARIANT: matrix granting a floor-denied role cannot rescue it (403 at floor, matrix never consulted)', async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: capaItem() }); // HITL item only

    await expect(
      handler(
        makeEvent(
          { input: { hitlItemId: 'hitl-item-123', decision: 'APPROVE' } },
          'employee',
        ) as never,
      ),
    ).rejects.toThrow(/cannot approve items in module/);
    // exactly ONE ddb call (the item Get) — floor 403'd before matrix read
    expect(mockDdbSend).toHaveBeenCalledTimes(1);
  });
});
