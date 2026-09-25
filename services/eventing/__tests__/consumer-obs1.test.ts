/**
 * OBS-1: transient processing failure log carries error message + errorName.
 * Isolated test: mocks Logger to assert structured log fields.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLoggerError } = vi.hoisted(() => ({
  mockLoggerError: vi.fn(),
}));

vi.mock('@aws-lambda-powertools/logger', () => ({
  Logger: class {
    info = vi.fn();
    warn = vi.fn();
    error = mockLoggerError;
    appendKeys = vi.fn();
  },
}));

vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class {
    send = vi.fn().mockResolvedValue({});
  },
  SendMessageCommand: class {
    constructor(public input: unknown) {}
  },
}));

import { createHandler } from '../src/consumer.js';
import type { SQSEvent, SQSRecord } from 'aws-lambda';

function makeSqsRecord(body: string, messageId = 'msg-001'): SQSRecord {
  return {
    messageId,
    receiptHandle: 'receipt-1',
    body,
    attributes: {} as SQSRecord['attributes'],
    messageAttributes: {},
    md5OfBody: '',
    eventSource: 'aws:sqs',
    eventSourceARN: 'arn:aws:sqs:us-east-1:123456789012:test-queue',
    awsRegion: 'us-east-1',
  };
}

function makeValidBody(): string {
  return JSON.stringify({
    detailType: 'Document.Published',
    detail: {
      tenantId: 'tenant-1',
      eventId: 'evt-1',
      timestamp: '2026-07-23T00:00:00Z',
      actor: 'user-1',
      module: 'M1',
      clauseRef: 'ISO 9001 7.5.3',
      standard: 'ISO9001',
      auditTrail: true,
      payload: { documentId: 'doc-1' },
    },
  });
}

beforeEach(() => {
  mockLoggerError.mockReset();
});

describe('OBS-1: transient failure log carries error message and errorName', () => {
  it('logs error message (sliced to 300) and errorName on transient processing failure', async () => {
    const handler = createHandler({
      dlqUrl: 'https://sqs.us-east-1.amazonaws.com/123/test-dlq',
      handler: async () => {
        const err = new Error(
          'ECONNREFUSED: connect ECONNREFUSED 10.0.1.42:443 — VPC endpoint unreachable',
        );
        err.name = 'FetchError';
        throw err;
      },
    });

    const sqsEvent: SQSEvent = { Records: [makeSqsRecord(makeValidBody(), 'msg-vpc-fail')] };
    const result = await handler(sqsEvent);

    expect(result.batchItemFailures).toHaveLength(1);
    expect(result.batchItemFailures[0].itemIdentifier).toBe('msg-vpc-fail');

    // OBS-1: the log call carries both error message and errorName
    expect(mockLoggerError).toHaveBeenCalledOnce();
    const [logMsg, logFields] = mockLoggerError.mock.calls[0];
    expect(logMsg).toBe('Transient processing failure');
    expect(logFields.messageId).toBe('msg-vpc-fail');
    expect(logFields.error).toContain('ECONNREFUSED');
    expect(logFields.errorName).toBe('FetchError');
    // Message is sliced to 300 chars max
    expect(logFields.error.length).toBeLessThanOrEqual(300);
  });
});
