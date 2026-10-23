import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { generateEphemeralHandleKeyPair } from '../../governance/capability/index.js';
import { endActivity, startActivity } from '../../substrate/epistemic/index.js';
import type { DomainEvent } from '../../substrate/outbox/index.js';
import { newChat } from '../chat/index.js';
import {
  advanceGoalRun,
  confirmGoalRun,
  createGoalRun,
  pauseGoalRun,
  releaseGoalRunHold,
} from '../goal/index.js';
import type { GoalRunBudget } from '../goal/types.js';
import type { OutboxDeliveryMeta } from '../outbox/index.js';
import { completeTaskWithResult } from '../task/index.js';
import { proposeWorkerDefinition, publishWorkerDefinition } from '../worker/index.js';
import { registerBudgetWarningConsumer } from './budget-consumer.js';
import { registerGoalRunUpdatedConsumer } from './goal-consumer.js';
import { leaseContextItemsToTurn } from './store.js';
import { registerTaskUpdatedConsumer } from './task-consumer.js';

/**
 * application/linkage/goal-consumer.integration (S11 GO5e-2, plan §4.14, §7.2 S1 "对话里出现里程碑
 * 消息"): a GoalRun's changes, read from the real outbox rows `application/goal` writes, become
 * `system.goal_update` messages in the chat the goal was proposed from — and, but for the
 * proposal, context items for that chat's next Turn; a goal step's Task reports into the same chat,
 * named after its step, without a context item of its own. Harness as `task-consumer.integration`.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

const BUDGET: GoalRunBudget = {
  maxTokens: 100_000,
  maxSteps: 10,
  maxRevisions: 2,
  maxWallClockSeconds: 3600,
};

class FakeTaskSupervisorClient implements TaskSupervisorClientPort {
  private readonly statuses = new Map<string, TaskSupervisorStatus>();

  async spawn(input: TaskSpawnInput): Promise<TaskSpawnOutcome> {
    const containerId = `container-${input.workerRunId}`;
    this.statuses.set(input.workerRunId, {
      workerRunId: input.workerRunId,
      status: 'running',
      exitCode: undefined,
      containerId,
      ip: '198.51.100.30',
      startedAt: new Date().toISOString(),
      finishedAt: undefined,
      reason: undefined,
    });
    return { containerId, ip: '198.51.100.30' };
  }

  async terminate(workerRunId: string): Promise<boolean> {
    return this.statuses.delete(workerRunId);
  }

  async status(workerRunId: string): Promise<TaskSupervisorStatus | undefined> {
    return this.statuses.get(workerRunId);
  }
}

/** Captures the consumer a `register*Consumer` subscribes, so a test delivers events by hand. */
function fakeDispatcher<E extends GoalRunUpdatedEvent | TaskUpdatedEvent | BudgetWarningEvent>() {
  let registered: ((event: E, meta: OutboxDeliveryMeta) => Promise<void> | void) | undefined;
  return {
    subscribe: (
      _eventType: E['type'],
      consumer: (event: E, meta: OutboxDeliveryMeta) => Promise<void> | void,
    ) => {
      registered = consumer;
      return () => {
        registered = undefined;
      };
    },
    emit: async (outboxId: string, event: E) => {
      await registered?.(event, { outboxId, workspaceId: event.workspaceId });
    },
  };
}

type GoalRunUpdatedEvent = Extract<DomainEvent, { type: 'GoalRunUpdated' }>;
type TaskUpdatedEvent = Extract<DomainEvent, { type: 'TaskUpdated' }>;
type BudgetWarningEvent = Extract<DomainEvent, { type: 'BudgetWarning' }>;

interface MessageRow {
  readonly chat_id: string;
  readonly role: string;
  readonly content: Record<string, unknown>;
}

