import type {
  ApplyResponse,
  DescribeOperationsResponse,
  HealthResponse,
  ObserveResponse,
  RevertResponse,
  SimulateResponse,
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
 */

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

  constructor(options: HttpGatekeeperClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
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
