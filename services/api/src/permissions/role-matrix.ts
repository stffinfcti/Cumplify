/**
 * Part 13 Permission Matrix — HITL approval rights per role.
 * Versioned shared module consumed by hitl-approval.ts (step 2).
 *
 * Source: cumplify-CONSOLIDATED-master-architecture-v7-full.md Part 13.1–13.2
 * 12 roles × module write permissions. canApprove checks if the role has
 * write access to the artifact's module (write = can approve HITL items).
 *
 * SoD rules (enforced elsewhere, not in this map):
 * - author ≠ approver (per-artifact check in the approval Lambda)
 * - auditor-independence (Internal Auditor cannot audit processes where they hold write)
 * - incident-investigator ≠ area supervisor
 */

/** Modules where each role has write (and therefore approval) permission */
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

/**
 * Cognito group name → Part 13 role slug. IdentityStack (spec 1) created
 * PascalCase groups and PreTokenGen stamps the FIRST group name verbatim as
 * custom:role, while this matrix keys on kebab-case slugs — without this map
 * every approval 403s regardless of role (BUG-11a, found live at ACC-3).
 * IMSLead maps to Part 13 Role 2 (Management Rep / IMS Lead), not a naive
 * kebab-casing. 'Employee' is PreTokenGen's no-group fallback.
 */
const COGNITO_GROUP_ROLES: Record<string, string> = {
  TopManagement: 'top-management',
  IMSLead: 'management-rep',
  QualityManager: 'quality-manager',
  EHSManager: 'ehs-manager',
  DocumentController: 'document-controller',
  Employee: 'employee',
  // Auditor/supervisory groups (AUDIT_TRAIL_ROLES uses these verbatim — proof
  // the Cognito groups are PascalCase). Without the mapping an InternalAuditor
  // 403s their own M3 surface.
  InternalAuditor: 'internal-auditor',
  ExternalAuditor: 'external-auditor',
  Supervisor: 'supervisor',
  ProcessOwner: 'process-owner',
  Contractor: 'contractor',
  PartnerConsultant: 'partner-consultant',
};

/** Map a raw custom:role claim (Cognito group name or slug) to a matrix key. */
export function normalizeRole(role: string): string {
  return COGNITO_GROUP_ROLES[role] ?? role;
}

/**
 * Writeback tool → module. Ground truth = execute-writeback.ts SQL targets
 * (PG schema mN == module MN). HITL items do not carry a module field today
 * (enterHitlGate omits it — spec-4 carry), so approval resolves the module
 * from the proposed tool; unmapped tools resolve to 'unknown' and deny.
 */
export const TOOL_MODULES: Record<string, string> = {
  'capa-open': 'M2', // m2.corrective_actions
  'rca-write': 'M2', // m2.root_cause_analyses (C1 CAPA Studio RCA)
  'capa-verify-effectiveness': 'M2', // m2.capa_effectiveness_checks
  'doc-draft': 'M1', // m1.documents (S2 Document Studio: agent-drafted creation)
  'manual-section-draft': 'M1', // m1 manual versions via GEN-6 engine (S3 Manual Studio)
  'doc-publish': 'M1', // m1 document lifecycle
  'doc-version-control': 'M1', // m1.document_versions
  'audit-finding-write': 'M3', // m3.audit_findings
  'audit-checklist-gen': 'M3', // m3.audit_checklists
  'records-retention-schedule': 'M4', // m4.retention_policies
  'ct-governance-write': 'M1', // BLOCKED-ON-DESIGN at writeback; M1 per corpus intent
  // read-surface-completion RS-8 (queued next): execute-writeback.ts's new
  // dispatch cases for these two tools (CAPAGuru/RiskSentinel tool-loop
  // proposals, HITL-gated — the real compliance-gated path per architecture
  // §4 CAPA stage 2/risk assessment). TOOL_ARTIFACTS (approval-matrix.ts)
  // already mapped these; this map was the missing half of the pair
  // (asymmetry found at RS-7 build time) — added now so RS-8 doesn't hit
  // the same gap.
  'nc-draft-write': 'M2', // m2.nonconformities (S1 intake: agent-drafted NC creation)
  'nc-triage-write': 'M2', // m2.nonconformities (nc_type reclassification)
  'risk-assessment-write': 'M5', // m5.risks (likelihood/severity update)
};

/** Resolve a HITL item's module: explicit field first, then tool registry. */
export function resolveModule(item: {
  module?: unknown;
  proposedAction?: { tool?: unknown } | Record<string, unknown>;
}): string {
  if (typeof item.module === 'string' && item.module.length > 0) return item.module;
  const tool = (item.proposedAction as { tool?: unknown } | undefined)?.tool;
  if (typeof tool === 'string' && TOOL_MODULES[tool]) return TOOL_MODULES[tool];
  return 'unknown';
}

/**
 * Check if a role has approval permission for a HITL item in the given module.
 * Returns true if the role has write access to the module.
 * Unknown roles default to false (deny).
 */
export function canApprove(role: string, module: string): boolean {
  const modules = ROLE_WRITE_MODULES[normalizeRole(role)];
  if (!modules) return false;
  return modules.has(module);
}

/**
 * Get all modules a role can approve for (utility for UI display).
 */
export function getApprovalModules(role: string): readonly string[] {
  const modules = ROLE_WRITE_MODULES[normalizeRole(role)];
  if (!modules) return [];
  return [...modules];
}

/** All known roles (for validation) */
export const KNOWN_ROLES = Object.keys(ROLE_WRITE_MODULES);
