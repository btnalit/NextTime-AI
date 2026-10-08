#!/usr/bin/env node
// release-channel.mjs — builds the ReleaseChannel record `channel.json` (S10 U1,
// docs/s10-evolution-plan-2026-10-04.md §4.2): every recent platform release (the pi it bundles,
// the migrations it adds, whether release-please marked it breaking) plus the latest upstream pi
// and the nightly drift check's verdict on it. `.github/workflows/release-channel.yml` runs it and
// uploads the result to the rolling `channel` pre-release; the host's `update-feed` service
// downloads that file and the kernel's `platform_updates` reads it.
//
// The output is validated against `ReleaseChannelSchema` from packages/shared/dist (build shared
// first) — the same schema the kernel validates on every read, so CI cannot publish a record the
// kernel would reject.
//
// Usage (from the repository root, with tags fetched — `actions/checkout` `fetch-depth: 0`):
//   node scripts/release-channel.mjs --repo <owner>/<repo> --out channel.json
//     [--previous prev.json]            keep its piUpstream when no --pi-* is given (release runs)
//     [--pi-latest 1.0.2 --pi-suite pass|fail --pi-checked-at <ISO>
//      --pi-failure "<one line>" --pi-run-url <url>]   the drift check's result (pi-drift.yml)
//     [--max-releases 20]

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MIGRATIONS_DIR = 'packages/kernel/migrations/';

/** `packages/kernel/migrations/core/0041_x.sql` → `core 0041`; anything else → null. */
export function migrationRef(path) {
  if (!path.startsWith(MIGRATIONS_DIR)) return null;
  const match = /^([a-z][a-z-]{0,31})\/(\d{4})_[^/]*\.sql$/.exec(path.slice(MIGRATIONS_DIR.length));
  return match ? `${match[1]} ${match[2]}` : null;
}

/** Whether CHANGELOG.md's section for `version` (`vX.Y.Z`) carries release-please's breaking
 *  marker (`### ⚠ BREAKING CHANGES`). A version with no section is not breaking. */
export function isBreaking(changelog, version) {
  const bare = version.replace(/^v/, '');
  const lines = changelog.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`## [${bare}]`));
  if (start === -1) return false;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ')) break;
    if (/BREAKING CHANGE/i.test(lines[i])) return true;
  }
  return false;
}

/**
 * Pure half: the record from already-collected facts.
 * - `releases`: newest first, `{version, publishedAt, pi, migrations, breaking}`.
 * - `pi`: this run's drift-check result, or null to keep `previous.piUpstream`.
 * `bundledIn` is always recomputed — a release run that ships the new pi must flip it.
 */
export function buildChannel({ repo, generatedAt, releases, pi, previous }) {
  const withUrls = releases.map((release) => ({
    ...release,
    notesUrl: `https://github.com/${repo}/releases/tag/${release.version}`,
  }));
  const carried = pi ?? previous?.piUpstream ?? null;
  let piUpstream = null;
  if (carried) {
    const bundling = [...withUrls].reverse().find((release) => release.pi === carried.latest);
    piUpstream = {
      latest: carried.latest,
      checkedAt: carried.checkedAt,
      sdkSuite: carried.sdkSuite,
      failureSummary: carried.sdkSuite === 'fail' ? (carried.failureSummary ?? null) : null,
      bundledIn: bundling?.version ?? null,
      runUrl: carried.runUrl ?? null,
    };
  }
  return {
    schema: 1,
    generatedAt,
    platform: { latest: withUrls[0]?.version ?? null, releases: withUrls },
    piUpstream,
  };
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Release tags newest first, with each one's facts read from git at that tag. */
export function collectReleases(maxReleases) {
  const tags = git(['tag', '--list', 'v*', '--sort=-v:refname'])
    .split('\n')
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag))
    .slice(0, maxReleases + 1);
  let changelog = '';
  try {
    changelog = readFileSync('CHANGELOG.md', 'utf8');
  } catch {
    // no changelog: nothing is marked breaking
  }
  return tags.slice(0, maxReleases).map((tag, index) => {
    let pi = null;
    try {
      const value = git(['show', `${tag}:pi.version`]).trim();
      pi = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value) ? value : null;
    } catch {
      // a tag from before pi.version existed
    }
    const previousTag = tags[index + 1];
    const migrations = previousTag
      ? git(['diff', '--name-only', '--diff-filter=A', previousTag, tag, '--', MIGRATIONS_DIR])
          .split('\n')
          .map(migrationRef)
          .filter((ref) => ref !== null)
          .sort()
      : [];
    const publishedAt = new Date(git(['log', '-1', '--format=%cI', tag]).trim()).toISOString();
    return { version: tag, publishedAt, pi, migrations, breaking: isBreaking(changelog, tag) };
  });
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`unexpected argument ${key}`);
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${key} needs a value`);
    args[key.slice(2)] = value;
    i += 1;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(args.repo)) {
    throw new Error('--repo <owner>/<repo> is required');
  }
  if (!args.out) throw new Error('--out <file> is required');
  const { ReleaseChannelSchema } = await import(
    pathToFileURL(`${process.cwd()}/packages/shared/dist/index.js`).href
  );

  let previous = null;
  if (args.previous) {
    try {
      const parsed = ReleaseChannelSchema.safeParse(
        JSON.parse(readFileSync(args.previous, 'utf8')),
      );
      if (parsed.success) previous = parsed.data;
      else console.warn(`release-channel: ignoring an invalid previous record ${args.previous}`);
    } catch {
      console.warn(`release-channel: no readable previous record at ${args.previous}`);
    }
  }

  let pi = null;
  if (args['pi-latest']) {
    pi = {
      latest: args['pi-latest'],
      checkedAt: args['pi-checked-at'] ?? new Date().toISOString(),
      sdkSuite: args['pi-suite'],
      failureSummary: args['pi-failure'] ? args['pi-failure'].slice(0, 500) : null,
      runUrl: args['pi-run-url'] || null,
    };
  }

  const record = buildChannel({
    repo: args.repo,
    generatedAt: new Date().toISOString(),
    releases: collectReleases(Number(args['max-releases'] ?? 20)),
    pi,
    previous,
  });
  const checked = ReleaseChannelSchema.safeParse(record);
  if (!checked.success) {
    console.error(JSON.stringify(checked.error.issues, null, 2));
    throw new Error('the built record does not match ReleaseChannelSchema — not writing it');
  }
  const text = `${JSON.stringify(checked.data, null, 2)}\n`;
  writeFileSync(args.out, text);
  console.log(
    `release-channel: ${args.out} (${text.length} bytes): platform latest ${record.platform.latest ?? 'none'}, ` +
      `${record.platform.releases.length} releases, pi upstream ${record.piUpstream?.latest ?? 'unknown'} ` +
      `(${record.piUpstream?.sdkSuite ?? '-'}, bundled in ${record.piUpstream?.bundledIn ?? 'none'})`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`release-channel: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
