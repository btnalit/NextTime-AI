import { randomUUID } from 'node:crypto';
import { IllegalTransition } from '@nexttime/shared';
import type { TaskStatus, WorkerRunStatus } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { completeTaskWithResult, failTaskRow, terminateWorkerRunRow } from './lifecycle.js';

/**
 * application/task/lifecycle.test: pure/no-real-DB unit tests for `completeTaskWithResult`'s
 * `waiting_approval` handling (leftover 47, docs/STATUS.md §4) — a fake `PoolClient` (a `.query()`
 * stub that pattern-matches on SQL text and returns canned rows) stands in for Postgres, same
 * "unit with fakes" style `application/task/quotas.test.ts` already establishes for this package.
 * Everything else this function touches (`worker_runs` reads/writes, `audit_records`, `outbox`)
 * lives in this same fake so the test exercises the real function end to end without a database —
 * the one deliberate simplification is a `WorkerRun` with no `sessionId`, so
 * `revokeWorkerRunAndDescendants` never has to call into `governance/capability`'s `revokeSession`.
 */

interface FakeClientOptions {
  readonly taskStatus: TaskStatus;
  readonly workerRunStatus?: WorkerRunStatus;
}

function createFakeClient(options: FakeClientOptions) {
  const workspaceId = 'ws-1';
  const taskId = 'task-1';
  const workerRunId = 'wr-1';
  const actorPrincipalId = 'principal-1';
  const calls: string[] = [];

  const taskDbRow = {
    workspace_id: workspaceId,
    id: taskId,
    status: options.taskStatus,
    on_behalf_of: actorPrincipalId,
    created_by_activity_id: null,
    worker_definition_id: 'def-1',
    worker_definition_version: 1,
    input: {},
    result: null,
    token_budget: null,
    duration_limit_sec: null,
    tokens_used: 0,
    budget_warned_at: null,
    failure_reason: null,
    retry_count: 0,
    created_at: new Date(),
    updated_at: new Date(),
    completed_at: null,
    failed_at: null,
    cancelled_at: null,
  };

  const workerRunDbRow = {
    workspace_id: workspaceId,
    id: workerRunId,
    status: options.workerRunStatus ?? 'running',
    task_id: taskId,
    parent_worker_run_id: null,
    // No session — keeps `revokeWorkerRunAndDescendants` from calling `revokeSession` at all
    // (see this file's own doc comment).
    session_id: null,
    container_id: null,
    depth: 0,
    activity_id: null,
    attempt: 1,
    agent_principal_id: 'agent-1',
    started_at: new Date(),
    terminated_at: null,
  };

  const auditRowFor = () => ({
    workspace_id: workspaceId,
    id: randomUUID(),
    actor_principal_id: actorPrincipalId,
    actor_user_id: null,
    action: 'x',
    resource_type: null,
    resource_id: null,
    payload: {},
    created_at: new Date(),
  });

  const client = {
    query: async (text: string) => {
      calls.push(text);
      const sql = text.replace(/\s+/g, ' ').trim().toLowerCase();

      if (sql.startsWith('update tasks') && sql.includes('returning')) {
        return {
          rows: [{ ...taskDbRow, status: 'completed', completed_at: new Date() }],
          rowCount: 1,
        };
      }
      if (sql.startsWith('select') && sql.includes('from tasks')) {
        return { rows: [taskDbRow], rowCount: 1 };
      }
      // `revokeWorkerRunAndDescendants`'s children lookup — checked before the generic
      // `readWorkerRunRow` match below, since `WORKER_RUN_ROW_COLUMNS` also lists
      // `parent_worker_run_id` as a selected column name (not this WHERE clause).
      if (
        sql.startsWith('select') &&
        sql.includes('where workspace_id = $1 and parent_worker_run_id = $2')
      ) {
        return { rows: [], rowCount: 0 }; // no children
      }
      if (sql.startsWith('select') && sql.includes('from worker_runs')) {
        return { rows: [workerRunDbRow], rowCount: 1 };
      }
      if (sql.startsWith('update worker_runs')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('insert into audit_records')) {
        return { rows: [auditRowFor()], rowCount: 1 };
      }
      if (sql.startsWith('insert into outbox')) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`fake PoolClient: unhandled query in lifecycle.test.ts: ${text}`);
    },
  } as unknown as PoolClient;

  return { client, calls, workspaceId, taskId, workerRunId, actorPrincipalId };
}

