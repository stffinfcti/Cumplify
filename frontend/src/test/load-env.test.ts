import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * Test load-env.mjs output — verifies the build-time env loader correctly
 * reads cdk-outputs.json and writes the expected NEXT_PUBLIC_* variables.
 */

describe('load-env.mjs', () => {
  const frontendDir = resolve(__dirname, '../..');
  const envLocalPath = resolve(frontendDir, '.env.local');

  // Strip NEXT_PUBLIC_* from the child env so the early-exit guard does NOT fire.
  // vitest's test.env injects these into process.env (hermetic lane), which would
  // otherwise be inherited by execSync and trigger the guard. (SMOKE-2 A-2)
  function envWithoutNextPublic() {
    const rest = { ...process.env };
    delete rest.NEXT_PUBLIC_GRAPHQL_URL;
    delete rest.NEXT_PUBLIC_USER_POOL_ID;
    delete rest.NEXT_PUBLIC_USER_POOL_CLIENT_ID;
    return rest;
  }

  it('generates .env.local from cdk-outputs.json with correct keys', () => {
    execSync('node scripts/load-env.mjs', { cwd: frontendDir, env: envWithoutNextPublic() });

    const content = readFileSync(envLocalPath, 'utf-8');

    expect(content).toContain('NEXT_PUBLIC_GRAPHQL_URL=');
    expect(content).toContain('NEXT_PUBLIC_USER_POOL_ID=');
    expect(content).toContain('NEXT_PUBLIC_USER_POOL_CLIENT_ID=');

    // Values from cdk-outputs.json
    expect(content).toContain(
      'NEXT_PUBLIC_GRAPHQL_URL=https://42yckio3gbbgphpdkpl7vux3v4.appsync-api.us-east-1.amazonaws.com/graphql',
    );
    expect(content).toContain('NEXT_PUBLIC_USER_POOL_ID=us-east-1_cmiNNOAst');
    expect(content).toContain('NEXT_PUBLIC_USER_POOL_CLIENT_ID=662fm2cthctp150bo5sa7i5o43');
  });

  it('uses PoolBId key (not ExportsOutputRef fallback)', () => {
    execSync('node scripts/load-env.mjs', { cwd: frontendDir, env: envWithoutNextPublic() });
    const content = readFileSync(envLocalPath, 'utf-8');
    // The value should come from PoolBId, which is us-east-1_cmiNNOAst
    expect(content).toContain('NEXT_PUBLIC_USER_POOL_ID=us-east-1_cmiNNOAst');
  });
});

describe('load-env.mjs — early-exit guard (SMOKE-2 §4.3, A-2 REQUIRED)', () => {
  const frontendDir = resolve(__dirname, '../..');
  const envLocalPath = resolve(frontendDir, '.env.local');

  it('exits 0 and does NOT write .env.local when all NEXT_PUBLIC_* vars are set in env', () => {
    // Delete .env.local if it exists (left over from the test above)
    try {
      unlinkSync(envLocalPath);
    } catch {
      // doesn't exist — fine
    }

    // Run with all three vars preset — should early-exit without writing .env.local
    execSync('node scripts/load-env.mjs', {
      cwd: frontendDir,
      env: {
        ...process.env,
        NEXT_PUBLIC_GRAPHQL_URL: 'https://staging.appsync-api.us-east-1.amazonaws.com/graphql',
        NEXT_PUBLIC_USER_POOL_ID: 'us-east-1_STAGING',
        NEXT_PUBLIC_USER_POOL_CLIENT_ID: 'staging-client-id',
      },
    });

    // Assert .env.local was NOT written
    expect(existsSync(envLocalPath)).toBe(false);
  });
});
