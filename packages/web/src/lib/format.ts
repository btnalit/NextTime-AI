import type { Translate } from './i18n.js';

/**
 * lib/format: display formatting for ids, times and durations. Pure; every function takes an
 * optional `now` so tests are deterministic.
 *
 * Time formatting (S8 W1-A2, docs/development-tasks.md §5e, audit S9/PW1): one formatter family,
 * zh-CN, rendered in the browser's own time zone (never a fixed zone — the console has no way to
 * know the operator's zone otherwise) but every *absolute* timestamp is labelled with that zone
 * (`formatDateTime`), because the host the console is proxied to often runs in a different zone
 * than the browser viewing it (audit S9: "浏览器在 PDT，主机在 CST"). `formatRelative` is
 * symmetric — past "N 分钟/小时前", future "N 分钟/小时后" — because a future instant (an ephemeral
 * workspace's `expiresAt`, PW1) must never render as "just now"/"刚刚": the old implementation
 * clamped `now - ms` to a `Math.max(0, …)` floor, which made every future timestamp render as the
 * nearest-to-zero bucket regardless of how far in the future it actually was.
 */

/** First 8 characters — enough to tell uuids apart in a list; the full id is a hover/copy away. */
export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function parse(iso: string | null | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Midnight (local time) of the calendar day containing `ms` — the boundary `formatRelative` uses
 *  for its "昨天"/"明天" bucket. Local `Date` accessors/mutators, so this follows the runtime's own
 *  zone (and its DST rules, if any) rather than a fixed 86_400_000ms day length. */
function localDayStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** `UTC+8` / `UTC+5:30` / `UTC-3` / `UTC+0` — the runtime's own zone offset at `ms` (computed per
 *  instant, not once, so a DST transition between two timestamps is reflected correctly), for the
 *  label `formatDateTime` appends to every absolute timestamp. */
