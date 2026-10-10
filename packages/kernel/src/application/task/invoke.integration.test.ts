import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IllegalTransition } from '@nexttime/shared';
import type { CapabilityScope, HandleClaims } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import type { PoolLike } from '../../adapters/db/pool.js';
import {
  type TaskSpawnInput,
  type TaskSpawnOutcome,
  type TaskSupervisorClientPort,
  TaskSupervisorError,
  type TaskSupervisorStatus,
} from '../../adapters/supervisor-client/index.js';
import { setAgentProfile } from '../../governance/agent-profile/index.js';
import {
  type IssuedHandle,
  entryScope,
  generateEphemeralHandleKeyPair,
  issueHandle,
} from '../../governance/capability/index.js';
import { withAdminClient } from '../gateway/auth.js';
import { composeSystemPrompt, updatePlatformSettings } from '../platform/index.js';
import { proposeWorkerDefinition, publishWorkerDefinition } from '../worker/index.js';
import { invokeWorker } from './invoke.js';
import {
  completeTaskWithResult,
  failTaskAndReapWorkerRuns,
  reactToSupervisorStatus,
  readTaskRow,
  readWorkerRunRow,
} from './lifecycle.js';
import { runTaskReaper } from './reaper.js';
import type { TaskRuntimeDeps } from './runtime.js';
import { recordWorkerRunUsage, terminateTask } from './service.js';
import { spawnWorkerRun } from './spawn.js';
import {
  InvokeWorkerAttenuationError,
  InvokeWorkerDefinitionNotEnabledError,
  QuotaExceededError,
} from './types.js';
import type { TaskRow } from './types.js';

/**
 * application/task/invoke.integration.test: DB-gated (real Postgres; auto-skip without
 * DATABASE_URL) end-to-end tests for `invoke_worker`'s full flow, using a fake, in-memory
 * `TaskSupervisorClientPort` (no real Docker/worker-supervisor) — docs/development-tasks.md S2.7
 * "unit with fakes (supervisor client, clock)". Covers: depth-4 rejection, attenuation rejection,
 * wait=true timeout, requeue-once, terminate revokes Handle, and budget 100% → failed:
 * budget_exhausted.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
/** The test WorkerDefinition's own `systemPrompt` — P-A2 composes the container's prompt out
 *  of this plus the platform's `instanceInstructions`. */
const DEFINITION_SYSTEM_PROMPT = 'You are a plain worker.';

/** In-memory `TaskSupervisorClientPort` — every spawn "succeeds" immediately and starts
 *  `running`; tests mutate `.statuses` directly to simulate exit/failure/timeout. */
class FakeTaskSupervisorClient implements TaskSupervisorClientPort {
  readonly spawnCalls: TaskSpawnInput[] = [];
  readonly terminated: string[] = [];
  readonly statuses = new Map<string, TaskSupervisorStatus>();

  async spawn(input: TaskSpawnInput): Promise<TaskSpawnOutcome> {
    this.spawnCalls.push(input);
    const containerId = `container-${input.workerRunId}`;
    this.statuses.set(input.workerRunId, {
      workerRunId: input.workerRunId,
      status: 'running',
      exitCode: undefined,
      containerId,
      ip: '198.51.100.10',
      startedAt: new Date().toISOString(),
      finishedAt: undefined,
      reason: undefined,
    });
    return { containerId, ip: '198.51.100.10' };
  }

  async terminate(workerRunId: string): Promise<boolean> {
    this.terminated.push(workerRunId);
    const existing = this.statuses.get(workerRunId);
    if (!existing) return false;
    this.statuses.set(workerRunId, { ...existing, status: 'terminated', reason: 'requested' });
    return true;
  }

  async status(workerRunId: string): Promise<TaskSupervisorStatus | undefined> {
    return this.statuses.get(workerRunId);
  }

  setStatus(workerRunId: string, patch: Partial<TaskSupervisorStatus>): void {
    const existing = this.statuses.get(workerRunId);
    if (!existing) throw new Error(`no status seeded for ${workerRunId}`);
    this.statuses.set(workerRunId, { ...existing, ...patch });
  }
}

