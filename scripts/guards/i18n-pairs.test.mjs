// scripts/guards/i18n-pairs.test.mjs — unit layer for the i18n-pairs guard's detectors (S8
// W1-A9, docs/development-tasks.md §5e F5); `node scripts/guards/i18n-pairs.mjs` is the
// end-to-end run against the real source tree. Node's built-in test runner, no framework.
//
// Usage: node --test scripts/guards/i18n-pairs.test.mjs

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blankComments, findViolations } from './i18n-pairs.mjs';

test('findViolations', async (t) => {
  await t.test('flags a raw JSX text pair, with a 1-based line number', () => {
    const src = ['function X() {', '  return <span>还没有消息 No messages yet</span>;', '}'].join(
      '\n',
    );
    assert.deepEqual(findViolations(src), [{ line: 2, text: '还没有消息 No messages yet' }]);
  });

  await t.test('flags a raw string literal pair outside t(...)', () => {
    const src = "const title = '已归档 Archived';";
    assert.deepEqual(findViolations(src), [{ line: 1, text: '已归档 Archived' }]);
  });

  await t.test('does not flag the zh half of a real t(zh, en) call, even with an embedded ' +
    'Latin technical term', () => {
    const src = [
      "const a = t('登出', 'Sign out');",
      "const b = t('资源 id', 'Resource id');",
      "const c = t(\n  '共享 Shared — 一份凭证',\n  'One credential',\n);",
    ].join('\n');
    assert.deepEqual(findViolations(src), []);
  });

  await t.test('does not flag a pure-CJK or pure-Latin literal', () => {
    const src = "const a = '已归档'; const b = 'Archived';";
    assert.deepEqual(findViolations(src), []);
  });

  await t.test('ignores literals inside comments', () => {
    const src = ['// 还没有消息 No messages yet', "const a = '仅中文';"].join('\n');
    assert.deepEqual(findViolations(src), []);
  });

  await t.test('does not span two unrelated JSX tags across plain statement code between ' +
    'them (regression: ChatListPage.test.tsx-shaped `<Foo />` ... code ... `<Foo />`)', () => {
    const src = [
      'render(<Harness a={1} />);',
      "expect(rows()).toEqual(['新对话']);",
      'doSomething(); somethingElse();',
      'rerender(<Harness a={2} />);',
    ].join('\n');
    assert.deepEqual(findViolations(src), []);
  });

  await t.test('a JSX text pair split across lines is still one match', () => {
    const src = ['<p>', '  还没有权限\n  No permission yet', '</p>'].join('\n');
    assert.deepEqual(findViolations(src), [{ line: 1, text: '还没有权限 No permission yet' }]);
  });
});

test('blankComments', () => {
  const src = '// 打开 Explorer\nconst a = 1; /* 关闭 Close */';
  const blanked = blankComments(src);
  assert.ok(!blanked.includes('打开'));
  assert.ok(!blanked.includes('关闭'));
  assert.equal(blanked.split('\n').length, src.split('\n').length);
});
