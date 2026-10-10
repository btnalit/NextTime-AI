import { readFileSync } from 'node:fs';
import {
  type ApplyResponse,
  DEFAULT_GATE_TOKEN_FILE,
  type DescribeOperationsResponse,
  type HealthResponse,
  type ObserveResponse,
  type RevertResponse,
  type SimulateResponse,
  gateAuthorizationHeader,
  isRedirectStatus,
  normalizeGateToken,
  redirectRefusalMessage,
} from '@nexttime/gatekeeper-base';
import { correlationHeaders } from '@nexttime/shared';
import { scrubSecretValues } from '../../governance/redaction/index.js';
import { currentCorrelationId } from '../../substrate/correlation/index.js';
import {
  type OutboundTargetGuard,
  OutboundTargetRefusedError,
  createOutboundTargetGuard,
  withoutRedirects,
} from '../outbound-target/index.js';
import { deriveConnectionSecret } from './connection-secret.js';

export {
  CONNECTION_SECRET_PREFIX,
  GateConnectionSecretsUnavailableError,
  type GateConnectionSecrets,
  createGateConnectionSecrets,
  deriveConnectionSecret,
  isConnectionSecretSalt,
} from './connection-secret.js';

/**
 * adapters/gatekeeper-client: HTTP client implementing the gatekeeper protocol port
 * (describe_operations/observe/simulate/apply/revert/health — design doc §7.5; docs/development-
 * tasks.md S2.4 deliverable B). Response/request shapes are imported directly from
 * `@nexttime/gatekeeper-base` (a sibling workspace package, not a kernel-internal file — legal
 * under `.dependency-cruiser.cjs`'s cross-package-import rule) so the two sides can never drift.
 *
 * Adapters may be imported only by application and interfaces (§7.10) — this module implements a
 * port; `application/gateway`'s `request_action` handler and `action-executor.ts` are its callers.
 *
 * Auth (review lane 5, P1-1): every `/gate/*` route now requires `Authorization: Bearer <token>`
 * (`@nexttime/gatekeeper-base`'s `gate-auth.ts`). `HttpGatekeeperClient` reads that token itself,
 * from `NEXTTIME_GATE_TOKEN_FILE` (default `DEFAULT_GATE_TOKEN_FILE`,
 * `/run/secrets/gate_token` — the same in-container path the compose secret `gate_token` is
 * mounted at in the kernel service; a *different* env var name from the gate's own
 * `GATE_KERNEL_TOKEN_FILE` since each side reads its own copy of the same secret independently,
 * see `gate-token.ts`'s module doc comment). Deliberately best-effort, unlike the gate's own
 * `loadGateKernelToken` (which refuses the whole process to start): both call sites that construct
 * this client (`packages/kernel/src/index.ts`, `cli/bootstrap.ts`) do so with no arguments, so a
 * missing/invalid token file here must not crash kernel startup over a config problem specific to
 * gate calls — an omitted header simply means every gate call 401s visibly (`GatekeeperClientError`
 * with code `unauthorized`), diagnosable from the same place a real credential/network failure
 * would be.
 *
 * Which credential, per call (R-01, maintainer decision D-01, 2026-10-02 review): every method
 * takes a `GateTarget` — the endpoint *and* the `GateCredential` to present — instead of a bare
 * endpoint string, so no call site can reach a gate without saying which credential it means:
 *   - `platform`: `gate_token`, and only for a gate the kernel provisioned (a `gate_instances` row —
 *     `application/gateway/gate-target.ts` decides, from the catalog, never from the caller);
 *   - `connection`: a self-connected gate's own secret, derived here from `gate_token` and the
 *     Gatekeeper's salt (`connection-secret.ts`) — `gate_token` itself never leaves for such a gate;
 *   - `none`: a self-connected gate with no secret on record (connected before D-01) — refused here
 *     with `connection_secret_missing` (status 401) without contacting the gate.
 * A `connection` / `none` target is owner-supplied, so before the fetch its URL also passes the
 * outbound-target predicate (`adapters/outbound-target`, R-27) and the fetch never follows a
 * redirect; a refusal is a `GatekeeperClientError` with code `target_refused`.
 *
 * Leftover 87: every request also carries the current call's `x-correlation-id`
 * (substrate/correlation) when there is one, so the gate's own log line for this call has the same
 * id as the kernel's. A gate call made outside any inbound call (the approval drainer's background
 * tick, the gate-instance health sweep) carries none and the gate mints its own.
 */