describe.runIf(DATABASE_URL !== undefined)(
  'application/linkage/goal-consumer — integration (real Postgres)',
  () => {
    let pool: Pool;
    let privateKey: Awaited<ReturnType<typeof generateEphemeralHandleKeyPair>>['privateKey'];
    let workspaceId: string;
    let ownerId: string;
    let worker: { definitionId: string; version: number };
    const supervisorClient = new FakeTaskSupervisorClient();

    const goals = fakeDispatcher<GoalRunUpdatedEvent>();
    const tasks = fakeDispatcher<TaskUpdatedEvent>();
    const budgets = fakeDispatcher<BudgetWarningEvent>();

    const inTx = <T>(principalId: string, fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId, principalId }, fn);
    const admin = <T>(fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId, principalId: ownerId }, fn, { skipRoleSwitch: true });

    async function newPrincipal(role = 'member'): Promise<string> {
      const id = randomUUID();
      await admin((client) =>
        client.query(
          `insert into principals (workspace_id, id, kind, role, display_name)
           values ($1, $2, 'human', $3, $4)`,
          [workspaceId, id, role, `requester-${id.slice(0, 8)}`],
        ),
      );
      return id;
    }

    /** A Turn of `chatId`; ended at once unless `running` (a chat runs one Turn at a time). */
    async function turnIn(principalId: string, chatId: string, running = false): Promise<string> {
      return inTx(principalId, async (client) => {
        const turn = await startActivity(client, workspaceId, {
          kind: 'agent_turn',
          chatId,
          principalId,
        });
        if (!running) await endActivity(client, workspaceId, turn.id, 'completed');
        return turn.id;
      });
    }

    async function propose(requesterId: string, originatedInTurnId?: string): Promise<string> {
      const created = await inTx(requesterId, (client) =>
        createGoalRun(client, workspaceId, {
          requesterId,
          proposedBy: requesterId,
          statement: 'keep the stock list current',
          plan: { steps: [{ key: 'collect', worker, input: { step: 'collect' } }] },
          budget: BUDGET,
          ...(originatedInTurnId ? { originatedInTurnId } : {}),
        }),
      );
      return created.goalRunId;
    }

    async function confirm(requesterId: string, goalRunId: string): Promise<void> {
      await inTx(requesterId, (client) =>
        confirmGoalRun(client, workspaceId, { goalRunId, revision: 1, confirmedBy: requesterId }),
      );
    }

    /** The `GoalRunUpdated` row `application/goal` wrote for `change`, delivered to the consumer. */
    async function deliverGoalChange(goalRunId: string, change: string): Promise<string> {
      const row = await admin(async (client) => {
        const result = await client.query<{ id: string; payload: GoalRunUpdatedEvent }>(
          `select id, payload from outbox
            where workspace_id = $1 and event_type = 'GoalRunUpdated'
              and payload->>'goalRunId' = $2 and payload->>'change' = $3
            order by id desc limit 1`,
          [workspaceId, goalRunId, change],
        );
        const found = result.rows[0];
        if (!found) throw new Error(`no GoalRunUpdated{${change}} for ${goalRunId}`);
        return found;
      });
      await goals.emit(String(row.id), row.payload);
      return String(row.id);
    }

    const systemMessages = (principalId: string) =>
      inTx(principalId, async (client) => {
        const result = await client.query<MessageRow>(
          `select chat_id, role, content from chat_messages
            where workspace_id = $1 and role = 'system'
            order by chat_id, sequence`,
          [workspaceId],
        );
        return result.rows;
      });

    const goalUpdates = async (principalId: string, goalRunId: string) =>
      (await systemMessages(principalId)).filter(
        (row) => row.content.kind === 'system.goal_update' && row.content.goalRunId === goalRunId,
      );

    const contextKinds = (principalId: string, subjectId: string) =>
      inTx(principalId, async (client) => {
        const result = await client.query<{ kind: string; chat_id: string | null }>(
          `select kind, chat_id from pending_context_items
            where workspace_id = $1 and principal_id = $2 and subject_id = $3
            order by created_at, id`,
          [workspaceId, principalId, subjectId],
        );
        return result.rows;
      });

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      privateKey = (await generateEphemeralHandleKeyPair()).privateKey;
      workspaceId = randomUUID();
      ownerId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'go5e2-goal-consumer',
          ]);
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'owner', 'owner')",
            [workspaceId, ownerId],
          );
        },
        { skipRoleSwitch: true },
      );
      const proposed = await inTx(ownerId, (client) =>
        proposeWorkerDefinition(client, workspaceId, ownerId, {
          kind: 'worker',
          definition: { systemPrompt: 'You do one step of a goal.' },
        }),
      );
      await inTx(ownerId, (client) =>
        publishWorkerDefinition(client, workspaceId, ownerId, {
          definitionId: proposed.id,
          version: proposed.version,
        }),
      );
      worker = { definitionId: proposed.id, version: proposed.version };
      registerGoalRunUpdatedConsumer(goals, { pool });
      registerTaskUpdatedConsumer(tasks, { pool });
      registerBudgetWarningConsumer(budgets, { pool });
    });

    afterAll(async () => {
      // Leave nothing for another file's kernel to advance.
      await admin(async (client) => {
        await client.query('set local session_replication_role = replica');
        await client.query(
          `update goal_runs set status = 'cancelled', pause_reason = null, paused_by = null,
                  paused_by_authority = null, ended_at = now(), next_tick_at = null
            where workspace_id = $1 and status not in ('completed', 'cancelled', 'failed')`,
          [workspaceId],
        );
      });
      await pool.end();
    });

    it("lands in the chat the goal was proposed from, not the requester's latest; the proposal is no context item, the confirmation is", async () => {
      const requester = await newPrincipal();
      const origin = await inTx(requester, (client) => newChat(client, workspaceId, requester, {}));
      const turnId = await turnIn(requester, origin.id);
      // A newer chat: the default target for anything with no conversation behind it.
      const newer = await inTx(requester, (client) => newChat(client, workspaceId, requester, {}));
      const goalRunId = await propose(requester, turnId);

      await deliverGoalChange(goalRunId, 'propose');
      await confirm(requester, goalRunId);
      await deliverGoalChange(goalRunId, 'confirm');
      // Redelivered, to the same consumer and to a fresh one (a restarted kernel, its in-memory
      // dedupe gone): the same outbox rows write nothing new.
      await deliverGoalChange(goalRunId, 'confirm');
      registerGoalRunUpdatedConsumer(goals, { pool });
      await deliverGoalChange(goalRunId, 'propose');
      await deliverGoalChange(goalRunId, 'confirm');

      const updates = await goalUpdates(requester, goalRunId);
      expect(updates.map((row) => row.chat_id)).toEqual([origin.id, origin.id]);
      expect(updates.map((row) => row.content)).toEqual([
        {
          kind: 'system.goal_update',
          text: `Goal ${goalRunId} was proposed and waits for the requester to confirm it on the Goals page`,
          goalRunId,
          change: 'propose',
          status: 'proposed',
        },
        {
          kind: 'system.goal_update',
          text: `Goal ${goalRunId} was confirmed; its steps are starting`,
          goalRunId,
          change: 'confirm',
          status: 'running',
        },
      ]);
      // The statement is free text a read masks: never copied into the chat.
      expect(JSON.stringify(updates)).not.toContain('keep the stock list current');
      expect(
        (await systemMessages(requester)).filter((row) => row.chat_id === newer.id),
      ).toHaveLength(0);

      expect(await contextKinds(requester, goalRunId)).toEqual([
        { kind: 'goal_update', chat_id: origin.id },
      ]);
      const nextTurn = await turnIn(requester, origin.id, true);
      const leased = await inTx(requester, (client) =>
        leaseContextItemsToTurn(client, workspaceId, requester, {
          turnId: nextTurn,
          chatId: origin.id,
        }),
      );
      await inTx(requester, (client) => endActivity(client, workspaceId, nextTurn, 'completed'));
      expect(leased.tasks).toEqual([updates[1]?.content]);
      expect(leased.pendingApprovals).toEqual([]);
    });

    it("a goal proposed with no conversation behind it goes to the requester's most recent chat", async () => {
      const requester = await newPrincipal();
      await inTx(requester, (client) => newChat(client, workspaceId, requester, {}));
      const latest = await inTx(requester, (client) => newChat(client, workspaceId, requester, {}));
      const goalRunId = await propose(requester);
      await deliverGoalChange(goalRunId, 'propose');
      expect((await goalUpdates(requester, goalRunId)).map((row) => row.chat_id)).toEqual([
        latest.id,
      ]);
    });

    it("a pause says why; an owner's hold and its release say who may resume; a change read after the run moved on keeps only its own status", async () => {
      const requester = await newPrincipal();
      const origin = await inTx(requester, (client) => newChat(client, workspaceId, requester, {}));
      const goalRunId = await propose(requester, await turnIn(requester, origin.id));
      await confirm(requester, goalRunId);
      await inTx(requester, (client) =>
        pauseGoalRun(client, workspaceId, {
          goalRunId,
          actor: { principalId: requester, role: 'member' },
        }),
      );
      // The confirmation's event, consumed only now that the run is paused: it still reads as the
      // confirmation, without the pause's sub-state.
      await deliverGoalChange(goalRunId, 'confirm');
      await deliverGoalChange(goalRunId, 'pause');
      await inTx(ownerId, (client) =>
        pauseGoalRun(client, workspaceId, {
          goalRunId,
          actor: { principalId: ownerId, role: 'owner' },
        }),
      );
      await deliverGoalChange(goalRunId, 'hold');
      await inTx(ownerId, (client) =>
        releaseGoalRunHold(client, workspaceId, {
          goalRunId,
          actor: { principalId: ownerId, role: 'owner' },
        }),
      );
      await deliverGoalChange(goalRunId, 'release_hold');

      const contents = (await goalUpdates(requester, goalRunId)).map((row) => row.content);
      expect(contents).toEqual([
        expect.objectContaining({ change: 'confirm', status: 'running' }),
        {
          kind: 'system.goal_update',
          text: `Goal ${goalRunId} paused: a person asked for it`,
          goalRunId,
          change: 'pause',
          status: 'paused',
          pauseReason: 'requested',
        },
        expect.objectContaining({
          change: 'hold',
          status: 'paused',
          pauseReason: 'requested',
          heldByOwner: true,
        }),
        expect.objectContaining({
          change: 'release_hold',
          status: 'paused',
          pauseReason: 'requested',
        }),
      ]);
      expect(contents[0]).not.toHaveProperty('pauseReason');
      expect(contents[3]).not.toHaveProperty('heldByOwner');
      // Every change but the proposal is the agent's to know.
      expect((await contextKinds(requester, goalRunId)).map((row) => row.kind)).toEqual([
        'goal_update',
        'goal_update',
        'goal_update',
        'goal_update',
      ]);
    });

    it('an event written before `change` existed reads by its status alone', async () => {
      const requester = await newPrincipal();
      const origin = await inTx(requester, (client) => newChat(client, workspaceId, requester, {}));
      const goalRunId = await propose(requester, await turnIn(requester, origin.id));
      await goals.emit(String(9_000_000_000 + Math.floor(Math.random() * 1_000_000)), {
        type: 'GoalRunUpdated',
        workspaceId,
        goalRunId,
        status: 'proposed',
      });
      const [update] = await goalUpdates(requester, goalRunId);
      expect(update?.content).toEqual({
        kind: 'system.goal_update',
        text: `Goal ${goalRunId} is now "proposed"`,
        goalRunId,
        status: 'proposed',
      });
      // Not known to be the proposal: the agent hears of it.
      expect((await contextKinds(requester, goalRunId)).map((row) => row.kind)).toEqual([
        'goal_update',
      ]);
    });

    it("a goal step's Task reports into the goal's chat under its step, with no context item of its own — not even a budget warning", async () => {
      const requester = await newPrincipal();
      const origin = await inTx(requester, (client) => newChat(client, workspaceId, requester, {}));
      const goalRunId = await propose(requester, await turnIn(requester, origin.id));
      await inTx(requester, (client) => newChat(client, workspaceId, requester, {}));
      await confirm(requester, goalRunId);
      const advanced = await advanceGoalRun(
        { pool, taskRuntime: { pool, privateKey, supervisorClient } },
        { workspaceId, goalRunId, requesterId: requester },
      );
      const [taskId] = advanced.startedTaskIds;
      if (!taskId) throw new Error('the step started no Task');
      const workerRunId = await admin(async (client) => {
        const result = await client.query<{ id: string }>(
          'select id from worker_runs where workspace_id = $1 and task_id = $2',
          [workspaceId, taskId],
        );
        const id = result.rows[0]?.id;
        if (!id) throw new Error(`Task ${taskId} has no WorkerRun`);
        return id;
      });
      await inTx(requester, (client) =>
        completeTaskWithResult(client, workspaceId, requester, taskId, workerRunId, {
          summary: 'collected',
        }),
      );
      const completed = await admin(async (client) => {
        const result = await client.query<{ id: string; payload: TaskUpdatedEvent }>(
          `select id, payload from outbox
            where workspace_id = $1 and event_type = 'TaskUpdated'
              and payload->>'taskId' = $2 and payload->>'status' = 'completed'`,
          [workspaceId, taskId],
        );
        const row = result.rows[0];
        if (!row) throw new Error('expected a TaskUpdated{completed} row');
        return row;
      });
      await tasks.emit(String(completed.id), completed.payload);
      // The step's token budget is carved from the goal's (`application/task/invoke.ts`), so its
      // Task can cross 80% like any other; that is the goal's business, not the agent's.
      await budgets.emit(String(9_000_000_000 + Math.floor(Math.random() * 1_000_000)), {
        type: 'BudgetWarning',
        workspaceId,
        scope: 'task',
        taskId,
        percent: 85,
      });

      const lines = (await systemMessages(requester)).filter(
        (row) => row.content.kind === 'system.task_update' && row.content.taskId === taskId,
      );
      expect(lines).toHaveLength(1);
      expect(lines[0]?.chat_id).toBe(origin.id);
      expect(lines[0]?.content).toMatchObject({
        text: `Goal step "collect": task ${taskId} completed`,
        status: 'completed',
        summary: 'collected',
        goalRunId,
        stepKey: 'collect',
      });
      expect(await contextKinds(requester, taskId)).toEqual([]);
    });
  },
);