describe.runIf(DATABASE_URL !== undefined)('invoke_worker — integration (real Postgres)', () => {
  let pool: Pool;
  let privateKey: Awaited<ReturnType<typeof generateEphemeralHandleKeyPair>>['privateKey'];
  let workspaceId: string;
  let ownerId: string;
  let workerDefinitionId: string;

  async function adminInsertWorkspace(name: string): Promise<string> {
    const id = randomUUID();
    await withWorkspace(
      pool,
      { workspaceId: id, principalId: randomUUID() },
      async (client) => {
        await client.query('insert into workspaces (id, name) values ($1, $2)', [id, name]);
      },
      { skipRoleSwitch: true },
    );
    return id;
  }

  async function adminInsertPrincipal(role: string, displayName: string): Promise<string> {
    const id = randomUUID();
    await withWorkspace(
      pool,
      { workspaceId, principalId: id },
      async (client) => {
        await client.query(
          "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', $3, $4)",
          [workspaceId, id, role, displayName],
        );
      },
      { skipRoleSwitch: true },
    );
    return id;
  }

  async function inTx<T>(principalId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return withWorkspace(pool, { workspaceId, principalId }, fn);
  }

  async function insertSession(
    kind: string,
    principalId: string,
    onBehalfOf: string,
  ): Promise<string> {
    return inTx(principalId, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into sessions (workspace_id, principal_id, kind, on_behalf_of, status)
         values ($1, $2, $3, $4, 'active') returning id`,
        [workspaceId, principalId, kind, onBehalfOf],
      );
      const id = result.rows[0]?.id;
      if (!id) throw new Error('failed to insert session');
      return id;
    });
  }

  async function issueTestHandle(
    sessionId: string,
    scope: CapabilityScope,
    ttlSeconds = 3600,
  ): Promise<IssuedHandle> {
    return inTx(ownerId, (client) =>
      issueHandle(client, { sessionId, scope, ttlSeconds, privateKey }),
    );
  }

  function claimsFromIssued(issued: IssuedHandle): HandleClaims {
    return {
      ws: issued.workspaceId,
      sid: issued.sessionId,
      obo: issued.onBehalfOf,
      scope: issued.scope,
      jti: issued.jti,
      iat: Math.floor(issued.issuedAt.getTime() / 1000),
      exp: Math.floor(issued.expiresAt.getTime() / 1000),
      ...(issued.parentJti !== undefined ? { par: issued.parentJti } : {}),
    };
  }

  /** Publishes a `kind='worker'` WorkerDefinition and returns its `{definitionId, version}`. */
  async function publishWorkerDef(
    content: Record<string, unknown>,
  ): Promise<{ id: string; version: number }> {
    const proposed = await inTx(ownerId, (client) =>
      proposeWorkerDefinition(client, workspaceId, ownerId, {
        kind: 'worker',
        definition: content,
      }),
    );
    await inTx(ownerId, (client) =>
      publishWorkerDefinition(client, workspaceId, ownerId, {
        definitionId: proposed.id,
        version: proposed.version,
      }),
    );
    return { id: proposed.id, version: proposed.version };
  }

  function deps(
    supervisorClient: FakeTaskSupervisorClient,
    overrides: Partial<TaskRuntimeDeps> = {},
  ): TaskRuntimeDeps {
    return { pool, privateKey, supervisorClient, ...overrides };
  }

  beforeAll(async () => {
    pool = createPool();
    await runMigrations(pool, MIGRATIONS_DIR);
    const keyPair = await generateEphemeralHandleKeyPair();
    privateKey = keyPair.privateKey;

    workspaceId = await adminInsertWorkspace('invoke-worker-integration-test');
    ownerId = await adminInsertPrincipal('owner', 'owner');

    const definition = await publishWorkerDef({ systemPrompt: DEFINITION_SYSTEM_PROMPT });
    workerDefinitionId = definition.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('invoke_worker (wait=false) spawns a running Task + WorkerRun via the supervisor', async () => {
    const sessionId = await insertSession('entry', ownerId, ownerId);
    const issued = await issueTestHandle(sessionId, entryScope());
    const supervisorClient = new FakeTaskSupervisorClient();

    const result = await invokeWorker(
      workspaceId,
      { principalId: ownerId, channel: 'handle', claims: claimsFromIssued(issued) },
      { definitionId: workerDefinitionId, version: 1, input: { foo: 'bar' }, wait: false },
      deps(supervisorClient),
    );

    expect(result.status).toBe('running');
    expect(supervisorClient.spawnCalls).toHaveLength(1);
    expect(supervisorClient.spawnCalls[0]?.workspaceId).toBe(workspaceId);

    const task = await inTx(ownerId, (client) => readTaskRow(client, workspaceId, result.taskId));
    expect(task?.status).toBe('running');
    const workerRun = await inTx(ownerId, (client) =>
      readWorkerRunRow(client, workspaceId, result.workerRunId),
    );
    expect(workerRun?.status).toBe('running');
    expect(workerRun?.depth).toBe(1);
    expect(workerRun?.activityId).not.toBeNull();
  });

  it('rejects the 4th derivation level with a readable depth_exceeded error — S2.7 acceptance', async () => {
    // Seed a WorkerRun already at depth 3 (the platform ceiling) with its own session/Handle —
    // invoking from it would derive depth 4.
    const deepSessionId = await insertSession('worker_run', ownerId, ownerId);
    const deepHandle = await issueTestHandle(deepSessionId, {
      capabilities: ['get_object', 'invoke_worker'],
      resources: {},
    });
    const taskId = await inTx(ownerId, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into tasks (workspace_id, status, on_behalf_of, worker_definition_id, worker_definition_version)
         values ($1, 'running', $2, $3, 1) returning id`,
        [workspaceId, ownerId, workerDefinitionId],
      );
      return result.rows[0]?.id as string;
    });
    await inTx(ownerId, (client) =>
      client.query(
        `insert into worker_runs (workspace_id, status, task_id, session_id, depth, attempt)
         values ($1, 'running', $2, $3, 3, 1)`,
        [workspaceId, taskId, deepSessionId],
      ),
    );

    const supervisorClient = new FakeTaskSupervisorClient();
    const err = await invokeWorker(
      workspaceId,
      { principalId: ownerId, channel: 'handle', claims: claimsFromIssued(deepHandle) },
      { definitionId: workerDefinitionId, version: 1, input: {}, wait: false },
      deps(supervisorClient),
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(QuotaExceededError);
    expect((err as InstanceType<typeof QuotaExceededError>).code).toBe('depth_exceeded');
    expect((err as Error).message).toMatch(/depth/i);
    expect(supervisorClient.spawnCalls).toHaveLength(0);
  });

  // P2-6 fix (review job 652a4abc: "quota checks in separate txns, no lock → concurrent invokes
  // exceed maxConcurrentWorkerRunsPerUser"). A fresh principal (not ownerId, which accumulates
  // running Tasks across this whole suite) seeded to exactly one below the default concurrency
  // limit (5) — two truly concurrent invoke_worker calls (Promise.allSettled, not sequential
  // awaits, so the lock is actually exercised) must let exactly one through.
  it('two concurrent invoke_worker calls for the same principal at the concurrency ceiling: exactly one succeeds', async () => {
    const racerId = await adminInsertPrincipal('member', 'racer');

    await inTx(racerId, async (client) => {
      for (let i = 0; i < 4; i += 1) {
        await client.query(
          `insert into tasks (workspace_id, status, on_behalf_of, worker_definition_id, worker_definition_version)
           values ($1, 'running', $2, $3, 1)`,
          [workspaceId, racerId, workerDefinitionId],
        );
      }
    });

    const sessionId = await insertSession('entry', racerId, racerId);
    const issued = await issueTestHandle(sessionId, entryScope());
    const supervisorClient = new FakeTaskSupervisorClient();
    const runtimeDeps = deps(supervisorClient);
    const caller = {
      principalId: racerId,
      channel: 'handle' as const,
      claims: claimsFromIssued(issued),
    };

    const [first, second] = await Promise.allSettled([
      invokeWorker(
        workspaceId,
        caller,
        { definitionId: workerDefinitionId, version: 1, input: {}, wait: false },
        runtimeDeps,
      ),
      invokeWorker(
        workspaceId,
        caller,
        { definitionId: workerDefinitionId, version: 1, input: {}, wait: false },
        runtimeDeps,
      ),
    ]);

    const outcomes = [first, second];
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((fulfilled[0] as PromiseFulfilledResult<unknown>).value).toMatchObject({
      status: 'running',
    });
    const rejectionReason = (rejected[0] as PromiseRejectedResult).reason;
    expect(rejectionReason).toBeInstanceOf(QuotaExceededError);
    expect((rejectionReason as InstanceType<typeof QuotaExceededError>).code).toBe(
      'concurrency_exceeded',
    );
    expect(supervisorClient.spawnCalls).toHaveLength(1); // only the winner ever spawned

    const finalCount = await inTx(racerId, (client) =>
      client.query<{ count: string }>(
        `select count(*)::int as count from tasks
         where workspace_id = $1 and on_behalf_of = $2 and status in ('queued', 'running', 'waiting_approval')`,
        [workspaceId, racerId],
      ),
    );
    expect(Number(finalCount.rows[0]?.count)).toBe(5); // never exceeds the default limit
  });

  it('入口 Handle 请求含 execute 的子 Handle 被拒 — attenuation rejection, no Task row left running', async () => {
    const definition = await publishWorkerDef({
      systemPrompt: 'You are an execute-needing worker.',
      capabilities: ['get_object', '<gate>.<op>:execute'],
      gates: ['gk-needs-grant'],
    });
    const sessionId = await insertSession('entry', ownerId, ownerId);
    const issued = await issueTestHandle(sessionId, entryScope()); // never holds execute-class caps

    const supervisorClient = new FakeTaskSupervisorClient();
    await expect(
      invokeWorker(
        workspaceId,
        { principalId: ownerId, channel: 'handle', claims: claimsFromIssued(issued) },
        { definitionId: definition.id, version: definition.version, input: {}, wait: false },
        deps(supervisorClient),
      ),
    ).rejects.toThrow(InvokeWorkerAttenuationError);

    expect(supervisorClient.spawnCalls).toHaveLength(0);
  });

  it('wait=true returns {taskId, status} on timeout instead of hanging', async () => {
    const sessionId = await insertSession('entry', ownerId, ownerId);
    const issued = await issueTestHandle(sessionId, entryScope());
    const supervisorClient = new FakeTaskSupervisorClient(); // status stays 'running' forever

    let clockMs = 0;
    const result = await invokeWorker(
      workspaceId,
      { principalId: ownerId, channel: 'handle', claims: claimsFromIssued(issued) },
      { definitionId: workerDefinitionId, version: 1, input: {}, wait: true, timeout: 1 },
      deps(supervisorClient, {
        now: () => new Date(clockMs),
        sleep: async (ms: number) => {
          clockMs += ms;
        },
      }),
    );

    expect(result.taskId).toBeDefined();
    expect(result.workerRunId).toBeDefined();
    expect(result.status).toBe('running');
  });

  it('requeues once on a non-zero exit, then fails the Task on a second failure', async () => {
    const sessionId = await insertSession('entry', ownerId, ownerId);
    const issued = await issueTestHandle(sessionId, entryScope());
    const supervisorClient = new FakeTaskSupervisorClient();
    const runtimeDeps = deps(supervisorClient);

    const spawnResult = await invokeWorker(
      workspaceId,
      { principalId: ownerId, channel: 'handle', claims: claimsFromIssued(issued) },
      { definitionId: workerDefinitionId, version: 1, input: {}, wait: false },
      runtimeDeps,
    );
    const firstWorkerRunId = spawnResult.workerRunId;

    supervisorClient.setStatus(firstWorkerRunId, { status: 'failed', exitCode: 1 });
    await reactToSupervisorStatus(runtimeDeps, workspaceId, ownerId, firstWorkerRunId);

    const taskAfterFirstFailure = await inTx(ownerId, (client) =>
      readTaskRow(client, workspaceId, spawnResult.taskId),
    );
    expect(taskAfterFirstFailure?.status).toBe('running'); // requeued, not failed yet
    expect(taskAfterFirstFailure?.retryCount).toBe(1);
    expect(supervisorClient.spawnCalls).toHaveLength(2); // original + one requeue

    const firstRun = await inTx(ownerId, (client) =>
      readWorkerRunRow(client, workspaceId, firstWorkerRunId),
    );
    expect(firstRun?.status).toBe('terminated');

    const secondWorkerRunId = supervisorClient.spawnCalls[1]?.workerRunId as string;
    expect(secondWorkerRunId).not.toBe(firstWorkerRunId);

    // Second failure — no more retries left.
    supervisorClient.setStatus(secondWorkerRunId, { status: 'failed', exitCode: 1 });
    await reactToSupervisorStatus(runtimeDeps, workspaceId, ownerId, secondWorkerRunId);

    const taskAfterSecondFailure = await inTx(ownerId, (client) =>
      readTaskRow(client, workspaceId, spawnResult.taskId),
    );
    expect(taskAfterSecondFailure?.status).toBe('failed');
    expect(taskAfterSecondFailure?.failureReason).toBe('worker_failed');
    expect(supervisorClient.spawnCalls).toHaveLength(2); // no third spawn
  });

  // R-58 (2026-10-02 review): the crash-retry path. The reaper tick and a `wait:true` poll can react
  // to the same crash at once, and a cancel can land between a reaction's reads and its writes.
  describe('R-58 — crash-retry guards (docs/code-review-2026-10-02.md)', () => {
    async function spawnRunningTask(displayName: string) {
      const principalId = await adminInsertPrincipal('member', displayName);
      const sessionId = await insertSession('entry', principalId, principalId);
      const issued = await issueTestHandle(sessionId, entryScope());
      const supervisorClient = new FakeTaskSupervisorClient();
      const runtimeDeps = deps(supervisorClient);
      const spawnResult = await invokeWorker(
        workspaceId,
        { principalId, channel: 'handle', claims: claimsFromIssued(issued) },
        { definitionId: workerDefinitionId, version: 1, input: {}, wait: false },
        runtimeDeps,
      );
      return { principalId, supervisorClient, runtimeDeps, spawnResult };
    }

    async function workerRunCount(principalId: string, taskId: string): Promise<number> {
      return inTx(principalId, async (client) => {
        const result = await client.query<{ n: number }>(
          'select count(*)::int as n from worker_runs where workspace_id = $1 and task_id = $2',
          [workspaceId, taskId],
        );
        return result.rows[0]?.n ?? 0;
      });
    }

    /** Non-terminated WorkerRuns under the Task, with whether each one's Handle is revoked. */
    async function liveRuns(
      principalId: string,
      taskId: string,
    ): Promise<{ id: string; status: string; handleRevoked: boolean }[]> {
      return inTx(principalId, async (client) => {
        const result = await client.query<{ id: string; status: string; revoked: boolean }>(
          `select wr.id, wr.status, (h.revoked_at is not null) as revoked
             from worker_runs wr
             left join capability_handles h
               on h.workspace_id = wr.workspace_id and h.session_id = wr.session_id
            where wr.workspace_id = $1 and wr.task_id = $2 and wr.status <> 'terminated'`,
          [workspaceId, taskId],
        );
        return result.rows.map((row) => ({
          id: row.id,
          status: row.status,
          handleRevoked: row.revoked,
        }));
      });
    }

    /** A supervisor client over `inner` whose `terminate` first runs `hook` once, for `workerRunId`. */
    function terminateHooked(
      inner: FakeTaskSupervisorClient,
      workerRunId: string,
      hook: () => Promise<void>,
      order: 'before' | 'after',
    ): TaskSupervisorClientPort {
      let fired = false;
      return {
        spawn: (input) => inner.spawn(input),
        status: (id) => inner.status(id),
        terminate: async (id) => {
          if (fired || id !== workerRunId) return inner.terminate(id);
          fired = true;
          if (order === 'before') {
            await hook();
            return inner.terminate(id);
          }
          const stopped = await inner.terminate(id);
          await hook();
          return stopped;
        },
      };
    }

    it('two concurrent reactions to the same crashed WorkerRun spawn exactly one retry', async () => {
      const { principalId, supervisorClient, runtimeDeps, spawnResult } = await spawnRunningTask(
        'r58-concurrent-reactions',
      );
      supervisorClient.setStatus(spawnResult.workerRunId, { status: 'failed', exitCode: 1 });

      await Promise.all([
        reactToSupervisorStatus(runtimeDeps, workspaceId, principalId, spawnResult.workerRunId),
        reactToSupervisorStatus(runtimeDeps, workspaceId, principalId, spawnResult.workerRunId),
      ]);

      expect(supervisorClient.spawnCalls).toHaveLength(2); // the original + one retry
      const task = await inTx(principalId, (client) =>
        readTaskRow(client, workspaceId, spawnResult.taskId),
      );
      expect(task?.status).toBe('running');
      expect(task?.retryCount).toBe(1);
      expect(await workerRunCount(principalId, spawnResult.taskId)).toBe(2);
    });

    it('a reaction that reads the Task after another one claimed the retry leaves the retrying Task running', async () => {
      const { principalId, supervisorClient, runtimeDeps, spawnResult } =
        await spawnRunningTask('r58-late-task-read');
      supervisorClient.setStatus(spawnResult.workerRunId, { status: 'failed', exitCode: 1 });

      // The late reaction reads the crashed run while it is still live, then its supervisor
      // status call waits until the other reaction has finished, so it reads the Task only after
      // `retry_count` was bumped and the retry spawned. It takes the no-retry branch and must
      // leave the Task alone.
      let lateEntered!: () => void;
      const lateInStatus = new Promise<void>((resolve) => {
        lateEntered = resolve;
      });
      let releaseLate!: () => void;
      const firstDone = new Promise<void>((resolve) => {
        releaseLate = resolve;
      });
      const lateDeps = deps(supervisorClient, {
        supervisorClient: {
          spawn: (input) => supervisorClient.spawn(input),
          terminate: (id) => supervisorClient.terminate(id),
          status: async (id) => {
            lateEntered();
            await firstDone;
            return supervisorClient.status(id);
          },
        },
      });

      const late = reactToSupervisorStatus(
        lateDeps,
        workspaceId,
        principalId,
        spawnResult.workerRunId,
      );
      await lateInStatus;
      await reactToSupervisorStatus(runtimeDeps, workspaceId, principalId, spawnResult.workerRunId);
      releaseLate();
      await late;

      expect(supervisorClient.spawnCalls).toHaveLength(2); // the original + one retry
      const task = await inTx(principalId, (client) =>
        readTaskRow(client, workspaceId, spawnResult.taskId),
      );
      expect(task?.status).toBe('running');
      expect(task?.retryCount).toBe(1);
      expect(await workerRunCount(principalId, spawnResult.taskId)).toBe(2);
    });

    it('the reaper duration-limit sweep leaves a Task alone whose crash retry a poll claimed after the scan', async () => {
      const { principalId, supervisorClient, runtimeDeps, spawnResult } =
        await spawnRunningTask('r58-reaper-timeout');
      supervisorClient.setStatus(spawnResult.workerRunId, { status: 'failed', exitCode: 1 });
      // Past the duration limit, so the reaper's scan picks this run for the timeout path.
      await withAdminClient(pool, (client) =>
        client.query(
          `update worker_runs set started_at = now() - interval '2 hours'
            where workspace_id = $1 and id = $2`,
          [workspaceId, spawnResult.workerRunId],
        ),
      );
      // The reaper stops the container first; a `wait:true` poll reacts to the crash right then,
      // after the scan and before the reaper's own row writes, and claims the retry.
      const reaperDeps = deps(supervisorClient, {
        supervisorClient: terminateHooked(
          supervisorClient,
          spawnResult.workerRunId,
          () =>
            reactToSupervisorStatus(runtimeDeps, workspaceId, principalId, spawnResult.workerRunId),
          'before',
        ),
      });

      await runTaskReaper(reaperDeps);

      expect(supervisorClient.spawnCalls).toHaveLength(2); // the original + the poll's retry
      const task = await inTx(principalId, (client) =>
        readTaskRow(client, workspaceId, spawnResult.taskId),
      );
      // Before the fix: failed / timeout, with the retry still running under it on a live Handle.
      expect(task?.status).toBe('running');
      expect(task?.retryCount).toBe(1);
      const live = await liveRuns(principalId, spawnResult.taskId);
      expect(live).toHaveLength(1);
      expect(live[0]?.id).not.toBe(spawnResult.workerRunId);
      expect(live[0]?.handleRevoked).toBe(false);
    });

    it('a cancel whose sweep meets a crash reaction leaves no retry running under the cancelled Task', async () => {
      const { principalId, supervisorClient, runtimeDeps, spawnResult } =
        await spawnRunningTask('r58-cancel-vs-retry');
      supervisorClient.setStatus(spawnResult.workerRunId, { status: 'failed', exitCode: 1 });
      // The crash reaction runs while `terminateTask` is stopping the crashed run's container.
      const cancelDeps = deps(supervisorClient, {
        supervisorClient: terminateHooked(
          supervisorClient,
          spawnResult.workerRunId,
          () =>
            reactToSupervisorStatus(runtimeDeps, workspaceId, principalId, spawnResult.workerRunId),
          'before',
        ),
      });

      const { configureTaskRuntime, resetTaskRuntimeForTests } = await import('./runtime.js');
      configureTaskRuntime(cancelDeps);
      try {
        const cancelled = await terminateTask(workspaceId, principalId, spawnResult.taskId);
        expect(cancelled.status).toBe('cancelled');
      } finally {
        resetTaskRuntimeForTests();
      }

      const task = await inTx(principalId, (client) =>
        readTaskRow(client, workspaceId, spawnResult.taskId),
      );
      expect(task?.status).toBe('cancelled');
      // Before the fix: the sweep listed only the crashed run, the reaction claimed the retry and
      // spawned it, and the retry ran with a live Handle under the cancelled Task.
      expect(await liveRuns(principalId, spawnResult.taskId)).toEqual([]);
    });

    it("a reaction that sees the supervisor's terminated: requested does not turn the user's cancel into a failure", async () => {
      const { principalId, supervisorClient, runtimeDeps, spawnResult } =
        await spawnRunningTask('r58-cancel-not-failed');
      // The reaction runs right after `terminateTask` stopped the container (the supervisor now
      // reports `terminated: requested`) and before its row write.
      const cancelDeps = deps(supervisorClient, {
        supervisorClient: terminateHooked(
          supervisorClient,
          spawnResult.workerRunId,
          () =>
            reactToSupervisorStatus(runtimeDeps, workspaceId, principalId, spawnResult.workerRunId),
          'after',
        ),
      });

      const { configureTaskRuntime, resetTaskRuntimeForTests } = await import('./runtime.js');
      configureTaskRuntime(cancelDeps);
      let returned: TaskRow;
      try {
        returned = await terminateTask(workspaceId, principalId, spawnResult.taskId);
      } finally {
        resetTaskRuntimeForTests();
      }

      const task = await inTx(principalId, (client) =>
        readTaskRow(client, workspaceId, spawnResult.taskId),
      );
      // Before the fix: failed / terminated, and cancel returned that failure.
      expect(returned.status).toBe('cancelled');
      expect(task?.status).toBe('cancelled');
      expect(task?.failureReason).toBeNull();
    });

    it('spawnWorkerRun waits for a cancel in flight and refuses the cancelled Task', async () => {
      const { principalId, supervisorClient, runtimeDeps, spawnResult } =
        await spawnRunningTask('r58-spawn-for-share');
      const task = await inTx(principalId, (client) =>
        readTaskRow(client, workspaceId, spawnResult.taskId),
      );
      if (!task) throw new Error('the spawned Task was not found');

      // A cancel's UPDATE, not yet committed.
      const cancelClient = await pool.connect();
      try {
        await cancelClient.query('begin');
        await cancelClient.query(
          `update tasks set status = 'cancelled', cancelled_at = now()
            where workspace_id = $1 and id = $2`,
          [workspaceId, spawnResult.taskId],
        );

        const spawning = spawnWorkerRun(runtimeDeps, workspaceId, {
          task,
          parentWorkerRunId: null,
          depth: 1,
          attempt: 2,
          onBehalfOf: principalId,
          parentAuthority: 'unconstrained',
          parentClaimsForLineage: undefined,
          declaredCapabilities: [],
          declaredGates: [],
          definitionName: 'r58-spawn-for-share',
        });
        const outcome = spawning.then(
          () => 'spawned' as const,
          (err: unknown) => err,
        );
        // Commit the cancel once the spawn either finished (no lock: it read the stale `running`)
        // or is waiting on the Task row lock.
        for (;;) {
          const waiting = await pool.query<{ n: number }>(
            `select count(*)::int as n from pg_stat_activity
              where datname = current_database() and wait_event_type = 'Lock'`,
          );
          if ((waiting.rows[0]?.n ?? 0) > 0) break;
          const settled = await Promise.race([
            outcome.then(() => true),
            new Promise<false>((resolve) => setTimeout(() => resolve(false), 20)),
          ]);
          if (settled) break;
        }
        await cancelClient.query('commit');

        // Before the fix: the spawn read `running`, created the WorkerRun and started it under the
        // Task the cancel was about to commit.
        expect(await outcome).toBeInstanceOf(IllegalTransition);
      } finally {
        cancelClient.release();
      }
      expect(supervisorClient.spawnCalls).toHaveLength(1); // only the original
      expect(await workerRunCount(principalId, spawnResult.taskId)).toBe(1);
    });

    it('a claimed retry with no Handle to attenuate from fails the Task instead of leaving it running', async () => {
      const { principalId, supervisorClient, runtimeDeps, spawnResult } =
        await spawnRunningTask('r58-retry-no-handle');
      supervisorClient.setStatus(spawnResult.workerRunId, { status: 'failed', exitCode: 1 });
      await withAdminClient(pool, (client) =>
        client.query(
          'update worker_runs set session_id = null where workspace_id = $1 and id = $2',
          [workspaceId, spawnResult.workerRunId],
        ),
      );

      await reactToSupervisorStatus(runtimeDeps, workspaceId, principalId, spawnResult.workerRunId);

      expect(supervisorClient.spawnCalls).toHaveLength(1); // no retry spawned
      const task = await inTx(principalId, (client) =>
        readTaskRow(client, workspaceId, spawnResult.taskId),
      );
      // Before the fix: running, retry_count 1, with no live WorkerRun, forever.
      expect(task?.status).toBe('failed');
      expect(task?.failureReason).toBe('worker_failed');
      expect(await liveRuns(principalId, spawnResult.taskId)).toEqual([]);
    });

    it('a crash reaction under a Task cancelled meanwhile spawns no retry', async () => {
      const { principalId, supervisorClient, runtimeDeps, spawnResult } =
        await spawnRunningTask('r58-cancelled-meanwhile');
      supervisorClient.setStatus(spawnResult.workerRunId, { status: 'failed', exitCode: 1 });
      // The cancel's Task write landing before the reaction's own writes — set directly so the
      // crashed run is still live when the reaction gets to it (a full `terminateTask` would
      // terminate the run first, and the reaction would then have nothing to do).
      await inTx(principalId, (client) =>
        client.query(
          `update tasks set status = 'cancelled', cancelled_at = now()
           where workspace_id = $1 and id = $2`,
          [workspaceId, spawnResult.taskId],
        ),
      );

      await reactToSupervisorStatus(runtimeDeps, workspaceId, principalId, spawnResult.workerRunId);

      expect(supervisorClient.spawnCalls).toHaveLength(1); // no retry
      const task = await inTx(principalId, (client) =>
        readTaskRow(client, workspaceId, spawnResult.taskId),
      );
      expect(task?.status).toBe('cancelled');
      expect(task?.retryCount).toBe(0);
      const run = await inTx(principalId, (client) =>
        readWorkerRunRow(client, workspaceId, spawnResult.workerRunId),
      );
      expect(run?.status).toBe('terminated');
    });

    it('spawnWorkerRun refuses a terminal Task before creating a WorkerRun or calling the supervisor', async () => {
      const principalId = await adminInsertPrincipal('member', 'r58-spawn-terminal');
      const supervisorClient = new FakeTaskSupervisorClient();
      const taskId = randomUUID();
      await inTx(principalId, (client) =>
        client.query(
          `insert into tasks (
             workspace_id, id, status, on_behalf_of, worker_definition_id,
             worker_definition_version, cancelled_at
           ) values ($1, $2, 'cancelled', $3, $4, 1, now())`,
          [workspaceId, taskId, principalId, workerDefinitionId],
        ),
      );
      const task = await inTx(principalId, (client) => readTaskRow(client, workspaceId, taskId));
      if (!task) throw new Error('the seeded Task was not found');

      await expect(
        spawnWorkerRun(deps(supervisorClient), workspaceId, {
          task,
          parentWorkerRunId: null,
          depth: 1,
          attempt: 2,
          onBehalfOf: principalId,
          parentAuthority: 'unconstrained',
          parentClaimsForLineage: undefined,
          declaredCapabilities: [],
          declaredGates: [],
          definitionName: 'r58-spawn-terminal',
        }),
      ).rejects.toBeInstanceOf(IllegalTransition);

      expect(supervisorClient.spawnCalls).toHaveLength(0);
      expect(await workerRunCount(principalId, taskId)).toBe(0);
    });
  });

  it('an exited (code 0) container without a posted result marks the Task failed: no_result', async () => {
    const sessionId = await insertSession('entry', ownerId, ownerId);
    const issued = await issueTestHandle(sessionId, entryScope());
    const supervisorClient = new FakeTaskSupervisorClient();
    const runtimeDeps = deps(supervisorClient);

    const spawnResult = await invokeWorker(
      workspaceId,
      { principalId: ownerId, channel: 'handle', claims: claimsFromIssued(issued) },
      { definitionId: workerDefinitionId, version: 1, input: {}, wait: false },
      runtimeDeps,
    );

    supervisorClient.setStatus(spawnResult.workerRunId, { status: 'exited', exitCode: 0 });
    await reactToSupervisorStatus(runtimeDeps, workspaceId, ownerId, spawnResult.workerRunId);

    const task = await inTx(ownerId, (client) =>
      readTaskRow(client, workspaceId, spawnResult.taskId),
    );
    expect(task?.status).toBe('failed');
    expect(task?.failureReason).toBe('no_result');
  });

  // P1-6 fix (review job 652a4abc): a Task `waiting_approval` on an ActionRequest decision whose
  // WorkerRun then dies previously stayed `waiting_approval` forever on an `exited` status (the
  // check was `task.status === 'running'` only) — a later `ActionRequestUpdated` would try to
  // `task.resume` a Task with no live WorkerRun to resume into (the P1-2 dead state).
  it('an exited (code 0) container while the Task is waiting_approval also marks it failed: no_result', async () => {
    const sessionId = await insertSession('entry', ownerId, ownerId);
    const issued = await issueTestHandle(sessionId, entryScope());
    const supervisorClient = new FakeTaskSupervisorClient();
    const runtimeDeps = deps(supervisorClient);

    const spawnResult = await invokeWorker(
      workspaceId,
      { principalId: ownerId, channel: 'handle', claims: claimsFromIssued(issued) },
      { definitionId: workerDefinitionId, version: 1, input: {}, wait: false },
      runtimeDeps,
    );

    await inTx(ownerId, (client) =>
      client.query(
        "update tasks set status = 'waiting_approval' where workspace_id = $1 and id = $2",
        [workspaceId, spawnResult.taskId],
      ),
    );

    supervisorClient.setStatus(spawnResult.workerRunId, { status: 'exited', exitCode: 0 });
    await reactToSupervisorStatus(runtimeDeps, workspaceId, ownerId, spawnResult.workerRunId);

    const task = await inTx(ownerId, (client) =>
      readTaskRow(client, workspaceId, spawnResult.taskId),
    );
    expect(task?.status).toBe('failed');
    expect(task?.failureReason).toBe('no_result');
  });

  // P1-6 fix, same root cause as above but the `failed` (non-zero exit) branch: previously this
  // would spend the Task's one retry on a *fresh* WorkerRun that the outstanding ActionRequest's
  // `parent_worker_run_id` does not point to — a later approval could never resume the right run.
  it('a non-zero exit while the Task is waiting_approval fails it directly, without requeuing', async () => {
    const sessionId = await insertSession('entry', ownerId, ownerId);
    const issued = await issueTestHandle(sessionId, entryScope());
    const supervisorClient = new FakeTaskSupervisorClient();
    const runtimeDeps = deps(supervisorClient);

    const spawnResult = await invokeWorker(
      workspaceId,
      { principalId: ownerId, channel: 'handle', claims: claimsFromIssued(issued) },
      { definitionId: workerDefinitionId, version: 1, input: {}, wait: false },
      runtimeDeps,
    );

    await inTx(ownerId, (client) =>
      client.query(
        "update tasks set status = 'waiting_approval' where workspace_id = $1 and id = $2",
        [workspaceId, spawnResult.taskId],
      ),
    );

    supervisorClient.setStatus(spawnResult.workerRunId, { status: 'failed', exitCode: 1 });
    await reactToSupervisorStatus(runtimeDeps, workspaceId, ownerId, spawnResult.workerRunId);

    const task = await inTx(ownerId, (client) =>
      readTaskRow(client, workspaceId, spawnResult.taskId),
    );
    expect(task?.status).toBe('failed');
    expect(task?.failureReason).toBe('worker_failed');
    expect(supervisorClient.spawnCalls).toHaveLength(1); // no requeue attempt
  });

  it('terminateTask revokes the WorkerRun Handle (capability_handles.revoked_at set)', async () => {
    const sessionId = await insertSession('entry', ownerId, ownerId);
    const issued = await issueTestHandle(sessionId, entryScope());
    const supervisorClient = new FakeTaskSupervisorClient();
    const runtimeDeps = deps(supervisorClient);

    const { configureTaskRuntime, resetTaskRuntimeForTests } = await import('./runtime.js');
    configureTaskRuntime(runtimeDeps);
    try {
      const spawnResult = await invokeWorker(
        workspaceId,
        { principalId: ownerId, channel: 'handle', claims: claimsFromIssued(issued) },
        { definitionId: workerDefinitionId, version: 1, input: {}, wait: false },
        runtimeDeps,
      );

      const workerRunBefore = await inTx(ownerId, (client) =>
        readWorkerRunRow(client, workspaceId, spawnResult.workerRunId),
      );
      const childSessionId = workerRunBefore?.sessionId as string;

      const cancelled = await terminateTask(workspaceId, ownerId, spawnResult.taskId);
      expect(cancelled.status).toBe('cancelled');
      expect(supervisorClient.terminated).toContain(spawnResult.workerRunId);

      const revokedAt = await inTx(ownerId, async (client) => {
        const result = await client.query<{ revoked_at: Date | null }>(
          'select revoked_at from capability_handles where session_id = $1',
          [childSessionId],
        );
        return result.rows[0]?.revoked_at ?? null;
      });
      expect(revokedAt).not.toBeNull();

      const workerRunAfter = await inTx(ownerId, (client) =>
        readWorkerRunRow(client, workspaceId, spawnResult.workerRunId),
      );
      expect(workerRunAfter?.status).toBe('terminated');
    } finally {
      resetTaskRuntimeForTests();
    }
  });

  /** `RacingSupervisorClient.spawn` deterministically injects a concurrent `terminateTask`
   *  (`cancel_task`) call exactly inside the window both `invokeWorkerCreate`'s own guarded Task
   *  UPDATEs (leftover 67) *and* `spawnWorkerRun`'s own guarded WorkerRun UPDATEs (leftover 90,
   *  `spawn.ts`) are meant to close — between the Task's own INSERT (`queued`)/the WorkerRun's own
   *  INSERT (`provisioning`) and any of their respective follow-up UPDATEs. This mirrors
   *  `lifecycle.test.ts`'s own "no real race needed" convention (scripting the exact interleaving
   *  deterministically rather than relying on real concurrency timing) while still exercising the
   *  real, unmodified `terminateTask`/`invokeWorkerCreate`/`spawnWorkerRun` code paths end to end
   *  against real Postgres. Declared here, at the outer `describe`'s own scope (not nested inside
   *  the "leftover 67" block below), so the "leftover 90" block further down can reuse it against
   *  the exact same race window without re-deriving it. */
  class RacingSupervisorClient extends FakeTaskSupervisorClient {
    capturedTaskId: string | undefined;
    capturedWorkerRunId: string | undefined;
    private readonly failSpawn: boolean;
    constructor(failSpawn: boolean) {
      super();
      this.failSpawn = failSpawn;
    }
    override async spawn(input: TaskSpawnInput): Promise<TaskSpawnOutcome> {
      this.capturedTaskId = input.taskId;
      this.capturedWorkerRunId = input.workerRunId;
      // The WorkerRun row (+ its Handle) already exists by this point — `spawnWorkerRun`
      // (spawn.ts) creates and commits it *before* calling this method — so `terminateTask`'s own
      // "terminate every non-terminated WorkerRun under the Task" sweep finds and terminates it.
      await terminateTask(workspaceId, ownerId, input.taskId);
      if (this.failSpawn) throw new Error('supervisor unreachable (simulated race)');
      return super.spawn(input);
    }
  }

  describe('leftover 67 — status-guarded Task UPDATEs (docs/STATUS.md §4)', () => {
    it('a Task cancelled while spawnWorkerRun is in flight is not reverted to running by the guarded queued -> running UPDATE', async () => {
      const sessionId = await insertSession('entry', ownerId, ownerId);
      const issued = await issueTestHandle(sessionId, entryScope());
      const supervisorClient = new RacingSupervisorClient(false);
      const runtimeDeps = deps(supervisorClient);

      const { configureTaskRuntime, resetTaskRuntimeForTests } = await import('./runtime.js');
      configureTaskRuntime(runtimeDeps);
      try {
        await invokeWorker(
          workspaceId,
          { principalId: ownerId, channel: 'handle', claims: claimsFromIssued(issued) },
          { definitionId: workerDefinitionId, version: 1, input: {}, wait: false },
          runtimeDeps,
        );

        const taskId = supervisorClient.capturedTaskId as string;
        const task = await inTx(ownerId, (client) => readTaskRow(client, workspaceId, taskId));
        // Before the fix: the unconditional `update tasks set status = 'running' ...` would have
        // silently reverted the just-cancelled Task back to `running`.
        expect(task?.status).toBe('cancelled');
      } finally {
        resetTaskRuntimeForTests();
      }
    });

    it('a Task cancelled while spawnWorkerRun fails is not overwritten by the guarded queued -> failed:spawn_failed UPDATE', async () => {
      const sessionId = await insertSession('entry', ownerId, ownerId);
      const issued = await issueTestHandle(sessionId, entryScope());
      const supervisorClient = new RacingSupervisorClient(true);
      const runtimeDeps = deps(supervisorClient);

      const { configureTaskRuntime, resetTaskRuntimeForTests } = await import('./runtime.js');
      configureTaskRuntime(runtimeDeps);
      try {
        await expect(
          invokeWorker(
            workspaceId,
            { principalId: ownerId, channel: 'handle', claims: claimsFromIssued(issued) },
            { definitionId: workerDefinitionId, version: 1, input: {}, wait: false },
            runtimeDeps,
          ),
        ).rejects.toThrow();

        const taskId = supervisorClient.capturedTaskId as string;
        const task = await inTx(ownerId, (client) => readTaskRow(client, workspaceId, taskId));
        // Before the fix: the unconditional `update tasks set status = 'failed', failure_reason =
        // 'spawn_failed' ...` would have silently overwritten the just-cancelled Task.
        expect(task?.status).toBe('cancelled');
        expect(task?.failureReason).not.toBe('spawn_failed');
      } finally {
        resetTaskRuntimeForTests();
      }
    });

    it('terminateTask does not revert a Task that completes concurrently while its own cancellation is in flight', async () => {
      const sessionId = await insertSession('entry', ownerId, ownerId);
      const issued = await issueTestHandle(sessionId, entryScope());
      const supervisorClient = new FakeTaskSupervisorClient();
      const runtimeDeps = deps(supervisorClient);

      const spawnResult = await invokeWorker(
        workspaceId,
        { principalId: ownerId, channel: 'handle', claims: claimsFromIssued(issued) },
        { definitionId: workerDefinitionId, version: 1, input: {}, wait: false },
        runtimeDeps,
      );

      // Simulate a Worker's real `report_task_result` landing — via the real, unmodified
      // `completeTaskWithResult` — inside `terminateTask`'s own cancel transaction, after it read
      // the Task and right before its guarded UPDATE, deterministic same as
      // `RacingSupervisorClient` above. `terminateTask` decides the Task before it reaps the runs
      // (#534), so the completion is injected at the cancel UPDATE itself rather than from the
      // supervisor `.terminate` call, which now runs after the cancel has committed.
      let completed = false;
      const pooledCompletingBeforeCancel: PoolLike = {
        async connect() {
          const client = await pool.connect();
          const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
          (client as { query: unknown }).query = async (...args: unknown[]) => {
            const text = args[0];
            if (
              !completed &&
              typeof text === 'string' &&
              text.includes("update tasks set status = 'cancelled'")
            ) {
              completed = true;
              await inTx(ownerId, (other) =>
                completeTaskWithResult(
                  other,
                  workspaceId,
                  ownerId,
                  spawnResult.taskId,
                  spawnResult.workerRunId,
                  { summary: 'completed concurrently with cancellation' },
                ),
              );
            }
            return query(...args);
          };
          const release = client.release.bind(client);
          client.release = (err?: Error | boolean) => {
            (client as { query: unknown }).query = query;
            client.release = release;
            return release(err);
          };
          return client;
        },
      };
      const racingDeps = deps(supervisorClient, { pool: pooledCompletingBeforeCancel });

      const { configureTaskRuntime, resetTaskRuntimeForTests } = await import('./runtime.js');
      configureTaskRuntime(racingDeps);
      try {
        const cancelled = await terminateTask(workspaceId, ownerId, spawnResult.taskId);
        // Before the fix: the unconditional `update tasks set status = 'cancelled' ...` would have
        // silently reverted the just-completed Task back to `cancelled`.
        expect(completed).toBe(true);
        expect(cancelled.status).toBe('completed');

        const task = await inTx(ownerId, (client) =>
          readTaskRow(client, workspaceId, spawnResult.taskId),
        );
        expect(task?.status).toBe('completed');
      } finally {
        resetTaskRuntimeForTests();
      }
    });
  });

  describe('leftover 90 — status-guarded WorkerRun UPDATEs in spawnWorkerRun (docs/STATUS.md §4)', () => {
    it('a WorkerRun terminated while spawnWorkerRun is in flight is not reverted to running by the guarded provisioning -> running UPDATE, and the orphaned container is best-effort stopped', async () => {
      const sessionId = await insertSession('entry', ownerId, ownerId);
      const issued = await issueTestHandle(sessionId, entryScope());
      const supervisorClient = new RacingSupervisorClient(false);
      const runtimeDeps = deps(supervisorClient);

      const { configureTaskRuntime, resetTaskRuntimeForTests } = await import('./runtime.js');
      configureTaskRuntime(runtimeDeps);
      try {
        // Does not throw — `spawnWorkerRun` never surfaces a lost running-write race as an error
        // (see that function's own doc comment: the run reached `terminated` through a legitimate
        // concurrent cancel, not a spawn failure).
        await invokeWorker(
          workspaceId,
          { principalId: ownerId, channel: 'handle', claims: claimsFromIssued(issued) },
          { definitionId: workerDefinitionId, version: 1, input: {}, wait: false },
          runtimeDeps,
        );

        const workerRunId = supervisorClient.capturedWorkerRunId as string;
        const workerRun = await inTx(ownerId, (client) =>
          readWorkerRunRow(client, workspaceId, workerRunId),
        );
        // Before the fix: the unconditional `update worker_runs set status = 'running', ...` would
        // have silently reverted the just-terminated WorkerRun back to `running`.
        expect(workerRun?.status).toBe('terminated');

        const transitions = await inTx(ownerId, (client) =>
          client.query<{ action: string }>(
            `select action from audit_records
             where workspace_id = $1 and resource_type = 'worker_run' and resource_id = $2`,
            [workspaceId, workerRunId],
          ),
        );
        // No `worker_run.start` transition was ever recorded for a WorkerRun that never actually
        // reached `running` — only `terminateTask`'s own sweep (`worker_run.provision` +
        // `worker_run.terminate`) touched this row.
        expect(transitions.rows.map((r) => r.action)).not.toContain('worker_run.start');

        // The freshly spawned container is orphaned (the row it belongs to is already terminal) —
        // `spawnWorkerRun`'s lost-race branch best-effort stops it through the same supervisor
        // client, in addition to `terminateTask`'s own earlier (pre-spawn-confirmation) stop
        // attempt — at least two `.terminate()` calls for this workerRunId.
        expect(
          supervisorClient.terminated.filter((id) => id === workerRunId).length,
        ).toBeGreaterThanOrEqual(2);
      } finally {
        resetTaskRuntimeForTests();
      }
    });

    it('a spawn failure on a WorkerRun already terminated concurrently does not write a second worker_run.spawn_failed transition, and the original error still propagates', async () => {
      const sessionId = await insertSession('entry', ownerId, ownerId);
      const issued = await issueTestHandle(sessionId, entryScope());
      const supervisorClient = new RacingSupervisorClient(true);
      const runtimeDeps = deps(supervisorClient);

      const { configureTaskRuntime, resetTaskRuntimeForTests } = await import('./runtime.js');
      configureTaskRuntime(runtimeDeps);
      try {
        await expect(
          invokeWorker(
            workspaceId,
            { principalId: ownerId, channel: 'handle', claims: claimsFromIssued(issued) },
            { definitionId: workerDefinitionId, version: 1, input: {}, wait: false },
            runtimeDeps,
          ),
        ).rejects.toThrow('supervisor unreachable (simulated race)');

        const workerRunId = supervisorClient.capturedWorkerRunId as string;
        const workerRun = await inTx(ownerId, (client) =>
          readWorkerRunRow(client, workspaceId, workerRunId),
        );
        // Already `terminated` — via `terminateTask`'s own sweep, not this catch block's write.
        expect(workerRun?.status).toBe('terminated');

        const transitions = await inTx(ownerId, (client) =>
          client.query<{ action: string }>(
            `select action from audit_records
             where workspace_id = $1 and resource_type = 'worker_run' and resource_id = $2`,
            [workspaceId, workerRunId],
          ),
        );
        const actions = transitions.rows.map((r) => r.action);
        // `terminateTask`'s own sweep already recorded the one legitimate `worker_run.terminate`
        // transition — before the fix, the catch block's unconditional UPDATE would have written a
        // second, misleading `worker_run.spawn_failed` transition over the same already-terminal row.
        expect(actions).toContain('worker_run.terminate');
        expect(actions).not.toContain('worker_run.spawn_failed');
      } finally {
        resetTaskRuntimeForTests();
      }
    });
  });

  describe('R-09 — a failed spawn and the spawn_lost sweep reap the WorkerRun (docs/code-review-2026-10-02.md)', () => {
    /** The kernel's supervisor client gives up (`TaskSupervisorError('timeout')`, its own 30 s
     *  timeout) while worker-supervisor, which already received the request, still creates and
     *  starts the container — so the fake records that container as `running` before the client
     *  throws. The first `successfulSpawns` spawns answer normally (the requeue case). */
    class TimingOutSupervisorClient extends FakeTaskSupervisorClient {
      private successfulSpawns: number;
      constructor(successfulSpawns = 0) {
        super();
        this.successfulSpawns = successfulSpawns;
      }
      override async spawn(input: TaskSpawnInput): Promise<TaskSpawnOutcome> {
        const outcome = await super.spawn(input);
        if (this.successfulSpawns > 0) {
          this.successfulSpawns -= 1;
          return outcome;
        }
        throw new TaskSupervisorError(
          'timeout',
          'worker-supervisor request to /task/spawn timed out (simulated)',
        );
      }
    }

    /** A fresh principal per case: `ownerId` accumulates active Tasks across this file and would
     *  hit the per-user concurrency quota (5) — see the P-A2 block below. */
    async function freshPrincipal(displayName: string): Promise<string> {
      return adminInsertPrincipal('member', displayName);
    }

    async function handleRevokedAt(principalId: string, workerRunId: string): Promise<unknown> {
      return withWorkspace(pool, { workspaceId, principalId }, async (client) => {
        const run = await readWorkerRunRow(client, workspaceId, workerRunId);
        const result = await client.query<{ revoked_at: Date | null }>(
          'select revoked_at from capability_handles where workspace_id = $1 and session_id = $2',
          [workspaceId, run?.sessionId],
        );
        // `undefined` (no Handle row at all) must fail the callers' assertions, not pass them.
        return result.rows.length === 1 ? result.rows[0]?.revoked_at : undefined;
      });
    }

    /** The state a kernel crash between `spawnWorkerRun` committing the WorkerRun `running` and
     *  `invokeWorkerCreate`'s own `queued -> running` Task flip leaves behind (L3-4): the Task is
     *  still `queued` — backdated past the sweep's 60 s threshold — while its WorkerRun is
     *  `running` with a live Handle and the supervisor reports the container running. Built from
     *  the real `spawnWorkerRun`, so the run, its Handle and the supervisor call are the ones the
     *  crashed kernel would have produced. */
    async function seedSpawnLostTask(
      principalId: string,
      runtimeDeps: TaskRuntimeDeps,
    ): Promise<{ taskId: string; workerRunId: string }> {
      const taskId = randomUUID();
      const staleAt = new Date(Date.now() - 90 * 1000);
      await withWorkspace(pool, { workspaceId, principalId }, (client) =>
        client.query(
          `insert into tasks (
             workspace_id, id, status, on_behalf_of, worker_definition_id,
             worker_definition_version, created_at, updated_at
           ) values ($1, $2, 'queued', $3, $4, 1, $5, $5)`,
          [workspaceId, taskId, principalId, workerDefinitionId, staleAt],
        ),
      );
      const task = await withWorkspace(pool, { workspaceId, principalId }, (client) =>
        readTaskRow(client, workspaceId, taskId),
      );
      if (!task) throw new Error('seedSpawnLostTask: the seeded Task was not found');
      const workerRun = await spawnWorkerRun(runtimeDeps, workspaceId, {
        task,
        parentWorkerRunId: null,
        depth: 1,
        attempt: 1,
        onBehalfOf: principalId,
        parentAuthority: 'unconstrained',
        parentClaimsForLineage: undefined,
        declaredCapabilities: [],
        declaredGates: [],
        definitionName: 'r09-spawn-lost',
      });
      expect(workerRun.status).toBe('running');
      return { taskId, workerRunId: workerRun.id };
    }

    it('a spawn whose supervisor call times out leaves the WorkerRun terminated, its Handle revoked, and asks the supervisor to terminate it', async () => {
      const principalId = await freshPrincipal('r09-spawn-timeout');
      const sessionId = await insertSession('entry', principalId, principalId);
      const issued = await issueTestHandle(sessionId, entryScope());
      const supervisorClient = new TimingOutSupervisorClient();

      await expect(
        invokeWorker(
          workspaceId,
          { principalId, channel: 'handle', claims: claimsFromIssued(issued) },
          { definitionId: workerDefinitionId, version: 1, input: {}, wait: false },
          deps(supervisorClient),
        ),
      ).rejects.toThrow(TaskSupervisorError);

      expect(supervisorClient.spawnCalls).toHaveLength(1);
      const taskId = supervisorClient.spawnCalls[0]?.taskId as string;
      const workerRunId = supervisorClient.spawnCalls[0]?.workerRunId as string;

      const task = await withWorkspace(pool, { workspaceId, principalId }, (client) =>
        readTaskRow(client, workspaceId, taskId),
      );
      expect(task?.status).toBe('failed');
      expect(task?.failureReason).toBe('spawn_failed');

      const workerRun = await withWorkspace(pool, { workspaceId, principalId }, (client) =>
        readWorkerRunRow(client, workspaceId, workerRunId),
      );
      expect(workerRun?.status).toBe('terminated');
      // Before the fix: the run was `terminated` but its Handle stayed live until its ttl.
      expect(await handleRevokedAt(principalId, workerRunId)).toBeInstanceOf(Date);
      // The container worker-supervisor started after the client gave up is asked to stop.
      expect(supervisorClient.terminated).toContain(workerRunId);
      expect((await supervisorClient.status(workerRunId))?.status).toBe('terminated');
    });

    it('a requeue whose spawn times out reaps the retry WorkerRun the same way (Task failed: worker_failed)', async () => {
      const principalId = await freshPrincipal('r09-requeue-timeout');
      const sessionId = await insertSession('entry', principalId, principalId);
      const issued = await issueTestHandle(sessionId, entryScope());
      const supervisorClient = new TimingOutSupervisorClient(1); // the original spawn answers
      const runtimeDeps = deps(supervisorClient);

      const spawnResult = await invokeWorker(
        workspaceId,
        { principalId, channel: 'handle', claims: claimsFromIssued(issued) },
        { definitionId: workerDefinitionId, version: 1, input: {}, wait: false },
        runtimeDeps,
      );
      supervisorClient.setStatus(spawnResult.workerRunId, { status: 'failed', exitCode: 1 });
      await reactToSupervisorStatus(runtimeDeps, workspaceId, principalId, spawnResult.workerRunId);

      expect(supervisorClient.spawnCalls).toHaveLength(2); // original + the timed-out requeue
      const retryWorkerRunId = supervisorClient.spawnCalls[1]?.workerRunId as string;

      const task = await withWorkspace(pool, { workspaceId, principalId }, (client) =>
        readTaskRow(client, workspaceId, spawnResult.taskId),
      );
      expect(task?.status).toBe('failed');
      expect(task?.failureReason).toBe('worker_failed');

      const retryRun = await withWorkspace(pool, { workspaceId, principalId }, (client) =>
        readWorkerRunRow(client, workspaceId, retryWorkerRunId),
      );
      expect(retryRun?.status).toBe('terminated');
      expect(await handleRevokedAt(principalId, retryWorkerRunId)).toBeInstanceOf(Date);
      expect(supervisorClient.terminated).toContain(retryWorkerRunId);
    });

    it('the spawn_lost sweep reaps the WorkerRun a crashed kernel left running: run terminated, Handle revoked, container terminated', async () => {
      const principalId = await freshPrincipal('r09-spawn-lost');
      const supervisorClient = new FakeTaskSupervisorClient();
      const runtimeDeps = deps(supervisorClient);
      const { taskId, workerRunId } = await seedSpawnLostTask(principalId, runtimeDeps);
      expect(await handleRevokedAt(principalId, workerRunId)).toBeNull(); // live before the sweep

      // Cross-workspace, like production: it may also touch rows other cases left behind — the
      // assertions below are about this case's own Task and WorkerRun only.
      const result = await runTaskReaper(runtimeDeps);
      expect(result.spawnLost).toBeGreaterThanOrEqual(1);

      const task = await withWorkspace(pool, { workspaceId, principalId }, (client) =>
        readTaskRow(client, workspaceId, taskId),
      );
      expect(task?.status).toBe('failed');
      expect(task?.failureReason).toBe('spawn_lost');

      const workerRun = await withWorkspace(pool, { workspaceId, principalId }, (client) =>
        readWorkerRunRow(client, workspaceId, workerRunId),
      );
      // Before the fix: still `running` with a live Handle under a `failed: spawn_lost` Task, until
      // the duration-limit scan reached it (default 3600 s).
      expect(workerRun?.status).toBe('terminated');
      expect(await handleRevokedAt(principalId, workerRunId)).toBeInstanceOf(Date);
      expect(supervisorClient.terminated).toContain(workerRunId);
      expect((await supervisorClient.status(workerRunId))?.status).toBe('terminated');
    });

    it('failTaskAndReapWorkerRuns is idempotent: a second call changes nothing, even when the supervisor terminate throws', async () => {
      const principalId = await freshPrincipal('r09-idempotent');
      const supervisorClient = new FakeTaskSupervisorClient();
      const runtimeDeps = deps(supervisorClient);
      const { taskId, workerRunId } = await seedSpawnLostTask(principalId, runtimeDeps);

      async function snapshot() {
        return withWorkspace(pool, { workspaceId, principalId }, async (client) => {
          const task = await readTaskRow(client, workspaceId, taskId);
          const run = await readWorkerRunRow(client, workspaceId, workerRunId);
          const handles = await client.query<{ revoked_at: Date | null }>(
            'select revoked_at from capability_handles where workspace_id = $1 and session_id = $2',
            [workspaceId, run?.sessionId],
          );
          const audit = await client.query<{ resource_type: string; action: string }>(
            `select resource_type, action from audit_records
             where workspace_id = $1 and resource_id in ($2, $3)
             order by resource_type, action`,
            [workspaceId, taskId, workerRunId],
          );
          return {
            task: {
              status: task?.status,
              failureReason: task?.failureReason,
              failedAt: task?.failedAt?.toISOString(),
            },
            run: { status: run?.status, terminatedAt: run?.terminatedAt?.toISOString() },
            revokedAt: handles.rows.map((row) => row.revoked_at?.toISOString() ?? null),
            audit: audit.rows,
          };
        });
      }

      await failTaskAndReapWorkerRuns(runtimeDeps, workspaceId, principalId, taskId, 'spawn_lost');
      const first = await snapshot();
      expect(first.task).toMatchObject({ status: 'failed', failureReason: 'spawn_lost' });
      expect(first.run.status).toBe('terminated');
      expect(first.revokedAt).toHaveLength(1);
      expect(first.revokedAt[0]).not.toBeNull();
      expect(supervisorClient.terminated.filter((id) => id === workerRunId)).toHaveLength(1);

      // The best-effort supervisor stop must never surface an error to the caller.
      supervisorClient.terminate = async () => {
        throw new Error('worker-supervisor unreachable (simulated)');
      };
      await expect(
        failTaskAndReapWorkerRuns(runtimeDeps, workspaceId, principalId, taskId, 'spawn_lost'),
      ).resolves.toBeUndefined();

      // No second `task.fail` / `worker_run.terminate` row, no rewritten timestamps.
      expect(await snapshot()).toEqual(first);
    });
  });

  it('budget 100% marks the Task failed: budget_exhausted and terminates the WorkerRun', async () => {
    const sessionId = await insertSession('entry', ownerId, ownerId);
    const issued = await issueTestHandle(sessionId, entryScope());
    const supervisorClient = new FakeTaskSupervisorClient();
    const runtimeDeps = deps(supervisorClient);

    const spawnResult = await invokeWorker(
      workspaceId,
      { principalId: ownerId, channel: 'handle', claims: claimsFromIssued(issued) },
      { definitionId: workerDefinitionId, version: 1, input: {}, wait: false },
      runtimeDeps,
    );

    // Force a small token budget directly (bypassing quota resolution) so a single usage report
    // can push it to/over 100%.
    await inTx(ownerId, (client) =>
      client.query(
        'update tasks set token_budget = 100, tokens_used = 0 where workspace_id = $1 and id = $2',
        [workspaceId, spawnResult.taskId],
      ),
    );
    const workerRun = await inTx(ownerId, (client) =>
      readWorkerRunRow(client, workspaceId, spawnResult.workerRunId),
    );
    const childSessionId = workerRun?.sessionId as string;

    const { configureTaskRuntime, resetTaskRuntimeForTests } = await import('./runtime.js');
    configureTaskRuntime(runtimeDeps);
    try {
      await inTx(ownerId, (client) =>
        recordWorkerRunUsage(client, workspaceId, childSessionId, {
          inputTokens: 60,
          outputTokens: 60,
        }),
      );
    } finally {
      resetTaskRuntimeForTests();
    }

    const task = await inTx(ownerId, (client) =>
      readTaskRow(client, workspaceId, spawnResult.taskId),
    );
    expect(task?.status).toBe('failed');
    expect(task?.failureReason).toBe('budget_exhausted');

    const workerRunAfter = await inTx(ownerId, (client) =>
      readWorkerRunRow(client, workspaceId, spawnResult.workerRunId),
    );
    expect(workerRunAfter?.status).toBe('terminated');
  });

  it('80% budget warning fires exactly once (budget_warned_at set)', async () => {
    const sessionId = await insertSession('entry', ownerId, ownerId);
    const issued = await issueTestHandle(sessionId, entryScope());
    const supervisorClient = new FakeTaskSupervisorClient();
    const runtimeDeps = deps(supervisorClient);

    const spawnResult = await invokeWorker(
      workspaceId,
      { principalId: ownerId, channel: 'handle', claims: claimsFromIssued(issued) },
      { definitionId: workerDefinitionId, version: 1, input: {}, wait: false },
      runtimeDeps,
    );
    await inTx(ownerId, (client) =>
      client.query(
        'update tasks set token_budget = 100, tokens_used = 0 where workspace_id = $1 and id = $2',
        [workspaceId, spawnResult.taskId],
      ),
    );
    const workerRun = await inTx(ownerId, (client) =>
      readWorkerRunRow(client, workspaceId, spawnResult.workerRunId),
    );
    const childSessionId = workerRun?.sessionId as string;

    await inTx(ownerId, (client) =>
      recordWorkerRunUsage(client, workspaceId, childSessionId, {
        inputTokens: 40,
        outputTokens: 40,
      }),
    );

    const task = await inTx(ownerId, (client) =>
      readTaskRow(client, workspaceId, spawnResult.taskId),
    );
    expect(task?.status).toBe('running');
    expect(task?.budgetWarnedAt).not.toBeNull();

    const outboxEvents = await inTx(ownerId, async (client) => {
      const result = await client.query<{ event_type: string }>(
        "select event_type from outbox where workspace_id = $1 and event_type = 'BudgetWarning'",
        [workspaceId],
      );
      return result.rows;
    });
    expect(outboxEvents.length).toBeGreaterThanOrEqual(1);
  });

  // P-A2 (docs/platform-admin-design.md §6.6 "agent 全局附加指令 … 追加到每个入口与 Worker 的
  // system prompt"): the Worker container's `--system-prompt` is composed here, from the
  // WorkerDefinition's own `systemPrompt` plus the platform-wide `instanceInstructions`, and
  // handed to the supervisor verbatim (`SpawnWorkerRunInput.systemPrompt` → `/task/spawn`).
  describe('P-A2 systemPrompt composition', () => {
    async function spawnAndReadSystemPrompt(): Promise<string | undefined> {
      // The earlier blocks in this file leave their Tasks active on purpose; `invoke_worker`'s
      // per-user concurrency quota (5) would otherwise refuse this spawn (seen on CI). Settle them
      // first — this block asserts the spawn payload, not the quota.
      await withAdminClient(pool, (client) =>
        client.query(
          `update tasks set status = 'cancelled'
            where workspace_id = $1 and on_behalf_of = $2
              and status in ('queued', 'running', 'waiting_approval')`,
          [workspaceId, ownerId],
        ),
      );
      const sessionId = await insertSession('entry', ownerId, ownerId);
      const issued = await issueTestHandle(sessionId, entryScope());
      const supervisorClient = new FakeTaskSupervisorClient();

      await invokeWorker(
        workspaceId,
        { principalId: ownerId, channel: 'handle', claims: claimsFromIssued(issued) },
        { definitionId: workerDefinitionId, version: 1, input: {}, wait: false },
        deps(supervisorClient),
      );
      expect(supervisorClient.spawnCalls).toHaveLength(1);
      return supervisorClient.spawnCalls[0]?.systemPrompt;
    }

    it("sends the WorkerDefinition's own systemPrompt when the platform sets no instructions", async () => {
      expect(await spawnAndReadSystemPrompt()).toBe(DEFINITION_SYSTEM_PROMPT);
    });

    it('appends the platform instanceInstructions as a marked section below it', async () => {
      const instanceInstructions = 'Never quote internal prices.';
      try {
        await withAdminClient(pool, (client) =>
          updatePlatformSettings(client, { instanceInstructions }, null),
        );
        expect(await spawnAndReadSystemPrompt()).toBe(
          composeSystemPrompt({ base: DEFINITION_SYSTEM_PROMPT, instanceInstructions }),
        );
      } finally {
        // `platform_settings` is a single global row on the shared test database — never leave it
        // set for the next file (or the next local run).
        await withAdminClient(pool, (client) =>
          updatePlatformSettings(client, { instanceInstructions: '' }, null),
        );
      }
    });
  });

  // R-54 (2026-10-02 review, decision D-12): `invokeWorkerCreate` dedupes on the stored key the
  // capability handler always passes — a derived (`auto:`) key only against a Task that is not yet
  // terminal, an explicit key against its one Task whatever its status. Each test uses its own
  // principal so its running Tasks never count against another test's concurrency quota.
  describe('R-54 — invoke_worker idempotency key (docs/code-review-2026-10-02.md)', () => {
    async function entryCaller(principalId: string) {
      const sessionId = await insertSession('entry', principalId, principalId);
      const issued = await issueTestHandle(sessionId, entryScope());
      return { principalId, channel: 'handle' as const, claims: claimsFromIssued(issued) };
    }

    async function countTasksByKey(principalId: string, idempotencyKey: string): Promise<number> {
      return inTx(principalId, async (client) => {
        const result = await client.query<{ n: number }>(
          'select count(*)::int as n from tasks where workspace_id = $1 and idempotency_key = $2',
          [workspaceId, idempotencyKey],
        );
        return result.rows[0]?.n ?? 0;
      });
    }

    it('a duplicate with the same derived key returns the running Task; once that Task is terminal, an identical call starts a new one', async () => {
      const principalId = await adminInsertPrincipal('owner', 'r54-derived');
      const caller = await entryCaller(principalId);
      const supervisorClient = new FakeTaskSupervisorClient();
      const idempotencyKey = `auto:${caller.claims.sid}:${workerDefinitionId}@1:${randomUUID()}`;
      const input = {
        definitionId: workerDefinitionId,
        version: 1,
        input: { job: 'r54-derived' },
        wait: false,
        idempotencyKey,
      };

      const first = await invokeWorker(workspaceId, caller, input, deps(supervisorClient));
      const duplicate = await invokeWorker(workspaceId, caller, input, deps(supervisorClient));
      expect(duplicate).toMatchObject({
        taskId: first.taskId,
        workerRunId: first.workerRunId,
        status: 'running',
      });
      expect(supervisorClient.spawnCalls).toHaveLength(1);

      await failTaskAndReapWorkerRuns(
        deps(supervisorClient),
        workspaceId,
        principalId,
        first.taskId,
        'r54_test_terminal',
      );

      const next = await invokeWorker(workspaceId, caller, input, deps(supervisorClient));
      expect(next.taskId).not.toBe(first.taskId);
      expect(next.status).toBe('running');
      expect(supervisorClient.spawnCalls).toHaveLength(2);
      expect(await countTasksByKey(principalId, idempotencyKey)).toBe(2);
    });

    it('two identical calls sent together start one Task and one Worker', async () => {
      const principalId = await adminInsertPrincipal('owner', 'r54-concurrent');
      const caller = await entryCaller(principalId);
      const supervisorClient = new FakeTaskSupervisorClient();
      const idempotencyKey = `auto:${caller.claims.sid}:${workerDefinitionId}@1:${randomUUID()}`;
      const input = {
        definitionId: workerDefinitionId,
        version: 1,
        input: { job: 'r54-concurrent' },
        wait: false,
        idempotencyKey,
      };

      const [a, b] = await Promise.all([
        invokeWorker(workspaceId, caller, input, deps(supervisorClient)),
        invokeWorker(workspaceId, caller, input, deps(supervisorClient)),
      ]);
      expect(b.taskId).toBe(a.taskId);
      expect(b.workerRunId).toBe(a.workerRunId);
      expect(supervisorClient.spawnCalls).toHaveLength(1);
      expect(await countTasksByKey(principalId, idempotencyKey)).toBe(1);
    });

    it('an explicit key returns its Task whatever its status, and a fresh key starts a second Worker alongside a running one', async () => {
      const principalId = await adminInsertPrincipal('owner', 'r54-explicit');
      const caller = await entryCaller(principalId);
      const supervisorClient = new FakeTaskSupervisorClient();
      const explicitKey = (key: string) => `explicit:${principalId}:${caller.claims.sid}:${key}`;
      const input = (key: string) => ({
        definitionId: workerDefinitionId,
        version: 1,
        input: { job: 'r54-explicit' },
        wait: false,
        idempotencyKey: explicitKey(key),
      });

      const first = await invokeWorker(
        workspaceId,
        caller,
        input('call-1'),
        deps(supervisorClient),
      );
      await failTaskAndReapWorkerRuns(
        deps(supervisorClient),
        workspaceId,
        principalId,
        first.taskId,
        'r54_test_terminal',
      );
      const replay = await invokeWorker(
        workspaceId,
        caller,
        input('call-1'),
        deps(supervisorClient),
      );
      expect(replay).toMatchObject({
        taskId: first.taskId,
        workerRunId: first.workerRunId,
        status: 'failed',
        failureReason: 'r54_test_terminal',
      });
      expect(supervisorClient.spawnCalls).toHaveLength(1);

      const running = await invokeWorker(
        workspaceId,
        caller,
        input('call-2'),
        deps(supervisorClient),
      );
      const alongside = await invokeWorker(
        workspaceId,
        caller,
        input('call-3'),
        deps(supervisorClient),
      );
      expect(running.status).toBe('running');
      expect(alongside.status).toBe('running');
      expect(alongside.taskId).not.toBe(running.taskId);
      expect(supervisorClient.spawnCalls).toHaveLength(3);
    });
  });
});
