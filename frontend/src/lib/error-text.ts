'use client';

/**
 * errorText — map a thrown error to a LOCALIZED user-facing string.
 *
 * Resolver errors carry stable SNAKE_CASE codes (UNAUTHORIZED,
 * APPROVAL_REQUIRED, …) followed by optional prose meant for logs, never
 * for users. Rendering `err.message` leaks English internals into a UI
 * that ships en/es/pt catalogs — every render site should go through this
 * mapper: known code → catalog string; anything else → the page's
 * localized generic fallback.
 */

const CODE_TO_KEY: Record<string, string> = {
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'unauthorized',
  SESSION_EXPIRED: 'sessionExpired',
  PAUSED_FOR_CREDITS: 'pausedForCredits',
  APPROVAL_REQUIRED: 'approvalRequired',
  INVALID_STATE: 'invalidState',
  SOD_VIOLATION: 'sodViolation',
  GENERATION_UNAVAILABLE: 'generationUnavailable',
  ORG_PROFILE_REQUIRED: 'orgProfileRequired',
  SUBMIT_INVALID_STATUS: 'submitInvalidStatus',
  MAPPING_INCOMPLETE: 'mappingIncomplete',
  VALIDATION_INCOMPLETE: 'validationIncomplete',
  UNRESOLVED_GAPS: 'validationIncomplete',
  LINK_TARGET_NOT_FOUND: 'linkTargetNotFound',
  RECORD_NOT_FOUND: 'recordNotFound',
  VERSION_NOT_FOUND: 'versionNotFound',
  SEAL_FAILED: 'sealFailed',
  HITL_TASK_EXPIRED: 'taskExpired',
  JUSTIFICATION_REQUIRED: 'justificationRequired',
  EXCLUSION_REQUIRES_JUSTIFICATION: 'justificationRequired',
  INVALID_PAYLOAD: 'invalidInput',
  VALIDATION: 'invalidInput',
  BAD_REQUEST: 'invalidInput',
  INVALID_RETURN_URL: 'invalidInput',
  INVALID_STANDARD: 'invalidInput',
  DOCUMENT_NOT_FOUND: 'notFound',
  NC_NOT_FOUND: 'notFound',
  CAPA_NOT_FOUND: 'notFound',
  RISK_NOT_FOUND: 'notFound',
  RUN_NOT_FOUND: 'notFound',
  SECTION_NOT_FOUND: 'notFound',
  AUDIT_NOT_FOUND: 'notFound',
  EXPORT_SET_NOT_FOUND: 'notFound',
  CAPA_ALREADY_CLOSED: 'invalidState',
  APPROVE_INVALID_STATUS: 'invalidState',
  APPROVAL_NOT_REQUIRED: 'invalidState',
  REOPEN_INVALID_STATUS: 'invalidState',
  RECORD_IMMUTABLE: 'invalidState',
  RUN_NOT_FINALIZED: 'invalidState',
  RUN_NOT_REVIEWABLE: 'invalidState',
  AUDIT_NOT_FOUND_OR_ALREADY_COMPLETED: 'invalidState',
  UNREVIEWED_SECTIONS: 'invalidState',
  SECTION_STILL_COMPOSING: 'invalidState',
  VERSION_MISMATCH: 'invalidState',
  SEALED_VERSION_REJECTED: 'invalidState',
  HITL_ALREADY_RESOLVED: 'invalidState',
  MASTER_LIST_NOT_FOUND: 'unavailable',
  TEMPLATE_METADATA_MISSING: 'unavailable',
  NO_CLAUSES_FOR_STANDARD: 'unavailable',
  NO_STANDARDS_IN_SCOPE: 'unavailable',
  DOC_STUDIO_NOT_AVAILABLE: 'unavailable',
  REGENERATE_NOT_AVAILABLE: 'unavailable',
  EXPORT_NOT_AVAILABLE: 'unavailable',
  EXPORT_NOT_CONFIGURED: 'unavailable',
  STRIPE_NOT_CONFIGURED: 'unavailable',
  LEAD_AUDITOR_NOT_AVAILABLE: 'unavailable',
  CONTENT_UNAVAILABLE: 'unavailable',
  RENDER_FAILED: 'sealFailed',
};

const CODE_RE = /^([A-Z][A-Z0-9_]{2,})(?::|\s|$)/;

export function errorText(err: unknown, t: (key: string) => string, fallbackKey: string): string {
  const msg = err instanceof Error ? err.message : '';
  const code = CODE_RE.exec(msg)?.[1];
  if (code && CODE_TO_KEY[code]) return t(CODE_TO_KEY[code]);
  return t(fallbackKey);
}
