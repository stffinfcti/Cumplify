/**
 * Unit tests for invoke-transport.ts — spec-35 Task 4.
 * Verifies: createEmbedFn() sends op:'embed' payload to AI_INVOKER_ARN,
 * parses EmbedResult, handles errors correctly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();
vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class {
    send = mockSend;
  },
  InvokeCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

vi.stubEnv('AI_INVOKER_ARN', 'arn:aws:lambda:us-east-1:697114252993:function:ai-invoker-dev');

const { createEmbedFn, createInvokeFn } = await import('../invoke-transport.js');

describe('createEmbedFn', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('sends payload with op:"embed" to AI_INVOKER_ARN', async () => {
    const embedResult = { embedding: [0.1, 0.2, 0.3], tokenCount: 5, credits: 0.0001 };
    mockSend.mockResolvedValueOnce({
      Payload: Buffer.from(JSON.stringify(embedResult)),
    });

    const embedFn = createEmbedFn();
    const result = await embedFn({
      tenantId: 'tenant-1',
      agent: 'guru-9001',
      module: 'M1',
      feature: 'advisory',
      text: 'What is clause 4.1?',
    });

    // Verify Lambda invocation
    expect(mockSend).toHaveBeenCalledTimes(1);
    const cmd = mockSend.mock.calls[0][0] as { input: { FunctionName: string; Payload: Buffer } };
    expect(cmd.input.FunctionName).toBe(
      'arn:aws:lambda:us-east-1:697114252993:function:ai-invoker-dev',
    );

    // Verify payload includes op:'embed'
    const payload = JSON.parse(Buffer.from(cmd.input.Payload).toString());
    expect(payload.op).toBe('embed');
    expect(payload.tenantId).toBe('tenant-1');
    expect(payload.agent).toBe('guru-9001');
    expect(payload.text).toBe('What is clause 4.1?');

    // Verify result parsed correctly
    expect(result).toEqual(embedResult);
  });

  it('throws on FunctionError', async () => {
    mockSend.mockResolvedValueOnce({
      FunctionError: 'Unhandled',
      Payload: Buffer.from(JSON.stringify({ errorMessage: 'model not found' })),
    });

    const embedFn = createEmbedFn();
    await expect(
      embedFn({ tenantId: 't', agent: 'a', module: 'm', feature: 'f', text: 'x' }),
    ).rejects.toThrow('AI Invoker embed error: Unhandled — model not found');
  });

  it('throws on empty payload', async () => {
    mockSend.mockResolvedValueOnce({
      Payload: undefined,
    });

    const embedFn = createEmbedFn();
    await expect(
      embedFn({ tenantId: 't', agent: 'a', module: 'm', feature: 'f', text: 'x' }),
    ).rejects.toThrow('AI Invoker embed returned empty payload');
  });
});

describe('createInvokeFn (back-compat — no op field)', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('sends InvokeRequest WITHOUT op field', async () => {
    const invokeResult = {
      text: 'answer',
      toolUseBlocks: [],
      stopReason: 'end_turn',
      usage: {},
      credits: 0.5,
      modelId: 'x',
      seat: 'workhorse',
    };
    mockSend.mockResolvedValueOnce({
      Payload: Buffer.from(JSON.stringify(invokeResult)),
    });

    const invokeFn = createInvokeFn();
    await invokeFn({
      seat: 'workhorse',
      messages: [{ role: 'user', content: [{ text: 'hi' }] }],
      tenantId: 'tenant-1',
      agent: 'test',
      module: 'M1',
      feature: 'advisory',
    });

    const cmd = mockSend.mock.calls[0][0] as { input: { Payload: Buffer } };
    const payload = JSON.parse(Buffer.from(cmd.input.Payload).toString());
    // No op field — back-compat with existing invoke path
    expect(payload.op).toBeUndefined();
    expect(payload.seat).toBe('workhorse');
  });
});
