// scripts/reversibility-triage.mjs — the verdict step of .github/workflows/reversibility-probe.yml.
//
// The probe runs BASE's (the latest release tag's) kernel suite against HEAD's schema
// (docs/runbooks/release.md §6). Most failures there are real: BASE code that no longer works on
// the new schema, i.e. a rollback that needs a database restore. One kind is not — a BASE test
// that asserts the very database constraint a HEAD migration changes on purpose (core 0041 drops
// a policy branch; v0.42.0's suite asserts that branch exists). Before this script that kind kept
// the probe red until the next release tag carried the updated test, and the triage lived only in
// a PR comment.
//
// Now such a failure is *declared*, reviewed with the migration, in
// packages/kernel/migrations/reversibility-deltas.json:
//
//   { "deltas": [ {
//       "migration": "core/0041_drop_workspace_ontology_enforcement_allowance.sql",
//       "baseTests": [ { "file": "src/…test.ts", "fullName": "<describe chain and title>" } ],
//       "replacedBy": [ { "file": "src/…test.ts", "fullName": "…" } ],
//       "rationale": "docs/runbooks/release.md §6, core 0041 row: …" } ] }
//
// and this script holds every declaration to evidence. Nothing is skipped — BASE's whole suite
// still runs — and the probe is green only when all of these hold:
//   1. every BASE failure is a test declared by an *active* delta (one whose migration HEAD adds
//      over BASE; an entry for a migration BASE already ships is inert, so the manifest
//      expires by itself once the next tag carries the updated tests);
//   2. every declared BASE test exists in BASE's results and actually failed (a declaration that
//      no longer matches a failure is stale and must be removed, not left as a standing waiver);
//   3. no test file failed outside its tests (import / hook errors) and BASE reported no
//      unhandled errors;
//   4. every `replacedBy` test is new in HEAD (absent from BASE's results: added or renamed by this
//      PR), and passes when HEAD runs it on the same database — the new behaviour is asserted, not
//      just the old assertion silenced; and every declared BASE test's file differs between BASE
//      and HEAD — the PR actually revisited the old assertion;
//   4a. the report reconciles: Vitest's own failed-test count equals the failures listed, a name
//      occurring twice keeps its worst outcome, BASE's exit code agrees with the report, BASE
//      passed at least one test and skipped at most MAX_SKIPPED_SHARE of them;
//   5. the manifest is well formed: each migration exists in HEAD, each entry names at least one
//      BASE test, at least one replacement, and a rationale citing release.md §6.
//
// Usage (from the workflow, after BASE's suite wrote its JSON report):
//   node head/scripts/reversibility-triage.mjs --base-report probe-results.json --base-rc 1 \
//     --base-log probe.log --base-root base/packages/kernel --head-root head/packages/kernel \
//     --manifest head/packages/kernel/migrations/reversibility-deltas.json --delta delta.list
// Pure helpers are exported for scripts/reversibility-triage.test.mjs (node --test).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Built from a string: a literal ESC in a regex trips biome's noControlCharactersInRegex.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const MIGRATION_RE = /^[a-z][a-z0-9_-]*\/\d{4}_[a-z0-9_]+\.sql$/;

/** Validates the manifest's shape; returns `{ deltas, errors }`. `headMigrationsDir`, when given,
 *  must contain each entry's migration file. */
