/**
 * Pseudo-locale CI check — fails the build if hardcoded user-facing strings
 * are detected in frontend/src/ components.
 *
 * Rule: JSX string literals (excluding className, key, data-*, testID, and
 * known non-user-facing patterns) must go through next-intl.
 *
 * Usage: node frontend/scripts/check-hardcoded-strings.mjs
 * Exit 0 = pass, Exit 1 = violations found.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, extname } from 'node:path';

const SRC_DIR = resolve(import.meta.dirname, '../src');

// Patterns that are NOT user-facing strings (safe to hardcode)
const SAFE_PATTERNS = [
  /className=/,
  /key=/,
  /data-/,
  /testID=/,
  /href=/,
  /src=/,
  /alt=""/, // empty alt is accessibility pattern
  /type=/,
  /id=/,
  /name=/,
  /style=/,
  /role=/,
  /lang=/,
];

// Regex to find JSX string literals: text between > and < (children),
// or quoted-expression children like >{'Some text'}<
const JSX_STRING_CHILD =
  />\s*(?:['"]([A-Z][a-z][\w\s,.!?:;"-]{3,})['"]|([A-Z][a-z][\w\s,.!?:;'"-]{3,}))\s*</g;

// User-facing attribute literals — FE-11: aria-*/placeholder/alt/title must
// also route through next-intl, in both attr="text" and attr={'text'} forms.
const USER_FACING_ATTRS = [
  'aria-label',
  'aria-description',
  'aria-valuetext',
  'aria-placeholder',
  'placeholder',
  'alt',
  'title',
];
const ATTR_LITERAL = new RegExp(
  `(?:${USER_FACING_ATTRS.join('|')})\\s*=\\s*(?:"([^"]*)"|'([^']*)'|\\{\\s*['"]([^'"]*)['"]\\s*\\})`,
  'g',
);

// Values that are genuinely technical, not UI copy — the brand mark itself
// does not translate (1 known exception), nor do symbols/numbers/ids.
const ALLOWED_ATTR_VALUES = new Set(['Cumplify']);

function looksLikeCopy(text) {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length < 4 || ALLOWED_ATTR_VALUES.has(trimmed)) return false;
  if (/^[A-Z_]+$/.test(trimmed) || /^\d/.test(trimmed)) return false;
  if (!/[a-zA-Z]/.test(trimmed)) return false;
  return true;
}

function getAllFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = resolve(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      if (entry === 'node_modules' || entry === 'tokens') continue;
      results.push(...getAllFiles(fullPath));
    } else if (['.tsx', '.jsx'].includes(extname(entry))) {
      // Test files assert against i18n KEYS ('editor.accept') and use
      // fixture content strings (mocked editor HTML) that are not
      // user-facing UI — scanning them only produces false positives.
      if (/\.test\.[jt]sx$/.test(entry)) continue;
      results.push(fullPath);
    }
  }
  return results;
}

const violations = [];

for (const file of getAllFiles(SRC_DIR)) {
  const content = readFileSync(file, 'utf-8');
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip imports, comments, type annotations
    if (
      line.trimStart().startsWith('import ') ||
      line.trimStart().startsWith('//') ||
      line.trimStart().startsWith('*')
    )
      continue;

    // Check for JSX string children (text between > and <)
    let match;
    JSX_STRING_CHILD.lastIndex = 0;
    while ((match = JSX_STRING_CHILD.exec(line)) !== null) {
      const text = (match[1] ?? match[2]).trim();
      // Skip if it's in a safe attribute context
      const isSafe = SAFE_PATTERNS.some((p) => p.test(line.slice(0, match.index + 1)));
      if (isSafe) continue;
      if (!looksLikeCopy(text)) continue;

      violations.push({
        file: file.replace(process.cwd() + '/', ''),
        line: i + 1,
        text,
      });
    }

    // Check for hardcoded user-facing attribute literals (FE-11)
    ATTR_LITERAL.lastIndex = 0;
    while ((match = ATTR_LITERAL.exec(line)) !== null) {
      const text = (match[1] ?? match[2] ?? match[3] ?? '').trim();
      if (!looksLikeCopy(text)) continue;

      violations.push({
        file: file.replace(process.cwd() + '/', ''),
        line: i + 1,
        text: `${match[0].split('=')[0].trim()}="${text}"`,
      });
    }
  }
}

if (violations.length > 0) {
  console.error(`\n❌ HARDCODED STRINGS DETECTED (${violations.length} violations):\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} — "${v.text}"`);
  }
  console.error('\nAll user-facing strings must use next-intl (useTranslations/getTranslations).');
  console.error('See: .kiro/steering/17-i18n.md\n');
  process.exit(1);
} else {
  console.log('✓ No hardcoded user-facing strings detected.');
  process.exit(0);
}