/**
 * A second fake `PoolClient`, purpose-built for the P1-b hotfix (post-v0.16.0 review, "task status
 * race"): scripts the exact sequence of return values for `readTaskRow`'s SELECT and the guarded
 * `update tasks ... where ... and status = $3` UPDATE, rather than modeling real concurrency (the
 * dispatch's own "no real race needed" — a lost guarded UPDATE and a concurrent writer's status
 * change are indistinguishable from this function's point of view; scripting `rowCount: 0` directly
 * exercises the same code path a real race would).
 */
interface RaceFakeClientOptions {
  /** Each `select ... from tasks` call returns the next entry — the first is
   *  `completeTaskWithResult`'s own initial read; each later one models a re-read after a lost
   *  guarded-UPDATE attempt. The queue's last entry repeats once exhausted. */
  readonly taskStatuses: readonly TaskStatus[];
  /** Each guarded `update tasks ... returning` call consumes the next entry — `true` = the guard
   *  matched (rowCount 1, the row moves to `completed`), `false` = it did not (rowCount 0). */
  readonly updateOutcomes: readonly boolean[];
}

function createRaceFakeClient(options: RaceFakeClientOptions) {
  const workspaceId = 'ws-1';
  const taskId = 'task-1';
  const workerRunId = 'wr-1';
  const actorPrincipalId = 'principal-1';

  const baseTaskRow = {
    workspace_id: workspaceId,
    id: taskId,
    on_behalf_of: actorPrincipalId,
    created_by_activity_id: null,
    worker_definition_id: 'def-1',
    worker_definition_version: 1,
    input: {},
    result: null,
    token_budget: null,
    duration_limit_sec: null,
    tokens_used: 0,
    budget_warned_at: null,
    failure_reason: null,
    retry_count: 0,
    created_at: new Date(),
    updated_at: new Date(),
    completed_at: null,
    failed_at: null,
    cancelled_at: null,
  };

  const workerRunDbRow = {
    workspace_id: workspaceId,
    id: workerRunId,
    status: 'running',
    task_id: taskId,
    parent_worker_run_id: null,
    session_id: null,
    container_id: null,
    depth: 0,
    activity_id: null,
    attempt: 1,
    agent_principal_id: 'agent-1',
    started_at: new Date(),
    terminated_at: null,
  };

  const auditRowFor = () => ({
    workspace_id: workspaceId,
    id: randomUUID(),
    actor_principal_id: actorPrincipalId,
    actor_user_id: null,
    action: 'x',
    resource_type: null,
    resource_id: null,
    payload: {},
    created_at: new Date(),
  });

  let taskReadIndex = 0;
  let updateIndex = 0;

  const client = {
    query: async (text: string) => {
      const sql = text.replace(/\s+/g, ' ').trim().toLowerCase();

      if (sql.startsWith('update tasks') && sql.includes('returning')) {
        const outcome = options.updateOutcomes[updateIndex] ?? true;
        updateIndex += 1;
        if (!outcome) return { rows: [], rowCount: 0 };
        return {
          rows: [{ ...baseTaskRow, status: 'completed', completed_at: new Date() }],
          rowCount: 1,
        };
      }
      if (sql.startsWith('select') && sql.includes('from tasks')) {
        const idx = Math.min(taskReadIndex, options.taskStatuses.length - 1);
        const status = options.taskStatuses[idx];
        taskReadIndex += 1;
        return { rows: [{ ...baseTaskRow, status }], rowCount: 1 };
      }
      if (
        sql.startsWith('select') &&
        sql.includes('where workspace_id = $1 and parent_worker_run_id = $2')
      ) {
        return { rows: [], rowCount: 0 }; // no children
      }
      if (sql.startsWith('select') && sql.includes('from worker_runs')) {
        return { rows: [workerRunDbRow], rowCount: 1 };
      }
      if (sql.startsWith('update worker_runs')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('insert into audit_records')) {
        return { rows: [auditRowFor()], rowCount: 1 };
      }
      if (sql.startsWith('insert into outbox')) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`fake PoolClient: unhandled query in lifecycle.test.ts (race): ${text}`);
    },
  } as unknown as PoolClient;

  return { client, workspaceId, taskId, workerRunId, actorPrincipalId };
}

