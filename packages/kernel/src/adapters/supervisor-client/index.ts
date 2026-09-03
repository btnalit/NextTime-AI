/**
 * adapters/supervisor-client: a typed HTTP client over `worker-supervisor`'s **Task-mode** API
 * (design doc §7.1 "task | ... | 调用 supervisor"; docs/development-tasks.md S2.7, S2.8;
 * `packages/worker-supervisor/README.md` "Task 模式（S2.8）"). This is the kernel's own client,
 * separate from `packages/agent-host/src/supervisor-client.ts` (which talks to the *resident*-mode
 * API, `/resident/*`, from a different process/package) — the two share no code (this task's
 * dispatch: "write the kernel's own client for `/task/*`, do not import agent-host"), but this
 * module's *shape* (typed error kinds, injectable `fetch`/timeout, a `*Port` interface so callers
 * can inject a fake, never logs the Capability Handle) deliberately mirrors it, the same
 * "adapters implement a port; ports are typed, testable, and never leak a secret into a log line"
 * convention this codebase already uses in three places (`platform-extension/src/kernel-client.ts`,
 * agent-host's own client).
 *
 *   POST /task/spawn                {taskId, workerRunId, workspaceId, onBehalfOf,
 *                                     capabilityHandle, image?, model?, skills?, skillsInline?,
 *                                     timeoutSec?}
 *                                     -> 200 {containerId, ip} / 403 (image not allowlisted) / 400
 *   POST /task/:workerRunId/terminate -> 204 | 404
 *   GET  /task/:workerRunId         -> 200 TaskStatus | 404
 *
 * Trust boundary: same as agent-host's client — `control`-network-only, no auth of its own (see
 * worker-supervisor's own doc comment: "same auth model as agent-host: trusted caller, no separate
 * auth"). This client's own secret is the `capabilityHandle` string it forwards in `spawn`'s body,
 * which — like agent-host's client — it never logs.
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

export type TaskSupervisorErrorKind =
  | 'network'
  | 'timeout'
  | 'invalid_response'
  | 'image_not_allowed'
  | 'invalid_request'
  | 'http_error';

export class TaskSupervisorError extends Error {
  readonly kind: TaskSupervisorErrorKind;
  readonly status?: number;

  constructor(
    kind: TaskSupervisorErrorKind,
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'TaskSupervisorError';
    this.kind = kind;
    this.status = options.status;
  }
}

export interface TaskSkillMountInput {
  readonly name: string;
  readonly hostPath: string;
}

/** One Skill mounted by *content*, not a host path (S2.14; `packages/worker-supervisor`'s own
 *  `config.ts` `TaskSkillInlineSchema` doc comment has the full rationale: the kernel has no
 *  writable data mount of its own, I9-adjacent, so a published Skill's rendered `SKILL.md` text
 *  travels in the spawn request body and `worker-supervisor` writes it to disk itself, under the
 *  Task's own already-bind-mounted workspace directory — no new bind mount needed). `files` keys
 *  are relative filenames under `<agentDir>/skills/<name>/` (`"SKILL.md"` at minimum;
 *  `application/worker/skills.ts`'s `renderSkillMarkdownFile` produces exactly that one file
 *  today — the map shape leaves room for a future Skill to ship more than one). */
export interface TaskSkillInlineMountInput {
  readonly name: string;
  readonly files: Record<string, string>;
}

export interface TaskSpawnInput {
  readonly taskId: string;
  readonly workerRunId: string;
  readonly workspaceId: string;
  readonly onBehalfOf: string;
  /** Capability Handle — never logged. */
  readonly capabilityHandle: string;
  readonly image?: string;
  readonly model?: string;
  readonly skills?: readonly TaskSkillMountInput[];
  readonly skillsInline?: readonly TaskSkillInlineMountInput[];
  readonly timeoutSec?: number;
}

export interface TaskSpawnOutcome {
  readonly containerId: string;
  readonly ip: string | undefined;
}

export type TaskSupervisorState = 'running' | 'exited' | 'terminated' | 'failed';

export interface TaskSupervisorStatus {
  readonly workerRunId: string;
  readonly status: TaskSupervisorState;
  readonly exitCode: number | undefined;
  readonly containerId: string;
  readonly ip: string | undefined;
  readonly startedAt: string | undefined;
  readonly finishedAt: string | undefined;
  readonly reason: string | undefined;
}

