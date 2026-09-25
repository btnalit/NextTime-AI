#!/usr/bin/env node
// scripts/guards/i18n-pairs.mjs — S8 W1-A9 (docs/development-tasks.md §5e F5 "界面语言中文为主，
// 英文收进语言切换"; audit S4/S7) + W1-A12 (batch design review round 2: two shapes slipped past
// the original guard — see detectors (c)/(d) below) + S8 W4 item 5 (leftover 85 "i18n 守卫不查插值
// 模板里的中英对" — detector (e) below). Fails on a *new* "中文 English" literal pair — CJK text
// immediately followed by a Latin-script tail in the same string/JSX-text/template literal —
// outside a `t(zh, en)` call (`packages/web/src/lib/i18n.tsx`), a raw English-only piece of UI
// copy, or a CJK sentence with its full English translation glued into the same literal instead of
// split across `t()`'s two arguments. W1-A9's codemod split every short pair it could safely reach
// into `t('中文', 'English')`; this guard is the regression net so new code keeps doing the same
// instead of reintroducing a doubled bilingual label (the audit's S4 "全站标签…翻倍…折行" root
// cause) or shipping English-only copy in a Chinese-first console.
//
// Five literal shapes are scanned, all text-based (not an AST parse — same trade-off `css-tokens
// .mjs`'s TW_ARBITRARY_VALUE/UI_IMPORT checks document):
//   (a) JSX text — text directly between `>` and `<` (no `{`/`}` in between, so it is never
//       already an expression like `{t(...)}`) that contains the *short* pair pattern (W1-A9).
//       Always a violation: a JSX text node can only be "in a t() call" by being wrapped in
//       `{t(...)}`, which this scan does not see as plain text at all.
//   (b) A quoted string literal (single/double, single-line) whose *entire* content is the short
//       pair pattern (W1-A9). Exempted when the literal is the first argument of a call to a
//       function named exactly `t` (i.e. immediately preceded by `t(`, whitespace/newlines
//       allowed) — that shape is `t('中文 embeds a Latin term', 'English')`, already routed
//       through the switch; the guard only cares that the pair was *split*, not that the zh half
//       is pure CJK.
//   (c) W1-A12: a JSX text node, or the value of a user-facing JSX attribute (`title`,
//       `aria-label`, `placeholder`, `label`, `description`, `hint`, `subtitle`), that is an
//       English phrase (no CJK, ≥ 3 whitespace-separated words) and — for the JSX-text case only
//       (an attribute string literal can never itself be `{t(...)}`) — is not lexically inside a
//       `t(...)` call. Candidates that "look like code" (contain `(`, `)`, `{`, `}`, `=`, or a
//       dotted `word.word` member-access run) are skipped — a brace/semicolon-free span between
//       two unrelated `>`/`<` can still capture a ternary chain or a TS type signature, the same
//       false-span risk (b)'s own doc comment describes; a real JSX text phrase or attribute string
//       essentially never needs any of those characters.
//   (d) W1-A12: a quoted string literal containing a CJK ideograph followed, after the *last* CJK
//       ideograph in the string, by a Latin-script tail of ≥ 4 words — the "glued-together
//       sentence pair" shape (a `t(zh, en)` call whose `zh` argument still carries the English
//       translation as a trailing clause instead of it living in `en`, or a plain string never
//       routed through `t()` at all). Unlike (b), *not* exempted by a preceding `t(` — that is
//       exactly the shape that let it hide inside an already-`t()`-wrapped call. Tails that "look
//       like code" (a path segment, a `--flag`, or a `.ext`-shaped token — `scripts/foo.sh`,
//       `docker compose up -d --force-recreate`, `config/ontology/`) are skipped: a Chinese
//       sentence legitimately embedding a shell command or file path is not a translation
//       duplicate. This trades a few false negatives (a genuine duplicate whose tail happens to
//       mention e.g. `models.json`) for not flagging the much more common legitimate case; the
//       W1-A12 sweep found and fixed both kinds by hand, this guard is the regression net going
//       forward. (c) and (d) skip `*.test.ts(x)` files entirely — assertions and fixture strings
//       are not rendered UI copy, and would otherwise flood the baseline.
//   (e) S8 W4 item 5: the same (b)/(d) checks — short unsplit pair, glued-sentence tail — run
//       against a **template literal**'s (backtick string) *flattened* static text: every
//       `${...}` interpolation replaced with a single space before testing, so a dynamic value
//       (an id, a count) never participates in the CJK/Latin-tail matching either way, e.g.
//       `` `弃用 ${x} Deprecate ${x}` `` flattens to "弃用   Deprecate  " → a glued pair, flagged.
//       `STRING_RE` above never matches backticks at all ((b)'s own doc comment: "deliberately
//       not... template-literal aware"), so this closes a real, previously unguarded gap — see
//       `findTemplateLiteralSpans`'s own doc comment for the nested-`${}`-aware scanner this
//       needs (an expression can itself contain nested template literals/strings/braces). Same
//       `t(` exemption as (b) (an already-split `t(\`zh ${x}\`, \`en ${x}\`)` call), same
//       unconditional (no exemption) glued-sentence check as (d), same `*.test.ts(x)` skip as
//       (c)/(d) (a template literal in a test is overwhelmingly a fixture/expected-value string).
//
// Ratchet baseline (`i18n-pairs-baseline.json`, `{ "<file>": ["<exact violation text>", …] }`):
// shared by all five detectors (a violation is identified by its exact text within a file,
// regardless of which detector found it). W1-A9's codemod could not safely auto-convert every
// pre-existing short pair (module-level wire-code/enum label maps — `lib/status-tone.ts`-shaped
// non-component helpers — and a handful of multi-line JSX fragments with embedded markup); W1-A12
// likewise keeps a handful of legitimate English here — product names, code identifiers, env-var
// names shown behind a "技术细节" disclosure — that (c)/(d)'s heuristics cannot itself tell apart
// from real untranslated copy. Recorded keyed by content, not line number, so an unrelated edit
// elsewhere in the same file never spuriously trips the guard. The baseline only shrinks (same
// convention as `legacy-ui-importers.json`): a file already in it may lose entries (fixed) freely,
// but any violation text not already listed — in a new file or an existing one — fails the guard.
// Regenerating after a legitimate fix: remove the fixed string(s) from that file's array (empty
// array/missing file once a file is fully clean).
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

