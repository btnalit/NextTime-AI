import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CapabilityScope, HandleClaims } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import type {
  TaskSpawnInput,
  TaskSpawnOutcome,
  TaskSupervisorClientPort,
  TaskSupervisorStatus,
} from '../../adapters/supervisor-client/index.js';
import { setAgentProfile } from '../../governance/agent-profile/index.js';
import {
  type IssuedHandle,
  entryScope,
  generateEphemeralHandleKeyPair,
  issueHandle,
} from '../../governance/capability/index.js';
import { proposeWorkerDefinition, publishWorkerDefinition } from '../worker/index.js';
import { createTask, invokeWorker } from './invoke.js';
import { reactToSupervisorStatus, readTaskRow, readWorkerRunRow } from './lifecycle.js';
import type { TaskRuntimeDeps } from './runtime.js';
import { recordWorkerRunUsage, terminateTask } from './service.js';
import {
  InvokeWorkerAttenuationError,
  InvokeWorkerDefinitionNotEnabledError,
  QuotaExceededError,
} from './types.js';

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

    const definition = await publishWorkerDef({ systemPrompt: 'You are a plain worker.' });
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

  // W4 closeout: `create_task` — "create only", never spawns (contrast every `invoke_worker` test
  // above, which always does). See `createTask`'s own doc comment (invoke.ts) for the semantics
  // decision.
  describe('create_task — create only, never spawns', () => {
    it('creates a Task at status "queued", pinned to the WorkerDefinition, with zero WorkerRuns and no supervisor call', async () => {
      const supervisorClient = new FakeTaskSupervisorClient();
      const task = await createTask(
        workspaceId,
        { principalId: ownerId, channel: 'handle' },
        { definitionId: workerDefinitionId, version: 1, input: { foo: 'bar' } },
        deps(supervisorClient),
      );

      expect(task.status).toBe('queued');
      expect(task.workerDefinitionId).toBe(workerDefinitionId);
      expect(task.workerDefinitionVersion).toBe(1);
      expect(task.onBehalfOf).toBe(ownerId);
      expect(supervisorClient.spawnCalls).toHaveLength(0); // never spawns

      const reread = await inTx(ownerId, (client) => readTaskRow(client, workspaceId, task.id));
      expect(reread?.status).toBe('queued');
      const workerRunCount = await inTx(ownerId, (client) =>
        client.query<{ count: string }>(
          'select count(*)::int as count from worker_runs where workspace_id = $1 and task_id = $2',
          [workspaceId, task.id],
        ),
      );
      expect(Number(workerRunCount.rows[0]?.count)).toBe(0); // no WorkerRun ever created for it
    });

    it('honors AgentProfile.enabledWorkerDefinitions the same way invoke_worker does', async () => {
      const principalId = await adminInsertPrincipal('owner', 'create-task-profile-owner');
      const definitionA = await publishWorkerDef({
        systemPrompt: 'You are worker A.',
        name: 'create-task-profile-worker-a-unique',
      });
      const definitionB = await publishWorkerDef({
        systemPrompt: 'You are worker B.',
        name: 'create-task-profile-worker-b-unique',
      });

      // Owners are not exempt (a Profile is a preference the principal set for themselves, not a
      // privilege boundary) — same rule `invoke-worker-handler.integration.test.ts`'s own
      // equivalent test asserts for `invoke_worker`.
      await inTx(principalId, (client) =>
        setAgentProfile(client, workspaceId, principalId, principalId, {
          enabledWorkerDefinitions: [definitionA.id],
        }),
      );

      const supervisorClient = new FakeTaskSupervisorClient();
      const err = await createTask(
        workspaceId,
        { principalId, channel: 'handle' },
        { definitionId: definitionB.id, version: definitionB.version, input: {} },
        deps(supervisorClient),
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InvokeWorkerDefinitionNotEnabledError);

      // A itself stays creatable — the profile narrows, it does not additionally break the
      // definition it does list.
      const task = await createTask(
        workspaceId,
        { principalId, channel: 'handle' },
        { definitionId: definitionA.id, version: definitionA.version, input: {} },
        deps(supervisorClient),
      );
      expect(task.status).toBe('queued');
      expect(supervisorClient.spawnCalls).toHaveLength(0);
    });

    // Documents the known limitation `createTask`'s own doc comment (invoke.ts) calls out: a Task
    // created without a WorkerRun still counts toward the same `queued`/`running`/`waiting_approval`
    // concurrency ceiling `invoke_worker` enforces (`insertQueuedTaskWithQuotaCheck` is shared), so
    // it can consume a real caller's quota slot with nothing ever running to show for it.
    it('a create_task-created queued Task counts toward the same concurrency ceiling invoke_worker enforces', async () => {
      const quotaRacerId = await adminInsertPrincipal('member', 'create-task-quota-racer');

      // Seed to exactly one below the default concurrency limit (5) via create_task itself, not a
      // raw INSERT — proving the shared quota gate really did run for each of these.
      const supervisorClient = new FakeTaskSupervisorClient();
      for (let i = 0; i < 4; i += 1) {
        await createTask(
          workspaceId,
          { principalId: quotaRacerId, channel: 'handle' },
          { definitionId: workerDefinitionId, version: 1, input: {} },
          deps(supervisorClient),
        );
      }
      expect(supervisorClient.spawnCalls).toHaveLength(0); // still never spawns

      // The 5th create_task succeeds (fills the ceiling)...
      await createTask(
        workspaceId,
        { principalId: quotaRacerId, channel: 'handle' },
        { definitionId: workerDefinitionId, version: 1, input: {} },
        deps(supervisorClient),
      );

      // ...and now a real invoke_worker for the same principal is rejected — the phantom `queued`
      // Tasks from create_task above already exhausted the ceiling, with zero WorkerRuns among
      // them.
      const sessionId = await insertSession('entry', quotaRacerId, quotaRacerId);
      const issued = await issueTestHandle(sessionId, entryScope());
      const invokeErr = await invokeWorker(
        workspaceId,
        { principalId: quotaRacerId, channel: 'handle', claims: claimsFromIssued(issued) },
        { definitionId: workerDefinitionId, version: 1, input: {}, wait: false },
        deps(supervisorClient),
      ).catch((e: unknown) => e);

      expect(invokeErr).toBeInstanceOf(QuotaExceededError);
      expect((invokeErr as InstanceType<typeof QuotaExceededError>).code).toBe(
        'concurrency_exceeded',
      );
      expect(supervisorClient.spawnCalls).toHaveLength(0);
    });
  });
});
