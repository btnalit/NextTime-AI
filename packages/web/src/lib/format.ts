/**
 * lib/format: display formatting for ids, times and durations. Pure; every function takes an
 * optional `now` so tests are deterministic.
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

/** "just now" / "4m ago" / "3h ago" / "2d ago" / a short date beyond a week. */
export function formatRelative(iso: string | null | undefined, now: number = Date.now()): string {
  const ms = parse(iso);
  if (ms === undefined) return '—';
  const diff = Math.max(0, now - ms);
  const s = Math.floor(diff / 1000);
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Full local date-time, for detail views and `title` attributes. */
export function formatDateTime(iso: string | null | undefined): string {
  const ms = parse(iso);
  if (ms === undefined) return '—';
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
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