async function requestJson(
  fetchImpl: typeof fetch,
  timeoutMs: number,
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(
    () => controller.abort(new Error('worker-supervisor request timeout')),
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
      throw new TaskSupervisorError(
        'invalid_response',
        `worker-supervisor returned non-JSON body: ${String(err)}`,
      );
    }
    return { status: response.status, body };
  } catch (err) {
    if (err instanceof TaskSupervisorError) throw err;
    if (controller.signal.aborted) {
      throw new TaskSupervisorError('timeout', `worker-supervisor request to ${url} timed out`, {
        cause: err,
      });
    }
    throw new TaskSupervisorError(
      'network',
      `worker-supervisor request to ${url} failed: ${String(err)}`,
      { cause: err },
    );
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function errorCodeFromBody(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'error' in body) {
    const error = (body as { error?: unknown }).error;
    if (error && typeof error === 'object' && 'code' in error) {
      const code = (error as { code?: unknown }).code;
      return typeof code === 'string' ? code : undefined;
    }
  }
  return undefined;
}

/** The slice of `TaskSupervisorClient` `application/task` depends on — declared as an interface
 *  (rather than requiring the concrete class) so `application/task`'s unit tests can exercise
 *  `invoke.ts`/`reaper.ts`'s orchestration with a fake, no network involved. Same convention as
 *  `packages/agent-host/src/supervisor-client.ts`'s `SupervisorClientPort` and
 *  `packages/kernel/src/adapters/db/pool.ts`'s `PoolLike`. */
export interface TaskSupervisorClientPort {
  spawn(input: TaskSpawnInput): Promise<TaskSpawnOutcome>;
  /** `false` when worker-supervisor has never heard of this `workerRunId` (404) — idempotent:
   *  terminating an already-finished/unknown Task is a safe no-op from the caller's point of
   *  view. */
  terminate(workerRunId: string): Promise<boolean>;
  status(workerRunId: string): Promise<TaskSupervisorStatus | undefined>;
}

export class TaskSupervisorClient implements TaskSupervisorClientPort {
  private readonly supervisorUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SupervisorClientOptions) {
    this.supervisorUrl = options.supervisorUrl.replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_SUPERVISOR_CLIENT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async spawn(input: TaskSpawnInput): Promise<TaskSpawnOutcome> {
    const { status, body } = await requestJson(
      this.fetchImpl,
      this.timeoutMs,
      `${this.supervisorUrl}/task/spawn`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      },
    );
    if (status === 403) {
      throw new TaskSupervisorError(
        'image_not_allowed',
        errorCodeFromBody(body) ?? 'image not allowlisted',
        { status },
      );
    }
    if (status === 400) {
      throw new TaskSupervisorError(
        'invalid_request',
        errorCodeFromBody(body) ?? 'invalid request',
        {
          status,
        },
      );
    }
    if (status !== 200) {
      throw new TaskSupervisorError('http_error', `POST /task/spawn returned ${status}`, {
        status,
      });
    }
    return body as TaskSpawnOutcome;
  }

  async terminate(workerRunId: string): Promise<boolean> {
    const { status } = await requestJson(
      this.fetchImpl,
      this.timeoutMs,
      `${this.supervisorUrl}/task/${encodeURIComponent(workerRunId)}/terminate`,
      { method: 'POST' },
    );
    if (status === 404) return false;
    if (status !== 204) {
      throw new TaskSupervisorError(
        'http_error',
        `POST /task/:workerRunId/terminate returned ${status}`,
        { status },
      );
    }
    return true;
  }

  async status(workerRunId: string): Promise<TaskSupervisorStatus | undefined> {
    const { status, body } = await requestJson(
      this.fetchImpl,
      this.timeoutMs,
      `${this.supervisorUrl}/task/${encodeURIComponent(workerRunId)}`,
      { method: 'GET' },
    );
    if (status === 404) return undefined;
    if (status !== 200) {
      throw new TaskSupervisorError('http_error', `GET /task/:workerRunId returned ${status}`, {
        status,
      });
    }
    return body as TaskSupervisorStatus;
  }
}
