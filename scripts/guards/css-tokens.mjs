#!/usr/bin/env node
// scripts/guards/css-tokens.mjs — S6-A0 (docs/console-completion-plan.md §5.9 "验收":
// "`tokens.css` 之外零硬编码颜色与字号"; C24): every stylesheet under `packages/web/src/styles/`
// other than the token sheet (`tokens.css`) and the font-face sheet (`fonts.css`, which only
// `@import`s the self-hosted @fontsource files) must express colour and type size through the
// tokens — no `#hex`, `rgb()`/`rgba()`, `hsl()`/`hsla()` literals and no `font-size: <n>px`.
// Wired into `pnpm ci:guards` (root package.json). Prints `file:line: <offending text>` for every
// violation and exits non-zero if there is at least one; a clean run prints nothing.
//
// Files are enumerated from the filesystem (not `git ls-files`) so an untracked stylesheet in a
// working tree is checked before it is ever committed. Comments (`/* … */`) are blanked before
// matching so a rationale comment may quote a hex value.
//
// Usage: node scripts/guards/css-tokens.mjs

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const STYLES_DIR = 'packages/web/src/styles';
/** The only two sheets allowed to carry literals: the token definitions themselves, and the
 *  @font-face imports (whose values are file paths, never colours or sizes). */
export const EXEMPT_FILES = new Set(['tokens.css', 'fonts.css']);

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

function main() {
  const violations = [];
  for (const file of listStylesheets()) {
    const rel = path.relative(REPO_ROOT, file);
    for (const { line, text } of findViolations(readFileSync(file, 'utf8'))) {
      violations.push(`${rel}:${line}: ${text}`);
    }
  }
  if (violations.length > 0) {
    console.error(
      `css-tokens guard: ${violations.length} hard-coded colour/font-size literal(s) outside tokens.css (docs/console-completion-plan.md §5.9):`,
    );
    for (const v of violations) console.error(`  ${v}`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
