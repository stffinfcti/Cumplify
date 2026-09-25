/**
 * Unit test: guru handler passes ISO_CANON_TENANT_ID to retrieve()
 * for ISO KB retrieval (not the requesting user's tenantId).
 * Spec: iso-kb-seeding Task 6.
 *
 * Also verifies: user's tenantId still flows to invokeFn (metering).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const retrieveMock = vi.fn();
const lambdaSendMock = vi.fn();

vi.mock('../../shared/retrieval.js', () => ({
  retrieve: (...args: unknown[]) => retrieveMock(...args),
}));

vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class {
    send = lambdaSendMock;
  },
  InvokeCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

vi.stubEnv('AOSS_ISO_KB_ENDPOINT', 'https://iso-kb.us-east-1.aoss.amazonaws.com');
vi.stubEnv('AI_INVOKER_ARN', 'arn:aws:lambda:us-east-1:697114252993:function:ai-invoker');

const { handleQuery } = await import('../handler.js');

beforeEach(() => {
  retrieveMock.mockReset();
  lambdaSendMock.mockReset();

  // Default: embed succeeds
  lambdaSendMock.mockImplementation((cmd: { input?: { Payload?: Buffer } }) => {
    const payload = cmd.input?.Payload ? JSON.parse(Buffer.from(cmd.input.Payload).toString()) : {};
    // Embed response
    if (payload.op === 'embed') {
      return Promise.resolve({
        Payload: Buffer.from(
          JSON.stringify({
            embedding: Array(1024).fill(0.01),
            tokenCount: 10,
            credits: 0.0002,
          }),
        ),
      });
    }
    // Invoke response (converse)
    return Promise.resolve({
      Payload: Buffer.from(
        JSON.stringify({
          text: 'Clause 4.1 requires determining external and internal issues.',
          tokenUsage: { inputTokens: 50, outputTokens: 30 },
        }),
      ),
    });
  });

  // Default: retrieval succeeds with chunks
  retrieveMock.mockResolvedValue({
    chunks: [
      { text: '[ISO 9001 4.1] Understanding the organization...', score: 0.95, metadata: {} },
    ],
    latencyMs: 200,
    coldStart: false,
    attempts: 1,
  });
});

describe('guru-9001 canon-tenant wiring (iso-kb-seeding Task 6)', () => {
  it('passes ISO_CANON_TENANT_ID to retrieve() — NOT the user tenantId', async () => {
    await handleQuery('tenant-real-user-abc', 'What does clause 4.1 require?');

    expect(retrieveMock).toHaveBeenCalledTimes(1);
    const retrieveArgs = retrieveMock.mock.calls[0][0];
    expect(retrieveArgs.tenantId).toBe('__ISO_CANON__');
    expect(retrieveArgs.tenantId).not.toBe('tenant-real-user-abc');
  });

  it('user tenantId still flows to the invoke call (metering attribution)', async () => {
    await handleQuery('tenant-real-user-xyz', 'What is 5.1?');

    // The second Lambda call is the invokeFn (converse) — check its payload
    // lambdaSendMock is called: [embed, invoke]
    expect(lambdaSendMock).toHaveBeenCalledTimes(2);
    const invokePayload = JSON.parse(
      Buffer.from(lambdaSendMock.mock.calls[1][0].input.Payload).toString(),
    );
    expect(invokePayload.tenantId).toBe('tenant-real-user-xyz');
  });

  it('retrieval uses the cumplify-iso-kb index name', async () => {
    await handleQuery('tenant-1', 'Anything');

    const retrieveArgs = retrieveMock.mock.calls[0][0];
    expect(retrieveArgs.indexName).toBe('cumplify-iso-kb');
    expect(retrieveArgs.collectionEndpoint).toBe('https://iso-kb.us-east-1.aoss.amazonaws.com');
  });
});
