// Unit tests for scripts/loop-health.mjs's assessment. Fixtures only: the report reads the real
// repository when a patrol runs it, not here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLegacyTable } from './guards/loop-ledger.mjs';
import { archivableNotes, assess, commitMix, legacyCounts, legacyFlow, releasesAhead, render } from './loop-health.mjs';

const rows = (...lines) => parseLegacyTable(['## 4. 遗留清单', ...lines, '## 5. 更新规则'].join('\n'));
const row = (id, status, level = 'P3') => `| ${id} | item | ${level} | lane | ${status} |`;

const cfg = {
  schema: 1,
  host: { version: 'v0.63.0', appliedOn: '2026-11-06' },
  cadence: { hostLagRemindReleases: 3, hostLagRemindDays: 14, recordCommitShareMax: 0.25, stalePrDays: 3 },
  docBudgets: { 'docs/STATUS.md': { ceiling: 1000, target: 500 } },
  legacy: { tierRequiredFromId: 821, inStageWipCap: 2, weeklyNewP3Soft: 2, grandfathered: {} },
};
const NOW = Date.parse('2026-11-27T06:00:00Z');
const tag = (name, date = '2026-11-20') => ({ name, date });

/** A quiet week: host on the latest tag, documents under target, nothing new registered. */
function quiet(overrides = {}) {
  const legacy = rows(row(900, '开放（挂起：只是排版）'));
  return {
    cfg,
    now: NOW,
    tags: [tag('v0.62.0'), tag('v0.63.0')],
    sizes: { 'docs/STATUS.md': 400 },
    legacy,
    legacyWeekAgo: legacy,
    subjects: ['feat(kernel): a', 'fix(web): b', 'fix(kernel): c', 'docs(status): d'],
    ...overrides,
  };
}
const find = (findings, key) => findings.find((f) => f.key === key);

test('legacyCounts: open work by level and tier; accepted and closed rows are not open', () => {
  const c = legacyCounts(
    rows(
      row(1, '开放', 'P1'),
      row(2, '部分关闭（#1）', 'P2'),
      row(3, '已接受（维护者）', 'P2'),
      row(4, '已关闭（#2）'),
      row(5, '代码已合入（#3）', 'P2'), // unknown state counts as open
      row(900, '开放（阶段内处理）'),
      row(901, '开放（挂起：只多遮）'),
      row(902, '开放（发版前必须关闭）', 'P2'),
    ),
  );
  assert.deepEqual(c, { open: 6, p1: 1, p2: 3, p3: 2, inStage: 1, parked: 1, closedInTable: 1, blockers: [902] });
});

test('legacyFlow: closed, registered and net between two readings', () => {
  const base = rows(row(1, '开放'), row(2, '开放'), row(3, '开放'), row(4, '已关闭（#1）'));
  const head = rows(row(1, '开放'), row(2, '已关闭（#9）'), row(5, '开放（挂起：x）'), row(6, '开放', 'P2'));
  // 2 closed in place, 3 moved out of the table; 5 and 6 are new.
  assert.deepEqual(legacyFlow(base, head), { closed: 2, registered: 2, registeredP3: 1, net: 0 });
});

test('commitMix: docs commits over all commits; no commits has no share', () => {
  const m = commitMix(['docs(status): a', 'docs: b', 'fix(kernel): c', 'feat!: d', 'not conventional']);
  assert.deepEqual(m, { total: 5, docs: 2, status: 1, share: 0.4 });
  assert.equal(commitMix([]).share, undefined);
});

test('releasesAhead: tags newer than the host, in version order', () => {
  const ahead = releasesAhead([tag('v0.70.1'), tag('v0.63.0'), tag('v0.9.0'), tag('v0.64.0')], 'v0.63.0');
  assert.deepEqual(ahead.map((t) => t.name), ['v0.64.0', 'v0.70.1']);
});

test('assess: a quiet week has nothing to act on', () => {
  const findings = assess(quiet());
  assert.deepEqual(
    findings.filter((f) => f.level !== 'ok'),
    [],
  );
  assert.match(render(findings), /合计：该处理 0，无样本 0，留意 0，正常 5/);
});

