import { GATE_ID_PATTERN } from './platform-errors.js';

/** `GATE_ID_PATTERN`'s length cap (`^[a-z0-9][a-z0-9-]{1,63}$` → 2–64 characters). */
export const GATE_ID_MAX_LENGTH = 64;

/**
 * Live normalization of a typed gate id (`create_gate_instance.gateId`, a packaged gate's
 * `GATE_ID`): lowercases, turns `_`, whitespace and `.` into `-`, drops every other character the
 * kernel's rule does not allow, strips leading hyphens (the rule wants a letter or digit first) and
 * caps the length. A trailing hyphen is kept — the user may still be typing the next segment.
 */
export function normalizeGateIdInput(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[_\s.]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+/, '')
    .slice(0, GATE_ID_MAX_LENGTH);
}

/** A finished slug from free text (a display name, a host name): `normalizeGateIdInput` plus
 *  collapsed and trimmed hyphens. `''` when nothing usable is left (e.g. an all-Chinese name) or
 *  the result would still not pass the kernel's rule. */
export function deriveGateId(source: string): string {
  const slug = normalizeGateIdInput(source)
    .replace(/-{2,}/g, '-')
    .slice(0, GATE_ID_MAX_LENGTH)
    .replace(/-+$/, '');
  return GATE_ID_PATTERN.test(slug) ? slug : '';
}

/** A gate-id suggestion from a target URL's host name (`https://billing.internal:8443/api` →
 *  `billing-internal`). Accepts a value without a scheme too. `''` when there is no host. */
export function gateIdFromTarget(target: string): string {
  const trimmed = target.trim();
  if (trimmed.length === 0) return '';
  try {
    return deriveGateId(new URL(withDefaultScheme(trimmed, 'https')).hostname);
  } catch {
    return '';
  }
}

/** `scheme://` at the start of a value. */
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Whether a value already starts with a URL scheme (`https://`, `http://`, …). */
export function hasUrlScheme(value: string): boolean {
  return SCHEME_PATTERN.test(value.trim());
}

/** Whether a scheme-less value could be a host (with optional port / path): no whitespace, no
 *  `://` anywhere (a mistyped scheme such as `://x` or `htps//x:` is not a host), and it does not
 *  start with `:`. */
function looksLikeBareHost(value: string): boolean {
  return !/\s/.test(value) && !value.includes('://') && !value.startsWith(':');
}

/** Prepends `<scheme>://` to a non-empty value that has none (`billing.internal` →
 *  `https://billing.internal`; a leading `//` is folded in). Values that already carry a scheme,
 *  blank values, and values that are obviously not a host (`://bad url`, anything with a space)
 *  come back trimmed and otherwise unchanged — so a caller comparing before/after never claims it
 *  "added https://" to something that stays invalid. */
export function withDefaultScheme(value: string, scheme: 'http' | 'https'): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || hasUrlScheme(trimmed)) return trimmed;
  if (!looksLikeBareHost(trimmed)) return trimmed;
  return `${scheme}://${trimmed.replace(/^\/+/, '')}`;
}

/** Whether `value` parses as an absolute URL. */
export function isAbsoluteUrl(value: string): boolean {
  try {
    return new URL(value).href.length > 0;
  } catch {
    return false;
  }
}