export function parseManifest(raw, headMigrationsDir) {
  const errors = [];
  let doc;
  try {
    doc = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (err) {
    return { deltas: [], errors: [`manifest is not valid JSON: ${err.message}`] };
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.deltas)) {
    return { deltas: [], errors: ['manifest must be an object with a "deltas" array'] };
  }
  const isTestRef = (t) =>
    t &&
    typeof t.file === 'string' &&
    /^src\/.+\.test\.ts$/.test(t.file) &&
    typeof t.fullName === 'string' &&
    t.fullName.trim().length > 0;
  doc.deltas.forEach((d, i) => {
    const at = `deltas[${i}]`;
    if (!d || typeof d.migration !== 'string' || !MIGRATION_RE.test(d.migration)) {
      errors.push(`${at}.migration must look like "<module>/NNNN_name.sql"`);
    } else if (headMigrationsDir && !existsSync(path.join(headMigrationsDir, d.migration))) {
      errors.push(`${at}.migration ${d.migration} does not exist in HEAD`);
    }
    if (!Array.isArray(d?.baseTests) || d.baseTests.length === 0 || !d.baseTests.every(isTestRef)) {
      errors.push(
        `${at}.baseTests must be a non-empty list of { file: "src/….test.ts", fullName }`,
      );
    }
    if (
      !Array.isArray(d?.replacedBy) ||
      d.replacedBy.length === 0 ||
      !d.replacedBy.every(isTestRef)
    ) {
      errors.push(
        `${at}.replacedBy must be a non-empty list of { file: "src/….test.ts", fullName }`,
      );
    }
    if (typeof d?.rationale !== 'string' || !d.rationale.includes('release.md §6')) {
      errors.push(`${at}.rationale must cite docs/runbooks/release.md §6`);
    }
  });
  return { deltas: errors.length === 0 ? doc.deltas : [], errors };
}

/** Deltas whose migration HEAD *adds* over BASE (`deltaMigrations`: the workflow's `comm -13`
 *  list of new "<module>/<file>.sql" paths, with or without a leading "./"). A migration HEAD
 *  edits after BASE shipped it activates nothing: BASE's runner fails it on its checksum, which is
 *  a real irreversibility and must stay red. */
