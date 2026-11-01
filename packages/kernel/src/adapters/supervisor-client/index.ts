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
 *                                     timeoutSec?, egressDeny?, egressDenyAll?}
 *                                     -> 200 {containerId, ip, runtime} / 403 (image not
 *                                        allowlisted) / 400
 *   POST /task/:workerRunId/terminate -> 204 | 404
 *   GET  /task/:workerRunId         -> 200 TaskStatus | 404
 *
 * Trust boundary (lane-6 review follow-up, 2026-09 — supersedes the "no auth of its own" note this
 * doc comment used to carry): `worker-supervisor`'s `POST /task/spawn` now requires the
 * kernel's own credential for it (`packages/worker-supervisor/src/internal-auth.ts`) — this
 * client sends it as `Authorization: Bearer <authorizationHeader>` (already the full header value, e.g.
 * `@nexttime/shared`'s `internalAuthorizationHeader(token)`) on every request it makes, not only
 * the currently-guarded `spawn`, so it never needs revisiting if `terminate`/`status` are ever
 * guarded too. `main()` loads the kernel's own credential for worker-supervisor
 * (`loadSupervisorToken()`, R-03 — never the internal-plane root) and `createBackgroundServices`
 * hands it here. This client's own other secret is the `capabilityHandle` string it forwards in
 * `spawn`'s body, which — like the credential — it never logs.
 *
 * Leftover 87: every request also carries an `x-correlation-id` header — the current call's id
 * (substrate/correlation), or for `spawn` the caller's explicit `options.correlationId` (the
 * Worker's inherited id, which `/task/spawn` puts into the container's `NEXTTIME_CORRELATION_ID`).
 * A header, not a body field: `/task/spawn`'s body schema is strict and unchanged.
 */

import { STEP_FILES_STATE_VALUES, type StepFilesState, correlationHeaders } from '@nexttime/shared';
import { z } from 'zod';
import { currentCorrelationId } from '../../substrate/correlation/index.js';

/** S11 GO14: `POST /task-dirs/keep`'s answer — one state per Task asked about. */
const TaskDirsKeepResponseSchema = z.object({
  tasks: z.array(
    z.object({ taskId: z.string(), state: z.enum(STEP_FILES_STATE_VALUES) }).passthrough(),
  ),
});

export const DEFAULT_SUPERVISOR_CLIENT_TIMEOUT_MS = 30_000;

export interface SupervisorClientOptions {
  /** Base URL of worker-supervisor, e.g. `http://worker-supervisor:8081` — no trailing slash
   *  required. */
  readonly supervisorUrl: string;
  readonly timeoutMs?: number;
  /** Injectable `fetch` implementation, for tests. Defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** The full `Authorization` header value for worker-supervisor's internal-plane guard — e.g.
   *  `internalAuthorizationHeader(token)` from `@nexttime/shared` (`"Bearer <token>"`). Sent on
   *  every request this client makes; `undefined` sends none (only safe when the guard itself is
   *  unconfigured, e.g. some unit tests against a fake worker-supervisor — never in production,
   *  where `POST /task/spawn` would otherwise 401). Never logged. */
  readonly authorizationHeader?: string;
}

export type TaskSupervisorErrorKind =
  | 'network'
  | 'timeout'
  | 'invalid_response'
  | 'image_not_allowed'
  | 'invalid_request'
  /** 409 from worker-supervisor: the image was built before its mount layout (STATUS leftover 422,
   *  `runtime-contract.ts` there). Recorded as the `worker_run.spawn_failed` audit reason. */
  | 'runtime_image_incompatible'
  /** S11 GO14: 409 from worker-supervisor — an earlier step's files this spawn mounts cannot be
   *  mounted (`upstream-files.ts` there); `upstream` on the error says which and why. */
  | 'upstream_unavailable'
  | 'http_error';

export class TaskSupervisorError extends Error {
  readonly kind: TaskSupervisorErrorKind;
  readonly status?: number;
  /** S11 GO14: for `upstream_unavailable`, the step whose files could not be mounted and why. */
  readonly upstream?: { readonly stepKey: string; readonly state: StepFilesState };

