/**
 * M1 Document Studio — document read surface. Extracted from m1.ts
 * (mechanical decomposition — no semantic changes).
 */

import { beginTenantTransaction, marshalOne, marshalMany } from '../shared.js';
import { mapEnum, DOC_STATUS_MAP } from '../enum-mappings.js';
import { LIST_QUERY_LIMIT, type AppSyncEvent } from './common.js';

export async function getDocument(event: AppSyncEvent, tenantId: string) {
  const txn = await beginTenantTransaction(tenantId);
  try {
    const result = await txn.execute(`SELECT * FROM m1.documents WHERE id = :id::uuid`, [
      { name: 'id', value: { stringValue: event.arguments.id as string } },
    ]);
    await txn.commit();
    return marshalOne(result);
  } catch (err) {
    await txn.rollback();
    throw err;
  }
}

export async function listDocuments(event: AppSyncEvent, tenantId: string) {
  // Filters declared in the schema (standard, status) are honored here —
  // previously ignored, which made the M1 filter bar a no-op live.
  const clauses: string[] = [];
  const params: Array<{ name: string; value: { stringValue: string } }> = [];
  const standard = event.arguments.standard as string | undefined;
  const status = event.arguments.status as string | undefined;
  if (standard) {
    clauses.push('standard = :standard');
    params.push({ name: 'standard', value: { stringValue: standard } });
  }
  if (status) {
    clauses.push('status = :status');
    params.push({
      name: 'status',
      value: { stringValue: mapEnum(DOC_STATUS_MAP, status, 'status') },
    });
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const txn = await beginTenantTransaction(tenantId);
  try {
    const result = await txn.execute(
      `SELECT * FROM m1.documents ${where} ORDER BY created_at DESC LIMIT ${LIST_QUERY_LIMIT}`,
      params,
    );
    await txn.commit();
    return marshalMany(result);
  } catch (err) {
    await txn.rollback();
    throw err;
  }
}
