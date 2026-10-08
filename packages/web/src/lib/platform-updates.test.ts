// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  availablePlatformUpdate,
  feedFreshness,
  piUpdate,
  platformUpdate,
  platformUpdates,
} from '../components/platform/test-fixtures.js';
import {
  DISMISSED_CAP,
  DISMISSED_STORAGE_KEY,
  buildUpdateNotices,
  feedAge,
  feedNoticeKey,
  piUpstreamStateText,
  readDismissedKeys,
  withDismissedKey,
  writeDismissedKeys,
} from './platform-updates.js';

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

const NOW = Date.parse('2026-10-08T00:00:00.000Z');
const t = <T>(zh: T): T => zh;

describe('buildUpdateNotices', () => {
  it('is empty for the quiet state: up to date, nothing newer, feed fresh', () => {
    expect(buildUpdateNotices(platformUpdates(), NOW)).toEqual([]);
  });

  it('platform release: one notice with the facts, keyed by the latest version', () => {
    const [notice, ...rest] = buildUpdateNotices(
      platformUpdates({ platformUpdate: availablePlatformUpdate() }),
      NOW,
    );
    expect(rest).toEqual([]);
    expect(notice).toMatchObject({
      kind: 'platform',
      key: 'platform:v0.43.0',
      tone: 'info',
      latestVersion: 'v0.43.0',
      releaseCount: 1,
      piVersion: '1.0.2',
      migrations: ['core 0041'],
      breaking: false,
      applyCommand: 'sh scripts/apply-release.sh --pull v0.43.0',
      rollbackVersion: 'v0.42.0',
    });
  });

  it('platform release: breaking is a warn tone; the pi comes from the newest release, count spans all', () => {
    const base = availablePlatformUpdate();
    const first = base.newerReleases[0];
    if (!first) throw new Error('fixture');
    const [notice] = buildUpdateNotices(
      platformUpdates({
        platformUpdate: availablePlatformUpdate({
          breaking: true,
          migrations: ['core 0041', 'core 0042'],
          newerReleases: [{ ...first, version: 'v0.44.0', pi: '1.0.3', breaking: true }, first],
          latestVersion: 'v0.44.0',
        }),
      }),
      NOW,
    );
    expect(notice).toMatchObject({
      kind: 'platform',
      key: 'platform:v0.44.0',
      tone: 'warn',
      releaseCount: 2,
      piVersion: '1.0.3',
      breaking: true,
    });
  });

  it('no platform notice when available is false (even with a latest version) or the record is missing', () => {
    expect(
      buildUpdateNotices(
        platformUpdates({ platformUpdate: platformUpdate({ latestVersion: 'v0.42.0' }) }),
        NOW,
      ),
    ).toEqual([]);
    expect(
      buildUpdateNotices(
        platformUpdates({
          platformUpdate: null,
          feedFreshness: feedFreshness({ status: 'missing', fetchedAt: null, generatedAt: null }),
        }),
        NOW,
      ),
    ).toEqual([]);
  });

  it('pi pending_release (1): info notice with the check run link', () => {
    const [notice] = buildUpdateNotices(
      platformUpdates({
        piUpdate: piUpdate({
          state: 'pending_release',
          upstreamLatest: '1.0.2',
          runUrl: 'https://github.com/example/repo/actions/runs/42',
        }),
      }),
      NOW,
    );
    expect(notice).toEqual({
      kind: 'pi-pending',
      key: 'pi-pending:1.0.2',
      tone: 'info',
      upstreamLatest: '1.0.2',
      runUrl: 'https://github.com/example/repo/actions/runs/42',
    });
  });

  it('pi incompatible (2): warn notice with the failure summary', () => {
    const [notice] = buildUpdateNotices(
      platformUpdates({
        piUpdate: piUpdate({
          state: 'incompatible',
          upstreamLatest: '1.1.0',
          sdkSuite: 'fail',
          failureSummary: 'RpcClient.prompt is not a function',
        }),
      }),
      NOW,
    );
    expect(notice).toMatchObject({
      kind: 'pi-incompatible',
      key: 'pi-incompatible:1.1.0',
      tone: 'warn',
      failureSummary: 'RpcClient.prompt is not a function',
      runUrl: null,
    });
  });

  it('no separate notice for released / up_to_date / unknown pi states', () => {
    for (const state of ['released', 'up_to_date', 'unknown'] as const) {
      expect(
        buildUpdateNotices(
          platformUpdates({ piUpdate: piUpdate({ state, upstreamLatest: '1.0.2' }) }),
          NOW,
        ),
      ).toEqual([]);
    }
  });

  it('drops a link that is not https', () => {
    const [notice] = buildUpdateNotices(
      platformUpdates({
        platformUpdate: availablePlatformUpdate({ notesUrl: 'javascript:alert(1)' }),
      }),
      NOW,
    );
    expect(notice).toMatchObject({ kind: 'platform', notesUrl: null });
  });

  it('feed stale: warn notice with the age from fetchedAt, keyed by it', () => {
    const fetchedAt = '2026-10-05T12:00:00.000Z';
    const [notice] = buildUpdateNotices(
      platformUpdates({ feedFreshness: feedFreshness({ status: 'stale', fetchedAt }) }),
      NOW,
    );
    expect(notice).toEqual({
      kind: 'feed-stale',
      key: `feed-stale:${fetchedAt}`,
      tone: 'warn',
      age: { value: 2, unit: 'day' },
    });
  });

  it('feed invalid: danger notice carrying the kernel detail', () => {
    const [notice] = buildUpdateNotices(
      platformUpdates({
        platformUpdate: null,
        feedFreshness: feedFreshness({
          status: 'invalid',
          fetchedAt: null,
          detail: 'channel.json does not match the schema',
        }),
      }),
      NOW,
    );
    expect(notice).toEqual({
      kind: 'feed-invalid',
      key: 'feed-invalid:none',
      tone: 'danger',
      detail: 'channel.json does not match the schema',
    });
  });

  it('feed missing and fresh give nothing; several kinds keep platform, pi, feed order', () => {
    expect(
      buildUpdateNotices(
        platformUpdates({
          feedFreshness: feedFreshness({ status: 'missing', fetchedAt: null, generatedAt: null }),
        }),
        NOW,
      ),
    ).toEqual([]);
    const kinds = buildUpdateNotices(
      platformUpdates({
        platformUpdate: availablePlatformUpdate(),
        piUpdate: piUpdate({ state: 'pending_release', upstreamLatest: '1.0.3' }),
        feedFreshness: feedFreshness({ status: 'stale' }),
      }),
      NOW,
    ).map((n) => n.kind);
    expect(kinds).toEqual(['platform', 'pi-pending', 'feed-stale']);
  });
});

