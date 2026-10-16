import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IllegalTransition, type TaskFailureReason } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { type PoolLike, createPool, withWorkspace } from '../../adapters/db/pool.js';
import type {
  TaskSpawnInput,
  TaskSpawnOutcome,
  TaskSupervisorClientPort,
  TaskSupervisorStatus,
} from '../../adapters/supervisor-client/index.js';
import {
  ApprovalDrainer,
  approveActionRequest,
  getActionRequest,
  markActionRequestExecuted,
  requestAction,
  startActionRequestExecution,
  withdrawActionRequest,
} from '../../governance/approval/index.js';
import { generateEphemeralHandleKeyPair } from '../../governance/capability/index.js';
import {
  SYSTEM_ACTOR_PLACEHOLDER,
  registerGatekeeper,
} from '../../governance/gatekeepers/index.js';
import { checkIG1, checkIG9 } from '../../substrate/audit/goal-invariant-checks.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import type { DomainEvent } from '../../substrate/outbox/index.js';
import { createAdminWithTransaction } from '../gateway/action-executor.js';
import { registerActionRequestDrainConsumer } from '../gateway/action-request-drain-consumer.js';
import {
  GoalStepClosedError,
  RunConfigSnapshotSchema,
  type TaskRuntimeDeps,
  completeTaskWithResult,
  lockGoalStepForNewWork,
  reactToSupervisorStatus,
} from '../task/index.js';
import { failTaskAndReapWorkerRuns } from '../task/lifecycle.js';
import { proposeWorkerDefinition, publishWorkerDefinition } from '../worker/index.js';
import {
  DEFAULT_BLOCKED_RETRY_RECHECK_MS,
  type GoalAdvancerOptions,
  advanceGoalRun,
} from './advance.js';
import {
  type GoalWakeEventSource,
  claimDueGoalRuns,
  markReconcileDue,
  registerGoalWakeConsumer,
  sweepGoalCancelCleanup,
} from './advancer.js';
import { GOAL_CANCELLED_WITHDRAW_REASON } from './cancelling.js';
import { cancelGoalRun, pauseGoalRun, resumeGoalRun } from './control.js';
import { GoalPlanValidationError } from './plan.js';
import { getGoalRun, listStepRuns } from './reads.js';
import { GoalRunStateError, confirmGoalRun, createGoalRun } from './service.js';
import type { GoalRunBudget, GoalRunRow, StepRunRow } from './types.js';

/**
 * application/goal/advancer.integration (S11 GO2, GO3a): the deterministic advancer against real
 * Postgres and the real Task path (`createStepAttemptTask` → `spawnWorkerRun` → the Handle mint),
 * with an in-memory worker-supervisor. The scenarios are the plan's §7.2 rows GO2 owns — S1, S2,
 * S3, S9, S10, S12 — plus the rules around them: confirmation (I-G3), retries and backoff, the wait
 * on the step (§4.8), plan fencing (I-G2) and pinned configuration (§4.4); and GO3a's: a person
 * pausing, resuming and cancelling a run, S7, the I-G9 entry check and the goal's token headroom.
 *
 * Every test advances its own GoalRuns by id (`advanceGoalRun`): the claim and the reconcile scan
 * are cross-workspace, and the shared database holds other files' rows, so tests that exercise
 * them look only for their own runs in the result. Each test's requester is a fresh member — a
 * test leaves running Tasks behind, and they count against that principal's concurrency quota.
 *
 * Gated on `DATABASE_URL`.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

const BUDGET: GoalRunBudget = {
  maxTokens: 1_000_000,
  maxSteps: 50,
  maxRevisions: 5,
  maxWallClockSeconds: 3600,
};
const NO_BACKOFF: GoalAdvancerOptions = { retryBackoffMs: () => 0 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every spawn starts `running`; tests move a run's status to simulate a crash. */
class FakeTaskSupervisorClient implements TaskSupervisorClientPort {
  readonly spawnCalls: TaskSpawnInput[] = [];
  readonly statuses = new Map<string, TaskSupervisorStatus>();

  async spawn(input: TaskSpawnInput): Promise<TaskSpawnOutcome> {
    this.spawnCalls.push(input);
    const containerId = `container-${input.workerRunId}`;
    this.statuses.set(input.workerRunId, {
      workerRunId: input.workerRunId,
      status: 'running',
      exitCode: undefined,
      containerId,
      ip: '198.51.100.20',
      startedAt: new Date().toISOString(),
      finishedAt: undefined,
      reason: undefined,
    });
    return { containerId, ip: '198.51.100.20' };
  }

  async terminate(workerRunId: string): Promise<boolean> {
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

/** Records the wake consumer's subscriptions so a test delivers events by hand. */
class FakeWakeSource implements GoalWakeEventSource {
  private readonly consumers = new Map<string, (event: DomainEvent) => Promise<void> | void>();

  subscribe<T extends 'TaskUpdated' | 'ActionRequestUpdated'>(
    eventType: T,
    consumer: (event: Extract<DomainEvent, { type: T }>) => Promise<void> | void,
  ): () => void {
    this.consumers.set(eventType, consumer as (event: DomainEvent) => Promise<void> | void);
    return () => {
      this.consumers.delete(eventType);
    };
  }

  async deliver(event: DomainEvent): Promise<void> {
    await this.consumers.get(event.type)?.(event);
  }
}

interface StepSpec {
  readonly key: string;
  readonly dependsOn?: readonly string[];
  readonly maxAttempts?: number;
  readonly input?: unknown;
}

interface AttemptTaskRow {
  id: string;
  status: string;
  step_attempt: number;
  failure_reason: string | null;
  run_config_snapshot: unknown;
  token_budget: string | null;
  duration_limit_sec: number;
  plan_revision: number;
  goal_run_id: string;
  on_behalf_of: string;
  created_by_activity_id: string | null;
}

describe.runIf(DATABASE_URL !== undefined)(
  'application/goal advancer (S11 GO2, integration, real Postgres)',
  () => {
    let pool: Pool;
    let privateKey: Awaited<ReturnType<typeof generateEphemeralHandleKeyPair>>['privateKey'];
    let workspaceId: string;
    let ownerId: string;
    let worker: { definitionId: string; version: number };
    const supervisor = new FakeTaskSupervisorClient();

    const taskRuntime = (overrides: Partial<TaskRuntimeDeps> = {}): TaskRuntimeDeps => ({
      pool,
      privateKey,
      supervisorClient: supervisor,
      ...overrides,
    });

    const admin = <T>(fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId, principalId: ownerId }, fn, { skipRoleSwitch: true });

    /** A write with the guards off — for state the GO2 write paths cannot reach yet (a revision
     *  adopted without GO3's revise path) or a test fixture (a deprecated version). */
    const raw = <T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) =>
      admin(async (client) => {
        await client.query('set local session_replication_role = replica');
        return (await client.query(sql, [...params])).rows as T[];
      });

    const asRequester = <T>(requesterId: string, fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId, principalId: requesterId }, fn);

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

    async function publish(definition: Record<string, unknown>) {
      const proposed = await asRequester(ownerId, (client) =>
        proposeWorkerDefinition(client, workspaceId, ownerId, { kind: 'worker', definition }),
      );
      await asRequester(ownerId, (client) =>
        publishWorkerDefinition(client, workspaceId, ownerId, {
          definitionId: proposed.id,
          version: proposed.version,
        }),
      );
      return { definitionId: proposed.id, version: proposed.version };
    }

    function planOf(steps: readonly StepSpec[], ref = worker) {
      return {
        steps: steps.map((step) => ({
          key: step.key,
          worker: ref,
          input: step.input ?? { step: step.key },
          ...(step.dependsOn ? { dependsOn: step.dependsOn } : {}),
          ...(step.maxAttempts ? { maxAttempts: step.maxAttempts } : {}),
        })),
      };
    }

    async function proposeGoal(
      requesterId: string,
      steps: readonly StepSpec[],
      budget: GoalRunBudget = BUDGET,
      ref = worker,
    ): Promise<string> {
      const created = await asRequester(requesterId, (client) =>
        createGoalRun(client, workspaceId, {
          requesterId,
          proposedBy: requesterId,
          statement: 'reach the goal',
          plan: planOf(steps, ref),
          budget,
        }),
      );
      return created.goalRunId;
    }

    async function startGoal(
      requesterId: string,
      steps: readonly StepSpec[],
      budget: GoalRunBudget = BUDGET,
      ref = worker,
    ): Promise<string> {
      const goalRunId = await proposeGoal(requesterId, steps, budget, ref);
      await asRequester(requesterId, (client) =>
        confirmGoalRun(client, workspaceId, { goalRunId, confirmedBy: requesterId }),
      );
      return goalRunId;
    }

    const startErrors: unknown[] = [];

    function advance(
      goalRunId: string,
      requesterId: string,
      options: GoalAdvancerOptions = NO_BACKOFF,
      overrides: { pool?: PoolLike; taskRuntime?: TaskRuntimeDeps } = {},
    ) {
      return advanceGoalRun(
        {
          pool: overrides.pool ?? pool,
          taskRuntime: overrides.taskRuntime ?? taskRuntime(),
          options,
          onStartError: (err) => startErrors.push(err),
        },
        { workspaceId, goalRunId, requesterId },
      );
    }

    const goalOf = async (goalRunId: string): Promise<GoalRunRow> => {
      const goal = await admin((client) => getGoalRun(client, workspaceId, goalRunId));
      if (!goal) throw new Error(`no goal run ${goalRunId}`);
      return goal;
    };

    async function stepsOf(goalRunId: string): Promise<Record<string, StepRunRow>> {
      const rows = await admin((client) => listStepRuns(client, workspaceId, goalRunId));
      return Object.fromEntries(
        rows.filter((row) => row.status !== 'superseded').map((row) => [row.stepKey, row]),
      );
    }

    const attemptTasks = (stepRunId: string) =>
      admin(async (client) => {
        const result = await client.query<AttemptTaskRow>(
          `select id, status, step_attempt, failure_reason, run_config_snapshot, token_budget,
                  duration_limit_sec, plan_revision, goal_run_id, on_behalf_of,
                  created_by_activity_id
             from tasks
            where workspace_id = $1 and step_run_id = $2 and step_attempt is not null
            order by step_attempt`,
          [workspaceId, stepRunId],
        );
        return result.rows;
      });