function timeZoneLabel(ms: number): string {
  const offsetMin = -new Date(ms).getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? `:${pad2(m)}` : ''}`;
}

/** `MM-DD` (or `YYYY-MM-DD` when `ms` falls in a year other than `now`'s) — the compact calendar
 *  date shared by `formatDateTime` and `formatRelative`'s beyond-a-week fallback. */
function formatShortDate(ms: number, now: number): string {
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return sameYear
    ? `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
    : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * "刚刚" (±60s of `now`) / "N 分钟前" / "N 小时前" / "昨天 17:59" / "N 天前" / a short date beyond a
 * week — mirrored for the future: "N 分钟后" / "N 小时后" / "明天 17:59" / "N 天后" / a short date.
 *
 * Bucket order: an elapsed-time window (minutes, then hours) is checked *before* the calendar-day
 * comparison, so a timestamp from 23:55 yesterday sent 10 minutes ago still reads "10 分钟前" (the
 * reader's intuition — "a few minutes ago" — wins over the midnight crossing); only once elapsed
 * time reaches a full hour does a calendar-day difference of exactly ±1 switch to "昨天"/"明天" +
 * the target's own clock time. "刚刚" has no direction — within ±60s the two are indistinguishable
 * to a human reader — and the minute bucket only starts once a full minute has elapsed, so a "0m
 * ago"/"0 分钟前" (the audit's other S9 complaint) cannot occur.
 */
export function formatRelative(iso: string | null | undefined, now: number = Date.now()): string {
  const ms = parse(iso);
  if (ms === undefined) return '—';
  const diff = now - ms; // > 0 past, < 0 future
  const absDiff = Math.abs(diff);
  if (absDiff <= 60_000) return '刚刚';

  const absMinutes = Math.floor(absDiff / 60_000);
  if (absMinutes < 60) return diff > 0 ? `${absMinutes} 分钟前` : `${absMinutes} 分钟后`;

  const dayDiff = Math.round((localDayStart(now) - localDayStart(ms)) / 86_400_000);
  if (dayDiff === 0) {
    const absHours = Math.floor(absDiff / 3_600_000);
    return diff > 0 ? `${absHours} 小时前` : `${absHours} 小时后`;
  }

  if (dayDiff === 1 || dayDiff === -1) {
    const target = new Date(ms);
    const clock = `${pad2(target.getHours())}:${pad2(target.getMinutes())}`;
    return dayDiff === 1 ? `昨天 ${clock}` : `明天 ${clock}`;
  }
  if (dayDiff >= 2 && dayDiff <= 6) return `${dayDiff} 天前`;
  if (dayDiff <= -2 && dayDiff >= -6) return `${-dayDiff} 天后`;
  return formatShortDate(ms, now);
}

/** Full local date-time for detail views and `title` attributes — compact (`MM-DD HH:mm`, no
 *  seconds: minute precision is enough for an operator scanning a list; the adjacent
 *  `formatRelative` label or a second look at `formatDuration` covers sub-minute ordering when it
 *  matters) with the runtime's own zone labelled, e.g. `09-25 17:59 (UTC+8)` — the host this
 *  console is proxied to can run in a different zone than the browser viewing it (audit S9), so
 *  the label is never omitted. Year is shown only when `iso` falls in a year other than `now`'s. */
export function formatDateTime(iso: string | null | undefined, now: number = Date.now()): string {
  const ms = parse(iso);
  if (ms === undefined) return '—';
  const d = new Date(ms);
  const timePart = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return `${formatShortDate(ms, now)} ${timePart} (${timeZoneLabel(ms)})`;
}

/** Clock time only (`HH:mm`, local zone, no date/zone label) — for an inline per-message
 *  timestamp that already sits next to a full `formatDateTime` in its `title` tooltip (S8 W1-A2,
 *  `components/ChatPage.tsx`'s message rows). */
export function formatTime(iso: string | null | undefined): string {
  const ms = parse(iso);
  if (ms === undefined) return '—';
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** "12s" / "3m 04s" / "1h 02m" between two instants (`end` defaults to now — an elapsed time). */
export function formatDuration(
  startIso: string | null | undefined,
  endIso?: string | null,
  now: number = Date.now(),
): string {
  const start = parse(startIso);
  if (start === undefined) return '—';
  const end = parse(endIso) ?? now;
  const total = Math.max(0, Math.floor((end - start) / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return `${m}m ${String(s).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

/** `docker.container_restart` → `docker container restart` (the kernel's own label convention,
 *  `application/linkage/content.ts`). */
export function humanizeKind(kind: string): string {
  return kind.replace(/[._-]+/g, ' ').trim() || kind;
}

/** A platform audit row's actor, for display: the login when known, else the raw id, else — 遗留
 *  54 (`packages/kernel/src/application/platform/purge-workspace.ts`) — an operator-CLI purge with
 *  no resolvable administrator writes `actorUserId: null` rather than skipping the row. Never
 *  render that as a blank chip or `"null"` (a template literal would otherwise stringify it
 *  verbatim). Structurally typed (not `PlatformAuditRecordWire`) to keep this module
 *  dependency-free, same as every other helper here. */
export function formatAuditActor(
  row: {
    readonly actorLogin: string | null;
    readonly actorUserId: string | null;
  },
  t: Translate,
): string {
  return (
    row.actorLogin ?? row.actorUserId ?? t('主机操作员（未署名）', 'Host operator (unattributed)')
  );
}

/** Pretty JSON, or the raw string when the value is not serializable. */
export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** One-line excerpt of arbitrary JSON, for list rows. */
export function excerpt(value: unknown, max = 120): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const SENSITIVE_KEY =
  /credential|secret|token|password|passwd|api[_-]?key|authorization|private[_-]?key/i;

/** Deep-copies `value` with sensitive-looking keys replaced by `[redacted]`, so a params dump in
 *  the UI never shows what the kernel's own audit redaction (`dispatch.ts` `redactAuditParams`)
 *  would also hide. Display-only defense; the kernel already never returns credentials. */
export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redactSensitive(inner);
    }
    return out;
  }
  return value;
}
