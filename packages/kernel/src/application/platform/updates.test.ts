import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RELEASE_CHANNEL_MAX_BYTES, type ReleaseChannel } from '@nexttime/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_UPDATE_FEED_FILE,
  type ReleaseChannelRead,
  UPDATE_FEED_MAX_AGE_HOURS,
  derivePlatformUpdates,
  readReleaseChannel,
  releaseChannelFromFile,
  resolveUpdateFeedFile,
  resolveUpdateFeedRepo,
} from './updates.js';

/** S10 U1: `platform_updates` from the downloaded ReleaseChannel record. */

const NOW = new Date('2026-10-08T12:00:00Z');
const HOUR = 3_600_000;
const REPO = 'https://github.com/example/nexttime-ai';
const FEED_REPO = 'example/nexttime-ai';

/** The fixtures' releases are consecutive minors: v0.44.0 follows v0.43.0, and so on. */
function previousOf(version: string): string {
  const minor = Number(/^v0\.(\d+)\.0$/.exec(version)?.[1]);
  return `v0.${minor - 1}.0`;
}

function release(version: string, pi: string, migrations: string[] = [], breaking = false) {
  return {
    version,
    previousVersion: previousOf(version),
    publishedAt: '2026-10-05T10:00:00Z',
    pi,
    migrations,
    breaking,
    notesUrl: `${REPO}/releases/tag/${version}`,
  };
}

const UPSTREAM: NonNullable<ReleaseChannel['piUpstream']> = {
  latest: '1.0.2',
  checkedAt: '2026-10-08T03:30:00Z',
  sdkSuite: 'pass',
  failureSummary: null,
  bundledIn: 'v0.43.0',
  runUrl: `${REPO}/actions/runs/123`,
};

function channel(overrides: Partial<ReleaseChannel> = {}): ReleaseChannel {
  return {
    schema: 1,
    generatedAt: '2026-10-08T03:30:00Z',
    platform: {
      latest: 'v0.44.0',
      releases: [
        release('v0.44.0', '1.0.2', ['core 0042'], true),
        release('v0.43.0', '1.0.2', ['core 0041', 'task 0006']),
        release('v0.42.0', '0.99.2', ['core 0040']),
        release('v0.41.0', '0.99.2'),
      ],
    },
    piUpstream: UPSTREAM,
    ...overrides,
  };
}

function readOf(record: ReleaseChannel, fetchedAgoHours = 1): ReleaseChannelRead {
  return releaseChannelFromFile(
    '/feed.json',
    JSON.stringify(record),
    new Date(NOW.getTime() - fetchedAgoHours * HOUR),
    NOW,
    FEED_REPO,
  );
}

function derive(read: ReleaseChannelRead, kernelVersion = 'v0.42.0 (abc1234)', pinned = '0.99.2') {
  return derivePlatformUpdates({
    read,
    kernelVersion,
    pinnedPiVersion: pinned,
    activeImagePiVersion: pinned,
    now: NOW,
  });
}