const GATE_TOKEN_FILE_ENV = 'NEXTTIME_GATE_TOKEN_FILE';

function resolveGateTokenFile(env: NodeJS.ProcessEnv): string {
  const configured = env[GATE_TOKEN_FILE_ENV];
  return configured && configured.length > 0 ? configured : DEFAULT_GATE_TOKEN_FILE;
}

/** The kernel's `gate_token` from `NEXTTIME_GATE_TOKEN_FILE` (default `DEFAULT_GATE_TOKEN_FILE`),
 *  or `undefined` when it is missing or unusable (best-effort — see this module's doc comment). */
export function loadGateToken(env: NodeJS.ProcessEnv): string | undefined {
  const file = resolveGateTokenFile(env);
  try {
    return normalizeGateToken(readFileSync(file, 'utf8'), file);
  } catch {
    return undefined;
  }
}

/** Which call a gate answered with an error — set only on an answer the gate actually gave (an
 *  `ok: false` envelope), for the kernel's own record of a refusal (UX acceptance of #538): the
 *  Operation, the digest the call said was approved, and — when the gate reported it in a
 *  well-formed `details.runningDigest` — the digest of the definition it runs. */
export interface GateCallRefusal {
  readonly operation: string;
  readonly approvedDigest: string | null;
  readonly runningDigest?: string;
}

export class GatekeeperClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly call?: GateCallRefusal;

  constructor(message: string, options: { code: string; status: number; call?: GateCallRefusal }) {
    super(message);
    this.name = 'GatekeeperClientError';
    this.code = options.code;
    this.status = options.status;
    if (options.call !== undefined) this.call = options.call;
  }
}

/**
 * Gate answers a caller can act on (review of #532, error mapping): the gate said, the same way
 * every time, that this call as made will not run — a param the gate owns, params its schema
 * refuses, an Operation it does not have or runs from another definition, no credential for this
 * account, a key already applied. The capability surfaces pass these through with the gate's own
 * code instead of 502 `gatekeeper_error`, which reads as an outage an agent would retry. The
 * status is this table's: an answer counts only when the gate's status line agrees with it — a
 * self-connected gate is owner-supplied, and its response does not get to pick the kernel's
 * status. Anything else (401 between kernel and gate, a 5xx, a network failure, a refused
 * redirect, an unknown code) stays an upstream failure.
 */
const GATE_REFUSAL_STATUS: Readonly<Record<string, number>> = {
  invalid_params: 400,
  revert_not_supported: 400,
  operation_refused: 403,
  operation_not_found: 404,
  operation_definition_mismatch: 409,
  idempotency_conflict: 409,
  apply_outcome_unknown: 409,
  credential_unavailable: 424,
};

/** `err` as a gate refusal to pass through (`GATE_REFUSAL_STATUS`), or `undefined`. */
export function gateRefusalOf(
  err: GatekeeperClientError,
): { readonly status: number; readonly code: string } | undefined {
  const status = Object.hasOwn(GATE_REFUSAL_STATUS, err.code)
    ? GATE_REFUSAL_STATUS[err.code]
    : undefined;
  return status !== undefined && err.status === status ? { status, code: err.code } : undefined;
}

export class GatekeeperTimeoutError extends Error {
  /** The gate path that timed out (`gate/apply`, `gate/observe`, …) — `action-executor.ts` treats a
   *  `gate/apply` timeout as "outcome unknown" rather than a failure (the gate may still finish). */
  readonly path: string;
  constructor(message: string, path = '') {
    super(message);
    this.name = 'GatekeeperTimeoutError';
    this.path = path;
  }
}

/** What the kernel presents to a gate — see this module's doc comment. */
export type GateCredential =
  | { readonly kind: 'platform' }
  | { readonly kind: 'connection'; readonly workspaceId: string; readonly salt: string }
  | { readonly kind: 'none' };

