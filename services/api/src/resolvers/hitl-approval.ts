/**
 * HITL Approval resolver — processes Approve / Send-back decisions.
 * Design §2.3: claims-derived tenantId/approver, server-side taskToken fetch,
 * conditional UpdateItem guard (AM-1: resolvingAt), SFN SendTaskSuccess/Failure,
 * resolveHitlItem bookkeeping, audit event publication.
 *
 * BC-8: taskToken never leaves the server.
 * SCHEMA-5: tenantId from resolverContext only.
 */

import { Logger } from '@aws-lambda-powertools/logger';
import { GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { SFNClient, SendTaskSuccessCommand, SendTaskFailureCommand } from '@aws-sdk/client-sfn';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { extractContext, getTenantDdbClient, publishAuditEvent, TABLE_NAME } from './shared.js';
import { canApprove, normalizeRole, resolveModule } from '../permissions/role-matrix.js';
import {
  approveAllowedByMatrix,
  getMatrixEntry,
  resolveArtifactType,
} from '../permissions/approval-matrix.js';
import { resolveHitlItem } from '../../../agents/shared/hitl.js';

const logger = new Logger({ serviceName: 'resolver-hitl-approval' });
const sfnClient = new SFNClient({});

interface AppSyncEvent {
  info: { fieldName: string };
  arguments: Record<string, unknown>;
  identity?: { resolverContext?: Record<string, string> };
}

interface ApprovalInput {
  hitlItemId: string;
  decision: 'APPROVE' | 'SEND_BACK';
  justification?: string;
  editedPayload?: Record<string, unknown>;
}

/**
 * Must match the schema type HitlApprovalResult exactly — every field below is
 * non-nullable there, and tenantId is what AppSync matches against the
 * onHitlItemResolved(tenantId:) subscription argument; without it the
 * subscription never delivers (BUG-12/12b, found at ACC-3: the old return
 * shape errored response marshalling AFTER SendTaskSuccess had fired).
 */
interface HitlApprovalResult {
  hitlItemId: string;
  tenantId: string;
  decision: string;
  auditEventId: string;
  auditEventTimestamp: string;
  resolvedBy: string;
  resolvedAt: string;
}

export async function handler(event: AppSyncEvent): Promise<HitlApprovalResult> {
  // Step 1: Extract context — tenantId, sub (approverSub), role
  const ctx = extractContext(event);
  const { tenantId, sub: approverSub, role } = ctx;
  logger.appendKeys({ tenantId, approverSub, requestField: event.info.fieldName });

  const input = event.arguments.input as ApprovalInput;
  const { hitlItemId, decision, justification, editedPayload } = input;

  logger.info('Processing HITL approval', { hitlItemId, decision });

  // Step 3: Fetch the HITL item (need item data before role validation)
  const ddb = await getTenantDdbClient(tenantId);

  const getResult = await ddb.send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({
        PK: `TENANT#${tenantId}#HITL`,
        SK: `PENDING#${hitlItemId}`,
      }),
    }),
  );

  if (!getResult.Item) {
    throw new ApprovalError(404, `HITL item not found: ${hitlItemId}`);
  }

  const item = unmarshall(getResult.Item);

  // Step 5: Extract taskToken + sfnExecutionArn
  const taskToken = item.taskToken as string;
  const sfnExecutionArn = (item.sfnExecutionArn as string) ?? undefined;

  // Step 6: Resolve module — explicit item field, else the writeback tool
  // registry (BUG-11b: the old tool-prefix fallback derived vocabulary like
  // 'capa' that can never match ROLE_WRITE_MODULES → universal 403).
  const module = resolveModule(item);

  // Step 7: Validate role — canApprove(role, module)
  if (!canApprove(role, module)) {
    logger.warn('Role lacks approval permission', { role, module, hitlItemId });
    throw new ApprovalError(403, `Role '${role}' cannot approve items in module '${module}'`);
  }

  // Step 7a (SOD-1): author ≠ approver. Items stamped with the proposing
  // human's sub (RS-8 runs) can never be approved by that same identity —
  // the hard SoD floor beneath any tenant config.
  const requestedBy = item.requestedBy as string | undefined;
  if (requestedBy && requestedBy === approverSub && decision === 'APPROVE') {
    logger.warn('SoD violation blocked: proposer attempted self-approval', { hitlItemId });
    throw new ApprovalError(403, 'SoD violation: the proposer cannot approve their own item');
  }

  // Step 7b (RS-6): tenant approval-matrix narrowing. The matrix can only
  // NARROW who approves (floor already enforced above); no entry → no
  // narrowing.
  const artifactType = resolveArtifactType(item);
  if (artifactType && decision === 'APPROVE') {
    const entry = await getMatrixEntry(
      ddb as never,
      TABLE_NAME,
      tenantId,
      artifactType,
      (item.standard as string) ?? null,
    );
    if (!approveAllowedByMatrix(entry, normalizeRole(role))) {
      logger.warn('Approval-matrix narrowing denied approval', {
        role,
        artifactType,
        hitlItemId,
      });
      throw new ApprovalError(
        403,
        `Approval matrix: role '${role}' is not an approver for '${artifactType}'`,
      );
    }
  }

  // L5-2 (Task 32): If guardrailEvidence.flagged=true, approval REQUIRES justification.
  // Flagged items had grounding issues — approver must explicitly justify the override.
  const guardrailEvidence = item.guardrailEvidence as
    { flagged?: boolean; groundingScore?: number; relevanceScore?: number } | undefined;
  const isFlagged = guardrailEvidence?.flagged === true;

  if (isFlagged && decision === 'APPROVE' && !justification) {
    throw new ApprovalError(
      400,
      'Justification required: this item was flagged by the guardrail grounding check. ' +
        'Provide a justification to approve.',
    );
  }

  // Step 4: Conditional UpdateItem — status to RESOLVING (AM-1 guard)
  const now = new Date().toISOString();
  try {
    await ddb.send(
      new UpdateItemCommand({
        TableName: TABLE_NAME,
        Key: marshall({
          PK: `TENANT#${tenantId}#HITL`,
          SK: `PENDING#${hitlItemId}`,
        }),
        ConditionExpression: 'attribute_exists(PK) AND #status = :pending',
        UpdateExpression: 'SET #status = :resolving, resolvingAt = :now',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: marshall({
          ':pending': 'PENDING',
          ':resolving': 'RESOLVING',
          ':now': now,
        }),
      }),
    );
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new ApprovalError(409, `HITL item already resolved or being processed: ${hitlItemId}`);
    }
    throw err;
  }

  // Step 8: Branch on decision — send to SFN
  try {
    if (decision === 'APPROVE') {
      await sfnClient.send(
        new SendTaskSuccessCommand({
          taskToken,
          output: JSON.stringify({
            decision: 'APPROVE',
            approverSub,
            ...(editedPayload ? { editedPayload } : {}),
            ...(justification ? { justification } : {}),
          }),
        }),
      );
    } else {
      // SEND_BACK
      await sfnClient.send(
        new SendTaskFailureCommand({
          taskToken,
          error: 'SENT_BACK',
          cause: justification ?? 'No reason provided',
        }),
      );
    }
  } catch (err: unknown) {
    const errName = (err as { name?: string }).name ?? '';
    if (errName === 'TaskDoesNotExist' || errName === 'TaskTimedOut') {
      // The token is permanently dead — resolve as TIMED_OUT (removes GSI9
      // membership + TTLs the item) instead of leaving a ghost RESOLVING row
      // that only the sweeper would ever reclaim.
      await resolveHitlItem(tenantId, hitlItemId, 'TIMED_OUT', 'system', ddb).catch(
        (resolveErr: unknown) => {
          logger.warn('Failed to mark expired HITL item TIMED_OUT', {
            hitlItemId,
            resolveErr: String(resolveErr),
          });
        },
      );
      throw new ApprovalError(
        410,
        `SFN task expired or does not exist for HITL item: ${hitlItemId}`,
      );
    }
    // Transient send failure — reset to PENDING so the card re-appears in the
    // queue for a retry instead of vanishing until the sweeper finds it.
    await ddb
      .send(
        new UpdateItemCommand({
          TableName: TABLE_NAME,
          Key: marshall({
            PK: `TENANT#${tenantId}#HITL`,
            SK: `PENDING#${hitlItemId}`,
          }),
          ConditionExpression: '#status = :resolving',
          UpdateExpression: 'SET #status = :pending REMOVE resolvingAt',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: marshall({
            ':resolving': 'RESOLVING',
            ':pending': 'PENDING',
          }),
        }),
      )
      .catch((resetErr: unknown) => {
        logger.warn('Failed to reset HITL item to PENDING after SFN send error', {
          hitlItemId,
          resetErr: String(resetErr),
        });
      });
    throw err;
  }

  // Step 9: resolveHitlItem bookkeeping (removes GSI9, sets TTL) — rides the
  // same tenant-scoped client as the RESOLVING guard (BUG-14: ambient role has
  // no DDB grants).
  const resolution = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  await resolveHitlItem(tenantId, hitlItemId, resolution, approverSub, ddb);

  // Step 10: Publish audit event
  const detailType = decision === 'APPROVE' ? 'Hitl.Approved' : 'Hitl.SentBack';
  const standard = (item.standard as 'ISO9001' | 'ISO14001' | 'ISO45001') ?? 'ISO9001';
  const clauseRef = (item.proposedAction as Record<string, unknown>)?.tool?.toString() ?? 'unknown';

  // L5-3 (Task 32): Stamp flaggedApproval on sealed event when flagged + approved
  const flaggedApproval =
    isFlagged && decision === 'APPROVE'
      ? { justification: justification!, approverSub, timestamp: now }
      : undefined;

  const auditEventTimestamp = new Date().toISOString();
  const auditEventId = await publishAuditEvent({
    tenantId,
    actor: approverSub,
    module,
    clauseRef,
    standard,
    detailType,
    source: 'cumplify.hitl.approval',
    timestamp: auditEventTimestamp,
    entityId: hitlItemId,
    payload: {
      hitlItemId,
      decision,
      justification: justification ?? null,
      editedPayload: editedPayload ?? null,
      sfnExecutionArn: sfnExecutionArn ?? null,
      ...(flaggedApproval && { flaggedApproval }),
    },
  });

  logger.info('HITL approval complete', { hitlItemId, decision, resolution, auditEventId });

  // Step 11: Return HitlApprovalResult (schema shape — see interface note)
  return {
    hitlItemId,
    tenantId,
    decision,
    auditEventId,
    auditEventTimestamp,
    resolvedBy: approverSub,
    resolvedAt: now,
  };
}

/**
 * Typed error with HTTP-like status code for AppSync error mapping.
 */
class ApprovalError extends Error {
  public readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'ApprovalError';
    this.statusCode = statusCode;
  }
}
