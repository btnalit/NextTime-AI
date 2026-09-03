import type { CryptoKey } from 'jose';
import type { PoolLike } from '../../adapters/db/pool.js';
import type { TaskSupervisorClientPort } from '../../adapters/supervisor-client/index.js';

/**
 * application/task/runtime: the process-level dependencies `invoke.ts`/`reaper.ts`/`service.ts`
 * need beyond `(client, workspaceId, ...)` — the Handle-signing private key and a
 * `TaskSupervisorClientPort` — wired once by the composition root
 * (`packages/kernel/src/index.ts`, `configureTaskRuntime`) and read by the capability handlers
 * (`application/gateway/handlers.ts`) and the reaper's interval loop. Same "module-level
 * singleton set once by the composition root" shape `application/gateway/handlers.ts` already
 * uses for `agentRuntime`/`setAgentRuntimeForHandlers` — kept here, in `application/task` itself,
 * rather than in `handlers.ts`, so that file's own S2.7 additions stay to "wire a handler that
 * calls into this module" and never need to know what a `TaskSupervisorClientPort` is.
 *
 * Every actual unit under test (`invokeWorker`, `runTaskReaper`, `terminateTask`, ...) takes its
 * `TaskRuntimeDeps` as an explicit parameter — this module's singleton is only what the thin
 * capability-handler/composition-root wrappers read, never the core logic itself, so every real
 * unit test injects a fake `TaskSupervisorClientPort` and an ephemeral key pair directly, no
 * global state involved.
 *
 * **Why `pool`, not just a `PoolClient`:** `invoke_worker`'s handler cannot use the single
 * `client`/transaction `application/gateway/dispatch.ts`'s `dispatchCapability` opens around
 * every capability call — see `invoke.ts`'s own module doc comment for the full reasoning (in
 * short: a Handle minted inside an uncommitted transaction is unusable by the Worker it was
 * minted for until that transaction commits, which would make `wait=true` self-deadlock). Every
 * function in this module therefore manages its own short, independently-committed
 * `withWorkspace(deps.pool, ...)` transactions instead.
 */
export interface TaskRuntimeDeps {
  readonly pool: PoolLike;
  readonly privateKey: CryptoKey;
  readonly supervisorClient: TaskSupervisorClientPort;
  /** Injectable clock, for deterministic tests. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
  /** Injectable sleep, for deterministic tests (the `wait=true` poll loop). Defaults to a real
   *  `setTimeout`-based sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export class TaskRuntimeNotConfiguredError extends Error {
  constructor() {
    super(
      'application/task: TaskRuntimeDeps has not been configured — the composition root ' +
        '(packages/kernel/src/index.ts) must call configureTaskRuntime() before any task ' +
        'capability handler runs',
    );
    this.name = 'TaskRuntimeNotConfiguredError';
  }
}

let configuredDeps: TaskRuntimeDeps | undefined;

/** Called once by the composition root. */
export function configureTaskRuntime(deps: TaskRuntimeDeps): void {
  configuredDeps = deps;
}

/** Read by the capability handlers and the reaper's interval loop. Throws
 *  `TaskRuntimeNotConfiguredError` if `configureTaskRuntime` was never called (e.g. a unit test
 *  exercising a handler directly with no runtime wired — same "safe to fail loudly rather than
 *  silently no-op" choice `application/host-bridge/agent-host-runtime.ts` and friends make for
 *  their own required deps, unlike `stopAgentHandler`'s deliberately-optional `agentRuntime`). */
export function getConfiguredTaskRuntime(): TaskRuntimeDeps {
  if (!configuredDeps) throw new TaskRuntimeNotConfiguredError();
  return configuredDeps;
}

/** Test-only escape hatch to reset the singleton between test files/suites. */
export function resetTaskRuntimeForTests(): void {
  configuredDeps = undefined;
}
