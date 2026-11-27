// Unit tests for scripts/guards/loop-ledger.mjs. They use fixtures only: the guard itself runs
// against the real docs in the `guards` job, which also runs on docs-only changes (this file's
// job does not).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  budgetRaises,
  compareVersions,
  hostStepTag,
  isReleaseBlocker,
  lintBudgets,
  lintConfig,
  lintHostVersion,
  lintLegacy,
  lintReleaseSections,
  parseLegacyTable,
  releaseSections,
  rowState,
  rowTier,
  splitRow,
} from './loop-ledger.mjs';

const LEGACY = { tierRequiredFromId: 821, inStageWipCap: 20, weeklyNewP3Soft: 10, grandfathered: {} };

const table = (...rows) =>
  ['## 3. 当前波次', '| 1 | not in the table | P3 | x | 开放 |', '## 4. 遗留清单', '', '| # | 项 | 级别 | 归属 | 状态 |', '|---|---|---|---|---|', ...rows, '', '## 5. 更新规则', '| 9 | after the table | P3 | x | 开放 |'].join('\n');

const row = (id, status, level = 'P3', item = 'item') => `| ${id} | ${item} | ${level} | lane | ${status} |`;

test('splitRow: an escaped pipe stays in its cell, an unescaped one splits it', () => {
  assert.deepEqual(splitRow('| 1 | a \\| b | P3 | x | 开放 |'), ['1', 'a \\| b', 'P3', 'x', '开放']);
  assert.equal(splitRow('| 1 | `a | b` | P3 | x | 开放 |').length, 6);
});

test('parseLegacyTable reads only the rows of the legacy section', () => {
  const rows = parseLegacyTable(table(row(10, '开放'), row(48, '部分关闭（#1）')));
  assert.deepEqual(
    rows.map((r) => [r.id, r.level, r.status]),
    [
      [10, 'P3', '开放'],
      [48, 'P3', '部分关闭（#1）'],
    ],
  );
  assert.throws(() => parseLegacyTable('## 3. 当前波次\n'), /遗留清单/);
});

test('rowState: known prefixes, bold markers ignored, a different word is not a state', () => {
  assert.equal(rowState('开放（挂起：等 pi）'), 'open');
  assert.equal(rowState('**已接受**（维护者）'), 'accepted');
  assert.equal(rowState('已关闭（#5）'), 'closed');
  assert.equal(rowState('关闭（#5）'), 'closed');
  assert.equal(rowState('部分关闭（#5）'), 'partial');
  assert.equal(rowState('待主机 验收'), 'awaiting_host');
  assert.equal(rowState('开放·推迟（先不做）'), undefined);
  assert.equal(rowState('代码已合入（#479）'), undefined);
});

test('rowTier: the two tiers, and a parked row needs its reason', () => {
  assert.equal(rowTier('开放（阶段内处理：排在 926 之后）'), 'in_stage');
  assert.equal(rowTier('开放（阶段内处理）'), 'in_stage');
  assert.equal(rowTier('开放（挂起：只多遮）'), 'parked');
  assert.equal(rowTier('开放（挂起：）'), undefined);
  assert.equal(rowTier('开放（#493 审查记录）'), undefined);
});

test('lintLegacy: a clean table passes; an empty one does not', () => {
  const rows = parseLegacyTable(
    table(row(10, '开放', '功能缺口'), row(820, '开放（#1 记录）'), row(821, '开放（挂起：只是排版）'), row(822, '开放', 'P2')),
  );
  assert.deepEqual(lintLegacy(rows, LEGACY), []);
  assert.match(lintLegacy([], LEGACY)[0], /no rows/);
});

test('lintLegacy: each rule reports the row that breaks it', () => {
  const broken = parseLegacyTable(
    table(
      row(5, '开放', 'P3', '`a | b`'), // cells
      row(6, '开放', 'P9'), // level
      row(7, '代码已合入（#1）'), // state
      row(900, '开放（#1 记录）'), // tier
      row(900, '开放（挂起：重复的号）'), // order
    ),
  );
  const problems = lintLegacy(broken, LEGACY);
  assert.equal(problems.length, 5);
  assert.match(problems[0], /legacy 5 .*6 cells/);
  assert.match(problems[1], /legacy 6 .*level "P9"/);
  assert.match(problems[2], /legacy 7 .*status must start/);
  assert.match(problems[3], /legacy 900 .*tier/);
  assert.match(problems[4], /legacy 900 .*ascend/);
});

