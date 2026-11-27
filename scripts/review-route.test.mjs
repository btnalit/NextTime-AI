// Unit tests for scripts/review-route.mjs. The routing rules under test are a fixture; the real
// map is checked for shape by `review-route.mjs --check` in the `guards` job.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lintMap, render, route } from './review-route.mjs';

const MAP = {
  schema: 1,
  seats: { kernel: '内核', credentials: '凭据', ux: 'UX' },
  stewardOnly: ['docs/STATUS.md'],
  rules: [
    { name: 'redaction', risk: 'R3', seats: ['credentials', 'kernel'], paths: ['packages/kernel/src/**/redaction/**'] },
    { name: 'migrations', risk: 'R2', seats: ['kernel'], paths: ['packages/kernel/migrations/**'] },
    { name: 'kernel', risk: 'R1', seats: ['kernel'], paths: ['packages/kernel/**'] },
    { name: 'web', risk: 'R1', seats: ['ux'], paths: ['packages/web/**'] },
    { name: 'docs', risk: 'R0', seats: [], paths: ['docs/**', '*.md'] },
  ],
  default: { name: 'other', risk: 'R1', seats: ['kernel'] },
};

test('route: a file takes its first rule; the change takes the highest tier and all seats', () => {
  const r = route(MAP, [
    'packages/kernel/src/governance/redaction/a.ts',
    'packages/kernel/src/chat/b.ts',
    'packages/web/src/c.tsx',
    'docs/x.md',
  ]);
  assert.equal(r.risk, 'R3');
  assert.deepEqual(r.seats, ['kernel', 'credentials', 'ux']);
  assert.deepEqual(r.groups.map((g) => [g.name, g.risk, g.files.length]), [
    ['redaction', 'R3', 1],
    ['kernel', 'R1', 1],
    ['web', 'R1', 1],
    ['docs', 'R0', 1],
  ]);
});

test('route: one R3 line makes the whole change R3; docs alone need no seat', () => {
  assert.equal(route(MAP, ['docs/a.md', 'packages/kernel/src/substrate/redaction/x.ts']).risk, 'R3');
  const docs = route(MAP, ['docs/a.md', 'README.md']);
  assert.equal(docs.risk, 'R0');
  assert.deepEqual(docs.seats, []);
  assert.match(render(MAP, docs), /seats: \(none/);
});

test('route: an unmatched path takes the default rule, never nothing', () => {
  const r = route(MAP, ['package.json']);
  assert.deepEqual([r.risk, r.seats, r.groups[0].name], ['R1', ['kernel'], 'other']);
  // A nested markdown file is not the top-level `*.md` rule.
  assert.equal(route(MAP, ['packs/x/readme.md']).groups[0].name, 'other');
});

test('route: steward-only files are reported; an empty change has no route', () => {
  assert.deepEqual(route(MAP, ['docs/STATUS.md', 'docs/a.md']).stewardOnly, ['docs/STATUS.md']);
  const empty = route(MAP, []);
  assert.equal(empty.risk, undefined);
  assert.match(render(MAP, empty), /no changed files/);
});

test('lintMap: the fixture passes; unknown seats, bad tiers and seatless risk are named', () => {
  assert.deepEqual(lintMap(MAP), []);
  const bad = structuredClone(MAP);
  bad.rules[0].seats = ['nobody'];
  bad.rules[1].risk = 'R9';
  bad.rules[2].seats = [];
  bad.rules[3].paths = [];
  const problems = lintMap(bad);
  assert.equal(problems.length, 4);
  assert.match(problems[0], /"redaction": seats must be listed/);
  assert.match(problems[1], /"migrations": risk must be one of/);
  assert.match(problems[2], /"kernel": R1 needs at least one seat/);
  assert.match(problems[3], /"web": paths must not be empty/);
  assert.ok(lintMap({}).length > 0);
});
