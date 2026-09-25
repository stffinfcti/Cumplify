#!/usr/bin/env tsx
/**
 * Evidence-gate script — Part 39 Layer 2
 * Runs the ordered verification chain, writes to .kiro/evidence/<spec>/<task>.log
 * Usage: npm run verify -- --spec <name> --task <id> [--module <name>]
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, resolve, join, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SCRIPT_VERSION = '0.1.0';

// --- Argument parsing ---
const { values } = parseArgs({
  options: {
    spec: { type: 'string' },
    task: { type: 'string' },
    module: { type: 'string' },
  },
  strict: false,
});

const specName = (values.spec as string | undefined) ?? 'unknown-spec';
const taskId = (values.task as string | undefined) ?? 'unknown-task';
const moduleName = values.module as string | undefined;

// --- Log setup ---
const evidenceDir = join(ROOT, '.kiro', 'evidence', specName);
mkdirSync(evidenceDir, { recursive: true });
const logPath = join(evidenceDir, `${taskId}.log`);

let logContent = '';
let maxRung = 'D1'; // Will be downgraded if steps are skipped
let hasSkipped = false;
let hasFailed = false;

function timestamp(): string {
  return new Date().toISOString();
}

function log(line: string) {
  logContent += line + '\n';
}

function writeLog() {
  writeFileSync(logPath, logContent, 'utf-8');
}

// --- Git SHA ---
function getGitSha(): string {
  try {
    return execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

function getDirtyCount(): number {
  try {
    const output = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf-8' });
    return output
      .trim()
      .split('\n')
      .filter((l) => l.length > 0).length;
  } catch {
    return -1;
  }
}

// --- Step runner ---
type StepResult = 'PASS' | 'FAIL' | 'SKIPPED';

function runStep(
  stepNum: number,
  name: string,
  command: string | null,
  opts?: { skipReason?: string },
): StepResult {
  const start = timestamp();
  log(`\n=== STEP ${stepNum}: ${name} [START ${start}] ===`);

  if (opts?.skipReason) {
    log(opts.skipReason);
    const end = timestamp();
    log(`=== STEP ${stepNum}: ${name} [SKIPPED ${end}] ===`);
    hasSkipped = true;
    return 'SKIPPED';
  }

  try {
    const output = execSync(command!, {
      cwd: ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 300_000, // 5 min max per step
    });
    log(output);
    const end = timestamp();
    log(`=== STEP ${stepNum}: ${name} [PASS ${end}] ===`);
    return 'PASS';
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string; message?: string };
    if (error.stdout) log(error.stdout);
    if (error.stderr) log(error.stderr);
    if (!error.stdout && !error.stderr && error.message) log(error.message);
    const end = timestamp();
    log(`=== STEP ${stepNum}: ${name} [FAIL ${end}] ===`);
    hasFailed = true;
    return 'FAIL';
  }
}

// --- Service property-test check ---
function hasFilesMatching(root: string, patterns: string[]): boolean {
  // Simple check: do any .test.ts files exist in services/ or infra/ dirs?
  for (const pattern of patterns) {
    const baseDir = pattern.startsWith('services') ? join(root, 'services') : join(root, 'infra');
    if (!existsSync(baseDir)) continue;
    try {
      const output = execSync(`find "${baseDir}" -name "*.test.ts" -type f 2>/dev/null | head -1`, {
        encoding: 'utf-8',
        cwd: root,
      });
      if (output.trim().length > 0) return true;
    } catch {
      continue;
    }
  }
  return false;
}

/** Recursive file walker — the test-discovery checks must reach tests in
 * src/, __tests__/, or any nested layout, not just a service's top level. */
function* walkFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      yield* walkFiles(p);
    } else {
      yield p;
    }
  }
}

const INTEGRATION_TEST_RE = /\.(integration|int)\.test\.ts$/;

function checkPropertyTests(): string | null {
  const servicesDir = join(ROOT, 'services');
  if (!existsSync(servicesDir)) return null;

  const entries = readdirSync(servicesDir);
  for (const entry of entries) {
    if (entry === '_scaffold') continue; // excluded per design §6
    const dir = join(servicesDir, entry);
    if (!statSync(dir).isDirectory()) continue;

    const allFiles = [...walkFiles(dir)].map((f) => basename(f));

    // Check if the subtree has source .ts files
    const sourceFiles = allFiles.filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'index.ts' && f !== 'types.ts',
    );
    if (sourceFiles.length === 0) continue;

    // Check for property tests anywhere under the service
    const propertyTests = allFiles.filter((f) => f.endsWith('.property.test.ts'));
    if (propertyTests.length === 0) {
      return `FAIL: services/${entry}/ has no property-based test (*.property.test.ts). Per 13-testing.md, property-based tests are mandatory on services/*.`;
    }
  }
  return null;
}