describe('feedAge / feedNoticeKey', () => {
  it('days when at least a day, otherwise hours (never 0)', () => {
    expect(feedAge('2026-10-06T00:00:00.000Z', NOW)).toEqual({ value: 2, unit: 'day' });
    expect(feedAge('2026-10-07T01:00:00.000Z', NOW)).toEqual({ value: 23, unit: 'hour' });
    expect(feedAge('2026-10-07T23:50:00.000Z', NOW)).toEqual({ value: 1, unit: 'hour' });
    expect(feedAge(null, NOW)).toBeNull();
    expect(feedAge('not a date', NOW)).toBeNull();
  });

  it('keys by status and fetch time, none when never fetched', () => {
    expect(feedNoticeKey('stale', '2026-10-05T00:00:00.000Z')).toBe(
      'feed-stale:2026-10-05T00:00:00.000Z',
    );
    expect(feedNoticeKey('invalid', null)).toBe('feed-invalid:none');
  });
});

describe('piUpstreamStateText', () => {
  it('has a text for each state; released names the bundling release', () => {
    expect(piUpstreamStateText(piUpdate({ state: 'up_to_date' }), t)).toBe('与本版一致');
    expect(piUpstreamStateText(piUpdate({ state: 'pending_release' }), t)).toBe(
      '兼容性初查通过，等待平台发版',
    );
    expect(piUpstreamStateText(piUpdate({ state: 'incompatible' }), t)).toBe('不兼容，暂不可升');
    expect(piUpstreamStateText(piUpdate({ state: 'released', bundledIn: 'v0.43.0' }), t)).toBe(
      '已由 v0.43.0 内置——升级平台即可获得',
    );
    expect(piUpstreamStateText(piUpdate({ state: 'unknown' }), t)).toBe('未取到上游版本信息');
  });
});

describe('dismissed keys', () => {
  it('round-trips through localStorage and caps the list to the newest entries', () => {
    expect(readDismissedKeys()).toEqual([]);
    let keys: readonly string[] = [];
    for (let i = 0; i < DISMISSED_CAP + 5; i += 1)
      keys = withDismissedKey(keys, `platform:v0.${i}.0`);
    expect(keys).toHaveLength(DISMISSED_CAP);
    expect(keys.at(-1)).toBe(`platform:v0.${DISMISSED_CAP + 4}.0`);
    expect(keys).not.toContain('platform:v0.0.0');
    writeDismissedKeys(keys);
    expect(readDismissedKeys()).toEqual(keys);
  });

  it('re-adding a key moves it to the end instead of duplicating it', () => {
    expect(withDismissedKey(['a', 'b'], 'a')).toEqual(['b', 'a']);
  });

  it('reads garbage as empty, and never throws when storage does', () => {
    window.localStorage.setItem(DISMISSED_STORAGE_KEY, '{not json');
    expect(readDismissedKeys()).toEqual([]);
    window.localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify({ a: 1 }));
    expect(readDismissedKeys()).toEqual([]);
    window.localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify(['ok', 3, null]));
    expect(readDismissedKeys()).toEqual(['ok']);

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readDismissedKeys()).toEqual([]);
    expect(() => writeDismissedKeys(['x'])).not.toThrow();
  });
});
