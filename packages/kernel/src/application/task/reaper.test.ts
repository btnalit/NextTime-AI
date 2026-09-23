import { randomUUID } from 'node:crypto';
import type { TaskStatus } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { moveTaskToWaitingApproval, resumeTaskFromWaitingApproval } from './reaper.js';

/**
 * application/task/reaper.test: fake-PoolClient (no real Postgres) unit coverage of the P1-b
 * hotfix (post-v0.16.0 review, "task status race") for `moveTaskToWaitingApproval` and
 * `resumeTaskFromWaitingApproval` — same "unit with fakes" convention `lifecycle.test.ts` already
 * establishes for `completeTaskWithResult`'s identical class of fix. Every real-DB path for these
 * two (routed through `registerActionRequestRoutingConsumer`'s event consumers) stays covered by
 * `reaper.integration.test.ts`; this file only exercises the guarded-UPDATE rowCount=0 branch,
 * which needs no real race — the fake's `updateRowCount` scripts it directly.
 */

function createFakeClient(options: { taskStatus: TaskStatus; updateRowCount: number }) {
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
      throw new Error(`fake PoolClient: unhandled query in reaper.test.ts: ${text}`);
    },
  } as unknown as PoolClient;

  return { client, queries, workspaceId, taskId, actorPrincipalId };
}

describe('moveTaskToWaitingApproval — status-guarded UPDATE (P1-b hotfix)', () => {
  it('writes the waiting_approval transition + audit when the guarded UPDATE matches (rowCount 1)', async () => {
    const { client, queries, workspaceId, taskId, actorPrincipalId } = createFakeClient({
      taskStatus: 'running',
      updateRowCount: 1,
    });

    await moveTaskToWaitingApproval(client, workspaceId, taskId, actorPrincipalId);

    expect(queries.some((q) => q.toLowerCase().includes('insert into audit_records'))).toBe(true);
    expect(queries.some((q) => q.toLowerCase().includes('insert into outbox'))).toBe(true);
  });

  it('is a silent no-op — no audit/outbox row — when the guarded UPDATE loses the race (rowCount 0)', async () => {
    const { client, queries, workspaceId, taskId, actorPrincipalId } = createFakeClient({
      taskStatus: 'running',
      updateRowCount: 0,
    });

    await expect(
      moveTaskToWaitingApproval(client, workspaceId, taskId, actorPrincipalId),
    ).resolves.toBeUndefined();

    expect(queries.some((q) => q.toLowerCase().includes('insert into audit_records'))).toBe(false);
    expect(queries.some((q) => q.toLowerCase().includes('insert into outbox'))).toBe(false);
  });
});

describe('resumeTaskFromWaitingApproval — status-guarded UPDATE (P1-b hotfix, leftover 47’s race)', () => {
  it('writes the running transition + audit when the guarded UPDATE matches (rowCount 1)', async () => {
    const { client, queries, workspaceId, taskId, actorPrincipalId } = createFakeClient({
      taskStatus: 'waiting_approval',
      updateRowCount: 1,
    });

    await resumeTaskFromWaitingApproval(client, workspaceId, taskId, actorPrincipalId);

    expect(queries.some((q) => q.toLowerCase().includes('insert into audit_records'))).toBe(true);
    expect(queries.some((q) => q.toLowerCase().includes('insert into outbox'))).toBe(true);
  });

  it('is a silent no-op — never reverts a Task a concurrent completeTaskWithResult already finished — when the guarded UPDATE loses the race (rowCount 0)', async () => {
    const { client, queries, workspaceId, taskId, actorPrincipalId } = createFakeClient({
      taskStatus: 'waiting_approval',
      updateRowCount: 0,
    });

    await expect(
      resumeTaskFromWaitingApproval(client, workspaceId, taskId, actorPrincipalId),
    ).resolves.toBeUndefined();

    expect(queries.some((q) => q.toLowerCase().includes('insert into audit_records'))).toBe(false);
    expect(queries.some((q) => q.toLowerCase().includes('insert into outbox'))).toBe(false);
  });
});