  constructor(
    kind: TaskSupervisorErrorKind,
    message: string,
    options: {
      status?: number;
      cause?: unknown;
      upstream?: { readonly stepKey: string; readonly state: StepFilesState };
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'TaskSupervisorError';
    this.kind = kind;
    this.status = options.status;
    if (options.upstream) this.upstream = options.upstream;
  }
}

/** S11 GO14: an earlier step of the same goal whose handoff directory a spawn mounts read-only at
 *  `/upstream/<stepKey>` (worker-supervisor `upstream-files.ts`). */
export interface TaskUpstreamFilesInput {
  readonly stepKey: string;
  readonly taskId: string;
}

/** S11 GO14: one goal step Task for `POST /task-dirs/keep`, and what its directory was found to be. */
export interface TaskDirsKeepInput {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly goalRunId: string;
}
export interface TaskDirsKeepResult {
  readonly taskId: string;
  readonly state: StepFilesState;
}

/** S11 GO14: how many Tasks one `POST /task-dirs/keep` may name (worker-supervisor's
 *  `MAX_TASK_DIRS_KEEP_BATCH`). */
export const TASK_DIRS_KEEP_BATCH = 500;

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
  /** feat/egress-definition-lists: forwarded verbatim into `/task/spawn`'s own `egressDeny`
   *  (`packages/worker-supervisor`'s `config.ts` `TaskSpawnRequestSchema`) — the invoked
   *  WorkerDefinition's own egress deny list, never re-derived by this client. */
  readonly egressDeny?: readonly string[];
  /** S10 E3-2a: `true` for an evaluation Task's run — its egress source is written deny-all
   *  (worker-supervisor's `egressDenyAll`, E3-2-0), so the run reaches nothing outside the
   *  platform. Set by `spawnWorkerRun` from the Task's own `purpose`, never by a caller. A
   *  supervisor that predates the field refuses the spawn (strict schema → 400), so an evaluation
   *  run never starts without it. */
  readonly egressDenyAll?: boolean;
  /** P-A2: the Worker container's system prompt (the WorkerDefinition's own `systemPrompt` plus
   *  the platform's `instanceInstructions`), written by worker-supervisor into the Task's
   *  platform directory outside its workspace (read-only `/opt/nexttime/platform/system-prompt.md`
   *  in the container) before start. Omitted = the runtime image's default prompt. */
  readonly systemPrompt?: string;
  /** S11 GO14: the goal run a goal step's attempt Task works for — worker-supervisor makes its
   *  handoff directory (`/workspace/out`) and owner marker. A supervisor that predates the field
   *  refuses the spawn (strict schema → 400): the two are upgraded and rolled back together. */
  readonly goalRunId?: string;
  /** S11 GO14: earlier steps' handoff directories to mount (the step's `filesFrom`, each one's
   *  accepted attempt) — chosen by the advancer, checked again by worker-supervisor. */
  readonly upstream?: readonly TaskUpstreamFilesInput[];
}

/** S11 W1a: what worker-supervisor reported about the container it started for a WorkerRun —
 *  mirrors `packages/worker-supervisor`'s own `TaskRuntimeReport` (runtime-report.ts there). */
export interface TaskRuntimeReport {
  readonly imageRef: string;
  /** The container runtime's resolved image id, `sha256:<64 hex>`. */
  readonly imageId: string;
  readonly piVersion: string | undefined;
  readonly platformExtensionVersion: string | undefined;
  readonly builtFrom: string | undefined;
  /** `sha256:<64 hex>` of the `models.json` the container mounted, when the supervisor read it. */
  readonly modelsConfigDigest: string | undefined;
}

export interface TaskSpawnOutcome {
  readonly containerId: string;
  readonly ip: string | undefined;
  /** S11 W1a: absent from a worker-supervisor that predates it, or when what it sent does not
   *  parse ({@link parseTaskRuntimeReport}). */
  readonly runtime?: TaskRuntimeReport;
}

const SHA256_ID = /^sha256:[0-9a-f]{64}$/;
const isSha256Id = (value: string): boolean => SHA256_ID.test(value);

/** Deliberately a char-code loop, not a `/[\x00-\x1f\x7f]/` regex (biome's
 *  `noControlCharactersInRegex`, same as shared `wire/llm-admin.ts`'s `hasControlCharacter`): C0
 *  controls (0x00–0x1F) plus DEL (0x7F). */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** An image reference: no whitespace or control character, the container runtime's own length
 *  bound. */
function isImageRef(value: string): boolean {
  return (
    value.length >= 1 && value.length <= 255 && !/\s/.test(value) && !hasControlCharacter(value)
  );
}

