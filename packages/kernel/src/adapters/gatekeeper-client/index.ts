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
  constructor(message: string) {
    super(message);
    this.name = 'GatekeeperTimeoutError';
  }
}

export interface GatekeeperCallInput {
  readonly operation: string;
  readonly params?: unknown;
  readonly onBehalfOf?: string;
}

export interface GatekeeperApplyInput extends GatekeeperCallInput {
  readonly idempotencyKey: string;
}

export interface GatekeeperRevertInput extends GatekeeperCallInput {
  readonly idempotencyKey?: string;
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
  /** Explicit override for the gate auth token (mainly for tests) — takes precedence over
   *  `NEXTTIME_GATE_TOKEN_FILE` and skips reading a file entirely. Omit to use the env-driven
   *  loader; pass `env` (below) to test that loader against a real temp file instead. */
  readonly token?: string;
  /** Injectable for tests — defaults to `process.env`. Only consulted when `token` is omitted. */
  readonly env?: NodeJS.ProcessEnv;
}

const DEFAULT_TIMEOUT_MS = 15_000;

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
  private readonly token: string | undefined;

  constructor(options: HttpGatekeeperClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.token = options.token ?? loadGateToken(options.env ?? process.env);
  }

  private async request(
    endpoint: string,
    path: string,
    method: 'GET' | 'POST' | 'DELETE',
    body?: unknown,
  ): Promise<unknown> {
    const url = new URL(path, endpoint.endsWith('/') ? endpoint : `${endpoint}/`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.token !== undefined) headers.authorization = gateAuthorizationHeader(this.token);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') {
        throw new GatekeeperTimeoutError(
          `gatekeeper client: ${path} timed out after ${this.timeoutMs}ms`,
        );
      }
      throw new GatekeeperClientError(`gatekeeper client: ${path} request failed`, {
        code: 'network_error',
        status: 0,
      });
    } finally {
      clearTimeout(timeout);
    }

    const envelope = (await response.json()) as Envelope;
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
    return (await this.request(endpoint, 'gate/apply', 'POST', input)) as ApplyResponse;
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
