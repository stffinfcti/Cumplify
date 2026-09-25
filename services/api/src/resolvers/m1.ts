/**
 * M1 Document Studio resolver — dispatch shell.
 * RDS system-of-record via Data API (app_role). DDB metadata via tenant-data role.
 * C-2 INVARIANT: set_config FIRST in every transaction, transaction-local (true).
 * SCHEMA-5: tenantId from resolverContext only.
 *
 * God-file decomposition (M-effort, item 11): resolver bodies live in
 * resolvers/m1/ siblings — drafts.ts (create/agent/runDoc drafts),
 * versions.ts (submit/approve/publish+seal, version queries, section edit,
 * diff internals), policy.ts (updatePolicy/updateImsScope), queries.ts
 * (document read surface), common.ts (clients, env, content-plane helpers).
 * Only the field→function dispatch remains here; exported symbols unchanged.
 */

import { extractContext, extractAgentContext, requireModuleRole } from './shared.js';
import { logger, type AppSyncEvent } from './m1/common.js';
import { runDocDraft, createDocumentDraft, agentDraftDocument } from './m1/drafts.js';
import {
  submitDocumentForApproval,
  approveDocumentVersion,
  publishControlledDocument,
  listDocumentVersions,
  getDocumentVersionDiff,
  getDocumentContent,
  saveDocumentSectionEdit,
} from './m1/versions.js';
import { updatePolicy, updateImsScope } from './m1/policy.js';
import { getDocument, listDocuments } from './m1/queries.js';

export async function handler(event: AppSyncEvent): Promise<unknown> {
  // RS-7: agent* (@aws_iam) fields never carry resolverContext — branch
  // BEFORE extractContext, which would throw for them.
  if (event.info.fieldName === 'agentDraftDocument') {
    const { tenantId, actor } = extractAgentContext(event.arguments, 'DocStudio', event.identity);
    logger.appendKeys({ tenantId, requestField: event.info.fieldName });
    return agentDraftDocument(event, tenantId, actor);
  }

  const ctx = extractContext(event);
  const { tenantId, sub, role } = ctx;
  logger.appendKeys({ tenantId, requestField: event.info.fieldName });

  // M-effort: M1 write mutations are role-gated at entry (Part 13 matrix);
  // queries stay at the authenticated floor.
  switch (event.info.fieldName) {
    case 'createDocumentDraft':
      return requireModuleRole(role, 'M1', () => createDocumentDraft(event, tenantId, sub));
    case 'submitDocumentForApproval':
      return requireModuleRole(role, 'M1', () => submitDocumentForApproval(event, tenantId, sub));
    case 'approveDocumentVersion':
      return requireModuleRole(role, 'M1', () => approveDocumentVersion(event, tenantId, sub));
    case 'publishControlledDocument':
      return requireModuleRole(role, 'M1', () => publishControlledDocument(event, tenantId, sub));
    case 'updatePolicy':
      return requireModuleRole(role, 'M1', () => updatePolicy(event, tenantId, sub));
    case 'updateImsScope':
      return requireModuleRole(role, 'M1', () => updateImsScope(event, tenantId, sub));
    case 'getDocument':
      return getDocument(event, tenantId);
    case 'listDocuments':
      return listDocuments(event, tenantId);
    case 'listDocumentVersions':
      return listDocumentVersions(event, tenantId);
    case 'getDocumentVersionDiff':
      return getDocumentVersionDiff(event, tenantId);
    case 'getDocumentContent':
      return getDocumentContent(event, tenantId);
    case 'saveDocumentSectionEdit':
      return requireModuleRole(role, 'M1', () => saveDocumentSectionEdit(event, tenantId, sub));
    case 'runDocDraft':
      return requireModuleRole(role, 'M1', () => runDocDraft(event, tenantId, sub));
    default:
      throw new Error(`Unknown field: ${event.info.fieldName}`);
  }
}
