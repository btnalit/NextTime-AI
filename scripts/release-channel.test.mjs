// node --test scripts/release-channel.test.mjs — needs packages/shared built (the record is
// checked against the kernel's own ReleaseChannelSchema).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { buildChannel, isBreaking, migrationRef } from './release-channel.mjs';

const { ReleaseChannelSchema } = await import(
  pathToFileURL(`${process.cwd()}/packages/shared/dist/index.js`).href
);

const RELEASES = [
  {
    version: 'v0.43.0',
    previousVersion: 'v0.42.0',
    publishedAt: '2026-10-09T10:00:00.000Z',
    pi: '1.0.2',
    migrations: ['core 0041'],
    breaking: false,
  },
  {
    version: 'v0.42.0',
    previousVersion: 'v0.41.0',
    publishedAt: '2026-10-04T10:07:13.000Z',
    pi: '0.99.2',
    migrations: ['core 0040'],
    breaking: false,
  },
];

const PI = {
  latest: '1.0.2',
  checkedAt: '2026-10-09T03:30:00Z',
  sdkSuite: 'pass',
  failureSummary: null,
  runUrl: 'https://github.com/o/r/actions/runs/9',
};

test('migrationRef keeps only kernel migration files', () => {
  assert.equal(migrationRef('packages/kernel/migrations/core/0041_namespace.sql'), 'core 0041');
  assert.equal(migrationRef('packages/kernel/migrations/llm-usage/0002_x.sql'), 'llm-usage 0002');
  assert.equal(migrationRef('packages/kernel/migrations/core/README.md'), null);
  assert.equal(migrationRef('docs/x.sql'), null);
});

test('isBreaking reads only the version’s own CHANGELOG section', () => {
  const changelog = [
    '# Changelog',
    '## [0.43.0](https://x) (2026-10-09)',
    '### ⚠ BREAKING CHANGES',
    '* something',
    '## [0.42.0](https://x) (2026-10-04)',
    '### Features',
  ].join('\n');
  assert.equal(isBreaking(changelog, 'v0.43.0'), true);
  assert.equal(isBreaking(changelog, 'v0.42.0'), false);
  assert.equal(isBreaking(changelog, 'v0.41.0'), false);
});

test('a drift-check run records upstream pi and finds the release that bundles it', () => {
  const record = buildChannel({
    repo: 'o/r',
    generatedAt: '2026-10-09T03:31:00.000Z',
    releases: RELEASES,
    pi: PI,
    previous: null,
  });
  assert.equal(record.platform.latest, 'v0.43.0');
  assert.equal(record.platform.releases[0].notesUrl, 'https://github.com/o/r/releases/tag/v0.43.0');
  assert.equal(record.piUpstream.bundledIn, 'v0.43.0');
  assert.equal(ReleaseChannelSchema.safeParse(record).success, true);
});

test('a release run keeps the previous upstream verdict and recomputes bundledIn', () => {
  const previous = buildChannel({
    repo: 'o/r',
    generatedAt: '2026-10-08T03:31:00.000Z',
    releases: RELEASES.slice(1),
    pi: PI,
    previous: null,
  });
  assert.equal(previous.piUpstream.bundledIn, null);
  const record = buildChannel({
    repo: 'o/r',
    generatedAt: '2026-10-09T10:05:00.000Z',
    releases: RELEASES,
    pi: null,
    previous,
  });
  assert.equal(record.piUpstream.checkedAt, PI.checkedAt);
  assert.equal(record.piUpstream.bundledIn, 'v0.43.0');
});

test('a passing suite carries no failure summary; a failing one keeps it', () => {
  const failed = buildChannel({
    repo: 'o/r',
    generatedAt: '2026-10-09T03:31:00.000Z',
    releases: RELEASES,
    pi: { ...PI, latest: '1.1.0', sdkSuite: 'fail', failureSummary: '3 test(s) failed' },
    previous: null,
  });
  assert.equal(failed.piUpstream.failureSummary, '3 test(s) failed');
  assert.equal(failed.piUpstream.bundledIn, null);
  const passed = buildChannel({
    repo: 'o/r',
    generatedAt: '2026-10-09T03:31:00.000Z',
    releases: RELEASES,
    pi: { ...PI, failureSummary: 'stale text' },
    previous: null,
  });
  assert.equal(passed.piUpstream.failureSummary, null);
});

test('no releases and no drift result yet is still a valid record', () => {
  const record = buildChannel({
    repo: 'o/r',
    generatedAt: '2026-10-09T03:31:00.000Z',
    releases: [],
    pi: null,
    previous: null,
  });
  assert.deepEqual(record.platform, { latest: null, releases: [] });
  assert.equal(record.piUpstream, null);
  assert.equal(ReleaseChannelSchema.safeParse(record).success, true);
});
