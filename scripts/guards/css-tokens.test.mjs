// scripts/guards/css-tokens.test.mjs — unit layer for the css-tokens guard's detectors
// (S6-A0, docs/console-completion-plan.md §5.9 "验收"; S8 W1-A0 extension, docs/development-
// tasks.md §5e decision F3 / risk ①); `node scripts/guards/css-tokens.mjs` is the end-to-end run
// against the real stylesheets and source tree. Node's built-in test runner, no framework.
//
// Usage: node --test scripts/guards/css-tokens.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  EXEMPT_FILES,
  KIT_DIR,
  UI_DIR,
  blankComments,
  blankJsComments,
  findArbitraryValueViolations,
  findLegacyUiImports,
  findViolations,
  listWebSourceFiles,
  loadLegacyUiAllowlist,
  toRepoRelativePosix,
} from './css-tokens.mjs';

test('findViolations', async (t) => {
  await t.test('flags hex, rgb()/rgba()/hsl() and px font-size, with 1-based line numbers', () => {
    const css = [
      '.a {',
      '  color: #fff;',
      '  background: rgba(0, 0, 0, 0.4);',
      '  font-size: 12.5px;',
      '}',
    ].join('\n');
    assert.deepEqual(findViolations(css), [
      { line: 2, text: '#fff' },
      { line: 3, text: 'rgba(' },
      { line: 4, text: 'font-size: 12.5px' },
    ]);
  });
  await t.test('passes token references, id selectors, and non-px sizes', () => {
    const css = [
      '#root { min-height: 100vh; }',
      '.b { color: var(--text); font-size: var(--fs-13); line-height: 16px; }',
      '.c { font-size: 0.875rem; box-shadow: var(--shadow-1); }',
    ].join('\n');
    assert.deepEqual(findViolations(css), []);
  });
  await t.test('ignores literals inside comments (a rationale may quote a hex value)', () => {
    const css = '/* was #fff before S6-A0 */\n.d { color: var(--text-on-accent); }';
    assert.deepEqual(findViolations(css), []);
    assert.equal(blankComments(css).split('\n').length, 2);
  });
});

test('only tokens.css and fonts.css are exempt', () => {
  assert.deepEqual([...EXEMPT_FILES].sort(), ['fonts.css', 'tokens.css']);
});

test('blankJsComments', async (t) => {
  await t.test('blanks block and line comments, keeping line numbers', () => {
    const source = ['const a = 1; // bg-[#fff]', '/* text-[13px] */', 'const b = 2;'].join('\n');
    const blanked = blankJsComments(source);
    assert.equal(blanked.split('\n').length, 3);
    assert.equal(blanked.includes('bg-['), false);
    assert.equal(blanked.includes('text-['), false);
    assert.equal(blanked.includes('const b = 2;'), true);
  });
});

test('findArbitraryValueViolations', async (t) => {
  await t.test('flags hex, rgb/hsl and px/rem bracketed values', () => {
    const source = [
      'const a = <div className="bg-[#fff]" />;',
      'const b = <div className="text-[13px] p-[1.5rem]" />;',
      'const c = <div className="shadow-[rgba(0,0,0,.4)]" />;',
    ].join('\n');
    const found = findArbitraryValueViolations(source).map((v) => v.text);
    assert.deepEqual(found, ['bg-[#fff]', 'text-[13px]', 'p-[1.5rem]', 'shadow-[rgba(0,0,0,.4)]']);
  });
  await t.test('passes ordinary utilities, token-named classes and array/index syntax', () => {
    const source = [
      'const a = <div className="bg-accent text-13 rounded-m" />;',
      'const items = list[0];',
      'const arr = [1, 2, 3];',
    ].join('\n');
    assert.deepEqual(findArbitraryValueViolations(source), []);
  });
  await t.test('ignores a value quoted only in a comment', () => {
    const source = '// bg-[#fff] was the old way\nconst a = <div className="bg-accent" />;';
    assert.deepEqual(findArbitraryValueViolations(source), []);
  });
});

test('findLegacyUiImports', async (t) => {
  await t.test('matches ./ui/, ../ui/ and nested components/ui/ specifiers', () => {
    const source = [
      "import { Button } from './ui/Button.js';",
      "import { Card } from '../ui/Card.js';",
      "import { Toast } from '../../components/ui/Toast.js';",
    ].join('\n');
    assert.deepEqual(
      findLegacyUiImports(source).map((v) => v.text),
      ['./ui/Button.js', '../ui/Card.js', '../../components/ui/Toast.js'],
    );
  });
  await t.test('ignores a commented-out import and non-ui imports', () => {
    const source = [
      "// import { Button } from './ui/Button.js';",
      "import { cn } from '../../lib/cn.js';",
    ].join('\n');
    assert.deepEqual(findLegacyUiImports(source), []);
  });
});

test('loadLegacyUiAllowlist: every entry is a packages/web/src path, sorted, unique', () => {
  const list = [...loadLegacyUiAllowlist()];
  assert.ok(list.length > 0);
  assert.deepEqual(list, [...new Set(list)].sort());
  for (const entry of list) {
    assert.ok(entry.startsWith('packages/web/src/'), `unexpected entry: ${entry}`);
  }
});

test('end-to-end: the current web source tree has no violations the CLI run would not already catch', async (t) => {
  await t.test('no Tailwind arbitrary-value literal in packages/web/src', () => {
    const offenders = listWebSourceFiles().filter(
      (file) => findArbitraryValueViolations(readFileSync(file, 'utf8')).length > 0,
    );
    assert.deepEqual(offenders, []);
  });

  await t.test(
    'every current components/ui importer outside ui/ itself is on the allowlist',
    () => {
      const allowlist = loadLegacyUiAllowlist();
      const missing = listWebSourceFiles()
        .filter((file) => findLegacyUiImports(readFileSync(file, 'utf8')).length > 0)
        .map(toRepoRelativePosix)
        .filter((rel) => rel !== UI_DIR && !rel.startsWith(`${UI_DIR}/`))
        .filter((rel) => !allowlist.has(rel));
      assert.deepEqual(missing, []);
    },
  );

  await t.test('components/kit itself never imports the legacy components/ui', () => {
    const offenders = listWebSourceFiles()
      .filter((file) => toRepoRelativePosix(file).startsWith(`${KIT_DIR}/`))
      .filter((file) => findLegacyUiImports(readFileSync(file, 'utf8')).length > 0)
      .map(toRepoRelativePosix);
    assert.deepEqual(offenders, []);
  });
});
