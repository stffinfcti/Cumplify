/**
 * Server-side gate for the credit-exemption flags (SERVE-9).
 *
 * `creditExempt` (invoke path) and `systemOp` (embed path) are caller-supplied
 * booleans that bypass the credit pre-check and mark usage as COGS in
 * telemetry. Because the flag arrives inside the request payload it is, by
 * itself, caller-trusted — this module makes it server-enforced: the flag is
 * honored ONLY when the request's `agent` field names a registered internal/
 * system principal. Every other caller's flag is stripped (logged loudly) so
 * the pre-check and tenant invoicing still apply.
 *
 * The registry is intentionally small — today the only system operations that
 * legitimately meter as COGS are the indexers below. New incident-reporting /
 * HITL-approval flows that need the invoke-path exemption MUST register their
 * agent name here; until they do, their creditExempt flag is a no-op.
 *
 * Note: the AR-policy `flag_hitl` decision needs no such gate — it is
 * computed in ar-check.ts from Bedrock ApplyGuardrail findings alone and is
 * never read from the request payload.
 */

import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({ serviceName: 'ai-invoker-exempt' });

/** Internal/system principals allowed to carry a credit-exemption flag. */
const EXEMPT_PRINCIPALS: ReadonlySet<string> = new Set(['iso-kb-seeder', 'TenantDocsIndexer']);

/**
 * Resolve the effective value of a caller-supplied exemption flag.
 * Returns true only when the flag was requested AND the caller is a
 * registered system principal; otherwise the flag is stripped and the
 * attempt is logged.
 */
export function resolveExemptFlag(
  requested: boolean | undefined,
  agent: string,
  flag: 'creditExempt' | 'systemOp',
): boolean {
  if (!requested) return false;
  if (EXEMPT_PRINCIPALS.has(agent)) return true;
  logger.warn(`${flag} flag stripped — caller is not a registered system principal`, {
    agent,
    flag,
  });
  return false;
}
