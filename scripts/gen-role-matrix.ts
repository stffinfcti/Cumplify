/**
 * gen-role-matrix — single-source codegen for the Part 13 role/permission matrix.
 *
 * The matrix lived in two places that drifted independently:
 *   - services/api/src/permissions/role-matrix.ts  (AUTHORITATIVE — the file
 *     declares itself the "versioned shared module" the frontend "mirrors")
 *   - frontend/src/lib/role-matrix.ts              (generated — presentation-only)
 *
 * This script parses the services source with the TypeScript AST (no regex
 * scraping of literals), extracts COGNITO_GROUP_ROLES + ROLE_WRITE_MODULES
 * (preserving declaration order and per-role comments), and emits the complete
 * frontend module — including its frontend-only exports (ADMIN_ROLES,
 * canSeeAdmin, roleLabel) — formatted with the repo's prettier config.
 *
 *   tsx scripts/gen-role-matrix.ts          # write frontend/src/lib/role-matrix.ts
 *   tsx scripts/gen-role-matrix.ts --check  # drift check: exit 1 when out of date
 *
 * `npm run check:role-matrix` is wired into scripts/verify.ts step 3, so a
 * hand-edit on either side fails the evidence gate.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { format, resolveConfig } from 'prettier';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SOURCE = resolve(ROOT, 'services/api/src/permissions/role-matrix.ts');
const TARGET = resolve(ROOT, 'frontend/src/lib/role-matrix.ts');

export interface RoleEntry {
  role: string;
  modules: string[];
  /** Leading `//` comments preserved verbatim from the source declaration. */
  comments: string[];
}

export interface RoleMatrix {
  /** COGNITO_GROUP_ROLES entries, in declaration order. */
  roleMap: [string, string][];
  /** ROLE_WRITE_MODULES entries, in declaration order. */
  roleEntries: RoleEntry[];
}

/** Get the ObjectLiteralExpression for a top-level `const NAME = { ... }`. */
function findObjectLiteral(sourceFile: ts.SourceFile, name: string): ts.ObjectLiteralExpression {
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === name && decl.initializer) {
        if (ts.isObjectLiteralExpression(decl.initializer)) return decl.initializer;
        throw new Error(`${name}: expected an object literal initializer`);
      }
    }
  }
  throw new Error(`${name}: declaration not found`);
}

function propName(node: ts.PropertyName): string {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  throw new Error(`unsupported property name kind: ${ts.SyntaxKind[node.kind]}`);
}

/** Leading `//` comment lines attached to a node (blank lines dropped). */
function leadingComments(sourceText: string, node: ts.Node): string[] {
  const ranges = ts.getLeadingCommentRanges(sourceText, node.getFullStart()) ?? [];
  return ranges
    .map((r) => sourceText.slice(r.pos, r.end).trim())
    .filter((c) => c.startsWith('//'))
    .map((c) => c.replace(/^\/\/\s?/, '').trim())
    .filter((c) => c.length > 0);
}

/** Evaluate `key: 'value'` string-map entries from an object literal. */
function evalStringMap(_sourceText: string, lit: ts.ObjectLiteralExpression): [string, string][] {
  return lit.properties.map((p) => {
    if (!ts.isPropertyAssignment(p)) {
      throw new Error(`expected PropertyAssignment, got ${ts.SyntaxKind[p.kind]}`);
    }
    if (!ts.isStringLiteral(p.initializer)) {
      throw new Error(`${propName(p.name)}: expected a string literal initializer`);
    }
    return [propName(p.name), p.initializer.text];
  });
}

/** Evaluate `key: new Set(['a', 'b'])` entries from an object literal. */
function evalModuleSets(sourceText: string, lit: ts.ObjectLiteralExpression): RoleEntry[] {
  return lit.properties.map((p) => {
    if (!ts.isPropertyAssignment(p)) {
      throw new Error(`expected PropertyAssignment, got ${ts.SyntaxKind[p.kind]}`);
    }
    const init = p.initializer;
    if (!ts.isNewExpression(init)) {
      throw new Error(`${propName(p.name)}: expected \`new Set([...])\``);
    }
    const arg = init.arguments?.[0];
    let modules: string[] = [];
    if (arg !== undefined) {
      if (!ts.isArrayLiteralExpression(arg)) {
        throw new Error(`${propName(p.name)}: Set initializer must be an array literal`);
      }
      modules = arg.elements.map((el) => {
        if (!ts.isStringLiteral(el)) {
          throw new Error(`${propName(p.name)}: Set member must be a string literal`);
        }
        return el.text;
      });
    }
    return {
      role: propName(p.name),
      modules,
      comments: leadingComments(sourceText, p),
    };
  });
}

