#!/usr/bin/env node
// scripts/guards/css-tokens.mjs — S6-A0 (docs/console-completion-plan.md §5.9 "验收":
// "`tokens.css` 之外零硬编码颜色与字号"; C24): every stylesheet under `packages/web/src/styles/`
// other than the token sheet (`tokens.css`) and the font-face sheet (`fonts.css`, which only
// `@import`s the self-hosted @fontsource files) must express colour and type size through the
// tokens — no `#hex`, `rgb()`/`rgba()`, `hsl()`/`hsla()` literals and no `font-size: <n>px`.
//
// S8 W1-A0 (docs/development-tasks.md §5e decision F3) extended this guard to Tailwind v4 +
// components/kit/*, S8 risk ①: (1) reject Tailwind arbitrary colour/size values (`bg-[#fff]`,
// `text-[13px]`, …) anywhere under `packages/web/src/**/*.{ts,tsx}` — the token aliasing in
// `packages/web/src/styles/tailwind.css` only has effect if nobody reaches past it for a literal;
// (2) reject a *new* file importing the legacy `components/ui/*` kit — see
// `legacy-ui-importers.json`'s own header for how that allowlist is built and kept current.
//
// Wired into `pnpm ci:guards` (root package.json). Prints `file:line: <offending text>` for every
// violation and exits non-zero if there is at least one; a clean run prints nothing.
//
// Usage: node scripts/guards/css-tokens.mjs

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const STYLES_DIR = 'packages/web/src/styles';
export const WEB_SRC_DIR = 'packages/web/src';
export const UI_DIR = 'packages/web/src/components/ui';
export const KIT_DIR = 'packages/web/src/components/kit';
/** The only two sheets allowed to carry literals: the token definitions themselves, and the
 *  @font-face imports (whose values are file paths, never colours or sizes). */
export const EXEMPT_FILES = new Set(['tokens.css', 'fonts.css']);

// ---- (1) CSS: hard-coded colour / px font-size literals outside tokens.css -------------------

/** Hex colour literal: `#` + 3/4/6/8 hex digits, not followed by another identifier character
 *  (so `#root` and similar id selectors never match — `r` is not a hex digit; and an id that
 *  happens to start with hex digits, `#add-button`, is excluded by the trailing look-ahead). */
const HEX_COLOUR = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-zA-Z_-])/g;
/** `rgb(`, `rgba(`, `hsl(`, `hsla(` function literals. */
const COLOUR_FN = /\b(?:rgba?|hsla?)\(/g;
/** A pixel font-size — `font-size: 12.5px`, `font-size:13px`. Percent/em/rem/var() are fine. */
const PX_FONT_SIZE = /\bfont-size\s*:\s*[0-9.]+px/g;

/** Replaces every `/* … *\/` block with spaces of the same length (newlines kept) so line
 *  numbers of the remaining text are unchanged. */
export function blankComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '));
}

/** Every violation in one stylesheet's text: `{line, text}` (1-based line, the matched literal). */
export function findViolations(css) {
  const out = [];
  const lines = blankComments(css).split('\n');
  lines.forEach((line, index) => {
    for (const re of [HEX_COLOUR, COLOUR_FN, PX_FONT_SIZE]) {
      re.lastIndex = 0;
      for (const match of line.matchAll(re)) {
        out.push({ line: index + 1, text: match[0] });
      }
    }
  });
  return out;
}

export function listStylesheets(dir = path.join(REPO_ROOT, STYLES_DIR)) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.css') && !EXEMPT_FILES.has(name))
    .sort()
    .map((name) => path.join(dir, name));
}

// ---- (2) TS/TSX: Tailwind arbitrary-value literals and new legacy components/ui imports -------

/** Tailwind arbitrary-value token: a utility-like prefix immediately followed by a bracketed
 *  literal colour or pixel/rem size — `bg-[#fff]`, `text-[13px]`, `shadow-[rgba(0,0,0,.4)]`,
 *  `w-[3rem]`. Deliberately simple, same trade-off as the CSS checks above: it scans raw text, not
 *  parsed class strings, so it cannot tell `className="bg-[#fff]"` from any other occurrence of
 *  that substring (a false positive), and it will not catch a value built at runtime via string
 *  concatenation or spread across a template literal's `${}` boundary (a false negative). This is
 *  a lint guard, not a Tailwind class-string parser. */
