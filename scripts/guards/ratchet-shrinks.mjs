// ratchet-shrinks.mjs — the two test-debt ratchets only go down across a pull request
// (docs/test-coverage-gaps-2026-11-06.md §5; review follow-up on #1006 and #1012).
//
// capability-matrix.mjs and e2e-locators.mjs each check that their ratchet file matches the code
// *of the same commit*. Neither can see the commit before, so a PR that adds an untested capability
// and raises `ratchet:`, or adds a test-id click and re-runs `--update-baseline`, passes both. This
// compares the PR's files with the base branch's:
//
//   matrix    docs/contracts/capability-matrix.yaml `ratchet.<key>` must not exceed the base's
//   locators  scripts/guards/e2e-locators-baseline.json: each call text's count, summed over all
//             files (so renaming a spec file is not a raise), and the total, must not exceed the
//             base's
//
// A raise is sometimes right — a reviewed `kernel_test: missing` waiver (#1006 M5) is one. It
// is then a reviewer's explicit decision, not a side effect of a diff: the PR carries the
// `ratchet-raise` label, CI passes the label in (`--allow-raise`), and the raise is printed into
// the log, not hidden. Usage: node scripts/guards/ratchet-shrinks.mjs --base <git ref> [--allow-raise]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MATRIX = 'docs/contracts/capability-matrix.yaml';
const LOCATORS = 'scripts/guards/e2e-locators-baseline.json';

/** `ratchet.<key>` raises: `[{ key, base, head }]`. A key the base did not have counts from 0. */
export function matrixRaises(baseMatrix, headMatrix) {
  const base = baseMatrix?.ratchet ?? {};
  const head = headMatrix?.ratchet ?? {};
  return Object.entries(head)
    .filter(([key, count]) => count > (base[key] ?? 0))
    .map(([key, count]) => ({ key, base: base[key] ?? 0, head: count }));
}

function byText(baseline) {
  const out = new Map();
  for (const calls of Object.values(baseline ?? {})) {
    for (const [text, count] of Object.entries(calls)) out.set(text, (out.get(text) ?? 0) + count);
  }
  return out;
}

/** Locator baseline raises: per call text summed over files, then the total. */
export function locatorRaises(baseBaseline, headBaseline) {
  const base = byText(baseBaseline);
  const head = byText(headBaseline);
  const raises = [];
  for (const [text, count] of head) {
    if (count > (base.get(text) ?? 0))
      raises.push({ key: text, base: base.get(text) ?? 0, head: count });
  }
  const total = (m) => [...m.values()].reduce((n, c) => n + c, 0);
  if (total(head) > total(base))
    raises.push({ key: '(total)', base: total(base), head: total(head) });
  return raises;
}

function atRef(ref, file) {
  try {
    return execFileSync('git', ['show', `${ref}:${file}`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined; // not on the base yet: nothing to compare with
  }
}

function main() {
  const at = process.argv.indexOf('--base');
  const ref = at > 0 ? process.argv[at + 1] : undefined;
  if (!ref) {
    console.error('usage: ratchet-shrinks.mjs --base <git ref> [--allow-raise]');
    process.exit(2);
  }
  const allow = process.argv.includes('--allow-raise');
  const found = [];
  const baseMatrix = atRef(ref, MATRIX);
  if (baseMatrix !== undefined) {
    const head = parse(readFileSync(path.join(REPO_ROOT, MATRIX), 'utf8'));
    for (const r of matrixRaises(parse(baseMatrix), head)) found.push({ file: MATRIX, ...r });
  }
  const baseLocators = atRef(ref, LOCATORS);
  if (baseLocators !== undefined) {
    const head = JSON.parse(readFileSync(path.join(REPO_ROOT, LOCATORS), 'utf8'));
    for (const r of locatorRaises(JSON.parse(baseLocators), head))
      found.push({ file: LOCATORS, ...r });
  }
  for (const r of found) {
    console[allow ? 'log' : 'error'](
      `ratchet-shrinks: ${r.file}: "${r.key}" goes up ${r.base} -> ${r.head}${allow ? ' (allowed: ratchet-raise label)' : ''}`,
    );
  }
  if (found.length > 0 && !allow) {
    console.error(
      'ratchet-shrinks: test debt only goes down. Fix the new case (a kernel test, a role / label locator). If a raise is right (a reviewed waiver), a reviewer puts the `ratchet-raise` label on the PR and says why in it.',
    );
    process.exit(1);
  }
  console.log(
    `ratchet-shrinks: OK against ${ref}${found.length > 0 ? ` (${found.length} raise(s) allowed by label)` : ''}`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
