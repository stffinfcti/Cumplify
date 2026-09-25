/**
 * qms — clause registry reads + applicability mutation. Extracted from
 * qms.ts.
 */

import { beginTenantTransaction, marshalOne, marshalMany, publishAuditEvent } from '../shared.js';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import type { AppSyncEvent } from './common.js';

export async function listClauseRegistry(event: AppSyncEvent, tenantId: string) {
  const standard = event.arguments.standard as string | undefined;
  const txn = await beginTenantTransaction(tenantId);
  try {
    let sql = `
      SELECT id, standard, clause_no, clause_title, intent_paraphrase,
             annex_sl_mode, harmonization_key, required_sources, sort_order
      FROM qms.clause_registry
    `;
    const params: SqlParameter[] = [];
    if (standard) {
      sql += ` WHERE standard = :standard`;
      params.push({ name: 'standard', value: { stringValue: standard } });
    }
    sql += ` ORDER BY sort_order`;

    const result = await txn.execute(sql, params);
    await txn.commit();
    return marshalMany(result);
  } catch (err) {
    try {
      await txn.rollback();
    } catch {
      /* never mask */
    }
    throw err;
  }
}

export async function listClauseApplicability(tenantId: string) {
  const txn = await beginTenantTransaction(tenantId);
  try {
    const result = await txn.execute(`
      SELECT id, clause_registry_id, applicable, justification
      FROM qms.clause_applicability
    `);
    await txn.commit();
    return marshalMany(result);
  } catch (err) {
    try {
      await txn.rollback();
    } catch {
      /* never mask */
    }
    throw err;
  }
}

/**
 * setClauseApplicability — exclusion REQUIRES justification (DB CHECK enforces;
 * surface typed error before hitting the DB for better UX).
 */
export async function setClauseApplicability(event: AppSyncEvent, tenantId: string, actor: string) {
  const input = event.arguments.input as {
    clauseRegistryId: string;
    applicable: boolean;
    justification?: string;
  };

  // Surface typed error before hitting DB CHECK
  if (!input.applicable && (!input.justification || input.justification.trim().length === 0)) {
    throw new Error('EXCLUSION_REQUIRES_JUSTIFICATION');
  }

  const txn = await beginTenantTransaction(tenantId);
  try {
    const result = await txn.execute(
      `
      INSERT INTO qms.clause_applicability (tenant_id, clause_registry_id, applicable, justification, decided_by, created_by)
      VALUES (:tenantId, :clauseId::uuid, :applicable, :justification, :actor, :actor)
      ON CONFLICT (tenant_id, clause_registry_id)
      DO UPDATE SET applicable = :applicable, justification = :justification,
                    decided_by = :actor, decided_at = NOW(), updated_at = NOW()
      RETURNING id, clause_registry_id, applicable, justification
    `,
      [
        { name: 'tenantId', value: { stringValue: tenantId } },
        { name: 'clauseId', value: { stringValue: input.clauseRegistryId } },
        { name: 'applicable', value: { booleanValue: input.applicable } },
        {
          name: 'justification',
          value: input.justification ? { stringValue: input.justification } : { isNull: true },
        },
        { name: 'actor', value: { stringValue: actor } },
      ],
    );

    await txn.commit();

    const applicability = marshalOne(result);
    // Audit event: Scope.Changed (already registered)
    await publishAuditEvent({
      tenantId,
      actor,
      module: 'M1',
      clauseRef: '4.3',
      standard: 'ISO9001',
      detailType: 'Scope.Changed',
      source: 'cumplify.qms.document-engine',
      entityId: String(applicability?.id ?? ''), // the ClauseApplicability row the mutation returns
      payload: {
        applicabilityId: applicability?.id,
        clauseRegistryId: input.clauseRegistryId,
        applicable: input.applicable,
      },
    });

    return applicability;
  } catch (err) {
    try {
      await txn.rollback();
    } catch {
      /* never mask */
    }
    throw err;
  }
}
