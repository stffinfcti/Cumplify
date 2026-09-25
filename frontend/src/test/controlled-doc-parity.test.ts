/**
 * Controlled-doc template PARITY DRIFT TEST (architecture §11 P2; cited by
 * the vendored file's provenance header). The frontend copy at
 * lib/controlled-doc/template.ts must stay byte-equivalent (ignoring
 * comments) to the authority at services/pdf-export/src/template.ts — a
 * drift means the on-screen controlled document no longer matches the
 * sealed PDF export, which is a §7 identification-block violation.
 * Precedent: design-tokens-match.test.ts (file-comparison drift pins).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const VENDORED = resolve(__dirname, '../lib/controlled-doc/template.ts');
const AUTHORITY = resolve(__dirname, '../../../services/pdf-export/src/template.ts');

function normalized(path: string): string {
  return (
    readFileSync(path, 'utf-8')
      .split('\n')
      // strip line comments, block-comment lines, and blank lines — the
      // provenance headers legitimately differ; the CODE may not.
      .filter((l) => {
        const t = l.trim();
        return t !== '' && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .join('\n')
  );
}

describe('controlled-doc template parity (vendored ↔ pdf-export authority)', () => {
  it('code is identical between the vendored copy and the authority', () => {
    expect(normalized(VENDORED)).toBe(normalized(AUTHORITY));
  });

  it('both carry the §7 identification-block essentials', () => {
    for (const path of [VENDORED, AUTHORITY]) {
      const src = readFileSync(path, 'utf-8');
      expect(src).toContain('controlled-stamp');
      expect(src).toMatch(/uncontrolled/i);
      expect(src).toContain('approvedBy');
      expect(src).toContain('versionNo');
      expect(src).toContain('clauseRefs');
    }
  });
});
