/**
 * audit-gate — npm audit with an explicit, expiring allowlist.
 *
 * Replaces the raw `npm audit --audit-level=high` Synth gate. The gate stays
 * hard: any high/critical advisory NOT allowlisted fails the build, an
 * allowlist entry past its expiry fails the build (forcing periodic revisit),
 * and an entry with a missing/unparseable `expires` fails the build outright
 * — `expires` is REQUIRED, not advisory. (Pre-hardening, a missing expiry
 * produced `new Date(undefined)` → NaN → the entry waived the advisory
 * forever.) Allowlisting exists solely for advisories that dependency
 * management cannot fix — e.g. deps BUNDLED inside another package's tarball
 * (npm overrides and lockfile edits cannot reach those; see aws-cdk-lib
 * bundleDependencies).
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export interface AllowlistEntry {
  advisory: string; // GHSA id
  module: string; // package the advisory is against
  reason: string;
  expires: string; // REQUIRED ISO date; entry is INVALID from this date on
}

export interface Finding {
  module: string;
  advisory: string;
  severity: string;
  title: string;
}

export interface Decision {
  blocked: Finding[];
  waived: Finding[];
  expired: AllowlistEntry[];
  /** Entries whose `expires` is missing, empty, or unparseable — they can never waive. */
  invalid: AllowlistEntry[];
}

const GATED = new Set(['high', 'critical']);

/** True when `expires` is a non-empty string that parses to a real date. */
export function hasValidExpiry(entry: AllowlistEntry): boolean {
  const raw = (entry as { expires?: unknown }).expires;
  return typeof raw === 'string' && raw.trim() !== '' && !Number.isNaN(Date.parse(raw));
}

export function decide(findings: Finding[], allowlist: AllowlistEntry[], today: Date): Decision {
  const blocked: Finding[] = [];
  const waived: Finding[] = [];
  const expired: AllowlistEntry[] = [];
  const invalid: AllowlistEntry[] = [];
  // Expiry is enforced on EVERY entry — matched or not — so a stale or
  // malformed entry can never sit in the file silently (REQUIRED, not advisory).
  for (const e of allowlist) {
    if (!hasValidExpiry(e)) {
      invalid.push(e);
    } else if (today >= new Date(e.expires)) {
      expired.push(e);
    }
  }
  for (const f of findings) {
    if (!GATED.has(f.severity)) continue;
    const entry = allowlist.find((a) => a.advisory === f.advisory && a.module === f.module);
    // An entry only waives when it exists AND carries a valid future expiry.
    if (!entry || !hasValidExpiry(entry) || today >= new Date(entry.expires)) {
      blocked.push(f);
    } else {
      waived.push(f);
    }
  }
  return { blocked, waived, expired, invalid };
}

/** Extract direct advisories (via-objects) from `npm audit --json` output. */
export function extractFindings(auditJson: {
  vulnerabilities?: Record<string, { via?: Array<string | Record<string, unknown>> }>;
}): Finding[] {
  const findings: Finding[] = [];
  for (const [module, vuln] of Object.entries(auditJson.vulnerabilities ?? {})) {
    for (const via of vuln.via ?? []) {
      // String entries are transitive pointers to another module's advisory —
      // gated where the advisory itself is reported, not here.
      if (typeof via === 'string') continue;
      const url = String(via.url ?? '');
      const ghsa = url.match(/GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/)?.[0] ?? url;
      findings.push({
        module,
        advisory: ghsa,
        severity: String(via.severity ?? 'unknown'),
        title: String(via.title ?? ''),
      });
    }
  }
  return findings;
}

function main(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Optional package dir (e.g. `frontend`): audits that package's lockfile and
  // reads its own audit-allowlist.json. Default = repo root.
  const dirArg = process.argv[2];
  const auditDir = dirArg ? path.resolve(here, '..', dirArg) : path.resolve(here, '..');
  const allowlistPath = dirArg
    ? path.join(auditDir, 'audit-allowlist.json')
    : path.join(here, 'audit-allowlist.json');
  const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8')) as AllowlistEntry[];

  // npm audit exits non-zero when vulnerabilities exist — capture stdout anyway.
  let raw: string;
  try {
    raw = execSync('npm audit --json', {
      cwd: auditDir,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    raw = (e as { stdout?: string }).stdout ?? '';
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  // npm audit infra failures (ENOAUDIT, registry down) print an `{"error":…}`
  // object — treating it as zero findings would silently PASS a broken gate.
  if (parsed.error || parsed.vulnerabilities === undefined) {
    console.error(`audit-gate: npm audit returned an error object: ${raw.slice(0, 400)}`);
    process.exit(2);
  }
  const findings = extractFindings(parsed);
  const { blocked, waived, expired, invalid } = decide(findings, allowlist, new Date());

  for (const w of waived) {
    console.log(`WAIVED  ${w.advisory} (${w.module}) — allowlisted, see ${allowlistPath}`);
  }
  for (const x of invalid) {
    console.error(
      `INVALID allowlist entry ${x.advisory} (${x.module}) — missing or unparseable \`expires\`; ` +
        `every allowlist entry REQUIRES a valid ISO expiry date (see ${allowlistPath})`,
    );
  }
  for (const x of expired) {
    console.error(
      `EXPIRED allowlist entry ${x.advisory} (${x.module}) — expired ${x.expires}; revisit or renew with justification`,
    );
  }
  for (const b of blocked) {
    console.error(`BLOCKED ${b.advisory} (${b.module}) [${b.severity}] ${b.title}`);
  }
  if (blocked.length > 0 || invalid.length > 0 || expired.length > 0) {
    console.error(
      `audit-gate: FAIL — ${blocked.length} high/critical advisory(ies) not covered by a valid ` +
        `allowlist entry; ${invalid.length} invalid + ${expired.length} expired allowlist entr(ies)`,
    );
    process.exit(1);
  }
  console.log(
    `audit-gate: PASS — ${findings.length} finding(s) inspected, ${waived.length} waived, 0 blocked`,
  );
}

const isDirectRun =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) main();
