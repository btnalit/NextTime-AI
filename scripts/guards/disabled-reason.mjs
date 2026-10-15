#!/usr/bin/env node
// scripts/guards/disabled-reason.mjs — console usability DoD item 4 (`docs/console-usability-dod.md`):
// a button that is grey because of what the form contains must say why, right next to it. The
// console audit (2026-10-09, P1-2 / P1-9) found the same defect in two dozen forms one at a time;
// this guard makes the rule a CI failure instead of the next walkthrough's finding.
//
// For every `<Button …>` / `<button …>` in `packages/web/src/**/*.tsx` (tests excluded) whose
// `disabled={…}` expression depends on more than "the action is running", one of these must hold:
//
//   1. a `<StillNeeded …>` (components/kit/still-needed) within WINDOW lines of the button;
//   2. the button itself carries `title=` or `aria-describedby=` (a reason on hover / for AT);
//   3. a comment `ux-lint-allow-disabled: <why>` within 4 lines above it, for a button whose
//      reason is self-evident on screen (「上移」 on the first step, an unchanged form's 保存).
//
// "The action is running" is read from the expression: a disjunct counts as busy when one of its
// `&&`-atoms names a busy flag (`busy`, `submitting`, `refreshing`, `loadingMore`, `pending`, …),
// because the button's own spinner already says what is happening. A bare `disabled` is a prop
// passed through to a wrapper — the caller is the one this guard checks.
//
// Wired into `pnpm ci:guards`. Prints `file:line: disabled={…}` per violation and exits non-zero
// if there is at least one; a clean run prints nothing.
//
// Usage: node scripts/guards/disabled-reason.mjs

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const WEB_SRC_DIR = 'packages/web/src';
/** How far (lines, either side) a `<StillNeeded` may sit from the button it explains — a form's
 *  footer keeps them a few lines apart; a sheet's footer can put the line after two buttons. */
export const WINDOW = 40;

/** A flag that only says an action is in flight. Matched against every segment of a dotted name
 *  (`state.busy`, `history.loadingMore`, `pending.state.refreshing`). */
const BUSY_SEGMENT =
  /^(?:busy|stopBusy|submitting|refreshing|retrying|loading|loadingMore|saving\w*|pending|creating|checking|previewing|filtering)$/;
/** A comparison against an in-flight status value (`discovery.status === 'loading'`). */
const BUSY_STATUS = /===\s*['"](?:loading|running|pending|submitting)['"]/;

/** Gates whose reason is rendered by the component that owns them, right above the button:
 *  `credentialReview.blocked` is the 「已核对凭据」 checkbox (`kit/credential-review`). */
const SELF_EXPLAINED = new Set(['credentialReview.blocked', 'approveBlocked']);

const ALLOW = /ux-lint-allow-disabled:\s*[^\s*/}]/;

/** The text of each `{…}` attribute value, braces balanced, starting right after `disabled={`. */
function readBraced(source, start) {
  let depth = 1;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index);
    }
  }
  return null;
}

/** Splits `expression` on a top-level operator (outside parentheses). */
function splitTopLevel(expression, operator) {
  const parts = [];
  let depth = 0;
  let last = 0;
  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index];
    if (char === '(' || char === '[') depth += 1;
    else if (char === ')' || char === ']') depth -= 1;
    else if (depth === 0 && expression.startsWith(operator, index)) {
      parts.push(expression.slice(last, index));
      last = index + operator.length;
      index += operator.length - 1;
    }
  }
  parts.push(expression.slice(last));
  return parts.map((part) => part.trim().replace(/^\((.*)\)$/s, '$1').trim());
}

function names(atom) {
  const withoutStrings = atom.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, ' ');
  return withoutStrings.match(/[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*/g) ?? [];
}

function atomIsBusy(atom) {
  if (BUSY_STATUS.test(atom)) return true;
  return names(atom).some((name) =>
    name.split(/\??\./).some((segment) => BUSY_SEGMENT.test(segment)),
  );
}

function atomIsSelfExplained(atom) {
  return names(atom).some((name) => SELF_EXPLAINED.has(name.replace(/\?\./g, '.')));
}

/** Whether a `disabled` expression needs a visible reason: some disjunct is neither busy (one of
 *  its conjuncts names a busy flag) nor a self-explained gate. A bare `disabled` passes through. */
export function needsReason(expression) {
  const trimmed = expression.trim();
  if (trimmed === 'disabled' || trimmed === 'false') return false;
  return splitTopLevel(trimmed, '||').some((disjunct) => {
    const atoms = splitTopLevel(disjunct, '&&');
    if (atoms.some(atomIsBusy)) return false;
    return !atoms.every(atomIsSelfExplained);
  });
}

const BUTTON_OPEN = /<(Button|button)\b/g;

/** Every violation in one TSX source: `{line, expression}`. */
export function findViolations(source) {
  const out = [];
  const lines = source.split('\n');
  const stillNeededLines = [];
  lines.forEach((line, index) => {
    if (line.includes('<StillNeeded')) stillNeededLines.push(index + 1);
  });
  for (const match of source.matchAll(BUTTON_OPEN)) {
    // The opening tag ends at the first `>` outside braces.
    let depth = 0;
    let end = -1;
    for (let index = match.index; index < source.length; index += 1) {
      const char = source[index];
      if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
      else if (char === '>' && depth === 0) {
        end = index;
        break;
      }
    }
    if (end === -1) continue;
    const tag = source.slice(match.index, end);
    const disabledAt = tag.indexOf('disabled={');
    if (disabledAt === -1) continue;
    const expression = readBraced(tag, disabledAt + 'disabled={'.length);
    if (expression === null || !needsReason(expression)) continue;
    if (/\b(?:title|aria-describedby)=/.test(tag)) continue;
    const line = source.slice(0, match.index).split('\n').length;
    if (stillNeededLines.some((at) => Math.abs(at - line) <= WINDOW)) continue;
    const above = lines.slice(Math.max(0, line - 5), line).join('\n');
    if (ALLOW.test(above)) continue;
    out.push({ line, expression: expression.replace(/\s+/g, ' ').trim() });
  }
  return out;
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith('.tsx') && !entry.name.includes('.test.')) yield full;
  }
}

/** The components that *are* buttons pass `disabled` through; their callers are checked. */
const WRAPPERS = new Set([
  'packages/web/src/components/ui/Button.tsx',
  'packages/web/src/components/kit/button.tsx',
]);

export function run(root = REPO_ROOT) {
  const violations = [];
  for (const file of walk(path.join(root, WEB_SRC_DIR))) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    if (WRAPPERS.has(relative)) continue;
    for (const violation of findViolations(readFileSync(file, 'utf8'))) {
      violations.push(`${relative}:${violation.line}: disabled={${violation.expression}}`);
    }
  }
  return violations;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const violations = run();
  if (violations.length > 0) {
    console.error(
      'A button that is grey because of the form’s content must say why: add <StillNeeded> next to it (components/kit/still-needed), a title, or a `ux-lint-allow-disabled: <why>` comment when the reason is already on screen.',
    );
    for (const violation of violations) console.error(violation);
    process.exit(1);
  }
}
