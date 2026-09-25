import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

/**
 * Frontend unit lane — HERMETIC (fake env, mocked amplify modules).
 * Any unmocked AWS client fails loudly.
 * Wired into root `npm run test` via chained script in root package.json.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['node_modules'],
    setupFiles: ['src/test/setup.ts'],
    reporters: ['verbose'],
    // Coverage floor (TEST-6): measured 2026-09-25 at ~67% lines. Wired via
    // `npm run test:cov`; `npm run test` stays coverage-free for speed.
    coverage: {
      provider: 'v8',
      thresholds: { statements: 62, branches: 51, functions: 53, lines: 65 },
    },
    // HERMETIC: fake env prevents any real AWS calls
    env: {
      NEXT_PUBLIC_GRAPHQL_URL: 'http://localhost:4000/graphql',
      NEXT_PUBLIC_USER_POOL_ID: 'us-east-1_TEST',
      NEXT_PUBLIC_USER_POOL_CLIENT_ID: 'test-client-id',
      AWS_ACCESS_KEY_ID: 'AKIA-HERMETIC-FRONTEND',
      AWS_SECRET_ACCESS_KEY: 'hermetic-frontend-lane',
      AWS_REGION: 'us-east-1',
    },
  },
});