/** A version label (`v0.50.0 (abc1234)` for built-from): printable, one line. */
function isLabelText(value: string): boolean {
  return value.length >= 1 && value.length <= 200 && !hasControlCharacter(value);
}

function optionalMatch(value: unknown, accept: (value: string) => boolean): string | undefined {
  return typeof value === 'string' && accept(value) ? value : undefined;
}

/**
 * S11 W1a: `/task/spawn`'s `runtime`, as the kernel will store it on the WorkerRun and the console
 * will show it. worker-supervisor is trusted, but what it sends is still checked here, at the
 * boundary: no image reference or id of the expected shape → no report at all (`undefined`, the
 * run's runtime reads "未记录"); a label or digest of the wrong shape → that field alone dropped.
 */
export function parseTaskRuntimeReport(value: unknown): TaskRuntimeReport | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const imageRef = optionalMatch(record.imageRef, isImageRef);
  const imageId = optionalMatch(record.imageId, isSha256Id);
  if (imageRef === undefined || imageId === undefined) return undefined;
  return {
    imageRef,
    imageId,
    piVersion: optionalMatch(record.piVersion, isLabelText),
    platformExtensionVersion: optionalMatch(record.platformExtensionVersion, isLabelText),
    builtFrom: optionalMatch(record.builtFrom, isLabelText),
    modelsConfigDigest: optionalMatch(record.modelsConfigDigest, isSha256Id),
  };
}

/** S7-E (P-C §6.5): one runtime image, as worker-supervisor's `GET /images` reports it — mirrors
 *  `packages/worker-supervisor`'s own `RuntimeImageInfo` (this package cannot import that
 *  package's type directly, same convention every other adapter shape here already follows). */
export interface RuntimeImageInfo {
  readonly id: string;
  readonly tags: readonly string[];
  readonly created: string;
  readonly labels: Readonly<Record<string, string>>;
}

/** S7-E: `GET /images`'s full response — `defaultImage` is worker-supervisor's own
 *  `config.workerImage` (its `WORKER_IMAGE` env, resolved). The kernel has no other way to learn
 *  this (the two processes only ever talk over HTTP) — `application/platform/runtime.ts` reads
 *  this instead of guessing a compiled-in default, so a host that overrides `WORKER_IMAGE` away
 *  from the image's own build-time default name is still reported correctly.
 *
 * `allowedImages` (P1-a hotfix, post-v0.16.0 review): worker-supervisor's own
 * `config.taskImageAllowlist` verbatim — the exact static allowlist its `/task/spawn` and
 * `/resident/spawn` already enforce (`isImageAllowed`). `application/platform/runtime.ts` reads
 * this to reject a `set_active_runtime_image`/`rollback_runtime_image` target that is not
 * allowlisted, instead of only discovering it once every future spawn starts 403ing.
 *
 * `runtimeContract` (STATUS leftover 422): the `ai.nexttime.runtime-contract` label value every
 * image worker-supervisor starts must carry (its `runtime-contract.ts`; a mismatch 409s
 * `runtime_image_incompatible` at spawn). `undefined` from a worker-supervisor that predates it —
 * then nothing is known to be incompatible and nothing is refused on that ground. */
export interface RuntimeImageInventory {
  readonly defaultImage: string;
  readonly images: RuntimeImageInfo[];
  readonly allowedImages: readonly string[];
  readonly runtimeContract?: string;
}

/** S7-E: one resident entry container, as worker-supervisor's `GET /residents` reports it —
 *  mirrors that package's own `ResidentInventoryEntry`. */
