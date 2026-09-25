/**
 * Forms module resolver — dispatch shell (Task 8 qms-forms catalog + record
 * lifecycle + PDF export/sealing).
 * RDS system-of-record via Data API (app_role) inside beginTenantTransaction.
 * C-2 INVARIANT: set_config FIRST in every transaction, transaction-local (true).
 * SCHEMA-5: tenantId from resolverContext only, never input.
 * i18n: all user-facing strings resolve through locale catalogs — nothing
 * hardcoded (pseudo-locale CI). PDF export resolves the tenant's document
 * locale server-side (Task 8 Rec-7).
 *
 * Note: listFormRecords closes the standing BLOCKED listRecords item from
 * frontend-app Task 29.
 *
 * God-file decomposition (M-effort, item 11): resolver bodies live in
 * resolvers/forms/ siblings — catalog.ts (template + record read surface),
 * records.ts (record lifecycle mutations + getFormRecord), export.ts
 * (PDF export + approved-record sealing), common.ts (clients, env,
 * marshal/coercion/locale helpers). Only the field→function dispatch
 * remains here; exported symbols unchanged.
 */

import { extractContext, requireModuleRole } from './shared.js';
import { logger, type AppSyncEvent } from './forms/common.js';
import { listFormTemplates, getFormTemplate, listFormRecords } from './forms/catalog.js';
import {
  getFormRecord,
  createFormRecord,
  saveFormRecordValues,
  submitFormRecord,
  approveFormRecord,
  reopenFormRecord,
} from './forms/records.js';
import { exportFormRecordPdf } from './forms/export.js';

export async function handler(event: AppSyncEvent): Promise<unknown> {
  const ctx = extractContext(event);
  const { tenantId, sub, role } = ctx;
  logger.appendKeys({ tenantId, requestField: event.info.fieldName });

  // M-effort: create/save/submit stay at the authenticated floor — any tenant
  // member records evidence (Part 13 matrix has no 'form-filler' role).
  // approve/reopen flip records-domain compliance state (approve seals into
  // m4.records) — gated to the M4 write family, same matrix hitl-approval uses.
  switch (event.info.fieldName) {
    case 'listFormTemplates':
      return listFormTemplates(tenantId);
    case 'getFormTemplate':
      return getFormTemplate(event);
    case 'listFormRecords':
      return listFormRecords(event, tenantId);
    case 'getFormRecord':
      return getFormRecord(event, tenantId);
    case 'createFormRecord':
      return createFormRecord(event, tenantId, sub);
    case 'saveFormRecordValues':
      return saveFormRecordValues(event, tenantId);
    case 'submitFormRecord':
      return submitFormRecord(event, tenantId, sub, role);
    case 'approveFormRecord':
      return requireModuleRole(role, 'M4', () => approveFormRecord(event, tenantId, sub));
    case 'reopenFormRecord':
      return requireModuleRole(role, 'M4', () => reopenFormRecord(event, tenantId, sub));
    case 'exportFormRecordPdf':
      return exportFormRecordPdf(event, tenantId);
    default:
      throw new Error(`Unknown field: ${event.info.fieldName}`);
  }
}