    const goalTaskCount = async (goalRunId: string) =>
      Number(
        (
          await admin((client) =>
            client.query<{ count: string }>(
              'select count(*) from tasks where workspace_id = $1 and goal_run_id = $2',
              [workspaceId, goalRunId],
            ),
          )
        ).rows[0]?.count,
      );

    const runsOf = (taskId: string) =>
      admin(async (client) => {
        const result = await client.query<{ id: string; status: string }>(
          'select id, status from worker_runs where workspace_id = $1 and task_id = $2 order by started_at, id',
          [workspaceId, taskId],
        );
        return result.rows;
      });

    async function latestAttempt(stepRunId: string): Promise<AttemptTaskRow> {
      const tasks = await attemptTasks(stepRunId);
      const latest = tasks[tasks.length - 1];
      if (!latest) throw new Error(`step ${stepRunId} has no attempt Task`);
      return latest;
    }

    async function latestRun(stepRunId: string): Promise<string> {
      const task = await latestAttempt(stepRunId);
      const [run] = await runsOf(task.id);
      if (!run) throw new Error(`attempt Task ${task.id} has no WorkerRun`);
      return run.id;
    }

    /** The Worker of the step's latest attempt reports its result (`report_task_result`). */
    async function completeStep(stepRunId: string, requesterId: string): Promise<string> {
      const task = await latestAttempt(stepRunId);
      const runId = await latestRun(stepRunId);
      await asRequester(requesterId, (client) =>
        completeTaskWithResult(client, workspaceId, requesterId, task.id, runId, {
          summary: 'done',
        }),
      );
      return task.id;
    }

    async function failStep(stepRunId: string, requesterId: string, reason: TaskFailureReason) {
      const task = await latestAttempt(stepRunId);
      await failTaskAndReapWorkerRuns(taskRuntime(), workspaceId, requesterId, task.id, reason);
      return task.id;
    }

    /** An ActionRequest of the step, raised by `workerRunId`. */
    async function seedAction(
      stepRunId: string,
      workerRunId: string | null,
      status: string,
      failureKind: string | null = null,
    ): Promise<string> {
      const rows = await raw<{ id: string }>(
        `insert into action_requests (workspace_id, status, gatekeeper_id, action_kind, blast_radius,
           policy_decision, await_decision, on_behalf_of, actor_runtime, requested_at,
           step_run_id, parent_worker_run_id, failure_kind)
         values ($1, $2, $3, 'test.go2.action', 'low', $4, false, $5, 'pi', now(), $6, $7, $8)
         returning id`,
        [
          workspaceId,
          status,
          randomUUID(),
          // The table's checks tie executing/executed under `require_approval`, and approved/rejected,
          // to a decision row; the advancer reads only the status, so the fixture skips them.
          status === 'denied' ? 'deny' : 'allow',
          ownerId,
          stepRunId,
          workerRunId,
          failureKind,
        ],
      );
      return rows[0]?.id as string;
    }

    const setActionStatus = (id: string, status: string, failureKind: string | null = null) =>
      raw(
        'update action_requests set status = $3, failure_kind = $4 where workspace_id = $1 and id = $2',
        [workspaceId, id, status, failureKind],
      );

    const isDue = async (goalRunId: string) =>
      (
        await admin((client) =>
          client.query<{ due: boolean | null }>(
            'select next_tick_at <= now() as due from goal_runs where workspace_id = $1 and id = $2',
            [workspaceId, goalRunId],
          ),
        )
      ).rows[0]?.due === true;

    const outboxCount = async (eventType: string, goalRunId: string) =>
      Number(
        (
          await admin((client) =>
            client.query<{ count: string }>(
              `select count(*) from outbox
                where workspace_id = $1 and event_type = $2 and payload ->> 'goalRunId' = $3`,
              [workspaceId, eventType, goalRunId],
            ),
          )
        ).rows[0]?.count,
      );

    const stepAudit = (goalRunId: string) =>
      admin(async (client) => {
        const result = await client.query<{
          action: string;
          actor_principal_id: string;
          resource_id: string;
          payload: Record<string, unknown>;
        }>(
          `select action, actor_principal_id, resource_id, payload from audit_records
            where workspace_id = $1 and resource_type = 'step_run' and payload ->> 'goalRunId' = $2
            order by created_at, id`,
          [workspaceId, goalRunId],
        );
        return result.rows;
      });

    const goalAudit = (goalRunId: string) =>
      admin(async (client) => {
        const result = await client.query<{ action: string; payload: Record<string, unknown> }>(
          `select action, payload from audit_records
            where workspace_id = $1 and resource_type = 'goal_run' and resource_id = $2
            order by created_at, id`,
          [workspaceId, goalRunId],
        );
        return result.rows;
      });

