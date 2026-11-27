// Unit tests for scripts/host-upgrade-brief.mjs's computations, on fixtures (the command reads tags).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { migrationsAdded, newSections, renderBrief, runs, sortSections } from './host-upgrade-brief.mjs';

const md = (...sections) => ['## 3. 主机', ...sections.flatMap(([n, ...body]) => [`### 3.${n} title ${n}`, ...body]), '## 4. Hotfix'].join('\n');

test('newSections: what the target has and the start does not', () => {
  const from = md([131], [132]);
  const to = md([131], [132], [133, 'a'], [134, 'b'], [136, 'c']);
  assert.deepEqual(newSections(from, to).map((s) => s.n), [133, 134, 136]);
  assert.deepEqual(newSections(to, to), []);
});

test('runs: consecutive numbers fold into ranges, gaps stay visible', () => {
  assert.deepEqual(runs([201, 133, 134, 135, 199, 202]), [
    [133, 135],
    [199, 199],
    [201, 202],
  ]);
  assert.deepEqual(runs([]), []);
});

test('migrationsAdded: added .sql files by directory, nothing else', () => {
  const diff = [
    'A\tpackages/kernel/migrations/core/0055_b.sql',
    'A\tpackages/kernel/migrations/core/0054_a.sql',
    'M\tpackages/kernel/migrations/core/0001_init.sql',
    'M\tpackages/kernel/migrations/reversibility-deltas.json',
    'A\tpackages/kernel/migrations/goal/0018_x.sql',
    'M\tdocker-compose.yml',
  ].join('\n');
  assert.deepEqual(migrationsAdded(diff), { core: ['0054', '0055'], goal: ['0018'] });
  assert.deepEqual(migrationsAdded(''), {});
});

const tagged = (n, tag, ...body) => ({ n, title: `t${n}`, body: [`> 主机步骤：${tag}`, ...body].join('\n') });

test('sortSections: by host-step line; untagged sections are only screened', () => {
  const sorted = sortSections([
    tagged(222, '无；维护者本人：否'),
    tagged(223, '窗口前、应用后；维护者本人：是'),
    tagged(224, '窗口内；维护者本人：否'),
    { n: 133, title: 'old a', body: '只改控制台文案' },
    { n: 134, title: 'old b', body: '升级后由维护者轮换 key' },
  ]);
  const ids = (list) => list.map((s) => s.n);
  assert.deepEqual(ids(sorted.none), [222]);
  assert.deepEqual([ids(sorted.steps.窗口前), ids(sorted.steps.窗口内), ids(sorted.steps.应用后)], [[223], [224], [223]]);
  assert.deepEqual(ids(sorted.maintainer), [223]);
  assert.deepEqual(ids(sorted.untagged), [133, 134]);
  assert.deepEqual(ids(sorted.screened), [134]);
});

const DATA = {
  from: 'v0.63.0',
  to: 'v0.70.1',
  fromCommit: 'e784e57aaaaaaaa',
  toCommit: '108660cbbbbbbbb',
  releases: [
    { name: 'v0.64.0', date: '2026-11-06' },
    { name: 'v0.70.1', date: '2026-11-27' },
  ],
  migrations: { core: ['0054', '0055', '0057'], worker: ['0014'] },
  composeChanged: false,
  envChanged: true,
  sections: [{ n: 133, title: 'old', body: 'x' }, tagged(222, '无；维护者本人：否'), tagged(224, '窗口内；维护者本人：是')],
  staging: undefined,
  slug: 'owner/repo',
  warnings: [],
};

test('renderBrief: counts, ranges, the gap, and the dispatch command when no rehearsal is named', () => {
  const brief = renderBrief(DATA);
  assert.match(brief, /途经 2 个版本：v0\.64\.0（2026-11-06）、v0\.70\.1（2026-11-27）/);
  assert.match(brief, /共 \*\*4 个\*\*新迁移/);
  assert.match(brief, /core：0054–0055、0057（3 个）/);
  assert.match(brief, /worker：0014（1 个）/);
  assert.match(brief, /`docker-compose\.yml`：没有改动；`\.env\.example`：\*\*有改动\*\*/);
  assert.match(brief, /共 3 节：§3\.133、§3\.222、§3\.224/);
  assert.match(brief, /编号从 §3\.222 直接到 §3\.224/);
  assert.match(brief, /1 节写明\*\*没有主机步骤\*\*：§3\.222/);
  assert.match(brief, /\*\*窗口内\*\*要做的 1 节/);
  assert.match(brief, /\*\*维护者本人\*\*在场或决定，下发前先告诉他：§3\.224/);
  assert.match(brief, /1 节是加主机步骤行之前写的（§3\.133）/);
  assert.match(brief, /inputs\[from\]=v0\.63\.0' -f 'inputs\[to\]=v0\.70\.1'/);
});

test('renderBrief: a rehearsal that is not green for this path is called out; warnings lead', () => {
  const ok = renderBrief({ ...DATA, staging: { id: '1', title: 'staging v0.63.0 -> v0.70.1', url: 'u', ok: true } });
  assert.match(ok, /run 1（staging v0\.63\.0 -> v0\.70\.1）：\*\*绿\*\*/);
  const bad = renderBrief({ ...DATA, warnings: ['只能当演算'], staging: { id: '2', title: 't', url: 'u', ok: false, problem: '结论是 failure' } });
  assert.match(bad, /\*\*不能用：结论是 failure\*\*/);
  assert.match(bad, /> \*\*注意\*\*：只能当演算/);
  assert.match(renderBrief({ ...DATA, migrations: {}, sections: [] }), /没有新迁移[\s\S]*没有新增的 §3 小节/);
});
