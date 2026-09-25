import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  excerpt,
  formatAuditActor,
  formatDateTime,
  formatDuration,
  formatRelative,
  formatTime,
  humanizeKind,
  redactSensitive,
  shortId,
} from './format.js';
import type { Translate } from './i18n.js';

// Every calendar-day-sensitive assertion below needs a fixed, known zone — pin the whole file to
// UTC so it is deterministic on any host/CI machine regardless of its own local zone, and restore
// whatever was there afterwards. The dedicated "时区" describe block below temporarily overrides
// this for its own two zones.
const ORIGINAL_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'UTC';
});
// `process.env.TZ = undefined` would coerce to the literal string "undefined" (Node stringifies
// every process.env assignment) — a real, invalid TZ value, not "no TZ set" — so an actual
// `delete` is required below, not the usual `= undefined` replacement.
afterAll(() => {
  // biome-ignore lint/performance/noDelete: see the comment above this block.
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

const NOW = Date.parse('2026-09-03T12:00:00.000Z');

describe('format', () => {
  it('shortId keeps 8 characters', () => {
    expect(shortId('0123456789abcdef')).toBe('01234567');
    expect(shortId('abc')).toBe('abc');
  });

  it('formatDuration renders s / m s / h m', () => {
    expect(formatDuration('2026-09-03T11:59:48.000Z', null, NOW)).toBe('12s');
    expect(formatDuration('2026-09-03T11:56:56.000Z', '2026-09-03T12:00:00.000Z')).toBe('3m 04s');
    expect(formatDuration('2026-09-03T10:58:00.000Z', null, NOW)).toBe('1h 02m');
  });

  it('humanizeKind matches the kernel label convention', () => {
    expect(humanizeKind('docker.container_restart')).toBe('docker container restart');
  });

  it('formatAuditActor prefers login, falls back to the (truncated) id, then to an unattributed label (遗留 54, AU1)', () => {
    const zhT: Translate = (zh) => zh;
    expect(formatAuditActor({ actorLogin: 'alice', actorUserId: 'u-1' }, zhT)).toBe('alice');
    expect(formatAuditActor({ actorLogin: null, actorUserId: 'u-1' }, zhT)).toBe('u-1');
    // S8 W4-A (ui-audit AU1): a full-length id falls back through `shortId`, never the literal
    // full id — a platform user id has no `resolve_refs` kind to resolve a RefChip through.
    expect(
      formatAuditActor(
        { actorLogin: null, actorUserId: '12345678-abcd-4321-8888-000000000000' },
        zhT,
      ),
    ).toBe('12345678');
    // A CLI purge with no resolvable administrator (`platform.workspace_purged`,
    // `payload.attributedActor: false`) writes actor_user_id null — never render that as blank or
    // the literal string "null".
    expect(formatAuditActor({ actorLogin: null, actorUserId: null }, zhT)).toBe(
      '主机操作员（未署名）',
    );
  });

  it('excerpt truncates and redactSensitive masks credential-like keys deeply', () => {
    expect(excerpt('x'.repeat(200), 20)?.length).toBe(20);
    expect(
      redactSensitive({ a: 1, nested: { apiKey: 's', list: [{ password: 'p', ok: 2 }] } }),
    ).toEqual({
      a: 1,
      nested: { apiKey: '[redacted]', list: [{ password: '[redacted]', ok: 2 }] },
    });
  });

  describe('formatRelative — bad input', () => {
    it('tolerates null/unparsable input', () => {
      expect(formatRelative(null, NOW)).toBe('—');
      expect(formatRelative('not a date', NOW)).toBe('—');
    });
  });

  describe('formatRelative — 刚刚 (±60s, no direction, no "0m ago")', () => {
    it('is "刚刚" from 60s in the past through 60s in the future, inclusive', () => {
      expect(formatRelative(new Date(NOW - 60_000).toISOString(), NOW)).toBe('刚刚');
      expect(formatRelative(new Date(NOW - 10_000).toISOString(), NOW)).toBe('刚刚');
      expect(formatRelative(new Date(NOW).toISOString(), NOW)).toBe('刚刚');
      expect(formatRelative(new Date(NOW + 10_000).toISOString(), NOW)).toBe('刚刚');
      expect(formatRelative(new Date(NOW + 60_000).toISOString(), NOW)).toBe('刚刚');
    });

    it('never renders "0 分钟前/后" just past the ±60s window', () => {
      expect(formatRelative(new Date(NOW - 61_000).toISOString(), NOW)).toBe('1 分钟前');
      expect(formatRelative(new Date(NOW + 61_000).toISOString(), NOW)).toBe('1 分钟后');
    });
  });

  describe('formatRelative — minutes and hours, symmetric', () => {
    it('past: minutes then hours', () => {
      expect(formatRelative('2026-09-03T11:55:00.000Z', NOW)).toBe('5 分钟前');
      expect(formatRelative('2026-09-03T09:00:00.000Z', NOW)).toBe('3 小时前');
    });

    it('future: minutes then hours — never clamped to "刚刚"/zero (PW1)', () => {
      expect(formatRelative('2026-09-03T12:05:00.000Z', NOW)).toBe('5 分钟后');
      expect(formatRelative('2026-09-03T15:00:00.000Z', NOW)).toBe('3 小时后');
    });

    it('an elapsed minute bucket wins over a real midnight crossing', () => {
      // now = 00:05, target = 23:55 the previous UTC calendar day — 10 minutes elapsed, one
      // calendar day apart. Reader intuition ("a few minutes ago") beats the calendar: this must
      // read "10 分钟前", not "昨天 23:55".
      const midnightNow = Date.parse('2026-09-03T00:05:00.000Z');
      expect(formatRelative('2026-09-02T23:55:00.000Z', midnightNow)).toBe('10 分钟前');
    });
  });

  describe('formatRelative — 昨天/明天 (calendar day, not a fixed 24h/48h window)', () => {
    it('past: 昨天 + the target clock time', () => {
      // 26h01m elapsed, but a full calendar day apart.
      expect(formatRelative('2026-09-02T09:59:00.000Z', NOW)).toBe('昨天 09:59');
    });

    it('future: 明天 + the target clock time', () => {
      expect(formatRelative('2026-09-04T09:05:00.000Z', NOW)).toBe('明天 09:05');
    });
  });

  describe('formatRelative — N 天前/后 (2–6 calendar days)', () => {
    it('past', () => {
      expect(formatRelative('2026-09-01T12:00:00.000Z', NOW)).toBe('2 天前');
      expect(formatRelative('2026-08-29T12:00:00.000Z', NOW)).toBe('5 天前');
    });

    it('future — this is PW1: an ephemeral workspace expiring in 2 days must read "2 天后", never "expires just now"', () => {
      expect(formatRelative('2026-09-05T12:00:00.000Z', NOW)).toBe('2 天后');
      expect(formatRelative('2026-09-08T12:00:00.000Z', NOW)).toBe('5 天后');
    });
  });

  describe('formatRelative — beyond a week: a short absolute date', () => {
    it('past and future, same year (no year prefix)', () => {
      expect(formatRelative('2026-08-01T12:00:00.000Z', NOW)).toBe('08-01');
      expect(formatRelative('2026-10-01T12:00:00.000Z', NOW)).toBe('10-01');
    });

    it('a different year gets a year prefix', () => {
      expect(formatRelative('2025-08-01T12:00:00.000Z', NOW)).toBe('2025-08-01');
    });
  });

  describe('formatDateTime', () => {
    it('renders MM-DD HH:mm with a UTC zone label (UTC-pinned for this suite)', () => {
      expect(formatDateTime('2026-09-25T09:59:00.000Z', NOW)).toBe('09-25 09:59 (UTC+0)');
    });

    it('prefixes the year only when it differs from `now`', () => {
      expect(formatDateTime('2025-01-01T00:00:00.000Z', NOW)).toBe('2025-01-01 00:00 (UTC+0)');
    });

    it('tolerates null/unparsable input', () => {
      expect(formatDateTime(null, NOW)).toBe('—');
      expect(formatDateTime('not a date', NOW)).toBe('—');
    });
  });

  describe('formatTime', () => {
    it('renders HH:mm only, no date or zone', () => {
      expect(formatTime('2026-09-03T09:05:00.000Z')).toBe('09:05');
      expect(formatTime(null)).toBe('—');
    });
  });
});

describe('format — time zone label and calendar boundary across real zones', () => {
  const ORIGINAL = process.env.TZ;
  afterEach(() => {
    // biome-ignore lint/performance/noDelete: same reason as the file-level afterAll above.
    if (ORIGINAL === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL;
  });

  it('a DST-free zone ahead of UTC (Asia/Shanghai, UTC+8, no half-hour offset)', () => {
    process.env.TZ = 'Asia/Shanghai';
    // 2026-09-03T12:00:00Z is 2026-09-03 20:00 in Shanghai.
    const now = Date.parse('2026-09-03T12:00:00.000Z');
    expect(formatDateTime('2026-09-03T12:00:00.000Z', now)).toBe('09-03 20:00 (UTC+8)');
    // 09:00Z the same day is 17:00 Shanghai the same calendar day — an hours-bucket, not 昨天.
    expect(formatRelative('2026-09-03T09:00:00.000Z', now)).toBe('3 小时前');
    // 2026-09-02T20:00:00Z is 2026-09-03 04:00 Shanghai — still "today" in Shanghai, so this is an
    // hours-bucket too even though it crossed a UTC-day boundary.
    expect(formatRelative('2026-09-02T20:00:00.000Z', now)).toBe('16 小时前');
  });

  it('a zone with a non-hour offset (Asia/Kolkata, UTC+5:30)', () => {
    process.env.TZ = 'Asia/Kolkata';
    const now = Date.parse('2026-09-03T12:00:00.000Z'); // 17:30 IST
    expect(formatDateTime('2026-09-03T12:00:00.000Z', now)).toBe('09-03 17:30 (UTC+5:30)');
    // A day earlier at the same UTC instant is exactly one IST calendar day back.
    expect(formatRelative('2026-09-02T12:00:00.000Z', now)).toBe('昨天 17:30');
  });
});
