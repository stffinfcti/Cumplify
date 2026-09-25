/**
 * Unit tests for runCapaAnalysis (m2.ts) / runRiskAssessment (m5.ts) —
 * RS-8, read-surface-completion. Pins: RDS context fetch (this Lambda has
 * access, the agent handler does not — AgentHandlerReadOnlyPolicy, T-1),
 * fire-and-forget async Lambda:Invoke (InvocationType 'Event' — never
 * RequestResponse, which risks AppSync's ~30s resolver ceiling), requestedBy
 * threaded into the payload (SOD-1), NOT_FOUND paths, DISPATCHED ack shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExecute, mockCommit, mockRollback, mockLambdaSend } = vi.hoisted(() => {
  process.env.CAPA_GURU_FN_ARN = 'arn:aws:lambda:us-east-1:123:function:CapaGuruFn';
  process.env.RISK_SENTINEL_FN_ARN = 'arn:aws:lambda:us-east-1:123:function:RiskSentinelFn';
  process.env.DOC_STUDIO_FN_ARN = 'arn:aws:lambda:us-east-1:123:function:DocStudioFn';
  return {
    mockExecute: vi.fn(),
    mockCommit: vi.fn(),
    mockRollback: vi.fn(),
    mockLambdaSend: vi.fn().mockResolvedValue({}),
  };
});

vi.mock('../../src/resolvers/shared.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/resolvers/shared.js')>();
  return {
    ...actual,
    beginTenantTransaction: vi.fn().mockResolvedValue({
      execute: mockExecute,
      commit: mockCommit,
      rollback: mockRollback,
    }),
    publishAuditEvent: vi.fn().mockResolvedValue('evt-test'),
  };
});

vi.mock('@aws-lambda-powertools/logger', () => ({
  Logger: class {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    appendKeys = vi.fn();
  },
}));

vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class {
    send = mockLambdaSend;
  },
  InvokeCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('ulid', () => ({ ulid: () => 'run-fixed-01' }));

import { handler as m2Handler } from '../../src/resolvers/m2.js';
import { handler as m5Handler } from '../../src/resolvers/m5.js';
import { handler as m1Handler } from '../../src/resolvers/m1.js';

function makeEvent(fieldName: string, args: Record<string, unknown> = {}) {
  return {
    info: { fieldName },
    arguments: args,
    identity: { resolverContext: { tenantId: 'tenant-test', sub: 'user-9', role: 'IMSLead' } },
  };
}

beforeEach(() => {
  mockExecute.mockReset();
  mockCommit.mockReset();
  mockRollback.mockReset();
  mockLambdaSend.mockReset().mockResolvedValue({});
});

describe('runCapaAnalysis (m2.ts)', () => {
  it('fetches NC + CAs, async-invokes CAPAGuru with requestedBy, returns DISPATCHED ack', async () => {
    mockExecute
      .mockResolvedValueOnce({
        records: [
          [
            { stringValue: 'Widget cracked' },
            { stringValue: 'NC' },
            { stringValue: 'HIGH' },
            { stringValue: 'ISO9001' },
            { stringValue: 'OPEN' },
          ],
        ],
        columnMetadata: [
          { name: 'description' },
          { name: 'nc_type' },
          { name: 'severity' },
          { name: 'standard' },
          { name: 'status' },
        ],
      })
      .mockResolvedValueOnce({
        records: [
          [
            { stringValue: 'ca-1' },
            { stringValue: 'Retrain' },
            { stringValue: 'OPEN' },
            { stringValue: 'owner-1' },
          ],
        ],
        columnMetadata: [
          { name: 'id' },
          { name: 'action_desc' },
          { name: 'status' },
          { name: 'owner_id' },
        ],
      });

    const result = await m2Handler(makeEvent('runCapaAnalysis', { ncId: 'nc-1' }));
    expect(result).toEqual({ runId: 'run-fixed-01', status: 'DISPATCHED' });

    expect(mockCommit).toHaveBeenCalledOnce();
    expect(mockLambdaSend).toHaveBeenCalledOnce();
    const invokeInput = mockLambdaSend.mock.calls[0][0].input as {
      FunctionName: string;
      InvocationType: string;
      Payload: string;
    };
    expect(invokeInput.FunctionName).toBe('arn:aws:lambda:us-east-1:123:function:CapaGuruFn');
    expect(invokeInput.InvocationType).toBe('Event'); // fire-and-forget, never RequestResponse
    const payload = JSON.parse(invokeInput.Payload);
    expect(payload).toMatchObject({
      tenantId: 'tenant-test',
      runId: 'run-fixed-01',
      ncId: 'nc-1',
      requestedBy: 'user-9',
      context: {
        nc: { description: 'Widget cracked', ncType: 'nc', severity: 'high', status: 'open' },
        correctiveActions: [
          { id: 'ca-1', actionDesc: 'Retrain', status: 'open', ownerId: 'owner-1' },
        ],
      },
    });
  });

  it('throws NC_NOT_FOUND and rolls back without invoking CAPAGuru', async () => {
    mockExecute.mockResolvedValueOnce({ records: [], columnMetadata: [] });

    await expect(m2Handler(makeEvent('runCapaAnalysis', { ncId: 'missing' }))).rejects.toThrow(
      'NC_NOT_FOUND',
    );
    expect(mockRollback).toHaveBeenCalledOnce();
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });
});

describe('runNcIntake (m2.ts, S1 studio wave)', () => {
  it('dispatches the intake payload to CAPAGuru with requestedBy — no DB reads (nothing exists yet)', async () => {
    const result = await m2Handler(
      makeEvent('runNcIntake', {
        description: 'Cabinet doors delivered with wrong finish on lot 42',
        evidenceNote: 'Photos attached to job folder',
      }),
    );

    expect(result).toEqual({ runId: 'run-fixed-01', status: 'DISPATCHED' });
    // Stage-1 intake: no NC exists — the resolver must not touch RDS
    expect(mockExecute).not.toHaveBeenCalled();

    const cmd = mockLambdaSend.mock.calls[0][0] as {
      input: { FunctionName: string; InvocationType: string; Payload: string };
    };
    expect(cmd.input.FunctionName).toBe('arn:aws:lambda:us-east-1:123:function:CapaGuruFn');
    expect(cmd.input.InvocationType).toBe('Event'); // fire-and-forget
    const payload = JSON.parse(cmd.input.Payload);
    expect(payload).toEqual({
      tenantId: 'tenant-test',
      runId: 'run-fixed-01',
      requestedBy: 'user-9', // SOD-1: the reporter cannot approve the draft
      intake: {
        description: 'Cabinet doors delivered with wrong finish on lot 42',
        evidenceNote: 'Photos attached to job folder',
      },
    });
  });

  it('rejects an empty description without invoking the agent', async () => {
    await expect(m2Handler(makeEvent('runNcIntake', { description: '   ' }))).rejects.toThrow(
      'VALIDATION',
    );
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });
});

describe('runDocDraft (m1.ts, S2 studio wave)', () => {
  it('dispatches the draft intent + CURRENT ORG PROFILE to DocStudio (S2.3: "[Organization Name]" shipped on a live card without it)', async () => {
    mockExecute.mockResolvedValueOnce({
      records: [[{ stringValue: JSON.stringify({ legalName: 'Meridian Design-Build LLC' }) }]],
      columnMetadata: [{ name: 'payload' }],
    });

    const result = await m1Handler(
      makeEvent('runDocDraft', {
        intent: 'A procedure for controlling subcontractor site work',
        docType: 'procedure',
        standard: 'ISO9001',
      }),
    );

    expect(result).toEqual({ runId: 'run-fixed-01', status: 'DISPATCHED' });

    const cmd = mockLambdaSend.mock.calls[0][0] as {
      input: { FunctionName: string; InvocationType: string; Payload: string };
    };
    expect(cmd.input.FunctionName).toBe('arn:aws:lambda:us-east-1:123:function:DocStudioFn');
    expect(cmd.input.InvocationType).toBe('Event');
    const payload = JSON.parse(cmd.input.Payload);
    expect(payload).toEqual({
      tenantId: 'tenant-test',
      runId: 'run-fixed-01',
      requestedBy: 'user-9',
      draftIntent: {
        intent: 'A procedure for controlling subcontractor site work',
        docType: 'procedure',
        standard: 'ISO9001',
        orgProfile: { legalName: 'Meridian Design-Build LLC' },
      },
    });
  });

  it('pre-wizard tenant (no profile row) still dispatches — draftIntent simply has no orgProfile', async () => {
    mockExecute.mockResolvedValueOnce({ records: [], columnMetadata: [] });

    const result = await m1Handler(makeEvent('runDocDraft', { intent: 'A calibration procedure' }));
    expect(result).toEqual({ runId: 'run-fixed-01', status: 'DISPATCHED' });
    const payload = JSON.parse(
      (mockLambdaSend.mock.calls[0][0] as { input: { Payload: string } }).input.Payload,
    );
    expect(payload.draftIntent.orgProfile).toBeUndefined();
  });

  it('rejects an empty intent without invoking the agent', async () => {
    await expect(m1Handler(makeEvent('runDocDraft', { intent: ' ' }))).rejects.toThrow(
      'VALIDATION',
    );
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });
});

describe('runRiskAssessment (m5.ts)', () => {
  it('fetches risk, async-invokes RiskSentinel with requestedBy, returns DISPATCHED ack', async () => {
    mockExecute.mockResolvedValueOnce({
      records: [
        [
          { stringValue: 'Supplier drift' },
          { stringValue: 'QUALITY' },
          { stringValue: 'ISO9001' },
          { longValue: 2 },
          { longValue: 3 },
        ],
      ],
      columnMetadata: [
        { name: 'description' },
        { name: 'category' },
        { name: 'standard' },
        { name: 'likelihood' },
        { name: 'severity' },
      ],
    });

    const result = await m5Handler(makeEvent('runRiskAssessment', { riskId: 'risk-1' }));
    expect(result).toEqual({ runId: 'run-fixed-01', status: 'DISPATCHED' });

    expect(mockCommit).toHaveBeenCalledOnce();
    const invokeInput = mockLambdaSend.mock.calls[0][0].input as {
      FunctionName: string;
      InvocationType: string;
      Payload: string;
    };
    expect(invokeInput.FunctionName).toBe('arn:aws:lambda:us-east-1:123:function:RiskSentinelFn');
    expect(invokeInput.InvocationType).toBe('Event');
    const payload = JSON.parse(invokeInput.Payload);
    expect(payload).toMatchObject({
      tenantId: 'tenant-test',
      runId: 'run-fixed-01',
      riskId: 'risk-1',
      requestedBy: 'user-9',
      context: {
        description: 'Supplier drift',
        category: 'quality',
        currentLikelihood: 2,
        currentSeverity: 3,
      },
    });
  });

  it('throws RISK_NOT_FOUND and rolls back without invoking RiskSentinel', async () => {
    mockExecute.mockResolvedValueOnce({ records: [], columnMetadata: [] });

    await expect(m5Handler(makeEvent('runRiskAssessment', { riskId: 'missing' }))).rejects.toThrow(
      'RISK_NOT_FOUND',
    );
    expect(mockRollback).toHaveBeenCalledOnce();
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });
});
