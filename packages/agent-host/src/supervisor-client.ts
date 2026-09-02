/**
 * supervisor-client: a thin fetch client over `worker-supervisor`'s resident-mode HTTP API
 * (`docs/runbooks/host-worker-runtime.md` §9 "供下一个任务（agent-host 事件桥）参考的 supervisor API
 * 契约" — this *is* that next task). Mirrors `packages/platform-extension/src/kernel-client.ts`'s
 * shape (typed error kinds, injectable `fetch`/timeout, never logs a secret) one level down: this
 * client's own secret is the Capability Handle it forwards in every `spawn` call's body, which it
 * never logs either.
 *
 *   POST /resident/spawn          {workspaceId, principalId, handle, kernelUrl?, llmUrl?}
 *                                   -> 200 {containerId, ip, status, created, restarts}
 *   POST /resident/stop           {principalId} -> 204
 *   GET  /resident/:principalId   -> 200 ResidentStatus | 404
 *   POST /resident/:principalId/touch -> 204 | 404
 */

export const DEFAULT_SUPERVISOR_CLIENT_TIMEOUT_MS = 30_000;

export interface SupervisorClientOptions {
  /** Base URL of worker-supervisor, e.g. `http://worker-supervisor:8081` — no trailing slash
   *  required. */
  readonly supervisorUrl: string;
  readonly timeoutMs?: number;
  /** Injectable `fetch` implementation, for tests. Defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export type SupervisorErrorKind = 'network' | 'timeout' | 'invalid_response' | 'http_error';

export class SupervisorError extends Error {
  readonly kind: SupervisorErrorKind;
  readonly status?: number;

  constructor(
    kind: SupervisorErrorKind,
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'SupervisorError';
    this.kind = kind;
    this.status = options.status;
  }
}

export interface SpawnInput {
  readonly workspaceId: string;
  readonly principalId: string;
  /** Capability Handle — never logged. */
  readonly handle: string;
  readonly kernelUrl?: string;
  readonly llmUrl?: string;
}

export interface SpawnResult {
  readonly containerId: string;
  readonly ip: string | undefined;
  readonly status: string;
  readonly created: boolean;
  readonly restarts: number;
}

export interface ResidentStatus {
  readonly principalId: string;
  readonly containerId: string;
  readonly ip: string | undefined;
  readonly running: boolean;
  readonly status: string;
  readonly startedAt: string | undefined;
  readonly restarts: number;
  readonly lastTouchedAt: string | undefined;
}

async function requestJson(
  fetchImpl: typeof fetch,
  timeoutMs: number,
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(
    () => controller.abort(new Error('supervisor request timeout')),
    timeoutMs,
  );
  timeoutHandle.unref?.();
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let body: unknown;
    try {
      body = text.length > 0 ? JSON.parse(text) : undefined;
    } catch (err) {
      throw new SupervisorError(
        'invalid_response',
        `worker-supervisor returned non-JSON body: ${String(err)}`,
      );
    }
    return { status: response.status, body };
  } catch (err) {
    if (err instanceof SupervisorError) throw err;
    if (controller.signal.aborted) {
      throw new SupervisorError('timeout', `worker-supervisor request to ${url} timed out`, {
        cause: err,
      });
    }
    throw new SupervisorError(
      'network',
      `worker-supervisor request to ${url} failed: ${String(err)}`,
      {
        cause: err,
      },
    );
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/** The slice of `SupervisorClient` `host.ts` depends on — declared as an interface (rather than
 *  requiring the concrete class) so tests can exercise `host.ts`'s orchestration with a fake, no
 *  network involved. Same convention as `packages/kernel/src/adapters/db/pool.ts`'s `PoolLike`. */
export interface SupervisorClientPort {
  spawn(input: SpawnInput): Promise<SpawnResult>;
  stop(principalId: string): Promise<void>;
  status(principalId: string): Promise<ResidentStatus | undefined>;
  touch(principalId: string): Promise<boolean>;
}

export class SupervisorClient implements SupervisorClientPort {
  private readonly supervisorUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SupervisorClientOptions) {
    this.supervisorUrl = options.supervisorUrl.replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_SUPERVISOR_CLIENT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Idempotent: worker-supervisor reuses a running container for this principal (`created:
   *  false`) or spawns a fresh one (crash/never-spawned — `created: true`, `restarts` incremented
   *  for the crash case) — see resident-service.ts's own doc comment. This is what makes calling
   *  `spawn` on every `startTurn` correct rather than wasteful: the common case is a cheap
   *  reuse-and-return. */
  async spawn(input: SpawnInput): Promise<SpawnResult> {
    const { status, body } = await requestJson(
      this.fetchImpl,
      this.timeoutMs,
      `${this.supervisorUrl}/resident/spawn`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      },
    );
    if (status !== 200) {
      throw new SupervisorError('http_error', `POST /resident/spawn returned ${status}`, {
        status,
      });
    }
    return body as SpawnResult;
  }

  async stop(principalId: string): Promise<void> {
    const { status } = await requestJson(
      this.fetchImpl,
      this.timeoutMs,
      `${this.supervisorUrl}/resident/stop`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ principalId }),
      },
    );
    if (status !== 204) {
      throw new SupervisorError('http_error', `POST /resident/stop returned ${status}`, { status });
    }
  }

  async status(principalId: string): Promise<ResidentStatus | undefined> {
    const { status, body } = await requestJson(
      this.fetchImpl,
      this.timeoutMs,
      `${this.supervisorUrl}/resident/${encodeURIComponent(principalId)}`,
      { method: 'GET' },
    );
    if (status === 404) return undefined;
    if (status !== 200) {
      throw new SupervisorError('http_error', `GET /resident/:principalId returned ${status}`, {
        status,
      });
    }
    return body as ResidentStatus;
  }

  /** Refreshes the idle-timeout clock. Returns `false` when worker-supervisor has never heard of
   *  this principal (404 — see resident-service.ts's own `touch` doc comment for the recovery
   *  case this still tolerates). */
  async touch(principalId: string): Promise<boolean> {
    const { status } = await requestJson(
      this.fetchImpl,
      this.timeoutMs,
      `${this.supervisorUrl}/resident/${encodeURIComponent(principalId)}/touch`,
      { method: 'POST' },
    );
    if (status === 404) return false;
    if (status !== 204) {
      throw new SupervisorError(
        'http_error',
        `POST /resident/:principalId/touch returned ${status}`,
        { status },
      );
    }
    return true;
  }
}
