#!/usr/bin/env node
// scripts/guards/i18n-pairs.mjs — S8 W1-A9 (docs/development-tasks.md §5e F5 "界面语言中文为主，
// 英文收进语言切换"; audit S4/S7): fails on a *new* "中文 English" literal pair — CJK text
// immediately followed by a Latin-script tail in the same string/JSX-text literal — outside a
// `t(zh, en)` call (`packages/web/src/lib/i18n.ts`). W1-A9's codemod split every such existing
// pair it could safely reach into `t('中文', 'English')`; this guard is the regression net so new
// code keeps doing the same instead of reintroducing a doubled bilingual label (the audit's S4
// "全站标签…翻倍…折行" root cause).
//
// Two literal shapes are scanned, both text-based (not an AST parse — same trade-off `css-tokens
// .mjs`'s TW_ARBITRARY_VALUE/UI_IMPORT checks document):
//   (a) JSX text — text directly between `>` and `<` (no `{`/`}` in between, so it is never
//       already an expression like `{t(...)}`) that contains the pair pattern. Always a
//       violation: a JSX text node can only be "in a t() call" by being wrapped in
//       `{t(...)}`, which this scan does not see as plain text at all.
//   (b) A quoted string literal (single/double, single-line) whose *entire* content is the pair
//       pattern. Exempted when the literal is the first argument of a call to a function named
//       exactly `t` (i.e. immediately preceded by `t(`, whitespace/newlines allowed) — that shape
//       is `t('中文 embeds a Latin term', 'English')`, already routed through the switch; the
//       guard only cares that the pair was *split*, not that the zh half is pure CJK.
//
// Ratchet baseline (`i18n-pairs-baseline.json`, `{ "<file>": ["<exact violation text>", …] }`):
// W1-A9's codemod could not safely auto-convert every pre-existing pair (module-level wire-code/
// enum label maps — `lib/status-tone.ts`-shaped non-component helpers — and a handful of
// multi-line JSX fragments with embedded markup); those are recorded here, keyed by content, not
// line number, so an unrelated edit elsewhere in the same file never spuriously trips the guard.
// The baseline only shrinks (same convention as `legacy-ui-importers.json`): a file already in it
// may lose entries (fixed) freely, but any violation text not already listed — in a new file or
// an existing one — fails the guard. Regenerating after a legitimate fix: remove the fixed
// string(s) from that file's array (empty array/missing file once a file is fully clean).
//
// Wired into `pnpm ci:guards` (root package.json). Prints `file: <text>` for every un-baselined
// violation and exits non-zero if there is at least one; a clean run prints nothing.
//
// Usage: node scripts/guards/i18n-pairs.mjs [--dump]   (--dump prints every current violation,
// baselined or not, as JSON — for regenerating the baseline after a legitimate change)

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const WEB_SRC_DIR = 'packages/web/src';
export const BASELINE_FILE = fileURLToPath(new URL('./i18n-pairs-baseline.json', import.meta.url));

// CJK Unified Ideographs (the codebase's own bilingual convention never uses the rarer CJK
// extension blocks) plus the full-width punctuation the audit's sample strings use.
const CJK = '\\u3400-\\u9fff\\u3000-\\u303f\\uff00-\\uffef';
const LATIN_TAIL_CHAR = "[A-Za-z0-9\\s,./()'’\"%:_+\\-;!?&]";

/** Longest-suffix split, mirroring the W1-A9 codemod's own heuristic: true iff `text` is exactly
 *  "<zh...><space><pure-Latin-tail>" with at least one CJK ideograph on the zh side. */