describe('completeTaskWithResult — status-guarded UPDATE + retry (P1-b hotfix, post-v0.16.0 review "task status race")', () => {
  it('retries once and succeeds when the guarded UPDATE loses the race exactly once (e.g. an approval landing waiting_approval -> running concurrently)', async () => {
    const { client, workspaceId, taskId, workerRunId, actorPrincipalId } = createRaceFakeClient({
      taskStatuses: ['waiting_approval', 'running'],
      updateOutcomes: [false, true],
    });

    const result = await completeTaskWithResult(
      client,
      workspaceId,
      actorPrincipalId,
      taskId,
      workerRunId,
      { summary: 'completed after one retry' },
    );

    expect(result.status).toBe('completed');
  });

  it('throws IllegalTransition (never reverts) when the re-read after a lost race finds a terminal status', async () => {
    const { client, workspaceId, taskId, workerRunId, actorPrincipalId } = createRaceFakeClient({
      taskStatuses: ['running', 'cancelled'],
      updateOutcomes: [false],
    });

    await expect(
      completeTaskWithResult(client, workspaceId, actorPrincipalId, taskId, workerRunId, {}),
    ).rejects.toThrow(IllegalTransition);
  });

  it('throws IllegalTransition after losing the guarded UPDATE race twice in a row, instead of retrying forever', async () => {
    const { client, workspaceId, taskId, workerRunId, actorPrincipalId } = createRaceFakeClient({
      taskStatuses: ['running', 'running'],
      updateOutcomes: [false, false],
    });

    await expect(
      completeTaskWithResult(client, workspaceId, actorPrincipalId, taskId, workerRunId, {}),
    ).rejects.toThrow(IllegalTransition);
  });
});

describe('completeTaskWithResult — waiting_approval (leftover 47)', () => {
  it('completes a Task that is waiting_approval by hopping through the already-existing resume edge, instead of throwing IllegalTransition', async () => {
    const { client, workspaceId, taskId, workerRunId, actorPrincipalId } = createFakeClient({
      taskStatus: 'waiting_approval',
    });

    // Before the fix, `transition(TASK_TRANSITIONS, 'waiting_approval', 'complete')` had no edge
    // and threw here — this is exactly what a Worker's `report_task_result` call hits when a gate
    // tool's `await_decision: true` wait timed out with the ActionRequest still undecided.
    const result = await completeTaskWithResult(
      client,
      workspaceId,
      actorPrincipalId,
      taskId,
      workerRunId,
      { summary: 'done despite the still-pending approval' },
    );

    expect(result.status).toBe('completed');
  });

  it('still throws IllegalTransition for a Task that is not running or waiting_approval — the fix only widens waiting_approval, nothing else', async () => {
    const { client, workspaceId, taskId, workerRunId, actorPrincipalId } = createFakeClient({
      taskStatus: 'failed',
    });

    await expect(
      completeTaskWithResult(client, workspaceId, actorPrincipalId, taskId, workerRunId, {}),
    ).rejects.toThrow(IllegalTransition);
  });

  it('still completes a Task that is already running — the ordinary, unchanged path', async () => {
    const { client, workspaceId, taskId, workerRunId, actorPrincipalId } = createFakeClient({
      taskStatus: 'running',
    });

    const result = await completeTaskWithResult(
      client,
      workspaceId,
      actorPrincipalId,
      taskId,
      workerRunId,
      { summary: 'ordinary completion' },
    );

    expect(result.status).toBe('completed');
  });
});

/** Fake `PoolClient` for `failTaskRow` (leftover 67, docs/STATUS.md §4) — same "unit with fakes"
 *  convention `reaper.test.ts` establishes for `moveTaskToWaitingApproval`/
 *  `resumeTaskFromWaitingApproval`'s identical guarded-UPDATE shape: `updateRowCount` scripts the
 *  guarded `update tasks ... and status = $4` outcome directly rather than modeling a real race. */
