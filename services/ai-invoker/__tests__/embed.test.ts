/**
 * Unit tests for embed.ts — spec-35 Task 3.
 * Hermetic: mocked BedrockRuntimeClient, DynamoDB, EventBridge.
 * Verifies: InvokeModel call shape, metering, telemetry, credit pre-check.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Bedrock Runtime
const mockBedrockSend = vi.fn();
vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: class {
    send = mockBedrockSend;
  },
  InvokeModelCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

// Mock DynamoDB (used by metering + credit-precheck)
const mockDdbSend = vi.fn();
vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class {
    send = mockDdbSend;
  },
  QueryCommand: class {
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
  GetItemCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

// Mock EventBridge (telemetry)
const mockEbSend = vi.fn();
vi.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: class {
    send = mockEbSend;
  },
  PutEventsCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

vi.stubEnv('TABLE_NAME', 'CumplifyCore');
vi.stubEnv('BUS_NAME', 'cumplify-events');
vi.stubEnv('AWS_REGION', 'us-east-1');

const { embed, resetEmbedClient } = await import('../src/embed.js');
const { resetWeightsCache } = await import('../src/metering.js');

describe('embed', () => {
  beforeEach(() => {
    mockBedrockSend.mockReset();
    mockDdbSend.mockReset();
    mockEbSend.mockReset();
    resetEmbedClient();
    // weightsCache is module-level — isolate per-call DDB queries between its
    resetWeightsCache();

    // Default: credit pre-check passes (GetItem returns balance > 0)
    mockDdbSend.mockImplementation(
      (cmd: { input?: { Key?: unknown; KeyConditionExpression?: string } }) => {
        // Credit pre-check (GetItem on METER)
        if (cmd.input && 'Key' in cmd.input) {
          return Promise.resolve({ Item: null }); // No meter row = no usage = passes
        }
        // loadWeights (QueryCommand on MODELWEIGHT#)
        if (cmd.input && 'KeyConditionExpression' in cmd.input) {
          return Promise.resolve({
            Items: [
              {
                PK: { S: 'MODELWEIGHT#amazon.titan-embed-text-v2:0' },
                SK: { S: 'VERSION#20260716' },
                modelId: { S: 'amazon.titan-embed-text-v2:0' },
                wIn: { N: '20' },
                wOut: { N: '0' },
                effectiveFrom: { S: '2026-07-16' },
                sourceCommit: { S: 'b6f2c39' },
              },
            ],
          });
        }
        // incrementMeter (UpdateItem)
        return Promise.resolve({});
      },
    );

    // Default: telemetry succeeds
    mockEbSend.mockResolvedValue({});
  });

  it('calls InvokeModel with correct model and body shape', async () => {
    mockBedrockSend.mockResolvedValueOnce({
      body: Buffer.from(
        JSON.stringify({
          embedding: Array(1024).fill(0.1),
          inputTextTokenCount: 7,
        }),
      ),
    });

    const result = await embed({
      tenantId: 'tenant-1',
      agent: 'guru-9001',
      module: 'M1',
      feature: 'advisory',
      text: 'What is clause 4.1?',
    });

    // Verify InvokeModel call
    expect(mockBedrockSend).toHaveBeenCalledTimes(1);
    const cmd = mockBedrockSend.mock.calls[0][0] as { input: { modelId: string; body: Buffer } };
    expect(cmd.input.modelId).toBe('amazon.titan-embed-text-v2:0');
    const body = JSON.parse(Buffer.from(cmd.input.body).toString());
    expect(body.inputText).toBe('What is clause 4.1?');
    expect(body.dimensions).toBe(1024);

    // Verify result
    expect(result.embedding).toHaveLength(1024);
    expect(result.tokenCount).toBe(7);
    expect(result.credits).toBeCloseTo((7 * 20) / 1_000_000, 8); // 0.00014
  });

  it('meters credits correctly (inputTokens × wIn / 1M)', async () => {
    mockBedrockSend.mockResolvedValueOnce({
      body: Buffer.from(
        JSON.stringify({
          embedding: Array(1024).fill(0.5),
          inputTextTokenCount: 500,
        }),
      ),
    });

    const result = await embed({
      tenantId: 'tenant-2',
      agent: 'copilot',
      module: 'M3',
      feature: 'advisory',
      text: 'A longer text for embedding purposes',
    });

    // 500 tokens × 20 / 1,000,000 = 0.01 credits
    expect(result.credits).toBeCloseTo(0.01, 6);
    expect(result.tokenCount).toBe(500);
  });

  it('emits telemetry with correct attribution fields', async () => {
    mockBedrockSend.mockResolvedValueOnce({
      body: Buffer.from(
        JSON.stringify({
          embedding: Array(1024).fill(0.0),
          inputTextTokenCount: 10,
        }),
      ),
    });

    await embed({
      tenantId: 'tenant-3',
      agent: 'guru-14001',
      module: 'M6',
      feature: 'advisory',
      text: 'test',
    });

    // Telemetry event emitted
    expect(mockEbSend).toHaveBeenCalledTimes(1);
    const entry = (
      mockEbSend.mock.calls[0][0] as {
        input: { Entries: Array<{ Detail: string }> };
      }
    ).input.Entries[0];
    const detail = JSON.parse(entry.Detail);
    expect(detail.tenantId).toBe('tenant-3');
    expect(detail.agent).toBe('guru-14001');
    expect(detail.module).toBe('M6');
    expect(detail.feature).toBe('advisory');
    expect(detail.modelId).toBe('amazon.titan-embed-text-v2:0');
    expect(detail.seat).toBe('embed');
    expect(detail.inputTokens).toBe(10);
    expect(detail.outputTokens).toBe(0);
  });

  it('does NOT implement AOSS retry (EMB-5 — pure embedding call)', async () => {
    // The embed function should NOT catch/retry AOSS errors — that's the caller's job.
    // This test verifies embed makes exactly ONE Bedrock call and returns.
    mockBedrockSend.mockResolvedValueOnce({
      body: Buffer.from(
        JSON.stringify({
          embedding: Array(1024).fill(0.0),
          inputTextTokenCount: 3,
        }),
      ),
    });

    await embed({
      tenantId: 'tenant-1',
      agent: 'guru-9001',
      module: 'M1',
      feature: 'advisory',
      text: 'hi',
    });

    expect(mockBedrockSend).toHaveBeenCalledTimes(1);
  });
});

describe('embed — systemOp threading (iso-kb-seeding Task 2)', () => {
  beforeEach(() => {
    mockBedrockSend.mockReset();
    mockDdbSend.mockReset();
    mockEbSend.mockReset();
    resetEmbedClient();
    resetWeightsCache();

    // loadWeights returns valid weights
    mockDdbSend.mockImplementation(
      (cmd: { input?: { Key?: unknown; KeyConditionExpression?: string } }) => {
        if (cmd.input && 'KeyConditionExpression' in cmd.input) {
          return Promise.resolve({
            Items: [
              {
                PK: { S: 'MODELWEIGHT#amazon.titan-embed-text-v2:0' },
                SK: { S: 'VERSION#20260716' },
                modelId: { S: 'amazon.titan-embed-text-v2:0' },
                wIn: { N: '20' },
                wOut: { N: '0' },
                effectiveFrom: { S: '2026-07-16' },
                sourceCommit: { S: 'b6f2c39' },
              },
            ],
          });
        }
        return Promise.resolve({});
      },
    );

    mockEbSend.mockResolvedValue({});
    mockBedrockSend.mockResolvedValue({
      body: Buffer.from(
        JSON.stringify({
          embedding: Array(1024).fill(0.1),
          inputTextTokenCount: 15,
        }),
      ),
    });
  });

  it('systemOp: true skips credit pre-check (SERVE-9 exempt flag)', async () => {
    // Track calls to understand what DDB calls happen
    const callLog: string[] = [];
    mockDdbSend.mockImplementation((cmd: { input?: Record<string, unknown> }) => {
      if (cmd.input && 'KeyConditionExpression' in cmd.input) {
        callLog.push('query:loadWeights');
        return Promise.resolve({
          Items: [
            {
              PK: { S: 'MODELWEIGHT#amazon.titan-embed-text-v2:0' },
              SK: { S: 'VERSION#20260716' },
              modelId: { S: 'amazon.titan-embed-text-v2:0' },
              wIn: { N: '20' },
              wOut: { N: '0' },
              effectiveFrom: { S: '2026-07-16' },
              sourceCommit: { S: 'b6f2c39' },
            },
          ],
        });
      }
      if (cmd.input && 'UpdateExpression' in cmd.input) {
        callLog.push('update:incrementMeter');
        return Promise.resolve({});
      }
      if (cmd.input && 'Key' in cmd.input) {
        const pk = (cmd.input.Key as Record<string, { S?: string }>)?.PK?.S ?? '';
        callLog.push(`getItem:${pk}`);
        return Promise.resolve({ Item: null });
      }
      return Promise.resolve({});
    });

    await embed({
      tenantId: '__ISO_CANON__',
      agent: 'iso-kb-seeder',
      module: 'system',
      feature: 'seed',
      text: 'ISO 9001 4.1 context clause',
      systemOp: true,
    });

    // With systemOp: true, checkCreditBalance skips immediately (no DDB GetItem calls
    // for METER or ENTITLEMENT). Only loadWeights and incrementMeter should fire.
    const creditCheckCalls = callLog.filter(
      (c) => c.includes('METER') || c.includes('ENTITLEMENT'),
    );
    // incrementMeter writes to METER but does NOT read it — it's an UpdateItem (ADD)
    const meterReadCalls = creditCheckCalls.filter((c) => c.startsWith('getItem:'));
    expect(meterReadCalls).toHaveLength(0);
  });

  it('systemOp: true still meters credits (incrementMeter fires)', async () => {
    await embed({
      tenantId: '__ISO_CANON__',
      agent: 'iso-kb-seeder',
      module: 'system',
      feature: 'seed',
      text: 'test',
      systemOp: true,
    });

    // incrementMeter is an UpdateItem call
    const updateCalls = mockDdbSend.mock.calls.filter((call) => call[0]?.input?.UpdateExpression);
    expect(updateCalls.length).toBeGreaterThan(0);
  });

  it('telemetry event includes systemOp: true when set', async () => {
    await embed({
      tenantId: '__ISO_CANON__',
      agent: 'iso-kb-seeder',
      module: 'system',
      feature: 'seed',
      text: 'test',
      systemOp: true,
    });

    expect(mockEbSend).toHaveBeenCalledTimes(1);
    const entry = (
      mockEbSend.mock.calls[0][0] as {
        input: { Entries: Array<{ Detail: string }> };
      }
    ).input.Entries[0];
    const detail = JSON.parse(entry.Detail);
    expect(detail.systemOp).toBe(true);
    expect(detail.tenantId).toBe('__ISO_CANON__');
  });

  it('telemetry event includes systemOp: false when omitted', async () => {
    await embed({
      tenantId: 'tenant-regular',
      agent: 'guru-9001',
      module: 'advisory',
      feature: 'clause-qa',
      text: 'test',
      // systemOp not set — defaults to false
    });

    expect(mockEbSend).toHaveBeenCalledTimes(1);
    const entry = (
      mockEbSend.mock.calls[0][0] as {
        input: { Entries: Array<{ Detail: string }> };
      }
    ).input.Entries[0];
    const detail = JSON.parse(entry.Detail);
    expect(detail.systemOp).toBe(false);
  });
});
