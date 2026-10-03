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
  normalizeGateToken,
} from '@nexttime/gatekeeper-base';
import { correlationHeaders } from '@nexttime/shared';
import { currentCorrelationId } from '../../substrate/correlation/index.js';

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

function loadGateToken(env: NodeJS.ProcessEnv): string | undefined {
  const file = resolveGateTokenFile(env);
  try {
    return normalizeGateToken(readFileSync(file, 'utf8'), file);
  } catch {
    return undefined;
  }
}

export class GatekeeperClientError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, options: { code: string; status: number }) {
    super(message);
    this.name = 'GatekeeperClientError';
    this.code = options.code;
    this.status = options.status;
  }
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

export interface GatekeeperCallInput {
  readonly operation: string;
  readonly params?: unknown;
  readonly onBehalfOf?: string;
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
  describeOperations(endpoint: string): Promise<DescribeOperationsResponse>;
  observe(endpoint: string, input: GatekeeperCallInput): Promise<ObserveResponse>;
  simulate(endpoint: string, input: GatekeeperCallInput): Promise<SimulateResponse>;
  apply(endpoint: string, input: GatekeeperApplyInput): Promise<ApplyResponse>;
  revert(endpoint: string, input: GatekeeperRevertInput): Promise<RevertResponse>;
  health(endpoint: string): Promise<HealthResponse>;
  /** S2.13: stores a ConnectedAccount credential on the gate instance, keyed by `onBehalfOf` —
   *  the kernel never persists the credential itself (design doc §11 "凭证只在门"). */
  storeConnectedAccount(
    endpoint: string,
    input: GatekeeperStoreConnectedAccountInput,
  ): Promise<void>;
  /** S2.13: removes a ConnectedAccount credential from the gate instance. */
  deleteConnectedAccount(endpoint: string, onBehalfOf: string): Promise<void>;
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
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_APPLY_TIMEOUT_MS = 60_000;
/** R-49: the most bytes one gate response body may have. Above the gate's own 10 MiB exec output
 *  buffer (`@nexttime/gatekeeper-base` `kinds/ssh.ts` / `kinds/cli.ts`) with room for JSON
 *  escaping; a larger body is refused (`response_too_large`) rather than buffered whole. */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

class ResponseTooLargeError extends Error {}

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

  constructor(options: HttpGatekeeperClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.applyTimeoutMs = options.applyTimeoutMs ?? DEFAULT_APPLY_TIMEOUT_MS;
    this.token = options.token ?? loadGateToken(options.env ?? process.env);
  }

  private async request(
    endpoint: string,
    path: string,
    method: 'GET' | 'POST' | 'DELETE',
    body?: unknown,
    timeoutMs: number = this.timeoutMs,
  ): Promise<unknown> {
    const url = new URL(path, endpoint.endsWith('/') ? endpoint : `${endpoint}/`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const headers: Record<string, string> = { ...correlationHeaders(currentCorrelationId()) };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.token !== undefined) headers.authorization = gateAuthorizationHeader(this.token);
    const timedOut = (): GatekeeperTimeoutError =>
      new GatekeeperTimeoutError(`gatekeeper client: ${path} timed out after ${timeoutMs}ms`, path);
    let response: Response;
    let text: string;
    try {
      try {
        response = await this.fetchImpl(url, {
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
    if (!envelope.ok) {
      throw new GatekeeperClientError(envelope.error.message, {
        code: envelope.error.code,
        status: response.status,
      });
    }
    return envelope.result;
  }

  async describeOperations(endpoint: string): Promise<DescribeOperationsResponse> {
    return (await this.request(
      endpoint,
      'gate/describe_operations',
      'GET',
    )) as DescribeOperationsResponse;
  }

  async observe(endpoint: string, input: GatekeeperCallInput): Promise<ObserveResponse> {
    return (await this.request(endpoint, 'gate/observe', 'POST', input)) as ObserveResponse;
  }

  async simulate(endpoint: string, input: GatekeeperCallInput): Promise<SimulateResponse> {
    return (await this.request(endpoint, 'gate/simulate', 'POST', input)) as SimulateResponse;
  }

  async apply(endpoint: string, input: GatekeeperApplyInput): Promise<ApplyResponse> {
    return (await this.request(
      endpoint,
      'gate/apply',
      'POST',
      input,
      this.applyTimeoutMs,
    )) as ApplyResponse;
  }

  async revert(endpoint: string, input: GatekeeperRevertInput): Promise<RevertResponse> {
    return (await this.request(endpoint, 'gate/revert', 'POST', input)) as RevertResponse;
  }

  async health(endpoint: string): Promise<HealthResponse> {
    return (await this.request(endpoint, 'gate/health', 'GET')) as HealthResponse;
  }

  async storeConnectedAccount(
    endpoint: string,
    input: GatekeeperStoreConnectedAccountInput,
  ): Promise<void> {
    await this.request(endpoint, 'gate/connected-accounts', 'POST', input);
  }

  async deleteConnectedAccount(endpoint: string, onBehalfOf: string): Promise<void> {
    await this.request(endpoint, 'gate/connected-accounts', 'DELETE', { onBehalfOf });
  }
}
