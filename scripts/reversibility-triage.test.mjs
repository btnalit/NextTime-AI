// scripts/reversibility-triage.test.mjs — unit tests for the reversibility probe's verdict
// (scripts/reversibility-triage.mjs). Pure helpers only; the end-to-end run is the probe workflow.
//
// Usage: node --test scripts/reversibility-triage.test.mjs

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  activeDeltas,
  checkBindings,
  classify,
  exactNamePattern,
  parseManifest,
  readReport,
  testKey,
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

/** A Vitest-shaped JSON report whose totals match its rows unless `totals` overrides them. */
const report = (files, totals = {}) => {
  const all = files.flatMap((f) => f.tests.map(([, status]) => status));
  return {
    numTotalTests: all.length,
    numPassedTests: all.filter((x) => x === 'passed').length,
    numFailedTests: all.filter((x) => x === 'failed').length,
    numPendingTests: all.filter((x) => x === 'skipped' || x === 'pending').length,
    numTodoTests: 0,
    ...totals,
    testResults: files.map(({ file, status = 'passed', message, tests }) => ({
      name: `${ROOT}/${file}`,
      status,
      message,
      assertionResults: tests.map(([fullName, x]) => ({ fullName, status: x })),
    })),
  };
};

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
  const failing = () =>
    readReport(
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
  await t.test('a declared failure is excused; everything else passing means no problems', () => {
    const { problems, excused } = classify(failing(), [delta()], { baseExitCode: 1 });
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
            ['ok', 'passed'],
          ],
        },
      ]),
      ROOT,
    );
    const { problems } = classify(r, [delta()], { baseExitCode: 1 });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /undeclared failure: .* platform transaction/);
  });
  await t.test('a declaration for an inactive migration excuses nothing', () => {
    assert.equal(classify(failing(), [], { baseExitCode: 1 }).problems.length, 1);
  });
  await t.test('a declared test that passed or is missing is a stale declaration', () => {
    const passed = readReport(report([{ file: FILE, tests: [[OLD, 'passed']] }]), ROOT);
    assert.match(classify(passed, [delta()]).problems[0], /stale declaration/);
    const missing = readReport(report([{ file: FILE, tests: [[OTHER, 'passed']] }]), ROOT);
    assert.match(classify(missing, [delta()]).problems[0], /not in BASE's results/);
  });
  await t.test('a file that failed outside its tests, or unhandled errors, are problems', () => {
    const r = readReport(
      report([
        { file: FILE, tests: [[OTHER, 'passed']] },
        { file: 'src/x.test.ts', status: 'failed', message: 'boom\nstack', tests: [] },
      ]),
      ROOT,
    );
    assert.match(classify(r, []).problems[0], /outside its tests: src\/x\.test\.ts — boom$/);
    const clean = readReport(report([{ file: FILE, tests: [[OTHER, 'passed']] }]), ROOT);
    assert.equal(classify(clean, [], { unhandledErrors: true }).problems.length, 1);
  });
  await t.test('a passing duplicate name never hides a failing one (worst outcome wins)', () => {
    const r = readReport(
      report([
        {
          file: FILE,
          status: 'failed',
          tests: [
            [OTHER, 'failed'],
            [OTHER, 'passed'],
          ],
        },
      ]),
      ROOT,
    );
    assert.equal(r.tests.get(testKey(FILE, OTHER))?.status, 'failed');
    assert.match(classify(r, [], { baseExitCode: 1 }).problems[0], /undeclared failure/);
  });
  await t.test("the report's own failed count must match the failures it lists", () => {
    const r = readReport(
      report(
        [
          {
            file: FILE,
            status: 'failed',
            tests: [
              [OLD, 'failed'],
              [OTHER, 'passed'],
            ],
          },
        ],
        {
          numFailedTests: 2,
        },
      ),
      ROOT,
    );
    assert.match(
      classify(r, [delta()], { baseExitCode: 1 }).problems[0],
      /counts 2 failed tests but lists 1/,
    );
  });
  await t.test("BASE's exit code must agree with the report", () => {
    const clean = readReport(report([{ file: FILE, tests: [[OTHER, 'passed']] }]), ROOT);
    assert.match(classify(clean, [], { baseExitCode: 1 }).problems[0], /exited 1 with no failure/);
    assert.match(classify(failing(), [delta()], { baseExitCode: 0 }).problems[0], /exited 0/);
  });
  await t.test('nothing passed, or too much skipped, proves nothing', () => {
    const none = readReport(report([{ file: FILE, tests: [[OTHER, 'skipped']] }]), ROOT);
    assert.match(classify(none, []).problems[0], /passed no test/);
    const rows = Array.from({ length: 20 }, (_, i) => [`t${i}`, i < 18 ? 'passed' : 'skipped']);
    const skippy = readReport(report([{ file: FILE, tests: rows }]), ROOT);
    assert.match(classify(skippy, []).problems[0], /skipped 2 of 20/);
  });
});

test('checkBindings', async (t) => {
  const active = [delta()];
  await t.test('a new replacement and a changed BASE test file pass', () => {
    assert.deepEqual(checkBindings(active, { baseHas: () => false, fileChanged: () => true }), []);
  });
  await t.test('a replacement that already exists in BASE is refused', () => {
    const problems = checkBindings(active, {
      baseHas: (key) => key === testKey(FILE, `${OLD} (new)`),
      fileChanged: () => true,
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /already exists in BASE/);
  });
  await t.test('a declared BASE test whose file this PR did not touch is refused', () => {
    const problems = checkBindings(active, { baseHas: () => false, fileChanged: () => false });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /unchanged in HEAD/);
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
