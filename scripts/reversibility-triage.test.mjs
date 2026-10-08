// scripts/reversibility-triage.test.mjs — unit tests for the reversibility probe's verdict
// (scripts/reversibility-triage.mjs). Pure helpers only; the end-to-end run is the probe workflow.
//
// Usage: node --test scripts/reversibility-triage.test.mjs

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  activeDeltas,
  classify,
  exactNamePattern,
  parseManifest,
  readReport,
} from './reversibility-triage.mjs';

const ROOT = '/w/base/packages/kernel';
const FILE = 'src/adapters/db/write-confinement.integration.test.ts';
const OLD = 'R-29 workspaces a workspace transaction cannot change its own workspace either';
const OTHER = 'R-29 workspaces a platform transaction writes any workspace';

const delta = (overrides = {}) => ({
  migration: 'core/0041_drop_allowance.sql',
  baseTests: [{ file: FILE, fullName: OLD }],
  replacedBy: [{ file: FILE, fullName: `${OLD} (new)` }],
  rationale: 'docs/runbooks/release.md §6, core 0041 row',
  ...overrides,
});

const report = (files) => ({
  testResults: files.map(({ file, status = 'passed', message, tests }) => ({
    name: `${ROOT}/${file}`,
    status,
    message,
    assertionResults: tests.map(([fullName, s]) => ({ fullName, status: s })),
  })),
});

test('parseManifest', async (t) => {
  await t.test('accepts a well-formed manifest', () => {
    const { deltas, errors } = parseManifest(JSON.stringify({ deltas: [delta()] }));
    assert.deepEqual(errors, []);
    assert.equal(deltas.length, 1);
  });
  await t.test(
    'rejects a delta without a replacement, a rationale, or a valid migration path',
    () => {
      const { deltas, errors } = parseManifest({
        deltas: [delta({ replacedBy: [], rationale: 'because', migration: '0041.sql' })],
      });
      assert.deepEqual(deltas, []);
      assert.equal(errors.length, 3);
    },
  );
  await t.test('rejects a test reference outside src/**.test.ts', () => {
    const { errors } = parseManifest({
      deltas: [delta({ baseTests: [{ file: 'vitest.config.ts', fullName: 'x' }] })],
    });
    assert.equal(errors.length, 1);
  });
  await t.test('rejects invalid JSON and a missing deltas array', () => {
    assert.equal(parseManifest('{').errors.length, 1);
    assert.equal(parseManifest('{}').errors.length, 1);
  });
});

test('activeDeltas: only migrations HEAD adds or edits over BASE are active', () => {
  const shipped = delta({ migration: 'core/0030_old.sql' });
  const { active, inert } = activeDeltas(
    [delta(), shipped],
    ['./core/0041_drop_allowance.sql', ''],
  );
  assert.deepEqual(
    active.map((d) => d.migration),
    ['core/0041_drop_allowance.sql'],
  );
  assert.deepEqual(inert, [shipped]);
});

test('classify', async (t) => {
  await t.test('a declared failure is excused; everything else passing means no problems', () => {
    const r = readReport(
      report([
        {
          file: FILE,
          status: 'failed',
          tests: [
            [OLD, 'failed'],
            [OTHER, 'passed'],
          ],
        },
      ]),
      ROOT,
    );
    const { problems, excused } = classify(r, [delta()]);
    assert.deepEqual(problems, []);
    assert.equal(excused.length, 1);
  });
  await t.test('an undeclared failure is a problem', () => {
    const r = readReport(
      report([
        {
          file: FILE,
          status: 'failed',
          tests: [
            [OLD, 'failed'],
            [OTHER, 'failed'],
          ],
        },
      ]),
      ROOT,
    );
    const { problems } = classify(r, [delta()]);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /undeclared failure: .* platform transaction/);
  });
  await t.test('a declaration for an inactive migration excuses nothing', () => {
    const r = readReport(
      report([{ file: FILE, status: 'failed', tests: [[OLD, 'failed']] }]),
      ROOT,
    );
    assert.equal(classify(r, []).problems.length, 1);
  });
  await t.test('a declared test that passed or is missing is a stale declaration', () => {
    const passed = readReport(report([{ file: FILE, tests: [[OLD, 'passed']] }]), ROOT);
    assert.match(classify(passed, [delta()]).problems[0], /stale declaration/);
    const missing = readReport(report([{ file: FILE, tests: [[OTHER, 'passed']] }]), ROOT);
    assert.match(classify(missing, [delta()]).problems[0], /not in BASE's results/);
  });
  await t.test('a file that failed outside its tests, or unhandled errors, are problems', () => {
    const r = readReport(
      report([{ file: 'src/x.test.ts', status: 'failed', message: 'boom\nstack', tests: [] }]),
      ROOT,
    );
    assert.match(classify(r, []).problems[0], /outside its tests: src\/x\.test\.ts — boom$/);
    const clean = readReport(report([{ file: FILE, tests: [[OTHER, 'passed']] }]), ROOT);
    assert.equal(classify(clean, [], { unhandledErrors: true }).problems.length, 1);
  });
});

test('readReport falls back to ancestorTitles + title when fullName is absent', () => {
  const { tests } = readReport(
    {
      testResults: [
        {
          name: `${ROOT}/${FILE}`,
          status: 'passed',
          assertionResults: [{ ancestorTitles: ['A', 'B'], title: 'c', status: 'passed' }],
        },
      ],
    },
    ROOT,
  );
  assert.equal([...tests.values()][0].fullName, 'A B c');
});

test('exactNamePattern escapes regex metacharacters', () => {
  const name = 'cannot change (status, name) — a.b [x]?';
  assert.ok(new RegExp(exactNamePattern(name)).test(`R-29 ${name}`));
  assert.ok(!new RegExp(exactNamePattern(name)).test('cannot change status, name — aXb x'));
});