/** One gate as a call addresses it: where, and with which credential. */
export interface GateTarget {
  readonly endpoint: string;
  readonly credential: GateCredential;
}

/** A gate the kernel provisioned (packaged gate, gate-host instance) — `gate_token`. */
export function platformGateTarget(endpoint: string): GateTarget {
  return { endpoint, credential: { kind: 'platform' } };
}

export interface GatekeeperCallInput {
  readonly operation: string;
  readonly params?: unknown;
  readonly onBehalfOf?: string;
  /**
   * Legacy K: the digest of the Operation definition the kernel approved
   * (`governance/gatekeepers`'s `operationRecordDigest`); the gate refuses the call when it runs
   * another one (409 `operation_definition_mismatch`). Required, so no call site can forget it.
   * `undefined` only on the reaper's replay of a row that names no definition: the gate then
   * answers from its idempotency store and refuses anything else.
   */
  readonly operationDigest: string | undefined;
}

export interface GatekeeperApplyInput extends GatekeeperCallInput {
  readonly actionRequestId: string;
}

export interface GatekeeperRevertInput extends GatekeeperCallInput {
  readonly actionRequestId?: string;
}

/** S2.13: `create_connection`'s "send the credential straight to the gate" step
 *  (`application/gateway/connection-handlers.ts`) — `@nexttime/gatekeeper-base`'s
 *  `POST /gate/connected-accounts`. */
export interface GatekeeperStoreConnectedAccountInput {
  readonly onBehalfOf: string;
  readonly credential: Record<string, unknown>;
}

/** The port `application/gateway`'s `request_action` handler and `action-executor.ts` depend on
 *  — declared so tests can supply a fake without any HTTP involved. */
export interface GatekeeperClient {
  describeOperations(target: GateTarget): Promise<DescribeOperationsResponse>;
  observe(target: GateTarget, input: GatekeeperCallInput): Promise<ObserveResponse>;
  simulate(target: GateTarget, input: GatekeeperCallInput): Promise<SimulateResponse>;
  apply(target: GateTarget, input: GatekeeperApplyInput): Promise<ApplyResponse>;
  revert(target: GateTarget, input: GatekeeperRevertInput): Promise<RevertResponse>;
  health(target: GateTarget): Promise<HealthResponse>;
  /** S2.13: stores a ConnectedAccount credential on the gate instance, keyed by `onBehalfOf` —
   *  the kernel never persists the credential itself (design doc §11 "凭证只在门"). */
  storeConnectedAccount(
    target: GateTarget,
    input: GatekeeperStoreConnectedAccountInput,
  ): Promise<void>;
  /** S2.13: removes a ConnectedAccount credential from the gate instance. */
  deleteConnectedAccount(target: GateTarget, onBehalfOf: string): Promise<void>;
}

export interface HttpGatekeeperClientOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /** Timeout for `gate/apply` only (default `DEFAULT_APPLY_TIMEOUT_MS`). An `apply` performs the
   *  effect itself — a container restart waits up to the caller's own `timeoutSeconds` for a
   *  graceful stop, an ssh command runs as long as it runs — so it gets a longer budget than the
   *  read-side calls (`timeoutMs`). Real-model regression 2026-10-02: a `container.restart` with
   *  `timeoutSeconds: 30` hit the old shared 15 s budget, the ActionRequest was marked `failed`,
   *  and the container restarted anyway. */
  readonly applyTimeoutMs?: number;
  /** Explicit override for the gate auth token (mainly for tests) — takes precedence over
   *  `NEXTTIME_GATE_TOKEN_FILE` and skips reading a file entirely. Omit to use the env-driven
   *  loader; pass `env` (below) to test that loader against a real temp file instead. */
  readonly token?: string;
  /** Injectable for tests — defaults to `process.env`. Only consulted when `token` is omitted. */
  readonly env?: NodeJS.ProcessEnv;
  /** The owner-supplied-URL predicate applied to every `connection` / `none` target (R-27) —
   *  defaults to `createOutboundTargetGuard()` over `process.env`. */
  readonly outboundTargetGuard?: OutboundTargetGuard;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_APPLY_TIMEOUT_MS = 60_000;