describe('releaseChannelFromFile', () => {
  it('is fresh within both limits and keeps the record', () => {
    const read = readOf(channel());
    expect(read.channel?.platform.latest).toBe('v0.44.0');
    expect(read.feed).toMatchObject({
      status: 'fresh',
      fetchedAt: '2026-10-08T11:00:00.000Z',
      generatedAt: '2026-10-08T03:30:00Z',
      maxAgeHours: UPDATE_FEED_MAX_AGE_HOURS,
    });
  });

  it('is stale after 48 h without a successful download, and still keeps the record', () => {
    expect(readOf(channel(), 48).feed.status).toBe('fresh');
    expect(readOf(channel(), 48).feed.staleCause).toBeNull();
    const stale = readOf(channel(), 49);
    expect(stale.feed).toMatchObject({ status: 'stale', staleCause: 'download' });
    expect(stale.feed.detail).toContain('update-feed');
    expect(stale.channel).not.toBeNull();
  });

  it('is stale when CI stopped writing the record, even if the download is fresh', () => {
    const read = readOf(channel({ generatedAt: '2026-10-05T03:00:00Z' }));
    expect(read.feed).toMatchObject({ status: 'stale', staleCause: 'ci' });
    // Both halves stale: the download is the cause — a record not being fetched says nothing
    // about CI.
    expect(readOf(channel({ generatedAt: '2026-10-05T03:00:00Z' }), 49).feed.staleCause).toBe(
      'download',
    );
    expect(read.feed.detail).toContain('CI last wrote the record');
  });

  it('rejects non-JSON and schema violations as invalid, using nothing from them', () => {
    const notJson = releaseChannelFromFile('/f', '<html>', NOW, NOW, FEED_REPO);
    expect(notJson).toMatchObject({ channel: null, feed: { status: 'invalid' } });

    const forged = [
      { ...channel(), schema: 2 },
      channel({
        platform: {
          latest: 'v0.44.0',
          releases: [{ ...release('v0.44.0', '1.0.2'), previousVersion: 'v0.44.0' }],
        },
      }),
      channel({
        platform: {
          latest: 'v0.44.0',
          releases: [{ ...release('v0.44.0', '1.0.2'), notesUrl: 'https://evil.example/x' }],
        },
      }),
      channel({
        piUpstream: { ...UPSTREAM, failureSummary: 'x'.repeat(501) },
      }),
      channel({
        platform: { latest: 'v0.44.0', releases: [release('v0.44.0', '1.0.2', ['DROP TABLE'])] },
      }),
    ];
    for (const record of forged) {
      const read = releaseChannelFromFile('/f', JSON.stringify(record), NOW, NOW, FEED_REPO);
      expect(read.channel).toBeNull();
      expect(read.feed.status).toBe('invalid');
      expect(read.feed.detail).toContain('rejected');
    }
  });
});

