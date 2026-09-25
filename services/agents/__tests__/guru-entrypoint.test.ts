/**
 * Guru AppSync entrypoint tests (Task 8R-2 hotfix, architect).
 *
 * Pins the defect class found at 8R-2 validation: guru handler modules exported
 * only handleQuery() — no `handler` entrypoint — so every AppSync invocation
 * would fail with Runtime.HandlerNotFound. Also pins the security contract:
 * tenantId comes ONLY from the authorizer's resolverContext (fail-closed),
 * never from client arguments.
 *
 * Task 19 update: handlers now call embedFn() + retrieve() before invoke().
 * Mock must return distinct shapes per call (embed → invoke).
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

// Mock AOSS retrieval — Task 19 handlers call retrieve() after embed
vi.mock('../shared/retrieval.js', () => ({
  retrieve: vi.fn().mockResolvedValue({
    chunks: [{ text: '[ISO 9001 4.1] Context of the organization', score: 0.92, metadata: {} }],
    latencyMs: 150,
    coldStart: false,
    attempts: 1,
  }),
}));

vi.stubEnv('AI_INVOKER_ARN', 'arn:aws:lambda:us-east-1:000000000000:function:ai-invoker');
vi.stubEnv('AOSS_ISO_KB_ENDPOINT', 'https://example.aoss.amazonaws.com');

const GURUS = [
  { name: 'guru-9001', mod: () => import('../guru-9001/handler.js') },
  { name: 'guru-14001', mod: () => import('../guru-14001/handler.js') },
  { name: 'guru-45001', mod: () => import('../guru-45001/handler.js') },
] as const;

function embedPayload(): Uint8Array {
  return Buffer.from(
    JSON.stringify({
      embedding: new Array(1024).fill(0.01),
      tokenCount: 5,
      credits: 0.002,
    }),
  );
}

function invokerPayload(text: string): Uint8Array {
  return Buffer.from(JSON.stringify({ text, usage: { inputTokens: 1, outputTokens: 1 } }));
}

describe('guru AppSync entrypoints', () => {
  beforeEach(() => {
    mockSend.mockReset();
    // First call = embed, second call = invoke
    mockSend
      .mockResolvedValueOnce({ Payload: embedPayload() })
      .mockResolvedValueOnce({ Payload: invokerPayload('advisory answer') });
  });

  for (const guru of GURUS) {
    describe(guru.name, () => {
      it('exports a `handler` entrypoint (CDK wires handler: "handler")', async () => {
        const mod = await guru.mod();
        expect(typeof (mod as Record<string, unknown>).handler).toBe('function');
      });

      it('FAIL-CLOSED: throws Unauthorized when resolverContext.tenantId is absent', async () => {
        const { handler } = (await guru.mod()) as { handler: (e: unknown) => Promise<string> };
        await expect(handler({ arguments: { question: 'What is clause 4.1?' } })).rejects.toThrow(
          /Unauthorized/,
        );
        // tenantId in client ARGUMENTS must not be accepted as identity
        await expect(
          handler({
            arguments: { question: 'q', tenantId: 'tenant-EVIL' },
            identity: { resolverContext: {} },
          }),
        ).rejects.toThrow(/Unauthorized/);
        expect(mockSend).not.toHaveBeenCalled();
      });

      it('calls embedFn then invokeFn with groundingContext assembled', async () => {
        // Reset to provide fresh per-test mocks
        mockSend.mockReset();
        mockSend
          .mockResolvedValueOnce({ Payload: embedPayload() })
          .mockResolvedValueOnce({ Payload: invokerPayload('grounded answer') });

        const { handler } = (await guru.mod()) as { handler: (e: unknown) => Promise<string> };
        const answer = await handler({
          arguments: { question: 'What is clause 4.1?' },
          identity: { resolverContext: { tenantId: 'tenant-AAA' } },
        });
        expect(answer).toBe('grounded answer');
        // Two Lambda calls: embed + invoke
        expect(mockSend).toHaveBeenCalledTimes(2);

        // Second call (invoke) should have groundingContext
        const invokePayload = JSON.parse(
          Buffer.from((mockSend.mock.calls[1][0] as any).input.Payload).toString(),
        );
        expect(invokePayload.groundingContext).toBeDefined();
        expect(invokePayload.groundingContext.source).toContain('ISO 9001 4.1');
        expect(invokePayload.groundingContext.query).toBe('What is clause 4.1?');
      });

      it('truncates query to 1,000 chars for groundingContext', async () => {
        mockSend.mockReset();
        mockSend
          .mockResolvedValueOnce({ Payload: embedPayload() })
          .mockResolvedValueOnce({ Payload: invokerPayload('answer') });

        const { handler } = (await guru.mod()) as { handler: (e: unknown) => Promise<string> };
        const longQuestion = 'x'.repeat(2000);
        await handler({
          arguments: { question: longQuestion },
          identity: { resolverContext: { tenantId: 'tenant-AAA' } },
        });

        const invokePayload = JSON.parse(
          Buffer.from((mockSend.mock.calls[1][0] as any).input.Payload).toString(),
        );
        expect(invokePayload.groundingContext.query.length).toBe(1000);
      });

      it('FIX-T20-2: converse messages contain chunk text when retrieval returned chunks', async () => {
        mockSend.mockReset();
        mockSend
          .mockResolvedValueOnce({ Payload: embedPayload() })
          .mockResolvedValueOnce({ Payload: invokerPayload('grounded answer') });

        const { handler } = (await guru.mod()) as { handler: (e: unknown) => Promise<string> };
        await handler({
          arguments: { question: 'What is clause 4.1?' },
          identity: { resolverContext: { tenantId: 'tenant-BBB' } },
        });

        // Invoke payload should carry the chunks in messages (not just groundingContext)
        const invokePayload = JSON.parse(
          Buffer.from((mockSend.mock.calls[1][0] as any).input.Payload).toString(),
        );
        const messages = invokePayload.messages;
        expect(messages).toHaveLength(1); // single user message with multiple content blocks
        const userMsg = messages[0];
        expect(userMsg.role).toBe('user');
        // Multiple content blocks: question + chunks
        expect(userMsg.content.length).toBeGreaterThanOrEqual(2);
        // The chunks should appear in the message content
        const allText = userMsg.content.map((b: { text: string }) => b.text).join('');
        expect(allText).toContain('Context of the organization');
        expect(allText).toContain('Relevant ISO');
      });
    });
  }
});
