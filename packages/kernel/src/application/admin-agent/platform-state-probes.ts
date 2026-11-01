import { isIpLiteral } from '@nexttime/shared';

/**
 * application/admin-agent/platform-state-probes (S11 AA2, tests only): what the redaction tests of
 * `platform_state_*` look for in a result — every string in it that could carry an address. Not a
 * redactor: the projections never pass such a string (they keep only shaped values); this checks
 * they do not.
 *
 * A string is address-like when it holds `://`, a `user@host`, an IP literal (with or without a
 * port or brackets), a `name.name:port`, or an absolute POSIX path.
 */

const HOST_PORT = /[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+:\d{1,5}\b/;
const USER_AT_HOST = /[^\s@]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]+/;
const ABSOLUTE_PATH = /(?:^|[\s"'=(])\/[A-Za-z0-9._~-]+/;

function tokenIsIp(token: string): boolean {
  const bare = token.replace(/^\[|\]$/g, '');
  if (isIpLiteral(bare)) return true;
  // `a.b.c.d:port` and `[v6]:port`
  const v4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(token);
  if (v4WithPort?.[1] && isIpLiteral(v4WithPort[1])) return true;
  const v6WithPort = /^\[([0-9A-Fa-f:.]+)\]:\d{1,5}$/.exec(token);
  return v6WithPort?.[1] !== undefined && isIpLiteral(v6WithPort[1]);
}

/** Why `text` is address-like, or `null`. */
export function addressLikeReason(text: string): string | null {
  if (text.includes('://')) return 'a URL scheme';
  if (USER_AT_HOST.test(text)) return 'a user@host';
  if (HOST_PORT.test(text)) return 'a host:port';
  if (ABSOLUTE_PATH.test(text)) return 'an absolute path';
  for (const token of text.split(/[\s,;()"'<>=]+/)) {
    if (token !== '' && tokenIsIp(token)) return 'an IP literal';
  }
  return null;
}

/** Every address-like string leaf of `value` (object keys included), with its path and why. */
export function findAddressLike(value: unknown, path = '$'): string[] {
  if (typeof value === 'string') {
    const reason = addressLikeReason(value);
    return reason === null ? [] : [`${path}: ${reason}`];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findAddressLike(item, `${path}[${index}]`));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) => [
      ...findAddressLike(key, `${path}{key}`),
      ...findAddressLike(child, `${path}.${key}`),
    ]);
  }
  return [];
}
