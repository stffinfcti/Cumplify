/**
 * M1 Document Studio — draft creation paths (human, agent writeback, and the
 * DocStudio front door). Extracted from m1.ts (mechanical decomposition).
 */

import { InvokeCommand } from '@aws-sdk/client-lambda';
import { ulid } from 'ulid';
import { beginTenantTransaction, publishAuditEvent, marshalOne } from '../shared.js';
import { mapEnum, DOC_TYPE_MAP } from '../enum-mappings.js';
import { logger, lambdaClient, DOC_STUDIO_FN_ARN, type AppSyncEvent } from './common.js';

/**
 * runDocDraft (S2, studio wave) — Document Studio's front door: the user
 * describes the document they need; DocStudio drafts it whole (title,
 * clause refs, sections) and proposes via the doc-draft HITL tool.
 * Fire-and-forget Event invoke (runNcIntake pattern); the HITL card is
 * the deliverable.
 * S2.3 (owner screenshot 2026-07-22): the current org profile rides in the
 * payload — without it the agent drafted "[Organization Name]" placeholders
 * into a live card. Doctrine #5: never make the human fill what the AI can
 * know. Profile absence is fine (pre-wizard tenants draft ungrounded).
 */
export async function runDocDraft(event: AppSyncEvent, tenantId: string, actor: string) {
  const intent = (event.arguments.intent as string) ?? '';
  if (!intent.trim()) throw new Error('VALIDATION: intent is required');
  const docType = event.arguments.docType as string | undefined;
  const standard = event.arguments.standard as string | undefined;

  let orgProfile: Record<string, unknown> | null = null;
  const txn = await beginTenantTransaction(tenantId);
  try {
    const result = await txn.execute(`
      SELECT pv.payload
      FROM qms.org_profiles p
      JOIN qms.org_profile_versions pv
        ON pv.profile_id = p.id AND pv.version_no = p.current_version
      LIMIT 1
    `);
    await txn.commit();
    const raw = (result.records?.[0]?.[0] as { stringValue?: string } | undefined)?.stringValue;
    if (raw) orgProfile = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    try {
      await txn.rollback();
    } catch {
      /* never mask */
    }
    throw err;
  }

  const runId = ulid();
  await lambdaClient.send(
    new InvokeCommand({
      FunctionName: DOC_STUDIO_FN_ARN,
      InvocationType: 'Event',
      Payload: JSON.stringify({
        tenantId,
        runId,
        requestedBy: actor,
        draftIntent: {
          intent,
          ...(docType ? { docType } : {}),
          ...(standard ? { standard } : {}),
          ...(orgProfile ? { orgProfile } : {}),
        },
      }),
    }),
  );

  logger.info('Doc draft dispatched', { tenantId, runId, hasProfile: !!orgProfile });
  return { runId, status: 'DISPATCHED' };
}

export async function createDocumentDraft(event: AppSyncEvent, tenantId: string, actor: string) {
  const input = event.arguments.input as Record<string, unknown>;
  const docType = mapEnum(DOC_TYPE_MAP, input.docType as string, 'docType');
  const txn = await beginTenantTransaction(tenantId);
  try {
    const result = await txn.execute(
      `INSERT INTO m1.documents (tenant_id, standard, doc_type, title, owner_id, status, created_by)
       VALUES (:tenantId, :standard, :docType, :title, :actor, 'draft', :actor)
       RETURNING *`,
      [
        { name: 'tenantId', value: { stringValue: tenantId } },
        { name: 'standard', value: { stringValue: input.standard as string } },
        { name: 'docType', value: { stringValue: docType } },
        { name: 'title', value: { stringValue: input.title as string } },
        { name: 'actor', value: { stringValue: actor } },
      ],
    );
    await txn.commit();
    const doc = marshalOne(result);
    await publishAuditEvent({
      tenantId,
      actor,
      module: 'M1',
      clauseRef: 'ISO 9001 7.5.2',
      standard: 'ISO9001',
      detailType: 'Document.DraftCreated',
      source: 'cumplify.m1.document-studio',
      entityId: String(doc?.id ?? ''),
      payload: { documentId: doc?.id, input },
    });
    return doc;
  } catch (err) {
    await txn.rollback();
    throw err;
  }
}

/**
 * agentDraftDocument (RS-7, DocStudio writeback door) — creates a DRAFT
 * document row + its first version in one transaction. Direct write, no
 * HITL gate: a draft is not record-of-truth (7.5.2's review/approve stages
 * — submitDocumentForApproval -> approveDocumentVersion, unchanged) are the
 * existing gate a human already walks through downstream, exactly as for a
 * human-authored createDocumentDraft.
 */
export async function agentDraftDocument(event: AppSyncEvent, tenantId: string, actor: string) {
  const input = event.arguments.input as Record<string, unknown>;
  const docType = mapEnum(DOC_TYPE_MAP, input.docType as string, 'docType');
  const txn = await beginTenantTransaction(tenantId);
  try {
    const docResult = await txn.execute(
      `INSERT INTO m1.documents (tenant_id, standard, doc_type, title, owner_id, status, created_by)
       VALUES (:tenantId, :standard, :docType, :title, :actor, 'draft', :actor)
       RETURNING *`,
      [
        { name: 'tenantId', value: { stringValue: tenantId } },
        { name: 'standard', value: { stringValue: input.standard as string } },
        { name: 'docType', value: { stringValue: docType } },
        { name: 'title', value: { stringValue: input.title as string } },
        { name: 'actor', value: { stringValue: actor } },
      ],
    );
    const doc = marshalOne(docResult);
    await txn.execute(
      `INSERT INTO m1.document_versions (tenant_id, document_id, version_no, content_ref, change_summary, author_id, created_by)
       VALUES (:tenantId, :documentId::uuid, 1, :contentRef, 'Agent draft', :actor, :actor)`,
      [
        { name: 'tenantId', value: { stringValue: tenantId } },
        { name: 'documentId', value: { stringValue: String(doc?.id ?? '') } },
        { name: 'contentRef', value: { stringValue: input.contentRef as string } },
        { name: 'actor', value: { stringValue: actor } },
      ],
    );
    await txn.commit();
    await publishAuditEvent({
      tenantId,
      actor,
      module: 'M1',
      clauseRef: 'ISO 9001 7.5.2',
      standard: 'ISO9001',
      detailType: 'Document.DraftCreated',
      source: 'cumplify.m1.document-studio',
      entityId: String(doc?.id ?? ''),
      payload: { documentId: doc?.id, input },
    });
    return doc;
  } catch (err) {
    await txn.rollback();
    throw err;
  }
}
