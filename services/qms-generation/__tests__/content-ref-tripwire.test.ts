/**
 * content_ref tripwire — BC-8 (spec-40 Task 6).
 *
 * `m1.document_versions.content_ref` must be REAL everywhere. Exactly ONE
 * writer is exempted (the agent HITL writeback — no content plane yet) and
 * that exemption must stay explicitly documented with a TRACKED-TODO marker.
 * A new writer that defaults content_ref to '' fails this suite.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../..');

// Filesystem walk instead of `git grep`: the CodeBuild source artifact carries
// no .git directory (CodePipeline zip export), so git-based discovery aborts
// with status 128 there. Walking the tree keeps BC-8 enforced in EVERY lane.
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'cdk.out',
  'dist',
  'build',
  'coverage',
  '.next',
]);

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...walkTsFiles(join(dir, entry.name)));
    } else if (entry.name.endsWith('.ts')) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

function trackedFiles(pattern: string): string[] {
  return walkTsFiles(REPO_ROOT)
    .filter((f) => readFileSync(f, 'utf8').includes(pattern))
    .map((f) => relative(REPO_ROOT, f).split('\\').join('/'))
    .filter((f) => !f.includes('.test.'));
}

describe('content_ref tripwire (BC-8)', () => {
  it('every INSERT into m1.document_versions binds a contentRef that cannot silently be empty — except the ONE documented exemption', () => {
    const writers = trackedFiles('INSERT INTO m1.document_versions');
    expect(writers.length).toBeGreaterThan(0);

    for (const file of writers) {
      const src = readFileSync(resolve(REPO_ROOT, file), 'utf8');
      const emptyDefault = /contentRef[^\n]*\?\?\s*''/.test(src) || /content_ref[^\n]*''/.test(src);
      if (!emptyDefault) continue;

      const rel = relative(REPO_ROOT, resolve(REPO_ROOT, file));
      expect(rel, `undocumented empty-content_ref writer: ${rel}`).toBe(
        'services/agents/shared/execute-writeback.ts',
      );
      expect(src, 'the exemption must carry its TRACKED-TODO marker').toContain(
        'TRACKED-TODO(content-ref-tripwire)',
      );
    }
  });

  it('the spec-40 finalize writer sets BOTH content_ref and content_sha256', () => {
    const src = readFileSync(
      resolve(REPO_ROOT, 'services/qms-generation/src/finalize-manual.ts'),
      'utf8',
    );
    expect(src).toContain('content_ref, content_sha256');
    expect(src).not.toMatch(/contentRef[^\n]*\?\?\s*''/);
  });
});
