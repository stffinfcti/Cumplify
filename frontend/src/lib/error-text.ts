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
  LINK_TARGET_NOT_FOUND: 'linkTargetNotFound',
  RECORD_NOT_FOUND: 'recordNotFound',
  VERSION_NOT_FOUND: 'versionNotFound',
  SEAL_FAILED: 'sealFailed',
};

const CODE_RE = /^([A-Z][A-Z0-9_]{2,})(?::|\s|$)/;

export function errorText(err: unknown, t: (key: string) => string, fallbackKey: string): string {
  const msg = err instanceof Error ? err.message : '';
  const code = CODE_RE.exec(msg)?.[1];
  if (code && CODE_TO_KEY[code]) return t(CODE_TO_KEY[code]);
  return t(fallbackKey);
}
