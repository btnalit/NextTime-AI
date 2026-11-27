// Unit tests for scripts/pr-gate.mjs's checks, on fixtures (the command itself reads GitHub).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bringsOnly, checkProblems, latestVerdicts, mergeChecks, releaseChecks, render, trustedBodies, verdictCovers } from './pr-gate.mjs';

const HEAD = 'abcdef1234567890abcdef1234567890abcdef12';
const MAP = {
  schema: 1,
  seats: { kernel: '内核', credentials: '凭据', ux: 'UX' },
  stewardOnly: ['docs/STATUS.md'],
  rules: [
    { name: 'redaction', risk: 'R3', seats: ['credentials', 'kernel'], paths: ['packages/kernel/src/redaction/**'] },
    { name: 'kernel', risk: 'R1', seats: ['kernel'], paths: ['packages/kernel/**'] },
    { name: 'web', risk: 'R1', seats: ['ux'], paths: ['packages/web/**'] },
    { name: 'docs', risk: 'R0', seats: [], paths: ['docs/**'] },
  ],
  default: { name: 'other', risk: 'R1', seats: ['kernel'] },
};
const run = (name, conclusion = 'success', status = 'completed') => ({ name, status, conclusion });
const GREEN = [run('guards'), run('quality'), run('test'), run('changes'), run('changes')];
const verdict = (seat, head = HEAD.slice(0, 8), v = 'pass') => `review text\n<!-- review-verdict seat=${seat} head=${head} verdict=${v} -->`;
const pr = (over = {}) => ({
  state: 'open',
  merged: false,
  draft: false,
  title: 'fix(kernel): x',
  body: '## 合入后由合并线程写入的状态\n- …',
  head: { sha: HEAD, ref: 'claude/x' },
  base: { ref: 'main' },
  ...over,
});
const merge = (over = {}) =>
  mergeChecks({
    pr: pr(),
    runs: GREEN,
    behindBy: 0,
    files: ['packages/kernel/src/a.ts'],
    commits: [{ sha: HEAD, parents: ['p0'] }],
    isBaseMerge: (c) => c.parents.length === 2 && c.parents[1].startsWith('main'),
    comments: [verdict('kernel')],
    map: MAP,
    steward: false,
    ...over,
  });
const failed = (checks) => checks.filter((c) => !c.ok).map((c) => c.name);

test('latestVerdicts: the last line of each seat wins', () => {
  const v = latestVerdicts([verdict('kernel', 'aaaaaaa', 'block'), 'no marker here', verdict('kernel', 'bbbbbbb'), verdict('ux', 'ccccccc'), null]);
  assert.deepEqual([...v], [
    ['kernel', { head: 'bbbbbbb', verdict: 'pass' }],
    ['ux', { head: 'ccccccc', verdict: 'pass' }],
  ]);
});

test('trustedBodies: only the owner, members and collaborators can write a verdict', () => {
  const pass = (seat) => `<!-- review-verdict seat=${seat} head=${HEAD} verdict=pass -->`;
  const block = (seat) => `<!-- review-verdict seat=${seat} head=${HEAD} verdict=block -->`;
  const bodies = trustedBodies([
    { at: '2026-11-27T03:00:00Z', body: pass('credentials'), association: 'NONE' }, // a passer-by, last
    { at: '2026-11-27T01:00:00Z', body: block('credentials'), association: 'OWNER' },
    { at: '2026-11-27T02:00:00Z', body: pass('kernel'), association: 'CONTRIBUTOR' },
    { at: '2026-11-27T02:30:00Z', body: pass('ux'), association: 'COLLABORATOR' },
    { at: '2026-11-27T02:40:00Z', body: pass('docs') }, // no association given
  ]);
  const verdicts = latestVerdicts(bodies);
  assert.equal(verdicts.get('credentials').verdict, 'block'); // the outsider's pass does not replace it
  assert.equal(verdicts.has('kernel'), false);
  assert.equal(verdicts.has('docs'), false);
  assert.equal(verdicts.get('ux').verdict, 'pass');
  // In time order whatever the order of the two lists.
  const later = trustedBodies([
    { at: '2026-11-27T05:00:00Z', body: pass('kernel'), association: 'OWNER' },
    { at: '2026-11-27T04:00:00Z', body: block('kernel'), association: 'MEMBER' },
  ]);
  assert.equal(latestVerdicts(later).get('kernel').verdict, 'pass');
});

