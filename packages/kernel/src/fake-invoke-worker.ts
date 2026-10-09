import type { CryptoKey } from 'jose';
import { withWorkspace } from './adapters/db/pool.js';
import type { PoolLike } from './adapters/db/pool.js';
import type {
  TaskSpawnInput,
  TaskSpawnOutcome,
  TaskSupervisorClientPort,
  TaskSupervisorStatus,
} from './adapters/supervisor-client/index.js';
import { dispatchCapability, resolveSourceBoundCaller } from './application/gateway/index.js';
import {
  FAKE_DELEGATE_MARKER,
  type FakeDelegateOutcome,
  type StartTurnInput,
} from './application/host-bridge/index.js';
import { invokeWorker } from './application/task/index.js';
import type { TaskRuntimeDeps } from './application/task/index.js';
import { listWorkerDefinitions } from './application/worker/index.js';

/**
 * fake-invoke-worker: STATUS leftover 83 — the CI-only glue that lets the e2e stack's
 * `AGENT_RUNTIME=fake` kernel exercise a *real* `invoke_worker` path (Task created, Handle minted
 * with attenuated scope, a Worker run that reports a result contract through
 * `report_task_result`, Task reaches a terminal state) with no agent-host/pi/worker-supervisor in
 * the loop.
 *
 * Deliberately **not** under `application/`, `adapters/`, `governance/` or `substrate/` — a bare
 * file next to `index.ts` itself, imported only by that composition root, exactly like `index.ts`
 * already imports both `application/host-bridge` (host-bridge, per `.dependency-cruiser.cjs`,
 * must never import `application/task`) and `application/task` directly. Living outside every
 * layered directory means this file may freely import both without reopening that rule or
 * inventing a new layer for a CI-only escape hatch — see this task's own PR body for the
 * alternatives this weighed (extending `worker-supervisor`'s CI footprint with a fake image was
 * rejected: slower, another container to keep healthy, and the in-process `TaskSupervisorClientPort`
 * seam `index.ts` already exposes for tests is the smaller, faster change).
 *
 * Two halves, wired together only by `index.ts`'s `main()` under a dedicated, additive env var
 * (`FAKE_INVOKE_WORKER=1`, itself only ever set in `deploy/ci/env.ci.template` — never a real
 * deployment's `.env`, and additionally gated on `AGENT_RUNTIME=fake`/a Handle keypair being
 * configured at all, same as the real task runtime):
 *
 *   1. {@link createFakeDelegateHandler} — the `FakeAgentRuntime.onDelegate` hook: resolves "the
 *      workspace's own most-recently-published, kind='worker' WorkerDefinition" (no id/version
 *      threaded through the chat prompt — a journey spec just needs the marker, not to know or
 *      reverse-engineer an internal id) and calls the real `invoke_worker` core
 *      (`application/task`'s `invokeWorker`) directly, as `channel: 'human'` on behalf of the
 *      chatting principal — the same "unconstrained (human/owner root call)" path
 *      `application/task/handle-mint.ts`'s `resolveParentAuthority` already defines and
 *      `handle-mint.test.ts` already names and tests, just reached here by scripted glue instead
 *      of a real human API call. This bypasses `application/gateway`'s dispatch/authorize layer
 *      entirely (the same way every `invoke.integration.test.ts` case already does) — there is no
 *      real entry Handle in this stack to present at that layer, and this file *is* trusted
 *      composition-root code deciding, once, under a CI-only flag, to call the core function
 *      directly.
 *   2. {@link FakeTaskSupervisorClient} — a `TaskSupervisorClientPort` implementation swapped in
 *      for the real HTTP `TaskSupervisorClient` (via `createBackgroundServices`'s pre-existing
 *      `taskSupervisorClient` test seam). `spawn()` returns a fake container id immediately (same
 *      contract as a real spawn) and, fire-and-forget, authenticates as the Worker the same way a
 *      real one's own first API call back to the kernel would — with the Handle bound to its
 *      address (`resolveSourceBoundCaller`) — and calls `report_task_result` with a minimal valid contract
 *      (`{summary}` — every other field is optional, `packages/shared/src/worker-result.ts`).
 *      Going through `resolveSourceBoundCaller` + `dispatchCapability` in-process (rather than a real HTTP
 *      loopback call) exercises the exact same verification + dispatch pipeline
 *      `interfaces/http/capability-route.ts` uses, deterministically and without needing to know
 *      the kernel's own listening port. `main()` never overrides `loadHandlePublicKey` — the
 *      default loader reads the same mounted key files `loadHandleKeyPair()` already loaded for
 *      the Handle's own signing, so verification lines up with no extra wiring; only the
 *      integration test overrides it (own ephemeral keypair, no real files on disk).
 *
 * Ordering is not a concern: `application/task/lifecycle.ts`'s `completeTaskWithResult` reads the
 * Task's *current* status and validates a path to `completed` from whatever it finds (`queued` or
 * `running`) before writing — the fire-and-forget report landing before or after
 * `invokeWorkerCreate`'s own "mark running" transaction both resolve the Task to `completed`.
 */

const FAKE_WORKER_RESULT_SUMMARY_PREFIX =
  'fake worker executor (CI-only, STATUS leftover 83): scripted report_task_result — no real Worker container ran.';

/** The workspace's own most-recently-published, `kind='worker'` WorkerDefinition — `undefined`
 *  when none exists yet (a journey that has not published one; see `createFakeDelegateHandler`'s
 *  own doc comment for how that surfaces to the chat Turn). */
