/**
 * Environment configuration — drives stage-conditional resource parameters.
 * Per design §1.2 (F-3 resolution).
 */

export interface EnvConfig {
  readonly envName: 'dev' | 'staging' | 'prod';
  readonly account: string;
  readonly region: string;
  /**
   * Pinned AZs for VPC creation. Must be the intersection of AZs that support
   * ALL required VPC endpoint services (especially com.amazonaws.us-east-1.aoss
   * which is NOT available in all AZs). AZ-name-to-physical mapping is randomized
   * per account — values are account-specific.
   *
   * Empty array [] = not yet populated (MUST run describe-vpc-endpoint-services
   * intersection query against the target account before first deploy).
   */
  readonly availabilityZones: string[];
  /**
   * IdC SAML metadata URL for Pool A federation (task 3.2). undefined =
   * federation not wired yet. The URL is console-only (no API exposes it):
   * IdC console -> Applications -> cumplify-pool-a-sso -> "IAM Identity Center
   * SAML metadata file". Setting it activates the Cognito SAML provider.
   */
  readonly samlMetadataUrl?: string;
  // Stage-conditional resource parameters
  readonly globalTableReplica: boolean;
  readonly drRegionStack: boolean;
  readonly secretsReplica: boolean;
  readonly s3Crr: boolean;
  readonly aossStandby: boolean;
  readonly auroraMinCapacity: number;
  readonly auroraMaxCapacity: number;
  readonly cacheMultiAz: boolean;
  readonly cacheNodeType: string;
  /** Object Lock COMPLIANCE retention for the audit-archive bucket (days). */
  readonly auditArchiveRetentionDays: number;
  /**
   * EvidenceVault Object-Lock default retention (days) + mode.
   *
   * This is a SAFETY-NET default only: writers set a per-object
   * `retain-until-date` derived from the TENANT's retention policy
   * (m4.retention_policies), which overrides this default. The default exists
   * so an object written without explicit retention is never unprotected.
   *
   * Was hardcoded COMPLIANCE / 2555 days for every environment (fixed
   * 2026-07-14). Two consequences, both real: (1) one sealed object made the
   * dev bucket permanently undeletable — COMPLIANCE cannot be shortened by
   * anyone, including root; (2) it silently overrode every tenant retention
   * policy shorter than 7 years, making ISO 7.5.3 disposition and GDPR
   * erasure impossible. Dev/staging now use GOVERNANCE + a short window so
   * the bucket stays disposable; prod keeps the 7-year COMPLIANCE floor.
   */
  readonly evidenceRetentionDays: number;
  readonly evidenceRetentionMode: 'COMPLIANCE' | 'GOVERNANCE';
  /**
   * Email endpoint for cost/ops alert SNS subscriptions (COND-4 credit-cap
   * alerts). SNS email subscriptions require a one-time confirmation click
   * by the recipient before delivery starts.
   */
  readonly alertEmail: string;
  /**
   * Public frontend origin (no scheme) used for Cognito OAuth callbackUrls /
   * logoutUrls — e.g. the deployed CloudFront domain or a custom domain.
   * Populate after first deploy per env; localhost is always also allowed
   * so `next dev` sign-in keeps working.
   */
  readonly frontendDomain?: string;
}

