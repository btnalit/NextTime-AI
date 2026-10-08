import type {
  PiUpdateWire,
  PlatformUpdateFeedWire,
  PlatformUpdateWire,
  PlatformUpdatesWire,
} from '@nexttime/shared';

/** Fixtures for the S10 U1 `platform_updates` read, shared by the overview / runtime / status
 *  page tests. The default is the quiet state: nothing newer, feed fresh. */
export function platformUpdate(overrides: Partial<PlatformUpdateWire> = {}): PlatformUpdateWire {
  return {
    currentVersion: 'v0.42.0',
    latestVersion: 'v0.42.0',
    available: false,
    newerReleases: [],
    migrations: [],
    breaking: false,
    notesUrl: null,
    applyCommand: null,
    rollbackVersion: null,
    ...overrides,
  };
}

/** A platform update to v0.43.0 (one release, pi 1.0.2, core 0041, not breaking). */
export function availablePlatformUpdate(
  overrides: Partial<PlatformUpdateWire> = {},
): PlatformUpdateWire {
  return platformUpdate({
    latestVersion: 'v0.43.0',
    available: true,
    newerReleases: [
      {
        version: 'v0.43.0',
        publishedAt: '2026-10-05T00:00:00.000Z',
        pi: '1.0.2',
        migrations: ['core 0041'],
        breaking: false,
        notesUrl: 'https://github.com/example/repo/releases/tag/v0.43.0',
      },
    ],
    migrations: ['core 0041'],
    notesUrl: 'https://github.com/example/repo/releases/tag/v0.43.0',
    applyCommand: 'sh scripts/apply-release.sh --pull v0.43.0',
    rollbackVersion: 'v0.42.0',
    ...overrides,
  });
}

export function piUpdate(overrides: Partial<PiUpdateWire> = {}): PiUpdateWire {
  return {
    state: 'up_to_date',
    bundledVersion: '1.0.2',
    activeImageVersion: '1.0.2',
    upstreamLatest: '1.0.2',
    sdkSuite: 'pass',
    failureSummary: null,
    bundledIn: null,
    checkedAt: '2026-10-07T03:00:00.000Z',
    runUrl: null,
    ...overrides,
  };
}

export function feedFreshness(
  overrides: Partial<PlatformUpdateFeedWire> = {},
): PlatformUpdateFeedWire {
  return {
    status: 'fresh',
    fetchedAt: '2026-10-07T04:00:00.000Z',
    generatedAt: '2026-10-07T03:00:00.000Z',
    maxAgeHours: 48,
    detail: 'channel.json fetched 1h ago (limit 48h)',
    ...overrides,
  };
}

export function platformUpdates(overrides: Partial<PlatformUpdatesWire> = {}): PlatformUpdatesWire {
  return {
    platformUpdate: platformUpdate(),
    piUpdate: piUpdate(),
    feedFreshness: feedFreshness(),
    checkedAt: '2026-10-07T05:00:00.000Z',
    ...overrides,
  };
}
