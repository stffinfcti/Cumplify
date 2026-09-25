/**
 * Canonical role precedence — Cognito's groups claim order is NOT
 * priority-ordered, so a multi-group user's role was nondeterministic.
 * Highest-authority membership wins (internal > tenant-admin > tenant-user).
 * Single source for authorizer.ts and pre-token-gen/index.ts.
 */
export const ROLE_PRIORITY: readonly string[] = [
  // PoolA (internal)
  'PlatformAdmin',
  'SecurityOps',
  'SupportEngineer',
  'FinanceOps',
  // PoolB (tenant-admin)
  'TopManagement',
  'IMSLead',
  'QualityManager',
  'EHSManager',
  'DocumentController',
  // PoolC (tenant-user)
  'InternalAuditor',
  'ProcessOwner',
  'Supervisor',
  'PartnerConsultant',
  'Contractor',
  'Employee',
  'ExternalAuditor',
];
