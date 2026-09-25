/**
 * assert-legal-signoff — Prod hard gate (LegalSignoffGuard).
 *
 * Blocks the Prod deploy stage unless an attorney sign-off record has been
 * committed to the repo. The record is `legal-signoff/prod-approval.json` —
 * counsel (or the owner on counsel's written instruction) commits it when the
 * release's legal review is complete. Absent or malformed records fail the
 * build, which is the gate working as designed, not an error to bypass.
 *
 * Expected shape:
 * {
 *   "approvedBy": "counsel name or firm",
 *   "approvedAt": "YYYY-MM-DD",
 *   "scope":     "what was reviewed (e.g. 'GA terms, privacy policy v1.2')",
 *   "notes":     "optional — reference to the sign-off artifact"
 * }
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export interface SignoffRecord {
  approvedBy: string;
  approvedAt: string;
  scope: string;
  notes?: string;
}

export function validate(record: unknown): string[] {
  const errors: string[] = [];
  if (typeof record !== 'object' || record === null) {
    return ['record is not a JSON object'];
  }
  const r = record as Partial<SignoffRecord>;
  if (typeof r.approvedBy !== 'string' || r.approvedBy.trim() === '') {
    errors.push('missing or empty "approvedBy"');
  }
  if (typeof r.approvedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.approvedAt)) {
    errors.push('missing or malformed "approvedAt" (expected YYYY-MM-DD)');
  }
  if (typeof r.scope !== 'string' || r.scope.trim() === '') {
    errors.push('missing or empty "scope"');
  }
  return errors;
}

function main(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const manifestPath = path.join(here, '..', 'legal-signoff', 'prod-approval.json');

  if (!existsSync(manifestPath)) {
    console.error(
      `LegalSignoffGuard: FAIL — no attorney sign-off record at ${manifestPath}\n` +
        'Commit a record with { approvedBy, approvedAt, scope, notes? } once legal review is complete.',
    );
    process.exit(1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    console.error(
      `LegalSignoffGuard: FAIL — ${manifestPath} is not valid JSON: ${(e as Error).message}`,
    );
    process.exit(1);
  }

  const errors = validate(parsed);
  if (errors.length > 0) {
    console.error(`LegalSignoffGuard: FAIL — sign-off record invalid:\n  ${errors.join('\n  ')}`);
    process.exit(1);
  }

  const r = parsed as SignoffRecord;
  console.log(
    `LegalSignoffGuard: PASS — sign-off by ${r.approvedBy} on ${r.approvedAt} (scope: ${r.scope})`,
  );
}

const isDirectRun =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) main();
