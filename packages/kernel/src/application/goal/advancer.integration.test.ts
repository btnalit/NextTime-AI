import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IllegalTransition, type Operation, type TaskFailureReason } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { type PoolLike, createPool, withWorkspace } from '../../adapters/db/pool.js';
import {
  type GateTarget,
  type GatekeeperCallInput,
  GatekeeperClientError,
} from '../../adapters/gatekeeper-client/index.js';
import type {
  TaskSpawnInput,
  TaskSpawnOutcome,
  TaskSupervisorClientPort,
  TaskSupervisorStatus,
} from '../../adapters/supervisor-client/index.js';
import {
  ActionReconciliationForbiddenError,
  ApprovalDrainer,
  approveActionRequest,
  claimReconcileCheck,
  ensureReconcileCheck,
  expireActionRequest,
  getActionRequest,
  markActionRequestExecuted,
  markActionRequestFailed,
  readReconcileChecks,
  rejectActionRequest,
  requestAction,
  startActionRequestExecution,
  withdrawActionRequest,
} from '../../governance/approval/index.js';
import { generateEphemeralHandleKeyPair } from '../../governance/capability/index.js';
import {
  SYSTEM_ACTOR_PLACEHOLDER,
  importManifest,
  publishOperation,
  registerGatekeeper,
} from '../../governance/gatekeepers/index.js';
import { checkIG1, checkIG9 } from '../../substrate/audit/goal-invariant-checks.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import type { DomainEvent } from '../../substrate/outbox/index.js';
import { createAdminWithTransaction } from '../gateway/action-executor.js';
import { registerActionRequestDrainConsumer } from '../gateway/action-request-drain-consumer.js';
import { reportTaskOutcome } from '../task/attribution.js';
import {
  GoalStepClosedError,
  RunConfigSnapshotSchema,
  type TaskRuntimeDeps,
  allotChildTokenBudget,
  completeTaskWithResult,
  lockGoalStepForNewWork,
  reactToSupervisorStatus,
} from '../task/index.js';
import { failTaskAndReapWorkerRuns } from '../task/lifecycle.js';
import { proposeWorkerDefinition, publishWorkerDefinition } from '../worker/index.js';
import {
  type DueAcceptanceCheck,
  listDueAcceptanceChecks,
  runAcceptanceCheck,
  runAcceptanceCheckTick,
} from './acceptance-check.js';
import { listAcceptanceChecks } from './acceptance-checks.js';
import {
  GOAL_OUTCOME_NOTE_MAX,
  confirmGoalAcceptance,
  endGoalRun,
  readGoalAcceptance,
} from './acceptance.js';
import {
  DEFAULT_BLOCKED_RETRY_RECHECK_MS,
  type GoalAdvancerOptions,
  advanceGoalRun,
} from './advance.js';
import {
  type GoalCleanupCursor,
  type GoalWakeEventSource,
  claimDueGoalRuns,
  markReconcileDue,
  recordAdvanceFailure,
  registerGoalWakeConsumer,
  runGoalAdvancerTick,
  sweepGoalCancelCleanup,
} from './advancer.js';
import { GOAL_CANCELLED_WITHDRAW_REASON } from './cancelling.js';
import { cancelGoalRun, pauseGoalRun, releaseGoalRunHold, resumeGoalRun } from './control.js';
import { GoalPlanValidationError } from './plan.js';
import { getGoalRun, getPlanRevision, listStepRuns } from './reads.js';
import {
  type DueReconcileCheck,
  listDueReconcileChecks,
  runReconcileCheck,
  runReconcileCheckTick,
} from './reconcile-check.js';
import { listGoalRunUnresolvedActions, reconcileGoalAction } from './reconcile.js';
import { GOAL_REVISED_WITHDRAW_REASON, reviseGoalRun } from './revise.js';
import { GoalRunStateError, confirmGoalRun, createGoalRun } from './service.js';
import type { GoalRunBudget, GoalRunRow, StepRunRow } from './types.js';

/**
 * application/goal/advancer.integration (S11 GO2, GO3a): the deterministic advancer against real
 * Postgres and the real Task path (`createStepAttemptTask` → `spawnWorkerRun` → the Handle mint),
 * with an in-memory worker-supervisor. The scenarios are the plan's §7.2 rows GO2 owns — S1, S2,
 * S3, S9, S10, S12 — plus the rules around them: confirmation (I-G3), retries and backoff, the wait
 * on the step (§4.8), plan fencing (I-G2) and pinned configuration (§4.4); GO3a's: a person
 * pausing, resuming and cancelling a run, S7, the I-G9 entry check and the goal's token headroom;
 * and GO3b's: an owner's hold, revising a paused run (S8: terminated or let finish, requests
 * released one by one), a step judged only once its nested child Tasks ended, verification only
 * once nothing of the run is left running, and a run whose advances keep failing (legacy 356);
 * and GO3c's: a person's finding on an action whose outcome is unknown and the requester's
 * re-execute decision, a finding that resumes no run (the requester does), scenarios S5 and S11;
 * and GO3d's: the platform's reconcile check a step declares (scenario S4, both ways), its refusals,
 * retries and fencing, and the plan checks of a declaration; and GO4a's: verifying a run — its
 * acceptance observations and the requester's confirmation, scenario S6 (a check that never passes
 * pauses the run with its evidence), the requester's outcome and what it overrides, a round ended
 * by a pause, a hold or a cancel, the scan's part, and the plan checks of an acceptance check.
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

/** GO3d: the gate side of a reconcile check — records each observe call and answers it with
 *  `answer`, which a test sets. Nothing else of a gate is reachable from the check. */
class FakeObserveClient {
  readonly calls: Array<{ readonly target: GateTarget; readonly input: GatekeeperCallInput }> = [];
  answer: (input: GatekeeperCallInput) => Promise<{ data: unknown }> = async () => ({ data: null });

  async observe(target: GateTarget, input: GatekeeperCallInput): Promise<{ data: unknown }> {
    this.calls.push({ target, input });
    return this.answer(input);
  }
}

