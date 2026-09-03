import { readFileSync } from 'node:fs';
import { Agent, fetch as undiciFetch } from 'undici';

/**
 * tls: how an `http`/`mcp` gate trusts a target that presents a private or self-signed
 * certificate — the alternative to `NODE_TLS_REJECT_UNAUTHORIZED=0`, which disables verification
 * for *every* outbound TLS connection the gate process makes and was the documented stop-gap for
 * the ragflow gate (docs/runbooks/host-gatekeepers.md §11).
 *
 *   - `GATE_TLS_CA_FILE`    — PEM file (one or more certificates) added as the *only* trust
 *                             anchors for this gate's target connections. For a self-signed
 *                             target, the target's own certificate is the anchor.
 *   - `GATE_TLS_SERVERNAME` — the name to verify the certificate against (and to send as SNI)
 *                             when the target is reached by an address that is not in its SAN
 *                             list — e.g. a LAN IP for a certificate issued to a DNS name.
 *
 * Both are optional and independent. Neither is set → plain global `fetch`, system trust store,
 * normal hostname verification. Verification is never turned off here: a wrong CA or name fails
 * the connection instead of silently trusting it.
 *
 * Implementation: an `undici` `Agent` whose `connect` options are handed to `tls.connect` (`ca`,
 * `servername`), used through undici's own `fetch` so Agent and fetch come from the same undici
 * build (Node's bundled fetch and an npm undici Agent are not guaranteed to speak the same
 * dispatcher handler protocol across versions). The returned function is typed as the global
 * `typeof fetch` — the transports only read `ok`/`status`/`text()`/`json()` off the Response, all
 * of which undici's Response provides identically.
 */

export interface GateTlsOptions {
  readonly caFile?: string;
  readonly servername?: string;
}

/** `undefined` when neither env var is set (the common case — no TLS override at all). */
export function gateTlsOptionsFromEnv(env: NodeJS.ProcessEnv): GateTlsOptions | undefined {
  const caFile = env.GATE_TLS_CA_FILE?.trim() || undefined;
  const servername = env.GATE_TLS_SERVERNAME?.trim() || undefined;
  if (!caFile && !servername) return undefined;
  return { ...(caFile ? { caFile } : {}), ...(servername ? { servername } : {}) };
}

/** The line a gate logs at startup when the process-wide kill switch is set — kept as a warning,
 *  not an error, so an operator mid-migration is told what to do instead rather than locked out. */
export function insecureTlsEnvWarning(env: NodeJS.ProcessEnv): string | undefined {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED !== '0') return undefined;
  return (
    'NODE_TLS_REJECT_UNAUTHORIZED=0 is set: certificate verification is disabled for every ' +
    'outbound TLS connection this gate makes. Trust the target explicitly instead — ' +
    'GATE_TLS_CA_FILE (its PEM) and, if it is reached by an address not in its SAN, GATE_TLS_SERVERNAME.'
  );
}

type UndiciFetch = typeof undiciFetch;

/**
 * Builds the `fetchImpl` an `HttpTransport`/`McpTransport` takes. `baseFetch` is injectable for
 * tests; production callers leave it as undici's fetch (see module doc comment for why not the
 * global one).
 *
 * Throws (synchronously, at gate startup) if `caFile` cannot be read — a gate configured to trust
 * a CA it cannot load must not start and fall back to the system store unnoticed.
 */
export function buildTlsFetch(
  options: GateTlsOptions,
  baseFetch: UndiciFetch = undiciFetch,
): typeof fetch {
  const ca = options.caFile ? readFileSync(options.caFile, 'utf8') : undefined;
  const dispatcher = new Agent({
    connect: {
      ...(ca !== undefined ? { ca } : {}),
      ...(options.servername ? { servername: options.servername } : {}),
    },
  });
  const tlsFetch = (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    baseFetch(input as Parameters<UndiciFetch>[0], {
      ...(init as Parameters<UndiciFetch>[1]),
      dispatcher,
    }) as unknown as Promise<Response>;
  return tlsFetch as typeof fetch;
}
