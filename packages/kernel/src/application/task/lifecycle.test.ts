import { randomUUID } from 'node:crypto';
import { IllegalTransition } from '@nexttime/shared';
import type { TaskStatus, WorkerRunStatus } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { completeTaskWithResult } from './lifecycle.js';

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