export const ENV_CONFIGS: Record<string, EnvConfig> = {
  dev: {
    envName: 'dev',
    account: '697114252993',
    region: 'us-east-1',
    // Pinned to AOSS-supported AZs (verified: com.amazonaws.us-east-1.aoss
    // available in 1b/1c/1d only in account 697114252993, deploy #1 failure).
    availabilityZones: ['us-east-1b', 'us-east-1c'],
    // IdC app cumplify-pool-a-sso (apl-7223d822671e7fe5); metadata validated
    // 2026-07-04: HTTP 200, EntityDescriptor + signing cert (task 3.2).
    samlMetadataUrl:
      'https://portal.sso.us-east-1.amazonaws.com/saml/metadata/MTU3MDgyMjE4Njg3X2lucy03MjIzZDgyMjY3MWU3ZmU1',
    globalTableReplica: false,
    drRegionStack: false,
    secretsReplica: false,
    s3Crr: false,
    aossStandby: false,
    auroraMinCapacity: 0,
    auroraMaxCapacity: 4,
    cacheMultiAz: false,
    cacheNodeType: 'cache.t4g.micro',
    auditArchiveRetentionDays: 1,
    evidenceRetentionDays: 1,
    evidenceRetentionMode: 'GOVERNANCE',
    alertEmail: 'julio@mbdesignremodel.com',
    // Deployed dev distribution (cdk-outputs.json).
    frontendDomain: 'd1tw2kanxo5wnt.cloudfront.net',
  },
  staging: {
    envName: 'staging',
    account: '889007427685',
    region: 'us-east-1',
    // Populated 2026-07-04 from describe-vpc-endpoint-services intersection
    // in account 889007427685: aoss/bedrock/kms/secretsmanager/execute-api all
    // support b,c (aoss constrains to b,c,d). Evidence: 3.1-az-intersection.log.
    availabilityZones: ['us-east-1b', 'us-east-1c'],
    globalTableReplica: false,
    drRegionStack: false,
    secretsReplica: false,
    s3Crr: false,
    aossStandby: false,
    auroraMinCapacity: 0,
    auroraMaxCapacity: 4,
    cacheMultiAz: false,
    cacheNodeType: 'cache.t4g.micro',
    auditArchiveRetentionDays: 1,
    evidenceRetentionDays: 1,
    evidenceRetentionMode: 'GOVERNANCE',
    alertEmail: 'julio@mbdesignremodel.com',
  },
  prod: {
    envName: 'prod',
    account: '077405654066',
    region: 'us-east-1',
    // Populated 2026-07-04 from describe-vpc-endpoint-services intersection
    // in account 077405654066: aoss/bedrock/kms/secretsmanager/execute-api all
    // support b,c (aoss constrains to b,c,d). Evidence: 3.1-az-intersection.log.
    availabilityZones: ['us-east-1b', 'us-east-1c'],
    globalTableReplica: true,
    drRegionStack: true,
    secretsReplica: true,
    s3Crr: true,
    aossStandby: true,
    auroraMinCapacity: 0.5,
    auroraMaxCapacity: 16,
    cacheMultiAz: true,
    cacheNodeType: 'cache.t4g.medium',
    auditArchiveRetentionDays: 2555,
    evidenceRetentionDays: 2555,
    evidenceRetentionMode: 'COMPLIANCE',
    alertEmail: 'julio@mbdesignremodel.com',
  },
};

export const MGMT_ACCOUNT = '157082218687';
export const PRIMARY_REGION = 'us-east-1';
export const DR_REGION = 'us-west-2';

// -----------------------------------------------------------------------------
// GUARDRAIL — workload/management account boundary (owner policy 2026-07-04)
// The management account (157082218687) hosts ONLY the CDK Pipeline. Every
// application/workload stack MUST deploy to a dedicated env account
// (dev/staging/prod) — NEVER mgmt. The prior (May) project violated this and
// dumped the whole app into mgmt, causing recurring cost + blast-radius pain.
// AWS SCPs cannot restrict the management account (Organizations exempts it),
// so this synth-time assertion is the PRIMARY preventive control: any workload
// env pointed at mgmt (or an account collision) fails synth before deploy.
// -----------------------------------------------------------------------------
export function assertWorkloadAccountBoundary(
  configs: Record<string, EnvConfig> = ENV_CONFIGS,
): void {
  const seen = new Map<string, string>();
  for (const [name, cfg] of Object.entries(configs)) {
    if (cfg.account === MGMT_ACCOUNT) {
      throw new Error(
        `Account boundary violation: env '${name}' targets the management account ` +
          `${MGMT_ACCOUNT}. Workload stacks must deploy to a dedicated account, never ` +
          `mgmt (mgmt hosts only the CDK Pipeline).`,
      );
    }
    const prior = seen.get(cfg.account);
    if (prior) {
      throw new Error(
        `Account collision: '${name}' and '${prior}' both target ${cfg.account}. ` +
          `Each workload env needs its own account.`,
      );
    }
    seen.set(cfg.account, name);
  }
}

// Enforced at module load — importing env-config validates the boundary.
assertWorkloadAccountBoundary();
