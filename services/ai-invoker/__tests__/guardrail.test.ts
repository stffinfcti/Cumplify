/**
 * Unit tests for guardrail.ts — spec-35 Task 8.
 * Verifies 5-guardrail routing: doc-composer→DOCGEN, record-write→RECORDWRITE,
 * other→GUARDRAIL, AR guardrails (ARCLAUSE/ARADVISORY) accessed separately.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('buildGuardrailConfig (5-guardrail routing)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      GUARDRAIL_ID: 'agent-guardrail-id',
      GUARDRAIL_VERSION: '3',
      DOCGEN_GUARDRAIL_ID: 'docgen-guardrail-id',
      DOCGEN_GUARDRAIL_VERSION: '2',
      RECORDWRITE_GUARDRAIL_ID: 'recordwrite-guardrail-id',
      RECORDWRITE_GUARDRAIL_VERSION: '1',
      ARCLAUSE_GUARDRAIL_ID: 'arclause-guardrail-id',
      ARCLAUSE_GUARDRAIL_VERSION: '1',
      ARADVISORY_GUARDRAIL_ID: 'aradvisory-guardrail-id',
      ARADVISORY_GUARDRAIL_VERSION: '1',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('routes doc-composer seat to DOCGEN guardrail', async () => {
    const { buildGuardrailConfig } = await import('../src/guardrail.js');
    const config = buildGuardrailConfig('doc-composer', 'record-write');
    // doc-composer takes priority even with record-write feature
    expect(config).toEqual({
      guardrailIdentifier: 'docgen-guardrail-id',
      guardrailVersion: '2',
    });
  });

  it('routes record-write feature to RECORDWRITE guardrail', async () => {
    const { buildGuardrailConfig } = await import('../src/guardrail.js');
    const config = buildGuardrailConfig('workhorse', 'record-write');
    expect(config).toEqual({
      guardrailIdentifier: 'recordwrite-guardrail-id',
      guardrailVersion: '1',
    });
  });

  it.each(['doc-draft', 'manual-section-draft'])(
    'routes %s feature to DOCGEN guardrail (S2.1/S3: no PII anonymization of the tenant draft)',
    async (feature) => {
      const { buildGuardrailConfig } = await import('../src/guardrail.js');
      const config = buildGuardrailConfig('workhorse', feature);
      expect(config).toEqual({
        guardrailIdentifier: 'docgen-guardrail-id',
        guardrailVersion: '2',
      });
    },
  );

  it('routes advisory seats to GUARDRAIL (agent guardrail)', async () => {
    const { buildGuardrailConfig } = await import('../src/guardrail.js');
    const config = buildGuardrailConfig('guru-9001', 'advisory');
    expect(config).toEqual({
      guardrailIdentifier: 'agent-guardrail-id',
      guardrailVersion: '3',
    });
  });

  it('routes seats without feature to GUARDRAIL', async () => {
    const { buildGuardrailConfig } = await import('../src/guardrail.js');
    const config = buildGuardrailConfig('lightweight');
    expect(config).toEqual({
      guardrailIdentifier: 'agent-guardrail-id',
      guardrailVersion: '3',
    });
  });

  it('returns undefined when env vars missing (unconfigured env)', async () => {
    delete process.env.GUARDRAIL_ID;
    const { buildGuardrailConfig } = await import('../src/guardrail.js');
    const config = buildGuardrailConfig('workhorse', 'advisory');
    expect(config).toBeUndefined();
  });
});

describe('AR guardrail configs (separate from inline routing)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      ARCLAUSE_GUARDRAIL_ID: 'arclause-id',
      ARCLAUSE_GUARDRAIL_VERSION: '2',
      ARADVISORY_GUARDRAIL_ID: 'aradvisory-id',
      ARADVISORY_GUARDRAIL_VERSION: '3',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('buildArClauseGuardrailConfig returns ARCLAUSE config', async () => {
    const { buildArClauseGuardrailConfig } = await import('../src/guardrail.js');
    expect(buildArClauseGuardrailConfig()).toEqual({
      guardrailIdentifier: 'arclause-id',
      guardrailVersion: '2',
    });
  });

  it('buildArAdvisoryGuardrailConfig returns ARADVISORY config', async () => {
    const { buildArAdvisoryGuardrailConfig } = await import('../src/guardrail.js');
    expect(buildArAdvisoryGuardrailConfig()).toEqual({
      guardrailIdentifier: 'aradvisory-id',
      guardrailVersion: '3',
    });
  });

  it('AR configs return undefined when not deployed yet', async () => {
    delete process.env.ARCLAUSE_GUARDRAIL_ID;
    delete process.env.ARADVISORY_GUARDRAIL_ID;
    const { buildArClauseGuardrailConfig, buildArAdvisoryGuardrailConfig } =
      await import('../src/guardrail.js');
    expect(buildArClauseGuardrailConfig()).toBeUndefined();
    expect(buildArAdvisoryGuardrailConfig()).toBeUndefined();
  });
});
