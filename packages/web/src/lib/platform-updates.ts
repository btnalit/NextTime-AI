import type {
  PiUpdateWire,
  PlatformUpdateFeedStatusWire,
  PlatformUpdatesWire,
} from '@nexttime/shared';
import type { Translate } from './i18n.js';

/**
 * lib/platform-updates (S10 U1, docs/s10-evolution-plan-2026-10-04.md §4.2 ⑤): turns the kernel's
 * `platform_updates` read into the list of reminders the overview banner shows, and holds the
 * per-version "知道了" bookkeeping. Pure apart from `localStorage`, which every access wraps in
 * try/catch (private windows, blocked site data and thumbnail capture all make it throw) — the
 * banner works without it, a dismissal just does not outlive the tab then.
 *
 * Decisions 2 and 3: the console never upgrades. A platform-release notice carries the exact
 * command and checklist for the maintainer to run on the host, nothing more.
 */

export type UpdateNoticeKind =
  | 'platform'
  | 'pi-pending'
  | 'pi-incompatible'
  | 'feed-invalid'
  | 'feed-stale';

export type UpdateNoticeTone = 'info' | 'warn' | 'danger';

export interface PlatformReleaseNotice {
  readonly kind: 'platform';
  readonly key: string;
  readonly tone: UpdateNoticeTone;
  readonly latestVersion: string;
  /** How many releases newer than the running one exist (the notice says it spans N). */
  readonly releaseCount: number;
  /** The pi the newest release bundles; null when that release carries none. */
  readonly piVersion: string | null;
  readonly migrations: readonly string[];
  readonly breaking: boolean;
  readonly notesUrl: string | null;
  readonly applyCommand: string | null;
  readonly rollbackVersion: string | null;
}

export interface PiPendingNotice {
  readonly kind: 'pi-pending';
  readonly key: string;
  readonly tone: UpdateNoticeTone;
  readonly upstreamLatest: string;
  readonly runUrl: string | null;
}

export interface PiIncompatibleNotice {
  readonly kind: 'pi-incompatible';
  readonly key: string;
  readonly tone: UpdateNoticeTone;
  readonly upstreamLatest: string;
  readonly failureSummary: string | null;
  readonly runUrl: string | null;
}

export interface FeedInvalidNotice {
  readonly kind: 'feed-invalid';
  readonly key: string;
  readonly tone: UpdateNoticeTone;
  readonly detail: string;
}

export interface FeedStaleNotice {
  readonly kind: 'feed-stale';
  readonly key: string;
  readonly tone: UpdateNoticeTone;
  /** null when the feed carries no fetch time (should not happen for `stale`). */
  readonly age: FeedAge | null;
}

export type UpdateNotice =
  | PlatformReleaseNotice
  | PiPendingNotice
  | PiIncompatibleNotice
  | FeedInvalidNotice
  | FeedStaleNotice;

