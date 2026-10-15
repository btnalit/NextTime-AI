import { namesASecretField } from './secret-field-name.js';

/**
 * address-credential: the one rule for "this address carries a credential in its URL" (legacy 186
 * and the #549 security review, B1). An address — a connection's or a gate instance's `target`, a
 * gate's `endpoint`, a `manifestSource` — names a system; a credential riding in it is stored as
 * given and shown to every owner or platform administrator. Two shapes are recognised:
 *
 *   - a password in the URL's userinfo (`https://ops:pw@host`) — a user name alone stays
 *     (`ssh://deploy@host`);
 *   - a query or fragment parameter, with a value, whose name names a credential: any name
 *     `namesASecretField` matches (`token`, `access_token`, `api_key`, `password`, `client_secret`,
 *     `X-Amz-Credential`, `X-Amz-Security-Token`, …) or one of `ADDRESS_SECRET_QUERY_NAMES`, the
 *     short names signed URLs and key-in-query APIs use (`sig`, `signature`, `key`, `X-Amz-Signature`,
 *     `X-Goog-Signature`, …). A plain query (`?format=json`, `?version=3`) stays.
 *
 * Four places ask this about the same addresses and derive from this module, so they cannot drift:
 * the kernel's refusal on every path that writes an address (`governance/connections/credentials`),
 * the kernel's raw-secret scrub that counts the rows written before it, the console (no one-click
 * suggestion copies such an address into another field), and the read-only preflight SQL
 * (`ADDRESS_CREDENTIAL_SQL`, an upper bound of this rule, checked against it by a test).
 *
 * Linear in the address: one split, and `namesASecretField` (linear) per parameter name.
 */

/** Query parameter names that carry a credential although `namesASecretField` does not match them
 *  (it keeps a field named `key` or `signature` visible, which is right for a JSON field but not for
 *  a URL): an Azure SAS / generic signature (`sig`, `signature`), the AWS SigV4 and Google V4
 *  signatures, and the short names APIs use for a key or password. Lower case; compared
 *  case-insensitively. */
export const ADDRESS_SECRET_QUERY_NAMES: readonly string[] = [
  'sig',
  'signature',
  'x-amz-signature',
  'x-goog-signature',
  'key',
  'pwd',
  'pass',
  'auth',
];

/** Whether a query or fragment parameter named `name` carries a credential (this module's rule). */
export function queryParamNameCarriesCredential(name: string): boolean {
  return ADDRESS_SECRET_QUERY_NAMES.includes(name.toLowerCase()) || namesASecretField(name);
}

export type AddressCredential = 'password' | 'query';

function decodeName(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return raw;
  }
}

/** What credential `address` carries — `'password'` (URL userinfo) or `'query'` (a parameter named
 *  like one) — or `null`. Text that is not a URL is checked for parameters only (`host/x?key=…`). */
export function addressCredential(address: string): AddressCredential | null {
  try {
    if (new URL(address).password !== '') return 'password';
  } catch {
    // Not a URL: only its parameters can be judged.
  }
  const start = address.search(/[?#]/);
  if (start === -1) return null;
  for (const pair of address.slice(start + 1).split(/[&;?#]/)) {
    const eq = pair.indexOf('=');
    // A bare name, or one with an empty value, carries nothing.
    if (eq <= 0 || eq === pair.length - 1) continue;
    if (queryParamNameCarriesCredential(decodeName(pair.slice(0, eq)))) return 'query';
  }
  return null;
}

/** `namesASecretField`'s words as an SQL alternation. Over-matches (any name containing `token`, a
 *  count such as `max_tokens` included), which an upper bound may. */
const SECRET_NAME_WORDS_SQL =
  'password|passwd|passphrase|secret|credential|authori[sz]ation|api[_-]?key|private[_-]?key|access[_-]?key|token|cookie|bearer|handle';

/**
 * The same rule as PostgreSQL regular expressions (use with `~*`), for the read-only preflight that
 * estimates how many stored addresses the scrub will count. Each is an upper bound of
 * `addressCredential`: every address it flags matches (a test runs both over one corpus; a
 * percent-encoded parameter name, which only the TypeScript rule decodes, is the one exception), and
 * the plain cases it keeps (`?format=json`, `ssh://deploy@host`, `https://host:8443/x`) do not.
 * `scrub-raw-secrets` (dry run) gives the exact count.
 */
export const ADDRESS_CREDENTIAL_SQL = {
  /** A non-empty password in the URL's userinfo. */
  password: '^[a-z][a-z0-9+.-]*://[^/?#@]*:[^/?#@]+@',
  /** A query or fragment parameter, with a value, named like a credential. */
  query: `[?#&;]([^=&#;?]*(${SECRET_NAME_WORDS_SQL})[^=&#;?]*|${ADDRESS_SECRET_QUERY_NAMES.join('|')})=[^&#;]`,
} as const;