function createFailFakeClient(options: { taskStatus: TaskStatus; updateRowCount: number }) {
  const workspaceId = 'ws-1';
  const taskId = 'task-1';
  const actorPrincipalId = 'principal-1';
  const queries: string[] = [];

  const taskDbRow = {
    workspace_id: workspaceId,
    id: taskId,
    status: options.taskStatus,
    on_behalf_of: actorPrincipalId,
    created_by_activity_id: null,
    worker_definition_id: 'def-1',
    worker_definition_version: 1,
    input: {},
    result: null,
    token_budget: null,
    duration_limit_sec: null,
    tokens_used: 0,
    budget_warned_at: null,
    failure_reason: null,
    retry_count: 0,
    created_at: new Date(),
    updated_at: new Date(),
    completed_at: null,
    failed_at: null,
    cancelled_at: null,
  };

  const auditRowFor = () => ({
    workspace_id: workspaceId,
    id: randomUUID(),
    actor_principal_id: actorPrincipalId,
    actor_user_id: null,
    action: 'x',
    resource_type: null,
    resource_id: null,
    payload: {},
    created_at: new Date(),
  });

  const client = {
    query: async (text: string) => {
      queries.push(text);
      const sql = text.replace(/\s+/g, ' ').trim().toLowerCase();
      if (sql.startsWith('select') && sql.includes('from tasks')) {
        return { rows: [taskDbRow], rowCount: 1 };
      }
      if (sql.startsWith('update tasks')) {
        return { rows: [], rowCount: options.updateRowCount };
      }
      if (sql.startsWith('insert into audit_records')) {
        return { rows: [auditRowFor()], rowCount: 1 };
      }
      if (sql.startsWith('insert into outbox')) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(
        `fake PoolClient: unhandled query in lifecycle.test.ts (failTaskRow): ${text}`,
      );
    },
  } as unknown as PoolClient;

  return { client, queries, workspaceId, taskId, actorPrincipalId };
}

describe('failTaskRow — status-guarded UPDATE (leftover 67, docs/STATUS.md §4)', () => {
  it('writes the failed transition + audit when the guarded UPDATE matches (rowCount 1)', async () => {
    const { client, queries, workspaceId, taskId, actorPrincipalId } = createFailFakeClient({
      taskStatus: 'running',
      updateRowCount: 1,
    });

    await failTaskRow(client, workspaceId, actorPrincipalId, taskId, 'worker_failed');

    expect(queries.some((q) => q.toLowerCase().includes('insert into audit_records'))).toBe(true);
  });

  it('is a silent no-op — never overwrites a status a concurrent writer already produced — when the guarded UPDATE loses the race (rowCount 0)', async () => {
    const { client, queries, workspaceId, taskId, actorPrincipalId } = createFailFakeClient({
      taskStatus: 'running',
      updateRowCount: 0,
    });

    await expect(
      failTaskRow(client, workspaceId, actorPrincipalId, taskId, 'worker_failed'),
    ).resolves.toBeUndefined();

    expect(queries.some((q) => q.toLowerCase().includes('insert into audit_records'))).toBe(false);
  });

  it('is a no-op for a Task already in a terminal status — never re-fails an already-terminal row', async () => {
    const { client, queries, workspaceId, taskId, actorPrincipalId } = createFailFakeClient({
      taskStatus: 'completed',
      updateRowCount: 1, // would match if the guard clause below were somehow skipped
    });

    await failTaskRow(client, workspaceId, actorPrincipalId, taskId, 'worker_failed');

    expect(queries.some((q) => q.toLowerCase().startsWith('update tasks'))).toBe(false);
  });
});

/** Fake `PoolClient` for `terminateWorkerRunRow` (leftover 90, docs/STATUS.md §4): scripts the
 *  exact sequence of return values for `readWorkerRunRow`'s SELECT (called both by
 *  `terminateWorkerRunRow` itself and, on the lost-race path, once more as its own re-read) and
 *  the guarded `update worker_runs ... where ... and status = $3` UPDATE — same "no real race
 *  needed, script the outcome directly" convention `createRaceFakeClient` above already
 *  establishes for `completeTaskWithResult`. `session_id` is deliberately `null` (same
 *  simplification `createFakeClient` above uses) so `revokeWorkerRunAndDescendants` never calls
 *  into `governance/capability`'s `revokeSession` — whether it *ran* is instead observed through
 *  the children-lookup query (`... where workspace_id = $1 and parent_worker_run_id = $2`), which
 *  only `revokeWorkerRunAndDescendants` ever issues. */
