// scripts/guards/css-tokens.test.mjs — unit layer for the css-tokens guard's detectors
// (S6-A0, docs/console-completion-plan.md §5.9 "验收"); `node scripts/guards/css-tokens.mjs`
// is the end-to-end run against the real stylesheets. Node's built-in test runner, no framework.
//
// Usage: node --test scripts/guards/css-tokens.test.mjs

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXEMPT_FILES, blankComments, findViolations } from './css-tokens.mjs';

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