test('assess: host lag acts on the release count or on days with a release waiting', () => {
  const many = assess(quiet({ tags: [tag('v0.63.0'), tag('v0.64.0'), tag('v0.65.0'), tag('v0.66.0')] }));
  assert.equal(find(many, 'host-lag').level, 'act');
  assert.match(find(many, 'host-lag').action, /--from v0\.63\.0 --to v0\.66\.0/);
  assert.equal(many[0].key, 'host-lag'); // most urgent first

  const one = quiet({ tags: [tag('v0.63.0'), tag('v0.64.0')] });
  assert.equal(find(assess(one), 'host-lag').level, 'act'); // 21 days since the host moved
  assert.equal(find(assess({ ...one, now: Date.parse('2026-11-10T00:00:00Z') }), 'host-lag').level, 'ok');
  // Old on the host but nothing newer released: nothing to upgrade to.
  assert.equal(find(assess(quiet()), 'host-lag').level, 'ok');
});

test('assess: a sample that cannot be read is no-sample, never ok', () => {
  const findings = assess(quiet({ tags: [], legacyWeekAgo: undefined, subjects: undefined, sizes: {} }));
  for (const key of ['host-lag', 'legacy-flow', 'commit-mix', 'doc:docs/STATUS.md']) {
    assert.equal(find(findings, key).level, 'no-sample', key);
  }
  assert.equal(find(assess(quiet({ legacy: undefined })), 'legacy').level, 'no-sample');
  assert.equal(find(assess(quiet({ subjects: [] })), 'commit-mix').level, 'no-sample');
});

test('assess: document budgets watch over target and act near the ceiling', () => {
  const at = (size) => find(assess(quiet({ sizes: { 'docs/STATUS.md': size } })), 'doc:docs/STATUS.md').level;
  assert.equal(at(500), 'ok');
  assert.equal(at(501), 'watch');
  assert.equal(at(951), 'act');
});

test('assess: legacy inflow, tier cap, open P1 and blockers', () => {
  const legacy = rows(
    row(10, '开放', 'P1'),
    row(900, '开放（挂起：只是排版）'),
    row(901, '开放（阶段内处理）'),
    row(902, '开放（阶段内处理）'),
    row(903, '开放（阶段内处理；发版前必须关闭）'),
  );
  const findings = assess(quiet({ legacy }));
  assert.equal(find(findings, 'legacy-open').level, 'act'); // an open P1
  assert.equal(find(findings, 'legacy-wip').level, 'act'); // 3 in stage, cap 2
  assert.match(find(findings, 'release-blockers').message, /903/);
  const flow = find(findings, 'legacy-flow'); // 3 new P3 against a soft limit of 2
  assert.equal(flow.level, 'act');
  assert.match(flow.message, /新登记且仍开放 4 条（P3 3），关闭 0 条，净 \+4/);
});

test('assess: record-only commits over the share are watched', () => {
  const findings = assess(quiet({ subjects: ['docs(status): a', 'docs(status): b', 'fix: c'] }));
  assert.equal(find(findings, 'commit-mix').level, 'watch');
});

test('assess: optional readings appear only when given', () => {
  assert.equal(find(assess(quiet()), 'memory-index'), undefined);
  assert.equal(find(assess(quiet({ memoryIndexSize: 9000 })), 'memory-index').level, 'ok');
  assert.equal(find(assess(quiet({ memoryIndexSize: 11000 })), 'memory-index').level, 'watch');
  assert.equal(find(assess(quiet({ memoryIndexSize: 13000 })), 'memory-index').level, 'act');
  const quietPulls = [{ number: 7, title: 'feat: x', draft: true, days: 6 }];
  assert.match(find(assess(quiet({ quietPulls })), 'pr:7').message, /#7（draft） 6 天没有动静/);
  assert.equal(find(assess(quiet({ archivable: ['console-ux/acceptance-7.md'] })), 'archive').level, 'watch');
});

test('archivableNotes: released acceptance notes and prompts for an older tag', () => {
  const names = [
    'README.md',
    'host-upgrade-v0.70.0.md',
    'host-upgrade-v0.70.1.md',
    'console-ux/acceptance-1.md',
    'console-ux/acceptance-2.md',
    'console-ux/audit.md',
  ];
  assert.deepEqual(archivableNotes(names, (pr) => pr === 1, 'v0.70.1'), ['host-upgrade-v0.70.0.md', 'console-ux/acceptance-1.md']);
  assert.deepEqual(archivableNotes(names, () => false, undefined), []);
});
