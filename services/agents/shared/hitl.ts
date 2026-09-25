/**
 * HITL gate — Step Functions waitForTaskToken integration.
 * Design §3 — agents-existing-8.
 *
 * When a mutating tool is detected, this module:
 * 1. Starts a Step Functions execution with the proposed action + full item payload.
 * 2. Returns the execution ARN for tracking.
 *
 * The DynamoDB HITL_PENDING item is written by store-token.ts (the first state
 * in the SFN chain), NOT here. This avoids requiring DDB write permissions on
 * AgentHandlerReadOnlyPolicy (T-1 owner-approved zero-write scope).
 *
 * Approval comes via SendTaskSuccess from the frontend (spec 9).
 */

import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { Logger } from '@aws-lambda-powertools/logger';
import { ulid } from 'ulid';
import type { ConversationMessage } from '../../ai-invoker/src/types.js';

const logger = new Logger({ serviceName: 'agents-hitl' });

const sfn = new SFNClient({});
const ddb = new DynamoDBClient({});

const TABLE_NAME = process.env.TABLE_NAME!;
const HITL_STATE_MACHINE_ARN = process.env.HITL_STATE_MACHINE_ARN!;

export interface HitlGateInput {
  tenantId: string;
  agentName: string;
  proposedAction: { tool: string; args: unknown };
  /** SOD-1: sub of the human who triggered the run (self-approval blocked). */
  requestedBy?: string;
  conversationState: ConversationMessage[];
  /** L5-1: guardrail evidence to persist on the HITL item for HITL card display */
  guardrailEvidence?: {
    groundingScore: number | null;
    relevanceScore: number | null;
    arVerdict: 'pass' | 'fail' | 'error' | null;
    arDetails: string | null;
    citations: Array<{ clauseRef: string; sourceChunk: string; score: number }>;
    flagged: boolean;
  };
}

export interface HitlResult {
  status: 'HITL_PENDING';
  executionArn: string;
  hitlItemId: string;
}

/**
 * Enter the HITL gate: start a Step Functions execution carrying the full
 * HITL item payload. Store-token (first SFN state) creates the DDB item
 * atomically with the task token — no separate PutItem here, no race.
 *
 * The handler Lambda only needs SFN:StartExecution (already in
 * AgentHandlerReadOnlyPolicy). Zero DDB permissions required.
 */
export async function enterHitlGate(input: HitlGateInput): Promise<HitlResult> {
  const hitlItemId = ulid();
  const executionName = `hitl-${input.agentName}-${hitlItemId}`;
  const now = new Date().toISOString();

  // Pass all item fields in the SFN input — store-token writes them on upsert.
  const sfnInput = {
    tenantId: input.tenantId,
    agentName: input.agentName,
    proposedAction: input.proposedAction,
    hitlItemId,
    createdAt: now,
    // SOD-1: the proposing human's sub (user-triggered runs) — the approval
    // Lambda blocks self-approval when present.
    ...(input.requestedBy && { requestedBy: input.requestedBy }),
    // L5-1: guardrail evidence flows to store-token → DDB item → HITL card
    ...(input.guardrailEvidence && { guardrailEvidence: input.guardrailEvidence }),
    // Conversation context truncated to stay within SFN input size (256KB).
    conversationContext: truncateConversation(input.conversationState, 200_000),
  };

  const startResult = await sfn.send(
    new StartExecutionCommand({
      stateMachineArn: HITL_STATE_MACHINE_ARN,
      name: executionName,
      input: JSON.stringify(sfnInput),
    }),
  );

  const executionArn = startResult.executionArn!;

  logger.info('HITL gate entered — SFN execution started', {
    tenantId: input.tenantId,
    agentName: input.agentName,
    tool: input.proposedAction.tool,
    executionArn,
    hitlItemId,
  });

  return { status: 'HITL_PENDING', executionArn, hitlItemId };
}

/**
 * Mark a HITL item as resolved (APPROVED/REJECTED/TIMED_OUT).
 * Removes the GSI attribute (sparse GSI — resolved items disappear from pending query).
 * Sets TTL to 30 days from now.
 */
/** Minimal structural sender — any DynamoDBClient (tenant-scoped or ambient)
 * satisfies it; avoids depending on the concrete class across service roots. */
export type DdbSender = { send: (cmd: UpdateItemCommand) => Promise<unknown> };

/** Ambient-credentialed client for system callers (SFN timeout path) whose
 * own role carries the HITL write grant. Resolvers must pass their
 * tenant-scoped client instead. */
export const ambientDdb: DdbSender = ddb;

export async function resolveHitlItem(
  tenantId: string,
  hitlItemId: string,
  resolution: 'APPROVED' | 'REJECTED' | 'TIMED_OUT',
  approver: string | undefined,
  // REQUIRED: the caller chooses the credential path — the approval Lambda's
  // ambient role has no DDB grants at all, so it must ride the tenant-data
  // role's HITL-pinned statement (BUG-14); a silent ambient default would
  // write through ambient creds instead.
  client: DdbSender,
): Promise<void> {
  const ttlEpoch = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60; // 30 days

  await client.send(
    new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({
        PK: `TENANT#${tenantId}#HITL`,
        SK: `PENDING#${hitlItemId}`,
      }),
      UpdateExpression:
        'SET #status = :status, resolvedAt = :now, approver = :approver, #ttl = :ttl ' +
        'REMOVE GSI9PK, GSI9SK',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#ttl': 'ttl',
      },
      ExpressionAttributeValues: marshall({
        ':status': resolution,
        ':now': new Date().toISOString(),
        ':approver': approver ?? 'system',
        ':ttl': ttlEpoch,
      }),
    }),
  );

  logger.info('HITL item resolved', { tenantId, hitlItemId, resolution, approver });
}

/**
 * Truncate conversation state to fit within a byte budget (R6-n1).
 * Takes the last N messages; if serialized size exceeds budget, drops oldest.
 */
function truncateConversation(
  messages: ConversationMessage[],
  maxBytes: number,
): ConversationMessage[] {
  let slice = messages.slice(-10);
  while (slice.length > 0) {
    const size = Buffer.byteLength(JSON.stringify(slice), 'utf-8');
    if (size <= maxBytes) return slice;
    slice = slice.slice(1); // Drop oldest
  }
  return [];
}