// --- Main ---
function main() {
  // Header
  log('=== EVIDENCE LOG ===');
  log(`spec: ${specName}`);
  log(`task: ${taskId}`);
  log(`git-sha: ${getGitSha()}`);
  log(`dirty: ${getDirtyCount()} files`);
  log(`started: ${timestamp()}`);
  log(`script-version: ${SCRIPT_VERSION}`);
  log('=====================================');

  // Step 1: npm ci (unconditional per Part 39 Layer 1)
  const s1 = runStep(1, 'npm ci', 'npm ci');
  if (s1 === 'FAIL') {
    computeResult();
    return;
  }

  // Step 2: tsc --noEmit
  const s2 = runStep(2, 'tsc --noEmit', 'npx tsc --noEmit');
  if (s2 === 'FAIL') {
    computeResult();
    return;
  }

  // Step 3: eslint + prettier + codegen drift (role-matrix single-source check —
  // hand-edits to frontend/src/lib/role-matrix.ts fail here)
  const s3 = runStep(
    3,
    'eslint + prettier + codegen drift',
    'npm run lint && npm run format:check && npm run check:role-matrix',
  );
  if (s3 === 'FAIL') {
    computeResult();
    return;
  }

  // Step 4: unit + property-based tests
  // First: mechanical property-test existence check
  const propCheckFail = checkPropertyTests();
  if (propCheckFail) {
    const start = timestamp();
    log(`\n=== STEP 4: unit + property tests [START ${start}] ===`);
    log(propCheckFail);
    log(`=== STEP 4: unit + property tests [FAIL ${timestamp()}] ===`);
    hasFailed = true;
    computeResult();
    return;
  }

  // Check if any test files exist before invoking vitest
  const hasTestFiles = hasFilesMatching(ROOT, [
    'services/**/*.test.ts',
    'services/**/*.property.test.ts',
    'infra/**/*.test.ts',
  ]);

  if (!hasTestFiles) {
    runStep(4, 'unit + property tests', null, {
      skipReason: 'No test files found (no services/* or infra/* test code yet). Skipping.',
    });
  } else {
    const s4 = runStep(4, 'unit + property tests', 'npx vitest run --reporter=verbose');
    if (s4 === 'FAIL') {
      computeResult();
      return;
    }
  }

  // Step 5: cdk synth + CDK Nag
  const cdkEntry = join(ROOT, 'infra', 'bin');
  const hasCdkApp = existsSync(cdkEntry) && readdirSync(cdkEntry).some((f) => f.endsWith('.ts'));
  if (!hasCdkApp) {
    runStep(5, 'cdk synth + CDK Nag', null, {
      skipReason: 'No CDK entrypoint found in infra/bin/ — skipping synth.',
    });
  } else {
    const s5 = runStep(5, 'cdk synth + CDK Nag', 'npx cdk synth --all');
    if (s5 === 'FAIL') {
      computeResult();
      return;
    }
  }

  // Step 6: targeted integration tests
  if (!moduleName) {
    runStep(6, 'integration tests (module: none specified)', null, {
      skipReason:
        'No --module specified (intentional for cross-cutting/infra-only tasks). Skipping integration tests.',
    });
  } else {
    const moduleTestDir = join(ROOT, 'services', moduleName);
    const hasIntegTests =
      existsSync(moduleTestDir) &&
      [...walkFiles(moduleTestDir)].some((f) => INTEGRATION_TEST_RE.test(f));
    if (!hasIntegTests) {
      runStep(6, `integration tests (module: ${moduleName})`, null, {
        skipReason: `No integration tests defined for module ${moduleName}.`,
      });
    } else {
      // Both suffixes exist in the tree — run them together.
      const s6 = runStep(
        6,
        `integration tests (module: ${moduleName})`,
        `npx vitest run "services/${moduleName}/**/*.integration.test.ts" "services/${moduleName}/**/*.int.test.ts" --reporter=verbose`,
      );
      if (s6 === 'FAIL') {
        computeResult();
        return;
      }
    }
  }

  computeResult();
}

function computeResult() {
  const steps = logContent.match(/\[(?:PASS|FAIL|SKIPPED)/g) || [];
  const passCount = steps.filter((s) => s === '[PASS').length;
  const skipCount = steps.filter((s) => s === '[SKIPPED').length;
  const failCount = steps.filter((s) => s === '[FAIL').length;

  if (hasFailed) {
    maxRung = 'NONE';
  } else if (hasSkipped) {
    // Step 5 or 6 skipped → max D1 (steps 1-4 green but synth/integration not proven)
    maxRung = 'D1';
  } else {
    // All steps pass → eligible for D2 (tested); D3+ requires readback appended separately
    maxRung = 'D2';
  }

  const statusSummary = hasFailed
    ? `FAIL (${failCount} failed)`
    : `PASS (${passCount} green${skipCount > 0 ? `, ${skipCount} skipped` : ''})`;

  log(`\n=== RESULT: ${statusSummary} | MAX-RUNG: ${maxRung} ===`);
  log(`=== ENDED: ${timestamp()} ===`);
  writeLog();

  if (hasFailed) {
    console.error(`EVIDENCE GATE FAILED — see ${logPath}`);
    process.exit(1);
  } else {
    console.log(`EVIDENCE GATE PASSED (MAX-RUNG: ${maxRung}) — log at ${logPath}`);
    process.exit(0);
  }
}

main();
