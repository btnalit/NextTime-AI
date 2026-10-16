import { type AddressCredential, SECRET_FIELD_MASK, addressCredential } from '@nexttime/shared';
import { scrubSecretValues } from '../redaction/index.js';

/**
 * governance/connections/credentials: what a connection's or a gate instance's addresses may not
 * carry (legacy 186, and the gate-instance half promoted from the #549 review). Every address is
 * stored as given — `connection_requests.target`, the Gatekeeper Object's `name` / `target` /
 * `endpoint`, its `ConnectedSystem`'s identity, `gate_instances.target` / `.endpoint` /
 * `.definition`, the `ConnectionRequested` / `ConnectionCreated` events, the Activity's metadata —
 * and shown to every owner or platform administrator. A credential belongs to the gate (its
 * credential entry, or the gate's own configuration), never to an address, so one that rides
 * along is refused before anything is written or fetched:
 *
 *   - `endpoint`, the gate's own address the kernel calls, has no user name or password, no query
 *     string and no fragment — the same three checks as llm-proxy's upstream base
 *     (`@nexttime/shared`'s `upstreamBaseUrlProblem`). A query string was never sent anyway (every
 *     call resolves a path against the base, which drops it), and a URL with userinfo cannot be
 *     fetched at all. Whether it is an http(s) URL the kernel may reach is the outbound-target
 *     check's (R-27), which runs next.
 *   - `target`, free text naming the system (`https://grafana.example.com`, `deploy@db-1`), carries
 *     no credential in its URL (`@nexttime/shared`'s `addressCredential`: a password in the
 *     userinfo, or a query / fragment parameter named like a credential — `token`, `api_key`,
 *     `sig`, `key`, `X-Amz-Signature`, `X-Goog-Signature`, …) and no secret-looking value anywhere
 *     (`scrubSecretValues`, the patterns every scrub uses: a JWT, a vendor key, a `Bearer` value, a
 *     PEM key). A user name alone stays (`ssh://deploy@host`).
 *   - `manifestSource`, the OpenAPI document or MCP endpoint the kernel (or the gate host) fetches,
 *     has no user name or password (a URL with userinfo cannot be fetched) and the same two checks
 *     as `target`. A plain query (`?format=json`, `?version=3`) stays. Fetching a document with a
 *     token in its URL is the kernel holding a credential; a document behind authentication is
 *     imported by the gate itself (leave the field empty).
 *
 * The error names the field, never the value.
 */

export type ConnectionCredentialField = 'target' | 'endpoint' | 'manifestSource';

/** A credential in a connection's or a gate instance's `target`, `endpoint` or `manifestSource`.
 *  Maps to HTTP 400 / WS invalid-params with `code = 'credentials_in_connection_params'` and
 *  `details: { field }`. */
export class ConnectionParamsCarryCredentialsError extends Error {
  readonly code = 'credentials_in_connection_params' as const;
  readonly details: { readonly field: ConnectionCredentialField };
  constructor(capability: string, field: ConnectionCredentialField, problem: string) {
    super(
      `${capability}: ${field} ${problem} — refused, nothing was stored. A credential goes to the gate (its credential entry, or the gate's own configuration), never into the ${field}.`,
    );
    this.name = 'ConnectionParamsCarryCredentialsError';
    this.details = { field };
  }
}

/** Why `endpoint` could carry a credential, or `null`. Text that is not a URL is left to the
 *  outbound-target check, which refuses it. */
function endpointCredentialProblem(endpoint: string): string | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.username !== '' || url.password !== '') return 'must not contain a user name or password';
  // `search` / `hash` are '' for a bare trailing `?` / `#` too, so check the raw text as well.
  if (url.search !== '' || endpoint.includes('?')) return 'must not contain a query string (?)';
  if (url.hash !== '' || endpoint.includes('#')) return 'must not contain a fragment (#)';
  return null;
}