test('bringsOnly: a merge may change only the files its second parent brought', () => {
  assert.equal(bringsOnly(['a.ts', 'b.ts'], ['a.ts', 'b.ts', 'c.ts']), true);
  assert.equal(bringsOnly([], ['a.ts']), true);
  assert.equal(bringsOnly(['a.ts', 'mine.ts'], ['a.ts']), false); // an edit slipped into the merge
  assert.equal(bringsOnly(['a.ts'], ['a.ts'], 1), false); // a list at the API cap is not trusted
});

test('verdictCovers: the head itself, or only merges of main after it', () => {
  const isBaseMerge = (c) => c.parents.length === 2 && c.parents[1].startsWith('main');
  const commits = [
    { sha: 'aaaaaaa1', parents: ['p0'] },
    { sha: 'bbbbbbb2', parents: ['aaaaaaa1'] },
    { sha: 'ccccccc3', parents: ['bbbbbbb2', 'main1'] },
  ];
  assert.equal(verdictCovers('bbbbbbb', commits, isBaseMerge), true); // then a merge of main only
  assert.equal(verdictCovers('ccccccc', commits, isBaseMerge), true);
  assert.equal(verdictCovers('aaaaaaa', commits, isBaseMerge), false); // bbbbbbb2 is a later change
  assert.equal(verdictCovers('ddddddd', commits, isBaseMerge), false); // not a commit of this pull request
  // A merge of some other branch is a change like any other.
  const other = [...commits.slice(0, 2), { sha: 'ccccccc3', parents: ['bbbbbbb2', 'feature1'] }];
  assert.equal(verdictCovers('bbbbbbb', other, isBaseMerge), false);
});

test('checkProblems: required checks must have run; nothing failed or still running', () => {
  assert.deepEqual(checkProblems(GREEN, ['guards', 'quality', 'test']), []);
  // A docs-only change skips quality and test: skipped is green unless the name must succeed.
  const docsOnly = [run('guards'), run('quality', 'skipped'), run('test', 'skipped')];
  assert.deepEqual(checkProblems(docsOnly, ['guards', 'quality', 'test']), []);
  assert.deepEqual(checkProblems(docsOnly, ['guards', 'quality', 'test'], ['quality']), ['quality is skipped']);
  assert.deepEqual(checkProblems([run('guards')], ['guards', 'quality']), ['quality has not run']);
  assert.deepEqual(checkProblems([...GREEN, run('web-e2e', 'failure')], ['guards']), ['web-e2e is failure']);
  assert.deepEqual(checkProblems([run('guards', null, 'in_progress')], ['guards']), ['guards is in_progress']);
  // The same name twice: one red run is red.
  assert.deepEqual(checkProblems([run('changes'), run('changes', 'cancelled')], []), ['changes is cancelled']);
});

test('mergeChecks: a reviewed, green, up-to-date pull request passes', () => {
  const checks = merge();
  assert.deepEqual(failed(checks), []);
  assert.match(render(checks), /RESULT ok$/);
});

test('mergeChecks: draft, behind, red checks and a closed pull request each fail', () => {
  assert.deepEqual(failed(merge({ pr: pr({ draft: true }) })), ['ready']);
  assert.deepEqual(failed(merge({ behindBy: 2 })), ['up-to-date']);
  assert.deepEqual(failed(merge({ runs: [...GREEN, run('quality', 'failure')] })), ['checks']);
  assert.deepEqual(failed(merge({ pr: pr({ state: 'closed', merged: true }) })), ['open']);
  assert.match(render(merge({ pr: pr({ draft: true }), behindBy: 1 })), /RESULT failed=ready,up-to-date$/);
});