describe('derivePlatformUpdates', () => {
  it('lists every newer release, the migrations crossed in apply order, and the exact command', () => {
    const result = derive(readOf(channel()));
    expect(result.platformUpdate).toMatchObject({
      currentVersion: 'v0.42.0',
      latestVersion: 'v0.44.0',
      available: true,
      migrations: ['core 0041', 'task 0006', 'core 0042'],
      migrationsIncomplete: false,
      breaking: true,
      notesUrl: `${REPO}/releases/tag/v0.44.0`,
      applyCommand: 'sh scripts/apply-release.sh --pull v0.44.0',
      rollbackVersion: 'v0.42.0',
    });
    expect(result.platformUpdate?.newerReleases.map((r) => r.version)).toEqual([
      'v0.44.0',
      'v0.43.0',
    ]);
    // pi 1.0.2 comes with v0.43.0, which is newer than what runs: the platform update says it.
    expect(result.piUpdate).toMatchObject({
      state: 'released',
      bundledVersion: '0.99.2',
      upstreamLatest: '1.0.2',
      bundledIn: 'v0.43.0',
    });
  });

  it('flags the migration list as partial only when this version predates the window base', () => {
    // The record lists v0.41.0 and newer, counted from v0.40.0 (v0.41.0's previousVersion): a
    // host on v0.40.0 gets every migration it will cross; one on v0.39.0 misses what v0.40.0
    // added (apply-release still runs them).
    expect(derive(readOf(channel()), 'v0.39.0 (aaa1111)').platformUpdate).toMatchObject({
      available: true,
      migrationsIncomplete: true,
    });
    for (const current of ['v0.40.0 (aaa1111)', 'v0.41.0 (bbb2222)']) {
      expect(derive(readOf(channel()), current).platformUpdate?.migrationsIncomplete).toBe(false);
    }
    // A record written before previousVersion existed is still valid; without the window base the
    // oldest listed release is the bound (the pre-field judgment).
    const legacy = channel();
    const legacyReleases = legacy.platform.releases.map(({ previousVersion: _, ...r }) => r);
    const legacyRead = releaseChannelFromFile(
      '/f',
      JSON.stringify({ ...legacy, platform: { ...legacy.platform, releases: legacyReleases } }),
      NOW,
      NOW,
      FEED_REPO,
    );
    expect(legacyRead.feed.status).toBe('fresh');
    expect(derive(legacyRead, 'v0.40.0 (aaa1111)').platformUpdate?.migrationsIncomplete).toBe(true);
    expect(derive(legacyRead, 'v0.41.0 (bbb2222)').platformUpdate?.migrationsIncomplete).toBe(
      false,
    );
    // The window reaches back to the repository's first release: nothing is missing.
    const fromFirst = channel();
    const releases = fromFirst.platform.releases.map((r, i, all) =>
      i === all.length - 1 ? { ...r, previousVersion: null } : r,
    );
    expect(
      derive(readOf({ ...fromFirst, platform: { ...fromFirst.platform, releases } }), 'v0.30.0 (c)')
        .platformUpdate?.migrationsIncomplete,
    ).toBe(false);
  });

  it('has nothing to offer on the latest release', () => {
    const result = derive(readOf(channel()), 'v0.44.0 (def5678)', '1.0.2');
    expect(result.platformUpdate).toMatchObject({
      available: false,
      newerReleases: [],
      migrations: [],
      breaking: false,
      applyCommand: null,
      rollbackVersion: 'v0.44.0',
    });
    expect(result.piUpdate.state).toBe('up_to_date');
  });

  it('cannot call anything newer for a dev build, but still reports the latest', () => {
    const result = derive(readOf(channel()), 'dev');
    expect(result.platformUpdate).toMatchObject({
      currentVersion: null,
      latestVersion: 'v0.44.0',
      available: false,
      rollbackVersion: null,
    });
  });

  it('① upstream pi passed the SDK suite and no release bundles it yet', () => {
    const record = channel({
      piUpstream: { ...UPSTREAM, latest: '1.0.3', bundledIn: null },
    });
    const result = derive(readOf(record), 'v0.44.0 (x)', '1.0.2');
    expect(result.piUpdate).toMatchObject({ state: 'pending_release', upstreamLatest: '1.0.3' });
  });

  it('② upstream pi failed the SDK suite', () => {
    const record = channel({
      piUpstream: {
        ...UPSTREAM,
        latest: '1.1.0',
        sdkSuite: 'fail',
        failureSummary: '7 tests failed (+ typecheck errors)',
        bundledIn: null,
      },
    });
    const result = derive(readOf(record), 'v0.44.0 (x)', '1.0.2');
    expect(result.piUpdate).toMatchObject({
      state: 'incompatible',
      failureSummary: '7 tests failed (+ typecheck errors)',
    });
  });

  it('is unknown without a pi upstream record or without this build’s pi.version', () => {
    expect(derive(readOf(channel({ piUpstream: null }))).piUpdate.state).toBe('unknown');
    const noPin = derivePlatformUpdates({
      read: readOf(channel()),
      kernelVersion: 'v0.42.0',
      pinnedPiVersion: null,
      activeImagePiVersion: null,
      now: NOW,
    });
    expect(noPin.piUpdate.state).toBe('unknown');
  });

  it('reads a record carrying fields a newer CI added, and passes none of them on', () => {
    const base = channel();
    const newer = {
      ...base,
      addedLater: 'top',
      platform: {
        ...base.platform,
        addedLater: 'platform',
        releases: base.platform.releases.map((r) => ({ ...r, addedLater: 'release' })),
      },
      piUpstream: { ...UPSTREAM, addedLater: 'pi' },
    };
    const read = releaseChannelFromFile('/f', JSON.stringify(newer), NOW, NOW, FEED_REPO);
    expect(read.feed.status).toBe('fresh');
    expect(read.channel).toEqual(base);
    // Known fields stay strictly typed: a bad value in one is still a rejected record.
    const badKnown = { ...newer, generatedAt: 'yesterday' };
    expect(
      releaseChannelFromFile('/f', JSON.stringify(badKnown), NOW, NOW, FEED_REPO).channel,
    ).toBeNull();
  });

  it('rejects a record linking outside the UPDATE_FEED_URL repository, case-insensitively', () => {
    const foreign = channel({
      platform: {
        latest: 'v0.44.0',
        releases: [
          {
            ...release('v0.44.0', '1.0.2'),
            notesUrl: 'https://github.com/someone-else/fork/releases/tag/v0.44.0',
          },
        ],
      },
    });
    const read = releaseChannelFromFile('/f', JSON.stringify(foreign), NOW, NOW, FEED_REPO);
    expect(read).toMatchObject({ channel: null, feed: { status: 'invalid' } });
    expect(read.feed.detail).toContain('links outside example/nexttime-ai');

    const foreignRun = channel({
      piUpstream: { ...UPSTREAM, runUrl: 'https://github.com/someone-else/fork/actions/runs/1' },
    });
    expect(
      releaseChannelFromFile('/f', JSON.stringify(foreignRun), NOW, NOW, FEED_REPO).channel,
    ).toBeNull();

    const own = releaseChannelFromFile(
      '/f',
      JSON.stringify(channel()),
      NOW,
      NOW,
      'Example/NextTime-AI'.toLowerCase(),
    );
    expect(own.channel).not.toBeNull();
    expect(
      releaseChannelFromFile('/f', JSON.stringify(channel()), NOW, NOW, null).feed.status,
    ).toBe('invalid');
  });

  it('takes the repository from UPDATE_FEED_URL, lower-cased; null for anything else', () => {
    expect(
      resolveUpdateFeedRepo({
        UPDATE_FEED_URL: 'https://github.com/Owner/Repo.X/releases/download/channel/channel.json',
      }),
    ).toBe('owner/repo.x');
    expect(resolveUpdateFeedRepo({})).toBe('btnalit/nexttime-ai');
    expect(
      resolveUpdateFeedRepo({ UPDATE_FEED_URL: 'https://mirror.example/channel.json' }),
    ).toBeNull();
  });

  it('uses nothing from an invalid or missing record', () => {
    const invalid = derive(releaseChannelFromFile('/f', '{}', NOW, NOW, FEED_REPO));
    expect(invalid.platformUpdate).toBeNull();
    expect(invalid.piUpdate).toMatchObject({ state: 'unknown', upstreamLatest: null });
    expect(invalid.feedFreshness.status).toBe('invalid');
  });
});

