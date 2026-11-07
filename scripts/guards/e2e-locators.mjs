// e2e-locators.mjs — an e2e test clicks, types and picks what a person sees
// (docs/test-coverage-gaps-2026-11-06.md §5.2, gap G1, batch B).
//
// Legacy 646: a journey picked the grant form's member with `getByTestId('ggf-member-select')
// .selectOption(id)` — a bare <select> with no visible label — while people used the search box
// labelled 「成员」, which did not work. The test was green; the console was broken. So:
//
//   L1  the target of an interaction (click, dblclick, fill, type, press, pressSequentially,
//       selectOption, check, uncheck, setChecked, setInputFiles, clear, hover, tap, dragTo,
//       dispatchEvent) must come from
//       getByRole / getByLabel / getByText / getByPlaceholder / getByAltText / getByTitle.
//       getByTestId and CSS `locator()` may scope (`drawer.getByRole('combobox', { name: '成员' })`)
//       and assert (`expect(row.getByTestId('x')).toBeVisible()`), never be the thing acted on.
//   L2  no page-level selector actions (`page.click('#x')`, `page.fill(sel, …)`,
//       `page.press(sel, key)`, `page.selectOption(sel, …)`): they bypass locators altogether.
//       (`page.keyboard.press(key)` is not one.)
//   L3  no interaction inside the page's own JavaScript (legacy 655): an `evaluate`,
//       `evaluateAll`, `evaluateHandle`, `$eval` or `$$eval` whose function calls `click()`,
//       `dblclick()`, `dispatchEvent()`, `submit()` or `requestSubmit()`, or sets `value`,
//       `checked`, `selected`, `selectedIndex` or `files` — or whose string does. That clicks a
//       control whether or not anyone could see or reach it, the same blind spot L1 closes.
//       Reading the page in `evaluate` (`el => el.textContent`) is fine.
//
// A control a test cannot reach by role or label has no accessible name — that is the defect to
// fix in the console, not in the test. A variable is traced to its declaration in the nearest
// enclosing scope (each test's own `const row = …`). What this cannot see: a target passed in as
// a function parameter, built across files, or declared twice in one scope is "unknown" and not
// reported (the reviewer's to catch).
//
// Existing violations are listed in scripts/guards/e2e-locators-baseline.json, by file and the
// text of the call (not line numbers), and can only go away: a new one fails, and a listed one
// that is gone fails until it is removed from the baseline (`--update-baseline` rewrites it from
// the current code — only ever to shrink it; the diff shows if it grew). The key is the call's
// text with whitespace collapsed, so editing a baselined call — or a formatter rewrapping it
// differently — makes it a new violation: move it to role / label then, don't re-baseline it.
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
  'hover',
  'tap',
  'dragTo',
  'dispatchEvent',
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

function isScope(node) {
  return (
    ts.isSourceFile(node) ||
    ts.isBlock(node) ||
    ts.isCaseBlock(node) ||
    ts.isModuleBlock(node) ||
    ts.isForStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isFunctionLike(node)
  );
}

function enclosingScope(node) {
  let scope = node.parent;
  while (scope && !isScope(scope)) scope = scope.parent;
  return scope;
}

/**
 * Every `const|let|var name = <initializer>`, keyed by the scope that declares it (a block, a
 * function, a `for`, the file): each `test()` body that writes its own `const row = …` gets its
 * own entry. A name declared twice in one scope is ambiguous (null).
 */
function collectDeclarations(sourceFile) {
  const scopes = new Map();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const scope = enclosingScope(node);
      if (!scopes.has(scope)) scopes.set(scope, new Map());
      const names = scopes.get(scope);
      const name = node.name.text;
      names.set(name, names.has(name) ? null : node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return scopes;
}

/** The initializer `identifier` refers to where it is used: the nearest scope that declares it.
 *  A parameter of that name on the way up shadows anything outside it (unknown). */
function resolve(identifier, scopes) {
  const name = identifier.text;
  for (let node = identifier.parent; node; node = node.parent) {
    if (!isScope(node)) continue;
    const declared = scopes.get(node)?.get(name);
    if (declared !== undefined) return declared;
    if (
      ts.isFunctionLike(node) &&
      node.parameters?.some((p) => ts.isIdentifier(p.name) && p.name.text === name)
    ) {
      return null;
    }
  }
  return null;
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
      const initializer = resolve(node, declarations);
      if (!initializer || seen.has(initializer)) return 'unknown';
      seen.add(initializer);
      node = initializer;
      continue;
    }
    return 'unknown';
  }
}

/** L3 (legacy 655): the page-side functions of these run inside the page. */
const EVALUATE = new Set(['evaluate', 'evaluateAll', 'evaluateHandle', '$eval', '$$eval']);
/** What, done from page-side JavaScript, acts on a control instead of looking at it. */
const DOM_ACTIONS = new Set(['click', 'dblclick', 'dispatchEvent', 'submit', 'requestSubmit']);
const DOM_SETTERS = new Set(['value', 'checked', 'selected', 'selectedIndex', 'files']);
const DOM_ACTION_TEXT = new RegExp(
  `\\.(?:(?:${[...DOM_ACTIONS].join('|')})\\s*\\(|(?:${[...DOM_SETTERS].join('|')})\\s*=(?!=))`,
);

/** Whether `node` (an `evaluate`'s argument) clicks, submits or sets a control's state. */
function actsOnPage(node) {
  if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
    return DOM_ACTION_TEXT.test(node.getText());
  }
  let found = false;
  const visit = (child) => {
    if (found) return;
    if (
      ts.isCallExpression(child) &&
      ts.isPropertyAccessExpression(child.expression) &&
      DOM_ACTIONS.has(child.expression.name.text)
    ) {
      found = true;
      return;
    }
    if (
      ts.isBinaryExpression(child) &&
      child.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(child.left) &&
      DOM_SETTERS.has(child.left.name.text)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  if (ts.isFunctionLike(node)) visit(node);
  return found;
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
      if (EVALUATE.has(action) && node.arguments.some(actsOnPage)) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        out.push({ rule: 'L3', text: node.getText(sourceFile).replace(/\s+/g, ' '), line });
      }
      if (ACTIONS.has(action)) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        const text = node.getText(sourceFile).replace(/\s+/g, ' ');
        if (isPageLike(target) && node.arguments.length > 0) {
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
      `e2e-locators: ${v.file}:${v.line} ${v.rule} ${v.text}\n  act on what a person sees: getByRole / getByLabel (scope with getByTestId if needed)${v.rule === 'L3' ? ', with a Playwright action (click / fill / check), not page-side JavaScript' : ''}. A control with no accessible name is a console bug to fix.`,
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