export interface ResidentInventoryEntry {
  readonly principalId: string;
  readonly workspaceId: string;
  readonly containerId: string;
  readonly running: boolean;
  readonly status: string;
  readonly image: string | undefined;
  readonly imageId: string | undefined;
  readonly startedAt: string | undefined;
  readonly lastTouchedAt: string | undefined;
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

function errorMessageFromBody(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'error' in body) {
    const error = (body as { error?: unknown }).error;
    if (error && typeof error === 'object' && 'message' in error) {
      const message = (error as { message?: unknown }).message;
      return typeof message === 'string' ? message : undefined;
    }
  }
  return undefined;
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
/** Per-call options for {@link TaskSupervisorClientPort.spawn} (leftover 87). */
export interface TaskSpawnCallOptions {
  /** Sent as `x-correlation-id` instead of the current call context's id — the Worker's own
   *  inherited id (`application/task/spawn.ts` resolves it). Never part of the request body. */
  readonly correlationId?: string;
}

export interface TaskSupervisorClientPort {
  spawn(input: TaskSpawnInput, options?: TaskSpawnCallOptions): Promise<TaskSpawnOutcome>;
  /** `false` when worker-supervisor has never heard of this `workerRunId` (404) — idempotent:
   *  terminating an already-finished/unknown Task is a safe no-op from the caller's point of
   *  view. */
  terminate(workerRunId: string): Promise<boolean>;
  status(workerRunId: string): Promise<TaskSupervisorStatus | undefined>;
  /**
   * P-A2: `POST /resident/stop {principalId}` — stops one principal's resident entry container
   * (the same endpoint `packages/agent-host`'s supervisor client already knows). Used by the
   * platform plane when a workspace or a user is disabled (docs/platform-admin-design.md §8
   * "停用用户 … 入口容器 stop"). Optional on the port so the existing test fakes (which model the
   * one-shot Task half only) keep compiling; callers treat a missing method as "nothing to stop".
   * `true` when a container was stopped, `false` when worker-supervisor knew of none (404).
   */
  stopResident?(principalId: string): Promise<boolean>;
  /**
   * S8 W5 (leftover 77): `POST /resident/reclaim {principalId}` — permanently reclaims one
   * principal's resident entry container (force-removed, not just stopped) and its
   * `workspaces/<principalId>` data directory. Called only from `purge_workspace`'s `afterCommit`
   * (`platform-handlers.ts`'s `reclaimEntryContainers`), once per purged Principal id, and only
   * once the purge actually executed — a purge is irreversible, so nothing will ever reuse that
   * container again (unlike `stopResident`, used for disable, where a stopped-but-present
   * container is the point). Optional on the port for the same reason `stopResident` is. `true`
   * when worker-supervisor acted, `false` when it knew of no such principal (404 — still a
   * success from this caller's point of view: nothing was there to reclaim).
   */
  reclaimResident?(principalId: string): Promise<boolean>;
  /** S7-E: `GET /images` — every runtime image carrying the platform's `ai.nexttime.*` labels,
   *  plus worker-supervisor's own reported `defaultImage`. Optional on the port for the same
   *  reason `stopResident` is (existing test fakes across `application/task/*.integration.test.ts`
   *  model the Task-mode half only); `application/platform/runtime.ts`'s handlers treat a missing
   *  implementation as "no images known", never a thrown error. */
  listImages?(): Promise<RuntimeImageInventory>;
  /** S7-E: `GET /residents` — every resident entry container across every workspace. Same
   *  optionality reasoning as `listImages` above. */
  listResidents?(): Promise<ResidentInventoryEntry[]>;
  /** S11 GO14: `POST /task-dirs/keep` — the state of each goal step Task's handoff directory for
   *  a reader of that workspace and goal run, a `kept` one's directories renewed against the
   *  retention sweep. At most {@link TASK_DIRS_KEEP_BATCH} per call. Optional on the port for the
   *  same reason `stopResident` is; callers treat a missing method as "not known". */
  keepTaskDirs?(tasks: readonly TaskDirsKeepInput[]): Promise<readonly TaskDirsKeepResult[]>;
}

export class TaskSupervisorClient implements TaskSupervisorClientPort {
  private readonly supervisorUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly authHeaders: Record<string, string>;

  constructor(options: SupervisorClientOptions) {
    this.supervisorUrl = options.supervisorUrl.replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_SUPERVISOR_CLIENT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.authHeaders =
      options.authorizationHeader !== undefined
        ? { authorization: options.authorizationHeader }
        : {};
  }

  /** Auth + correlation headers for one request — the correlation id defaults to the current
   *  call context's (leftover 87). */
  private headers(correlationId = currentCorrelationId()): Record<string, string> {
    return { ...correlationHeaders(correlationId), ...this.authHeaders };
  }