describe('readReleaseChannel', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'update-feed-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('a missing file is an explicit missing, never a throw', async () => {
    const read = await readReleaseChannel(path.join(dir, 'channel.json'), NOW, FEED_REPO);
    expect(read).toMatchObject({ channel: null, feed: { status: 'missing', fetchedAt: null } });
    expect(read.feed.detail).toContain('update-feed');
  });

  it('a directory at the path is missing too', async () => {
    const file = path.join(dir, 'channel.json');
    await mkdir(file);
    expect((await readReleaseChannel(file, NOW, FEED_REPO)).feed.status).toBe('missing');
  });

  it('reads the file and takes the download time from its modification time', async () => {
    const file = path.join(dir, 'channel.json');
    await writeFile(file, JSON.stringify(channel()));
    const fetched = new Date(NOW.getTime() - 50 * HOUR);
    await utimes(file, fetched, fetched);
    const read = await readReleaseChannel(file, NOW, FEED_REPO);
    expect(read.feed).toMatchObject({ status: 'stale', fetchedAt: fetched.toISOString() });
    expect(read.channel?.platform.latest).toBe('v0.44.0');
  });

  it('rejects a file over the size cap without parsing it', async () => {
    const file = path.join(dir, 'channel.json');
    await writeFile(file, ' '.repeat(RELEASE_CHANNEL_MAX_BYTES + 1));
    const read = await readReleaseChannel(file, NOW, FEED_REPO);
    expect(read).toMatchObject({ channel: null, feed: { status: 'invalid' } });
    expect(read.feed.detail).toContain(`> ${RELEASE_CHANNEL_MAX_BYTES}`);
  });

  it('resolves the file from UPDATE_FEED_FILE, defaulting to the config mount', () => {
    expect(resolveUpdateFeedFile({})).toBe(DEFAULT_UPDATE_FEED_FILE);
    expect(resolveUpdateFeedFile({ UPDATE_FEED_FILE: '/tmp/c.json' })).toBe('/tmp/c.json');
  });
});
