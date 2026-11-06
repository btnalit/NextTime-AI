// e2e-fixture.mjs — every e2e test runs on packages/web/e2e/lib/test.ts's `test`
// (docs/test-coverage-gaps-2026-11-06.md §5.3, gap G5, batch B2).
//
// lib/test.ts adds an automatic fixture that records each capability call a page makes; the end
// of the `web-e2e` job holds the capability matrix's `e2e: observed` rows to those records (rule
// M4, scripts/guards/capability-matrix.mjs). A spec that takes Playwright's own `test` instead
// still passes, but its calls go unrecorded, and a capability only it covers reads as untested:
//
//   E1  under packages/web/e2e, only lib/test.ts imports the value `test` from '@playwright/test'
//       (also `test as x`, a namespace or default import, `require`, a dynamic `import()`).
//       Types (`import type { Page }`, `type Page`) and `expect` may come from either.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PLAYWRIGHT = '@playwright/test';
export const FIXTURE_FILE = 'packages/web/e2e/lib/test.ts';

/** E1 over one file: `[{ line, text }]`. */
export function findViolations(fileName, sourceText) {
  if (fileName === FIXTURE_FILE) return [];
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const out = [];
  const report = (node, why) =>
    out.push({
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      text: `${why}: ${node.getText(source).replace(/\s+/g, ' ')}`,
    });
  const visit = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === PLAYWRIGHT
    ) {
      const clause = node.importClause;
      if (clause && !clause.isTypeOnly) {
        if (clause.name) report(node, 'default import');
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) report(node, 'namespace import');
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const imported = (element.propertyName ?? element.name).text;
            if (imported === 'test' && !element.isTypeOnly)
              report(node, "imports Playwright's test");
          }
        }
      }
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === PLAYWRIGHT
    ) {
      report(node, 'loads @playwright/test at run time');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

function main() {
  const files = execFileSync(
    'git',
    ['ls-files', '--', 'packages/web/e2e/*.ts', 'packages/web/e2e/**/*.ts'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  )
    .split('\n')
    .filter((file) => file.length > 0);
  let count = 0;
  for (const file of files) {
    for (const v of findViolations(file, readFileSync(path.join(REPO_ROOT, file), 'utf8'))) {
      count += 1;
      const fixture = path.posix
        .relative(path.posix.dirname(file), FIXTURE_FILE)
        .replace(/\.ts$/, '.js');
      console.error(
        `e2e-fixture: ${file}:${v.line} E1 ${v.text}\n  import { test, expect } from '${fixture.startsWith('.') ? fixture : `./${fixture}`}' — that test records which capabilities the console called (capability matrix M4)`,
      );
    }
  }
  if (count > 0) process.exit(1);
  console.log(`e2e-fixture: OK (${files.length} files on ${FIXTURE_FILE}'s test)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