    /** Adopts a revision 2 of `steps` without superseding anything — what GO3's revise path must
     *  never leave, written with the guards off. */
    async function adoptUnsupersededRevision(
      goalRunId: string,
      requesterId: string,
      steps: readonly StepSpec[],
    ) {
      await raw(
        `insert into plan_revisions (workspace_id, goal_run_id, revision, based_on_revision, status,
           plan, proposed_by, decided_by, decided_at)
         values ($1, $2, 2, 1, 'accepted', $3::jsonb, $4, $4, now())`,
        [workspaceId, goalRunId, JSON.stringify(planOf(steps)), requesterId],
      );
      await raw('update goal_runs set current_revision = 2 where workspace_id = $1 and id = $2', [
        workspaceId,
        goalRunId,
      ]);
    }

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
            'go2-goal-advancer',
          ]);
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'owner', 'owner')",
            [workspaceId, ownerId],
          );
        },
        { skipRoleSwitch: true },
      );
      worker = await publish({ systemPrompt: 'You do one step of a goal.' });
    });

    afterAll(async () => {
      // Leave nothing for another file's kernel to advance: this file's runs end here.
      await raw(
        `update goal_runs set status = 'cancelled', pause_reason = null, ended_at = now(),
                next_tick_at = null
          where workspace_id = $1 and status not in ('completed', 'cancelled', 'failed')`,
        [workspaceId],
      );
      await pool.end();
    });

    // -------------------------------------------------------------------------------------------

    describe('proposing and confirming (I-G3)', () => {
      it('only the requester confirms; revision 1 is accepted and adopted together; steps start pending', async () => {
        const requester = await newPrincipal();
        const someoneElse = await newPrincipal();
        const goalRunId = await proposeGoal(requester, [
          { key: 'a' },
          { key: 'b', dependsOn: ['a'] },
        ]);
        expect((await goalOf(goalRunId)).status).toBe('proposed');
        expect(await stepsOf(goalRunId)).toEqual({});

        for (const other of [someoneElse, ownerId]) {
          await expect(
            asRequester(other, (client) =>
              confirmGoalRun(client, workspaceId, { goalRunId, confirmedBy: other }),
            ),
          ).rejects.toBeInstanceOf(GoalRunStateError);
        }

        await asRequester(requester, (client) =>
          confirmGoalRun(client, workspaceId, { goalRunId, confirmedBy: requester }),
        );
        const goal = await goalOf(goalRunId);
        expect(goal).toMatchObject({ status: 'running', currentRevision: 1 });
        expect(goal.confirmedAt).not.toBeNull();
        expect(await isDue(goalRunId)).toBe(true);
        const revision = await admin((client) =>
          client.query<{ status: string; decided_by: string }>(
            'select status, decided_by from plan_revisions where workspace_id = $1 and goal_run_id = $2',
            [workspaceId, goalRunId],
          ),
        );
        expect(revision.rows).toEqual([{ status: 'accepted', decided_by: requester }]);
        const steps = await stepsOf(goalRunId);
        expect(Object.keys(steps).sort()).toEqual(['a', 'b']);
        for (const step of Object.values(steps)) {
          expect(step).toMatchObject({
            status: 'pending',
            attemptCount: 0,
            introducedInRevision: 1,
          });
        }
        expect(await goalTaskCount(goalRunId)).toBe(0);

        await expect(
          asRequester(requester, (client) =>
            confirmGoalRun(client, workspaceId, { goalRunId, confirmedBy: requester }),
          ),
        ).rejects.toBeInstanceOf(GoalRunStateError);
      });

      it('refuses a plan with a cycle, an unknown dependency or an unpublished worker', async () => {
        const requester = await newPrincipal();
        const propose = (plan: unknown) =>
          asRequester(requester, (client) =>
            createGoalRun(client, workspaceId, {
              requesterId: requester,
              proposedBy: requester,
              statement: 'bad plan',
              plan,
              budget: BUDGET,
            }),
          );
        await expect(
          propose(
            planOf([
              { key: 'a', dependsOn: ['b'] },
              { key: 'b', dependsOn: ['a'] },
            ]),
          ),
        ).rejects.toBeInstanceOf(GoalPlanValidationError);
        await expect(propose(planOf([{ key: 'a', dependsOn: ['nope'] }]))).rejects.toBeInstanceOf(
          GoalPlanValidationError,
        );
        await expect(
          propose(planOf([{ key: 'a' }], { definitionId: randomUUID(), version: 1 })),
        ).rejects.toBeInstanceOf(GoalPlanValidationError);
        await expect(
          propose({ steps: [{ key: 'a', worker, acceptance: 'always' }] }),
        ).rejects.toBeInstanceOf(GoalPlanValidationError);
      });
    });

    // -------------------------------------------------------------------------------------------

    describe('S1: A and B in parallel, then C, with nobody in the chat', () => {
      it('runs every step to the end and hands the run to verification', async () => {
        const requester = await newPrincipal();
        const goalRunId = await startGoal(requester, [
          { key: 'a' },
          { key: 'b' },
          { key: 'c', dependsOn: ['a', 'b'] },
        ]);
        const spawnsBefore = supervisor.spawnCalls.length;

        const first = await advance(goalRunId, requester);
        expect(first.startedTaskIds).toHaveLength(2);
        let steps = await stepsOf(goalRunId);
        expect(steps.a).toMatchObject({ status: 'running', attemptCount: 1 });
        expect(steps.b).toMatchObject({ status: 'running', attemptCount: 1 });
        expect(steps.c?.status).toBe('pending');
        expect(supervisor.spawnCalls.length - spawnsBefore).toBe(2);

        const [taskA] = await attemptTasks(steps.a?.id as string);
        expect(taskA).toMatchObject({
          status: 'running',
          step_attempt: 1,
          plan_revision: 1,
          goal_run_id: goalRunId,
          on_behalf_of: requester,
          created_by_activity_id: null,
        });
        const snapshot = RunConfigSnapshotSchema.parse(taskA?.run_config_snapshot);
        expect(snapshot.definition).toEqual({ id: worker.definitionId, version: worker.version });
        expect(snapshot.handle.capabilities).not.toContain('invoke_worker');
        expect(snapshot.handle.capabilities).not.toContain('find_workers');
        // A running run is looked at again at its wall-clock deadline at the latest.
        expect(first.nextTickAt).not.toBeNull();

        await completeStep(steps.a?.id as string, requester);
        await advance(goalRunId, requester);
        steps = await stepsOf(goalRunId);
        expect(steps.a?.status).toBe('succeeded');
        expect(steps.b?.status).toBe('running');
        expect(steps.c?.status).toBe('pending');

        await completeStep(steps.b?.id as string, requester);
        const third = await advance(goalRunId, requester);
        steps = await stepsOf(goalRunId);
        expect(steps.b?.status).toBe('succeeded');
        expect(steps.c).toMatchObject({ status: 'running', attemptCount: 1 });
        expect(third.startedTaskIds).toHaveLength(1);

        await completeStep(steps.c?.id as string, requester);
        const last = await advance(goalRunId, requester);
        expect(last).toMatchObject({ status: 'verifying', nextTickAt: null });
        expect((await goalOf(goalRunId)).status).toBe('verifying');

        // Nothing went through the chat: no Turn was started for the run.
        const turns = await admin((client) =>
          client.query<{ count: string }>(
            "select count(*) from outbox where workspace_id = $1 and event_type = 'TurnStarted'",
            [workspaceId],
          ),
        );
        expect(Number(turns.rows[0]?.count)).toBe(0);
        // Every move is the advancer's, made for the requester, audited and announced.
        const audit = await stepAudit(goalRunId);
        expect(audit.length).toBeGreaterThan(0);
        for (const row of audit.filter((entry) => entry.action !== 'step_run.create')) {
          expect(row.actor_principal_id).toBe(requester);
          expect(row.payload.by).toBe('advancer');
        }
        expect(await outboxCount('StepRunUpdated', goalRunId)).toBe(audit.length);
        expect(await outboxCount('GoalRunUpdated', goalRunId)).toBe(3); // propose, confirm, verify
      });
    });

    // -------------------------------------------------------------------------------------------

    describe('S2: a kernel that dies mid-advance or mid-Task loses nothing', () => {
      it('an advance that dies before it commits leaves nothing behind; the run is claimed again after the lease', async () => {
        const requester = await newPrincipal();
        const goalRunId = await startGoal(requester, [{ key: 'a' }, { key: 'b' }]);
        const claimed = await claimDueGoalRuns(pool, { limit: 10_000, leaseMs: 50 });
        expect(claimed.map((target) => target.goalRunId)).toContain(goalRunId);
        expect(await isDue(goalRunId)).toBe(false);

        const crashing: PoolLike = {
          async connect() {
            const client = await pool.connect();
            const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
            (client as { query: unknown }).query = async (...args: unknown[]) => {
              const [text, params] = args as [unknown, unknown[] | undefined];
              if (
                typeof text === 'string' &&
                text.includes('update step_runs') &&
                params?.[2] === 'running'
              ) {
                throw new Error('simulated crash mid-advance');
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
        await expect(advance(goalRunId, requester, NO_BACKOFF, { pool: crashing })).rejects.toThrow(
          'simulated crash mid-advance',
        );
        // The Task insert rolled back with the step's move: no orphan attempt, nothing unblocked.
        expect(await goalTaskCount(goalRunId)).toBe(0);
        const steps = await stepsOf(goalRunId);
        expect(steps.a?.status).toBe('pending');
        expect(steps.b?.status).toBe('pending');

        await sleep(100);
        const again = await claimDueGoalRuns(pool, { limit: 10_000 });
        expect(again.map((target) => target.goalRunId)).toContain(goalRunId);
        await advance(goalRunId, requester);
        const after = await stepsOf(goalRunId);
        for (const key of ['a', 'b']) {
          const step = after[key] as StepRunRow;
          expect(step).toMatchObject({ status: 'running', attemptCount: 1 });
          const tasks = await attemptTasks(step.id);
          expect(tasks.map((task) => task.step_attempt)).toEqual([1]);
          expect(await runsOf(tasks[0]?.id as string)).toHaveLength(1);
        }
      });

      it('a Worker that crashes fails its attempt once, with no Task-internal retry; the step starts a new attempt on the same configuration', async () => {
        const requester = await newPrincipal();
        const goalRunId = await startGoal(requester, [{ key: 'only' }]);
        await advance(goalRunId, requester);
        const step = (await stepsOf(goalRunId)).only as StepRunRow;
        const runId = await latestRun(step.id);

        supervisor.setStatus(runId, { status: 'failed', exitCode: 137, reason: 'crashed' });
        await reactToSupervisorStatus(taskRuntime(), workspaceId, requester, runId);
        const [firstAttempt] = await attemptTasks(step.id);
        expect(firstAttempt).toMatchObject({ status: 'failed', failure_reason: 'worker_failed' });
        expect(await runsOf(firstAttempt?.id as string)).toEqual([
          { id: runId, status: 'terminated' },
        ]);

        // One advance: the attempt is recorded as a transient failure, retried (no backoff here)
        // and the next attempt started.
        const outcome = await advance(goalRunId, requester);
        expect(outcome.startedTaskIds).toHaveLength(1);
        const retried = (await stepsOf(goalRunId)).only as StepRunRow;
        expect(retried).toMatchObject({ status: 'running', attemptCount: 2 });
        const tasks = await attemptTasks(step.id);
        expect(tasks.map((task) => [task.step_attempt, task.status])).toEqual([
          [1, 'failed'],
          [2, 'running'],
        ]);
        const before = RunConfigSnapshotSchema.parse(tasks[0]?.run_config_snapshot);
        const now = RunConfigSnapshotSchema.parse(tasks[1]?.run_config_snapshot);
        expect(now.definition).toEqual(before.definition);
        expect(now.skills).toEqual(before.skills);
        expect(now.model).toEqual(before.model);
        expect(now.image).toEqual(before.image);
        // Audit rows of one transaction share `created_at`: compare them as a set.
        const audit = await stepAudit(goalRunId);
        expect(audit.map((row) => row.action).sort()).toEqual(
          [
            'step_run.create',
            'step_run.unblock',
            'step_run.start',
            'step_run.fail',
            'step_run.retry',
            'step_run.start',
          ].sort(),
        );
        expect(audit.find((row) => row.action === 'step_run.fail')?.payload).toMatchObject({
          taskId: tasks[0]?.id,
          attempt: 1,
          taskFailureReason: 'worker_failed',
        });

        await completeStep(step.id, requester);
        expect((await advance(goalRunId, requester)).status).toBe('verifying');
        const ig1 = await pool.connect().then(async (client) => {
          try {
            return await checkIG1(client, 100_000);
          } finally {
            client.release();
          }
        });
        expect(ig1.sample.filter((line) => line.includes(step.id))).toEqual([]);
      });

      it('a kernel that dies between the advance and the spawn leaves a queued Task that comes back as a transient failure', async () => {
        const requester = await newPrincipal();
        const goalRunId = await startGoal(requester, [{ key: 'only' }]);
        const gone: PoolLike = {
          connect: () => Promise.reject(new Error('kernel gone')),
        };
        const errorsBefore = startErrors.length;
        const outcome = await advance(goalRunId, requester, NO_BACKOFF, {
          taskRuntime: taskRuntime({ pool: gone }),
        });
        expect(outcome.startedTaskIds).toHaveLength(1);
        expect(startErrors.length).toBeGreaterThan(errorsBefore);
        const step = (await stepsOf(goalRunId)).only as StepRunRow;
        expect(step).toMatchObject({ status: 'running', attemptCount: 1 });
        const [queued] = await attemptTasks(step.id);
        expect(queued?.status).toBe('queued');
        expect(await runsOf(queued?.id as string)).toEqual([]);

        // What the reaper's `spawn_lost` sweep does to it after its threshold (reaper tests).
        await failTaskAndReapWorkerRuns(
          taskRuntime(),
          workspaceId,
          requester,
          queued?.id as string,
          'spawn_lost',
        );
        await advance(goalRunId, requester);
        const tasks = await attemptTasks(step.id);
        expect(tasks.map((task) => [task.step_attempt, task.status, task.failure_reason])).toEqual([
          [1, 'failed', 'spawn_lost'],
          [2, 'running', null],
        ]);
        expect(await runsOf(tasks[1]?.id as string)).toHaveLength(1);
      });
    });

    // -------------------------------------------------------------------------------------------

    describe('S3: duplicate events neither duplicate Tasks nor advances', () => {
      it('wakes once per real change; a second advance on the same state moves nothing', async () => {
        const requester = await newPrincipal();
        const goalRunId = await startGoal(requester, [
          { key: 'a' },
          { key: 'b', dependsOn: ['a'] },
        ]);
        await advance(goalRunId, requester);
        expect(await isDue(goalRunId)).toBe(false);
        const source = new FakeWakeSource();
        const wakeErrors: unknown[] = [];
        const unsubscribe = registerGoalWakeConsumer(source, pool, (err) => wakeErrors.push(err));
        try {
          const stepA = (await stepsOf(goalRunId)).a as StepRunRow;
          const taskA = await latestAttempt(stepA.id);

          // A Task that merely started does not wake the run.
          await source.deliver({
            type: 'TaskUpdated',
            workspaceId,
            taskId: taskA.id,
            status: 'running',
          });
          expect(await isDue(goalRunId)).toBe(false);

          await completeStep(stepA.id, requester);
          const finished: DomainEvent = {
            type: 'TaskUpdated',
            workspaceId,
            taskId: taskA.id,
            status: 'completed',
          };
          await source.deliver(finished);
          await source.deliver(finished);
          expect(await isDue(goalRunId)).toBe(true);

          await advance(goalRunId, requester);
          const stepEvents = await outboxCount('StepRunUpdated', goalRunId);
          const audit = await stepAudit(goalRunId);
          // The duplicate is delivered again after the advance, and the run advanced again.
          await source.deliver(finished);
          const repeat = await advance(goalRunId, requester);
          expect(repeat.startedTaskIds).toEqual([]);
          expect(await outboxCount('StepRunUpdated', goalRunId)).toBe(stepEvents);
          expect(await stepAudit(goalRunId)).toHaveLength(audit.length);
          const stepB = (await stepsOf(goalRunId)).b as StepRunRow;
          expect((await attemptTasks(stepB.id)).map((task) => task.step_attempt)).toEqual([1]);

          // ActionRequestUpdated: an action of the step that left flight wakes the run, twice
          // delivered or not; one still in flight does not.
          const runB = await latestRun(stepB.id);
          const pending = await seedAction(stepB.id, runB, 'pending_approval');
          await advance(goalRunId, requester);
          await source.deliver({
            type: 'ActionRequestUpdated',
            workspaceId,
            actionRequestId: pending,
            status: 'pending_approval',
          });
          expect(await isDue(goalRunId)).toBe(false);
          await setActionStatus(pending, 'executed');
          const executed: DomainEvent = {
            type: 'ActionRequestUpdated',
            workspaceId,
            actionRequestId: pending,
            status: 'executed',
          };
          await source.deliver(executed);
          await source.deliver(executed);
          expect(await isDue(goalRunId)).toBe(true);
          // An event about a request the run does not know is ignored.
          await source.deliver({
            type: 'ActionRequestUpdated',
            workspaceId,
            actionRequestId: randomUUID(),
            status: 'executed',
          });
          expect(wakeErrors).toEqual([]);
        } finally {
          unsubscribe();
        }
      });
    });

    // -------------------------------------------------------------------------------------------

    describe('S9: a requester who lost authority starts nothing (I-G7)', () => {
      async function gatedSetup() {
        const requester = await newPrincipal();
        const gatekeeperId = await admin(async (client) => {
          const activity = await startActivity(client, workspaceId, {
            kind: 'test.connection',
            principalId: ownerId,
          });
          const registered = await registerGatekeeper(client, workspaceId, {
            name: `go2-gate-${randomUUID().slice(0, 8)}`,
            transportKind: 'http',
            target: 'example-system',
            endpoint: 'http://127.0.0.1:9',
            connectionSecretSalt: 'go2-salt',
            activityId: activity.id,
            registeredBy: { id: ownerId, kind: 'human' },
          });
          await client.query(
            `insert into capability_grants (workspace_id, principal_id, resource_type, resource_id, granted_by)
             values ($1, $2, 'gatekeeper', $3::uuid, $4)`,
            [workspaceId, requester, registered.gatekeeperId, ownerId],
          );
          return registered.gatekeeperId;
        });
        const gated = await publish({
          systemPrompt: 'You act on a gate.',
          capabilities: ['request_action'],
          gates: [gatekeeperId],
        });
        return { requester, gatekeeperId, gated };
      }

      it('a revoked gate grant pauses the run authority_lost before the next step starts', async () => {
        const { requester, gatekeeperId, gated } = await gatedSetup();
        const goalRunId = await startGoal(
          requester,
          [{ key: 'a' }, { key: 'b', dependsOn: ['a'] }],
          BUDGET,
          gated,
        );
        await advance(goalRunId, requester);
        const stepA = (await stepsOf(goalRunId)).a as StepRunRow;
        const snapshot = RunConfigSnapshotSchema.parse(
          (await latestAttempt(stepA.id)).run_config_snapshot,
        );
        expect(snapshot.handle.gatekeepers).toEqual([gatekeeperId]);

        await admin((client) =>
          client.query(
            `update capability_grants set status = 'revoked', revoked_at = now()
              where workspace_id = $1 and principal_id = $2`,
            [workspaceId, requester],
          ),
        );
        await completeStep(stepA.id, requester);
        const outcome = await advance(goalRunId, requester);
        expect(outcome.status).toBe('paused');
        const goal = await goalOf(goalRunId);
        expect(goal).toMatchObject({ status: 'paused', pauseReason: 'authority_lost' });
        const steps = await stepsOf(goalRunId);
        expect(steps.a?.status).toBe('succeeded');
        expect(steps.b).toMatchObject({ status: 'ready', attemptCount: 0 });
        expect(await attemptTasks(steps.b?.id as string)).toEqual([]);
        // Paused: nothing scheduled until a person or an event moves it.
        expect(outcome.nextTickAt).toBeNull();
      });

      it('a requester demoted to a role that cannot start Workers, or disabled, starts nothing', async () => {
        for (const demote of [
          "update principals set role = 'auditor' where workspace_id = $1 and id = $2",
          'update principals set disabled_at = now() where workspace_id = $1 and id = $2',
        ]) {
          const requester = await newPrincipal();
          const goalRunId = await startGoal(requester, [
            { key: 'a' },
            { key: 'b', dependsOn: ['a'] },
          ]);
          await advance(goalRunId, requester);
          const stepA = (await stepsOf(goalRunId)).a as StepRunRow;
          await completeStep(stepA.id, requester);
          await raw(demote, [workspaceId, requester]);
          await advance(goalRunId, requester);
          expect(await goalOf(goalRunId)).toMatchObject({
            status: 'paused',
            pauseReason: 'authority_lost',
          });
          const stepB = (await stepsOf(goalRunId)).b as StepRunRow;
          expect(stepB.status).toBe('ready');
          expect(await attemptTasks(stepB.id)).toEqual([]);
        }
      });
    });

    // -------------------------------------------------------------------------------------------

    describe('S10: budgets pause the run, never fail it (I-G6)', () => {
      it('tokens past the budget pause it budget_exhausted; an attempt is capped by what is left', async () => {
        const requester = await newPrincipal();
        const goalRunId = await startGoal(
          requester,
          [{ key: 'a' }, { key: 'b', dependsOn: ['a'] }],
          { ...BUDGET, maxTokens: 1000 },
        );
        await advance(goalRunId, requester);
        const stepA = (await stepsOf(goalRunId)).a as StepRunRow;
        const taskA = await latestAttempt(stepA.id);
        expect(taskA.token_budget).not.toBeNull();
        expect(Number(taskA.token_budget)).toBeLessThanOrEqual(1000);
        await admin((client) =>
          client.query('update tasks set tokens_used = 1500 where workspace_id = $1 and id = $2', [
            workspaceId,
            taskA.id,
          ]),
        );
        await completeStep(stepA.id, requester);
        await advance(goalRunId, requester);
        expect(await goalOf(goalRunId)).toMatchObject({
          status: 'paused',
          pauseReason: 'budget_exhausted',
        });
        const steps = await stepsOf(goalRunId);
        expect(steps.a?.status).toBe('succeeded');
        expect(steps.b?.status).toBe('ready');
        expect(await attemptTasks(steps.b?.id as string)).toEqual([]);
      });

      it('the step budget stops the next attempt', async () => {
        const requester = await newPrincipal();
        const goalRunId = await startGoal(
          requester,
          [{ key: 'a' }, { key: 'b', dependsOn: ['a'] }],
          { ...BUDGET, maxSteps: 1 },
        );
        await advance(goalRunId, requester);
        await completeStep(((await stepsOf(goalRunId)).a as StepRunRow).id, requester);
        await advance(goalRunId, requester);
        expect(await goalOf(goalRunId)).toMatchObject({
          status: 'paused',
          pauseReason: 'budget_exhausted',
        });
        expect(await goalTaskCount(goalRunId)).toBe(1);
      });

      it('an attempt that ran out of its budget fails transiently and pauses the run', async () => {
        const requester = await newPrincipal();
        const goalRunId = await startGoal(requester, [{ key: 'only' }]);
        await advance(goalRunId, requester);
        const step = (await stepsOf(goalRunId)).only as StepRunRow;
        await failStep(step.id, requester, 'budget_exhausted');
        await advance(goalRunId, requester);
        expect(await goalOf(goalRunId)).toMatchObject({
          status: 'paused',
          pauseReason: 'budget_exhausted',
        });
        expect((await stepsOf(goalRunId)).only).toMatchObject({
          status: 'failed',
          failureCategory: 'transient',
          attemptCount: 1,
        });
      });

      it('the wall clock pauses it; while running, the deadline is always scheduled', async () => {
        const requester = await newPrincipal();
        const goalRunId = await startGoal(
          requester,
          [{ key: 'a' }, { key: 'b', dependsOn: ['a'] }],
          {
            ...BUDGET,
            maxWallClockSeconds: 600,
          },
        );
        const outcome = await advance(goalRunId, requester);
        const goal = await goalOf(goalRunId);
        expect(outcome.nextTickAt?.getTime()).toBe(
          (goal.confirmedAt as Date).getTime() + 600 * 1000,
        );
        const stepA = (await stepsOf(goalRunId)).a as StepRunRow;
        expect((await latestAttempt(stepA.id)).duration_limit_sec).toBeLessThanOrEqual(600);

        await raw(
          `update goal_runs set confirmed_at = now() - interval '1 hour'
            where workspace_id = $1 and id = $2`,
          [workspaceId, goalRunId],
        );
        await completeStep(stepA.id, requester);
        await advance(goalRunId, requester);
        expect(await goalOf(goalRunId)).toMatchObject({
          status: 'paused',
          pauseReason: 'budget_exhausted',
        });
        expect(((await stepsOf(goalRunId)).b as StepRunRow).status).toBe('ready');
      });
    });

    // -------------------------------------------------------------------------------------------

    describe('S12: the reconcile scan makes up for a lost wake', () => {
      it('marks a run whose attempt Task finished, one waiting on a request that ended, one with nothing scheduled, and one over its tokens', async () => {
        const requester = await newPrincipal();
        const finishedRun = await startGoal(requester, [{ key: 'only' }]);
        await advance(finishedRun, requester);
        const finishedStep = (await stepsOf(finishedRun)).only as StepRunRow;

        const waitingRun = await startGoal(requester, [{ key: 'only' }]);
        await advance(waitingRun, requester);
        const waitingStep = (await stepsOf(waitingRun)).only as StepRunRow;
        const pending = await seedAction(
          waitingStep.id,
          await latestRun(waitingStep.id),
          'pending_approval',
        );
        await completeStep(waitingStep.id, requester);
        await advance(waitingRun, requester);
        expect((await stepsOf(waitingRun)).only).toMatchObject({
          status: 'waiting',
          waitingReason: 'approval',
        });

        const unscheduledRun = await startGoal(requester, [{ key: 'only' }]);
        await advance(unscheduledRun, requester);
        const overRun = await startGoal(requester, [{ key: 'only' }], {
          ...BUDGET,
          maxTokens: 100,
        });
        await advance(overRun, requester);
        const quietRun = await startGoal(requester, [{ key: 'only' }]);
        await advance(quietRun, requester);

        // The changes happen, and no event is delivered.
        await completeStep(finishedStep.id, requester);
        await setActionStatus(pending, 'executed');
        await admin((client) =>
          client.query(
            'update goal_runs set next_tick_at = null where workspace_id = $1 and id = $2',
            [workspaceId, unscheduledRun],
          ),
        );
        const overStep = (await stepsOf(overRun)).only as StepRunRow;
        await admin(async (client) =>
          client.query('update tasks set tokens_used = 500 where workspace_id = $1 and id = $2', [
            workspaceId,
            (await latestAttempt(overStep.id)).id,
          ]),
        );
        for (const goalRunId of [finishedRun, waitingRun, unscheduledRun, overRun, quietRun]) {
          expect(await isDue(goalRunId)).toBe(false);
        }

        expect(await markReconcileDue(pool)).toBeGreaterThanOrEqual(4);
        expect(await isDue(finishedRun)).toBe(true);
        expect(await isDue(waitingRun)).toBe(true);
        expect(await isDue(unscheduledRun)).toBe(true);
        expect(await isDue(overRun)).toBe(true);
        expect(await isDue(quietRun)).toBe(false);

        const claimed = (await claimDueGoalRuns(pool, { limit: 10_000 })).map(
          (target) => target.goalRunId,
        );
        expect(claimed).toEqual(
          expect.arrayContaining([finishedRun, waitingRun, unscheduledRun, overRun]),
        );
        expect((await advance(finishedRun, requester)).status).toBe('verifying');
        expect((await advance(waitingRun, requester)).status).toBe('verifying');
        expect(await goalOf(overRun)).toMatchObject({ status: 'running' });
        await advance(overRun, requester);
        expect(await goalOf(overRun)).toMatchObject({
          status: 'paused',
          pauseReason: 'budget_exhausted',
        });
      });
    });

    // -------------------------------------------------------------------------------------------

    describe('retries, backoff and the attempt limit', () => {
      it('waits out the backoff before the next attempt and schedules it', async () => {
        const requester = await newPrincipal();
        const goalRunId = await startGoal(requester, [{ key: 'only' }]);
        await advance(goalRunId, requester);
        const step = (await stepsOf(goalRunId)).only as StepRunRow;
        await failStep(step.id, requester, 'worker_failed');
        const outcome = await advance(goalRunId, requester, { retryBackoffMs: () => 60_000 });
        const failed = (await stepsOf(goalRunId)).only as StepRunRow;
        expect(failed).toMatchObject({ status: 'failed', failureCategory: 'transient' });
        expect(outcome.nextTickAt?.getTime()).toBe(failed.updatedAt.getTime() + 60_000);
        expect(await attemptTasks(step.id)).toHaveLength(1);
      });

      it('pauses for a person once the attempts are used up', async () => {
        const requester = await newPrincipal();
        const goalRunId = await startGoal(requester, [{ key: 'only', maxAttempts: 2 }]);
        await advance(goalRunId, requester);
        const step = (await stepsOf(goalRunId)).only as StepRunRow;
        await failStep(step.id, requester, 'worker_failed');
        await advance(goalRunId, requester);
        await failStep(step.id, requester, 'run_lost');
        await advance(goalRunId, requester);
        expect(await goalOf(goalRunId)).toMatchObject({
          status: 'paused',
          pauseReason: 'needs_decision',
        });
        expect((await stepsOf(goalRunId)).only).toMatchObject({
          status: 'failed',
          attemptCount: 2,
        });
        expect(await attemptTasks(step.id)).toHaveLength(2);
      });

      it('starts no new attempt while a request of the step, of any attempt, may still run (I-G4)', async () => {
        const requester = await newPrincipal();
        const goalRunId = await startGoal(requester, [{ key: 'only' }]);
        await advance(goalRunId, requester);
        const step = (await stepsOf(goalRunId)).only as StepRunRow;
        // A request recorded against the step outside this attempt's runs, still executing.
        const executing = await seedAction(step.id, null, 'executing');
        await failStep(step.id, requester, 'worker_failed');
        await advance(goalRunId, requester);
        expect((await stepsOf(goalRunId)).only).toMatchObject({
          status: 'failed',
          attemptCount: 1,
        });
        expect(await attemptTasks(step.id)).toHaveLength(1);

        await setActionStatus(executing, 'executed');
        await advance(goalRunId, requester);
        expect((await stepsOf(goalRunId)).only).toMatchObject({
          status: 'running',
          attemptCount: 2,
        });
      });

      it('looks again at a retry held back by a request in flight within one period, even when the wake is lost (S12)', async () => {
        const requester = await newPrincipal();
        const goalRunId = await startGoal(requester, [{ key: 'only' }]);
        await advance(goalRunId, requester);
        const step = (await stepsOf(goalRunId)).only as StepRunRow;
        const executing = await seedAction(step.id, null, 'executing');
        await failStep(step.id, requester, 'worker_failed');

        // By default the held-back retry is looked at again one reconcile period later, long
        // before the wall-clock deadline.
        const held = await advance(goalRunId, requester);
        const inMs = (held.nextTickAt as Date).getTime() - Date.now();
        expect(inMs).toBeGreaterThan(50_000);
        expect(inMs).toBeLessThanOrEqual(DEFAULT_BLOCKED_RETRY_RECHECK_MS + 1000);

        const recheck: GoalAdvancerOptions = { ...NO_BACKOFF, blockedRetryRecheckMs: 50 };
        await advance(goalRunId, requester, recheck);
        expect(await isDue(goalRunId)).toBe(false);
        // The request ends; its ActionRequestUpdated never arrives.
        await setActionStatus(executing, 'executed');
        await sleep(100);
        expect(await isDue(goalRunId)).toBe(true);
        const claimed = (await claimDueGoalRuns(pool, { limit: 10_000 })).map(
          (target) => target.goalRunId,
        );
        expect(claimed).toContain(goalRunId);
        await advance(goalRunId, requester, recheck);
        expect((await stepsOf(goalRunId)).only).toMatchObject({
          status: 'running',
          attemptCount: 2,
        });
      });

      it('a Worker that ends without a result, or a Task someone cancelled, needs a person', async () => {
        const requester = await newPrincipal();
        const noResult = await startGoal(requester, [{ key: 'only' }]);
        await advance(noResult, requester);
        await failStep(((await stepsOf(noResult)).only as StepRunRow).id, requester, 'no_result');
        await advance(noResult, requester);
        expect(await goalOf(noResult)).toMatchObject({
          status: 'paused',
          pauseReason: 'needs_decision',
        });
        expect((await stepsOf(noResult)).only).toMatchObject({
          status: 'failed',
          failureCategory: 'contract_violation',
        });

        const cancelled = await startGoal(requester, [{ key: 'only' }]);
        await advance(cancelled, requester);
        const step = (await stepsOf(cancelled)).only as StepRunRow;
        const task = await latestAttempt(step.id);
        await raw(
          "update tasks set status = 'cancelled', cancelled_at = now() where workspace_id = $1 and id = $2",
          [workspaceId, task.id],
        );
        await advance(cancelled, requester);
        expect(await goalOf(cancelled)).toMatchObject({
          status: 'paused',
          pauseReason: 'needs_decision',
        });
        expect((await stepsOf(cancelled)).only).toMatchObject({
          status: 'failed',
          failureCategory: 'transient',
        });
      });
    });

    // -------------------------------------------------------------------------------------------

    describe('the wait is on the step, not on the Worker (§4.8)', () => {
      it('a finished Worker with a request awaiting approval leaves its step waiting; the decision moves it on', async () => {
        const requester = await newPrincipal();
        const goalRunId = await startGoal(requester, [
          { key: 'a' },
          { key: 'b', dependsOn: ['a'] },
        ]);
        await advance(goalRunId, requester);
        const stepA = (await stepsOf(goalRunId)).a as StepRunRow;
        const request = await seedAction(stepA.id, await latestRun(stepA.id), 'pending_approval');
        await completeStep(stepA.id, requester);
        await advance(goalRunId, requester);
        let steps = await stepsOf(goalRunId);
        expect(steps.a).toMatchObject({ status: 'waiting', waitingReason: 'approval' });
        expect(steps.b?.status).toBe('pending');
        expect((await goalOf(goalRunId)).status).toBe('running');

        await setActionStatus(request, 'executed');
        await advance(goalRunId, requester);
        steps = await stepsOf(goalRunId);
        expect(steps.a?.status).toBe('succeeded');
        expect(steps.b?.status).toBe('running');
      });

      it('a refused request needs a person; an outcome-unknown one waits for a reconcile', async () => {
        const requester = await newPrincipal();
        const rejected = await startGoal(requester, [{ key: 'only' }]);
        await advance(rejected, requester);
        const rejectedStep = (await stepsOf(rejected)).only as StepRunRow;
        await seedAction(rejectedStep.id, await latestRun(rejectedStep.id), 'denied');
        await completeStep(rejectedStep.id, requester);
        await advance(rejected, requester);
        expect((await stepsOf(rejected)).only).toMatchObject({
          status: 'failed',
          failureCategory: 'action_refused',
        });
        expect(await goalOf(rejected)).toMatchObject({
          status: 'paused',
          pauseReason: 'needs_decision',
        });

        const unknown = await startGoal(requester, [{ key: 'only' }]);
        await advance(unknown, requester);
        const unknownStep = (await stepsOf(unknown)).only as StepRunRow;
        await seedAction(
          unknownStep.id,
          await latestRun(unknownStep.id),
          'failed',
          'outcome_unknown',
        );
        await failStep(unknownStep.id, requester, 'worker_failed');
        await advance(unknown, requester);
        expect((await stepsOf(unknown)).only).toMatchObject({
          status: 'waiting',
          waitingReason: 'reconcile',
        });
        expect(await goalOf(unknown)).toMatchObject({
          status: 'paused',
          pauseReason: 'awaiting_reconcile',
        });
      });

      it('an earlier attempt’s request never decides a later attempt', async () => {
        const requester = await newPrincipal();
        const goalRunId = await startGoal(requester, [{ key: 'only' }]);
        await advance(goalRunId, requester);
        const step = (await stepsOf(goalRunId)).only as StepRunRow;
        // Attempt 1's request never reached its gate: the attempt is transient, and retried.
        await seedAction(step.id, await latestRun(step.id), 'failed', 'not_delivered');
        await completeStep(step.id, requester);
        await advance(goalRunId, requester);
        expect((await stepsOf(goalRunId)).only).toMatchObject({
          status: 'running',
          attemptCount: 2,
        });
        // Attempt 2 raised nothing: it succeeds, whatever attempt 1's request says.
        await completeStep(step.id, requester);
        expect((await advance(goalRunId, requester)).status).toBe('verifying');
      });
    });

    // -------------------------------------------------------------------------------------------

    describe('fencing and pinned configuration (I-G2, §4.4)', () => {
      it('a step whose definition the current plan changed is not unblocked', async () => {
        const requester = await newPrincipal();
        const goalRunId = await startGoal(requester, [
          { key: 'a' },
          { key: 'b', dependsOn: ['a'] },
        ]);
        await advance(goalRunId, requester);
        // Revision 2 redefines b without superseding it — what GO3's revise path must never leave.
        await adoptUnsupersededRevision(goalRunId, requester, [
          { key: 'a' },
          { key: 'b', dependsOn: ['a'], input: { step: 'b', changed: true } },
        ]);
        await completeStep(((await stepsOf(goalRunId)).a as StepRunRow).id, requester);
        await advance(goalRunId, requester);
        const steps = await stepsOf(goalRunId);
        expect(steps.a?.status).toBe('succeeded');
        expect(steps.b?.status).toBe('pending');
        expect(await goalOf(goalRunId)).toMatchObject({
          status: 'paused',
          pauseReason: 'needs_decision',
        });
      });

      it('a paused run records each further cause once, not on every advance', async () => {
        const requester = await newPrincipal();
        const steps: StepSpec[] = [{ key: 'a' }, { key: 'b', dependsOn: ['a'] }, { key: 'c' }];
        const goalRunId = await startGoal(requester, steps);
        await advance(goalRunId, requester);
        await adoptUnsupersededRevision(goalRunId, requester, [
          { key: 'a' },
          { key: 'b', dependsOn: ['a'], input: { step: 'b', changed: true } },
          { key: 'c' },
        ]);
        const before = await stepsOf(goalRunId);
        await completeStep(before.a?.id as string, requester);
        await advance(goalRunId, requester);
        expect(await goalOf(goalRunId)).toMatchObject({
          status: 'paused',
          pauseReason: 'needs_decision',
        });

        // While paused, c's attempt fails: a new cause, noted once; b's is the pause's own.
        await failStep(before.c?.id as string, requester, 'no_result');
        for (let i = 0; i < 3; i += 1) await advance(goalRunId, requester);
        expect((await stepsOf(goalRunId)).c).toMatchObject({
          status: 'failed',
          failureCategory: 'contract_violation',
        });
        const audit = await goalAudit(goalRunId);
        expect(audit.filter((row) => row.action === 'goal_run.pause')).toHaveLength(1);
        expect(
          audit.filter((row) => row.action === 'goal_run.pause_noted').map((row) => row.payload),
        ).toEqual([
          expect.objectContaining({
            reason: 'needs_decision',
            detail: 'step c: attempt 1 failed (contract_violation)',
          }),
        ]);
      });

      it('a later attempt whose pinned WorkerDefinition version was deprecated does not start', async () => {
        const requester = await newPrincipal();
        const pinned = await publish({ systemPrompt: 'A version about to be deprecated.' });
        const goalRunId = await startGoal(requester, [{ key: 'only' }], BUDGET, pinned);
        await advance(goalRunId, requester);
        const step = (await stepsOf(goalRunId)).only as StepRunRow;
        await failStep(step.id, requester, 'worker_failed');
        await raw(
          "update worker_definitions set status = 'deprecated' where workspace_id = $1 and id = $2",
          [workspaceId, pinned.definitionId],
        );
        await advance(goalRunId, requester);
        expect(await goalOf(goalRunId)).toMatchObject({
          status: 'paused',
          pauseReason: 'needs_decision',
        });
        expect((await stepsOf(goalRunId)).only).toMatchObject({ status: 'ready', attemptCount: 1 });
        expect(await attemptTasks(step.id)).toHaveLength(1);
      });
    });

    // -------------------------------------------------------------------------------------------
    // S11 GO3a: a person stops a run — pause, resume, cancel — and what a cancel waits for.

    describe('stopping a run (S11 GO3a)', () => {
      const asOwner = <T>(fn: (client: PoolClient) => Promise<T>) => asRequester(ownerId, fn);
      // A function: `ownerId` is set in `beforeAll`, after this block is collected.
      const byOwner = () => ({ principalId: ownerId, role: 'owner' as const });
      const by = (principalId: string) => ({ principalId, role: 'member' as const });

      async function newGatekeeper(): Promise<string> {
        const id = randomUUID();
        await admin((client) =>
          client.query(
            "insert into objects (workspace_id, id, object_type) values ($1, $2, 'platform.Gatekeeper')",
            [workspaceId, id],
          ),
        );
        return id;
      }

      /** A request of `stepRunId` on `gatekeeperId`, raised by the Worker of the step's latest
       *  attempt (as I-G9's monitor requires), brought to `status` the way the platform does:
       *  requested, then approved by the owner or started. */
      async function requestOn(
        gatekeeperId: string,
        stepRunId: string,
        onBehalfOf: string,
        status: 'pending_approval' | 'approved' | 'auto_approved' | 'executing',
        actionKind: string,
      ): Promise<string> {
        const parentWorkerRunId = await latestRun(stepRunId);
        const row = await admin((client) =>
          requestAction(client, workspaceId, {
            gatekeeperId,
            actionKind,
            blastRadius: status === 'pending_approval' || status === 'approved' ? 'medium' : 'low',
            operationAutoApprovable: true,
            awaitDecision: false,
            onBehalfOf,
            actorRuntime: 'pi',
            stepRunId,
            parentWorkerRunId,
            requesterScope: {
              capabilities: ['request_action'],
              resources: { gatekeeper: [gatekeeperId] },
            },
          }),
        );
        if (status === 'approved') {
          await admin((client) =>
            approveActionRequest(client, workspaceId, {
              actionRequestId: row.id,
              approverPrincipalId: ownerId,
              approverRole: 'owner',
            }),
          );
        }
        if (status === 'executing') {
          await admin((client) => startActionRequestExecution(client, workspaceId, row.id));
        }
        expect(await actionStatus(row.id)).toBe(status);
        return row.id;
      }

      const actionStatus = async (id: string) =>
        (await admin((client) => getActionRequest(client, workspaceId, id)))?.status;

      const taskStatus = async (taskId: string) =>
        (
          await admin((client) =>
            client.query<{ status: string }>(
              'select status from tasks where workspace_id = $1 and id = $2',
              [workspaceId, taskId],
            ),
          )
        ).rows[0]?.status;

      const auditOf = (resourceId: string) =>
        admin(async (client) => {
          const result = await client.query<{
            action: string;
            actor_principal_id: string;
            payload: Record<string, unknown>;
          }>(
            `select action, actor_principal_id, payload from audit_records
              where workspace_id = $1 and resource_id = $2
              order by created_at, id`,
            [workspaceId, resourceId],
          );
          return result.rows;
        });

      it('pause: the requester or an owner stops new attempts; running ones finish; only the requester resumes', async () => {
        const requester = await newPrincipal();
        const someoneElse = await newPrincipal();
        const goalRunId = await startGoal(requester, [
          { key: 'a' },
          { key: 'b', dependsOn: ['a'] },
        ]);
        await advance(goalRunId, requester);
        const stepA = (await stepsOf(goalRunId)).a as StepRunRow;

        await expect(
          asRequester(someoneElse, (client) =>
            pauseGoalRun(client, workspaceId, { goalRunId, actor: by(someoneElse) }),
          ),
        ).rejects.toBeInstanceOf(GoalRunStateError);
        expect(
          await asOwner((client) =>
            pauseGoalRun(client, workspaceId, { goalRunId, actor: byOwner() }),
          ),
        ).toEqual({ status: 'paused', changed: true });
        expect(await goalOf(goalRunId)).toMatchObject({
          status: 'paused',
          pauseReason: 'requested',
        });
        expect(
          await asRequester(requester, (client) =>
            pauseGoalRun(client, workspaceId, { goalRunId, actor: by(requester) }),
          ),
        ).toEqual({ status: 'paused', changed: false });

        // The running attempt finishes and is recorded; the next step is ready but does not start.
        await completeStep(stepA.id, requester);
        await advance(goalRunId, requester);
        let steps = await stepsOf(goalRunId);
        expect(steps.a?.status).toBe('succeeded');
        expect(steps.b?.status).toBe('ready');
        expect(await goalTaskCount(goalRunId)).toBe(1);
        expect((await goalOf(goalRunId)).status).toBe('paused');

        // Resuming lets the run act with the requester's authority again: theirs alone.
        await expect(
          asOwner((client) => resumeGoalRun(client, workspaceId, { goalRunId, actor: byOwner() })),
        ).rejects.toBeInstanceOf(GoalRunStateError);
        expect(
          await asRequester(requester, (client) =>
            resumeGoalRun(client, workspaceId, { goalRunId, actor: by(requester) }),
          ),
        ).toEqual({ status: 'running', changed: true, retriedStepRunIds: [] });
        expect(await isDue(goalRunId)).toBe(true);
        await advance(goalRunId, requester);
        steps = await stepsOf(goalRunId);
        expect(steps.b?.status).toBe('running');

        const audit = await goalAudit(goalRunId);
        expect(audit.find((row) => row.action === 'goal_run.pause')?.payload).toMatchObject({
          by: 'person',
          resultingStatus: 'paused',
        });
        expect(audit.find((row) => row.action === 'goal_run.resume')?.payload).toMatchObject({
          by: 'person',
          pauseReason: 'requested',
        });
      });

      it('resume retries a failed step a person names, past its attempt limit, once nothing of it is in flight', async () => {
        const requester = await newPrincipal();
        const goalRunId = await startGoal(requester, [{ key: 'only', maxAttempts: 1 }]);
        await advance(goalRunId, requester);
        const step = (await stepsOf(goalRunId)).only as StepRunRow;
        await failStep(step.id, requester, 'worker_failed');
        await advance(goalRunId, requester);
        expect(await goalOf(goalRunId)).toMatchObject({
          status: 'paused',
          pauseReason: 'needs_decision',
        });
        const resume = (retrySteps: readonly string[]) =>
          asRequester(requester, (client) =>
            resumeGoalRun(client, workspaceId, { goalRunId, actor: by(requester), retrySteps }),
          );

        // I-G4: a request of the step still awaits a decision — no new attempt beside it.
        const gatekeeperId = await newGatekeeper();
        const waiting = await requestOn(
          gatekeeperId,
          step.id,
          requester,
          'pending_approval',
          'test.go3a.waiting',
        );
        await expect(resume(['only'])).rejects.toThrow(/still awaits a decision or runs/);
        await expect(resume(['missing'])).rejects.toThrow(/step missing: not found/);
        expect((await goalOf(goalRunId)).status).toBe('paused');
        await admin((client) => withdrawActionRequest(client, workspaceId, waiting));

        const resumed = await resume(['only']);
        expect(resumed).toMatchObject({ status: 'running', retriedStepRunIds: [step.id] });
        expect((await stepsOf(goalRunId)).only).toMatchObject({ status: 'ready', attemptCount: 1 });
        await advance(goalRunId, requester);
        expect((await stepsOf(goalRunId)).only).toMatchObject({
          status: 'running',
          attemptCount: 2,
        });
        const retry = (await stepAudit(goalRunId)).find((row) => row.action === 'step_run.retry');
        expect(retry).toMatchObject({
          actor_principal_id: requester,
          payload: expect.objectContaining({ by: 'person', decidedBy: requester }),
        });
        // A running run retries nothing on its own word.
        await expect(resume(['only'])).rejects.toThrow(/steps are retried on resume/);
      });

      it('S7: a cancel withdraws what has not run, in its own transaction; the gate drains the next goal’s action at once; the running Task is terminated', async () => {
        const requester = await newPrincipal();
        const goalRunId = await startGoal(requester, [
          { key: 'a' },
          { key: 'b', dependsOn: ['a'] },
        ]);
        await advance(goalRunId, requester);
        const stepA = (await stepsOf(goalRunId)).a as StepRunRow;
        const taskA = (await latestAttempt(stepA.id)).id;

        // The gate's queue: this goal's pending head, its approved request behind it, then another
        // goal's auto-approved request.
        const gatekeeperId = await newGatekeeper();
        const head = await requestOn(
          gatekeeperId,
          stepA.id,
          requester,
          'pending_approval',
          'test.s7.head',
        );
        const queued = await requestOn(
          gatekeeperId,
          stepA.id,
          requester,
          'approved',
          'test.s7.queued',
        );
        const otherRequester = await newPrincipal();
        const otherGoal = await startGoal(otherRequester, [{ key: 'only' }]);
        await advance(otherGoal, otherRequester);
        const otherStep = (await stepsOf(otherGoal)).only as StepRunRow;
        const behind = await requestOn(
          gatekeeperId,
          otherStep.id,
          otherRequester,
          'auto_approved',
          'test.s7.other-goal',
        );

        const executed: string[] = [];
        const withTransaction = createAdminWithTransaction(pool);
        const drainer = new ApprovalDrainer({
          executor: {
            async execute(row) {
              executed.push(row.actionKind);
              return { ok: true };
            },
          },
          withTransaction,
        });
        // Before the cancel the pending head holds the queue (R-50).
        expect(
          await drainer.drainGatekeeper(workspaceId, SYSTEM_ACTOR_PLACEHOLDER, gatekeeperId),
        ).toMatchObject({ processed: 0, stoppedAtPending: true });

        const errorsBefore = startErrors.length;
        await expect(
          asRequester(otherRequester, (client) =>
            cancelGoalRun(client, workspaceId, { goalRunId, actor: by(otherRequester) }),
          ),
        ).rejects.toBeInstanceOf(GoalRunStateError);
        const cancelled = await asRequester(requester, (client) =>
          cancelGoalRun(client, workspaceId, { goalRunId, actor: by(requester) }),
        );
        const steps = await stepsOf(goalRunId);
        expect(cancelled).toMatchObject({
          status: 'cancelling',
          changed: true,
          withdrawnActionRequestIds: [head, queued],
        });
        expect([...cancelled.cancelledStepRunIds].sort()).toEqual(
          [stepA.id, steps.b?.id as string].sort(),
        );
        expect(steps.a?.status).toBe('cancelled');
        expect(steps.b?.status).toBe('cancelled');
        expect(await actionStatus(head)).toBe('withdrawn');
        expect(await actionStatus(queued)).toBe('withdrawn');
        expect(await isDue(goalRunId)).toBe(true);
        const withdrawal = (await auditOf(head)).find(
          (row) => row.action === 'action_request.withdraw',
        );
        expect(withdrawal).toMatchObject({
          actor_principal_id: requester,
          payload: expect.objectContaining({ reason: GOAL_CANCELLED_WITHDRAW_REASON }),
        });

        // The withdrawal's own event re-drains the gate: the other goal's request runs now, not at
        // the next periodic tick — and the withdrawn ones never run.
        const source = new FakeWakeSource();
        registerActionRequestDrainConsumer(source, drainer, withTransaction);
        await source.deliver({
          type: 'ActionRequestUpdated',
          workspaceId,
          actionRequestId: head,
          status: 'withdrawn',
        });
        for (let i = 0; i < 50 && (await actionStatus(behind)) !== 'executed'; i += 1) {
          await sleep(20);
        }
        expect(await actionStatus(behind)).toBe('executed');
        expect(executed).toEqual(['test.s7.other-goal']);

        // The cancelling advance terminates the running Task after its commit and starts nothing.
        const first = await advance(goalRunId, requester);
        expect(first).toMatchObject({
          status: 'cancelling',
          startedTaskIds: [],
          terminatedTaskIds: [taskA],
        });
        expect(first.nextTickAt).not.toBeNull();
        expect(await taskStatus(taskA)).toBe('cancelled');
        expect((await runsOf(taskA)).map((run) => run.status)).toEqual(['terminated']);
        const second = await advance(goalRunId, requester);
        expect(second).toMatchObject({ status: 'cancelled', terminatedTaskIds: [] });
        expect(await goalOf(goalRunId)).toMatchObject({
          status: 'cancelled',
          cleanupPending: false,
          nextTickAt: null,
        });
        expect(await goalTaskCount(goalRunId)).toBe(1);
        expect(startErrors.slice(errorsBefore)).toEqual([]);
        // The I-G9 monitor finds nothing of this run's left to withdraw.
        const ig9 = await pool.connect().then(async (client) => {
          try {
            return await checkIG9(client, 100_000);
          } finally {
            client.release();
          }
        });
        expect(ig9.sample.filter((line) => line.includes(head) || line.includes(queued))).toEqual(
          [],
        );

        // A second cancel changes nothing; a proposed run is rejected, not cancelled.
        expect(
          await asRequester(requester, (client) =>
            cancelGoalRun(client, workspaceId, { goalRunId, actor: by(requester) }),
          ),
        ).toMatchObject({ status: 'cancelled', changed: false });
        const proposed = await proposeGoal(requester, [{ key: 'only' }]);
        await expect(
          asRequester(requester, (client) =>
            cancelGoalRun(client, workspaceId, { goalRunId: proposed, actor: by(requester) }),
          ),
        ).rejects.toThrow(/rejected, not cancelled/);

        const audit = await goalAudit(goalRunId);
        expect(audit.map((row) => row.action)).toEqual(
          expect.arrayContaining(['goal_run.cancel', 'goal_run.finish_cancel']),
        );
        expect(audit.find((row) => row.action === 'goal_run.cancel')?.payload).toMatchObject({
          by: 'person',
        });
      });

      it('S7: an executing action holds the cancel; past the deadline the run is cancelled with cleanup_pending listing it; it ends the R-48 way and the sweep clears the flag', async () => {
        const requester = await newPrincipal();
        const goalRunId = await startGoal(requester, [{ key: 'only' }]);
        await advance(goalRunId, requester);
        const step = (await stepsOf(goalRunId)).only as StepRunRow;
        const gatekeeperId = await newGatekeeper();
        const inDoubt = await requestOn(
          gatekeeperId,
          step.id,
          requester,
          'executing',
          'test.s7.in-doubt',
        );

        const errorsBefore = startErrors.length;
        const cancelled = await asOwner((client) =>
          cancelGoalRun(client, workspaceId, { goalRunId, actor: byOwner() }),
        );
        expect(cancelled).toMatchObject({ status: 'cancelling', withdrawnActionRequestIds: [] });
        // Started before the cancel: never withdrawn.
        expect(await actionStatus(inDoubt)).toBe('executing');
        await advance(goalRunId, requester);
        const waiting = await advance(goalRunId, requester);
        expect(waiting).toMatchObject({ status: 'cancelling', terminatedTaskIds: [] });
        expect(waiting.nextTickAt).not.toBeNull();

        // A cancelling run with nothing scheduled is found by the reconcile scan.
        await admin((client) =>
          client.query(
            'update goal_runs set next_tick_at = null where workspace_id = $1 and id = $2',
            [workspaceId, goalRunId],
          ),
        );
        await markReconcileDue(pool);
        expect(await isDue(goalRunId)).toBe(true);

        const pastDeadline = await advance(goalRunId, requester, {
          ...NO_BACKOFF,
          cancelDeadlineMs: 0,
        });
        expect(pastDeadline).toMatchObject({ status: 'cancelled', nextTickAt: null });
        expect(await goalOf(goalRunId)).toMatchObject({
          status: 'cancelled',
          cleanupPending: true,
        });
        const finish = (await goalAudit(goalRunId)).find(
          (row) => row.action === 'goal_run.finish_cancel',
        );
        expect(finish?.payload).toMatchObject({
          by: 'advancer',
          liveTaskIds: [],
          executingActions: [
            {
              id: inDoubt,
              stepRunId: step.id,
              gatekeeperId,
              actionKind: 'test.s7.in-doubt',
            },
          ],
        });

        const sweepDeps = {
          pool,
          taskRuntime: taskRuntime(),
          onStartError: (err: unknown) => startErrors.push(err),
        };
        await sweepGoalCancelCleanup(sweepDeps, { limit: 10_000 });
        expect((await goalOf(goalRunId)).cleanupPending).toBe(true);

        // The gate answers (or the R-48 reaper's replay does): the result is audited like any other.
        await admin((client) => markActionRequestExecuted(client, workspaceId, inDoubt));
        expect((await auditOf(inDoubt)).map((row) => row.action)).toContain(
          'action_request.complete',
        );
        const updatedBefore = await outboxCount('GoalRunUpdated', goalRunId);
        expect(await sweepGoalCancelCleanup(sweepDeps, { limit: 10_000 })).toBeGreaterThanOrEqual(
          1,
        );
        expect(await goalOf(goalRunId)).toMatchObject({
          status: 'cancelled',
          cleanupPending: false,
        });
        expect((await goalAudit(goalRunId)).map((row) => row.action)).toContain(
          'goal_run.cleanup_finished',
        );
        expect(await outboxCount('GoalRunUpdated', goalRunId)).toBe(updatedBefore + 1);
        expect(startErrors.slice(errorsBefore)).toEqual([]);
      });

      it('an executing action that ends before the deadline wakes the cancelling run, which is then cancelled cleanly', async () => {
        const requester = await newPrincipal();
        const goalRunId = await startGoal(requester, [{ key: 'only' }]);
        await advance(goalRunId, requester);
        const step = (await stepsOf(goalRunId)).only as StepRunRow;
        const gatekeeperId = await newGatekeeper();
        const running = await requestOn(
          gatekeeperId,
          step.id,
          requester,
          'executing',
          'test.go3a.running',
        );
        await asRequester(requester, (client) =>
          cancelGoalRun(client, workspaceId, { goalRunId, actor: by(requester) }),
        );
        await advance(goalRunId, requester);
        expect((await advance(goalRunId, requester)).status).toBe('cancelling');
        expect(await isDue(goalRunId)).toBe(false);

        const source = new FakeWakeSource();
        registerGoalWakeConsumer(source, pool);
        await admin((client) => markActionRequestExecuted(client, workspaceId, running));
        await source.deliver({
          type: 'ActionRequestUpdated',
          workspaceId,
          actionRequestId: running,
          status: 'executed',
        });
        expect(await isDue(goalRunId)).toBe(true);
        expect((await advance(goalRunId, requester)).status).toBe('cancelled');
        expect((await goalOf(goalRunId)).cleanupPending).toBe(false);
      });

      it('I-G9: new work under a step waits for a cancel holding the step, and is withdrawn with it; after the cancel the step takes none', async () => {
        const requester = await newPrincipal();
        const goalRunId = await startGoal(requester, [{ key: 'only' }]);
        await advance(goalRunId, requester);
        const step = (await stepsOf(goalRunId)).only as StepRunRow;
        const gatekeeperId = await newGatekeeper();

        // A request_action in flight: it holds the step's share lock and has inserted its request.
        const parentWorkerRunId = await latestRun(step.id);
        let requestId: string | undefined;
        let release: () => void = () => {};
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        let inserted: () => void = () => {};
        const hasInserted = new Promise<void>((resolve) => {
          inserted = resolve;
        });
        const inFlight = admin(async (tx) => {
          await lockGoalStepForNewWork(tx, workspaceId, step.id, 'request_action');
          const row = await requestAction(tx, workspaceId, {
            gatekeeperId,
            actionKind: 'test.go3a.in-flight',
            blastRadius: 'medium',
            operationAutoApprovable: true,
            awaitDecision: false,
            onBehalfOf: requester,
            actorRuntime: 'pi',
            stepRunId: step.id,
            parentWorkerRunId,
            requesterScope: {
              capabilities: ['request_action'],
              resources: { gatekeeper: [gatekeeperId] },
            },
          });
          requestId = row.id;
          inserted();
          await released;
        });
        await hasInserted;
        // The cancel waits for it on the step's lock …
        const cancel = asRequester(requester, (tx) =>
          cancelGoalRun(tx, workspaceId, { goalRunId, actor: by(requester) }),
        );
        await sleep(200);
        expect((await goalOf(goalRunId)).status).toBe('running');
        release();
        await inFlight;
        // … and, once it commits, withdraws what it raised.
        expect((await cancel).withdrawnActionRequestIds).toEqual([requestId]);
        expect(await actionStatus(requestId as string)).toBe('withdrawn');

        // A closed step takes no new work: the entry check refuses it (409 illegal_transition).
        await expect(
          admin((tx) => lockGoalStepForNewWork(tx, workspaceId, step.id, 'request_action')),
        ).rejects.toBeInstanceOf(GoalStepClosedError);
        await expect(
          admin((tx) => lockGoalStepForNewWork(tx, workspaceId, step.id, 'invoke_worker')),
        ).rejects.toBeInstanceOf(IllegalTransition);
      });

      it('#619 deviation 6: the attempts of one advance split the goal’s headroom; a share below one token waits for live Tasks, or pauses when none hold it', async () => {
        const requester = await newPrincipal();
        const goalRunId = await startGoal(requester, [{ key: 'a' }, { key: 'b' }], {
          ...BUDGET,
          maxTokens: 1000,
        });
        await advance(goalRunId, requester);
        let steps = await stepsOf(goalRunId);
        const taskA = await latestAttempt(steps.a?.id as string);
        const taskB = await latestAttempt(steps.b?.id as string);
        expect([Number(taskA.token_budget), Number(taskB.token_budget)]).toEqual([500, 500]);

        // b fails transiently having used nothing; a's live Task now holds all that is left.
        await admin((client) =>
          client.query('update tasks set token_budget = 1000 where workspace_id = $1 and id = $2', [
            workspaceId,
            taskA.id,
          ]),
        );
        await failStep(steps.b?.id as string, requester, 'worker_failed');
        await advance(goalRunId, requester);
        steps = await stepsOf(goalRunId);
        expect(steps.b).toMatchObject({ status: 'ready', attemptCount: 1 });
        expect((await goalOf(goalRunId)).status).toBe('running');

        // a ends having used 300: its unspent budget comes back, and b's retry gets it.
        await admin((client) =>
          client.query('update tasks set tokens_used = 300 where workspace_id = $1 and id = $2', [
            workspaceId,
            taskA.id,
          ]),
        );
        await completeStep(steps.a?.id as string, requester);
        await advance(goalRunId, requester);
        steps = await stepsOf(goalRunId);
        expect(steps.b).toMatchObject({ status: 'running', attemptCount: 2 });
        expect(Number((await latestAttempt(steps.b?.id as string)).token_budget)).toBe(700);

        // Nothing live, less than one token for each ready step: the run pauses.
        const starved = await startGoal(requester, [{ key: 'a' }, { key: 'b' }], {
          ...BUDGET,
          maxTokens: 1,
        });
        await advance(starved, requester);
        expect(await goalOf(starved)).toMatchObject({
          status: 'paused',
          pauseReason: 'budget_exhausted',
        });
        expect(await goalTaskCount(starved)).toBe(0);
      });

      it('A records no finished attempt of a step the current plan changed (I-G2); C unblocks after a skipped dependency', async () => {
        const requester = await newPrincipal();
        const fenced = await startGoal(requester, [{ key: 'a' }]);
        await advance(fenced, requester);
        await adoptUnsupersededRevision(fenced, requester, [
          { key: 'a', input: { step: 'a', changed: true } },
        ]);
        await completeStep(((await stepsOf(fenced)).a as StepRunRow).id, requester);
        await advance(fenced, requester);
        expect((await stepsOf(fenced)).a?.status).toBe('running');
        expect(await goalOf(fenced)).toMatchObject({
          status: 'paused',
          pauseReason: 'needs_decision',
        });

        const skipping = await startGoal(requester, [
          { key: 'a' },
          { key: 'b', dependsOn: ['a'] },
          { key: 'c' },
        ]);
        await admin((client) =>
          client.query(
            `update step_runs set status = 'skipped', ended_at = now()
              where workspace_id = $1 and goal_run_id = $2 and step_key = 'a'`,
            [workspaceId, skipping],
          ),
        );
        await advance(skipping, requester);
        const steps = await stepsOf(skipping);
        expect(steps.a?.status).toBe('skipped');
        expect(steps.b?.status).toBe('running');
      });
    });
  },
);