export async function resolveFakeDelegateTarget(
  pool: PoolLike,
  workspaceId: string,
  principalId: string,
): Promise<{ readonly definitionId: string; readonly version: number } | undefined> {
  const rows = await withWorkspace(pool, { workspaceId, principalId }, (client) =>
    listWorkerDefinitions(client, workspaceId, 'worker'),
  );
  const first = rows[0];
  return first ? { definitionId: first.id, version: first.version } : undefined;
}

export interface FakeDelegateHandlerDeps {
  readonly pool: PoolLike;
  readonly privateKey: CryptoKey;
  readonly supervisorClient: TaskSupervisorClientPort;
}

/** Builds the `FakeAgentRuntime.onDelegate` hook — see this module's own doc comment for the full
 *  design. Rejects (surfacing as the Turn ending `failed`, `fake-runtime.ts`'s own contract) when
 *  the workspace has nothing published to delegate to, rather than guessing or silently no-oping —
 *  an honest "the prerequisite journey① step never ran" signal instead of a misleading success. */
export function createFakeDelegateHandler(
  deps: FakeDelegateHandlerDeps,
): (input: StartTurnInput) => Promise<FakeDelegateOutcome> {
  const taskRuntimeDeps: TaskRuntimeDeps = {
    pool: deps.pool,
    privateKey: deps.privateKey,
    supervisorClient: deps.supervisorClient,
  };

  return async (input: StartTurnInput): Promise<FakeDelegateOutcome> => {
    const target = await resolveFakeDelegateTarget(deps.pool, input.workspaceId, input.principalId);
    if (!target) {
      throw new Error(
        'fake-invoke-worker: no published, kind="worker" WorkerDefinition in this workspace to delegate to',
      );
    }

    // Strips the marker itself out of the recorded Task input — it triggered this scripted path,
    // it is not part of the "message" a human would actually read back on the Tasks page.
    const message = input.prompt.replace(FAKE_DELEGATE_MARKER, '').trim();

    return invokeWorker(
      input.workspaceId,
      { principalId: input.principalId, channel: 'human', turnId: input.turnId },
      {
        definitionId: target.definitionId,
        version: target.version,
        input: { message },
        wait: true,
        timeout: 30,
      },
      taskRuntimeDeps,
    );
  };
}

export interface FakeTaskSupervisorClientOptions {
  readonly pool: PoolLike;
  /** Called whenever the scripted `report_task_result` call throws — never lets that rejection
   *  become an unhandled promise rejection (`spawn()` itself never awaits it). Defaults to a
   *  no-op; `index.ts`'s `main()` passes `app.log.error`. */
  readonly onReportError?: (error: unknown) => void;
  /** `resolveCaller`'s own `loadHandlePublicKey` — omitted (the default, and always true in
   *  `main()`'s own wiring) reads the *same* mounted key files `loadHandleKeyPair()` already loads
   *  for the Handle passed to `createFakeDelegateHandler`, so a Handle this fake supervisor minted
   *  verifies correctly with no extra wiring. Only ever overridden by
   *  `fake-invoke-worker.integration.test.ts`, which — like every other integration test in this
   *  package — mints its own ephemeral keypair rather than reading real files off disk. */
  readonly loadHandlePublicKey?: () => Promise<CryptoKey>;
}

/** A `TaskSupervisorClientPort` with no real worker-supervisor (and no real container runtime)
 *  underneath it — see this module's own doc comment. `terminate`/`status` are honest no-ops:
 *  this fake never has a real container for either to act on (the scripted report already ran
 *  the Task to a terminal status by the time anything would call them), matching the port's own
 *  "false/undefined = worker-supervisor never heard of this" contract
 *  (`adapters/supervisor-client/index.ts`). */
export class FakeTaskSupervisorClient implements TaskSupervisorClientPort {
  private readonly pool: PoolLike;
  private readonly onReportError: (error: unknown) => void;
  private readonly loadHandlePublicKey?: () => Promise<CryptoKey>;

  constructor(options: FakeTaskSupervisorClientOptions) {
    this.pool = options.pool;
    this.onReportError = options.onReportError ?? (() => {});
    this.loadHandlePublicKey = options.loadHandlePublicKey;
  }

  async spawn(input: TaskSpawnInput): Promise<TaskSpawnOutcome> {
    void this.reportResult(input).catch((err: unknown) => this.onReportError(err));
    return { containerId: `fake-worker-${input.workerRunId}`, ip: undefined };
  }

  private async reportResult(input: TaskSpawnInput): Promise<void> {
    // A Worker's Handle is container-held: the real path takes it from the source binding for the
    // container's address (interfaces/source-binding), so this stand-in presents it the same way.
    const caller = await resolveSourceBoundCaller(input.capabilityHandle, {
      pool: this.pool,
      loadHandlePublicKey: this.loadHandlePublicKey,
    });
    await dispatchCapability({ pool: this.pool }, caller, 'report_task_result', {
      summary: `${FAKE_WORKER_RESULT_SUMMARY_PREFIX} (task ${input.taskId}, worker run ${input.workerRunId}).`,
    });
  }

  async terminate(_workerRunId: string): Promise<boolean> {
    return false;
  }

  async status(_workerRunId: string): Promise<TaskSupervisorStatus | undefined> {
    return undefined;
  }
}
