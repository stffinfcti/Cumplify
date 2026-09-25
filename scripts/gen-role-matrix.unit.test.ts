import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { extractMatrix, render, emitFormatted } from './gen-role-matrix.js';

const SERVICES_SOURCE = readFileSync(
  resolve(__dirname, '../services/api/src/permissions/role-matrix.ts'),
  'utf-8',
);
const FRONTEND_FILE = readFileSync(
  resolve(__dirname, '../frontend/src/lib/role-matrix.ts'),
  'utf-8',
);

const MINI_SOURCE = `
const COGNITO_GROUP_ROLES: Record<string, string> = {
  TopManagement: 'top-management',
  IMSLead: 'management-rep',
};

const ROLE_WRITE_MODULES: Record<string, ReadonlySet<string>> = {
  // Role 1 comment
  'top-management': new Set(['M1']),
  'management-rep': new Set(['M1', 'M2']),
  nobody: new Set([]),
};
`;

describe('gen-role-matrix extractMatrix()', () => {
  it('extracts the Cognito group alias map in order', () => {
    const m = extractMatrix(MINI_SOURCE);
    expect(m.roleMap).toEqual([
      ['TopManagement', 'top-management'],
      ['IMSLead', 'management-rep'],
    ]);
  });

  it('extracts module sets preserving order, empties, and comments', () => {
    const m = extractMatrix(MINI_SOURCE);
    expect(m.roleEntries).toEqual([
      { role: 'top-management', modules: ['M1'], comments: ['Role 1 comment'] },
      { role: 'management-rep', modules: ['M1', 'M2'], comments: [] },
      { role: 'nobody', modules: [], comments: [] },
    ]);
  });

  it('extracts the live services source (12 roles + 12 group aliases)', () => {
    const m = extractMatrix(SERVICES_SOURCE, 'services/api/src/permissions/role-matrix.ts');
    expect(m.roleEntries).toHaveLength(12);
    expect(m.roleMap).toHaveLength(12);
    expect(m.roleMap).toContainEqual(['IMSLead', 'management-rep']);
    const mgmt = m.roleEntries.find((r) => r.role === 'management-rep');
    expect(mgmt?.modules).toHaveLength(13);
  });

  it('rejects non-literal initializers (fails loud, never guesses)', () => {
    const bad = `
      const MODULES = { m: 'M1' };
      const ROLE_WRITE_MODULES: Record<string, ReadonlySet<string>> = { x: new Set(MODULES.m) };
      const COGNITO_GROUP_ROLES = {};
    `;
    expect(() => extractMatrix(bad)).toThrow();
  });
});

describe('gen-role-matrix render()', () => {
  it('emits the shared maps plus frontend-only exports', () => {
    const out = render(extractMatrix(MINI_SOURCE));
    expect(out).toContain(`TopManagement: 'top-management'`);
    expect(out).toContain(`'top-management': new Set(['M1'])`);
    expect(out).toContain(`nobody: new Set([])`);
    expect(out).toContain('export function canSeeAdmin');
    expect(out).toContain('export function roleLabel');
    expect(out).toContain('export const KNOWN_ROLES');
  });

  it('carries the generated-file marker + source-of-truth pointer', () => {
    const out = render(extractMatrix(MINI_SOURCE));
    expect(out).toContain('GENERATED FILE. DO NOT EDIT BY HAND');
    expect(out).toContain('services/api/src/permissions/role-matrix.ts');
  });
});

describe('gen-role-matrix drift check', () => {
  it('the checked-in frontend file matches generation output (no drift)', async () => {
    const emitted = await emitFormatted(SERVICES_SOURCE);
    expect(emitted).toBe(FRONTEND_FILE);
  });

  it('drift is detected: edited source changes the emitted file', async () => {
    const tampered = SERVICES_SOURCE.replace(
      `'top-management': new Set(['M1'])`,
      `'top-management': new Set(['M1', 'M2'])`,
    );
    const emitted = await emitFormatted(tampered);
    expect(emitted).not.toBe(FRONTEND_FILE);
  });
});