test('lintLegacy: the tier rule is for open P3 rows from tierRequiredFromId on', () => {
  const rows = parseLegacyTable(
    table(row(820, '开放'), row(821, '开放', 'P2'), row(822, '部分关闭（#1）'), row(823, '已接受（#1）')),
  );
  assert.deepEqual(lintLegacy(rows, LEGACY), []);
});

test('lintLegacy: a grandfathered row is skipped only for its rule, and the list shrinks', () => {
  const rows = parseLegacyTable(table(row(7, '代码已合入（#1）'), row(8, '开放')));
  const legacy = (grandfathered) => ({ ...LEGACY, grandfathered });
  assert.deepEqual(lintLegacy(rows, legacy({ 7: 'state' })), []);
  assert.match(lintLegacy(rows, legacy({ 7: 'cells' }))[0], /legacy 7 .*status must start/);
  // 8 is clean and 9 is not in the table: both entries have to go.
  const stale = lintLegacy(rows, legacy({ 7: 'state', 8: 'state', 9: 'cells' }));
  assert.equal(stale.length, 2);
  assert.match(stale[0], /grandfathered\["8"\].*remove the entry/);
  assert.match(stale[1], /grandfathered\["9"\].*remove the entry/);
});

test('isReleaseBlocker: the mark counts only on a row that is still open', () => {
  const [open, closed, plain] = parseLegacyTable(
    table(row(1, '开放（发版前必须关闭）'), row(2, '已关闭（#3；曾标发版前必须关闭）'), row(3, '开放')),
  );
  assert.equal(isReleaseBlocker(open), true);
  assert.equal(isReleaseBlocker(closed), false);
  assert.equal(isReleaseBlocker(plain), false);
});

test('lintBudgets: over the ceiling and missing files fail; at the ceiling passes', () => {
  const budgets = { 'a.md': { ceiling: 100, target: 50 }, 'b.md': { ceiling: 100, target: 50 }, 'c.md': { ceiling: 1, target: 1 } };
  const sizes = { 'a.md': 100, 'b.md': 101 };
  const problems = lintBudgets(budgets, (f) => sizes[f]);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /b\.md: 101 bytes is over its ceiling of 100/);
  assert.match(problems[1], /c\.md: budgeted file is missing/);
});

test('budgetRaises: a higher ceiling or a dropped budget is a raise; lower and new are not', () => {
  const base = { 'a.md': { ceiling: 100 }, 'b.md': { ceiling: 100 }, 'c.md': { ceiling: 100 } };
  const head = { 'a.md': { ceiling: 90 }, 'b.md': { ceiling: 101 }, 'new.md': { ceiling: 999 } };
  assert.deepEqual(budgetRaises(base, head), [
    { file: 'b.md', base: 100, head: 101 },
    { file: 'c.md', base: 100, head: undefined },
  ]);
  assert.deepEqual(budgetRaises(undefined, head), []);
});

test('compareVersions orders by number, with or without the v', () => {
  assert.equal(compareVersions('v0.9.0', 'v0.10.0'), -1);
  assert.equal(compareVersions('v0.70.1', '0.70.1'), 0);
  assert.equal(compareVersions('v1.0.0', 'v0.70.1'), 1);
});

const CONFIG = {
  schema: 1,
  host: { version: 'v0.63.0', appliedOn: '2026-11-06' },
  cadence: { hostLagRemindReleases: 3, hostLagRemindDays: 14, recordCommitShareMax: 0.25, stalePrDays: 3 },
  docBudgets: { 'a.md': { ceiling: 100, target: 50 } },
  release: { hostStepTagFromSection: 222 },
  legacy: LEGACY,
};

