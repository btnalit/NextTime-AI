import { addressCredential } from '@nexttime/shared';
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

/** The scheme a scheme-less gate endpoint gets (legacy 152). A bare in-network name or address —
 *  `gate-host:8080`, `localhost`, `10.0.0.5:8080` — is plain http inside the deployment network;
 *  a dotted host name (`gate.example.com`) is most likely reached over the internet, where http
 *  would send the connection secret in the clear, so it gets https (the user can still type
 *  `http://`). */
export function gateEndpointDefaultScheme(value: string): 'http' | 'https' {
  const host = value
    .trim()
    .replace(/^\/+/, '')
    .split(/[/?#]/, 1)[0]
    ?.replace(/:\d*$/, '')
    .toLowerCase();
  if (host === undefined || !host.includes('.')) return 'http';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return 'http';
  if (host === 'localhost' || host.endsWith('.localhost')) return 'http';
  return 'https';
}

/** Whether `value` parses as an absolute URL. */
export function isAbsoluteUrl(value: string): boolean {
  try {
    return new URL(value).href.length > 0;
  } catch {
    return false;
  }
}

/** Whether a typed address visibly carries a credential: a user name or password in the URL, or a
 *  query / fragment parameter named like one (`?token=`, `?api_key=`, `?sig=`,
 *  `?X-Amz-Signature=`) — `@nexttime/shared`'s `addressCredential`, the rule the kernel refuses
 *  by (it also refuses a JWT, a vendor key or a `Bearer` value anywhere). This only keeps the
 *  console from copying such an address into another field. Accepts a value without a scheme. */
export function addressCarriesCredential(value: string): boolean {
  const withScheme = withDefaultScheme(value, 'https');
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return false;
  }
  if (url.username !== '' || url.password !== '') return true;
  return addressCredential(withScheme) !== null;
}

/** The OpenAPI document an http target usually serves, `<target>/openapi.json`, offered as a
 *  one-click fill: built from the target's origin and path only (never its user name, password,
 *  query or fragment), and not offered at all while the target carries a credential — a
 *  suggestion must never copy one into the manifest source (review of #549). `''` when the target
 *  is not an http(s) URL or host. */
export function suggestedManifestSource(target: string): string {
  const value = withDefaultScheme(target, 'https');
  if (value === '' || !isAbsoluteUrl(value) || addressCarriesCredential(value)) return '';
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}/openapi.json`;
}

/** A packaged gate's `GATE_ID` suggestion: `gatekeeper-<kind>`, or `gatekeeper-<kind>-2`, `-3`, …
 *  when an id the console can see already has it (field-inventory #9). Best effort: `known` is only
 *  what this reader's poll lists, so the field stays editable. */
export function suggestedGateId(kind: string, known: Iterable<string>): string {
  const taken = new Set(known);
  const base = deriveGateId(`gatekeeper-${kind}`);
  if (base === '' || !taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
