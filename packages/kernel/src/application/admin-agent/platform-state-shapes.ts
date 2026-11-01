import { isIpLiteral } from '@nexttime/shared';
import type { z } from 'zod';
import { findSuspectedSecrets } from '../../governance/redaction/index.js';

/**
 * application/admin-agent/platform-state-shapes (S11 AA2): the checks every `platform_state_*`
 * projection passes a source value through (platform-state.ts, platform-state-runtime.ts). A
 * string reaches an admin agent only in its shape — an enum, a pattern or an ISO timestamp — and
 * never as an IP literal or a credential-shaped value, however it is shaped; anything else is
 * dropped, nulled or counted by the caller.
 */

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

/** RFC 3339 as other processes write it: up to nanoseconds, `Z` or an offset. */
const RFC3339_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** `value` when it is a string of `pattern`'s shape that is neither an IP literal nor looks like
 *  a credential (the redactor's value patterns) — a dotted address or a vendor key can be a plain
 *  identifier too — else `null`. */
export function shaped(value: unknown, pattern: RegExp): string | null {
  return typeof value === 'string' &&
    pattern.test(value) &&
    !isIpLiteral(value) &&
    findSuspectedSecrets(value).count === 0
    ? value
    : null;
}

/** `value` when it is a version `pattern` (a RegExp or a string schema) admits and it does not look
 *  like a credential. Unlike {@link shaped} it is not refused as an IP literal: a three-part version
 *  (`0.73.1`) is one in the shorthand IPv4 reading. That is safe only for patterns that admit no
 *  written address — three numeric parts and at most one letter-led identifier with one numeric
 *  part after it (`PLATFORM_STATE_PI_VERSION_PATTERN`), never a dotted quad or a multi-label host
 *  name in a suffix; the credential check stays for any pattern. */
export function versionOf(value: unknown, pattern: RegExp | z.ZodType<string>): string | null {
  if (typeof value !== 'string') return null;
  const fits = pattern instanceof RegExp ? pattern.test(value) : pattern.safeParse(value).success;
  return fits && findSuspectedSecrets(value).count === 0 ? value : null;
}

/** An ISO timestamp the kernel itself wrote (`toISOString()`), else `null`. */
export function timestamp(value: unknown): string | null {
  return shaped(value, ISO_TIMESTAMP);
}

/** An RFC 3339 timestamp from another process (worker-supervisor reports the container engine's,
 *  to the nanosecond), rewritten as the kernel's ISO form — the output is `toISOString()`'s, never
 *  the source's text — else `null`. */
export function normalizedTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !RFC3339_TIMESTAMP.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** `value` when `schema` (an enum) accepts it, else `null`. */
export function member<T extends string>(schema: z.ZodType<T>, value: unknown): T | null {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function lengthOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/** `true` / `false` as given, anything else `null` (a tri-state the source left unknown). */
export function knownBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}
