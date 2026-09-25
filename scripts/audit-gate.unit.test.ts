import { describe, expect, it } from 'vitest';
import { decide, extractFindings, type AllowlistEntry, type Finding } from './audit-gate.js';

const BRACE: Finding = {
  module: 'brace-expansion',
  advisory: 'GHSA-3jxr-9vmj-r5cp',
  severity: 'high',
  title: 'DoS via exponential-time expansion',
};
const ALLOW: AllowlistEntry = {
  advisory: 'GHSA-3jxr-9vmj-r5cp',
  module: 'brace-expansion',
  reason: 'bundled in aws-cdk-lib tarball',
  expires: '2026-08-21',
};
const BEFORE_EXPIRY = new Date('2026-07-21T12:00:00Z');
const AFTER_EXPIRY = new Date('2026-08-21T00:00:00Z');

describe('audit-gate decide()', () => {
  it('blocks a high advisory with no allowlist entry', () => {
    const d = decide([BRACE], [], BEFORE_EXPIRY);
    expect(d.blocked).toHaveLength(1);
    expect(d.waived).toHaveLength(0);
  });

  it('waives an allowlisted advisory before expiry', () => {
    const d = decide([BRACE], [ALLOW], BEFORE_EXPIRY);
    expect(d.blocked).toHaveLength(0);
    expect(d.waived).toHaveLength(1);
  });

  it('blocks again once the allowlist entry expires (expiry day inclusive)', () => {
    const d = decide([BRACE], [ALLOW], AFTER_EXPIRY);
    expect(d.blocked).toHaveLength(1);
    expect(d.expired).toHaveLength(1);
  });

  it('expires is REQUIRED: missing expiry is invalid and cannot waive', () => {
    const noExpiry = { ...ALLOW } as unknown as AllowlistEntry;
    delete (noExpiry as { expires?: string }).expires;
    const d = decide([BRACE], [noExpiry], BEFORE_EXPIRY);
    expect(d.blocked).toHaveLength(1);
    expect(d.waived).toHaveLength(0);
    expect(d.invalid).toHaveLength(1);
  });

  it('expires is REQUIRED: empty string is invalid and cannot waive', () => {
    const d = decide([BRACE], [{ ...ALLOW, expires: '' }], BEFORE_EXPIRY);
    expect(d.blocked).toHaveLength(1);
    expect(d.invalid).toHaveLength(1);
  });

  it('expires is REQUIRED: unparseable date is invalid and cannot waive', () => {
    const d = decide([BRACE], [{ ...ALLOW, expires: 'not-a-date' }], BEFORE_EXPIRY);
    expect(d.blocked).toHaveLength(1);
    expect(d.invalid).toHaveLength(1);
  });

  it('flags expired/missing-expiry entries even with no matching finding (enforced globally)', () => {
    const stale = [{ ...ALLOW }, { ...ALLOW, advisory: 'GHSA-xxxx-xxxx-xxxx', expires: '' }];
    const d = decide([], stale, AFTER_EXPIRY);
    expect(d.blocked).toHaveLength(0);
    expect(d.expired).toHaveLength(1);
    expect(d.invalid).toHaveLength(1);
  });

  it('a valid unmatched entry is inert (no findings → no flags)', () => {
    const d = decide([], [ALLOW], BEFORE_EXPIRY);
    expect(d.blocked).toHaveLength(0);
    expect(d.expired).toHaveLength(0);
    expect(d.invalid).toHaveLength(0);
  });

  it('entry must match BOTH advisory and module', () => {
    const wrongModule = { ...ALLOW, module: 'minimatch' };
    const d = decide([BRACE], [wrongModule], BEFORE_EXPIRY);
    expect(d.blocked).toHaveLength(1);
  });

  it('ignores advisories below high', () => {
    const moderate = { ...BRACE, severity: 'moderate', advisory: 'GHSA-mmmm-mmmm-mmmm' };
    const d = decide([moderate], [], BEFORE_EXPIRY);
    expect(d.blocked).toHaveLength(0);
  });
});

describe('audit-gate extractFindings()', () => {
  it('extracts via-objects and skips transitive string pointers', () => {
    const findings = extractFindings({
      vulnerabilities: {
        'brace-expansion': {
          via: [
            {
              url: 'https://github.com/advisories/GHSA-3jxr-9vmj-r5cp',
              severity: 'high',
              title: 'DoS',
            },
          ],
        },
        minimatch: { via: ['brace-expansion'] },
        'aws-cdk-lib': { via: ['minimatch'] },
      },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      module: 'brace-expansion',
      advisory: 'GHSA-3jxr-9vmj-r5cp',
      severity: 'high',
    });
  });

  it('returns empty on a clean audit', () => {
    expect(extractFindings({ vulnerabilities: {} })).toHaveLength(0);
    expect(extractFindings({})).toHaveLength(0);
  });
});
