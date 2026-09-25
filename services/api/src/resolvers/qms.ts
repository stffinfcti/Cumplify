/**
 * qms — ISO QMS resolver (org profile, clause registry, generation runs,
 * IMS export). Thin dispatch shell after god-file decomposition (audit M
 * item 11): bodies live under ./qms/ — no semantic changes.
 */

import { extractContext, requireModuleRole } from './shared.js';
import { logger, type AppSyncEvent } from './qms/common.js';
import { getOrgProfile, saveOrgProfile } from './qms/org-profile.js';
import {
  listClauseRegistry,
  listClauseApplicability,
  setClauseApplicability,
} from './qms/clauses.js';
import {
  getGenerationRun,
  listGenerationRuns,
  markSectionReviewed,
  generateImsManual,
  requestImsExport,
  regenerateSection,
  runManualSectionDraft,
} from './qms/generation.js';

export { OrgProfileSchema } from './qms/org-profile.js';

export async function handler(event: AppSyncEvent): Promise<unknown> {
  const ctx = extractContext(event);
  const { tenantId, sub, role } = ctx;
  logger.appendKeys({ tenantId, requestField: event.info.fieldName });

  switch (event.info.fieldName) {
    case 'getOrgProfile':
      return getOrgProfile(tenantId);
    case 'saveOrgProfile':
      return requireM1Role(role, () => saveOrgProfile(event, tenantId, sub));
    case 'listClauseRegistry':
      return listClauseRegistry(event, tenantId);
    case 'listClauseApplicability':
      return listClauseApplicability(tenantId);
    case 'setClauseApplicability':
      return requireM1Role(role, () => setClauseApplicability(event, tenantId, sub));
    case 'getGenerationRun':
      return getGenerationRun(event, tenantId);
    case 'listGenerationRuns':
      return listGenerationRuns(event, tenantId);
    case 'markSectionReviewed':
      return requireM1Role(role, () => markSectionReviewed(event, tenantId, sub));
    case 'generateImsManual':
      return requireM1Role(role, () => generateImsManual(event, tenantId, sub));
    case 'requestImsExport':
      return requestImsExport(event, tenantId);
    case 'regenerateSection':
      return requireM1Role(role, () => regenerateSection(event, tenantId, sub));
    case 'runManualSectionDraft':
      return requireM1Role(role, () => runManualSectionDraft(event, tenantId, sub));
    default:
      throw new Error(`Unknown field: ${event.info.fieldName}`);
  }
}

/** Role gate: M1 authoring family (design §6) — shared requireModuleRole helper. */
function requireM1Role<T>(role: string, fn: () => T): T {
  return requireModuleRole(role, 'M1', fn);
}
