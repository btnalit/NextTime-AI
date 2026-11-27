#!/usr/bin/env node
/**
 * The redaction acceptance run (README.md beside this file; design doc
 * docs/redaction-boundary-design-2026-11-27.md §7 stage 1a).
 *
 *   node packages/kernel/test/redaction-fuzz/run.mjs [options]
 *
 *   --tag <tag>             the release to compare with (default: the last release — the newest
 *                           release tag not newer than .release-please-manifest.json's version)
 *   --generators <a,b,…>    which generators (default: all; `--list` names them)
 *   --seeds <7,8,…>         seeds (default 7,8)
 *   --rows <n>              rows per generator and seed (default 2000)
 *   --cut-sets <n>          stream cut sets per row (default 2)
 *   --report <dir>          write the results there as JSON, one file a group
 *   --write-corpus-baseline rewrite corpus-baseline.json from this run (CI's sample only)
 *   --write-stream-baseline rewrite stream-baseline.json from this run (CI's sample, every generator)
 *   --mutations [a,b,…]     apply each patch in mutations/ in turn and run: each must fail the run
 *   --list                  name the generators and the mutations
 *
 * It puts the release's kernel and shared sources under .baseline/<tag>/ (gitignored) with
 * `git archive`, fetching the tag from origin first when this clone does not have it, and runs
 * Vitest with vitest.config.ts beside this file. Exit status: Vitest's; with --mutations, 0 only
 * when every mutation failed the run — type-checked, every test file loaded, the harness passed,
 * and an acceptance test failed on an assertion; a patch that does not apply is stale, one that
 * breaks the build or the harness is broken, and both count as not failing it.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

const HERE = import.meta.dirname;
const KERNEL = join(HERE, '..', '..');
const ROOT = join(KERNEL, '..', '..');
const BASELINE_ROOT = join(HERE, '.baseline');
const MUTATIONS = join(HERE, 'mutations');
const SOURCES = ['packages/kernel/src', 'packages/shared/src'];
const PROBE = 'packages/kernel/src/substrate/redaction/secret-values.ts';
const CI_SAMPLE = { seeds: '7,8', rows: '2000', cutSets: '2' };

function parse(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value`);
      i += 1;
      return next;
    };
    switch (arg) {
      case '--tag':
        options.tag = value();
        break;
      case '--generators':
        options.generators = value();
        break;
      case '--seeds':
        options.seeds = value();
        break;
      case '--rows':
        options.rows = value();
        break;
      case '--cut-sets':
        options.cutSets = value();
        break;
      case '--report':
        options.report = value();
        break;
      case '--write-corpus-baseline':
        options.writeCorpusBaseline = true;
        break;
      case '--write-stream-baseline':
        options.writeStreamBaseline = true;
        break;
      case '--mutations': {
        const next = argv[i + 1];
        options.mutations = next !== undefined && !next.startsWith('--') ? value() : '';
        break;
      }
      case '--list':
        options.list = true;
        break;
      default:
        throw new Error(`unknown argument ${arg} (see the comment at the top of run.mjs)`);
    }
  }
  return options;
}

function git(args, how = {}) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', ...how });
  return { ok: result.status === 0, out: result.stdout ?? '', err: result.stderr ?? '' };
}

const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const versionOf = (tag) => RELEASE_TAG.exec(tag)?.slice(1).map(Number);
const newer = (a, b) => {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
};

/** The last release: the newest release tag on origin (this clone's tags when origin cannot be
 *  read) that is not newer than the version release-please last wrote. A release PR has written
 *  the version it is about to release, whose tag does not exist yet: it compares with the one
 *  before. */
function lastRelease() {
  const manifest = JSON.parse(readFileSync(join(ROOT, '.release-please-manifest.json'), 'utf8'));
  const written = versionOf(`v${manifest['.']}`);
  if (written === undefined) throw new Error('.release-please-manifest.json: no "." version');
  const remote = git(['ls-remote', '--tags', '--refs', 'origin', 'refs/tags/v*']);
  const tags = (remote.ok ? remote.out : git(['tag', '--list', 'v*']).out)
    .split('\n')
    .map((line) => line.trim().split('refs/tags/').pop() ?? '')
    .filter((tag) => versionOf(tag) !== undefined && !newer(versionOf(tag), written));
  if (tags.length === 0) return `v${manifest['.']}`;
  return tags.reduce((best, tag) => (newer(versionOf(tag), versionOf(best)) ? tag : best));
}