test('mergeChecks: every seat the paths require has passed this head', () => {
  const files = ['packages/kernel/src/redaction/a.ts'];
  assert.deepEqual(failed(merge({ files })), ['reviews']); // credentials has no verdict
  assert.deepEqual(failed(merge({ files, comments: [verdict('kernel'), verdict('credentials')] })), []);
  const blocked = merge({ files, comments: [verdict('kernel'), verdict('credentials', HEAD.slice(0, 8), 'block')] });
  assert.match(blocked.find((c) => c.name === 'reviews').detail, /credentials: block/);
  // A push after the verdict needs a new one; a merge of main does not.
  const commits = [{ sha: '1111111aaaa', parents: ['p0'] }, { sha: HEAD, parents: ['1111111aaaa'] }];
  assert.deepEqual(failed(merge({ commits, comments: [verdict('kernel', '1111111')] })), ['reviews']);
  commits[1].parents = ['1111111aaaa', 'main1'];
  assert.deepEqual(failed(merge({ commits, comments: [verdict('kernel', '1111111')] })), []);
});

test('mergeChecks: a console change also needs web-e2e to have succeeded', () => {
  const files = ['packages/web/src/a.tsx'];
  const comments = [verdict('ux')];
  assert.deepEqual(failed(merge({ files, comments })), ['checks']); // web-e2e has not run
  assert.deepEqual(failed(merge({ files, comments, runs: [...GREEN, run('web-e2e', 'skipped')] })), ['checks']);
  assert.deepEqual(failed(merge({ files, comments, runs: [...GREEN, run('web-e2e')] })), []);
});

test('mergeChecks: hot docs are the steward’s; docs and the steward need no handoff section', () => {
  const docs = { files: ['docs/STATUS.md'], comments: [], pr: pr({ body: '' }) };
  assert.deepEqual(failed(merge(docs)), ['steward-only']);
  assert.deepEqual(failed(merge({ ...docs, steward: true })), []);
  assert.deepEqual(failed(merge({ files: ['docs/a.md'], comments: [], pr: pr({ body: '' }) })), []);
  assert.deepEqual(failed(merge({ pr: pr({ body: 'no section' }) })), ['handoff']);
  assert.deepEqual(failed(merge({ files: [] })), ['reviews']); // an empty change is not a pass
});

const STATUS_MD = (status) => `## 4. 遗留清单\n| 681 | item | P2 | lane | ${status} |\n## 5. 更新规则\n`;
const release = (over = {}) =>
  releaseChecks({
    pr: pr({
      title: 'chore(main): release 0.70.1',
      head: { sha: HEAD, ref: 'release-please--branches--main--components--nexttime-ai' },
      body: '### ⚠ 升级须知\n**这一版是什么**\n**已知问题 / Known issues**\n**回滚 / Rollback**',
    }),
    runs: GREEN,
    behindBy: 0,
    statusMd: STATUS_MD('开放'),
    audit: { ok: true, detail: '' },
    ...over,
  });

test('releaseChecks: a release PR with notes, green checks, no blocker and a clean audit passes', () => {
  assert.deepEqual(failed(release()), []);
});

test('releaseChecks: each gate fails on its own', () => {
  assert.deepEqual(failed(release({ pr: pr() })), ['release-pr', 'notes']);
  assert.deepEqual(failed(release({ behindBy: 1 })), ['up-to-date']);
  assert.deepEqual(failed(release({ statusMd: STATUS_MD('开放（发版前必须关闭）') })), ['blockers']);
  assert.deepEqual(failed(release({ statusMd: STATUS_MD('已关闭（#1；原标发版前必须关闭）') })), []);
  // quality and test may not be skipped on a release.
  assert.deepEqual(failed(release({ runs: [run('guards'), run('quality', 'skipped'), run('test')] })), ['checks']);
  // A skipped audit is a failed gate, never RESULT ok.
  const skipped = release({ audit: { ok: false, detail: 'skipped (--skip-audit)' } });
  assert.match(render(skipped), /FAIL audit — skipped[\s\S]*RESULT failed=audit$/);
});