const LATIN_TAIL_CHAR = '[A-Za-z0-9\\s,./()\'’"%:_+\\-;!?&]';

/** Full-width / CJK punctuation that can directly abut an English tail with *no* space in
 *  between (e.g. "继承（不覆盖）Inherit workspace default" — the codemod's own split heuristic and
 *  the space-separated check below both miss this shape, see `isUnsplitPair`'s second branch). */
const CJK_PUNCT_RE = /[（）【】《》「」『』〈〉〔〕：，。；！？、～·—]/;

/** Longest-suffix split, mirroring the W1-A9 codemod's own heuristic: true iff `text` is exactly
 *  "<zh...><space><pure-Latin-tail>" with at least one CJK ideograph on the zh side — or
 *  "<zh...><CJK punctuation><pure-Latin-tail>" with no space at all, the same shape written with
 *  a closing full-width bracket/mark directly against the English half instead of a space. */
function isUnsplitPair(text) {
  const cjkRe = /[㐀-鿿]/;
  if (!cjkRe.test(text)) return false;
  let i = text.length;
  const tailRe = new RegExp(LATIN_TAIL_CHAR);
  while (i > 0 && tailRe.test(text[i - 1]) && !cjkRe.test(text[i - 1])) i--;
  const zh = text.slice(0, i).replace(/\s+$/, '');
  const en = text.slice(i).replace(/^\s+/, '');
  if (zh.length === 0 || en.length === 0) return false;
  if (!/^[A-Za-z]/.test(en)) return false;
  if (!cjkRe.test(zh)) return false;
  const trimmed = text.trim();
  if (`${zh} ${en}` === trimmed) return true;
  return CJK_PUNCT_RE.test(zh[zh.length - 1]) && `${zh}${en}` === trimmed;
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

const CJK_RE = /[㐀-鿿]/;

/** (c)'s JSX-text half — same span shape as `JSX_TEXT_RE` but without requiring a CJK ideograph
 *  (an all-English run is exactly what this detector is looking for). */
const JSX_TEXT_EN_RE = />([^<>{};]{1,200})</g;

/** (c)'s attribute half — a user-facing JSX prop whose value is a plain quoted string literal (an
 *  `attr={t(...)}` expression container never matches this — no quote directly after `=`). */
const ATTR_NAMES = [
  'title',
  'aria-label',
  'placeholder',
  'label',
  'description',
  'hint',
  'subtitle',
];
const ATTR_RE = new RegExp(`\\b(?:${ATTR_NAMES.join('|')})=(["'])((?:(?!\\1)[^\\n])*)\\1`, 'g');

function wordCount(text) {
  return text
    .trim()
    .split(/\s+/)
    .filter((word) => /[A-Za-z]/.test(word)).length;
}

/** (c): an English-only phrase worth flagging — no CJK, ≥ 3 real words (an identifier like
 *  `list_connection_requests` or `grant_capability` is one whitespace-delimited token, so it never
 *  reaches the threshold; that is deliberate, see the file header). */
function isEnglishPhrase(text) {
  const trimmed = text.trim();
  return trimmed.length > 0 && !CJK_RE.test(trimmed) && wordCount(trimmed) >= 3;
}

/** (c)'s code-shaped rejection — see the file header for why. `|` is TS's union-type marker
 *  (caught in the wild: two stacked `ReadonlyMap<K, V>` parameters read as one false JSX span
 *  between the first's closing `>` and the second's opening `<`, capturing the `| undefined,`
 *  text in between — real UI prose never uses a bare pipe). */
function looksLikeCode(text) {
  return /[(){}=|]/.test(text) || /\w\.\w/.test(text);
}

/** (d)'s code-hint rejection — a path segment, a `--flag`, or a `.ext`-shaped token in the Latin
 *  tail after the last CJK ideograph. See the file header for the trade-off. */
const CODE_HINT_RE = /\/|--|\.[A-Za-z]{1,4}(?=[\s.,;:)]|$)/;