interface StepSpec {
  readonly key: string;
  readonly dependsOn?: readonly string[];
  readonly maxAttempts?: number;
  readonly input?: unknown;
  readonly nested?: boolean;
  readonly reconcile?: readonly unknown[];
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
          ...(step.nested ? { nested: true } : {}),
          ...(step.reconcile ? { reconcile: step.reconcile } : {}),
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
        `update goal_runs set status = 'cancelled', pause_reason = null, paused_by = null,
                paused_by_authority = null, ended_at = now(), next_tick_at = null
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

    describe('stopping, holding and revising a run (S11 GO3a, GO3b)', () => {
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
          await asRequester(requester, (client) =>
            pauseGoalRun(client, workspaceId, { goalRunId, actor: by(requester) }),
          ),
        ).toEqual({ status: 'paused', changed: true });
        expect(await goalOf(goalRunId)).toMatchObject({
          status: 'paused',
          pauseReason: 'requested',
          pausedBy: requester,
          pausedByAuthority: 'requester',
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
        expect(await goalOf(goalRunId)).toMatchObject({ pausedBy: null, pausedByAuthority: null });
        expect(await isDue(goalRunId)).toBe(true);
        await advance(goalRunId, requester);
        steps = await stepsOf(goalRunId);
        expect(steps.b?.status).toBe('running');

        const audit = await goalAudit(goalRunId);
        expect(audit.find((row) => row.action === 'goal_run.pause')?.payload).toMatchObject({
          by: 'person',
          resultingStatus: 'paused',
          pausedByAuthority: 'requester',
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

      it('legacy 393: a run that can only go on once a person retries a failed step pauses needs_decision at once — a resume that names no failed step comes back to it, a branch still moving keeps the run going until it stops', async () => {
        const requester = await newPrincipal();
        const goalRunId = await startGoal(requester, [
          { key: 'a' },
          { key: 'b' },
          { key: 'c', dependsOn: ['a'] },
        ]);
        await advance(goalRunId, requester);
        const first = await stepsOf(goalRunId);
        const stepA = first.a as StepRunRow;
        const stepB = first.b as StepRunRow;
        await failStep(stepA.id, requester, 'no_result');
        await advance(goalRunId, requester);
        expect(await goalOf(goalRunId)).toMatchObject({
          status: 'paused',
          pauseReason: 'needs_decision',
        });
        expect((await stepsOf(goalRunId)).a).toMatchObject({
          status: 'failed',
          failureCategory: 'contract_violation',
        });
        const resume = (retrySteps?: readonly string[]) =>
          asRequester(requester, (client) =>
            resumeGoalRun(client, workspaceId, {
              goalRunId,
              actor: by(requester),
              ...(retrySteps ? { retrySteps } : {}),
            }),
          );
        const stuck =
          'step a: attempt 1 failed (contract_violation) and is not retried on its own — retry it; or revise the plan or cancel';
        const lastPause = async () =>
          (await goalAudit(goalRunId)).filter((row) => row.action === 'goal_run.pause').at(-1)
            ?.payload;

        // Resumed without retrying a: b still runs, so the run goes on.
        await resume();
        expect((await advance(goalRunId, requester)).status).toBe('running');
        expect((await stepsOf(goalRunId)).b?.status).toBe('running');

        // b ends: nothing moves on its own any more — the run pauses now, not at its wall clock.
        await completeStep(stepB.id, requester);
        const stopped = await advance(goalRunId, requester);
        expect(stopped).toMatchObject({ status: 'paused', nextTickAt: null });
        expect(await goalOf(goalRunId)).toMatchObject({
          status: 'paused',
          pauseReason: 'needs_decision',
        });
        expect(await lastPause()).toMatchObject({ reason: 'needs_decision', detail: stuck });
        expect((await stepsOf(goalRunId)).b?.status).toBe('succeeded');

        // Resumed again naming nothing: the next advance pauses it again, nothing starts.
        await resume();
        expect(await advance(goalRunId, requester)).toMatchObject({
          status: 'paused',
          startedTaskIds: [],
          nextTickAt: null,
        });
        expect(await lastPause()).toMatchObject({ detail: stuck });
        expect(await attemptTasks(stepA.id)).toHaveLength(1);

        // Naming a: it runs again, and the run is not stuck while it does.
        expect(await resume(['a'])).toMatchObject({ retriedStepRunIds: [stepA.id] });
        expect(await advance(goalRunId, requester)).toMatchObject({ status: 'running' });
        expect((await stepsOf(goalRunId)).a).toMatchObject({ status: 'running', attemptCount: 2 });
        await completeStep(stepA.id, requester);
        await advance(goalRunId, requester);
        expect((await stepsOf(goalRunId)).c?.status).toBe('running');
      });

      it('legacy 393: the pause names every step that failed for a person, each with what it waits for (review #493 on #657)', async () => {
        const requester = await newPrincipal();
        const goalRunId = await startGoal(requester, [{ key: 'x' }, { key: 'y' }]);
        await advance(goalRunId, requester);
        const steps = await stepsOf(goalRunId);
        await failStep((steps.x as StepRunRow).id, requester, 'no_result');
        await failStep((steps.y as StepRunRow).id, requester, 'no_result');
        await advance(goalRunId, requester);
        expect((await goalOf(goalRunId)).pauseReason).toBe('needs_decision');

        await asRequester(requester, (client) =>
          resumeGoalRun(client, workspaceId, { goalRunId, actor: by(requester) }),
        );
        expect(await advance(goalRunId, requester)).toMatchObject({ status: 'paused' });
        const pause = (await goalAudit(goalRunId))
          .filter((row) => row.action === 'goal_run.pause')
          .at(-1)?.payload;
        expect(pause).toMatchObject({
          reason: 'needs_decision',
          detail:
            'step x: attempt 1 failed (contract_violation) and is not retried on its own — retry it; step y: attempt 1 failed (contract_violation) and is not retried on its own — retry it; or revise the plan or cancel',
        });
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

      it('legacy 364: the cleanup sweep goes on where the previous one stopped, so runs whose leftovers do not end keep no other run waiting', async () => {
        const requester = await newPrincipal();
        const cancelPastDeadline = async () => {
          const goalRunId = await startGoal(requester, [{ key: 'only' }]);
          await advance(goalRunId, requester);
          const step = (await stepsOf(goalRunId)).only as StepRunRow;
          const inDoubt = await requestOn(
            await newGatekeeper(),
            step.id,
            requester,
            'executing',
            'test.364.in-doubt',
          );
          await asRequester(requester, (client) =>
            cancelGoalRun(client, workspaceId, { goalRunId, actor: by(requester) }),
          );
          await advance(goalRunId, requester, { ...NO_BACKOFF, cancelDeadlineMs: 0 });
          expect(await goalOf(goalRunId)).toMatchObject({
            status: 'cancelled',
            cleanupPending: true,
          });
          return { goalRunId, inDoubt };
        };
        const stuck = [await cancelPastDeadline(), await cancelPastDeadline()];
        const done = await cancelPastDeadline();
        await admin((client) => markActionRequestExecuted(client, workspaceId, done.inDoubt));
        const pending = await admin(async (client) =>
          (
            await client.query<{ id: string }>(
              `select id from goal_runs where status = 'cancelled' and cleanup_pending order by id`,
            )
          ).rows.map((row) => row.id),
        );
        expect(pending).toEqual(
          expect.arrayContaining([...stuck.map((run) => run.goalRunId), done.goalRunId]),
        );

        // One run per sweep: each sweep looks at the next run in id order, then starts over.
        const sweepDeps = {
          pool,
          taskRuntime: taskRuntime(),
          onStartError: (err: unknown) => startErrors.push(err),
        };
        const cursor: GoalCleanupCursor = { after: null };
        const visited: (string | null)[] = [];
        for (let sweep = 0; sweep <= pending.length; sweep += 1) {
          await sweepGoalCancelCleanup(sweepDeps, { limit: 1, cursor });
          visited.push(cursor.after);
        }
        expect(visited).toEqual([...pending, null]);
        expect((await goalOf(done.goalRunId)).cleanupPending).toBe(false);
        for (const run of stuck) {
          expect((await goalOf(run.goalRunId)).cleanupPending).toBe(true);
          await admin((client) => markActionRequestExecuted(client, workspaceId, run.inDoubt));
        }
        await sweepGoalCancelCleanup(sweepDeps, { limit: 10_000 });
        for (const run of stuck) expect((await goalOf(run.goalRunId)).cleanupPending).toBe(false);
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

        // A lone nested step holds all of a goal smaller than the workspace default (200000), and
        // its Worker can still start a child: half of what the attempt has not spent (review #493
        // P2-1 on #626).
        const nested = await startGoal(requester, [{ key: 'n', nested: true }], {
          ...BUDGET,
          maxTokens: 150_000,
        });
        await advance(nested, requester);
        const lone = await latestAttempt((await stepsOf(nested)).n?.id as string);
        expect(Number(lone.token_budget)).toBe(150_000);
        expect(
          await admin((tx) =>
            allotChildTokenBudget(tx, workspaceId, {
              goalRunId: nested,
              callerTaskId: lone.id,
              defaultTokenBudget: 200_000,
            }),
          ),
        ).toEqual({ tokenBudget: 75_000, fromCaller: 75_000 });

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

      // ----- S11 GO3b ---------------------------------------------------------------------------

      /** A nested child Task of `stepRunId`, running, carried by a WorkerRun under `parentRunId` —
       *  as `invoke_worker` records one (the child inherits its caller's goal step). */
      async function nestedChild(
        goalRunId: string,
        stepRunId: string,
        parentRunId: string,
        requester: string,
      ): Promise<{ taskId: string; runId: string }> {
        const planRevision = (await goalOf(goalRunId)).currentRevision;
        return admin(async (client) => {
          const task = await client.query<{ id: string }>(
            `insert into tasks (workspace_id, status, on_behalf_of, worker_definition_id,
               worker_definition_version, goal_run_id, step_run_id, plan_revision)
             values ($1, 'running', $2, $3, $4, $5, $6, $7) returning id`,
            [
              workspaceId,
              requester,
              worker.definitionId,
              worker.version,
              goalRunId,
              stepRunId,
              planRevision,
            ],
          );
          const taskId = task.rows[0]?.id as string;
          const run = await client.query<{ id: string }>(
            `insert into worker_runs (workspace_id, status, task_id, parent_worker_run_id)
             values ($1, 'running', $2, $3) returning id`,
            [workspaceId, taskId, parentRunId],
          );
          return { taskId, runId: run.rows[0]?.id as string };
        });
      }

      const endTask = (taskId: string) =>
        admin((client) =>
          client.query(
            `update tasks set status = 'completed', completed_at = now()
              where workspace_id = $1 and id = $2`,
            [workspaceId, taskId],
          ),
        );

      const pauseAs = (goalRunId: string, requester: string) =>
        asRequester(requester, (client) =>
          pauseGoalRun(client, workspaceId, { goalRunId, actor: by(requester) }),
        );
      const resumeAs = (goalRunId: string, requester: string) =>
        asRequester(requester, (client) =>
          resumeGoalRun(client, workspaceId, { goalRunId, actor: by(requester) }),
        );

      const ig9Mentions = async (ids: readonly string[]) => {
        const ig9 = await pool.connect().then(async (client) => {
          try {
            return await checkIG9(client, 100_000);
          } finally {
            client.release();
          }
        });
        return ig9.sample.filter((line) => ids.some((id) => line.includes(id)));
      };

      it('hold: an owner’s pause of someone else’s run holds it; the requester resumes once an owner lifts the hold', async () => {
        const requester = await newPrincipal();
        const member = await newPrincipal();
        const goalRunId = await startGoal(requester, [{ key: 'only', maxAttempts: 1 }]);
        await advance(goalRunId, requester);
        const step = (await stepsOf(goalRunId)).only as StepRunRow;
        const release = (actor: { principalId: string; role: 'owner' | 'member' }) =>
          asRequester(actor.principalId, (client) =>
            releaseGoalRunHold(client, workspaceId, { goalRunId, actor }),
          );

        expect(
          await asOwner((client) =>
            pauseGoalRun(client, workspaceId, { goalRunId, actor: byOwner() }),
          ),
        ).toEqual({ status: 'paused', changed: true });
        expect(await goalOf(goalRunId)).toMatchObject({
          status: 'paused',
          pauseReason: 'requested',
          pausedBy: ownerId,
          pausedByAuthority: 'owner',
        });
        await expect(resumeAs(goalRunId, requester)).rejects.toThrow(
          /a workspace owner holds it; it resumes once an owner lifts the hold/,
        );
        expect(await pauseAs(goalRunId, requester)).toEqual({ status: 'paused', changed: false });
        expect(
          await asOwner((client) =>
            pauseGoalRun(client, workspaceId, { goalRunId, actor: byOwner() }),
          ),
        ).toEqual({ status: 'paused', changed: false });

        // Lifting is an owner's act, not a resume: the run stays paused for its requester.
        await expect(release(by(requester))).rejects.toThrow(/only a workspace owner lifts a hold/);
        await expect(release(by(member))).rejects.toThrow(/only a workspace owner lifts a hold/);
        expect(await release(byOwner())).toEqual({ status: 'paused', changed: true });
        expect(await goalOf(goalRunId)).toMatchObject({
          status: 'paused',
          pauseReason: 'requested',
          pausedBy: null,
          pausedByAuthority: null,
        });
        expect(await release(byOwner())).toEqual({ status: 'paused', changed: false });
        expect(await resumeAs(goalRunId, requester)).toMatchObject({
          status: 'running',
          changed: true,
        });

        // The advancer pauses it; an owner places a hold on top of that pause.
        await failStep(step.id, requester, 'worker_failed');
        await advance(goalRunId, requester);
        expect(await goalOf(goalRunId)).toMatchObject({
          status: 'paused',
          pauseReason: 'needs_decision',
          pausedBy: null,
        });
        expect(
          await asOwner((client) =>
            pauseGoalRun(client, workspaceId, { goalRunId, actor: byOwner() }),
          ),
        ).toEqual({ status: 'paused', changed: true });
        expect(await goalOf(goalRunId)).toMatchObject({
          pauseReason: 'needs_decision',
          pausedBy: ownerId,
          pausedByAuthority: 'owner',
        });
        await expect(resumeAs(goalRunId, requester)).rejects.toThrow(/a workspace owner holds it/);

        const audit = await goalAudit(goalRunId);
        expect(audit.find((row) => row.action === 'goal_run.pause')?.payload).toMatchObject({
          by: 'person',
          pausedByAuthority: 'owner',
        });
        expect(audit.find((row) => row.action === 'goal_run.release_hold')?.payload).toMatchObject({
          by: 'person',
          heldBy: ownerId,
          pauseReason: 'requested',
        });
        expect(audit.find((row) => row.action === 'goal_run.hold')?.payload).toMatchObject({
          by: 'person',
          pauseReason: 'needs_decision',
          previouslyPausedBy: null,
          previousAuthority: null,
        });

        // A hold stops resuming, not cancelling: the requester may still stop the run for good, and
        // leaving `paused` clears who paused.
        expect(
          await asRequester(requester, (client) =>
            cancelGoalRun(client, workspaceId, { goalRunId, actor: by(requester) }),
          ),
        ).toMatchObject({ status: 'cancelling', changed: true });
        expect(await goalOf(goalRunId)).toMatchObject({
          status: 'cancelling',
          pausedBy: null,
          pausedByAuthority: null,
        });

        // A requester who is also an owner pauses their own run as its requester: no hold.
        const ownerRequester = await newPrincipal('owner');
        const own = await startGoal(ownerRequester, [{ key: 'x' }]);
        await advance(own, ownerRequester);
        const asOwnerRequester = { principalId: ownerRequester, role: 'owner' as const };
        await asRequester(ownerRequester, (client) =>
          pauseGoalRun(client, workspaceId, { goalRunId: own, actor: asOwnerRequester }),
        );
        expect(await goalOf(own)).toMatchObject({
          pausedBy: ownerRequester,
          pausedByAuthority: 'requester',
        });
        expect(
          await asRequester(ownerRequester, (client) =>
            resumeGoalRun(client, workspaceId, { goalRunId: own, actor: asOwnerRequester }),
          ),
        ).toMatchObject({ status: 'running', changed: true });
      });

      it('a step is judged only once its nested child Tasks ended; a request the child raised after its caller finished holds the step', async () => {
        const requester = await newPrincipal();
        const goalRunId = await startGoal(requester, [{ key: 'n', nested: true }]);
        await advance(goalRunId, requester);
        const step = (await stepsOf(goalRunId)).n as StepRunRow;
        const child = await nestedChild(goalRunId, step.id, await latestRun(step.id), requester);
        await completeStep(step.id, requester);
        await advance(goalRunId, requester);
        expect((await stepsOf(goalRunId)).n?.status).toBe('running');
        // Nor does the reconcile scan chase it: the child's end wakes the run.
        await markReconcileDue(pool);
        expect(await isDue(goalRunId)).toBe(false);

        const late = await seedAction(step.id, child.runId, 'pending_approval');
        await endTask(child.taskId);
        await advance(goalRunId, requester);
        expect((await stepsOf(goalRunId)).n).toMatchObject({
          status: 'waiting',
          waitingReason: 'approval',
        });
        await setActionStatus(late, 'executed');
        await advance(goalRunId, requester);
        expect((await stepsOf(goalRunId)).n?.status).toBe('succeeded');
        expect((await goalOf(goalRunId)).status).toBe('verifying');

        // A person's retry waits for the step's Tasks too.
        const retried = await startGoal(requester, [{ key: 'r', nested: true, maxAttempts: 1 }]);
        await advance(retried, requester);
        const stepR = (await stepsOf(retried)).r as StepRunRow;
        const childR = await nestedChild(retried, stepR.id, await latestRun(stepR.id), requester);
        await failStep(stepR.id, requester, 'worker_failed');
        await endTask(childR.taskId);
        await advance(retried, requester);
        expect((await stepsOf(retried)).r?.status).toBe('failed');
        await nestedChild(retried, stepR.id, await latestRun(stepR.id), requester);
        await expect(
          asRequester(requester, (client) =>
            resumeGoalRun(client, workspaceId, {
              goalRunId: retried,
              actor: by(requester),
              retrySteps: ['r'],
            }),
          ),
        ).rejects.toThrow(/step r: a Task of it still runs/);
      });

      it('S8 (default): a revision removes a running step — its Tasks, nested child included, are terminated and its requests withdrawn; a kept step runs on, an added one starts on resume', async () => {
        const requester = await newPrincipal();
        const goalRunId = await startGoal(requester, [{ key: 'a', nested: true }, { key: 'b' }]);
        await advance(goalRunId, requester);
        let steps = await stepsOf(goalRunId);
        const stepA = steps.a as StepRunRow;
        const stepB = steps.b as StepRunRow;
        const taskA = (await latestAttempt(stepA.id)).id;
        const child = await nestedChild(goalRunId, stepA.id, await latestRun(stepA.id), requester);
        const gatekeeperId = await newGatekeeper();
        const pending = await requestOn(
          gatekeeperId,
          stepA.id,
          requester,
          'pending_approval',
          'test.go3b.pending',
        );
        const approved = await requestOn(
          gatekeeperId,
          stepA.id,
          requester,
          'approved',
          'test.go3b.approved',
        );
        const executing = await requestOn(
          await newGatekeeper(),
          stepA.id,
          requester,
          'executing',
          'test.go3b.executing',
        );
        const plan2 = planOf([{ key: 'b' }, { key: 'c' }]);
        const revise = (input: { plan: unknown; reason?: string }) =>
          asRequester(requester, (client) =>
            reviseGoalRun(client, workspaceId, {
              goalRunId,
              actor: by(requester),
              basedOnRevision: 1,
              ...input,
            }),
          );

        await expect(revise({ plan: plan2 })).rejects.toThrow(
          /a plan is revised while the run is paused/,
        );
        await pauseAs(goalRunId, requester);
        const revised = await revise({ plan: plan2, reason: 'a is no longer needed' });
        expect(revised).toMatchObject({
          revision: 2,
          supersededStepRunIds: [stepA.id],
          withdrawnActionRequestIds: [pending, approved],
          releasedActionRequestIds: [],
        });
        expect(revised.createdStepRunIds).toHaveLength(1);
        const all = await admin((client) => listStepRuns(client, workspaceId, goalRunId));
        expect(all.find((row) => row.id === stepA.id)).toMatchObject({
          status: 'superseded',
          supersededInRevision: 2,
        });
        steps = await stepsOf(goalRunId);
        expect(steps.a).toBeUndefined();
        expect(steps.b).toMatchObject({ id: stepB.id, status: 'running', introducedInRevision: 1 });
        expect(steps.c).toMatchObject({
          id: revised.createdStepRunIds[0],
          status: 'pending',
          introducedInRevision: 2,
        });
        expect(await actionStatus(pending)).toBe('withdrawn');
        expect(await actionStatus(approved)).toBe('withdrawn');
        expect(
          (await auditOf(pending)).find((row) => row.action === 'action_request.withdraw'),
        ).toMatchObject({
          actor_principal_id: requester,
          payload: expect.objectContaining({ reason: GOAL_REVISED_WITHDRAW_REASON }),
        });
        expect(await goalOf(goalRunId)).toMatchObject({
          status: 'paused',
          pauseReason: 'requested',
          currentRevision: 2,
        });
        expect(await isDue(goalRunId)).toBe(true);
        expect(
          await admin((client) => getPlanRevision(client, workspaceId, goalRunId, 2)),
        ).toMatchObject({
          status: 'accepted',
          basedOnRevision: 1,
          proposedBy: requester,
          decidedBy: requester,
          reason: 'a is no longer needed',
          removals: {},
        });
        expect(
          (await goalAudit(goalRunId)).find((row) => row.action === 'goal_run.revise')?.payload,
        ).toMatchObject({
          by: 'person',
          revision: 2,
          basedOnRevision: 1,
          superseded: ['a'],
          created: ['c'],
          withdrawn: 2,
          released: 0,
        });

        // The superseded step takes no new work; the next advance terminates its Tasks.
        await expect(
          admin((tx) => lockGoalStepForNewWork(tx, workspaceId, stepA.id, 'request_action')),
        ).rejects.toBeInstanceOf(GoalStepClosedError);
        const outcome = await advance(goalRunId, requester);
        expect([...outcome.terminatedTaskIds].sort()).toEqual([taskA, child.taskId].sort());
        expect(await taskStatus(taskA)).toBe('cancelled');
        expect(await taskStatus(child.taskId)).toBe('cancelled');
        expect((await goalOf(goalRunId)).status).toBe('paused');

        await resumeAs(goalRunId, requester);
        await advance(goalRunId, requester);
        steps = await stepsOf(goalRunId);
        expect(steps.b?.status).toBe('running');
        expect(steps.c?.status).toBe('running');

        // b and c finish; the action a started before the revision still runs, so the run does
        // not verify until it has ended (the R-48 way).
        expect(await actionStatus(executing)).toBe('executing');
        await completeStep(stepB.id, requester);
        await completeStep(steps.c?.id as string, requester);
        await advance(goalRunId, requester);
        steps = await stepsOf(goalRunId);
        expect([steps.b?.status, steps.c?.status]).toEqual(['succeeded', 'succeeded']);
        expect((await goalOf(goalRunId)).status).toBe('running');
        await admin((client) => markActionRequestExecuted(client, workspaceId, executing));
        await advance(goalRunId, requester);
        expect((await goalOf(goalRunId)).status).toBe('verifying');
        expect(await ig9Mentions([pending, approved, executing])).toEqual([]);
      });

      it('S8 (let it finish): its Tasks run on but raise nothing new; the released request is decided and runs as usual, the others are withdrawn; the run verifies once nothing of it runs', async () => {
        const requester = await newPrincipal();
        const goalRunId = await startGoal(requester, [{ key: 'a', nested: true }, { key: 'b' }]);
        await advance(goalRunId, requester);
        const steps = await stepsOf(goalRunId);
        const stepA = steps.a as StepRunRow;
        const stepB = steps.b as StepRunRow;
        const taskA = (await latestAttempt(stepA.id)).id;
        const child = await nestedChild(goalRunId, stepA.id, await latestRun(stepA.id), requester);
        const gatekeeperId = await newGatekeeper();
        const released = await requestOn(
          gatekeeperId,
          stepA.id,
          requester,
          'pending_approval',
          'test.go3b.released',
        );
        const dropped = await requestOn(
          gatekeeperId,
          stepA.id,
          requester,
          'approved',
          'test.go3b.dropped',
        );
        const running = await requestOn(
          await newGatekeeper(),
          stepA.id,
          requester,
          'executing',
          'test.go3b.running',
        );
        await pauseAs(goalRunId, requester);
        const plan2 = planOf([{ key: 'b' }]);
        const revise = (removals: unknown) =>
          asRequester(requester, (client) =>
            reviseGoalRun(client, workspaceId, {
              goalRunId,
              actor: by(requester),
              basedOnRevision: 1,
              plan: plan2,
              removals,
            }),
          );

        await expect(revise({ b: { mode: 'let_finish' } })).rejects.toThrow(
          /step b is not a step this revision removes or changes while it runs/,
        );
        await expect(revise({ a: { mode: 'terminate', release: [released] } })).rejects.toThrow(
          /requests are released only from a step let to finish/,
        );
        await expect(revise({ a: { mode: 'let_finish', release: [running] } })).rejects.toThrow(
          /is not one of its requests awaiting a decision or approved and queued/,
        );
        await expect(
          revise({ a: { mode: 'let_finish', release: [randomUUID()] } }),
        ).rejects.toThrow(/is not one of its requests/);
        await expect(
          revise({ a: { mode: 'let_finish', release: [released, released] } }),
        ).rejects.toThrow(/a request is released once/);
        await expect(revise({ a: { mode: 'sideways' } })).rejects.toThrow(/removals: a\.mode/);
        expect((await goalOf(goalRunId)).currentRevision).toBe(1);

        const revised = await revise({ a: { mode: 'let_finish', release: [released] } });
        expect(revised).toMatchObject({
          revision: 2,
          supersededStepRunIds: [stepA.id],
          createdStepRunIds: [],
          withdrawnActionRequestIds: [dropped],
          releasedActionRequestIds: [released],
        });
        expect(await actionStatus(released)).toBe('pending_approval');
        expect(await actionStatus(dropped)).toBe('withdrawn');
        expect(await actionStatus(running)).toBe('executing');
        expect(
          (await auditOf(released)).find((row) => row.action === 'action_request.release'),
        ).toMatchObject({
          actor_principal_id: requester,
          payload: expect.objectContaining({ goalRunId, stepRunId: stepA.id, revision: 2 }),
        });
        expect(
          (await admin((client) => getPlanRevision(client, workspaceId, goalRunId, 2)))?.removals,
        ).toEqual({ a: { mode: 'let_finish', release: [released] } });

        // Its Tasks run on — the advance terminates nothing — but neither the step's Worker nor its
        // nested child raises anything new.
        const outcome = await advance(goalRunId, requester);
        expect(outcome.terminatedTaskIds).toEqual([]);
        expect(await taskStatus(taskA)).toBe('running');
        expect(await taskStatus(child.taskId)).toBe('running');
        await expect(
          admin((tx) => lockGoalStepForNewWork(tx, workspaceId, stepA.id, 'request_action')),
        ).rejects.toBeInstanceOf(GoalStepClosedError);
        await markReconcileDue(pool);
        expect(await isDue(goalRunId)).toBe(false);

        // The released request is decided and runs as usual.
        await admin((client) =>
          approveActionRequest(client, workspaceId, {
            actionRequestId: released,
            approverPrincipalId: ownerId,
            approverRole: 'owner',
          }),
        );
        await admin((client) => startActionRequestExecution(client, workspaceId, released));
        await admin((client) => markActionRequestExecuted(client, workspaceId, released));
        expect(await actionStatus(released)).toBe('executed');

        // Nothing of a is in flight any more; b finishes. The run does not verify while a's Tasks
        // run: a's Worker, then its child.
        await admin((client) => markActionRequestExecuted(client, workspaceId, running));
        await resumeAs(goalRunId, requester);
        await completeStep(stepB.id, requester);
        await advance(goalRunId, requester);
        expect((await stepsOf(goalRunId)).b?.status).toBe('succeeded');
        expect((await goalOf(goalRunId)).status).toBe('running');
        // Their results stay on their Tasks; the step moves no more.
        await completeStep(stepA.id, requester);
        await advance(goalRunId, requester);
        expect((await goalOf(goalRunId)).status).toBe('running');
        await endTask(child.taskId);
        await advance(goalRunId, requester);
        expect((await goalOf(goalRunId)).status).toBe('verifying');
        const all = await admin((client) => listStepRuns(client, workspaceId, goalRunId));
        expect(all.find((row) => row.id === stepA.id)?.status).toBe('superseded');
        // I-G9: the released request ran after its step was superseded — not a breach.
        expect(await ig9Mentions([released, dropped, running])).toEqual([]);
      });

      it('revising: the requester alone, on the current revision, within the revision budget; a step that ended is kept, not redefined', async () => {
        const requester = await newPrincipal();
        const goalRunId = await startGoal(requester, [{ key: 'a' }, { key: 'b' }], {
          ...BUDGET,
          maxRevisions: 1,
        });
        await advance(goalRunId, requester);
        await completeStep(((await stepsOf(goalRunId)).a as StepRunRow).id, requester);
        await advance(goalRunId, requester);
        expect((await stepsOf(goalRunId)).a?.status).toBe('succeeded');
        await pauseAs(goalRunId, requester);
        const revise = (
          basedOnRevision: number,
          steps: readonly StepSpec[],
          extra: { budget?: GoalRunBudget; reason?: string } = {},
          actor: { principalId: string; role: 'owner' | 'member' } = by(requester),
        ) =>
          asRequester(actor.principalId, (client) =>
            reviseGoalRun(client, workspaceId, {
              goalRunId,
              actor,
              basedOnRevision,
              plan: planOf(steps),
              ...extra,
            }),
          );

        await expect(revise(1, [{ key: 'b' }], {}, byOwner())).rejects.toThrow(
          /only the requester revises a goal run/,
        );
        await expect(revise(2, [{ key: 'b' }])).rejects.toThrow(
          /based on 2, but the current revision is 1 \(I-G3\)/,
        );
        await expect(
          revise(1, [{ key: 'a', input: { step: 'a', changed: true } }, { key: 'b' }]),
        ).rejects.toThrow(/step a is succeeded; its definition cannot change/);
        await expect(revise(1, [{ key: 'b', dependsOn: ['b'] }])).rejects.toBeInstanceOf(
          GoalPlanValidationError,
        );
        await expect(revise(1, [{ key: 'b' }], { reason: 'x'.repeat(2001) })).rejects.toThrow(
          /at most 2000 characters/,
        );

        // Dropped after it succeeded: a stays, as history; b is kept as it was.
        const stepB = (await stepsOf(goalRunId)).b as StepRunRow;
        expect(await revise(1, [{ key: 'b' }])).toMatchObject({
          revision: 2,
          supersededStepRunIds: [],
          createdStepRunIds: [],
        });
        const steps = await stepsOf(goalRunId);
        expect(steps.a).toMatchObject({ status: 'succeeded', supersededInRevision: null });
        expect(steps.b?.id).toBe(stepB.id);

        await expect(revise(2, [{ key: 'b' }, { key: 'c' }])).rejects.toThrow(
          /1 of 1 revisions already made/,
        );
        // A revision may bring a larger budget, revisions included: it takes effect with it.
        const third = await revise(2, [{ key: 'b' }, { key: 'c' }], {
          budget: { ...BUDGET, maxRevisions: 2 },
        });
        expect(third).toMatchObject({ revision: 3 });
        expect(third.createdStepRunIds).toHaveLength(1);
        expect(await goalOf(goalRunId)).toMatchObject({
          currentRevision: 3,
          budget: { maxRevisions: 2 },
        });

        // Only at a pause point: a running run is not revised.
        await resumeAs(goalRunId, requester);
        await expect(revise(3, [{ key: 'b' }, { key: 'c' }])).rejects.toThrow(
          /is running; a plan is revised while the run is paused/,
        );
      });

      it('a step whose key a revision redefined does not start beside what the step it replaces still runs; an outcome-unknown action pauses the run for a reconcile', async () => {
        const requester = await newPrincipal();
        const redefine = async (key = 'a', unknownFirst = false) => {
          const goalRunId = await startGoal(requester, [{ key: 'a' }]);
          await advance(goalRunId, requester);
          const before = (await stepsOf(goalRunId)).a as StepRunRow;
          const action = await requestOn(
            await newGatekeeper(),
            before.id,
            requester,
            'executing',
            'test.go3b.redefined',
          );
          if (unknownFirst) {
            await admin((client) =>
              markActionRequestFailed(client, workspaceId, action, {
                failureKind: 'outcome_unknown',
              }),
            );
          }
          await pauseAs(goalRunId, requester);
          await asRequester(requester, (client) =>
            reviseGoalRun(client, workspaceId, {
              goalRunId,
              actor: by(requester),
              basedOnRevision: 1,
              plan: planOf([{ key, input: { step: 'a', changed: true } }]),
            }),
          );
          await advance(goalRunId, requester);
          await resumeAs(goalRunId, requester);
          await advance(goalRunId, requester);
          return { goalRunId, action };
        };

        const executed = await redefine();
        expect((await stepsOf(executed.goalRunId)).a).toMatchObject({
          status: 'ready',
          introducedInRevision: 2,
          attemptCount: 0,
        });
        expect((await advance(executed.goalRunId, requester)).nextTickAt?.getTime()).toBeLessThan(
          Date.now() + DEFAULT_BLOCKED_RETRY_RECHECK_MS + 5000,
        );
        await admin((client) => markActionRequestExecuted(client, workspaceId, executed.action));
        await advance(executed.goalRunId, requester);
        expect((await stepsOf(executed.goalRunId)).a).toMatchObject({
          status: 'running',
          attemptCount: 1,
        });

        const unknown = await redefine();
        await admin((client) =>
          markActionRequestFailed(client, workspaceId, unknown.action, {
            failureKind: 'outcome_unknown',
          }),
        );
        await advance(unknown.goalRunId, requester);
        expect(await goalOf(unknown.goalRunId)).toMatchObject({
          status: 'paused',
          pauseReason: 'awaiting_reconcile',
        });
        expect((await stepsOf(unknown.goalRunId)).a?.status).toBe('ready');

        // Review #493 on #633: renaming the step does not get past the outcome-unknown action — no
        // attempt of the run starts while it waits for a reconcile, whatever the key …
        const renamed = await redefine('a2', true);
        await advance(renamed.goalRunId, requester);
        expect(await goalOf(renamed.goalRunId)).toMatchObject({
          status: 'paused',
          pauseReason: 'awaiting_reconcile',
        });
        expect((await stepsOf(renamed.goalRunId)).a2).toMatchObject({
          status: 'ready',
          attemptCount: 0,
        });

        // … while one still in flight holds only the step that took over its key: a renamed step
        // runs beside it, the person's choice, nothing in doubt.
        const beside = await redefine('a2');
        expect((await stepsOf(beside.goalRunId)).a2).toMatchObject({
          status: 'running',
          attemptCount: 1,
        });
        expect((await goalOf(beside.goalRunId)).status).toBe('running');
      });

      it('legacy 356: a run whose advances keep failing pauses for a person; an advance that commits, or a resume, starts the count again', async () => {
        const requester = await newPrincipal();
        const goalRunId = await startGoal(requester, [{ key: 'a' }]);
        await advance(goalRunId, requester);
        const errors: unknown[] = [];
        let crashing = true;
        // Fails the advance of this run only: after its GoalRun lock, at the advance's clock read.
        const flaky: PoolLike = {
          async connect() {
            const client = await pool.connect();
            const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
            let mine = false;
            (client as { query: unknown }).query = async (...args: unknown[]) => {
              const [text, params] = args as [unknown, unknown[] | undefined];
              if (typeof text === 'string' && text.includes('for no key update')) {
                mine = params?.[1] === goalRunId;
              }
              if (crashing && mine && text === 'select now() as now') {
                throw new Error('simulated advance failure, token=sk-ant-abcdefghijklmnopqrstuv');
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
        const tick = async () => {
          await admin((client) =>
            client.query(
              "update goal_runs set next_tick_at = '2000-01-01' where workspace_id = $1 and id = $2",
              [workspaceId, goalRunId],
            ),
          );
          await runGoalAdvancerTick(
            { pool: flaky, taskRuntime: taskRuntime(), options: NO_BACKOFF },
            { limit: 1, onError: (err) => errors.push(err) },
          );
        };

        for (let n = 1; n <= 4; n += 1) {
          await tick();
          expect(await goalOf(goalRunId)).toMatchObject({ status: 'running', advanceFailures: n });
        }
        await tick();
        expect(await goalOf(goalRunId)).toMatchObject({
          status: 'paused',
          pauseReason: 'needs_decision',
          advanceFailures: 5,
          nextTickAt: null,
        });
        expect(errors).toHaveLength(5);
        const pause = (await goalAudit(goalRunId)).find((row) => row.action === 'goal_run.pause');
        expect(pause?.payload).toMatchObject({
          by: 'advancer',
          reason: 'needs_decision',
          detail: 'the advance failed 5 times in a row',
        });
        expect(String(pause?.payload.lastError)).toContain('simulated advance failure');
        expect(String(pause?.payload.lastError)).not.toContain('abcdefghijklmnopqrstuv');

        // Paused and still failing: no lease retries, and the reconcile scan leaves it alone.
        await completeStep(((await stepsOf(goalRunId)).a as StepRunRow).id, requester);
        await markReconcileDue(pool);
        expect(await isDue(goalRunId)).toBe(false);
        await tick();
        expect(await goalOf(goalRunId)).toMatchObject({ advanceFailures: 6, nextTickAt: null });
        expect(
          (await goalAudit(goalRunId)).filter((row) => row.action === 'goal_run.advance_failing'),
        ).toHaveLength(0);

        // A person's revision starts the count again (review #493 on #633: past the limit the
        // scan skips the run, and with it terminating the Tasks a revision stops); so does a
        // resume, and an advance that commits clears it.
        await admin((client) =>
          client.query(
            'update goal_runs set advance_failures = 5 where workspace_id = $1 and id = $2',
            [workspaceId, goalRunId],
          ),
        );
        await asRequester(requester, (client) =>
          reviseGoalRun(client, workspaceId, {
            goalRunId,
            actor: by(requester),
            basedOnRevision: 1,
            plan: planOf([{ key: 'a' }]),
          }),
        );
        expect(await goalOf(goalRunId)).toMatchObject({ status: 'paused', advanceFailures: 0 });
        await admin((client) =>
          client.query(
            'update goal_runs set advance_failures = 5 where workspace_id = $1 and id = $2',
            [workspaceId, goalRunId],
          ),
        );
        await resumeAs(goalRunId, requester);
        expect(await goalOf(goalRunId)).toMatchObject({ status: 'running', advanceFailures: 0 });
        await tick();
        expect((await goalOf(goalRunId)).advanceFailures).toBe(1);
        crashing = false;
        await tick();
        expect(await goalOf(goalRunId)).toMatchObject({ status: 'verifying', advanceFailures: 0 });

        // A cancelling run keeps its lease — its cleanup must keep being tried — and the streak
        // is noted once.
        const cancelling = await startGoal(requester, [{ key: 'c' }]);
        await advance(cancelling, requester);
        await asRequester(requester, (client) =>
          cancelGoalRun(client, workspaceId, { goalRunId: cancelling, actor: by(requester) }),
        );
        await admin((client) =>
          client.query(
            'update goal_runs set advance_failures = 4 where workspace_id = $1 and id = $2',
            [workspaceId, cancelling],
          ),
        );
        const failure = new Error('cleanup failed');
        const deps = { pool, taskRuntime: taskRuntime(), options: NO_BACKOFF };
        const target = { workspaceId, goalRunId: cancelling, requesterId: requester };
        await recordAdvanceFailure(deps, target, failure);
        await recordAdvanceFailure(deps, target, failure);
        expect(await goalOf(cancelling)).toMatchObject({
          status: 'cancelling',
          advanceFailures: 6,
        });
        expect((await goalOf(cancelling)).nextTickAt).not.toBeNull();
        expect(
          (await goalAudit(cancelling)).filter((row) => row.action === 'goal_run.advance_failing'),
        ).toEqual([
          expect.objectContaining({
            payload: expect.objectContaining({
              status: 'cancelling',
              detail: 'the advance failed 5 times in a row',
              lastError: 'cleanup failed',
            }),
          }),
        ]);
      });

      describe('reconciling an action whose outcome is unknown, and the wait on the step (S11 GO3c)', () => {
        const lose = (id: string) =>
          admin((client) =>
            markActionRequestFailed(client, workspaceId, id, { failureKind: 'outcome_unknown' }),
          );

        const reconcileAs = (
          goalRunId: string,
          actionRequestId: string,
          decider: string,
          input: { verdict?: 'effect_seen' | 'effect_absent'; reexecute?: boolean },
        ) =>
          asRequester(decider, (client) =>
            reconcileGoalAction(client, workspaceId, {
              goalRunId,
              actionRequestId,
              deciderPrincipalId: decider,
              ...input,
            }),
          );

        const unresolved = (goalRunId: string) =>
          admin((client) => listGoalRunUnresolvedActions(client, workspaceId, goalRunId));

        const approveAndRun = async (id: string) => {
          await admin((client) =>
            approveActionRequest(client, workspaceId, {
              actionRequestId: id,
              approverPrincipalId: ownerId,
              approverRole: 'owner',
            }),
          );
          await admin((client) => startActionRequestExecution(client, workspaceId, id));
          await admin((client) => markActionRequestExecuted(client, workspaceId, id));
        };

        /** The Worker of the step's latest attempt asks for `actionKind` with `params` — with the
         *  step, the request's identity (I-G4) — and gets what `request_action` gives it. */
        async function ask(
          gatekeeperId: string,
          stepRunId: string,
          onBehalfOf: string,
          actionKind: string,
          params: Record<string, unknown> = {},
          awaitDecision = false,
        ) {
          const parentWorkerRunId = await latestRun(stepRunId);
          return admin((client) =>
            requestAction(client, workspaceId, {
              gatekeeperId,
              actionKind,
              blastRadius: 'medium',
              operationAutoApprovable: true,
              awaitDecision,
              onBehalfOf,
              actorRuntime: 'pi',
              params,
              stepRunId,
              parentWorkerRunId,
              requesterScope: {
                capabilities: ['request_action'],
                resources: { gatekeeper: [gatekeeperId] },
              },
            }),
          );
        }

        it('effect_seen counts as executed: the step succeeds, and the run the advancer paused for the check goes on once the requester resumes it', async () => {
          const requester = await newPrincipal();
          const member = await newPrincipal();
          const goalRunId = await startGoal(requester, [
            { key: 'a' },
            { key: 'b', dependsOn: ['a'] },
          ]);
          await advance(goalRunId, requester);
          const stepA = (await stepsOf(goalRunId)).a as StepRunRow;
          const action = await requestOn(
            await newGatekeeper(),
            stepA.id,
            requester,
            'executing',
            'test.go3c.seen',
          );
          await lose(action);
          await completeStep(stepA.id, requester);
          await advance(goalRunId, requester);
          expect((await stepsOf(goalRunId)).a).toMatchObject({
            status: 'waiting',
            waitingReason: 'reconcile',
          });
          expect(await goalOf(goalRunId)).toMatchObject({
            status: 'paused',
            pauseReason: 'awaiting_reconcile',
          });
          expect(await unresolved(goalRunId)).toEqual([
            expect.objectContaining({
              actionRequestId: action,
              stepKey: 'a',
              actionKindTag: 'test.go3c.seen',
              needs: 'finding',
            }),
          ]);

          await expect(
            reconcileAs(goalRunId, action, member, { verdict: 'effect_seen' }),
          ).rejects.toBeInstanceOf(ActionReconciliationForbiddenError);
          // Until someone checked, the run stays paused.
          await advance(goalRunId, requester);
          expect((await goalOf(goalRunId)).status).toBe('paused');

          expect(
            await reconcileAs(goalRunId, action, requester, { verdict: 'effect_seen' }),
          ).toMatchObject({ changed: true });
          expect(await isDue(goalRunId)).toBe(true);
          expect(await unresolved(goalRunId)).toEqual([]);
          await advance(goalRunId, requester);
          const judged = await stepsOf(goalRunId);
          expect(judged.a?.status).toBe('succeeded');
          expect(judged.b?.status).toBe('ready');
          // A finding resumes nothing: the requester does (review #493 on #642).
          expect((await goalOf(goalRunId)).status).toBe('paused');
          await resumeAs(goalRunId, requester);
          await advance(goalRunId, requester);
          expect((await stepsOf(goalRunId)).b?.status).toBe('running');
          expect((await goalOf(goalRunId)).status).toBe('running');
          expect(
            (await goalAudit(goalRunId))
              .filter((row) => row.action === 'goal_run.resume')
              .map((row) => row.payload),
          ).toEqual([expect.objectContaining({ by: 'person', pauseReason: 'awaiting_reconcile' })]);
        });

        it('a finding — effect_seen, or effect_absent with a re-execute — never changes how a run is paused, whoever paused it; the requester resumes it (review #493 on #642)', async () => {
          type PauseSource =
            | 'advancer'
            | 'requester'
            | 'requester over the advancer'
            | 'owner hold'
            | 'lifted hold';
          const pauseOf = (goal: GoalRunRow) => ({
            status: goal.status,
            pauseReason: goal.pauseReason,
            pausedBy: goal.pausedBy,
            pausedByAuthority: goal.pausedByAuthority,
          });
          const findings = [
            { verdict: 'effect_seen' },
            { verdict: 'effect_absent', reexecute: true },
          ] as const;
          const sources: readonly PauseSource[] = [
            'advancer',
            'requester',
            'requester over the advancer',
            'owner hold',
            'lifted hold',
          ];
          for (const source of sources) {
            for (const finding of findings) {
              const requester = await newPrincipal();
              const goalRunId = await startGoal(requester, [
                { key: 'a' },
                { key: 'b', dependsOn: ['a'] },
              ]);
              await advance(goalRunId, requester);
              const pauseAsRequester = () =>
                asRequester(requester, (client) =>
                  pauseGoalRun(client, workspaceId, { goalRunId, actor: by(requester) }),
                );
              // The requester's own pause comes first: the advancer only notes the check on it.
              if (source === 'requester') {
                expect(await pauseAsRequester()).toMatchObject({ changed: true });
              }
              const stepA = (await stepsOf(goalRunId)).a as StepRunRow;
              const action = await requestOn(
                await newGatekeeper(),
                stepA.id,
                requester,
                'executing',
                'test.go3c.intent',
              );
              await lose(action);
              await completeStep(stepA.id, requester);
              await advance(goalRunId, requester);
              expect((await stepsOf(goalRunId)).a?.waitingReason).toBe('reconcile');
              if (source === 'requester over the advancer') {
                // Nothing on the row says the requester wants it held: the call changes nothing.
                expect(await pauseAsRequester()).toMatchObject({ changed: false });
              }
              if (source === 'owner hold' || source === 'lifted hold') {
                await asOwner((client) =>
                  pauseGoalRun(client, workspaceId, { goalRunId, actor: byOwner() }),
                );
              }
              if (source === 'lifted hold') {
                await asOwner((client) =>
                  releaseGoalRunHold(client, workspaceId, { goalRunId, actor: byOwner() }),
                );
              }
              const before = pauseOf(await goalOf(goalRunId));
              expect(before.status).toBe('paused');

              await reconcileAs(goalRunId, action, requester, finding);
              await advance(goalRunId, requester);
              await advance(goalRunId, requester);
              expect(
                { source, finding, pause: pauseOf(await goalOf(goalRunId)) },
                'a finding leaves the pause as it was',
              ).toEqual({ source, finding, pause: before });
              expect((await stepsOf(goalRunId)).b?.status).not.toBe('running');
              expect(await attemptTasks(stepA.id)).toHaveLength(1);
              expect(
                (await goalAudit(goalRunId)).some((row) => row.action === 'goal_run.resume'),
              ).toBe(false);

              // The requester resumes — once no owner holds it — and the run goes on.
              if (source === 'owner hold') {
                await expect(resumeAs(goalRunId, requester)).rejects.toThrow(/holds it/);
                continue;
              }
              await resumeAs(goalRunId, requester);
              await advance(goalRunId, requester);
              const steps = await stepsOf(goalRunId);
              if (finding.verdict === 'effect_seen') {
                expect(steps.b?.status).toBe('running');
              } else {
                expect(steps.a).toMatchObject({ status: 'running', attemptCount: 2 });
              }
            }
          }
        });

        it('effect_absent: the step fails for a person and is never run again on its own; once the requester decided to, a retry makes the request anew, for a new approval', async () => {
          const requester = await newPrincipal();
          const goalRunId = await startGoal(requester, [{ key: 'only' }]);
          await advance(goalRunId, requester);
          const step = (await stepsOf(goalRunId)).only as StepRunRow;
          const gatekeeperId = await newGatekeeper();
          const first = await requestOn(
            gatekeeperId,
            step.id,
            requester,
            'approved',
            'test.go3c.absent',
          );
          await admin((client) => startActionRequestExecution(client, workspaceId, first));
          await lose(first);
          await failStep(step.id, requester, 'worker_failed');
          await advance(goalRunId, requester);
          expect(await goalOf(goalRunId)).toMatchObject({
            status: 'paused',
            pauseReason: 'awaiting_reconcile',
          });

          // An owner checks the target: nothing there. The step fails for a person; the run stays
          // paused (the advancer notes the decision it waits for) until the requester resumes it.
          await reconcileAs(goalRunId, first, ownerId, { verdict: 'effect_absent' });
          await advance(goalRunId, requester);
          expect((await stepsOf(goalRunId)).only).toMatchObject({
            status: 'failed',
            failureCategory: 'outcome_unknown',
            attemptCount: 1,
          });
          expect((await goalOf(goalRunId)).status).toBe('paused');
          expect(
            (await goalAudit(goalRunId)).find((row) => row.action === 'goal_run.pause_noted')
              ?.payload,
          ).toMatchObject({ by: 'advancer', reason: 'needs_decision' });
          expect(await unresolved(goalRunId)).toEqual([
            expect.objectContaining({ actionRequestId: first, needs: 'decision' }),
          ]);
          const retry = () =>
            asRequester(requester, (client) =>
              resumeGoalRun(client, workspaceId, {
                goalRunId,
                actor: by(requester),
                retrySteps: ['only'],
              }),
            );
          await expect(retry()).rejects.toThrow(/found to have no effect/);
          // Resumed without a retry (legacy 393): nothing of the run moves, so the next advance
          // pauses it again at once, saying what it waits for — the decision before a retry.
          const resumeOnly = () =>
            asRequester(requester, (client) =>
              resumeGoalRun(client, workspaceId, { goalRunId, actor: by(requester) }),
            );
          const lastPause = async () =>
            (await goalAudit(goalRunId)).filter((row) => row.action === 'goal_run.pause').at(-1)
              ?.payload;
          await resumeOnly();
          expect(await advance(goalRunId, requester)).toMatchObject({
            status: 'paused',
            nextTickAt: null,
          });
          expect(await goalOf(goalRunId)).toMatchObject({ pauseReason: 'needs_decision' });
          expect(await lastPause()).toMatchObject({
            reason: 'needs_decision',
            detail:
              'step only: an action of it was found to have no effect and is not run again on its own — decide to run it again, then retry the step; or revise the plan or cancel',
          });
          await expect(
            reconcileAs(goalRunId, first, ownerId, { reexecute: true }),
          ).rejects.toBeInstanceOf(ActionReconciliationForbiddenError);

          await reconcileAs(goalRunId, first, requester, { reexecute: true });
          expect(await unresolved(goalRunId)).toEqual([]);
          // Paused for a decision: nothing runs until the requester resumes.
          await advance(goalRunId, requester);
          expect((await goalOf(goalRunId)).status).toBe('paused');
          expect(await attemptTasks(step.id)).toHaveLength(1);
          // Decided, but resumed without naming the step: paused again, now sent to the retry.
          await resumeOnly();
          await advance(goalRunId, requester);
          expect(await lastPause()).toMatchObject({
            detail:
              'step only: attempt 1 failed (outcome_unknown) and is not retried on its own — retry it; or revise the plan or cancel',
          });
          expect(await attemptTasks(step.id)).toHaveLength(1);
          expect(await retry()).toMatchObject({ status: 'running', retriedStepRunIds: [step.id] });
          await advance(goalRunId, requester);
          expect((await stepsOf(goalRunId)).only).toMatchObject({
            status: 'running',
            attemptCount: 2,
          });

          const again = await ask(gatekeeperId, step.id, requester, 'test.go3c.absent');
          expect(again.id).not.toBe(first);
          expect(again).toMatchObject({
            status: 'pending_approval',
            parentWorkerRunId: await latestRun(step.id),
          });
          await expect(
            ask(gatekeeperId, step.id, requester, 'test.go3c.absent'),
          ).resolves.toMatchObject({ id: again.id });
        });

        it('no effect, run it again, in one decision: once the requester resumes the run the advancer paused, a new attempt starts; under an owner’s hold it waits for the hold to be lifted and the requester to resume', async () => {
          const requester = await newPrincipal();
          const lost = async () => {
            const goalRunId = await startGoal(requester, [{ key: 'only' }]);
            await advance(goalRunId, requester);
            const step = (await stepsOf(goalRunId)).only as StepRunRow;
            const action = await requestOn(
              await newGatekeeper(),
              step.id,
              requester,
              'executing',
              'test.go3c.again',
            );
            await lose(action);
            await completeStep(step.id, requester);
            return { goalRunId, action };
          };

          const free = await lost();
          await advance(free.goalRunId, requester);
          expect(await goalOf(free.goalRunId)).toMatchObject({
            status: 'paused',
            pauseReason: 'awaiting_reconcile',
          });
          await reconcileAs(free.goalRunId, free.action, requester, {
            verdict: 'effect_absent',
            reexecute: true,
          });
          await advance(free.goalRunId, requester);
          expect((await stepsOf(free.goalRunId)).only).toMatchObject({
            status: 'failed',
            failureCategory: 'transient',
            attemptCount: 1,
          });
          expect((await goalOf(free.goalRunId)).status).toBe('paused');
          await resumeAs(free.goalRunId, requester);
          await advance(free.goalRunId, requester);
          expect((await goalOf(free.goalRunId)).status).toBe('running');
          expect((await stepsOf(free.goalRunId)).only).toMatchObject({
            status: 'running',
            attemptCount: 2,
          });

          const held = await lost();
          await asOwner((client) =>
            pauseGoalRun(client, workspaceId, { goalRunId: held.goalRunId, actor: byOwner() }),
          );
          await advance(held.goalRunId, requester);
          expect((await stepsOf(held.goalRunId)).only).toMatchObject({
            status: 'waiting',
            waitingReason: 'reconcile',
          });
          expect(await goalOf(held.goalRunId)).toMatchObject({
            status: 'paused',
            pauseReason: 'requested',
            pausedByAuthority: 'owner',
          });
          // The requester still checks and decides under the hold; a finding runs nothing.
          await reconcileAs(held.goalRunId, held.action, requester, {
            verdict: 'effect_absent',
            reexecute: true,
          });
          await advance(held.goalRunId, requester);
          expect((await stepsOf(held.goalRunId)).only).toMatchObject({
            status: 'failed',
            failureCategory: 'transient',
            attemptCount: 1,
          });
          expect((await goalOf(held.goalRunId)).status).toBe('paused');
          await expect(resumeAs(held.goalRunId, requester)).rejects.toThrow(/holds it/);
          await asOwner((client) =>
            releaseGoalRunHold(client, workspaceId, {
              goalRunId: held.goalRunId,
              actor: byOwner(),
            }),
          );
          await resumeAs(held.goalRunId, requester);
          await advance(held.goalRunId, requester);
          expect((await stepsOf(held.goalRunId)).only).toMatchObject({
            status: 'running',
            attemptCount: 2,
          });
        });

        it('a cancelled run: what was found about an action whose outcome is unknown is still recorded, and nothing is run again', async () => {
          const requester = await newPrincipal();
          const goalRunId = await startGoal(requester, [{ key: 'only' }]);
          await advance(goalRunId, requester);
          const step = (await stepsOf(goalRunId)).only as StepRunRow;
          const action = await requestOn(
            await newGatekeeper(),
            step.id,
            requester,
            'executing',
            'test.go3c.cancelled',
          );
          await asOwner((client) =>
            cancelGoalRun(client, workspaceId, { goalRunId, actor: byOwner() }),
          );
          await advance(goalRunId, requester);
          await advance(goalRunId, requester);
          await advance(goalRunId, requester, { ...NO_BACKOFF, cancelDeadlineMs: 0 });
          expect((await goalOf(goalRunId)).status).toBe('cancelled');
          // The gate's answer comes after the cancel: the outcome is unknown.
          await lose(action);
          expect(await unresolved(goalRunId)).toEqual([
            expect.objectContaining({ actionRequestId: action, needs: 'finding' }),
          ]);

          await expect(
            reconcileAs(goalRunId, action, requester, {
              verdict: 'effect_absent',
              reexecute: true,
            }),
          ).rejects.toThrow(/a request is run again only in a run that can still run/);
          expect(await unresolved(goalRunId)).toHaveLength(1);
          const other = await startGoal(requester, [{ key: 'only' }]);
          await expect(
            reconcileAs(other, action, requester, { verdict: 'effect_absent' }),
          ).rejects.toThrow(/is not a request of goal run/);

          await reconcileAs(goalRunId, action, ownerId, { verdict: 'effect_absent' });
          expect(await unresolved(goalRunId)).toEqual([]);
          expect(await actionReconciliation(action)).toBe('effect_absent');
          expect((await goalOf(goalRunId)).status).toBe('cancelled');
        });

        const actionReconciliation = async (id: string) =>
          (await admin((client) => getActionRequest(client, workspaceId, id)))?.reconciliation;

        it('S5: an approval that outlasts the Worker (await_decision false) leaves the step waiting, not the run failing; once the action ran the step succeeds and the next one starts', async () => {
          const requester = await newPrincipal();
          const goalRunId = await startGoal(requester, [
            { key: 'a' },
            { key: 'b', dependsOn: ['a'] },
          ]);
          await advance(goalRunId, requester);
          const stepA = (await stepsOf(goalRunId)).a as StepRunRow;
          const action = await ask(await newGatekeeper(), stepA.id, requester, 'test.s5.now', {
            n: 1,
          });
          expect(action.status).toBe('pending_approval');
          // The Worker reports with the request pending, and exits.
          await completeStep(stepA.id, requester);
          await advance(goalRunId, requester);
          expect((await stepsOf(goalRunId)).a).toMatchObject({
            status: 'waiting',
            waitingReason: 'approval',
          });
          expect((await goalOf(goalRunId)).status).toBe('running');

          await approveAndRun(action.id);
          await advance(goalRunId, requester);
          const steps = await stepsOf(goalRunId);
          expect(steps.a?.status).toBe('succeeded');
          expect(steps.b?.status).toBe('running');
        });

        it('S5: await_decision true — the Task times out while its Worker waits; the step waits for the request; after it ran, the next attempt is given that request again instead of running it twice, and the next step starts', async () => {
          const requester = await newPrincipal();
          const goalRunId = await startGoal(requester, [
            { key: 'a', maxAttempts: 2 },
            { key: 'b', dependsOn: ['a'] },
          ]);
          await advance(goalRunId, requester);
          const stepA = (await stepsOf(goalRunId)).a as StepRunRow;
          const gatekeeperId = await newGatekeeper();
          const action = await ask(
            gatekeeperId,
            stepA.id,
            requester,
            'test.s5.wait',
            { n: 1 },
            true,
          );
          expect(action.status).toBe('pending_approval');
          await failStep(stepA.id, requester, 'timeout');
          await advance(goalRunId, requester);
          expect((await stepsOf(goalRunId)).a).toMatchObject({
            status: 'waiting',
            waitingReason: 'approval',
          });
          expect((await goalOf(goalRunId)).status).toBe('running');

          await approveAndRun(action.id);
          await advance(goalRunId, requester);
          // The timed-out attempt left no result: a new attempt, which asks again.
          expect((await stepsOf(goalRunId)).a).toMatchObject({
            status: 'running',
            attemptCount: 2,
          });
          await expect(
            ask(gatekeeperId, stepA.id, requester, 'test.s5.wait', { n: 1 }, true),
          ).resolves.toMatchObject({ id: action.id, status: 'executed' });
          expect(
            Number(
              (
                await admin((client) =>
                  client.query<{ n: string }>(
                    'select count(*) as n from action_requests where workspace_id = $1 and step_run_id = $2',
                    [workspaceId, stepA.id],
                  ),
                )
              ).rows[0]?.n,
            ),
          ).toBe(1);
          await completeStep(stepA.id, requester);
          await advance(goalRunId, requester);
          const steps = await stepsOf(goalRunId);
          expect(steps.a?.status).toBe('succeeded');
          expect(steps.b?.status).toBe('running');
        });

        it('S11: a rejected request, and an expired one, need a person — the step fails action_refused, the run pauses, the request is not retried on its own; asked again after a person’s retry it is a new request for a new decision', async () => {
          const requester = await newPrincipal();
          const refused = async (how: 'reject' | 'expire') => {
            const goalRunId = await startGoal(requester, [{ key: 'only', maxAttempts: 3 }]);
            await advance(goalRunId, requester);
            const step = (await stepsOf(goalRunId)).only as StepRunRow;
            const gatekeeperId = await newGatekeeper();
            const action = await ask(gatekeeperId, step.id, requester, `test.s11.${how}`);
            if (how === 'reject') {
              await admin((client) =>
                rejectActionRequest(client, workspaceId, {
                  actionRequestId: action.id,
                  approverPrincipalId: ownerId,
                  approverRole: 'owner',
                }),
              );
            } else {
              await admin((client) => expireActionRequest(client, workspaceId, action.id));
            }
            expect(await actionStatus(action.id)).toBe(how === 'reject' ? 'rejected' : 'expired');
            await completeStep(step.id, requester);
            await advance(goalRunId, requester);
            await advance(goalRunId, requester);
            expect((await stepsOf(goalRunId)).only).toMatchObject({
              status: 'failed',
              failureCategory: 'action_refused',
              attemptCount: 1,
            });
            expect(await goalOf(goalRunId)).toMatchObject({
              status: 'paused',
              pauseReason: 'needs_decision',
            });
            expect(await attemptTasks(step.id)).toHaveLength(1);
            return { goalRunId, step, gatekeeperId, action };
          };

          await refused('expire');
          const rejected = await refused('reject');
          await asRequester(requester, (client) =>
            resumeGoalRun(client, workspaceId, {
              goalRunId: rejected.goalRunId,
              actor: by(requester),
              retrySteps: ['only'],
            }),
          );
          await advance(rejected.goalRunId, requester);
          expect((await stepsOf(rejected.goalRunId)).only).toMatchObject({
            status: 'running',
            attemptCount: 2,
          });
          const asked = await ask(
            rejected.gatekeeperId,
            rejected.step.id,
            requester,
            'test.s11.reject',
          );
          expect(asked.id).not.toBe(rejected.action.id);
          expect(asked.status).toBe('pending_approval');
        });

        describe('the platform’s reconcile check a step declares (S11 GO3d, S4)', () => {
          const gateClient = new FakeObserveClient();
          let gate: string;
          const RESTART: Operation = {
            name: 'svc.restart',
            binding: { kind: 'http', method: 'POST', path: '/restart' },
            params_schema: {},
            mode: 'execute',
            blast_radius: 'medium',
            reversibility: false,
            auto_approvable: false,
            await_decision: false,
            reads: [],
            writes: [],
          };
          const STATUS: Operation = {
            ...RESTART,
            name: 'svc.status',
            binding: { kind: 'http', method: 'GET', path: '/status' },
            mode: 'observe',
            blast_radius: 'low',
            auto_approvable: true,
          };

          beforeAll(async () => {
            gate = await admin(async (client) => {
              const activity = await startActivity(client, workspaceId, {
                kind: 'test.connection',
                principalId: ownerId,
              });
              const registered = await registerGatekeeper(client, workspaceId, {
                name: `go3d-gate-${randomUUID().slice(0, 8)}`,
                transportKind: 'http',
                target: 'example-system',
                endpoint: 'http://127.0.0.1:9',
                connectionSecretSalt: 'e'.repeat(32),
                activityId: activity.id,
                registeredBy: { id: ownerId, kind: 'human' },
              });
              await importManifest(client, workspaceId, {
                gatekeeperId: registered.gatekeeperId,
                operations: [RESTART, STATUS],
                proposedBy: { id: ownerId, kind: 'human' },
                activityId: activity.id,
              });
              for (const operation of [RESTART, STATUS]) {
                await publishOperation(client, workspaceId, {
                  gatekeeperId: registered.gatekeeperId,
                  name: operation.name,
                });
              }
              return registered.gatekeeperId;
            });
          });

          // Functions: `gate` is set in `beforeAll`, after this block is collected.
          const declaration = (extra: Record<string, unknown> = {}) => ({
            action: { gatekeeperId: gate, operation: 'svc.restart', params: { name: 'web' } },
            check: {
              gatekeeperId: gate,
              operation: 'svc.status',
              params: { name: 'web' },
              expect: { path: 'state', op: 'eq', value: 'running' },
            },
            ...extra,
          });
          const checkDeps = (options: Parameters<typeof runReconcileCheck>[0]['options'] = {}) => ({
            pool,
            gatekeeperClient: gateClient,
            options,
          });

          /** A goal whose step `a` declares the check of `svc.restart {name: web}`; its Worker
           *  asks for `svc.restart` with `params`, the request is approved, starts and is lost
           *  (`outcome_unknown`), and the Worker reports its result. Then one advance — after
           *  `beforeAdvance`, when given. */
          async function lostAction(
            requester: string,
            params: Record<string, unknown> = { name: 'web' },
            extra: {
              readonly budget?: GoalRunBudget;
              readonly beforeAdvance?: (action: string) => Promise<unknown>;
            } = {},
          ) {
            const goalRunId = await startGoal(
              requester,
              [
                { key: 'a', reconcile: [declaration()] },
                { key: 'b', dependsOn: ['a'] },
              ],
              extra.budget,
            );
            await advance(goalRunId, requester);
            const stepA = (await stepsOf(goalRunId)).a as StepRunRow;
            const asked = await ask(gate, stepA.id, requester, 'svc.restart', params);
            await admin((client) =>
              approveActionRequest(client, workspaceId, {
                actionRequestId: asked.id,
                approverPrincipalId: ownerId,
                approverRole: 'owner',
              }),
            );
            await admin((client) => startActionRequestExecution(client, workspaceId, asked.id));
            await lose(asked.id);
            await completeStep(stepA.id, requester);
            await extra.beforeAdvance?.(asked.id);
            await advance(goalRunId, requester);
            return { goalRunId, stepA, action: asked.id };
          }
          /** Makes a pending check due now (its backoff skipped). */
          const dueNow = (action: string) =>
            raw(
              `update action_request_reconcile_checks set next_attempt_at = now()
                where workspace_id = $1 and action_request_id = $2`,
              [workspaceId, action],
            );
          const checkAudit = async (action: string) =>
            (
              await admin((client) =>
                client.query<{ payload: Record<string, unknown> }>(
                  `select payload from audit_records
                    where workspace_id = $1 and action = 'action_request.reconcile_check'
                      and resource_id = $2
                    order by created_at, id`,
                  [workspaceId, action],
                ),
              )
            ).rows.map((row) => row.payload);

          const dueOf = async (action: string): Promise<DueReconcileCheck | undefined> =>
            (await listDueReconcileChecks(pool, 1000)).find(
              (due) => due.actionRequestId === action,
            );
          async function mustBeDue(action: string): Promise<DueReconcileCheck> {
            const due = await dueOf(action);
            if (!due) throw new Error(`the check of ${action} is not due`);
            return due;
          }
          const checkOf = async (action: string) =>
            (await admin((client) => readReconcileChecks(client, workspaceId, [action]))).get(
              action,
            );
          const requestsOf = async (stepRunId: string) =>
            Number(
              (
                await admin((client) =>
                  client.query<{ n: string }>(
                    'select count(*) as n from action_requests where workspace_id = $1 and step_run_id = $2',
                    [workspaceId, stepRunId],
                  ),
                )
              ).rows[0]?.n,
            );
          const evidenceOf = async (action: string) =>
            (
              await admin((client) =>
                client.query<{ id: string; source_id: string; content: Record<string, unknown> }>(
                  `select id, source_id, content from observations
                    where workspace_id = $1 and content ->> 'purpose' = 'reconcile_check'
                      and content ->> 'actionRequestId' = $2
                    order by created_at, id`,
                  [workspaceId, action],
                ),
              )
            ).rows;
          const pauseDetail = async (goalRunId: string) =>
            (await goalAudit(goalRunId)).find((row) => row.action === 'goal_run.pause')?.payload
              .detail;

          it('S4: the platform observes, sees the effect and records effect_seen; the step succeeds without running the action again and the next step starts — the run never pauses', async () => {
            const requester = await newPrincipal();
            const { goalRunId, stepA, action } = await lostAction(requester);
            expect((await stepsOf(goalRunId)).a).toMatchObject({
              status: 'waiting',
              waitingReason: 'reconcile',
            });
            expect((await goalOf(goalRunId)).status).toBe('running');
            expect(await checkOf(action)).toMatchObject({
              status: 'pending',
              attempts: 0,
              observationCheck: declaration().check,
            });
            expect(await unresolved(goalRunId)).toEqual([
              expect.objectContaining({
                actionRequestId: action,
                needs: 'finding',
                platformCheck: {
                  status: 'pending',
                  attempts: 0,
                  lastError: null,
                  observationId: null,
                  nextAttemptAt: expect.any(Date),
                },
              }),
            ]);

            gateClient.answer = async () => ({ data: { name: 'web', state: 'running' } });
            const calls = gateClient.calls.length;
            expect(await runReconcileCheck(checkDeps(), await mustBeDue(action))).toBe('seen');
            expect(gateClient.calls.slice(calls)).toEqual([
              {
                target: expect.objectContaining({
                  credential: expect.objectContaining({ kind: 'connection' }),
                }),
                input: {
                  operation: 'svc.status',
                  params: { name: 'web' },
                  onBehalfOf: requester,
                  operationDigest: expect.any(String),
                },
              },
            ]);
            const found = await admin((client) => getActionRequest(client, workspaceId, action));
            expect(found?.reconciliation).toBe('effect_seen');
            const check = await checkOf(action);
            expect(check).toMatchObject({ status: 'seen', attempts: 1, leaseUntil: null });
            const [evidence] = await evidenceOf(action);
            expect(evidence?.id).toBe(check?.observationId);
            expect(evidence?.content).toMatchObject({
              actionRequestId: action,
              stepRunId: stepA.id,
              goalRunId,
              gatekeeperId: gate,
              operation: 'svc.status',
              expect: declaration().check.expect,
              outcome: 'satisfied',
              result: { name: 'web', state: 'running' },
              truncated: false,
            });
            const [decision] = await raw<{ decided_by: string | null; source_id: string }>(
              'select decided_by, source_id from decisions where workspace_id = $1 and id = $2',
              [workspaceId, found?.reconciliationDecisionId],
            );
            expect(decision).toEqual({ decided_by: null, source_id: evidence?.source_id });
            expect(await isDue(goalRunId)).toBe(true);

            await advance(goalRunId, requester);
            const steps = await stepsOf(goalRunId);
            expect(steps.a?.status).toBe('succeeded');
            expect(steps.b?.status).toBe('running');
            expect((await goalOf(goalRunId)).status).toBe('running');
            expect(await requestsOf(stepA.id)).toBe(1);
            expect((await goalAudit(goalRunId)).map((row) => row.action)).not.toContain(
              'goal_run.pause',
            );
            expect(await unresolved(goalRunId)).toEqual([]);
          });

          it('S4 reversed: observations that never show the effect are tried again with backoff, each one recorded, then leave the finding to a person — the run pauses awaiting_reconcile, nothing runs again, and the person’s finding moves it', async () => {
            const requester = await newPrincipal();
            const { goalRunId, stepA, action } = await lostAction(requester);
            gateClient.answer = async () => ({ data: { name: 'web', state: 'stopped' } });
            const options = { maxAttempts: 2, backoffMs: () => 60_000 };
            expect(await runReconcileCheck(checkDeps(options), await mustBeDue(action))).toBe(
              'retry',
            );
            const [first] = await evidenceOf(action);
            expect(await checkOf(action)).toMatchObject({
              status: 'pending',
              attempts: 1,
              leaseUntil: null,
              observationId: first?.id,
              lastError: 'predicate_unsatisfied',
            });
            // Retries hold nothing up and wake nothing: the run keeps running, the step waits.
            expect(await dueOf(action)).toBeUndefined();
            expect(await isDue(goalRunId)).toBe(false);
            expect((await goalOf(goalRunId)).status).toBe('running');
            expect(await unresolved(goalRunId)).toEqual([
              expect.objectContaining({
                platformCheck: {
                  status: 'pending',
                  attempts: 1,
                  lastError: 'predicate_unsatisfied',
                  observationId: first?.id,
                  nextAttemptAt: expect.any(Date),
                },
              }),
            ]);

            await dueNow(action);
            expect(await runReconcileCheck(checkDeps(options), await mustBeDue(action))).toBe(
              'not_seen',
            );
            expect(
              (await admin((client) => getActionRequest(client, workspaceId, action)))
                ?.reconciliation,
            ).toBeNull();
            const evidence = await evidenceOf(action);
            expect(evidence).toHaveLength(2);
            expect(await checkOf(action)).toMatchObject({
              status: 'not_seen',
              attempts: 2,
              observationId: evidence[1]?.id,
              lastError: null,
            });
            expect(evidence[1]?.content).toMatchObject({
              outcome: 'unsatisfied',
              result: { name: 'web', state: 'stopped' },
            });
            // Every attempt is audited, with the Observation it made.
            expect(await checkAudit(action)).toEqual([
              expect.objectContaining({
                outcome: 'retry',
                attempt: 1,
                code: 'predicate_unsatisfied',
                retryInMs: 60_000,
                observationId: evidence[0]?.id,
              }),
              expect.objectContaining({
                outcome: 'not_seen',
                attempt: 2,
                observationId: evidence[1]?.id,
              }),
            ]);
            expect(await isDue(goalRunId)).toBe(true);

            await advance(goalRunId, requester);
            expect(await goalOf(goalRunId)).toMatchObject({
              status: 'paused',
              pauseReason: 'awaiting_reconcile',
            });
            expect(await pauseDetail(goalRunId)).toBe(
              "step a: the platform's reconcile check of an action of attempt 1 did not see its effect",
            );
            expect((await stepsOf(goalRunId)).a).toMatchObject({
              status: 'waiting',
              waitingReason: 'reconcile',
            });
            expect(await unresolved(goalRunId)).toEqual([
              expect.objectContaining({
                actionRequestId: action,
                needs: 'finding',
                platformCheck: {
                  status: 'not_seen',
                  attempts: 2,
                  lastError: null,
                  observationId: evidence[1]?.id,
                  nextAttemptAt: null,
                },
              }),
            ]);
            expect(await requestsOf(stepA.id)).toBe(1);

            await reconcileAs(goalRunId, action, requester, { verdict: 'effect_seen' });
            await advance(goalRunId, requester);
            expect((await stepsOf(goalRunId)).a?.status).toBe('succeeded');
            await resumeAs(goalRunId, requester);
            await advance(goalRunId, requester);
            expect((await stepsOf(goalRunId)).b?.status).toBe('running');
            expect(await requestsOf(stepA.id)).toBe(1);
          });

          it('a check the gate refuses, or the requester may no longer make, is unavailable at once; one the gate does not answer is tried again with backoff, then unavailable — the run pauses for a person', async () => {
            const requester = await newPrincipal();
            const refused = await lostAction(requester);
            gateClient.answer = async () => {
              throw new GatekeeperClientError('refused by the gate', {
                code: 'operation_refused',
                status: 403,
              });
            };
            expect(await runReconcileCheck(checkDeps(), await mustBeDue(refused.action))).toBe(
              'unavailable',
            );
            expect(await checkOf(refused.action)).toMatchObject({
              status: 'unavailable',
              lastError: 'operation_refused',
            });
            expect(await evidenceOf(refused.action)).toEqual([]);
            await advance(refused.goalRunId, requester);
            expect(await goalOf(refused.goalRunId)).toMatchObject({
              status: 'paused',
              pauseReason: 'awaiting_reconcile',
            });
            expect(await pauseDetail(refused.goalRunId)).toBe(
              "step a: the platform's reconcile check of an action of attempt 1 could not be made",
            );

            // A requester whose role may not observe (R-35): refused before the gate is called.
            const demoted = await newPrincipal();
            const notAllowed = await lostAction(demoted);
            await raw(
              "update principals set role = 'auditor' where workspace_id = $1 and id = $2",
              [workspaceId, demoted],
            );
            const before = gateClient.calls.length;
            expect(await runReconcileCheck(checkDeps(), await mustBeDue(notAllowed.action))).toBe(
              'unavailable',
            );
            expect(gateClient.calls).toHaveLength(before);
            expect((await checkOf(notAllowed.action))?.lastError).toBe('requester_may_not_observe');

            const silent = await lostAction(await newPrincipal());
            gateClient.answer = async () => {
              throw new GatekeeperClientError('could not connect', {
                code: 'gate_unreachable',
                status: 0,
              });
            };
            const options = { maxAttempts: 2, backoffMs: () => 60_000 };
            expect(
              await runReconcileCheck(checkDeps(options), await mustBeDue(silent.action)),
            ).toBe('retry');
            expect(await checkOf(silent.action)).toMatchObject({
              status: 'pending',
              attempts: 1,
              leaseUntil: null,
              lastError: 'gate_unreachable',
            });
            expect(await dueOf(silent.action)).toBeUndefined();
            expect((await goalOf(silent.goalRunId)).status).toBe('running');
            await raw(
              `update action_request_reconcile_checks set next_attempt_at = now()
                where workspace_id = $1 and action_request_id = $2`,
              [workspaceId, silent.action],
            );
            expect(
              await runReconcileCheck(checkDeps(options), await mustBeDue(silent.action)),
            ).toBe('unavailable');
            expect(await checkOf(silent.action)).toMatchObject({
              status: 'unavailable',
              attempts: 2,
              lastError: 'gate_unreachable',
            });
          });

          it('an effect that shows late: not seen, then seen — the platform records effect_seen on the later Observation and the next step starts', async () => {
            const requester = await newPrincipal();
            const { goalRunId, action } = await lostAction(requester);
            const states = ['starting', 'running'];
            gateClient.answer = async () => ({ data: { name: 'web', state: states.shift() } });
            const options = { backoffMs: () => 60_000 };
            expect(await runReconcileCheck(checkDeps(options), await mustBeDue(action))).toBe(
              'retry',
            );
            await dueNow(action);
            expect(await runReconcileCheck(checkDeps(options), await mustBeDue(action))).toBe(
              'seen',
            );
            const evidence = await evidenceOf(action);
            expect(evidence.map((row) => row.content.outcome)).toEqual([
              'unsatisfied',
              'satisfied',
            ]);
            expect(await checkOf(action)).toMatchObject({
              status: 'seen',
              attempts: 2,
              observationId: evidence[1]?.id,
            });
            expect(
              (await admin((client) => getActionRequest(client, workspaceId, action)))
                ?.reconciliation,
            ).toBe('effect_seen');
            expect((await checkAudit(action)).map((row) => row.outcome)).toEqual(['retry', 'seen']);
            await advance(goalRunId, requester);
            expect((await goalOf(goalRunId)).status).toBe('running');
            expect((await stepsOf(goalRunId)).b?.status).toBe('running');
          });

          it('the caps: no attempt is scheduled past maxDurationMs from the first; at the last, a call with no answer settles on the latest Observation, or unavailable when there is none', async () => {
            const requester = await newPrincipal();
            // A retry that would start past the duration cap: the first attempt is the last.
            const short = await lostAction(requester);
            gateClient.answer = async () => ({ data: { state: 'stopped' } });
            expect(
              await runReconcileCheck(
                checkDeps({ maxDurationMs: 30_000, backoffMs: () => 60_000 }),
                await mustBeDue(short.action),
              ),
            ).toBe('not_seen');
            expect(await checkOf(short.action)).toMatchObject({ status: 'not_seen', attempts: 1 });
            expect((await checkOf(short.action))?.firstAttemptAt).toBeInstanceOf(Date);

            // Observed without the effect, then no answer at the last attempt: not_seen on the
            // earlier Observation, the last attempt's code kept.
            const mixed = await lostAction(requester);
            const options = { maxAttempts: 2, backoffMs: () => 60_000 };
            gateClient.answer = async () => ({ data: { state: 'stopped' } });
            expect(await runReconcileCheck(checkDeps(options), await mustBeDue(mixed.action))).toBe(
              'retry',
            );
            const [observed] = await evidenceOf(mixed.action);
            gateClient.answer = async () => {
              throw new GatekeeperClientError('gate overloaded', {
                code: 'internal_error',
                status: 503,
              });
            };
            await dueNow(mixed.action);
            expect(await runReconcileCheck(checkDeps(options), await mustBeDue(mixed.action))).toBe(
              'not_seen',
            );
            expect(await checkOf(mixed.action)).toMatchObject({
              status: 'not_seen',
              attempts: 2,
              observationId: observed?.id,
              lastError: 'internal_error',
            });
            expect(await evidenceOf(mixed.action)).toHaveLength(1);
          });

          it('nothing a retry could change is retried: deterministic gate failures, and a predicate the lint or the credential review now refuses, settle unavailable at the first attempt', async () => {
            const requester = await newPrincipal();
            const deterministic: Array<[string, number]> = [
              ['response_too_large', 200],
              ['invalid_response', 200],
              ['redirect_refused', 302],
              ['target_refused', 0],
              ['connection_secret_missing', 401],
              ['unauthorized', 401],
              ['invalid_params', 400],
              ['credential_unavailable', 424],
            ];
            for (const [code, status] of deterministic) {
              const { action } = await lostAction(requester);
              gateClient.answer = async () => {
                throw new GatekeeperClientError(`the gate said ${code}`, { code, status });
              };
              expect(await runReconcileCheck(checkDeps(), await mustBeDue(action)), code).toBe(
                'unavailable',
              );
              expect(await checkOf(action), code).toMatchObject({
                status: 'unavailable',
                attempts: 1,
                lastError: code,
              });
            }

            // A stored check whose predicate the reviews refuse (they may learn more after a plan
            // was confirmed): refused before the gate is called.
            const jwt =
              'eyJhbGciOiJFZERTQSJ9.eyJ3cyI6IndzMSIsIm9ibyI6InAxIn0.c2lnbmF0dXJlLWJ5dGVzLWhlcmU';
            const stored: Array<[unknown, string]> = [
              [{ path: 'length(keys(@))', op: 'gt', value: 1 }, 'predicate_refused'],
              [{ path: 'token', op: 'eq', value: jwt }, 'credentials_in_predicate'],
            ];
            for (const [expect_, code] of stored) {
              const { action } = await lostAction(
                requester,
                { name: 'web' },
                {
                  beforeAdvance: (id) =>
                    admin((client) =>
                      ensureReconcileCheck(client, workspaceId, {
                        actionRequestId: id,
                        observationCheck: { ...declaration().check, expect: expect_ } as never,
                      }),
                    ),
                },
              );
              const before = gateClient.calls.length;
              expect(await runReconcileCheck(checkDeps(), await mustBeDue(action))).toBe(
                'unavailable',
              );
              expect(gateClient.calls).toHaveLength(before);
              expect((await checkOf(action))?.lastError).toBe(code);
            }
          });

          it('a pause or an owner’s hold that lands while an attempt is under way: the attempt still records effect_seen and the step settles, but the run keeps the person’s pause or hold and nothing starts until it is resumed', async () => {
            const requester = await newPrincipal();
            for (const pauser of ['requester', 'owner'] as const) {
              const { goalRunId, stepA, action } = await lostAction(requester);
              gateClient.answer = async () => {
                if (pauser === 'requester') await pauseAs(goalRunId, requester);
                else {
                  await asOwner((client) =>
                    pauseGoalRun(client, workspaceId, { goalRunId, actor: byOwner() }),
                  );
                }
                return { data: { state: 'running' } };
              };
              expect(await runReconcileCheck(checkDeps(), await mustBeDue(action)), pauser).toBe(
                'seen',
              );
              expect(
                (await admin((client) => getActionRequest(client, workspaceId, action)))
                  ?.reconciliation,
              ).toBe('effect_seen');
              await advance(goalRunId, requester);
              expect(await goalOf(goalRunId), pauser).toMatchObject({
                status: 'paused',
                pauseReason: 'requested',
                pausedBy: pauser === 'owner' ? ownerId : requester,
              });
              const steps = await stepsOf(goalRunId);
              expect(steps.a?.status, pauser).toBe('succeeded');
              expect(steps.b?.status, pauser).toBe('ready');
              expect(await requestsOf(stepA.id)).toBe(1);

              if (pauser === 'owner') {
                await expect(resumeAs(goalRunId, requester)).rejects.toThrow(
                  /a workspace owner holds it/,
                );
                await asRequester(ownerId, (client) =>
                  releaseGoalRunHold(client, workspaceId, { goalRunId, actor: byOwner() }),
                );
              }
              await resumeAs(goalRunId, requester);
              await advance(goalRunId, requester);
              expect((await stepsOf(goalRunId)).b?.status, pauser).toBe('running');
            }

            // Paused before the attempt: the check waits for the resume, and is due again after.
            const waiting = await lostAction(requester);
            await pauseAs(waiting.goalRunId, requester);
            expect(await dueOf(waiting.action)).toBeUndefined();
            await resumeAs(waiting.goalRunId, requester);
            expect(await dueOf(waiting.action)).toBeDefined();
          });

          it('the goal’s wall-clock budget comes first: past the deadline the run pauses budget_exhausted while its check is pending, and the check waits — neither settled nor tried — until the run is resumed', async () => {
            const requester = await newPrincipal();
            const { goalRunId, action } = await lostAction(
              requester,
              { name: 'web' },
              { budget: { ...BUDGET, maxWallClockSeconds: 600 } },
            );
            // While the check is pending the run is looked at again at its deadline at the latest.
            const goal = await goalOf(goalRunId);
            expect(goal.nextTickAt?.getTime()).toBe(
              (goal.confirmedAt as Date).getTime() + 600 * 1000,
            );
            gateClient.answer = async () => ({ data: { state: 'stopped' } });
            expect(
              await runReconcileCheck(
                checkDeps({ backoffMs: () => 60_000 }),
                await mustBeDue(action),
              ),
            ).toBe('retry');

            await raw(
              `update goal_runs set confirmed_at = now() - interval '1 hour'
                where workspace_id = $1 and id = $2`,
              [workspaceId, goalRunId],
            );
            await advance(goalRunId, requester);
            expect(await goalOf(goalRunId)).toMatchObject({
              status: 'paused',
              pauseReason: 'budget_exhausted',
            });
            await dueNow(action);
            expect(await dueOf(action)).toBeUndefined();
            expect(await checkOf(action)).toMatchObject({ status: 'pending', attempts: 1 });
            expect((await stepsOf(goalRunId)).a).toMatchObject({
              status: 'waiting',
              waitingReason: 'reconcile',
            });
            expect(
              (await admin((client) => getActionRequest(client, workspaceId, action)))
                ?.reconciliation,
            ).toBeNull();
          });

          it('a cancel stops the retries: the cancelled step’s check settles unavailable without a call, keeping its latest Observation, and the action is left to a person as any unknown outcome under an ended goal', async () => {
            const requester = await newPrincipal();
            const { goalRunId, action } = await lostAction(requester);
            gateClient.answer = async () => ({ data: { state: 'stopped' } });
            expect(
              await runReconcileCheck(
                checkDeps({ backoffMs: () => 60_000 }),
                await mustBeDue(action),
              ),
            ).toBe('retry');
            const [observed] = await evidenceOf(action);

            await asRequester(requester, (client) =>
              cancelGoalRun(client, workspaceId, { goalRunId, actor: by(requester) }),
            );
            // Due at once, whatever its backoff said: the step was cancelled with the run.
            const closed = await dueOf(action);
            expect(closed?.closedBy).not.toBeNull();
            const before = gateClient.calls.length;
            expect(await runReconcileCheck(checkDeps(), closed as DueReconcileCheck)).toBe(
              'unavailable',
            );
            expect(gateClient.calls).toHaveLength(before);
            expect(await checkOf(action)).toMatchObject({
              status: 'unavailable',
              attempts: 2,
              observationId: observed?.id,
            });
            await advance(goalRunId, requester);
            expect((await goalOf(goalRunId)).status).toBe('cancelled');
            expect(await unresolved(goalRunId)).toEqual([
              expect.objectContaining({ actionRequestId: action, needs: 'finding' }),
            ]);
            await reconcileAs(goalRunId, action, requester, { verdict: 'effect_seen' });
            expect(
              (await admin((client) => getActionRequest(client, workspaceId, action)))
                ?.reconciliation,
            ).toBe('effect_seen');
          });

          it('a person’s finding preempts the check; an attempt whose claim was lost writes nothing', async () => {
            const requester = await newPrincipal();
            const preempted = await lostAction(requester);
            const due = await mustBeDue(preempted.action);
            await reconcileAs(preempted.goalRunId, preempted.action, requester, {
              verdict: 'effect_absent',
            });
            expect((await checkOf(preempted.action))?.status).toBe('preempted');
            expect(await dueOf(preempted.action)).toBeUndefined();
            const before = gateClient.calls.length;
            expect(await runReconcileCheck(checkDeps(), due)).toBe('skipped');
            expect(gateClient.calls).toHaveLength(before);

            // The lease runs out mid-call and another kernel claims the check: this attempt is
            // fenced off at its settle, and the other attempt owns the check.
            const raced = await lostAction(requester);
            gateClient.answer = async () => {
              await raw(
                `update action_request_reconcile_checks set lease_until = now() - interval '1 second'
                  where workspace_id = $1 and action_request_id = $2`,
                [workspaceId, raced.action],
              );
              await admin((client) =>
                claimReconcileCheck(client, workspaceId, raced.action, 60_000),
              );
              return { data: { state: 'running' } };
            };
            expect(await runReconcileCheck(checkDeps(), await mustBeDue(raced.action))).toBe(
              'skipped',
            );
            expect(await checkOf(raced.action)).toMatchObject({ status: 'pending', attempts: 2 });
            expect(await evidenceOf(raced.action)).toEqual([]);
            expect(
              (await admin((client) => getActionRequest(client, workspaceId, raced.action)))
                ?.reconciliation,
            ).toBeNull();
          });

          it('matches an action by its exact identity; checks run only while the run runs, and settle unavailable once the run or the step ended', async () => {
            // The Worker added a param: not the declared action — a person reconciles it.
            const requester = await newPrincipal();
            const other = await lostAction(requester, { name: 'web', force: true });
            expect(await checkOf(other.action)).toBeUndefined();
            expect(await goalOf(other.goalRunId)).toMatchObject({
              status: 'paused',
              pauseReason: 'awaiting_reconcile',
            });
            expect(await pauseDetail(other.goalRunId)).toBe(
              'step a: an action of attempt 1 may have run (outcome unknown)',
            );

            const paused = await lostAction(requester);
            await pauseAs(paused.goalRunId, requester);
            expect(await dueOf(paused.action)).toBeUndefined();
            await asRequester(requester, (client) =>
              cancelGoalRun(client, workspaceId, {
                goalRunId: paused.goalRunId,
                actor: by(requester),
              }),
            );
            await advance(paused.goalRunId, requester);
            expect((await goalOf(paused.goalRunId)).status).toBe('cancelled');
            const ended = await mustBeDue(paused.action);
            expect(ended.closedBy).toBe('goal_ended');
            const before = gateClient.calls.length;
            expect(await runReconcileCheck(checkDeps(), ended)).toBe('unavailable');
            expect(gateClient.calls).toHaveLength(before);
            expect(await checkOf(paused.action)).toMatchObject({
              status: 'unavailable',
              lastError: 'goal_ended',
            });

            // A step revised away: its check can no longer matter (the run pauses for a person
            // over its unknown action).
            const revised = await lostAction(requester);
            await pauseAs(revised.goalRunId, requester);
            await asRequester(requester, (client) =>
              reviseGoalRun(client, workspaceId, {
                goalRunId: revised.goalRunId,
                actor: by(requester),
                basedOnRevision: 1,
                plan: planOf([{ key: 'b' }]),
              }),
            );
            expect((await stepsOf(revised.goalRunId)).a).toBeUndefined();
            const closed = await mustBeDue(revised.action);
            expect(closed.closedBy).toBe('step_ended');
            expect(await runReconcileCheck(checkDeps(), closed)).toBe('unavailable');
            expect(gateClient.calls).toHaveLength(before);
            expect((await checkOf(revised.action))?.lastError).toBe('step_ended');
          });

          it('the tick runs every due check', async () => {
            const requester = await newPrincipal();
            const first = await lostAction(requester);
            const second = await lostAction(requester);
            gateClient.answer = async () => ({ data: { state: 'running' } });
            const errors: unknown[] = [];
            expect(
              await runReconcileCheckTick(checkDeps(), {
                limit: 1000,
                onError: (err) => errors.push(err),
              }),
            ).toBeGreaterThanOrEqual(2);
            expect(errors).toEqual([]);
            expect((await checkOf(first.action))?.status).toBe('seen');
            expect((await checkOf(second.action))?.status).toBe('seen');
          });

          it('a plan’s declaration names a published execute-class action and an observe-class check, with params that carry no credential', async () => {
            const requester = await newPrincipal();
            const jwtLike = [
              'eyJhbGciOiJIUzI1NiJ9',
              'eyJzdWIiOiJnbzNkIn0',
              'c2lnbmF0dXJlLWdvM2Q',
            ].join('.');
            const unknownGate = randomUUID();
            const propose = (reconcile: readonly unknown[]) =>
              asRequester(requester, (client) =>
                createGoalRun(client, workspaceId, {
                  requesterId: requester,
                  proposedBy: requester,
                  statement: 'reach the goal',
                  plan: planOf([{ key: 'a', reconcile }]),
                  budget: BUDGET,
                }),
              );
            const problems = async (reconcile: readonly unknown[]) => {
              try {
                await propose(reconcile);
              } catch (err) {
                expect(err).toBeInstanceOf(GoalPlanValidationError);
                return (err as GoalPlanValidationError).problems;
              }
              throw new Error('expected the plan to be refused');
            };
            const base = declaration();
            expect(
              await problems([
                { ...base, action: { ...base.action, operation: 'svc.status' } },
                { ...base, check: { ...base.check, operation: 'svc.restart' } },
                {
                  ...base,
                  action: { gatekeeperId: unknownGate, operation: 'svc.restart' },
                  check: { ...base.check, params: { token: jwtLike } },
                },
              ]),
            ).toEqual([
              'step "a": reconcile[0]: action: "svc.status" is observe-class',
              'step "a": reconcile[1]: check: "svc.restart" cannot be observed (not_observe_class)',
              `step "a": reconcile[2]: action: Gatekeeper ${unknownGate} is not enabled in this workspace`,
              expect.stringMatching(
                /^step "a": reconcile\[2\]: check: .*svc\.status: the params carry 1 credential value/,
              ),
            ]);
            expect(await propose([base])).toMatchObject({ goalRunId: expect.any(String) });
          });
        });
      });
    });

    // -------------------------------------------------------------------------------------------

    describe('verifying a run: its acceptance checks and the requester’s outcome (S11 GO4a, S6, I-G5)', () => {
      const observeClient = new FakeObserveClient();
      let gate: string;
      const STATUS: Operation = {
        name: 'svc.status',
        binding: { kind: 'http', method: 'GET', path: '/status' },
        params_schema: {},
        mode: 'observe',
        blast_radius: 'low',
        reversibility: false,
        auto_approvable: true,
        await_decision: false,
        reads: [],
        writes: [],
      };

      beforeAll(async () => {
        gate = await admin(async (client) => {
          const activity = await startActivity(client, workspaceId, {
            kind: 'test.connection',
            principalId: ownerId,
          });
          const registered = await registerGatekeeper(client, workspaceId, {
            name: `go4a-gate-${randomUUID().slice(0, 8)}`,
            transportKind: 'http',
            target: 'example-system',
            endpoint: 'http://127.0.0.1:9',
            connectionSecretSalt: 'f'.repeat(32),
            activityId: activity.id,
            registeredBy: { id: ownerId, kind: 'human' },
          });
          await importManifest(client, workspaceId, {
            gatekeeperId: registered.gatekeeperId,
            operations: [STATUS],
            proposedBy: { id: ownerId, kind: 'human' },
            activityId: activity.id,
          });
          await publishOperation(client, workspaceId, {
            gatekeeperId: registered.gatekeeperId,
            name: STATUS.name,
          });
          return registered.gatekeeperId;
        });
      });

      const by = (principalId: string, role: 'member' | 'owner' = 'member') => ({
        principalId,
        role,
      });
      // Functions: `gate` is set in `beforeAll`, after this block is collected.
      const observe = (key = 'up', field = 'state', value: unknown = 'running') => ({
        kind: 'observe_predicate' as const,
        key,
        check: {
          gatekeeperId: gate,
          operation: 'svc.status',
          params: { name: 'web' },
          expect: { path: field, op: 'eq', value },
        },
      });
      const CONFIRM = {
        kind: 'requester_confirm' as const,
        key: 'report',
        prompt: 'Is the weekly report in the shared folder?',
      };
      const STATEMENT = 'publish the weekly report';

      async function proposeWith(
        requester: string,
        acceptance: readonly unknown[] | undefined,
        steps: readonly StepSpec[] = [{ key: 'a' }],
      ) {
        const created = await asRequester(requester, (client) =>
          createGoalRun(client, workspaceId, {
            requesterId: requester,
            proposedBy: requester,
            statement: STATEMENT,
            plan: { ...planOf(steps), ...(acceptance ? { acceptance } : {}) },
            budget: BUDGET,
          }),
        );
        await asRequester(requester, (client) =>
          confirmGoalRun(client, workspaceId, {
            goalRunId: created.goalRunId,
            confirmedBy: requester,
          }),
        );
        return created;
      }

      /** A confirmed run of one step `a` with `acceptance` (none: the plan has no checks), run
       *  until every step is done — the advance that moves it to `verifying` is `entered`. */
      async function verifyingGoal(requester: string, acceptance?: readonly unknown[]) {
        const created = await proposeWith(requester, acceptance);
        await advance(created.goalRunId, requester);
        await completeStep((await stepsOf(created.goalRunId)).a?.id as string, requester);
        const entered = await advance(created.goalRunId, requester);
        return { goalRunId: created.goalRunId, created, entered };
      }

      const acceptanceOf = async (goalRunId: string) =>
        (await admin((client) => readGoalAcceptance(client, workspaceId, goalRunId))) ?? undefined;
      const rowsOf = (goalRunId: string) =>
        admin((client) => listAcceptanceChecks(client, workspaceId, goalRunId));
      const dueOf = async (goalRunId: string): Promise<readonly DueAcceptanceCheck[]> =>
        (await listDueAcceptanceChecks(pool, 1000)).filter((due) => due.goalRunId === goalRunId);
      const checkDeps = (options: Parameters<typeof runAcceptanceCheck>[0]['options'] = {}) => ({
        pool,
        gatekeeperClient: observeClient,
        options,
      });
      /** Runs the attempt of `key` now (its backoff skipped). */
      async function observeNow(
        goalRunId: string,
        key = 'up',
        options: Parameters<typeof runAcceptanceCheck>[0]['options'] = {},
      ) {
        await raw(
          `update goal_acceptance_checks set next_attempt_at = now()
            where workspace_id = $1 and goal_run_id = $2 and check_key = $3 and status = 'pending'`,
          [workspaceId, goalRunId, key],
        );
        const due = (await dueOf(goalRunId)).find((candidate) => candidate.checkKey === key);
        if (!due) throw new Error(`the check ${key} of ${goalRunId} is not due`);
        return runAcceptanceCheck(checkDeps(options), due);
      }
      const evidenceOf = async (goalRunId: string, key = 'up') =>
        (
          await admin((client) =>
            client.query<{ id: string; content: Record<string, unknown> }>(
              `select id, content from observations
                where workspace_id = $1 and content ->> 'purpose' = 'acceptance_check'
                  and content ->> 'goalRunId' = $2 and content ->> 'checkKey' = $3
                order by created_at, id`,
              [workspaceId, goalRunId, key],
            ),
          )
        ).rows;
      const decisionOf = async (id: string | null) =>
        (
          await raw<{ decided_by: string; status: string; rationale: Record<string, unknown> }>(
            'select decided_by, status, rationale from decisions where workspace_id = $1 and id = $2',
            [workspaceId, id],
          )
        )[0];
      const confirmAs = (goalRunId: string, principal: string, note?: string) =>
        asRequester(principal, (client) =>
          confirmGoalAcceptance(client, workspaceId, {
            goalRunId,
            actor: by(principal),
            ...(note ? { note } : {}),
          }),
        );
      const endAs = (
        goalRunId: string,
        principal: string,
        outcome: 'achieved' | 'not_achieved',
        note?: string,
        role: 'member' | 'owner' = 'member',
      ) =>
        asRequester(principal, (client) =>
          endGoalRun(client, workspaceId, {
            goalRunId,
            actor: by(principal, role),
            outcome,
            ...(note ? { note } : {}),
          }),
        );
      const pauseDetail = async (goalRunId: string) =>
        (await goalAudit(goalRunId)).filter((row) => row.action === 'goal_run.pause').at(-1)
          ?.payload.detail;
      const RUNNING = async () => ({ data: { name: 'web', state: 'running' } });

      it('achieved by check: the platform observes every check, they pass, and the run completes with nobody asked', async () => {
        const requester = await newPrincipal();
        const { goalRunId, created, entered } = await verifyingGoal(requester, [observe()]);
        expect(created.hints).toEqual([]);
        expect(entered).toMatchObject({ status: 'verifying', nextTickAt: null });
        expect(await acceptanceOf(goalRunId)).toMatchObject({
          status: 'verifying',
          rounds: [
            {
              round: 1,
              planRevision: 1,
              checks: [
                {
                  checkKey: 'up',
                  kind: 'observe_predicate',
                  status: 'pending',
                  check: observe().check,
                  attempts: 0,
                  nextAttemptAt: expect.any(Date),
                  overridden: false,
                },
              ],
            },
          ],
          outcome: null,
        });
        expect(
          (await goalAudit(goalRunId)).find((row) => row.action === 'goal_run.acceptance_round')
            ?.payload,
        ).toMatchObject({ round: 1, checks: [{ key: 'up', kind: 'observe_predicate' }] });
        // Verifying keeps no wall clock: another advance changes nothing.
        expect(await advance(goalRunId, requester)).toMatchObject({
          status: 'verifying',
          nextTickAt: null,
        });

        observeClient.answer = RUNNING;
        const calls = observeClient.calls.length;
        expect(await observeNow(goalRunId)).toBe('passed');
        expect(observeClient.calls.slice(calls)).toEqual([
          {
            target: expect.objectContaining({
              credential: expect.objectContaining({ kind: 'connection' }),
            }),
            input: {
              operation: 'svc.status',
              params: { name: 'web' },
              onBehalfOf: requester,
              operationDigest: expect.any(String),
            },
          },
        ]);
        const [evidence] = await evidenceOf(goalRunId);
        expect(evidence?.content).toMatchObject({
          purpose: 'acceptance_check',
          goalRunId,
          round: 1,
          checkKey: 'up',
          outcome: 'satisfied',
          result: { name: 'web', state: 'running' },
        });
        expect((await rowsOf(goalRunId))[0]).toMatchObject({
          status: 'passed',
          attempts: 1,
          observationId: evidence?.id,
          leaseUntil: null,
        });
        expect(await isDue(goalRunId)).toBe(true);

        expect(await advance(goalRunId, requester)).toMatchObject({ status: 'completed' });
        expect(await goalOf(goalRunId)).toMatchObject({
          status: 'completed',
          outcome: 'achieved',
          outcomeBasis: 'verified_by_check',
          outcomeDecisionId: null,
        });
        expect((await acceptanceOf(goalRunId))?.outcome).toEqual({
          outcome: 'achieved',
          basis: 'verified_by_check',
          decisionId: null,
          overriddenChecks: [],
        });
        expect(
          (await goalAudit(goalRunId)).find((row) => row.action === 'goal_run.complete')?.payload,
        ).toMatchObject({
          by: 'advancer',
          outcome: 'achieved',
          outcomeBasis: 'verified_by_check',
          round: 1,
          checks: ['up'],
        });
      });

      it('a plan with no check the platform makes says so; its round asks the requester alone, and only their confirmation achieves the goal — on their word', async () => {
        const requester = await newPrincipal();
        const someoneElse = await newPrincipal();
        const { goalRunId, created } = await verifyingGoal(requester);
        expect(created.hints).toEqual([
          { code: 'requester_confirm_only', message: expect.any(String) },
        ]);
        const revision = await admin((client) =>
          getPlanRevision(client, workspaceId, goalRunId, 1),
        );
        expect(revision?.validation).toMatchObject({
          hints: [{ code: 'requester_confirm_only' }],
        });
        expect((await acceptanceOf(goalRunId))?.rounds).toMatchObject([
          {
            round: 1,
            checks: [
              {
                checkKey: 'requester_confirm',
                kind: 'requester_confirm',
                status: 'pending',
                prompt: STATEMENT,
                nextAttemptAt: null,
              },
            ],
          },
        ]);
        expect(await dueOf(goalRunId)).toEqual([]);
        expect(await advance(goalRunId, requester)).toMatchObject({ status: 'verifying' });

        for (const [principal, role] of [
          [someoneElse, 'member'],
          [ownerId, 'owner'],
        ] as const) {
          await expect(
            asRequester(principal, (client) =>
              confirmGoalAcceptance(client, workspaceId, { goalRunId, actor: by(principal, role) }),
            ),
          ).rejects.toThrow(/only the requester gives a goal run its outcome/);
        }
        await expect(endAs(goalRunId, requester, 'achieved')).rejects.toThrow(
          /is verifying; confirm its acceptance check/,
        );
        const confirmed = await confirmAs(goalRunId, requester, 'checked the folder myself');
        expect(confirmed).toMatchObject({ status: 'verifying', changed: true });
        expect(await confirmAs(goalRunId, requester)).toEqual({
          status: 'verifying',
          changed: false,
          decisionId: confirmed.decisionId,
        });
        expect(await isDue(goalRunId)).toBe(true);
        expect(await decisionOf(confirmed.decisionId)).toEqual({
          decided_by: requester,
          status: 'approved',
          rationale: {
            decision: 'goal_outcome',
            goalRunId,
            outcome: 'achieved',
            round: 1,
            checkKey: 'requester_confirm',
            note: 'checked the folder myself',
          },
        });

        await advance(goalRunId, requester);
        expect(await goalOf(goalRunId)).toMatchObject({
          status: 'completed',
          outcome: 'achieved',
          outcomeBasis: 'requester',
          outcomeDecisionId: confirmed.decisionId,
        });
        expect((await acceptanceOf(goalRunId))?.outcome).toEqual({
          outcome: 'achieved',
          basis: 'requester',
          decisionId: confirmed.decisionId,
          overriddenChecks: [],
        });
      });

      it('I-G5: what the step’s Worker or the entry agent reports gives the goal no outcome — the Task’s agent_reported achieved neither passes a check nor completes the run', async () => {
        const requester = await newPrincipal();
        for (const acceptance of [[observe()], undefined]) {
          const { goalRunId } = await verifyingGoal(requester, acceptance);
          const task = await latestAttempt((await stepsOf(goalRunId)).a?.id as string);
          expect(
            await asRequester(requester, (client) =>
              reportTaskOutcome(client, workspaceId, requester, task.id, 'achieved'),
            ),
          ).toMatchObject({ outcome: 'achieved', basis: 'agent_reported' });
          expect(await advance(goalRunId, requester)).toMatchObject({ status: 'verifying' });
          expect(await goalOf(goalRunId)).toMatchObject({ outcome: null, outcomeBasis: null });
          expect((await rowsOf(goalRunId)).map((row) => row.status)).toEqual(['pending']);
        }
      });

      it('observations first, then the requester: the confirmation waits for every observation to pass, and the run is achieved by check', async () => {
        const requester = await newPrincipal();
        const { goalRunId } = await verifyingGoal(requester, [observe(), CONFIRM]);
        await expect(confirmAs(goalRunId, requester)).rejects.toThrow(
          /the platform's checks have not all passed yet \(up: pending\); the requester confirms after them/,
        );
        observeClient.answer = RUNNING;
        expect(await observeNow(goalRunId)).toBe('passed');
        expect(await advance(goalRunId, requester)).toMatchObject({ status: 'verifying' });
        expect(
          (await goalAudit(goalRunId))
            .map((row) => row.action)
            .filter((a) => a === 'goal_run.pause'),
        ).toEqual([]);

        const confirmed = await confirmAs(goalRunId, requester);
        expect(confirmed.changed).toBe(true);
        await advance(goalRunId, requester);
        expect(await goalOf(goalRunId)).toMatchObject({
          status: 'completed',
          outcome: 'achieved',
          outcomeBasis: 'verified_by_check',
          outcomeDecisionId: null,
        });
        expect((await acceptanceOf(goalRunId))?.rounds[0]?.checks).toMatchObject([
          { checkKey: 'report', status: 'passed', decisionId: confirmed.decisionId },
          { checkKey: 'up', status: 'passed' },
        ]);
      });

      it('S6: an observation that never satisfies its predicate is tried again with backoff, each one recorded; at the last the run pauses needs_decision with the evidence, never achieved — and the requester ends it as not achieved', async () => {
        const requester = await newPrincipal();
        const { goalRunId } = await verifyingGoal(requester, [observe(), CONFIRM]);
        observeClient.answer = async () => ({ data: { name: 'web', state: 'exited' } });
        const options = { maxAttempts: 2, backoffMs: () => 60_000 };
        expect(await observeNow(goalRunId, 'up', options)).toBe('retry');
        const [first] = await evidenceOf(goalRunId);
        expect((await rowsOf(goalRunId)).find((row) => row.checkKey === 'up')).toMatchObject({
          status: 'pending',
          attempts: 1,
          leaseUntil: null,
          lastError: 'predicate_unsatisfied',
          observationId: first?.id,
        });
        expect(await dueOf(goalRunId)).toEqual([]);
        expect(await advance(goalRunId, requester)).toMatchObject({ status: 'verifying' });

        expect(await observeNow(goalRunId, 'up', options)).toBe('failed');
        const evidence = await evidenceOf(goalRunId);
        expect(evidence).toHaveLength(2);
        expect(evidence.map((row) => row.content.outcome)).toEqual(['unsatisfied', 'unsatisfied']);
        expect((await rowsOf(goalRunId)).find((row) => row.checkKey === 'up')).toMatchObject({
          status: 'failed',
          attempts: 2,
          observationId: evidence[1]?.id,
          lastError: 'predicate_unsatisfied',
        });
        await expect(confirmAs(goalRunId, requester)).rejects.toThrow(
          /have not all passed yet \(up: failed\)/,
        );

        await advance(goalRunId, requester);
        expect(await goalOf(goalRunId)).toMatchObject({
          status: 'paused',
          pauseReason: 'needs_decision',
          outcome: null,
        });
        expect(await pauseDetail(goalRunId)).toBe(
          'round 1: acceptance check up: its observation did not satisfy the predicate; end the goal as not achieved (or as achieved, on your word), revise the plan, resume to verify again, or cancel',
        );
        // The confirmation the round still asked is superseded with it.
        expect((await acceptanceOf(goalRunId))?.rounds[0]?.checks).toMatchObject([
          { checkKey: 'report', status: 'superseded' },
          { checkKey: 'up', status: 'failed', observationId: evidence[1]?.id },
        ]);

        const ended = await endAs(
          goalRunId,
          requester,
          'not_achieved',
          'the service never came back',
        );
        expect(ended).toMatchObject({
          status: 'completed',
          changed: true,
          overriddenChecks: [],
          skippedStepRunIds: [],
        });
        expect(await endAs(goalRunId, requester, 'not_achieved')).toMatchObject({
          changed: false,
          decisionId: ended.decisionId,
        });
        expect(await decisionOf(ended.decisionId)).toMatchObject({
          decided_by: requester,
          rationale: {
            decision: 'goal_outcome',
            goalRunId,
            outcome: 'not_achieved',
            from: 'paused',
            pauseReason: 'needs_decision',
            note: 'the service never came back',
          },
        });
        expect((await acceptanceOf(goalRunId))?.outcome).toEqual({
          outcome: 'not_achieved',
          basis: 'requester',
          decisionId: ended.decisionId,
          overriddenChecks: [],
        });
      });

      it('the requester may declare it achieved over checks that did not pass — never silently: the decision, the audit and the read model name each overridden check with its evidence', async () => {
        const requester = await newPrincipal();
        const { goalRunId } = await verifyingGoal(requester, [
          observe('up'),
          observe('disk', 'free', 'plenty'),
          observe('health', 'health', 'ok'),
        ]);
        observeClient.answer = async () => ({
          data: { name: 'web', state: 'running', free: 'low' },
        });
        const once = { maxAttempts: 1 };
        expect(await observeNow(goalRunId, 'up', once)).toBe('passed');
        expect(await observeNow(goalRunId, 'disk', once)).toBe('failed');
        observeClient.answer = async () => {
          throw new GatekeeperClientError('could not connect', {
            code: 'gate_unreachable',
            status: 0,
          });
        };
        expect(await observeNow(goalRunId, 'health', once)).toBe('unavailable');
        await advance(goalRunId, requester);
        expect(await pauseDetail(goalRunId)).toBe(
          'round 1: acceptance check disk: its observation did not satisfy the predicate; acceptance check health: unavailable (gate_unreachable); end the goal as not achieved (or as achieved, on your word), revise the plan, resume to verify again, or cancel',
        );

        await expect(endAs(goalRunId, ownerId, 'achieved', undefined, 'owner')).rejects.toThrow(
          /only the requester gives a goal run its outcome/,
        );
        const [diskEvidence] = await evidenceOf(goalRunId, 'disk');
        const overriddenChecks = [
          {
            checkKey: 'disk',
            kind: 'observe_predicate',
            round: 1,
            status: 'failed',
            observationId: diskEvidence?.id,
            lastError: 'predicate_unsatisfied',
          },
          {
            checkKey: 'health',
            kind: 'observe_predicate',
            round: 1,
            status: 'unavailable',
            observationId: null,
            lastError: 'gate_unreachable',
          },
        ];
        const ended = await endAs(goalRunId, requester, 'achieved', 'disk is fine, I checked');
        expect(ended).toMatchObject({ status: 'completed', overriddenChecks });
        expect(await goalOf(goalRunId)).toMatchObject({
          outcome: 'achieved',
          outcomeBasis: 'requester',
          outcomeDecisionId: ended.decisionId,
        });
        expect((await decisionOf(ended.decisionId))?.rationale).toMatchObject({
          outcome: 'achieved',
          from: 'paused',
          overriddenChecks,
        });
        expect(
          (await goalAudit(goalRunId)).find((row) => row.action === 'goal_run.complete')?.payload,
        ).toMatchObject({
          by: 'person',
          outcome: 'achieved',
          outcomeBasis: 'requester',
          outcomeDecisionId: ended.decisionId,
          pauseReason: 'needs_decision',
          overriddenChecks,
        });
        const view = await acceptanceOf(goalRunId);
        expect(view?.outcome).toEqual({
          outcome: 'achieved',
          basis: 'requester',
          decisionId: ended.decisionId,
          overriddenChecks,
        });
        expect(
          view?.rounds[0]?.checks.map((check) => [check.checkKey, check.status, check.overridden]),
        ).toEqual([
          ['disk', 'failed', true],
          ['health', 'unavailable', true],
          ['up', 'passed', false],
        ]);
      });

      it('a pause, an owner’s hold or a cancel ends the round: nothing is observed while the run is not verifying, an attempt under way writes nothing, and a resume verifies in a new round', async () => {
        const requester = await newPrincipal();
        const { goalRunId } = await verifyingGoal(requester, [observe()]);

        // The run is paused while the gate answers: the attempt writes nothing.
        observeClient.answer = async () => {
          await asRequester(requester, (client) =>
            pauseGoalRun(client, workspaceId, { goalRunId, actor: by(requester) }),
          );
          return { data: { state: 'running' } };
        };
        expect(await observeNow(goalRunId)).toBe('skipped');
        expect(await evidenceOf(goalRunId)).toEqual([]);
        expect(await goalOf(goalRunId)).toMatchObject({
          status: 'paused',
          pauseReason: 'requested',
        });
        expect(await rowsOf(goalRunId)).toMatchObject([
          { round: 1, status: 'superseded', attempts: 1, observationId: null },
        ]);
        expect(
          (await goalAudit(goalRunId)).find((row) => row.action === 'goal_run.pause')?.payload,
        ).toMatchObject({ supersededAcceptanceChecks: 1 });
        expect(await dueOf(goalRunId)).toEqual([]);
        await advance(goalRunId, requester);
        expect(await rowsOf(goalRunId)).toHaveLength(1);

        // An owner's hold: the requester resumes only after it is lifted.
        await asRequester(ownerId, (client) =>
          pauseGoalRun(client, workspaceId, { goalRunId, actor: by(ownerId, 'owner') }),
        );
        await expect(
          asRequester(requester, (client) =>
            resumeGoalRun(client, workspaceId, { goalRunId, actor: by(requester) }),
          ),
        ).rejects.toThrow(/a workspace owner holds it/);
        await advance(goalRunId, requester);
        expect(await rowsOf(goalRunId)).toHaveLength(1);
        await asRequester(ownerId, (client) =>
          releaseGoalRunHold(client, workspaceId, { goalRunId, actor: by(ownerId, 'owner') }),
        );
        await asRequester(requester, (client) =>
          resumeGoalRun(client, workspaceId, { goalRunId, actor: by(requester) }),
        );
        expect(await advance(goalRunId, requester)).toMatchObject({ status: 'verifying' });
        expect(
          (await rowsOf(goalRunId)).map((row) => [row.round, row.checkKey, row.status]),
        ).toEqual([
          [1, 'up', 'superseded'],
          [2, 'up', 'pending'],
        ]);

        observeClient.answer = RUNNING;
        expect(await observeNow(goalRunId)).toBe('passed');
        await advance(goalRunId, requester);
        expect(await goalOf(goalRunId)).toMatchObject({
          status: 'completed',
          outcome: 'achieved',
          outcomeBasis: 'verified_by_check',
        });

        // A cancel supersedes the round too; a cancelled run has no outcome.
        const other = await newPrincipal();
        const cancelled = await verifyingGoal(other, [observe()]);
        await asRequester(other, (client) =>
          cancelGoalRun(client, workspaceId, {
            goalRunId: cancelled.goalRunId,
            actor: by(other),
          }),
        );
        await advance(cancelled.goalRunId, other);
        expect(await goalOf(cancelled.goalRunId)).toMatchObject({
          status: 'cancelled',
          outcome: null,
        });
        expect(await rowsOf(cancelled.goalRunId)).toMatchObject([{ status: 'superseded' }]);
        expect(await acceptanceOf(cancelled.goalRunId)).toMatchObject({ outcome: null });
        await expect(endAs(cancelled.goalRunId, other, 'not_achieved')).rejects.toThrow(
          /is cancelled; a paused or verifying run is ended with an outcome/,
        );
      });

      it('ending a run with an outcome: only the requester, only once nothing of it may still run; steps not started are skipped; an achieved without any round names every check as not run', async () => {
        const requester = await newPrincipal();
        const created = await proposeWith(
          requester,
          [observe()],
          [{ key: 'a' }, { key: 'b', dependsOn: ['a'] }],
        );
        const goalRunId = created.goalRunId;
        await advance(goalRunId, requester);
        await expect(endAs(goalRunId, requester, 'not_achieved')).rejects.toThrow(
          /is running; a paused or verifying run is ended with an outcome/,
        );
        await asRequester(requester, (client) =>
          pauseGoalRun(client, workspaceId, { goalRunId, actor: by(requester) }),
        );
        await expect(endAs(goalRunId, requester, 'achieved')).rejects.toThrow(
          /step a is running; wait for it, or cancel the run/,
        );
        await completeStep((await stepsOf(goalRunId)).a?.id as string, requester);
        await advance(goalRunId, requester);
        expect((await stepsOf(goalRunId)).a?.status).toBe('succeeded');
        // Each request is looked at on its own: one whose outcome is unknown — it may have run,
        // and the run may end over it — never hides one that still awaits its decision or runs
        // (review #493 on GO4a: the step's combined effect ranks `reconcile` above `approval`).
        const a = (await stepsOf(goalRunId)).a?.id as string;
        await seedAction(a, null, 'failed', 'outcome_unknown');
        for (const status of ['pending_approval', 'auto_approved', 'executing']) {
          const inFlight = await seedAction(a, null, status);
          await expect(endAs(goalRunId, requester, 'not_achieved')).rejects.toThrow(
            /an action of step a still awaits a decision or runs; wait for it, or cancel the run/,
          );
          await setActionStatus(inFlight, 'executed');
        }
        await expect(
          endAs(goalRunId, requester, 'achieved', 'x'.repeat(GOAL_OUTCOME_NOTE_MAX + 1)),
        ).rejects.toThrow(/a note is at most/);

        const ended = await endAs(goalRunId, requester, 'achieved');
        const b = (await stepsOf(goalRunId)).b;
        expect(ended).toMatchObject({
          status: 'completed',
          skippedStepRunIds: [b?.id],
          overriddenChecks: [
            {
              checkKey: 'up',
              kind: 'observe_predicate',
              round: null,
              status: 'not_run',
              observationId: null,
              lastError: null,
            },
          ],
        });
        expect(b?.status).toBe('skipped');
        expect(await acceptanceOf(goalRunId)).toMatchObject({
          rounds: [],
          outcome: {
            basis: 'requester',
            overriddenChecks: [{ checkKey: 'up', status: 'not_run' }],
          },
        });
      });

      it('the reconcile scan opens a round a run never got and wakes one whose wake was lost; a leftover pending row of a run that left verifying is superseded without a call', async () => {
        const requester = await newPrincipal();
        const { goalRunId } = await verifyingGoal(requester, [observe()]);
        // While its observation is pending, nothing to wake.
        await raw('update goal_runs set next_tick_at = null where workspace_id = $1 and id = $2', [
          workspaceId,
          goalRunId,
        ]);
        await markReconcileDue(pool);
        expect(await isDue(goalRunId)).toBe(false);
        // Settled, but the wake was lost.
        observeClient.answer = RUNNING;
        expect(await observeNow(goalRunId)).toBe('passed');
        await raw('update goal_runs set next_tick_at = null where workspace_id = $1 and id = $2', [
          workspaceId,
          goalRunId,
        ]);
        await markReconcileDue(pool);
        expect(await isDue(goalRunId)).toBe(true);
        await advance(goalRunId, requester);
        expect((await goalOf(goalRunId)).status).toBe('completed');

        // A run that entered verifying under a release without verification has no round.
        const other = await newPrincipal();
        const bare = await verifyingGoal(other, [observe()]);
        await raw(
          'delete from goal_acceptance_checks where workspace_id = $1 and goal_run_id = $2',
          [workspaceId, bare.goalRunId],
        );
        await raw('update goal_runs set next_tick_at = null where workspace_id = $1 and id = $2', [
          workspaceId,
          bare.goalRunId,
        ]);
        await markReconcileDue(pool);
        expect(await isDue(bare.goalRunId)).toBe(true);
        await advance(bare.goalRunId, other);
        expect(await rowsOf(bare.goalRunId)).toMatchObject([
          { round: 1, checkKey: 'up', status: 'pending' },
        ]);

        // A pending row a release left behind when it moved the run out of verifying.
        await raw(
          "update goal_runs set status = 'paused', pause_reason = 'requested' where workspace_id = $1 and id = $2",
          [workspaceId, bare.goalRunId],
        );
        const [leftover] = await dueOf(bare.goalRunId);
        expect(leftover).toMatchObject({ checkKey: 'up', closedBy: 'goal_left_verifying' });
        const calls = observeClient.calls.length;
        expect(await runAcceptanceCheck(checkDeps(), leftover as DueAcceptanceCheck)).toBe(
          'superseded',
        );
        expect(observeClient.calls).toHaveLength(calls);
        expect(await rowsOf(bare.goalRunId)).toMatchObject([{ status: 'superseded' }]);
      });

      it('a check the requester may no longer make is unavailable at once; the tick runs every due observation', async () => {
        const demoted = await newPrincipal();
        const refused = await verifyingGoal(demoted, [observe()]);
        await raw("update principals set role = 'auditor' where workspace_id = $1 and id = $2", [
          workspaceId,
          demoted,
        ]);
        const calls = observeClient.calls.length;
        expect(await observeNow(refused.goalRunId)).toBe('unavailable');
        expect(observeClient.calls).toHaveLength(calls);
        expect(await rowsOf(refused.goalRunId)).toMatchObject([
          { status: 'unavailable', lastError: 'requester_may_not_observe', observationId: null },
        ]);

        const requester = await newPrincipal();
        const first = await verifyingGoal(requester, [observe()]);
        const second = await verifyingGoal(requester, [observe()]);
        observeClient.answer = RUNNING;
        const errors: unknown[] = [];
        expect(
          await runAcceptanceCheckTick(checkDeps(), {
            limit: 1000,
            onError: (err) => errors.push(err),
          }),
        ).toBeGreaterThanOrEqual(2);
        expect(errors).toEqual([]);
        expect((await rowsOf(first.goalRunId))[0]?.status).toBe('passed');
        expect((await rowsOf(second.goalRunId))[0]?.status).toBe('passed');
      });

      it('a plan’s acceptance observation names a published observe-class Operation of an enabled gate, with params that carry no credential', async () => {
        const requester = await newPrincipal();
        const unknownGate = randomUUID();
        const jwtLike = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJnbzRhIn0', 'c2lnbmF0dXJlLWdvNGE'].join(
          '.',
        );
        let problems: readonly string[] = [];
        try {
          await proposeWith(requester, [
            { ...observe('a1'), check: { ...observe().check, operation: 'svc.missing' } },
            { ...observe('a2'), check: { ...observe().check, gatekeeperId: unknownGate } },
            { ...observe('a3'), check: { ...observe().check, params: { token: jwtLike } } },
          ]);
        } catch (err) {
          expect(err).toBeInstanceOf(GoalPlanValidationError);
          problems = (err as GoalPlanValidationError).problems;
        }
        expect(problems).toEqual([
          expect.stringMatching(/^acceptance\[0\] "a1": check: "svc\.missing" cannot be observed/),
          expect.stringMatching(/^acceptance\[1\] "a2": check: "svc\.status" cannot be observed/),
          expect.stringMatching(
            /^acceptance\[2\] "a3": check: .*svc\.status: the params carry 1 credential value/,
          ),
        ]);
      });
    });
  },
);