function createTerminateRaceFakeClient(options: {
  readonly initialStatus: WorkerRunStatus;
  readonly updateRowCount: number;
  /** What the lost-race re-read finds — only consulted when `updateRowCount` is 0. */
  readonly rereadStatus?: WorkerRunStatus;
}) {
  const workspaceId = 'ws-1';
  const taskId = 'task-1';
  const workerRunId = 'wr-1';
  const actorPrincipalId = 'principal-1';
  const queries: string[] = [];
  let workerRunReadCount = 0;

  const baseWorkerRunRow = {
    workspace_id: workspaceId,
    id: workerRunId,
    task_id: taskId,
    parent_worker_run_id: null,
    session_id: null,
    container_id: null,
    depth: 0,
    activity_id: null,
    attempt: 1,
    agent_principal_id: 'agent-1',
    started_at: new Date(),
    terminated_at: null,
  };

  const auditRowFor = () => ({
    workspace_id: workspaceId,
    id: randomUUID(),
    actor_principal_id: actorPrincipalId,
    actor_user_id: null,
    action: 'x',
    resource_type: null,
    resource_id: null,
    payload: {},
    created_at: new Date(),
  });

  const client = {
    query: async (text: string) => {
      queries.push(text);
      const sql = text.replace(/\s+/g, ' ').trim().toLowerCase();

      // `revokeWorkerRunAndDescendants`'s children lookup — checked before the generic
      // `readWorkerRunRow` match below, same ordering `createFakeClient` above already uses.
      if (
        sql.startsWith('select') &&
        sql.includes('where workspace_id = $1 and parent_worker_run_id = $2')
      ) {
        return { rows: [], rowCount: 0 }; // no children
      }
      if (sql.startsWith('select') && sql.includes('from worker_runs')) {
        workerRunReadCount += 1;
        const status =
          workerRunReadCount === 1 ? options.initialStatus : (options.rereadStatus ?? 'terminated');
        return { rows: [{ ...baseWorkerRunRow, status }], rowCount: 1 };
      }
      if (sql.startsWith('update worker_runs')) {
        return { rows: [], rowCount: options.updateRowCount };
      }
      if (sql.startsWith('insert into audit_records')) {
        return { rows: [auditRowFor()], rowCount: 1 };
      }
      if (sql.startsWith('insert into outbox')) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(
        `fake PoolClient: unhandled query in lifecycle.test.ts (terminateWorkerRunRow race): ${text}`,
      );
    },
  } as unknown as PoolClient;

  return { client, queries, workspaceId, taskId, workerRunId, actorPrincipalId };
}

describe('terminateWorkerRunRow — status-guarded UPDATE (leftover 90, docs/STATUS.md §4)', () => {
  it('writes the transition + revokes the Handle tree when the guarded UPDATE matches (rowCount 1, the ordinary path)', async () => {
    const { client, queries, workspaceId, workerRunId, actorPrincipalId } =
      createTerminateRaceFakeClient({ initialStatus: 'suspended', updateRowCount: 1 });

    await terminateWorkerRunRow(client, workspaceId, actorPrincipalId, workerRunId, 'requested');

    expect(queries.some((q) => q.toLowerCase().includes('insert into audit_records'))).toBe(true);
    expect(
      queries.some((q) =>
        q.toLowerCase().includes('where workspace_id = $1 and parent_worker_run_id = $2'),
      ),
    ).toBe(true);
  });

  it('is a silent no-op — never records a second transition or reverts a legitimately-alive run — when the guarded UPDATE loses the race and the row is not actually terminated', async () => {
    const { client, queries, workspaceId, workerRunId, actorPrincipalId } =
      createTerminateRaceFakeClient({
        initialStatus: 'running',
        updateRowCount: 0,
        rereadStatus: 'running', // e.g. `spawn.ts`'s own `provisioning -> running` write won instead
      });

    await terminateWorkerRunRow(client, workspaceId, actorPrincipalId, workerRunId, 'requested');

    expect(queries.some((q) => q.toLowerCase().includes('insert into audit_records'))).toBe(false);
    // Never revoked — the run is legitimately still alive.
    expect(
      queries.some((q) =>
        q.toLowerCase().includes('where workspace_id = $1 and parent_worker_run_id = $2'),
      ),
    ).toBe(false);
  });

  it('still revokes the Handle tree (idempotent) when the re-read finds the row already terminated by a concurrent terminateWorkerRunRow call, without recording a second transition', async () => {
    const { client, queries, workspaceId, workerRunId, actorPrincipalId } =
      createTerminateRaceFakeClient({
        initialStatus: 'running',
        updateRowCount: 0,
        rereadStatus: 'terminated',
      });

    await terminateWorkerRunRow(client, workspaceId, actorPrincipalId, workerRunId, 'requested');

    // No second `worker_run.terminate` audit row — the concurrent call that actually won the race
    // already wrote its own.
    expect(queries.some((q) => q.toLowerCase().includes('insert into audit_records'))).toBe(false);
    // But the Handle tree is still revoked here too.
    expect(
      queries.some((q) =>
        q.toLowerCase().includes('where workspace_id = $1 and parent_worker_run_id = $2'),
      ),
    ).toBe(true);
  });
});