export interface FeedAge {
  readonly value: number;
  readonly unit: 'day' | 'hour';
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Whole days since `fetchedAt`, or whole hours (at least 1) when under a day. null when the
 *  timestamp is missing or unparseable. */
export function feedAge(fetchedAt: string | null, now: number = Date.now()): FeedAge | null {
  if (fetchedAt === null) return null;
  const ms = Date.parse(fetchedAt);
  if (Number.isNaN(ms)) return null;
  const elapsed = Math.max(0, now - ms);
  if (elapsed >= DAY_MS) return { value: Math.floor(elapsed / DAY_MS), unit: 'day' };
  return { value: Math.max(1, Math.floor(elapsed / HOUR_MS)), unit: 'hour' };
}

/** The wire already restricts these to this repository's GitHub pages (`ReleaseChannelUrlSchema`),
 *  but the console never trusts a href: anything that is not plain https is dropped. */
function safeUrl(url: string | null): string | null {
  return url !== null && /^https:\/\//.test(url) ? url : null;
}

/** The dismissal key of a feed-problem notice — a newer download or a changed state shows again. */
export function feedNoticeKey(
  status: PlatformUpdateFeedStatusWire,
  fetchedAt: string | null,
): string {
  return `feed-${status}:${fetchedAt ?? 'none'}`;
}

/**
 * The reminders to show, in display order, at most one of each kind. Nothing for `up_to_date` /
 * `unknown` / `released` pi states (the platform notice already names the pi it bundles), nor for
 * a `missing` feed. A `stale` feed still yields its notices: old version information is still
 * information, and the stale notice says how old.
 */
export function buildUpdateNotices(
  data: PlatformUpdatesWire,
  now: number = Date.now(),
): readonly UpdateNotice[] {
  const notices: UpdateNotice[] = [];

  const platform = data.platformUpdate;
  if (platform?.available && platform.latestVersion !== null) {
    notices.push({
      kind: 'platform',
      key: `platform:${platform.latestVersion}`,
      tone: platform.breaking ? 'warn' : 'info',
      latestVersion: platform.latestVersion,
      releaseCount: platform.newerReleases.length,
      piVersion: platform.newerReleases[0]?.pi ?? null,
      migrations: platform.migrations,
      breaking: platform.breaking,
      notesUrl: safeUrl(platform.notesUrl),
      applyCommand: platform.applyCommand,
      rollbackVersion: platform.rollbackVersion,
    });
  }

  const pi = data.piUpdate;
  if (pi.upstreamLatest !== null) {
    if (pi.state === 'pending_release') {
      notices.push({
        kind: 'pi-pending',
        key: `pi-pending:${pi.upstreamLatest}`,
        tone: 'info',
        upstreamLatest: pi.upstreamLatest,
        runUrl: safeUrl(pi.runUrl),
      });
    } else if (pi.state === 'incompatible') {
      notices.push({
        kind: 'pi-incompatible',
        key: `pi-incompatible:${pi.upstreamLatest}`,
        tone: 'warn',
        upstreamLatest: pi.upstreamLatest,
        failureSummary: pi.failureSummary,
        runUrl: safeUrl(pi.runUrl),
      });
    }
  }

  const feed = data.feedFreshness;
  if (feed.status === 'invalid') {
    notices.push({
      kind: 'feed-invalid',
      key: feedNoticeKey('invalid', feed.fetchedAt),
      tone: 'danger',
      detail: feed.detail,
    });
  } else if (feed.status === 'stale') {
    notices.push({
      kind: 'feed-stale',
      key: feedNoticeKey('stale', feed.fetchedAt),
      tone: 'warn',
      age: feedAge(feed.fetchedAt, now),
    });
  }

  return notices;
}

/** The "上游最新 pi" row's short state text on the pi runtime card. */
export function piUpstreamStateText(pi: PiUpdateWire, t: Translate): string {
  switch (pi.state) {
    case 'up_to_date':
      return t('与本版一致', 'Same as this release');
    case 'pending_release':
      return t(
        '兼容性初查通过，等待平台发版',
        'Initial compatibility check passed — awaiting a platform release',
      );
    case 'incompatible':
      return t('不兼容，暂不可升', 'Incompatible — cannot upgrade yet');
    case 'released':
      return pi.bundledIn !== null
        ? t(
            `已由 ${pi.bundledIn} 内置——升级平台即可获得`,
            `Bundled in ${pi.bundledIn} — upgrade the platform to get it`,
          )
        : t(
            '已有平台发版内置——升级平台即可获得',
            'A platform release bundles it — upgrade the platform to get it',
          );
    case 'unknown':
      return t('未取到上游版本信息', 'Upstream version information unavailable');
  }
}

// ---- dismissals ("知道了") ---------------------------------------------------------------------

export const DISMISSED_STORAGE_KEY = 'nexttime.platform-updates.dismissed';
/** Cap on the stored list: old versions fall off, the newest dismissals are what matter. */
export const DISMISSED_CAP = 20;

export function readDismissedKeys(): readonly string[] {
  try {
    const raw = window.localStorage.getItem(DISMISSED_STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string').slice(-DISMISSED_CAP);
  } catch {
    return [];
  }
}

/** `keys` plus `key` (moved to the end if already there), trimmed to the newest `DISMISSED_CAP`. */
export function withDismissedKey(keys: readonly string[], key: string): readonly string[] {
  return [...keys.filter((existing) => existing !== key), key].slice(-DISMISSED_CAP);
}

/** Best-effort: a failed write (quota, blocked storage) is swallowed. */
export function writeDismissedKeys(keys: readonly string[]): void {
  try {
    window.localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify(keys.slice(-DISMISSED_CAP)));
  } catch {
    // The dismissal still holds for this page view; it just will not persist.
  }
}