/** Parse the services-side role-matrix.ts into the two shared maps. */
export function extractMatrix(sourceText: string, sourceName = 'role-matrix.ts'): RoleMatrix {
  const sourceFile = ts.createSourceFile(sourceName, sourceText, ts.ScriptTarget.ESNext, true);
  return {
    roleMap: evalStringMap(sourceText, findObjectLiteral(sourceFile, 'COGNITO_GROUP_ROLES')),
    roleEntries: evalModuleSets(sourceText, findObjectLiteral(sourceFile, 'ROLE_WRITE_MODULES')),
  };
}

function quoteKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : `'${key}'`;
}

function renderSet(modules: string[]): string {
  if (modules.length === 0) return 'new Set([])';
  const items = modules.map((m) => `'${m}'`).join(', ');
  return `new Set([${items}])`;
}

/** Render the complete frontend module (prettier formatting applied by the caller). */
export function render(matrix: RoleMatrix): string {
  const groupLines = matrix.roleMap.map(([k, v]) => `  ${quoteKey(k)}: '${v}',`).join('\n');
  const roleLines = matrix.roleEntries
    .map((r) => {
      const comments = r.comments.map((c) => `  // ${c}`).join('\n');
      const line = `  ${quoteKey(r.role)}: ${renderSet(r.modules)},`;
      return comments ? `${comments}\n${line}` : line;
    })
    .join('\n');
  return `/**
 * Frontend role-matrix — GENERATED FILE. DO NOT EDIT BY HAND.
 * Single source of truth: services/api/src/permissions/role-matrix.ts
 * (the "versioned shared module" this file mirrors).
 *
 * Regenerate:  npm run gen:role-matrix
 * Drift check: npm run check:role-matrix   (wired into scripts/verify.ts)
 *
 * CON-6: presentation-only gating (server always enforces).
 * Uses the normalizeRole alias map for Cognito PascalCase groups (BUG-11a).
 */

/** Cognito PascalCase group → kebab-case slug (BUG-11a) */
const COGNITO_GROUP_ROLES: Record<string, string> = {
${groupLines}
};

/** Map a raw custom:role claim to a matrix key. */
export function normalizeRole(role: string): string {
  return COGNITO_GROUP_ROLES[role] ?? role;
}

/** Part 13 permission map — modules where each role has write (approval) permission. */
const ROLE_WRITE_MODULES: Record<string, ReadonlySet<string>> = {
${roleLines}
};

/** Roles that can see /settings (Pool B admin-tier roles). */
const ADMIN_ROLES = new Set([
  'top-management',
  'management-rep',
  'quality-manager',
  'ehs-manager',
  'document-controller',
]);

/** Can this role see the admin/settings nav section? */
export function canSeeAdmin(role: string): boolean {
  return ADMIN_ROLES.has(normalizeRole(role));
}

/**
 * Per-module approval check — mirrors backend canApprove(role, module).
 * Returns true if the role has write access to the given module.
 * Unknown roles default to false (deny).
 */
export function canApprove(role: string, module: string): boolean {
  const modules = ROLE_WRITE_MODULES[normalizeRole(role)];
  if (!modules) return false;
  return modules.has(module);
}

/** Human-readable label for the role claim. */
export function roleLabel(role: string): string {
  const slug = normalizeRole(role);
  return slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** All known roles (for validation/testing). */
export const KNOWN_ROLES = Object.keys(ROLE_WRITE_MODULES);
`;
}

/** Full emit: extract → render → prettier-format (repo config). */
export async function emitFormatted(sourceText: string): Promise<string> {
  const prettierConfig = (await resolveConfig(TARGET)) ?? {};
  return format(render(extractMatrix(sourceText)), {
    parser: 'typescript',
    ...prettierConfig,
  });
}

async function main(): Promise<void> {
  const sourceText = readFileSync(SOURCE, 'utf-8');
  const emitted = await emitFormatted(sourceText);

  const current = readFileSync(TARGET, 'utf-8');
  if (current === emitted) {
    console.log('role-matrix: frontend/src/lib/role-matrix.ts is up to date');
    return;
  }
  if (process.argv.includes('--check')) {
    console.error(
      'role-matrix: DRIFT — frontend/src/lib/role-matrix.ts is stale vs ' +
        'services/api/src/permissions/role-matrix.ts. Run `npm run gen:role-matrix`.',
    );
    process.exit(1);
  }
  writeFileSync(TARGET, emitted);
  console.log('role-matrix: regenerated frontend/src/lib/role-matrix.ts');
}

const isDirectRun =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((err: unknown) => {
    console.error(`role-matrix: ${(err as Error).message}`);
    process.exit(1);
  });
}