  async spawn(
    input: TaskSpawnInput,
    options: TaskSpawnCallOptions = {},
  ): Promise<TaskSpawnOutcome> {
    const { status, body } = await requestJson(
      this.fetchImpl,
      this.timeoutMs,
      `${this.supervisorUrl}/task/spawn`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...this.headers(options.correlationId),
        },
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
    const code = errorCodeFromBody(body);
    if (status === 409 && code === 'runtime_image_incompatible') {
      // The supervisor's message names the image and the label it found.
      throw new TaskSupervisorError(code, errorMessageFromBody(body) ?? code, { status });
    }
    if (status === 409 && code === 'upstream_unavailable') {
      const error = (body as { error?: { stepKey?: unknown; state?: unknown } }).error;
      const state = STEP_FILES_STATE_VALUES.find((value) => value === error?.state);
      throw new TaskSupervisorError(code, errorMessageFromBody(body) ?? code, {
        status,
        ...(typeof error?.stepKey === 'string' && state
          ? { upstream: { stepKey: error.stepKey, state } }
          : {}),
      });
    }
    if (status !== 200) {
      throw new TaskSupervisorError(
        'http_error',
        `POST /task/spawn returned ${status}${code ? ` ${code}` : ''}`,
        { status },
      );
    }
    const outcome = body as { containerId: string; ip: string | undefined; runtime?: unknown };
    const runtime = parseTaskRuntimeReport(outcome.runtime);
    return {
      containerId: outcome.containerId,
      ip: outcome.ip,
      ...(runtime ? { runtime } : {}),
    };
  }

  async keepTaskDirs(tasks: readonly TaskDirsKeepInput[]): Promise<readonly TaskDirsKeepResult[]> {
    if (tasks.length === 0) return [];
    const { status, body } = await requestJson(
      this.fetchImpl,
      this.timeoutMs,
      `${this.supervisorUrl}/task-dirs/keep`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.headers() },
        body: JSON.stringify({ tasks }),
      },
    );
    if (status !== 200) {
      const code = errorCodeFromBody(body);
      throw new TaskSupervisorError(
        status === 400 ? 'invalid_request' : 'http_error',
        `POST /task-dirs/keep returned ${status}${code ? ` ${code}` : ''}`,
        { status },
      );
    }
    const parsed = TaskDirsKeepResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new TaskSupervisorError('invalid_response', 'POST /task-dirs/keep: unexpected body', {
        status,
      });
    }
    return parsed.data.tasks;
  }

  async stopResident(principalId: string): Promise<boolean> {
    const { status } = await requestJson(
      this.fetchImpl,
      this.timeoutMs,
      `${this.supervisorUrl}/resident/stop`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.headers() },
        body: JSON.stringify({ principalId }),
      },
    );
    if (status === 204 || status === 200) return true;
    if (status === 404) return false;
    throw new TaskSupervisorError('http_error', `POST /resident/stop returned ${status}`, {
      status,
    });
  }

  async reclaimResident(principalId: string): Promise<boolean> {
    const { status } = await requestJson(
      this.fetchImpl,
      this.timeoutMs,
      `${this.supervisorUrl}/resident/reclaim`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.headers() },
        body: JSON.stringify({ principalId }),
      },
    );
    if (status === 204 || status === 200) return true;
    if (status === 404) return false;
    throw new TaskSupervisorError('http_error', `POST /resident/reclaim returned ${status}`, {
      status,
    });
  }

  async listImages(): Promise<RuntimeImageInventory> {
    const { status, body } = await requestJson(
      this.fetchImpl,
      this.timeoutMs,
      `${this.supervisorUrl}/images`,
      { method: 'GET', headers: this.headers() },
    );
    if (status !== 200) {
      throw new TaskSupervisorError('http_error', `GET /images returned ${status}`, { status });
    }
    const parsed = body as RuntimeImageInventory;
    // P1-a hotfix: defend against an older worker-supervisor that does not yet send
    // `allowedImages` — default to "nothing allowed" (fail closed), never guessed open.
    return {
      ...parsed,
      allowedImages: parsed.allowedImages ?? [],
      runtimeContract:
        typeof parsed.runtimeContract === 'string' ? parsed.runtimeContract : undefined,
    };
  }

  async listResidents(): Promise<ResidentInventoryEntry[]> {
    const { status, body } = await requestJson(
      this.fetchImpl,
      this.timeoutMs,
      `${this.supervisorUrl}/residents`,
      { method: 'GET', headers: this.headers() },
    );
    if (status !== 200) {
      throw new TaskSupervisorError('http_error', `GET /residents returned ${status}`, { status });
    }
    return (body as { items: ResidentInventoryEntry[] }).items;
  }

  async terminate(workerRunId: string): Promise<boolean> {
    const { status } = await requestJson(
      this.fetchImpl,
      this.timeoutMs,
      `${this.supervisorUrl}/task/${encodeURIComponent(workerRunId)}/terminate`,
      { method: 'POST', headers: this.headers() },
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
      { method: 'GET', headers: this.headers() },
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