export function activeDeltas(deltas, deltaMigrations) {
  const delta = new Set(deltaMigrations.map((m) => m.replace(/^\.\//, '').trim()).filter(Boolean));
  return {
    active: deltas.filter((d) => delta.has(d.migration)),
    inert: deltas.filter((d) => !delta.has(d.migration)),
  };
}

const testKey = (file, fullName) => `${file}\u0000${fullName}`;

const STATUS_RANK = { failed: 3, passed: 2, skipped: 1, pending: 1, todo: 1 };
const worse = (a, b) => ((STATUS_RANK[b] ?? 3) > (STATUS_RANK[a] ?? 3) ? b : a);

/** Flattens a Vitest JSON report: per-test outcomes keyed by file (relative to `root`, "/"
 *  separators) and full name — a name that occurs twice in one file keeps its *worst* outcome, so
 *  a passing duplicate never hides a failing one — plus every failed assertion as reported (not
 *  de-duplicated), the files that failed outside any test, and the report's own totals. */
export function readReport(report, root) {
  const tests = new Map();
  const failed = [];
  const fileErrors = [];
  for (const file of report.testResults ?? []) {
    const rel = path.relative(root, file.name).split(path.sep).join('/');
    const assertions = file.assertionResults ?? [];
    for (const a of assertions) {
      const fullName = a.fullName ?? [...(a.ancestorTitles ?? []), a.title].join(' ');
      const key = testKey(rel, fullName);
      const prior = tests.get(key);
      tests.set(key, {
        file: rel,
        fullName,
        status: prior ? worse(prior.status, a.status) : a.status,
      });
      if (a.status === 'failed') failed.push({ file: rel, fullName });
    }
    if (file.status === 'failed' && !assertions.some((a) => a.status === 'failed')) {
      fileErrors.push({ file: rel, message: (file.message ?? '').split('\n')[0] });
    }
  }
  const totals = {
    total: report.numTotalTests,
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    skipped: (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0),
  };
  return { tests, failed, fileErrors, totals };
}

/** At most this share of BASE's tests may be skipped: a suite whose integration tests all skipped
 *  (no DATABASE_URL — `describe.runIf`) proves nothing and must not read as reversible. */
export const MAX_SKIPPED_SHARE = 0.05;

/** The probe's verdict over BASE's results. Pure: replacement runs are checked separately.
 *  `baseExitCode` is BASE's own `vitest run` exit code; `files` answers whether a test file's
 *  content differs between BASE and HEAD and whether a key exists there (see `checkBindings`). */
export function classify(
  { tests, failed, fileErrors, totals },
  active,
  { unhandledErrors = false, baseExitCode } = {},
) {
  const declared = new Map();
  for (const d of active) {
    for (const t of d.baseTests) declared.set(testKey(t.file, t.fullName), d.migration);
  }
  const problems = [];
  const excused = [];
  for (const t of failed) {
    const migration = declared.get(testKey(t.file, t.fullName));
    if (migration) excused.push({ ...t, migration });
    else problems.push(`undeclared failure: ${t.file} > ${t.fullName}`);
  }
  for (const [key, migration] of declared) {
    const t = tests.get(key);
    const [file, fullName] = key.split('\u0000');
    if (!t)
      problems.push(`declared for ${migration} but not in BASE's results: ${file} > ${fullName}`);
    else if (t.status !== 'failed') {
      problems.push(
        `declared for ${migration} but it ${t.status} on HEAD's schema — remove the stale declaration: ${file} > ${fullName}`,
      );
    }
  }
  for (const f of fileErrors)
    problems.push(`test file failed outside its tests: ${f.file} — ${f.message}`);
  if (unhandledErrors) problems.push("BASE's run reported unhandled errors (see the probe log)");

  // Reconcile with the report's own totals and BASE's exit code: the per-test walk above must
  // account for every failure Vitest counted, and a non-zero exit needs a reported cause.
  if (totals.failed !== undefined && totals.failed !== failed.length) {
    problems.push(
      `report counts ${totals.failed} failed tests but lists ${failed.length} — cannot account for every failure`,
    );
  }
  if (baseExitCode !== undefined) {
    const reported = failed.length + fileErrors.length + (unhandledErrors ? 1 : 0);
    if (baseExitCode !== 0 && reported === 0) {
      problems.push(`BASE's suite exited ${baseExitCode} with no failure in its report`);
    }
    if (baseExitCode === 0 && failed.length > 0) {
      problems.push("BASE's suite exited 0 although its report lists failures");
    }
  }
  if (!(totals.passed > 0)) problems.push("BASE's suite passed no test — nothing was proven");
  else if (totals.total > 0 && totals.skipped / totals.total > MAX_SKIPPED_SHARE) {
    problems.push(
      `BASE skipped ${totals.skipped} of ${totals.total} tests (over ${MAX_SKIPPED_SHARE * 100}%) — is DATABASE_URL set?`,
    );
  }
  return { problems, excused };
}

/** Binds each active declaration to this PR's own change (no I/O: `baseHas` says whether a test
 *  key exists in BASE's results, `fileChanged` whether a test file differs between BASE and HEAD):
 *   - every `replacedBy` test is new in HEAD (added or renamed — absent from BASE's results), so an
 *     unrelated test that already passed cannot stand in for the new behaviour;
 *   - every declared BASE test's file is changed by HEAD, so the old assertion was actually
 *     revisited in this PR, not just waived. */
export function checkBindings(active, { baseHas, fileChanged }) {
  const problems = [];
  for (const d of active) {
    for (const r of d.replacedBy) {
      if (baseHas(testKey(r.file, r.fullName))) {
        problems.push(
          `replacement for ${d.migration} already exists in BASE — it must be added or renamed in this PR: ${r.file} > ${r.fullName}`,
        );
      }
    }
    for (const file of new Set(d.baseTests.map((t) => t.file))) {
      if (!fileChanged(file)) {
        problems.push(
          `declared BASE test file for ${d.migration} is unchanged in HEAD — the old assertion was not revisited: ${file}`,
        );
      }
    }
  }
  return problems;
}

export { testKey };

/** Regex source matching `fullName` literally, for Vitest's `-t` (a selection filter only — the
 *  exact name is then checked against the JSON report). */
export function exactNamePattern(fullName) {
  return fullName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function runReplacement(headRoot, ref) {
  const dir = mkdtempSync(path.join(tmpdir(), 'reversibility-'));
  const out = path.join(dir, 'report.json');
  try {
    const run = spawnSync(
      'pnpm',
      [
        'exec',
        'vitest',
        'run',
        ref.file,
        '-t',
        exactNamePattern(ref.fullName),
        '--reporter=json',
        `--outputFile.json=${out}`,
      ],
      { cwd: headRoot, encoding: 'utf8', env: process.env },
    );
    if (!existsSync(out)) {
      return `replacement did not run: ${ref.file} > ${ref.fullName} (${(run.stderr || run.stdout || '').trim().split('\n').pop()})`;
    }
    const { tests } = readReport(JSON.parse(readFileSync(out, 'utf8')), headRoot);
    const t = tests.get(testKey(ref.file, ref.fullName));
    if (!t) return `replacement not found in HEAD: ${ref.file} > ${ref.fullName}`;
    if (t.status !== 'passed')
      return `replacement ${t.status} in HEAD: ${ref.file} > ${ref.fullName}`;
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`missing --${name}`);
  return process.argv[i + 1];
}

function main() {
  const manifestPath = arg('manifest');
  const headRoot = realpathSync(arg('head-root'));
  const baseRoot = realpathSync(arg('base-root'));
  const lines = [];
  const problems = [];

  const { deltas, errors } = existsSync(manifestPath)
    ? parseManifest(readFileSync(manifestPath, 'utf8'), path.join(headRoot, 'migrations'))
    : { deltas: [], errors: [] };
  problems.push(...errors);
  const { active, inert } = activeDeltas(deltas, readFileSync(arg('delta'), 'utf8').split('\n'));

  const reportPath = arg('base-report');
  if (!existsSync(reportPath)) {
    problems.push("BASE's suite wrote no JSON report — it did not run to completion");
  } else {
    const report = readReport(JSON.parse(readFileSync(reportPath, 'utf8')), baseRoot);
    const log = existsSync(arg('base-log')) ? readFileSync(arg('base-log'), 'utf8') : '';
    const unhandledErrors =
      /Vitest caught \d+ unhandled errors?|Unhandled (Errors?|Rejection) ⎯/.test(
        log.replace(ANSI, ''),
      );
    const baseExitCode = Number.parseInt(arg('base-rc'), 10);
    const verdict = classify(report, active, { unhandledErrors, baseExitCode });
    problems.push(...verdict.problems);
    const read = (root, file) => {
      const full = path.join(root, file);
      return existsSync(full) ? readFileSync(full, 'utf8') : null;
    };
    problems.push(
      ...checkBindings(active, {
        baseHas: (key) => report.tests.has(key),
        fileChanged: (file) => read(baseRoot, file) !== read(headRoot, file),
      }),
    );
    if (verdict.excused.length > 0) {
      lines.push('### Declared deltas (BASE tests superseded by a reviewed migration)');
      for (const e of verdict.excused) lines.push(`- ${e.migration}: ${e.file} > ${e.fullName}`);
    }
  }

  for (const d of active) {
    for (const ref of d.replacedBy) {
      const problem = runReplacement(headRoot, ref);
      if (problem) problems.push(problem);
      else lines.push(`- replacement passes in HEAD: ${ref.file} > ${ref.fullName}`);
    }
  }
  for (const d of inert)
    lines.push(`- inert (BASE already ships ${d.migration}): entry can be removed`);

  if (problems.length > 0) {
    lines.push('### Problems', ...problems.map((p) => `- ${p}`));
    lines.push('**Result: not proven** — triage the problems above (release.md §6)');
  } else {
    lines.push(
      active.length > 0
        ? '**Result: reversible** — BASE code passes on HEAD schema; every remaining failure is a declared, replaced delta'
        : '**Result: reversible** — BASE code passes on HEAD schema',
    );
  }
  console.log(lines.join('\n'));
  process.exit(problems.length > 0 ? 1 : 0);
}

// Real paths everywhere (here and for --head-root / --base-root, which Vitest reports as real
// paths): invoked through a symlinked checkout, a plain path comparison is false
// and the verdict would silently never run (exit 0).
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  main();
}