/** The release's sources under .baseline/<tag>/, put there if they are not. */
function baseline(tag) {
  if (versionOf(tag) === undefined) throw new Error(`--tag ${tag}: a release tag, vX.Y.Z`);
  const dir = join(BASELINE_ROOT, tag);
  if (existsSync(join(dir, PROBE))) return dir;
  if (!git(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`]).ok) {
    console.error(`fetching ${tag} from origin`);
    const fetched = git([
      'fetch',
      '--no-tags',
      '--depth=1',
      'origin',
      `refs/tags/${tag}:refs/tags/${tag}`,
    ]);
    if (!fetched.ok) throw new Error(`could not fetch ${tag}: ${fetched.err.trim()}`);
  }
  const scratch = mkdtempSync(join(tmpdir(), 'redaction-fuzz-'));
  try {
    const archive = join(scratch, 'sources.tar');
    const made = git(['archive', '--format=tar', `--output=${archive}`, tag, ...SOURCES]);
    if (!made.ok) throw new Error(`git archive ${tag}: ${made.err.trim()}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const untar = spawnSync('tar', ['-xf', archive, '-C', dir], { encoding: 'utf8' });
    if (untar.status !== 0) throw new Error(`tar: ${untar.stderr}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  console.error(`${tag}'s sources are in ${relative(ROOT, dir)}`);
  return dir;
}

/** A package's bin, as the kernel resolves the package. */
function binOf(pkg, name) {
  const require = createRequire(join(KERNEL, 'package.json'));
  const manifest = require.resolve(`${pkg}/package.json`);
  const { bin } = JSON.parse(readFileSync(manifest, 'utf8'));
  return join(dirname(manifest), typeof bin === 'string' ? bin : bin[name]);
}

/** The run, with `json` a file for Vitest's JSON report of it. */
function vitest(env, json) {
  const report =
    json === undefined
      ? []
      : ['--reporter=default', '--reporter=json', `--outputFile.json=${json}`];
  const result = spawnSync(
    process.execPath,
    [binOf('vitest', 'vitest'), 'run', '--config', join(HERE, 'vitest.config.ts'), ...report],
    { cwd: KERNEL, stdio: 'inherit', env: { ...process.env, ...env } },
  );
  return result.status ?? 1;
}

/** Whether the sources and this tool type-check as they stand (`tsconfig.json` beside this file
 *  reads the kernel sources it imports). */
function typechecks() {
  const result = spawnSync(
    process.execPath,
    [binOf('typescript', 'tsc'), '-p', join(HERE, 'tsconfig.json')],
    { cwd: KERNEL, encoding: 'utf8' },
  );
  if (result.status !== 0) console.error(`${result.stdout}${result.stderr}`.trim());
  return result.status === 0;
}

/** What a run under a mutation shows, from its JSON report: caught only when the harness passed,
 *  every file loaded, and an acceptance test failed on an assertion — a file that did not load, or
 *  a harness that failed, is a broken patch, not one the gate caught (review #493 on #1619). */
function verdict(status, json) {
  if (status === 0) return 'SURVIVED: the run passed';
  if (!existsSync(json)) return 'broken: no report (the run did not start)';
  const { testResults = [] } = JSON.parse(readFileSync(json, 'utf8'));
  const unloaded = testResults.filter(
    (file) => file.status === 'failed' && (file.assertionResults ?? []).length === 0,
  );
  if (unloaded.length > 0) {
    return `broken: ${unloaded.map((file) => relative(HERE, file.name)).join(', ')} did not load`;
  }
  const harness = testResults.filter((file) => file.name.endsWith('harness.test.ts'));
  if (harness.length === 0 || harness.some((file) => file.status !== 'passed')) {
    return 'broken: the harness did not pass';
  }
  const caught = testResults.some(
    (file) =>
      /acceptance-[\w-]+\.test\.ts$/.test(file.name) &&
      (file.assertionResults ?? []).some(
        (test) =>
          test.status === 'failed' &&
          (test.failureMessages ?? []).some((message) => /AssertionError/.test(message)),
      ),
  );
  return caught ? 'failed the run' : 'broken: no acceptance test failed on an assertion';
}

function patches(selected) {
  const all = existsSync(MUTATIONS)
    ? readdirSync(MUTATIONS)
        .filter((file) => file.endsWith('.patch'))
        .map((file) => file.slice(0, -'.patch'.length))
        .sort()
    : [];
  if (selected === undefined || selected === '') return all;
  const wanted = selected.split(',').map((name) => name.trim());
  for (const name of wanted) if (!all.includes(name)) throw new Error(`no mutations/${name}.patch`);
  return wanted;
}

/** Each mutation applied in turn: the run must fail under it. The sources are put back after each. */
function mutate(names, env) {
  if (names.length === 0) throw new Error('no mutations to run');
  const outcome = {};
  for (const name of names) {
    const patch = join(MUTATIONS, `${name}.patch`);
    if (!git(['apply', '--check', patch]).ok) {
      outcome[name] = 'stale: does not apply';
      continue;
    }
    git(['apply', patch]);
    const scratch = mkdtempSync(join(tmpdir(), 'redaction-fuzz-mutation-'));
    try {
      console.error(`\n=== mutation ${name}`);
      if (!typechecks()) {
        outcome[name] = 'broken: does not type-check';
      } else {
        const json = join(scratch, 'report.json');
        outcome[name] = verdict(vitest(env, json), json);
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      const back = git(['apply', '-R', patch]);
      if (!back.ok) {
        // The sources are left mutated: stop here, before anything else reads them.
        console.error(`could not take ${name} back out of src: ${back.err.trim()}`);
        process.exit(3);
      }
    }
  }
  console.log('\nmutations:');
  for (const [name, result] of Object.entries(outcome)) console.log(`  ${name}: ${result}`);
  return Object.values(outcome).every((result) => result === 'failed the run') ? 0 : 1;
}

/** Whether a report's settings are CI's sample. */
const ciSample = (settings) =>
  settings.rows === Number(CI_SAMPLE.rows) &&
  settings.cutSets === Number(CI_SAMPLE.cutSets) &&
  settings.seeds.join(',') === CI_SAMPLE.seeds;

/** corpus-baseline.json from a run's formats report: what the whole reading showed, per format. */
function writeCorpusBaseline(report, tag) {
  const { settings, results } = JSON.parse(readFileSync(join(report, 'formats.json'), 'utf8'));
  if (!ciSample(settings))
    throw new Error(
      "--write-corpus-baseline: only from CI's sample (rows, seeds, cut sets as default)",
    );
  const formats = {};
  for (const result of results) {
    formats[result.generator] ??= { rowsShowing: 0, shownChars: 0 };
    const line = formats[result.generator];
    line.rowsShowing += result.info.showing.now;
    line.shownChars += result.info.shownChars.now;
  }
  const file = {
    note: `Per format, on CI's sample (${CI_SAMPLE.rows} rows, seeds ${CI_SAMPLE.seeds}): the rows where this checkout's whole reading shows a value's character, and how many it shows. Written by run.mjs --write-corpus-baseline (compared with ${tag}); a change may only lower it.`,
    formats,
  };
  writeFileSync(join(HERE, 'corpus-baseline.json'), `${JSON.stringify(file, null, 2)}\n`);
  console.error('corpus-baseline.json rewritten');
}

/** stream-baseline.json from a run's reports: per generator, rows whose stream was not its whole
 *  text, this checkout's and the release's on the same rows. Every generator: a partial run would
 *  drop the lines of those it did not read. */
function writeStreamBaseline(report, tag, generators) {
  if (generators !== undefined)
    throw new Error('--write-stream-baseline: every generator (no --generators)');
  const lines = {};
  for (const file of readdirSync(report)
    .filter((name) => name.endsWith('.json'))
    .sort()) {
    const { settings, results } = JSON.parse(readFileSync(join(report, file), 'utf8'));
    if (!ciSample(settings))
      throw new Error(
        "--write-stream-baseline: only from CI's sample (rows, seeds, cut sets as default)",
      );
    for (const result of results) {
      lines[result.generator] ??= { rows: 0, atRelease: 0 };
      lines[result.generator].rows += result.streamDiffers.now;
      lines[result.generator].atRelease += result.streamDiffers.before;
    }
  }
  const recorded = Object.fromEntries(Object.entries(lines).sort(([a], [b]) => a.localeCompare(b)));
  const file = {
    note: `Per generator, on CI's sample (${CI_SAMPLE.rows} rows, seeds ${CI_SAMPLE.seeds}): rows where a stream reading's text is not this checkout's whole text (rows), and the same count for ${tag} on the same rows (atRelease). Written by run.mjs --write-stream-baseline; a change may only lower rows.`,
    generators: recorded,
  };
  writeFileSync(join(HERE, 'stream-baseline.json'), `${JSON.stringify(file, null, 2)}\n`);
  console.error('stream-baseline.json rewritten');
}

function main() {
  const options = parse(process.argv.slice(2));
  if (options.list) {
    // Named as the generator files key them (`'<group>/<name>':`), without loading them.
    const names = readdirSync(join(HERE, 'generators'))
      .filter((file) => file.endsWith('.ts'))
      .flatMap((file) => [
        ...readFileSync(join(HERE, 'generators', file), 'utf8').matchAll(
          /^ {2}'([a-z]+\/[\w-]+)':/gm,
        ),
      ])
      .map((match) => match[1]);
    console.log(`generators:\n${names.join('\n')}`);
    console.log(`mutations:\n${patches().join('\n')}`);
    return 0;
  }
  const tag = options.tag ?? lastRelease();
  baseline(tag);
  const report =
    options.report ??
    (options.writeCorpusBaseline || options.writeStreamBaseline
      ? mkdtempSync(join(tmpdir(), 'redaction-fuzz-report-'))
      : undefined);
  const env = {
    FUZZ_TAG: tag,
    FUZZ_SEEDS: options.seeds ?? CI_SAMPLE.seeds,
    FUZZ_ROWS: options.rows ?? CI_SAMPLE.rows,
    FUZZ_CUT_SETS: options.cutSets ?? CI_SAMPLE.cutSets,
    ...(options.generators === undefined ? {} : { FUZZ_GENERATORS: options.generators }),
    ...(report === undefined ? {} : { FUZZ_REPORT: report }),
  };
  if (options.mutations !== undefined) return mutate(patches(options.mutations), env);
  const status = vitest(env);
  if (options.writeCorpusBaseline) writeCorpusBaseline(report, tag);
  if (options.writeStreamBaseline) writeStreamBaseline(report, tag, options.generators);
  return status;
}

try {
  process.exitCode = main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 2;
}
