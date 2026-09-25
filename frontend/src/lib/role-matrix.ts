/**
 * Frontend role-matrix — GENERATED FILE. DO NOT EDIT BY HAND.
 * Single source of truth: services/api/src/permissions/role-matrix.ts
 * (the "versioned shared module" this file mirrors).
 *
 * Regenerate:  npm run gen:role-matrix
 * Drift check: npm run check:role-matrix   (wired into scripts/verify.ts)
 *
 * CON-6: presentation-only gating (server always enforces).
 * Uses the normalizeRole alias map for Cognito PascalCase groups (BUG-11a).
 */

/** Cognito PascalCase group → kebab-case slug (BUG-11a) */
const COGNITO_GROUP_ROLES: Record<string, string> = {
  TopManagement: 'top-management',
  IMSLead: 'management-rep',
  QualityManager: 'quality-manager',
  EHSManager: 'ehs-manager',
  DocumentController: 'document-controller',
  Employee: 'employee',
  InternalAuditor: 'internal-auditor',
  ExternalAuditor: 'external-auditor',
  Supervisor: 'supervisor',
  ProcessOwner: 'process-owner',
  Contractor: 'contractor',
  PartnerConsultant: 'partner-consultant',
};

/** Map a raw custom:role claim to a matrix key. */
export function normalizeRole(role: string): string {
  return COGNITO_GROUP_ROLES[role] ?? role;
}

/** Part 13 permission map — modules where each role has write (approval) permission. */
const ROLE_WRITE_MODULES: Record<string, ReadonlySet<string>> = {
  // Role 1: Top Management / Executive — approve policies (M1 policy only), 9.3 outputs
  'top-management': new Set(['M1']),
  // Role 2: Management Rep / IMS Lead — full write across all modules
  'management-rep': new Set([
    'M1',
    'M2',
    'M3',
    'M4',
    'M5',
    'M6',
    'M7',
    'M8',
    'M9',
    'M10',
    'M11',
    'M12',
    'M13',
  ]),
  // Role 3: Quality Manager — quality domains
  'quality-manager': new Set(['M1', 'M2', 'M3', 'M4', 'M5', 'M7', 'M11', 'M12', 'M13']),
  // Role 4: EHS Manager — environmental + OH&S domains
  'ehs-manager': new Set(['M5', 'M7', 'M8', 'M9', 'M10', 'M11']),
  // Role 5: Document Controller — M1/M14 full lifecycle
  'document-controller': new Set(['M1']),
  // Role 6: Internal Auditor — M3 full, read-only everywhere else
  'internal-auditor': new Set(['M3']),
  // Role 7: External Auditor (guest) — read-only, time-boxed
  'external-auditor': new Set([]),
  // Role 8: Process Owner — write within assigned processes only (row-level)
  'process-owner': new Set(['M1', 'M2', 'M5']),
  // Role 9: Supervisor — M10 hazard/incident, M13 training
  supervisor: new Set(['M10', 'M13']),
  // Role 10: Employee / Worker — incident reporting only
  employee: new Set(['M10']),
  // Role 11: Contractor (limited) — incident reporting only
  contractor: new Set(['M10']),
  // Role 12: Partner Consultant — delegated per-tenant, per-role access (handled at auth layer)
  'partner-consultant': new Set([]),
};

/** Roles that can see /settings (Pool B admin-tier roles). */
const ADMIN_ROLES = new Set([
  'top-management',
  'management-rep',
  'quality-manager',
  'ehs-manager',
  'document-controller',
]);

/** Can this role see the admin/settings nav section? */
export function canSeeAdmin(role: string): boolean {
  return ADMIN_ROLES.has(normalizeRole(role));
}

/**
 * Per-module approval check — mirrors backend canApprove(role, module).
 * Returns true if the role has write access to the given module.
 * Unknown roles default to false (deny).
 */
export function canApprove(role: string, module: string): boolean {
  const modules = ROLE_WRITE_MODULES[normalizeRole(role)];
  if (!modules) return false;
  return modules.has(module);
}

/** Human-readable label for the role claim. */
export function roleLabel(role: string): string {
  const slug = normalizeRole(role);
  return slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** All known roles (for validation/testing). */
export const KNOWN_ROLES = Object.keys(ROLE_WRITE_MODULES);