const TW_ARBITRARY_VALUE =
  /[a-zA-Z][\w-]*\[(?:#[0-9a-fA-F]{3,8}|rgba?\([^[\]]*\)|hsla?\([^[\]]*\)|[0-9.]+(?:px|rem))\]/g;

/** Any relative import with a `ui/` path segment — `./ui/Button.js`, `../ui/Card.js`,
 *  `../../components/ui/X.js`. Simple substring/regex match, not a module resolver: it would also
 *  flag an unrelated `.../ui/...` folder if one is ever added outside components/ui — an accepted
 *  false-positive risk for a guard with no resolution step. */
const UI_IMPORT = /from\s+['"]((?:\.\.?\/)+(?:[\w-]+\/)*ui\/[\w./-]+)['"]/g;

/** Blanks `//` line comments and `/* … *\/` block comments (same length, newlines kept) so a
 *  comment mentioning an arbitrary value or a legacy import doesn't trip either detector below.
 *  Does not understand string/template-literal boundaries, so `"// not a comment"` inside a
 *  string is still blanked — the same accepted limitation as `blankComments` above. */
export function blankJsComments(source) {
  const noBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return noBlockComments
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, (m) => ' '.repeat(m.length)))
    .join('\n');
}

/** Every Tailwind arbitrary colour/size value in one source file's text: `{line, text}`. */
export function findArbitraryValueViolations(source) {
  const out = [];
  const lines = blankJsComments(source).split('\n');
  lines.forEach((line, index) => {
    TW_ARBITRARY_VALUE.lastIndex = 0;
    for (const match of line.matchAll(TW_ARBITRARY_VALUE)) {
      out.push({ line: index + 1, text: match[0] });
    }
  });
  return out;
}

/** Every `components/ui/*`-shaped relative import in one source file's text: `{line, text}`
 *  (`text` is the import specifier itself, for the violation message). */
export function findLegacyUiImports(source) {
  const out = [];
  const lines = blankJsComments(source).split('\n');
  lines.forEach((line, index) => {
    UI_IMPORT.lastIndex = 0;
    for (const match of line.matchAll(UI_IMPORT)) {
      out.push({ line: index + 1, text: match[1] });
    }
  });
  return out;
}

export const LEGACY_UI_ALLOWLIST_FILE = fileURLToPath(
  new URL('./legacy-ui-importers.json', import.meta.url),
);

/** The file set `components/ui/*` is already allowed to import from — see that JSON file's own
 *  header for how it was built and how to regenerate it after a legitimate new usage. */
export function loadLegacyUiAllowlist() {
  return new Set(JSON.parse(readFileSync(LEGACY_UI_ALLOWLIST_FILE, 'utf8')));
}

function walkFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

export function listWebSourceFiles(dir = path.join(REPO_ROOT, WEB_SRC_DIR)) {
  return walkFiles(dir)
    .filter((file) => /\.(ts|tsx)$/.test(file))
    .sort();
}

export function toRepoRelativePosix(file) {
  return path.relative(REPO_ROOT, file).split(path.sep).join('/');
}

// ---- main ---------------------------------------------------------------------------------

function main() {
  const violations = [];

  for (const file of listStylesheets()) {
    const rel = toRepoRelativePosix(file);
    for (const { line, text } of findViolations(readFileSync(file, 'utf8'))) {
      violations.push(`${rel}:${line}: ${text}`);
    }
  }

  const legacyUiAllowlist = loadLegacyUiAllowlist();
  for (const file of listWebSourceFiles()) {
    const rel = toRepoRelativePosix(file);
    const source = readFileSync(file, 'utf8');

    for (const { line, text } of findArbitraryValueViolations(source)) {
      violations.push(
        `${rel}:${line}: Tailwind arbitrary value ${text} (use a §5.9 token utility)`,
      );
    }

    const isLegacyUiItself = rel === UI_DIR || rel.startsWith(`${UI_DIR}/`);
    if (!isLegacyUiItself && !legacyUiAllowlist.has(rel)) {
      for (const { line, text } of findLegacyUiImports(source)) {
        violations.push(
          `${rel}:${line}: new import of legacy components/ui (${text}) — not on the allowlist (scripts/guards/legacy-ui-importers.json); use components/kit instead (S8 risk ①, docs/development-tasks.md §5e)`,
        );
      }
    }
  }

  if (violations.length > 0) {
    console.error(`css-tokens guard: ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v}`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
