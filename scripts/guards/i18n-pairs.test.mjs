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

  await t.test('flags a zh half that ends in full-width punctuation directly against the ' +
    'English tail, with no space (S8 W1-A10 fix)', () => {
    const src = [
      'function X() {',
      '  return <span>继承（不覆盖）Inherit workspace default</span>;',
      '}',
    ].join('\n');
    assert.deepEqual(findViolations(src), [
      { line: 2, text: '继承（不覆盖）Inherit workspace default' },
    ]);
  });

  await t.test('still does not flag a CJK label glued to a non-punctuation Latin/numeric run ' +
    '(no language boundary implied)', () => {
    const src = "const a = '版本v2.0.1';";
    assert.deepEqual(findViolations(src), []);
  });
});

test('blankComments', () => {
  const src = '// 打开 Explorer\nconst a = 1; /* 关闭 Close */';
  const blanked = blankComments(src);
  assert.ok(!blanked.includes('打开'));
  assert.ok(!blanked.includes('关闭'));
  assert.equal(blanked.split('\n').length, src.split('\n').length);
});

// S8 W1-A12 (batch design review round 2): two shapes that slipped past the original two
// detectors above — (c) English-only UI copy with no Chinese at all, (d) a CJK sentence with its
// full English translation glued into the same literal instead of split across `t()`'s two
// arguments. Both are exercised through the public `findViolations(source, { isTestFile })`, the
// same way (a)/(b) are above — the internal helpers (`isEnglishPhrase`, `looksLikeCode`,
// `hasGluedEnglishSentence`, `computeInsideTMap`) are deliberately not exported, same convention
// as `isUnsplitPair`.
test('findViolations — (c) English-only JSX text/attribute', async (t) => {
  await t.test('flags a JSX text run of 3+ English words with no CJK', () => {
    const src = 'function X() { return <p>No messages yet here</p>; }';
    assert.deepEqual(findViolations(src), [{ line: 1, text: 'No messages yet here' }]);
  });

  await t.test('flags a user-facing attribute (title/aria-label/placeholder/label/description/' +
    'hint/subtitle) that is a plain English string literal', () => {
    const src = 'const x = <Button aria-label="Back to the chat list" />;';
    assert.deepEqual(findViolations(src), [{ line: 1, text: 'Back to the chat list' }]);
  });

  await t.test('does not flag an attribute name outside the tracked list', () => {
    const src = 'const x = <Button data-tip="Back to the chat list" />;';
    assert.deepEqual(findViolations(src), []);
  });

  await t.test('does not flag an attribute whose value is a {t(...)} expression (never a plain ' +
    'quoted string in the first place)', () => {
    const src = "const x = <Button aria-label={t('返回', 'Back to the chat list')} />;";
    assert.deepEqual(findViolations(src), []);
  });

  await t.test('does not flag fewer than 3 words, or a single snake_case identifier token', () => {
    const src = [
      'const a = <p>Load more</p>;',
      "const b = <Button title='grant_capability_now' />;",
    ].join('\n');
    assert.deepEqual(findViolations(src), []);
  });

  await t.test('does not flag a JSX text run that looks like code (parens/braces/equals/dotted ' +
    'member access) — a brace/semicolon-free span between two unrelated tags can still capture a ' +
    'ternary chain or a TS type signature, the same false-span risk (a)/(b) guard against', () => {
    const src =
      "const x = <A /> ) : llmAdminErrorMessage(list.state.error, t) !== null ? ( <B />;";
    assert.deepEqual(findViolations(src), []);
  });

  await t.test('does not flag a JSX text run that is lexically inside a t(...) call, however ' +
    'deeply nested (JSX fragments, other elements, in between)', () => {
    const src = [
      'function X() {',
      '  return (',
      '    <Notice>',
      '      {t(',
      '        <>还没有连接申请</>,',
      '        <>',
      '          No open connection requests right now',
      '        </>,',
      '      )}',
      '    </Notice>',
      '  );',
      '}',
    ].join('\n');
    assert.deepEqual(findViolations(src), []);
  });

  await t.test('skips *.test.ts(x) files entirely — assertions/fixtures are not rendered UI ' +
    'copy', () => {
    const src = "expect(screen.getByText('No open connection requests')).toBeTruthy();";
    assert.deepEqual(findViolations(src, { isTestFile: true }), []);
  });
});