/** (d): does `text` contain a CJK ideograph followed — after the *last* one — by a Latin-script
 *  tail of at least 4 words that does not look like an embedded command/path? That tail length is
 *  what tells a "glued-together sentence pair" (translated prose) apart from a short embedded
 *  technical term (`t('资源 id', 'Resource id')`-shaped, already legitimate and far short of 4
 *  words). */
function hasGluedEnglishSentence(text) {
  if (!CJK_RE.test(text)) return false;
  let lastCjk = -1;
  for (let i = 0; i < text.length; i++) if (CJK_RE.test(text[i])) lastCjk = i;
  const tail = text.slice(lastCjk + 1).trim();
  if (!tail || CODE_HINT_RE.test(tail)) return false;
  return wordCount(tail) >= 4;
}

/**
 * (e) W1-A13 (S8 W4 item 5, leftover 85 "i18n 守卫不查插值模板里的中英对"): a template literal
 * (backtick string) whose *static* text — the parts outside any `${...}` interpolation — glues a
 * CJK phrase to its own English translation, the same "unsplit pair"/"glued sentence" shapes (b)/
 * (d) already catch for plain quoted strings. `STRING_RE` never matches backticks at all (the file
 * header's own note on (b): "deliberately not... template-literal aware"), so this was a real,
 * unguarded gap — the exact shape #282 fixed five instances of by hand (`i18n-pairs-baseline.json`
 * predates this detector, hence the initial baseline entries this task's own sweep adds).
 *
 * `findTemplateLiteralSpans` walks the source once, tracking a stack of "am I inside a template
 * literal's static text, or inside one of its `${...}` expressions" frames — needed because an
 * expression can itself contain nested template literals (`${a ? \`x\` : \`y\`}`), ordinary quoted
 * strings (whose own `` ` ``/`{`/`}` characters must not perturb the outer template's own nesting),
 * and arbitrary brace-nesting (`${fn({a: 1})}`). Each span's *flattened* text — every `${...}`
 * replaced with a single space, so a dynamic value never fools the CJK/Latin-tail detectors either
 * way — is what both (b)'s `isUnsplitPair` and (d)'s `hasGluedEnglishSentence` run against, and
 * what gets reported/baselined (not the raw source substring, which would still carry the
 * un-evaluated `${...}` expressions).
 */
