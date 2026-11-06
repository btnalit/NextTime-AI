// e2e-locators.mjs — an e2e test clicks, types and picks what a person sees
// (docs/test-coverage-gaps-2026-11-06.md §5.2, gap G1, batch B).
//
// Legacy 646: a journey picked the grant form's member with `getByTestId('ggf-member-select')
// .selectOption(id)` — a bare <select> with no visible label — while people used the search box
// labelled 「成员」, which did not work. The test was green; the console was broken. So:
//
//   L1  the target of an interaction (click, dblclick, fill, type, press, pressSequentially,
//       selectOption, check, uncheck, setChecked, setInputFiles, clear) must come from
//       getByRole / getByLabel / getByText / getByPlaceholder / getByAltText / getByTitle.
//       getByTestId and CSS `locator()` may scope (`drawer.getByRole('combobox', { name: '成员' })`)
//       and assert (`expect(row.getByTestId('x')).toBeVisible()`), never be the thing acted on.
//   L2  no page-level selector actions (`page.click('#x')`, `page.fill(sel, …)`,
//       `page.selectOption(sel, …)`): they bypass locators altogether.
//
// A control a test cannot reach by role or label has no accessible name — that is the defect to
// fix in the console, not in the test. What this cannot see: a target passed in as a function
// parameter or built across files is "unknown" and not reported (the reviewer's to catch).
//
// Existing violations are listed in scripts/guards/e2e-locators-baseline.json, by file and the
// text of the call (not line numbers), and can only go away: a new one fails, and a listed one
// that is gone fails until it is removed from the baseline (`--update-baseline` rewrites it from
// the current code — only ever to shrink it; the diff shows if it grew).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const BASELINE_PATH = 'scripts/guards/e2e-locators-baseline.json';

const ACTIONS = new Set([
  'click',
  'dblclick',
  'fill',
  'type',
  'press',
  'pressSequentially',
  'selectOption',
  'check',
  'uncheck',
  'setChecked',
  'setInputFiles',
  'clear',
]);
const VISIBLE = new Set([
  'getByRole',
  'getByLabel',
  'getByText',
  'getByPlaceholder',
  'getByAltText',
  'getByTitle',
]);
const HIDDEN = new Set(['getByTestId', 'locator']);
// Narrowing a locator keeps what it was found by.
const PASSTHROUGH = new Set(['first', 'last', 'nth', 'filter', 'and', 'or']);

function calleeName(call) {
  return ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : undefined;
}

/** Every `const|let name = <initializer>` in the file; a name declared twice is ambiguous. */
function collectDeclarations(sourceFile) {
  const declarations = new Map();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const name = node.name.text;
      declarations.set(name, declarations.has(name) ? null : node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return declarations;
}

/** 'visible' | 'hidden' | 'unknown' — how the locator `expr` was found. */
export function classify(expr, declarations, seen = new Set()) {
  let node = expr;
  for (;;) {
    while (
      ts.isParenthesizedExpression(node) ||
      ts.isAwaitExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isAsExpression(node)
    ) {
      node = node.expression;
    }
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name && VISIBLE.has(name)) return 'visible';
      if (name && HIDDEN.has(name)) return 'hidden';
      if (name && PASSTHROUGH.has(name) && ts.isPropertyAccessExpression(node.expression)) {
        node = node.expression.expression;
        continue;
      }
      return 'unknown';
    }
    if (ts.isIdentifier(node)) {
      const initializer = declarations.get(node.text);
      if (!initializer || seen.has(node.text)) return 'unknown';
      seen.add(node.text);
      node = initializer;
      continue;
    }
    return 'unknown';
  }
}

function isPageLike(expr) {
  return ts.isIdentifier(expr) && /^(page|popup|newPage|\w+Page)$/.test(expr.text);
}

/** Violations in one file: `{ rule, text, line }`. */
export function findViolations(fileName, sourceText) {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declarations = collectDeclarations(sourceFile);
  const out = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const action = node.expression.name.text;
      const target = node.expression.expression;
      if (ACTIONS.has(action)) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        const text = node.getText(sourceFile).replace(/\s+/g, ' ');
        if (isPageLike(target) && node.arguments.length > 0 && action !== 'press') {
          out.push({ rule: 'L2', text, line });
        } else if (classify(target, declarations) === 'hidden') {
          out.push({ rule: 'L1', text, line });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

/** `{ "<file>": { "<call text>": count } }` → the violations not covered, and the stale entries. */
export function compareWithBaseline(found, baseline) {
  const fresh = [];
  const stale = [];
  const files = new Set([...Object.keys(found), ...Object.keys(baseline)]);
  for (const file of files) {
    const now = new Map();
    for (const v of found[file] ?? []) now.set(v.text, [...(now.get(v.text) ?? []), v]);
    const allowed = baseline[file] ?? {};
    for (const [text, list] of now) {
      const room = allowed[text] ?? 0;
      for (const v of list.slice(room)) fresh.push({ file, ...v });
    }
    for (const [text, count] of Object.entries(allowed)) {
      const have = now.get(text)?.length ?? 0;
      if (have < count) stale.push({ file, text, count, have });
    }
  }
  return { fresh, stale };
}

export function toBaseline(found) {
  const out = {};
  for (const file of Object.keys(found).sort()) {
    if (found[file].length === 0) continue;
    const counts = {};
    for (const v of found[file]) counts[v.text] = (counts[v.text] ?? 0) + 1;
    out[file] = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  }
  return out;
}

function main() {
  const files = execFileSync(
    'git',
    ['ls-files', '--', 'packages/web/e2e/*.ts', 'packages/web/e2e/**/*.ts'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    },
  )
    .split('\n')
    .filter((file) => file.length > 0);
  const found = {};
  for (const file of files) {
    found[file] = findViolations(file, readFileSync(path.join(REPO_ROOT, file), 'utf8'));
  }
  if (process.argv.includes('--update-baseline')) {
    writeFileSync(
      path.join(REPO_ROOT, BASELINE_PATH),
      `${JSON.stringify(toBaseline(found), null, 2)}\n`,
    );
    console.log(`e2e-locators: wrote ${BASELINE_PATH} — it may only ever shrink; read the diff`);
    return;
  }
  let baseline = {};
  try {
    baseline = JSON.parse(readFileSync(path.join(REPO_ROOT, BASELINE_PATH), 'utf8'));
  } catch {
    // no baseline: every violation is new
  }
  const { fresh, stale } = compareWithBaseline(found, baseline);
  for (const v of fresh) {
    console.error(
      `e2e-locators: ${v.file}:${v.line} ${v.rule} ${v.text}\n  act on what a person sees: getByRole / getByLabel (scope with getByTestId if needed). A control with no accessible name is a console bug to fix.`,
    );
  }
  for (const s of stale) {
    console.error(
      `e2e-locators: ${s.file}: the baseline allows ${s.count} of "${s.text}", the code has ${s.have} — remove it from ${BASELINE_PATH} (node scripts/guards/e2e-locators.mjs --update-baseline)`,
    );
  }
  if (fresh.length > 0 || stale.length > 0) process.exit(1);
  const total = Object.values(found).reduce((n, list) => n + list.length, 0);
  console.log(
    `e2e-locators: OK (${files.length} files; ${total} baselined interactions left to move to role / label)`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