/** R-49: the most bytes one gate response body may have. Above the gate's own 10 MiB exec output
 *  buffer (`@nexttime/gatekeeper-base` `kinds/ssh.ts` / `kinds/cli.ts`) with room for JSON
 *  escaping; a larger body is refused (`response_too_large`) rather than buffered whole. */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

class ResponseTooLargeError extends Error {}

/** The most bytes of a gate's error text the kernel passes on: room for a gate's own message plus
 *  the 2 KiB of target-system text `@nexttime/gatekeeper-base` `boundUntrustedText` folds into one. */
const MAX_GATE_ERROR_MESSAGE_BYTES = 4 * 1024;
/** How much of it is scrubbed before the cut — past the cut by more than any credential is long, so
 *  a value the cut lands in is already hidden, and the scrub stays linear in a bounded string. */
const GATE_ERROR_SCRUB_WINDOW_BYTES = 64 * 1024;
/** A gate's error code as the kernel repeats it: lower-case words joined by `_`, no digits, like
 *  every code the protocol defines (`invalid_params`, `operation_refused`, …) — so a token, which
 *  has digits or other characters, is never one. */
const GATE_ERROR_CODE = /^[a-z]+(?:_[a-z]+){0,7}$/;
const MAX_GATE_ERROR_CODE_LENGTH = 64;

/** `text` cut to at most `maxBytes` of UTF-8 — never mid-character — and marked when cut. */
function boundBytes(text: string, maxBytes: number, marked: boolean): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  const cut = buf
    .subarray(0, maxBytes)
    .toString('utf8')
    .replace(/\uFFFD+$/, '');
  return marked ? `${cut}… [truncated, ${buf.length} bytes total]` : cut;
}

/**
 * A gate's `{ ok: false, error }` as the kernel repeats it (review of #538, item 1). The message
 * reaches the caller on every surface — the HTTP and WS error, the MCP tool result an agent hands
 * its model, an ActionRequest's failure reason — and a self-connected gate is owner-supplied code
 * that can answer anything, including a target system's reply that echoes a key. So the text is
 * scrubbed (`scrubSecretValues`) and bounded here, once, for the pass-through refusals and the 502
 * alike; a message or code that is not what the protocol says it is reads as one the gate did not
 * give.
 */
/** An Operation digest as `@nexttime/gatekeeper-base`'s `operationDefinitionDigest` writes it — the
 *  only shape of `details.runningDigest` the kernel repeats (a self-connected gate's response is
 *  owner-supplied text). */
const OPERATION_DIGEST = /^sha256:[0-9a-f]{64}$/;

/** `details.runningDigest` of a gate's error, when it is a well-formed digest. */
export function gateRunningDigestOf(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const details = (error as { details?: unknown }).details;
  if (details === null || typeof details !== 'object') return undefined;
  const digest = (details as { runningDigest?: unknown }).runningDigest;
  return typeof digest === 'string' && OPERATION_DIGEST.test(digest) ? digest : undefined;
}

export function gateErrorOf(
  error: unknown,
  path: string,
): { readonly code: string; readonly message: string } {
  const { code: rawCode, message: rawMessage } =
    error !== null && typeof error === 'object'
      ? (error as { code?: unknown; message?: unknown })
      : {};
  const code =
    typeof rawCode === 'string' &&
    rawCode.length <= MAX_GATE_ERROR_CODE_LENGTH &&
    GATE_ERROR_CODE.test(rawCode)
      ? rawCode
      : 'unrecognized_gate_error';
  if (typeof rawMessage !== 'string' || rawMessage.trim() === '') {
    return { code, message: `gatekeeper client: ${path} answered an error without a message` };
  }
  const scrubbed = scrubSecretValues(
    boundBytes(rawMessage, GATE_ERROR_SCRUB_WINDOW_BYTES, false),
  ).value;
  return { code, message: boundBytes(scrubbed, MAX_GATE_ERROR_MESSAGE_BYTES, true) };
}

/**
 * R-49: reads `response`'s body as UTF-8 text, refusing past `maxBytes`, and gives up the moment
 * `signal` aborts — raced explicitly, so the budget holds whether or not the fetch implementation
 * ties its body stream to the request's signal.
 */
