import { scrubSecretValues } from '../redaction/index.js';

/**
 * governance/connections/credentials: what a connection's `target` and `endpoint` may not carry
 * (legacy 186). Both are stored as they are given — `connection_requests.target`, the Gatekeeper
 * Object's `name` / `target` / `endpoint`, its `ConnectedSystem`'s identity, the
 * `ConnectionRequested` / `ConnectionCreated` events, the Activity's metadata — and shown to every
 * owner. A credential belongs in the gate (`credentials`, or the gate's own configuration), never
 * in either, so one that rides along is refused before anything is written or fetched:
 *
 *   - `endpoint`, the gate's own address the kernel calls, has no user name or password, no query
 *     string and no fragment — the same three checks as llm-proxy's upstream base
 *     (`@nexttime/shared`'s `upstreamBaseUrlProblem`). A query string was never sent anyway (every
 *     call resolves a path against the base, which drops it), and a URL with userinfo cannot be
 *     fetched at all. Whether it is an http(s) URL the kernel may reach is the outbound-target
 *     check's (R-27), which runs next.
 *   - `target`, free text naming the system (`https://grafana.example.com`, `deploy@db-1`), carries
 *     no secret-looking value (`scrubSecretValues`, the patterns every scrub uses): a URL's
 *     password, a `?token=…` / `api_key=…` pair, a JWT, a vendor key, a `Bearer` value, a PEM key.
 *     A user name alone stays (`ssh://deploy@host`).
 *
 * The error names the field, never the value.
 */

export type ConnectionCredentialField = 'target' | 'endpoint';

/** `request_connection` / `create_connection` with a credential in `target` or `endpoint`. Maps to
 *  HTTP 400 / WS invalid-params with `code = 'credentials_in_connection_params'` and
 *  `details: { field }`. */
export class ConnectionParamsCarryCredentialsError extends Error {
  readonly code = 'credentials_in_connection_params' as const;
  readonly details: { readonly field: ConnectionCredentialField };
  constructor(capability: string, field: ConnectionCredentialField, problem: string) {
    super(
      `${capability}: ${field} ${problem} — refused, nothing was stored. Give the gate its credentials (the credentials field, or the gate's own configuration), never the ${field}.`,
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

/** The first of `target` / `endpoint` that carries a credential, and why, or `null` (this module's
 *  doc comment has the rule). Linear in both. */
export function findConnectionParamsCredential(params: {
  readonly target?: string | null;
  readonly endpoint?: string | null;
}): { readonly field: ConnectionCredentialField; readonly problem: string } | null {
  if (typeof params.target === 'string' && scrubSecretValues(params.target).redactedValues > 0) {
    return {
      field: 'target',
      problem:
        'carries what looks like a credential (a URL password, a token or key, a secret query parameter)',
    };
  }
  if (typeof params.endpoint === 'string') {
    const problem = endpointCredentialProblem(params.endpoint);
    if (problem !== null) return { field: 'endpoint', problem };
  }
  return null;
}

/** Throws `ConnectionParamsCarryCredentialsError` when `target` or `endpoint` carries a credential
 *  (`findConnectionParamsCredential`). */
export function assertConnectionParamsCarryNoCredentials(
  capability: string,
  params: { readonly target: string; readonly endpoint?: string },
): void {
  const found = findConnectionParamsCredential(params);
  if (found !== null) {
    throw new ConnectionParamsCarryCredentialsError(capability, found.field, found.problem);
  }
}