test('findViolations — (d) a CJK sentence glued to its own English translation', async (t) => {
  await t.test('flags a string whose Latin tail (after the last CJK ideograph) is a 4+ word ' +
    'sentence, even as the first argument of a t(...) call', () => {
    const src =
      "const hint = t('已达到单次读取上限 Reached the per-page limit, keep loading to see more', 'x');";
    assert.deepEqual(findViolations(src), [
      { line: 1, text: '已达到单次读取上限 Reached the per-page limit, keep loading to see more' },
    ]);
  });

  await t.test('flags a plain string never routed through t() at all', () => {
    const src =
      "const hint = '一句话说明何时用它。 One line on when to use it, kept fairly short here.';";
    assert.deepEqual(findViolations(src), [
      {
        line: 1,
        text: '一句话说明何时用它。 One line on when to use it, kept fairly short here.',
      },
    ]);
  });

  await t.test('does not flag a short embedded technical term (< 4 words) — the established ' +
    '`t(\'资源 id\', \'Resource id\')` shape stays legitimate', () => {
    const src = "const a = t('共享 Shared — 一份凭证', 'One credential');";
    assert.deepEqual(findViolations(src), []);
  });

  await t.test('does not flag a Chinese sentence whose trailing command tail (4+ words, but a ' +
    'path segment or a --flag, not prose) is legitimately embedded, not a translation duplicate', () => {
    const src = [
      // Real false-positive this guard must not repeat (PlatformModelsPage's store-unwritable
      // notice, W1-A12): the tail is a shell command with a `--flag`, not an English sentence.
      // Wrapped in `t(...)` like the real call site — (b)'s own short-pair check would otherwise
      // flag the un-split "请在主机上运行 docker compose…" shape on its own merits.
      "const a = t('请在主机上运行 docker compose up -d --force-recreate llm-proxy', 'x');",
      // A `.ext`-shaped token in the tail.
      "const b = t('请在主机上运行 scripts/host-llm-proxy-init.sh on the host now', 'y');",
    ].join('\n');
    assert.deepEqual(findViolations(src), []);
  });

  await t.test('skips *.test.ts(x) files entirely — the string is wrapped in t(...) so only ' +
    '(d) itself would otherwise flag it (see the JSX-text test above for (a)/(b) unconditionally ' +
    'still scanning test files)', () => {
    const src =
      "const a = t('已达到单次读取上限 Reached the per-page limit, keep loading to see more', 'x');";
    assert.deepEqual(findViolations(src, { isTestFile: true }), []);
  });
});

// S8 W4 item 5 (leftover 85 "i18n 守卫不查插值模板里的中英对"): (e) runs (b)'s short-pair check and
// (d)'s glued-sentence check against a template literal's *flattened* static text (every
// `${...}` replaced with a single space). Exercised through the public `findViolations` the same
// way (a)-(d) are above.
test('findViolations — (e) a glued zh/en pair inside a template literal', async (t) => {
  await t.test('flags the short-pair shape with a `${}` interpolation in the middle, the task’s ' +
    'own example ("弃用 ${x} Deprecate ${x}")', () => {
    const src = 'const a = `弃用 ${name} Deprecate ${name}`;';
    assert.deepEqual(findViolations(src), [{ line: 1, text: '弃用 Deprecate' }]);
  });

  await t.test('flags a glued-sentence tail (4+ words) split across static segments by an ' +
    'interpolation', () => {
    const src =
      'const a = `已导出 ${rows.length} 条审计记录 Exported ${rows.length} audit rows`;';
    assert.deepEqual(findViolations(src), [
      { line: 1, text: '已导出 条审计记录 Exported audit rows' },
    ]);
  });

  await t.test('does not flag a template literal whose only English is inside the ' +
    'interpolation expressions themselves (member access, function calls) — the static text ' +
    'carries no Latin tail', () => {
    const src =
      'const a = `${usage.calls} 调用 · ${usage.approved} 批准 · ${formatRelative(usage.at)}`;';
    assert.deepEqual(findViolations(src), []);
  });

  await t.test('does not flag the zh half of a real t(zh, en) call built from template ' +
    'literals, even with a shared interpolation', () => {
    const src =
      "const a = t(`已发布 ${n} 个 Operation`, `Published ${n} operations`);";
    assert.deepEqual(findViolations(src), []);
  });

  await t.test('correctly tracks a nested template literal inside an interpolation expression ' +
    '(a ternary choosing between two backtick strings) without corrupting the outer scan — a ' +
    'pure-CJK outer static text plus an English plural suffix nested inside is not a violation', () => {
    const src =
      'const a = `${n} workspace${n === 1 ? `` : `s`} 已启用（各自的连接见系统接入页）。`;';
    assert.deepEqual(findViolations(src), []);
  });

  await t.test('does not corrupt outer-template tracking when a nested template literal’s own ' +
    'static text, once flattened, does glue a pair — the nested one is scanned as its own ' +
    'independent span, and both are found', () => {
    const src = 'const a = `${flag ? `已弃用 Deprecated` : `活跃 Active`}`;';
    assert.deepEqual(findViolations(src), [
      { line: 1, text: '已弃用 Deprecated' },
      { line: 1, text: '活跃 Active' },
    ]);
  });

  await t.test('skips *.test.ts(x) files entirely', () => {
    const src = 'const a = `弃用 ${name} Deprecate ${name}`;';
    assert.deepEqual(findViolations(src, { isTestFile: true }), []);
  });
});