function findTemplateLiteralSpans(source) {
  const spans = [];
  const stack = [];
  let i = 0;
  function topIsTemplate() {
    const top = stack[stack.length - 1];
    return top !== undefined && top.type === 'template';
  }
  while (i < source.length) {
    const top = stack[stack.length - 1];
    if (top === undefined) {
      const ch = source[i];
      if (ch === '`') {
        stack.push({ type: 'template', parts: [], textStart: i + 1, spanStart: i });
        i++;
        continue;
      }
      if (ch === "'" || ch === '"') {
        const quote = ch;
        i++;
        while (i < source.length && source[i] !== quote) {
          if (source[i] === '\\') i++;
          i++;
        }
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (topIsTemplate()) {
      const ch = source[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '`') {
        top.parts.push(source.slice(top.textStart, i));
        stack.pop();
        spans.push({ start: top.spanStart, end: i + 1, flatText: top.parts.join(' ') });
        i++;
        continue;
      }
      if (ch === '$' && source[i + 1] === '{') {
        top.parts.push(source.slice(top.textStart, i));
        stack.push({ type: 'expr', depth: 1 });
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    // Inside a `${...}` expression.
    const ch = source[i];
    if (ch === '`') {
      stack.push({ type: 'template', parts: [], textStart: i + 1, spanStart: i });
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === '{') {
      top.depth++;
      i++;
      continue;
    }
    if (ch === '}') {
      top.depth--;
      if (top.depth === 0) {
        stack.pop();
        const parent = stack[stack.length - 1];
        if (parent && parent.type === 'template') parent.textStart = i + 1;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  return spans;
}

/** For every index in `source`, is that position lexically inside the argument list of a call to
 *  a function named exactly `t` (`useT()`'s return value, `packages/web/src/lib/i18n.tsx`)? A
 *  light paren-depth scan, not a real parser: strings/template literals are skipped whole (their
 *  contents cannot themselves open/close a `t(...)` call), every other `(`/`)` adjusts a stack of
 *  "was this paren opened by a bare `t` identifier" markers, and a position counts as inside `t()`
 *  when *any* entry on the stack is such a marker (nested calls/JSX inside the arguments are still
 *  part of the `t(...)` call). Used only by (c)'s JSX-text half — an attribute's own string literal
 *  can never itself be a `{t(...)}` expression, so it needs no such check (see the file header). */
function computeInsideTMap(source) {
  const insideT = new Array(source.length).fill(false);
  const stack = []; // each entry: was THIS paren opened by a bare `t` identifier?
  const hasT = () => stack.includes(true);
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      insideT[i] = hasT();
      i++;
      while (i < source.length && source[i] !== quote) {
        insideT[i] = hasT();
        if (source[i] === '\\' && i + 1 < source.length) {
          i++;
          insideT[i] = hasT();
        }
        i++;
      }
      if (i < source.length) {
        insideT[i] = hasT();
        i++;
      }
      continue;
    }
    if (ch === '(') {
      let j = i - 1;
      while (j >= 0 && /\s/.test(source[j])) j--;
      const isT = j >= 0 && source[j] === 't' && !/[A-Za-z0-9_$]/.test(source[j - 1] ?? '');
      stack.push(isT);
      insideT[i] = hasT();
      i++;
      continue;
    }
    if (ch === ')') {
      insideT[i] = hasT();
      stack.pop();
      i++;
      continue;
    }
    insideT[i] = hasT();
    i++;
  }
  return insideT;
}

/** `isTestFile` (repo-relative posix path): (c)/(d) skip `*.test.ts(x)` entirely — assertions and
 *  fixture strings are not rendered UI copy (see the file header); (a)/(b) keep scanning them
 *  unchanged (that is the existing, already-clean W1-A9 behaviour). */
export function findViolations(source, { isTestFile = false } = {}) {
  const blanked = blankComments(source);
  const out = [];
  const seen = new Set(); // dedupes when two detectors independently flag the same literal (e.g.
  // a short pair whose English half happens to also be ≥ 4 words — both (b)'s isUnsplitPair and
  // (d)'s hasGluedEnglishSentence match).
  function push(index, text) {
    const line = lineAt(blanked, index);
    const key = `${line}:${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ line, text });
  }

  JSX_TEXT_RE.lastIndex = 0;
  for (const m of blanked.matchAll(JSX_TEXT_RE)) {
    const text = m[1].trim().replace(/\s+/g, ' ');
    if (text && isUnsplitPair(text)) {
      push(m.index, text);
    }
  }

  STRING_RE.lastIndex = 0;
  for (const m of blanked.matchAll(STRING_RE)) {
    const text = (m[1] ?? m[2] ?? '').trim().replace(/\s+/g, ' ');
    if (!text) continue;
    const before = blanked.slice(Math.max(0, m.index - 4), m.index);
    const isTArg = /t\(\s*$/.test(before); // first argument of a t(...) call — already split
    if (isUnsplitPair(text) && !isTArg) {
      push(m.index, text);
    }
    if (!isTestFile && hasGluedEnglishSentence(text)) {
      push(m.index, text);
    }
  }

  // (e): skips test files, same reasoning (c)/(d) already give — a template literal in a
  // `*.test.ts(x)` file is overwhelmingly a fixture/expected-value string, not rendered UI copy.
  if (!isTestFile) {
    for (const span of findTemplateLiteralSpans(blanked)) {
      const text = span.flatText.trim().replace(/\s+/g, ' ');
      if (!text) continue;
      const before = blanked.slice(Math.max(0, span.start - 4), span.start);
      const isTArg = /t\(\s*$/.test(before); // first argument of a t(...) call — already split
      if (isUnsplitPair(text) && !isTArg) {
        push(span.start, text);
      }
      if (hasGluedEnglishSentence(text)) {
        push(span.start, text);
      }
    }
  }

  if (!isTestFile) {
    const insideT = computeInsideTMap(blanked);
    JSX_TEXT_EN_RE.lastIndex = 0;
    for (const m of blanked.matchAll(JSX_TEXT_EN_RE)) {
      const text = m[1].trim().replace(/\s+/g, ' ');
      if (!text || !isEnglishPhrase(text) || looksLikeCode(text)) continue;
      if (insideT[m.index]) continue;
      push(m.index, text);
    }

    ATTR_RE.lastIndex = 0;
    for (const m of blanked.matchAll(ATTR_RE)) {
      const text = (m[2] ?? '').trim().replace(/\s+/g, ' ');
      if (!text || !isEnglishPhrase(text)) continue;
      push(m.index, text);
    }
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
    const isTestFile = /\.test\.tsx?$/.test(rel);
    const found = findViolations(readFileSync(file, 'utf8'), { isTestFile });
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
        "scripts/guards/i18n-pairs-baseline.json under the file (see that guard's own header).",
    );
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