function isUnsplitPair(text) {
  const cjkRe = /[㐀-鿿]/;
  if (!cjkRe.test(text)) return false;
  let i = text.length;
  const tailRe = new RegExp(LATIN_TAIL_CHAR);
  while (i > 0 && tailRe.test(text[i - 1]) && !cjkRe.test(text[i - 1])) i--;
  const zh = text.slice(0, i).replace(/\s+$/, '');
  const en = text
    .slice(i)
    .replace(/^\s+/, '');
  if (zh.length === 0 || en.length === 0) return false;
  if (!/^[A-Za-z]/.test(en)) return false;
  if (!cjkRe.test(zh)) return false;
  return `${zh} ${en}` === text.trim();
}

/** Blanks `//` and `/* … *\/` comments (same length, newlines kept) so a comment never trips the
 *  scan — same trade-off as `css-tokens.mjs`'s `blankJsComments`. */
export function blankComments(source) {
  const noBlock = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return noBlock
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, (m) => ' '.repeat(m.length)))
    .join('\n');
}

function lineAt(source, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (source[i] === '\n') line++;
  return line;
}

/** JSX text runs: `>...<` with no `{`/`}`/`<`/`>`/`;` in between — plain text, never already an
 *  expression. `;` is excluded even though real JSX text never contains one: without it, a stray
 *  `>` closing one self-closing tag (e.g. `<Foo />`) and an unrelated `<` opening a *different*
 *  tag many statements later can bracket a whole run of ordinary code that happens to contain no
 *  braces (verified against `ChatListPage.test.tsx`'s own `rerender(<Harness .../>)` calls) — the
 *  semicolon between statements is the cheapest reliable "this is not markup" signal. Capped at
 *  200 chars as a second guard against the same class of false span. */
const JSX_TEXT_RE = />([^<>{};]{0,200}[㐀-鿿][^<>{};]{0,200})</g;

/** Single-line quoted string literals — deliberately not multi-line/template-literal aware (a
 *  template literal with `${}` substitutions is exactly the "manual" shape W1-A9 could not
 *  auto-convert either; out of this guard's scope the same way). */
const STRING_RE = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g;

export function findViolations(source) {
  const blanked = blankComments(source);
  const out = [];

  JSX_TEXT_RE.lastIndex = 0;
  for (const m of blanked.matchAll(JSX_TEXT_RE)) {
    const text = m[1].trim().replace(/\s+/g, ' ');
    if (text && isUnsplitPair(text)) {
      out.push({ line: lineAt(blanked, m.index), text });
    }
  }

  STRING_RE.lastIndex = 0;
  for (const m of blanked.matchAll(STRING_RE)) {
    const text = (m[1] ?? m[2] ?? '').trim().replace(/\s+/g, ' ');
    if (!text || !isUnsplitPair(text)) continue;
    const before = blanked.slice(Math.max(0, m.index - 4), m.index);
    if (/t\(\s*$/.test(before)) continue; // first argument of a t(...) call — already split
    out.push({ line: lineAt(blanked, m.index), text });
  }

  return out;
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

export function loadBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function main() {
  const dump = process.argv.includes('--dump');
  const baseline = loadBaseline();
  const byFile = new Map();

  for (const file of listWebSourceFiles()) {
    const rel = toRepoRelativePosix(file);
    const found = findViolations(readFileSync(file, 'utf8'));
    if (found.length > 0) byFile.set(rel, found);
  }

  if (dump) {
    const out = {};
    for (const [file, found] of byFile) out[file] = found.map((v) => v.text);
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const violations = [];
  for (const [file, found] of byFile) {
    const allowed = new Set(baseline[file] ?? []);
    for (const { line, text } of found) {
      if (allowed.has(text)) continue;
      violations.push(`${file}:${line}: "${text}"`);
    }
  }

  if (violations.length > 0) {
    console.error(`i18n-pairs guard: ${violations.length} new violation(s):`);
    for (const v of violations) console.error(`  ${v}`);
    console.error(
      '  Wrap in t(zh, en) (packages/web/src/lib/i18n.ts). If this is a pre-existing pair a ' +
        'non-component helper cannot split yet, add its exact text to ' +
        'scripts/guards/i18n-pairs-baseline.json under the file (see that guard\'s own header).',
    );
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
