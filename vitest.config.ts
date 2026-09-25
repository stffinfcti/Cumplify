import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

/**
 * T-1 (iso-kb-seeding): Vite plugin that resolves bare .md imports as text strings.
 * Same specifier as esbuild's `loader: { '.md': 'text' }` — NO ?raw suffix.
 * At test time this reads the .md file from the repo (hermetic: no live AWS).
 */
function mdAsTextPlugin(): Plugin {
  return {
    name: 'md-as-text',
    transform(code: string, id: string) {
      if (id.endsWith('.md')) {
        const content = readFileSync(resolve(id), 'utf-8');
        return { code: `export default ${JSON.stringify(content)};`, map: null };
      }
      return undefined;
    },
  };
}

export default defineConfig({
  plugins: [mdAsTextPlugin()],
  test: {
    globals: true,
    include: ['services/**/*.test.ts', 'services/**/*.property.test.ts', 'infra/**/*.unit.test.ts', 'scripts/**/*.unit.test.ts'],
    exclude: ['node_modules', 'dist', 'cdk.out', 'infra/readback/**', '**/*.int.test.ts'],
    reporters: ['verbose'],
    testTimeout: 60_000,
    // Coverage floor (TEST-6): measured 2026-09-25 at ~85% lines. Wired via
    // `npm run test:cov`; `npm run test` stays coverage-free for speed.
    coverage: {
      provider: 'v8',
      thresholds: { statements: 83, branches: 68, functions: 84, lines: 84 },
    },
    // HERMETIC UNIT LANE (2026-07-11): unit tests must NEVER reach live AWS.
    // Fake credentials make any unmocked SDK client fail LOUDLY on every
    // machine (a publisher escapee passed for weeks on dev machines with
    // ambient ~/.aws creds and only failed in CodeBuild). Live-AWS tests
    // belong in the *.int.test.ts lane (vitest.int.config.ts).
    env: {
      AWS_ACCESS_KEY_ID: 'AKIA-HERMETIC-UNIT-LANE',
      AWS_SECRET_ACCESS_KEY: 'hermetic-unit-lane-no-real-aws',
      AWS_SESSION_TOKEN: '',
      AWS_PROFILE: '',
      AWS_REGION: 'us-east-1',
      AWS_EC2_METADATA_DISABLED: 'true',
    },
  },
});
