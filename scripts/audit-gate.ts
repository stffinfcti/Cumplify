/**
 * audit-gate — npm audit with an explicit, expiring allowlist.
 *
 * Replaces the raw `npm audit --audit-level=high` Synth gate. The gate stays
 * hard: any high/critical advisory NOT allowlisted fails the build, and an
 * allowlist entry past its expiry fails the build (forcing periodic revisit).
 * Allowlisting exists solely for advisories that dependency management cannot
 * fix — e.g. deps BUNDLED inside another package's tarball (npm overrides and
 * lockfile edits cannot reach those; see aws-cdk-lib bundleDependencies).
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export interface AllowlistEntry {
  advisory: string; // GHSA id
  module: string; // package the advisory is against
  reason: string;
  expires: string; // ISO date; entry is INVALID from this date on
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
}

const GATED = new Set(['high', 'critical']);

export function decide(findings: Finding[], allowlist: AllowlistEntry[], today: Date): Decision {
  const blocked: Finding[] = [];
  const waived: Finding[] = [];
  const expired: AllowlistEntry[] = [];
  for (const f of findings) {
    if (!GATED.has(f.severity)) continue;
    const entry = allowlist.find((a) => a.advisory === f.advisory && a.module === f.module);
    if (!entry) {
      blocked.push(f);
    } else if (today >= new Date(entry.expires)) {
      expired.push(entry);
      blocked.push(f);
    } else {
      waived.push(f);
    }
  }
  return { blocked, waived, expired };
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
  const findings = extractFindings(JSON.parse(raw));
  const { blocked, waived, expired } = decide(findings, allowlist, new Date());

  for (const w of waived) {
    console.log(`WAIVED  ${w.advisory} (${w.module}) — allowlisted, see ${allowlistPath}`);
  }
  for (const x of expired) {
    console.error(`EXPIRED allowlist entry ${x.advisory} (${x.module}) — expired ${x.expires}; revisit or renew with justification`);
  }
  for (const b of blocked) {
    console.error(`BLOCKED ${b.advisory} (${b.module}) [${b.severity}] ${b.title}`);
  }
  if (blocked.length > 0) {
    console.error(`audit-gate: FAIL — ${blocked.length} high/critical advisory(ies) not covered by a valid allowlist entry`);
    process.exit(1);
  }
  console.log(`audit-gate: PASS — ${findings.length} finding(s) inspected, ${waived.length} waived, 0 blocked`);
}

const isDirectRun =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) main();