test('lintConfig: a well-formed state file passes, each malformed part is named', () => {
  assert.deepEqual(lintConfig(CONFIG), []);
  const bad = structuredClone(CONFIG);
  bad.host.version = '0.63';
  bad.host.appliedOn = '11-06';
  bad.cadence.recordCommitShareMax = 25;
  bad.docBudgets['a.md'].target = 200;
  bad.legacy.grandfathered = { 5: 'whatever' };
  bad.release = {};
  const problems = lintConfig(bad);
  assert.equal(problems.length, 6);
  for (const key of ['host.version', 'host.appliedOn', 'recordCommitShareMax', 'docBudgets.a.md', 'grandfathered.5', 'hostStepTagFromSection']) {
    assert.ok(problems.some((p) => p.includes(key)), key);
  }
  assert.ok(lintConfig({}).length > 0);
});

test('lintHostVersion: a tag no newer than the checkout; no tags is a failure only when required', () => {
  const tags = ['v0.63.0', 'v0.70.1'];
  assert.deepEqual(lintHostVersion('v0.63.0', '0.70.1', tags, true), []);
  assert.match(lintHostVersion('v0.64.0', '0.70.1', tags, true)[0], /not a release tag/);
  assert.match(lintHostVersion('v0.71.0', '0.70.1', [...tags, 'v0.71.0'], true)[0], /newer than this checkout/);
  assert.deepEqual(lintHostVersion('v0.63.0', '0.70.1', [], false), []);
  // A checkout with only some of the tags is not held to it unless tags are required.
  assert.deepEqual(lintHostVersion('v0.63.0', '0.70.1', ['v0.70.1'], false), []);
  assert.match(lintHostVersion('v0.72.0', '0.70.1', [], false)[0], /newer than this checkout/);
  assert.match(lintHostVersion('v0.63.0', '0.70.1', [], true)[0], /no release tags/);
});

const RELEASE = [
  '## 3. 主机怎么跟随一个 release tag',
  'intro',
  '### 3.1 old section',
  'no tag here',
  '```',
  '# a shell comment, not a heading',
  '```',
  'still 3.1',
  '### 3.222 new section',
  '',
  '> 主机步骤：窗口前、应用后；维护者本人：是',
  'body',
  '### 3.223 another',
  'body without the line',
  '## 4. Hotfix',
  'not part of 3.223',
].join('\n');

test('releaseSections: bodies run to the next heading; a comment in a code block is not one', () => {
  const s = releaseSections(RELEASE);
  assert.deepEqual(s.map((x) => [x.n, x.title]), [
    [1, 'old section'],
    [222, 'new section'],
    [223, 'another'],
  ]);
  assert.match(s[0].body, /still 3\.1/);
  assert.doesNotMatch(s[2].body, /not part of/);
});

test('hostStepTag: the first line of the body, well-formed or nothing', () => {
  assert.deepEqual(hostStepTag('\n> 主机步骤：无；维护者本人：否\ntext'), { host: ['无'], maintainer: false });
  assert.deepEqual(hostStepTag('> 主机步骤：窗口前、应用后；维护者本人：是'), { host: ['窗口前', '应用后'], maintainer: true });
  assert.equal(hostStepTag('text first\n> 主机步骤：无；维护者本人：否'), undefined); // not the first line
  assert.equal(hostStepTag('> 主机步骤：随便；维护者本人：否'), undefined);
  assert.equal(hostStepTag('> 主机步骤：无、窗口内；维护者本人：否'), undefined); // 无 stands alone
  assert.equal(hostStepTag('> 主机步骤：无；维护者本人：是'), undefined); // nothing to be there for
  assert.equal(hostStepTag('> 主机步骤：窗口内'), undefined);
});

test('lintReleaseSections: only sections from the given number on need the line', () => {
  assert.deepEqual(lintReleaseSections(RELEASE, 224), []);
  const problems = lintReleaseSections(RELEASE, 222);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /§3\.223: the section opens with its host-step line/);
  assert.equal(lintReleaseSections(RELEASE, 1).length, 2);
});
