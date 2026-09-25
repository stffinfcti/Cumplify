/**
 * M1 Document Studio — policy + IMS scope writes. Extracted from m1.ts
 * (mechanical decomposition — no semantic changes).
 */

import {
  beginTenantTransaction,
  publishAuditEvent,
  marshalOne,
} from '../shared.js';
import type { AppSyncEvent } from './common.js';

export async function updatePolicy(event: AppSyncEvent, tenantId: string, actor: string) {
  const input = event.arguments.input as Record<string, unknown>;
  const txn = await beginTenantTransaction(tenantId);
  try {
    const result = await txn.execute(
      `UPDATE m1.policies SET policy_text = :text, effective_date = NOW(), updated_at = NOW()
       WHERE id = :id::uuid RETURNING *`,
      [
        { name: 'id', value: { stringValue: input.id as string } },
        { name: 'text', value: { stringValue: input.policyText as string } },
      ],
    );
    await txn.commit();
    await publishAuditEvent({
      tenantId,
      actor,
      module: 'M1',
      clauseRef: 'ISO 9001 5.2',
      standard: 'ISO9001',
      detailType: 'Policy.Updated',
      source: 'cumplify.m1.document-studio',
      entityId: input.id as string,
      payload: { policyId: input.id },
    });
    return marshalOne(result);
  } catch (err) {
    await txn.rollback();
    throw err;
  }
}

export async function updateImsScope(event: AppSyncEvent, tenantId: string, actor: string) {
  const input = event.arguments.input as Record<string, unknown>;
  const txn = await beginTenantTransaction(tenantId);
  try {
    const result = await txn.execute(
      `UPDATE m1.ims_scope SET scope_statement = :stmt, boundaries = :bounds, exclusions_9001 = :excl, updated_at = NOW()
       WHERE id = :id::uuid RETURNING *`,
      [
        { name: 'id', value: { stringValue: input.id as string } },
        { name: 'stmt', value: { stringValue: input.scopeStatement as string } },
        { name: 'bounds', value: { stringValue: (input.boundaries as string) ?? '' } },
        { name: 'excl', value: { stringValue: (input.exclusions9001 as string) ?? '' } },
      ],
    );
    await txn.commit();
    await publishAuditEvent({
      tenantId,
      actor,
      module: 'M1',
      clauseRef: 'ISO 9001 4.3',
      standard: 'ISO9001',
      detailType: 'Scope.Changed',
      source: 'cumplify.m1.document-studio',
      entityId: input.id as string,
      payload: { scopeId: input.id },
    });
    return marshalOne(result);
  } catch (err) {
    await txn.rollback();
    throw err;
  }
}