const ADDRESS_PROBLEM: Record<AddressCredential, string> = {
  password: 'must not contain a password',
  query:
    'carries a credential in a query parameter (a token, key, password or signature such as sig= or X-Amz-Signature=)',
};

/** Why `target` (or the shared part of `manifestSource`) could carry a credential, or `null`. */
function addressCredentialProblem(address: string): string | null {
  const shape = addressCredential(address);
  if (shape !== null) return ADDRESS_PROBLEM[shape];
  return scrubSecretValues(address).redactedValues > 0
    ? 'carries what looks like a credential (a token, a key, a JWT)'
    : null;
}

/** Why `manifestSource` could carry a credential, or `null`. Text that is not a URL is left to the
 *  schema and the outbound-target check. */
function manifestSourceCredentialProblem(manifestSource: string): string | null {
  try {
    const url = new URL(manifestSource);
    if (url.username !== '' || url.password !== '') {
      return 'must not contain a user name or password';
    }
  } catch {
    // Not a URL: only the address checks below apply.
  }
  return addressCredentialProblem(manifestSource);
}

/** The first of `target` / `endpoint` / `manifestSource` that carries a credential, and why, or
 *  `null` (this module's doc comment has the rule). Linear in each. */
export function findConnectionParamsCredential(params: {
  readonly target?: string | null;
  readonly endpoint?: string | null;
  readonly manifestSource?: string | null;
}): { readonly field: ConnectionCredentialField; readonly problem: string } | null {
  if (typeof params.target === 'string') {
    const problem = addressCredentialProblem(params.target);
    if (problem !== null) return { field: 'target', problem };
  }
  if (typeof params.endpoint === 'string') {
    const problem = endpointCredentialProblem(params.endpoint);
    if (problem !== null) return { field: 'endpoint', problem };
  }
  if (typeof params.manifestSource === 'string') {
    const problem = manifestSourceCredentialProblem(params.manifestSource);
    if (problem !== null) return { field: 'manifestSource', problem };
  }
  return null;
}

/** Throws `ConnectionParamsCarryCredentialsError` when `target`, `endpoint` or `manifestSource`
 *  carries a credential (`findConnectionParamsCredential`). */
export function assertConnectionParamsCarryNoCredentials(
  capability: string,
  params: {
    readonly target: string;
    readonly endpoint?: string;
    readonly manifestSource?: string | null;
  },
): void {
  const found = findConnectionParamsCredential(params);
  if (found !== null) {
    throw new ConnectionParamsCarryCredentialsError(capability, found.field, found.problem);
  }
}

/** `address` (a `target` or an `endpoint`) with what could carry a credential cut out, by
 *  `findConnectionParamsCredential`'s rule — unchanged when the rule finds nothing: a URL loses its
 *  user name and password, query and fragment; what is left still looking like a secret is masked
 *  (`scrubSecretValues`), and if the rule would still refuse it, the whole value is
 *  (`SECRET_FIELD_MASK`). The result always passes the rule, so a second pass changes nothing.
 *
 *  For a copy of an address someone reads — `workspace_self_connections`' (core 0045), which the
 *  platform plane shows — never for one the kernel calls or the gate is registered at: that one is
 *  refused on write and counted by the scrub for its owner to fix. */
export function redactConnectionAddress(field: 'target' | 'endpoint', address: string): string {
  const carries = (value: string) =>
    findConnectionParamsCredential(field === 'target' ? { target: value } : { endpoint: value }) !==
    null;
  if (!carries(address)) return address;
  let cut: string;
  try {
    const url = new URL(address);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    cut = url.href;
  } catch {
    cut = address;
  }
  // A bare trailing `?` / `#` survives `URL` (its `search` / `hash` are already ''), and text that
  // is not a URL keeps its parameters until here.
  cut = scrubSecretValues(cut.replace(/[?#][\s\S]*$/, '')).value;
  return carries(cut) ? SECRET_FIELD_MASK : cut;
}
