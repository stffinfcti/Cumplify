import type { SQSEvent, SQSBatchResponse, SQSBatchItemFailure } from 'aws-lambda';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { Logger } from '@aws-lambda-powertools/logger';
import type { CumplifyEvent, QueueMessage } from './types.js';

const sqsClient = new SQSClient({});
const logger = new Logger({ serviceName: 'eventing-consumer' });

export type EventHandler<T = Record<string, unknown>> = (
  event: CumplifyEvent<T>,
  detailType: string,
) => Promise<void>;

export interface ConsumerConfig {
  dlqUrl: string;
  handler: EventHandler;
}

/**
 * Creates an SQS batch handler with:
 * - Canonical queue-message parsing (FIX-1: body = {detailType, detail})
 * - Envelope validation (ET-4 fields on .detail)
 * - Poison-message explicit DLQ send on parse/validation failure (D-2: immediate)
 * - Partial batch failure reporting (reportBatchItemFailures)
 * - Powertools structured logging
 */
export function createHandler(config: ConsumerConfig) {
  return async (sqsEvent: SQSEvent): Promise<SQSBatchResponse> => {
    const batchItemFailures: SQSBatchItemFailure[] = [];

    for (const record of sqsEvent.Records) {
      try {
        const msg = parseAndValidate(record.body);
        logger.info('Processing event', {
          detailType: msg.detailType,
          tenantId: msg.detail.tenantId,
          eventId: msg.detail.eventId,
        });
        await config.handler(msg.detail, msg.detailType);
      } catch (err) {
        if (err instanceof PoisonMessageError) {
          // D-2: explicit DLQ send — immediate, no 18-minute wait
          logger.warn('Poison message → DLQ', {
            messageId: record.messageId,
            reason: err.message,
          });
          await sqsClient.send(
            new SendMessageCommand({
              QueueUrl: config.dlqUrl,
              MessageBody: record.body,
              MessageAttributes: {
                PoisonReason: { DataType: 'String', StringValue: err.message },
                OriginalMessageId: { DataType: 'String', StringValue: record.messageId },
              },
            }),
          );
          // Do NOT add to batchItemFailures — message is handled (sent to DLQ)
        } else {
          // Transient error — let SQS retry via visibility timeout
          logger.error('Transient processing failure', {
            messageId: record.messageId,
            error: ((err as Error).message ?? '').slice(0, 300),
            errorName: (err as Error).name,
          });
          batchItemFailures.push({ itemIdentifier: record.messageId });
        }
      }
    }
    return { batchItemFailures };
  };
}

export class PoisonMessageError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'PoisonMessageError';
  }
}

// ─── FIFO Mode (REV-3, FIX-3) ─────────────────────────────────────────────────

export interface FifoConsumerConfig extends ConsumerConfig {
  /** Must be set to true to activate FIFO semantics. */
  fifo: true;
  /**
   * Error names treated as idempotent replays (success, continue batch).
   * E.g., ['ReplayDetectedError'] for the audit-trail consumer.
   */
  idempotentErrors?: string[];
}

/**
 * Creates an SQS batch handler in FIFO mode.
 *
 * On the first TRANSIENT failure, reports that record AND ALL SUBSEQUENT
 * records as batchItemFailures — preserving per-tenant message ordering.
 * (Per AWS FIFO partial-batch guidance: a retried message must not chain
 * AFTER its successors.)
 *
 * PoisonMessageError → explicit DLQ send (FIX-3: with MessageGroupId +
 * MessageDeduplicationId for FIFO DLQ), then continue batch.
 *
 * Errors whose `.name` is in `idempotentErrors` → treated as success.
 */
export function createFifoHandler(config: FifoConsumerConfig) {
  const idempotentErrors = new Set(config.idempotentErrors ?? []);

  return async (sqsEvent: SQSEvent): Promise<SQSBatchResponse> => {
    const batchItemFailures: SQSBatchItemFailure[] = [];

    for (let i = 0; i < sqsEvent.Records.length; i++) {
      const record = sqsEvent.Records[i];
      try {
        const msg = parseAndValidate(record.body);
        logger.info('Processing event (FIFO)', {
          detailType: msg.detailType,
          tenantId: msg.detail.tenantId,
          eventId: msg.detail.eventId,
        });
        await config.handler(msg.detail, msg.detailType);
      } catch (err) {
        if (err instanceof PoisonMessageError) {
          // Poison → explicit DLQ send (FIX-3: FIFO DLQ needs GroupId + DedupId)
          logger.warn('Poison message → DLQ (FIFO)', {
            messageId: record.messageId,
            reason: err.message,
          });

          // Extract tenantId if parseable, else fall back to messageId
          let messageGroupId: string;
          try {
            const parsed = JSON.parse(record.body);
            messageGroupId = parsed?.detail?.tenantId ?? record.messageId;
          } catch {
            messageGroupId = record.messageId;
          }

          await sqsClient.send(
            new SendMessageCommand({
              QueueUrl: config.dlqUrl,
              MessageBody: record.body,
              MessageGroupId: messageGroupId,
              MessageDeduplicationId: record.messageId,
              MessageAttributes: {
                PoisonReason: { DataType: 'String', StringValue: err.message },
                OriginalMessageId: { DataType: 'String', StringValue: record.messageId },
              },
            }),
          );
        } else if (idempotentErrors.has((err as Error).name)) {
          // Idempotent replay — success, continue
          logger.warn('Idempotent replay detected (FIFO)', {
            messageId: record.messageId,
            errorName: (err as Error).name,
          });
        } else {
          // TRANSIENT FAILURE: report this + ALL subsequent as unprocessed
          logger.error('Transient failure — stopping batch (FIFO)', {
            messageId: record.messageId,
            error: ((err as Error).message ?? '').slice(0, 300),
            errorName: (err as Error).name,
          });
          for (let j = i; j < sqsEvent.Records.length; j++) {
            batchItemFailures.push({ itemIdentifier: sqsEvent.Records[j].messageId });
          }
          break;
        }
      }
    }
    return { batchItemFailures };
  };
}

/** FIX-1: parse canonical queue-message contract {detailType, detail} */
function parseAndValidate(body: string): QueueMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new PoisonMessageError('JSON parse failure');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new PoisonMessageError('Body is not an object');
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.detailType !== 'string' || obj.detailType.length === 0) {
    throw new PoisonMessageError('Missing or invalid detailType');
  }
  if (!obj.detail || typeof obj.detail !== 'object') {
    throw new PoisonMessageError('Missing or invalid detail object');
  }

  // Validate mandatory envelope fields on .detail (ET-4)
  const detail = obj.detail as Record<string, unknown>;
  const required = [
    'tenantId',
    'eventId',
    'timestamp',
    'actor',
    'module',
    'clauseRef',
    'standard',
    'payload',
  ];
  for (const field of required) {
    if (!(field in detail)) {
      throw new PoisonMessageError(`Missing envelope field: detail.${field}`);
    }
  }

  // tenantId flows into set_config('app.tenant_id'), S3 tenants/<t>/ keys and
  // DDB TENANT#<t># partitions — reject charset garbage here so every consumer
  // inherits the assert instead of repeating it per handler.
  if (typeof detail.tenantId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(detail.tenantId)) {
    throw new PoisonMessageError('Invalid detail.tenantId charset');
  }

  return obj as unknown as QueueMessage;
}
