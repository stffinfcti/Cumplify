/**
 * qms — org profile schema + read/write surface. Extracted from qms.ts
 * (mechanical decomposition — no semantic changes).
 */

import { z } from 'zod';
import {
  beginTenantTransaction,
  marshalOne,
  publishAuditEvent,
  jsonOut,
} from '../shared.js';
import type { AppSyncEvent } from './common.js';

// ─── ORG-1 Org Profile Schema (zod — full design §2.2) ──────────────────────
// Consumed by saveOrgProfile AND the org-profile wizard (Task 10).
const VALID_STANDARDS = ['ISO9001', 'ISO14001', 'ISO45001'] as const;

export const OrgProfileSchema = z
  .object({
    legalName: z.string().min(1, 'legalName is required'),
    sites: z
      .array(
        z.object({
          name: z.string().min(1),
          address: z.string().optional(),
          city: z.string().optional(),
          state: z.string().optional(),
          country: z.string().optional(),
          headcount: z.number().int().positive().optional(),
        }),
      )
      .min(1, 'at least one site required'),
    employeeCount: z.number().int().positive(),
    industry: z.string().min(1, 'industry is required'),
    productsServices: z.string().min(1, 'productsServices is required'),
    coreProcesses: z.array(z.string().min(1)).min(1, 'at least one core process required'),
    designResponsibility: z.boolean(),
    standardsInScope: z.array(z.enum(VALID_STANDARDS)).min(1, 'at least one standard required'),
    managementRep: z.string().min(1, 'managementRep is required'),
    targetCertDate: z.string().optional(),
    // Extended ORG-1 fields (all optional — absence is a GAP for the generator, never a validation error)
    yearFounded: z.number().int().optional(),
    outsourcedProcesses: z.array(z.string()).optional(),
    supplyChainShape: z.string().optional(),
    existingCertifications: z.array(z.string()).optional(),
    manualExists: z.boolean().optional(),
  })
  .passthrough(); // Allow additional fields for extensibility

export async function getOrgProfile(tenantId: string) {
  const txn = await beginTenantTransaction(tenantId);
  try {
    // Fetch profile + latest version payload in one go
    const result = await txn.execute(`
      SELECT p.id, p.current_version, pv.payload, p.updated_at
      FROM qms.org_profiles p
      LEFT JOIN qms.org_profile_versions pv
        ON pv.profile_id = p.id AND pv.version_no = p.current_version
      LIMIT 1
    `);
    await txn.commit();
    const row = marshalOne(result);
    if (!row) return null;
    // payload is JSONB — Data API returns it stringified; AWSJSON output
    // must be the parsed object or the wire is double-encoded (2026-07-22).
    return { ...row, payload: jsonOut(row.payload) };
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
 * saveOrgProfile — zod-validated JSONB payload, versioned write (design §2.2).
 * In ONE txn: UPSERT org_profiles + INSERT new version row + bump current_version.
 */
export async function saveOrgProfile(event: AppSyncEvent, tenantId: string, actor: string) {
  const input = event.arguments.input as { payload: string | Record<string, unknown> };
  // AppSync delivers AWSJSON arguments to direct Lambda resolvers already
  // parsed (object), while hermetic fixtures pass the JSON string — accept
  // both (found live 2026-07-22: bare JSON.parse coerced the object to
  // "[object Object]" and saveOrgProfile had never worked from the wire).
  const payloadRaw = typeof input.payload === 'string' ? JSON.parse(input.payload) : input.payload;

  // Zod validation (full ORG-1 schema — also consumed by wizard Task 10)
  const parseResult = OrgProfileSchema.safeParse(payloadRaw);
  if (!parseResult.success) {
    throw new Error(`INVALID_PAYLOAD: ${parseResult.error.message}`);
  }
  const payload = parseResult.data;

  const txn = await beginTenantTransaction(tenantId);
  try {
    // UPSERT the profile row (creates if first time, else gets id + current_version)
    const upsertResult = await txn.execute(
      `
      INSERT INTO qms.org_profiles (tenant_id, current_version, created_by)
      VALUES (:tenantId, 0, :actor)
      ON CONFLICT (tenant_id) DO UPDATE SET updated_at = NOW()
      RETURNING id, current_version
    `,
      [
        { name: 'tenantId', value: { stringValue: tenantId } },
        { name: 'actor', value: { stringValue: actor } },
      ],
    );

    const profileRow = marshalOne(upsertResult)!;
    const profileId = profileRow.id as string;
    const currentVersion = profileRow.currentVersion as number;
    const newVersion = currentVersion + 1;

    // INSERT new version row
    await txn.execute(
      `
      INSERT INTO qms.org_profile_versions (profile_id, tenant_id, version_no, payload, created_by)
      VALUES (:profileId::uuid, :tenantId, :versionNo, :payload::jsonb, :actor)
    `,
      [
        { name: 'profileId', value: { stringValue: profileId } },
        { name: 'tenantId', value: { stringValue: tenantId } },
        { name: 'versionNo', value: { longValue: newVersion } },
        { name: 'payload', value: { stringValue: JSON.stringify(payload) } },
        { name: 'actor', value: { stringValue: actor } },
      ],
    );

    // Bump current_version
    await txn.execute(
      `
      UPDATE qms.org_profiles SET current_version = :newVersion, updated_at = NOW()
      WHERE id = :id::uuid
    `,
      [
        { name: 'newVersion', value: { longValue: newVersion } },
        { name: 'id', value: { stringValue: profileId } },
      ],
    );

    await txn.commit();

    // Audit event: Context.Updated (already registered)
    await publishAuditEvent({
      tenantId,
      actor,
      module: 'M1',
      clauseRef: '4.1',
      standard: 'ISO9001',
      detailType: 'Context.Updated',
      source: 'cumplify.qms.document-engine',
      entityId: profileId,
      payload: { profileId, version: newVersion },
    });

    return {
      id: profileId,
      currentVersion: newVersion,
      // AWSJSON output: the parsed object, never a pre-stringified string
      payload,
      updatedAt: new Date().toISOString(),
    };
  } catch (err) {
    try {
      await txn.rollback();
    } catch {
      /* never mask */
    }
    throw err;
  }
}