async function readBodyBounded(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => reject(new Error('aborted while reading the response body'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  aborted.catch(() => {}); // only ever observed through the race below
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new ResponseTooLargeError();
      chunks.push(value);
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  }
  return Buffer.concat(chunks).toString('utf8');
}

interface EnvelopeOk {
  readonly ok: true;
  readonly result: unknown;
}
interface EnvelopeErr {
  readonly ok: false;
  readonly error: { readonly code: string; readonly message: string };
}
type Envelope = EnvelopeOk | EnvelopeErr;

export class HttpGatekeeperClient implements GatekeeperClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly applyTimeoutMs: number;
  private readonly token: string | undefined;
  private readonly outboundTargetGuard: OutboundTargetGuard;

  constructor(options: HttpGatekeeperClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.applyTimeoutMs = options.applyTimeoutMs ?? DEFAULT_APPLY_TIMEOUT_MS;
    this.token = options.token ?? loadGateToken(options.env ?? process.env);
    this.outboundTargetGuard = options.outboundTargetGuard ?? createOutboundTargetGuard();
  }

  /** The `Authorization` value for `credential` — `gate_token` only for `platform` (D-01). */
  private authorizationFor(credential: GateCredential, path: string): string | undefined {
    switch (credential.kind) {
      case 'platform':
        return this.token !== undefined ? gateAuthorizationHeader(this.token) : undefined;
      case 'connection':
        if (this.token === undefined) {
          throw new GatekeeperClientError(
            `gatekeeper client: ${path} cannot be authenticated — the kernel has no gate token to derive this gate's connection secret from`,
            { code: 'gate_token_unavailable', status: 0 },
          );
        }
        return gateAuthorizationHeader(
          deriveConnectionSecret(this.token, credential.workspaceId, credential.salt),
        );
      case 'none':
        throw new GatekeeperClientError(
          `gatekeeper client: ${path} not sent — this self-connected gate has no connection secret yet (it was connected before per-connection secrets): the workspace owner issues one (rotate_connection_secret) and puts it in the gate's GATE_KERNEL_TOKEN_FILE`,
          { code: 'connection_secret_missing', status: 401 },
        );
    }
  }

  private async request(
    target: GateTarget,
    path: string,
    method: 'GET' | 'POST' | 'DELETE',
    body?: unknown,
    timeoutMs: number = this.timeoutMs,
    call?: GatekeeperCallInput,
  ): Promise<unknown> {
    const { endpoint, credential } = target;
    const url = new URL(path, endpoint.endsWith('/') ? endpoint : `${endpoint}/`);
    const authorization = this.authorizationFor(credential, path);
    const ownerSupplied = credential.kind !== 'platform';
    if (ownerSupplied) {
      try {
        await this.outboundTargetGuard(endpoint, 'gate endpoint');
      } catch (err) {
        if (!(err instanceof OutboundTargetRefusedError)) throw err;
        throw new GatekeeperClientError(`gatekeeper client: ${path} not sent — ${err.message}`, {
          code: 'target_refused',
          status: 0,
        });
      }
    }
    const fetchImpl = ownerSupplied ? withoutRedirects(this.fetchImpl) : this.fetchImpl;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const headers: Record<string, string> = { ...correlationHeaders(currentCorrelationId()) };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (authorization !== undefined) headers.authorization = authorization;
    const timedOut = (): GatekeeperTimeoutError =>
      new GatekeeperTimeoutError(`gatekeeper client: ${path} timed out after ${timeoutMs}ms`, path);
    let response: Response;
    let text: string;
    try {
      try {
        response = await fetchImpl(url, {
          method,
          headers: Object.keys(headers).length > 0 ? headers : undefined,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
      } catch (err) {
        if ((err as { name?: string }).name === 'AbortError') throw timedOut();
        throw new GatekeeperClientError(`gatekeeper client: ${path} request failed`, {
          code: 'network_error',
          status: 0,
        });
      }
      // Never followed (an owner-supplied endpoint's fetch is `withoutRedirects`); said so, with
      // where it pointed, instead of failing to parse the 3xx body (review of #532, item 4).
      if (isRedirectStatus(response.status)) {
        await response.body?.cancel().catch(() => {});
        throw new GatekeeperClientError(
          redirectRefusalMessage(`gatekeeper client: ${path}`, response, url, {
            follower:
              "The kernel does not follow a gate's redirects (the gate's secret would go along)",
            fix: "set the Gatekeeper's endpoint to the final address",
          }),
          { code: 'redirect_refused', status: response.status },
        );
      }
      // R-49: the abort stays armed through the body. A gate (or a workspace owner's endpoint) that
      // sends its headers and then trickles the body must not hold the call — and, for a read
      // inside the dispatch transaction, a pool connection — past the budget; for `gate/apply` a
      // stall here is the same "outcome unknown" as a stall before the headers.
      try {
        text = await readBodyBounded(response, MAX_RESPONSE_BYTES, controller.signal);
      } catch (err) {
        if (err instanceof ResponseTooLargeError) {
          throw new GatekeeperClientError(
            `gatekeeper client: ${path} response exceeds ${MAX_RESPONSE_BYTES} bytes`,
            { code: 'response_too_large', status: response.status },
          );
        }
        if (controller.signal.aborted) throw timedOut();
        throw new GatekeeperClientError(`gatekeeper client: ${path} response failed`, {
          code: 'network_error',
          status: 0,
        });
      }
    } finally {
      clearTimeout(timeout);
    }

    let envelope: Envelope;
    try {
      envelope = JSON.parse(text) as Envelope;
    } catch {
      throw new GatekeeperClientError(`gatekeeper client: ${path} returned a non-JSON response`, {
        code: 'invalid_response',
        status: response.status,
      });
    }
    if (envelope === null || typeof envelope !== 'object') {
      throw new GatekeeperClientError(
        `gatekeeper client: ${path} returned a non-envelope response`,
        {
          code: 'invalid_response',
          status: response.status,
        },
      );
    }
    if (envelope.ok !== true) {
      const error = (envelope as { error?: unknown }).error;
      const { code, message } = gateErrorOf(error, path);
      const runningDigest = gateRunningDigestOf(error);
      throw new GatekeeperClientError(message, {
        code,
        status: response.status,
        ...(call !== undefined
          ? {
              call: {
                operation: call.operation,
                approvedDigest: call.operationDigest ?? null,
                ...(runningDigest !== undefined ? { runningDigest } : {}),
              },
            }
          : {}),
      });
    }
    return envelope.result;
  }

  async describeOperations(target: GateTarget): Promise<DescribeOperationsResponse> {
    return (await this.request(
      target,
      'gate/describe_operations',
      'GET',
    )) as DescribeOperationsResponse;
  }

  async observe(target: GateTarget, input: GatekeeperCallInput): Promise<ObserveResponse> {
    return (await this.request(
      target,
      'gate/observe',
      'POST',
      input,
      this.timeoutMs,
      input,
    )) as ObserveResponse;
  }

  async simulate(target: GateTarget, input: GatekeeperCallInput): Promise<SimulateResponse> {
    return (await this.request(
      target,
      'gate/simulate',
      'POST',
      input,
      this.timeoutMs,
      input,
    )) as SimulateResponse;
  }

  async apply(target: GateTarget, input: GatekeeperApplyInput): Promise<ApplyResponse> {
    return (await this.request(
      target,
      'gate/apply',
      'POST',
      input,
      this.applyTimeoutMs,
      input,
    )) as ApplyResponse;
  }

  async revert(target: GateTarget, input: GatekeeperRevertInput): Promise<RevertResponse> {
    return (await this.request(
      target,
      'gate/revert',
      'POST',
      input,
      this.timeoutMs,
      input,
    )) as RevertResponse;
  }

  async health(target: GateTarget): Promise<HealthResponse> {
    return (await this.request(target, 'gate/health', 'GET')) as HealthResponse;
  }

  async storeConnectedAccount(
    target: GateTarget,
    input: GatekeeperStoreConnectedAccountInput,
  ): Promise<void> {
    await this.request(target, 'gate/connected-accounts', 'POST', input);
  }

  async deleteConnectedAccount(target: GateTarget, onBehalfOf: string): Promise<void> {
    await this.request(target, 'gate/connected-accounts', 'DELETE', { onBehalfOf });
  }
}
