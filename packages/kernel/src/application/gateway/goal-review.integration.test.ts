import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type GoalDetailWire,
  GoalDetailWireSchema,
  type GoalPlannerMode,
  type HandleClaims,
  REVIEWER_OUTPUT_SCHEMA,
  type Role,
  reviewDerivation,
} from '@nexttime/shared';
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
import { mapCapabilityError } from '../../interfaces/http/capability-route.js';
import { checkIG5 } from '../../substrate/audit/goal-invariant-checks.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { advanceGoalRun } from '../goal/advance.js';
import { createGoalRun } from '../goal/index.js';
import { REVIEW_SEALED, sameModelOf } from '../goal/review.js';
import { REVIEWER_HANDLE_CAPABILITIES } from '../task/index.js';
import { failTaskAndReapWorkerRuns } from '../task/lifecycle.js';
import { proposeWorkerDefinition, publishWorkerDefinition } from '../worker/index.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * Integration tests (real Postgres; auto-skip without DATABASE_URL) for S11 GO18a: a goal's
 * acceptance holding an independent review (`application/goal/review.ts`, phase V of `advance.ts`,
 * goal/0019, task/0014) — through the capability gateway as the console, the steps' Workers, the
 * reviewer and the goal planner call it, with an in-memory supervisor and every report written by
 * the test (no model runs).
 *
 * What the plan and the independent review asked tests for (go18-default-plan.md,
 * go18-independent-review.md): the review runs once every check the platform makes passed and
 * decides on the platform's arithmetic (F3, B2); the reviewer reads the criteria but not the pass
 * line, only its own Task, with no egress, and no other agent acting for the requester reads its
 * Task (F5, B3); a review not passing pauses the goal for its requester and opens no planner round
 * (F6); a review that cannot decide says why under a closed code (B3); reviews alone achieve the
 * goal on `reviewer_assessed`, which the confirmation card says (F7, N4), and with the requester's
 * confirmation on their word, given only after the review passed (B2); the goal planner reads a
 * review sealed and keeps it only exactly as read (F5, N7); the database takes nothing else.
 *
 * Every run this file moves is left with no `next_tick_at`, so no advancer of another file claims
 * it; the advances a test needs are driven by hand.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

const BUDGET = { maxTokens: 400_000, maxSteps: 10, maxRevisions: 3, maxWallClockSeconds: 3600 };
const ALL = 100_000;

const REVIEW = {
  kind: 'review',
  key: 'quality',
  subjects: ['draft'],
  criteria: [
    { key: 'clear', description: 'A reader new to the topic follows it', weight: 3 },
    { key: 'complete', description: 'Every section the outline names is there', weight: 1 },
  ],
  passAt: 75,
} as const;
const CONFIRM = { kind: 'requester_confirm', key: 'ok', prompt: 'Does the draft read well?' };
/** What the reviewed step reports. */
const DRAFT = { text: 'Q3 in review: revenue, costs, outlook.' };

function humanCaller(workspaceId: string, principalId: string, role: Role): ResolvedCaller {
  return {
    channel: 'human',
    principal: { workspaceId, id: principalId, kind: 'human', role, displayName: null },
    session: {
      workspaceId,
      id: randomUUID(),
      principalId,
      kind: 'web',
      onBehalfOf: principalId,
      status: 'active',
      createdAt: new Date(),
      expiresAt: null,
    },
  };
}

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
      ip: '198.51.100.31',
      startedAt: new Date().toISOString(),
      finishedAt: undefined,
      reason: undefined,
    });
    return { containerId, ip: '198.51.100.31' };
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
}

async function refusal(call: Promise<unknown>) {
  let thrown: unknown;
  try {
    await call;
  } catch (err) {
    thrown = err;
  }
  if (thrown === undefined) throw new Error('expected the call to be refused');
  return mapCapabilityError(thrown);
}

async function dbRefusal(write: Promise<unknown>): Promise<string> {
  try {
    await write;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('expected the database to refuse the write');
}

describe.runIf(DATABASE_URL !== undefined)(
  'goal review acceptance — S11 GO18a (integration, real Postgres)',
  () => {
    let pool: Pool;
    let privateKey: Awaited<ReturnType<typeof generateEphemeralHandleKeyPair>>['privateKey'];
    let workspaceId: string;
    let ownerId: string;
    let worker: { definitionId: string; version: number };
    const supervisor = new FakeTaskSupervisorClient();
    const roles = new Map<string, Role>();

    const admin = <T>(fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId, principalId: ownerId }, fn, { skipRoleSwitch: true });
    /** As the login role with the guards off — reads, and the few writes no path makes. */
    const raw = <T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) =>
      admin(async (client) => {
        await client.query('set local session_replication_role = replica');
        return (await client.query(sql, [...params])).rows as T[];
      });
    /** As the login role with the guards on — what the database itself refuses. */
    const guarded = (sql: string, params: readonly unknown[] = []) =>
      admin((client) => client.query(sql, [...params]));
    const asApp = <T>(principalId: string, fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId, principalId }, fn);

    async function newPrincipal(role: Role): Promise<string> {
      const id = randomUUID();
      await admin((client) =>
        client.query(
          `insert into principals (workspace_id, id, kind, role, display_name)
           values ($1, $2, 'human', $3, $4)`,
          [workspaceId, id, role, `${role}-${id.slice(0, 8)}`],
        ),
      );
      roles.set(id, role);
      return id;
    }

    const human = (principalId: string) =>
      humanCaller(workspaceId, principalId, roles.get(principalId) ?? 'member');

    const parkGoal = (goalRunId: string) =>
      raw('update goal_runs set next_tick_at = null where workspace_id = $1 and id = $2', [
        workspaceId,
        goalRunId,
      ]);

    async function call(caller: ResolvedCaller, name: string, params: Record<string, unknown>) {
      try {
        return await dispatchCapability({ pool }, caller, name, params);
      } finally {
        if (typeof params.goalRunId === 'string') await parkGoal(params.goalRunId);
      }
    }

    async function advanceOnce(goalRunId: string, requesterId: string) {
      const outcome = await advanceGoalRun(
        {
          pool,
          taskRuntime: { pool, privateKey, supervisorClient: supervisor },
          options: { retryBackoffMs: () => 0 },
        },
        { workspaceId, goalRunId, requesterId },
      );
      await parkGoal(goalRunId);
      return outcome;
    }

    /** One step, `key`, checked by `acceptance`. */
    const planOf = (acceptance: readonly unknown[], key = 'draft') => ({
      steps: [{ key, worker, input: { step: key }, maxAttempts: 1 }],
      ...(acceptance.length > 0 ? { acceptance } : {}),
    });

    async function propose(requesterId: string, plan: Record<string, unknown>) {
      const created = await asApp(requesterId, (client) =>
        createGoalRun(client, workspaceId, {
          requesterId,
          proposedBy: requesterId,
          statement: 'write the quarterly report',
          plan,
          budget: BUDGET,
        }),
      );
      return created.goalRunId;
    }

    /** Proposed, confirmed (with the planner's leave in mode `planner` unless it is false) and
     *  started. */
    async function startGoal(
      requesterId: string,
      plan: Record<string, unknown>,
      planner: GoalPlannerMode | false = false,
    ) {
      const goalRunId = await propose(requesterId, plan);
      await call(human(requesterId), 'confirm_goal', {
        goalRunId,
        revision: 1,
        ...(planner ? { planner } : {}),
      });
      await advanceOnce(goalRunId, requesterId);
      return goalRunId;
    }

    async function liveStep(goalRunId: string, key: string) {
      const [row] = await raw<{ id: string; status: string }>(
        `select id, status from step_runs
          where workspace_id = $1 and goal_run_id = $2 and step_key = $3
            and status <> 'superseded'`,
        [workspaceId, goalRunId, key],
      );
      if (!row) throw new Error(`no live step ${key}`);
      return row;
    }

    async function lastAttempt(stepRunId: string) {
      const [row] = await raw<{ id: string; status: string }>(
        `select id, status from tasks where workspace_id = $1 and step_run_id = $2
          order by step_attempt desc limit 1`,
        [workspaceId, stepRunId],
      );
      if (!row) throw new Error(`step ${stepRunId} has no attempt`);
      return row;
    }

    /** A Task's Worker, as its Handle calls the gateway. */
    async function workerOf(taskId: string): Promise<ResolvedCaller> {
      const [row] = await raw<{
        session_id: string;
        jti: string;
        on_behalf_of: string;
        scope: HandleClaims['scope'];
        expires_at: Date;
      }>(
        `select wr.session_id, h.jti, h.on_behalf_of, h.scope, h.expires_at
           from worker_runs wr
           join capability_handles h
             on h.workspace_id = wr.workspace_id and h.session_id = wr.session_id
          where wr.workspace_id = $1 and wr.task_id = $2
          order by wr.started_at desc limit 1`,
        [workspaceId, taskId],
      );
      if (!row) throw new Error(`no WorkerRun Handle for Task ${taskId}`);
      return {
        channel: 'handle',
        claims: {
          ws: workspaceId,
          sid: row.session_id,
          obo: row.on_behalf_of,
          scope: row.scope,
          jti: row.jti,
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(new Date(row.expires_at).getTime() / 1000),
        },
      };
    }

    /** The step's attempt reports success with {@link DRAFT} (or no output at all) — the advance
     *  after it enters `verifying` and starts the round's reviews, unless `beforeAdvance` changes
     *  something first. */
    async function succeed(
      goalRunId: string,
      requesterId: string,
      beforeAdvance?: (taskId: string) => Promise<unknown>,
      output: Record<string, unknown> | null = DRAFT,
    ) {
      const attempt = await lastAttempt((await liveStep(goalRunId, 'draft')).id);
      await dispatchCapability({ pool }, await workerOf(attempt.id), 'report_task_result', {
        summary: 'draft done',
        ...(output ? { output } : {}),
      });
      if (beforeAdvance) await beforeAdvance(attempt.id);
      await advanceOnce(goalRunId, requesterId);
      return attempt.id;
    }

    const goalRow = async (goalRunId: string) => {
      const [row] = await raw<{
        status: string;
        pause_reason: string | null;
        outcome: string | null;
        outcome_basis: string | null;
        outcome_decision_id: string | null;
      }>(
        `select status, pause_reason, outcome, outcome_basis, outcome_decision_id from goal_runs
          where workspace_id = $1 and id = $2`,
        [workspaceId, goalRunId],
      );
      if (!row) throw new Error(`goal run ${goalRunId} is gone`);
      return row;
    };

    const checkRow = async (goalRunId: string, checkKey = 'quality') => {
      const [row] = await raw<{
        round: number;
        status: string;
        attempts: number;
        last_error: string | null;
      }>(
        `select round, status, attempts, last_error from goal_acceptance_checks
          where workspace_id = $1 and goal_run_id = $2 and check_key = $3
          order by round desc limit 1`,
        [workspaceId, goalRunId, checkKey],
      );
      if (!row) throw new Error(`no check ${checkKey}`);
      return row;
    };

    async function reviewTask(goalRunId: string) {
      const rows = await raw<{
        id: string;
        status: string;
        on_behalf_of: string;
        step_run_id: string | null;
        review_round: number;
        review_check_key: string;
        output_schema: unknown;
        input: Record<string, unknown>;
      }>(
        `select id, status, on_behalf_of, step_run_id, review_round, review_check_key,
                output_schema, input
           from tasks where workspace_id = $1 and goal_run_id = $2 and purpose = 'review'
          order by created_at`,
        [workspaceId, goalRunId],
      );
      const [row, ...more] = rows;
      if (!row) throw new Error(`goal run ${goalRunId} has no reviewer Task`);
      expect(more).toEqual([]);
      return row;
    }

    const planningRounds = (goalRunId: string) =>
      raw<{ id: string; status: string; revision: number | null }>(
        `select id, status, revision from goal_planning_rounds
          where workspace_id = $1 and goal_run_id = $2 order by created_at`,
        [workspaceId, goalRunId],
      );

    const pauseDetail = async (goalRunId: string) => {
      const rows = await raw<{ payload: Record<string, unknown> }>(
        `select payload from audit_records
          where workspace_id = $1 and resource_id = $2 and action = 'goal_run.pause'
          order by created_at desc limit 1`,
        [workspaceId, goalRunId],
      );
      return String(rows[0]?.payload.detail ?? '');
    };

    const scores = (clear: number | null, complete: number | null) => ({
      scores: [
        { criterion: 'clear', score: clear, reason: 'how plainly it reads' },
        { criterion: 'complete', score: complete, reason: 'which sections are there' },
      ],
    });

    const reviewerReports = async (taskId: string, output: Record<string, unknown>) =>
      dispatchCapability({ pool }, await workerOf(taskId), 'report_task_result', {
        summary: 'reviewed',
        output,
      });

    const getGoal = async (goalRunId: string, by: string): Promise<GoalDetailWire> =>
      GoalDetailWireSchema.parse(await call(human(by), 'get_goal', { goalRunId }));

    const loseTask = (taskId: string, requesterId: string) =>
      failTaskAndReapWorkerRuns(
        { pool, privateKey, supervisorClient: supervisor },
        workspaceId,
        requesterId,
        taskId,
        'spawn_lost',
      );

    /** The requester's approved outcome Decision for confirmation `checkKey` of round `round` —
     *  what `confirm_goal_acceptance` writes, here without its checks. */
    async function confirmationDecision(
      goalRunId: string,
      requesterId: string,
      round: number,
      checkKey: string,
    ) {
      const activity = await asApp(requesterId, (client) =>
        startActivity(client, workspaceId, {
          kind: 'goal.outcome_decision',
          principalId: requesterId,
          metadata: { goalRunId, outcome: 'achieved' },
        }),
      );
      const [row] = await raw<{ id: string }>(
        `insert into decisions (workspace_id, status, activity_id, summary, rationale, decided_by,
           decided_at)
         values ($1, 'approved', $2, 'a goal outcome', $3::jsonb, $4, now()) returning id`,
        [
          workspaceId,
          activity.id,
          JSON.stringify({
            decision: 'goal_outcome',
            goalRunId,
            outcome: 'achieved',
            round,
            checkKey,
          }),
          requesterId,
        ],
      );
      return row?.id as string;
    }

    const notFlaggedByIG5 = async (goalRunIds: readonly string[]) => {
      const client = await pool.connect();
      try {
        const result = await checkIG5(client, ALL);
        for (const id of goalRunIds) {
          expect(
            result.sample.filter((line) => line.includes(`${workspaceId}:${id} (`)),
            id,
          ).toEqual([]);
        }
      } finally {
        client.release();
      }
    };

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
            'go18a-goal-review',
          ]);
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'owner', 'owner')",
            [workspaceId, ownerId],
          );
        },
        { skipRoleSwitch: true },
      );
      roles.set(ownerId, 'owner');
      const proposed = await asApp(ownerId, (client) =>
        proposeWorkerDefinition(client, workspaceId, ownerId, {
          origin: 'human',
          kind: 'worker',
          definition: { systemPrompt: 'You draft a report.' },
        }),
      );
      await asApp(ownerId, (client) =>
        publishWorkerDefinition(client, workspaceId, ownerId, {
          definitionId: proposed.id,
          version: proposed.version,
        }),
      );
      worker = { definitionId: proposed.id, version: proposed.version };
    });

    afterAll(async () => {
      await raw(
        `update goal_runs set status = 'cancelled', pause_reason = null, paused_by = null,
                paused_by_authority = null, ended_at = now(), next_tick_at = null
          where workspace_id = $1 and status not in ('completed', 'cancelled', 'failed')`,
        [workspaceId],
      );
      await pool.end();
    });

    // -------------------------------------------------------------------------------------------

    it('reviews alone: the card says so; the reviewer reads the criteria but not the pass line, only its own Task, with no egress; its scores achieve the goal on reviewer_assessed', async () => {
      const requester = await newPrincipal('member');
      const goalRunId = await propose(requester, planOf([REVIEW]));
      // N4: whoever confirms it reads that a model's scores alone decide.
      expect((await getGoal(goalRunId, requester)).planRevision.hints).toEqual([
        { code: 'review_only', message: expect.stringContaining('on a model’s scores alone') },
      ]);
      await call(human(requester), 'confirm_goal', { goalRunId, revision: 1 });
      await advanceOnce(goalRunId, requester);
      await succeed(goalRunId, requester);
      expect((await goalRow(goalRunId)).status).toBe('verifying');

      const task = await reviewTask(goalRunId);
      expect(task).toMatchObject({
        status: 'running',
        on_behalf_of: requester,
        step_run_id: null,
        review_round: 1,
        review_check_key: 'quality',
        output_schema: REVIEWER_OUTPUT_SCHEMA,
      });
      expect(await checkRow(goalRunId)).toMatchObject({ status: 'pending', attempts: 1 });
      expect(task.input).toMatchObject({
        kind: 'goal_review',
        goal: { statement: 'write the quarterly report' },
        subjects: [{ key: 'draft', status: 'succeeded', attempt: 1, output: DRAFT, files: null }],
        criteria: REVIEW.criteria,
        scoreRange: { min: 0, max: 4 },
      });
      // F5: the line it is held to is not the reviewer's to read.
      expect(JSON.stringify(task.input)).not.toContain('passAt');
      expect(supervisor.spawnCalls.find((input) => input.taskId === task.id)?.egressDenyAll).toBe(
        true,
      );

      const reviewer = await workerOf(task.id);
      if (reviewer.channel !== 'handle') throw new Error('not a Handle');
      expect(new Set(reviewer.claims.scope.capabilities)).toEqual(
        new Set(REVIEWER_HANDLE_CAPABILITIES),
      );
      expect(await dispatchCapability({ pool }, reviewer, 'get_task', { taskId: task.id })).toEqual(
        expect.objectContaining({ id: task.id }),
      );
      for (const [name, params] of [
        ['get_goal', { goalRunId }],
        ['invoke_worker', { definitionId: worker.definitionId, input: {} }],
      ] as const) {
        expect((await refusal(dispatchCapability({ pool }, reviewer, name, params))).status).toBe(
          403,
        );
      }
      // B3 (a): another agent acting for the requester — a step Worker of theirs — reads it as an
      // unknown Task; the requester reads it.
      const other = await startGoal(requester, planOf([]));
      const otherStep = await workerOf((await lastAttempt((await liveStep(other, 'draft')).id)).id);
      expect(
        (await refusal(dispatchCapability({ pool }, otherStep, 'get_task', { taskId: task.id })))
          .status,
      ).toBe(404);
      expect(await call(human(requester), 'get_task', { taskId: task.id })).toEqual(
        expect.objectContaining({ id: task.id }),
      );

      await reviewerReports(task.id, { ...scores(4, 2), comment: 'Reads well.' });
      // N3: what the reviewer read is the record its assessment rests on.
      expect(
        await dbRefusal(
          guarded(`update tasks set input = '{}'::jsonb where workspace_id = $1 and id = $2`, [
            workspaceId,
            task.id,
          ]),
        ),
      ).toMatch(/what a review Task reads never changes after it is created/);
      await advanceOnce(goalRunId, requester);
      expect(await goalRow(goalRunId)).toMatchObject({
        status: 'completed',
        outcome: 'achieved',
        outcome_basis: 'reviewer_assessed',
        outcome_decision_id: null,
      });
      const detail = await getGoal(goalRunId, requester);
      expect(detail).toMatchObject({ outcome: 'achieved', outcomeBasis: 'reviewer_assessed' });
      const [check] = detail.acceptance.rounds[0]?.checks ?? [];
      expect(check).toMatchObject({ kind: 'review', checkKey: 'quality', status: 'passed' });
      const assessment = check?.review?.assessment;
      // 3 × 4 + 1 × 2 of 3 × 4 + 1 × 4 points: 87.5 per cent, at or over 75.
      expect(assessment).toMatchObject({
        reviewTaskId: task.id,
        points: 14,
        maxPoints: 16,
        passAt: 75,
        unassessed: [],
        verdict: 'passed',
        comment: 'Reads well.',
      });
      expect(assessment?.lines.map((line) => [line.criterion, line.score])).toEqual([
        ['clear', 4],
        ['complete', 2],
      ]);
      if (!assessment) throw new Error('no assessment');
      expect(assessment.sameModel).toBe(
        sameModelOf(assessment.reviewerModel, assessment.executorModels),
      );
      expect(assessment.executorModels.map((executor) => executor.stepKey)).toEqual(['draft']);
      await notFlaggedByIG5([goalRunId]);
    });

    it('a review below its line pauses the goal for its requester, naming what pulled it down — no planner round; the database takes no verdict the scores do not give', async () => {
      const requester = await newPrincipal('member');
      // The planner's leave: a failed review still opens no round for it (F6).
      const goalRunId = await startGoal(requester, planOf([REVIEW]), 'propose');
      await succeed(goalRunId, requester);
      const task = await reviewTask(goalRunId);
      await reviewerReports(task.id, scores(1, 4));

      // B2: what a review passes on is the arithmetic of the reviewer's scores — 3 × 1 + 1 × 4 = 7
      // of 16 points is below 75 per cent — and its check follows its assessment.
      const derivation = reviewDerivation(REVIEW.criteria, REVIEW.passAt, scores(1, 4).scores);
      expect(derivation).toMatchObject({ points: 7, maxPoints: 16, verdict: 'failed' });
      expect(
        await dbRefusal(
          guarded(
            `insert into goal_review_assessments (
               workspace_id, goal_run_id, round, check_key, review_task_id, reviewer_model,
               executor_models, same_model, lines, comment, points, max_points, pass_at,
               unassessed, verdict
             ) values ($1, $2, 1, 'quality', $3, null, '[]'::jsonb, null, $4::jsonb, null, $5,
                       $6, $7, '[]'::jsonb, 'passed')`,
            [
              workspaceId,
              goalRunId,
              task.id,
              JSON.stringify(derivation.lines),
              derivation.points,
              derivation.maxPoints,
              derivation.passAt,
            ],
          ),
        ),
      ).toMatch(/the points, the line and the verdict are the arithmetic of the scores/);
      expect(
        await dbRefusal(
          guarded(
            `update goal_acceptance_checks set status = 'passed', settled_at = now()
              where workspace_id = $1 and goal_run_id = $2 and check_key = 'quality'`,
            [workspaceId, goalRunId],
          ),
        ),
      ).toMatch(/a review passes or fails only on its assessment, with that verdict/);

      await advanceOnce(goalRunId, requester);
      expect(await goalRow(goalRunId)).toMatchObject({
        status: 'paused',
        pause_reason: 'needs_decision',
      });
      expect(await checkRow(goalRunId)).toMatchObject({ status: 'failed', last_error: null });
      const detail = await pauseDetail(goalRunId);
      expect(detail).toContain(
        'acceptance check quality: the review scored 7 of 16 points, below its line of 75 per cent (lowest: clear 1/4)',
      );
      // The pause names the platform's numbers and the criteria's keys, never the reviewer's words.
      expect(detail).not.toContain('how plainly it reads');
      expect(await planningRounds(goalRunId)).toEqual([]);
      await advanceOnce(goalRunId, requester);
      expect(await planningRounds(goalRunId)).toEqual([]);
      const [check] = (await getGoal(goalRunId, requester)).acceptance.rounds[0]?.checks ?? [];
      expect(check?.review?.assessment).toMatchObject({ points: 7, verdict: 'failed' });
      await notFlaggedByIG5([goalRunId]);
    });

    it('a review that cannot decide says why under a closed code: a criterion the reviewer could not judge, a reviewer that failed, a step that left nothing to review, a goal with too few tokens left', async () => {
      const requester = await newPrincipal('member');

      const unjudged = await startGoal(requester, planOf([REVIEW]));
      await succeed(unjudged, requester);
      await reviewerReports((await reviewTask(unjudged)).id, scores(null, 4));
      await advanceOnce(unjudged, requester);
      expect(await checkRow(unjudged)).toMatchObject({
        status: 'unavailable',
        last_error: 'criteria_unassessed',
      });
      expect(await goalRow(unjudged)).toMatchObject({
        status: 'paused',
        pause_reason: 'needs_decision',
      });
      expect(await pauseDetail(unjudged)).toContain(
        'acceptance check quality: the reviewer could not judge clear, so the review decided nothing',
      );

      const lost = await startGoal(requester, planOf([REVIEW]));
      await succeed(lost, requester);
      await loseTask((await reviewTask(lost)).id, requester);
      await advanceOnce(lost, requester);
      expect(await checkRow(lost)).toMatchObject({
        status: 'unavailable',
        last_error: 'reviewer_failed',
      });
      expect(await pauseDetail(lost)).toContain(
        'acceptance check quality: the review did not run to a verdict (reviewer_failed)',
      );

      // §3.8: a reviewed step that left nothing to read — no output, no files — is never reviewed.
      const empty = await startGoal(requester, planOf([REVIEW]));
      await succeed(empty, requester, undefined, null);
      expect(await checkRow(empty)).toMatchObject({
        status: 'unavailable',
        attempts: 0,
        last_error: 'subject_missing',
      });
      expect(await pauseDetail(empty)).toContain('(subject_missing)');

      // F8: the reviewer's tokens come out of the goal's budget; too few left, it never starts.
      const spent = await startGoal(requester, planOf([REVIEW]));
      await succeed(spent, requester, (taskId) =>
        raw(
          `update tasks set tokens_used = $2, token_budget = greatest(token_budget, $2)
            where workspace_id = $1 and id = $3`,
          [workspaceId, BUDGET.maxTokens - 5_000, taskId],
        ),
      );
      expect(await checkRow(spent)).toMatchObject({
        status: 'unavailable',
        attempts: 0,
        last_error: 'no_budget',
      });
      expect(
        await raw(
          `select id from tasks where workspace_id = $1 and goal_run_id = $2 and purpose = 'review'`,
          [workspaceId, spent],
        ),
      ).toEqual([]);
      expect(await goalRow(spent)).toMatchObject({
        status: 'paused',
        pause_reason: 'needs_decision',
      });
      await notFlaggedByIG5([unjudged, lost, empty, spent]);
    });

    it('a reviewer report that writes anything but its scores, or misses a criterion, is refused and the review keeps waiting', async () => {
      const requester = await newPrincipal('member');
      const goalRunId = await startGoal(requester, planOf([REVIEW]));
      await succeed(goalRunId, requester);
      const task = await reviewTask(goalRunId);
      const writes = await refusal(
        dispatchCapability({ pool }, await workerOf(task.id), 'report_task_result', {
          summary: 'reviewed',
          output: scores(4, 4),
          findings: ['the step looks fine'],
          factsToAssert: [
            {
              linkType: 'reviewed',
              source: { objectType: 'Document', identity: { name: 'draft' } },
              target: { objectType: 'Document', identity: { name: 'outline' } },
            },
          ],
          evidence: [{ kind: 'note', content: { text: 'the step looks fine' } }],
        }),
      );
      expect(writes.status).toBe(400);
      expect(writes.message).toContain("what the goal reviewer's report must be");
      expect(writes.message).toContain('findings:');
      expect(writes.message).toContain('factsToAssert:');
      expect(writes.message).toContain('evidence:');
      const missing = await refusal(
        reviewerReports(task.id, {
          scores: [{ criterion: 'clear', score: 4, reason: 'reads plainly' }],
        }),
      );
      expect(missing.status).toBe(400);
      expect(missing.message).toContain('complete');
      expect((await reviewTask(goalRunId)).status).toBe('running');
      expect(await checkRow(goalRunId)).toMatchObject({ status: 'pending', attempts: 1 });

      // Independent review of #1102: the run leaves `verifying` (here the requester pauses it) and
      // its checks are superseded in that commit; the reviewer's Task is stopped only after it. A
      // report landing in between is still held to what a reviewer may write.
      await call(human(requester), 'pause_goal', { goalRunId });
      expect(await checkRow(goalRunId)).toMatchObject({ status: 'superseded' });
      expect((await reviewTask(goalRunId)).status).toBe('running');
      const late = await refusal(
        dispatchCapability({ pool }, await workerOf(task.id), 'report_task_result', {
          summary: 'reviewed',
          output: scores(4, 4),
          factsToAssert: [
            {
              linkType: 'reviewed',
              source: { objectType: 'Document', identity: { name: 'draft' } },
              target: { objectType: 'Document', identity: { name: 'outline' } },
            },
          ],
          proposedSkill: {
            name: 'grading',
            description: 'how this goal is graded',
            markdown: 'clear weighs 3, complete 1',
          },
        }),
      );
      expect(late.status).toBe(400);
      expect(late.message).toContain('factsToAssert:');
      expect(late.message).toContain('proposedSkill:');
      // Its scores alone are kept on the Task and move nothing (§3.4).
      await reviewerReports(task.id, scores(4, 4));
      expect(await checkRow(goalRunId)).toMatchObject({ status: 'superseded' });
      expect(
        await raw(
          'select 1 from goal_review_assessments where workspace_id = $1 and goal_run_id = $2',
          [workspaceId, goalRunId],
        ),
      ).toEqual([]);
    });

    it('a review and the requester’s confirmation: they confirm only once the review passed, and the goal is achieved on their word', async () => {
      const requester = await newPrincipal('member');
      const goalRunId = await propose(requester, planOf([REVIEW, CONFIRM]));
      // UX acceptance of #1102: not 「only on the requester's word」 — the review must pass first.
      expect(
        (await getGoal(goalRunId, requester)).planRevision.hints.map((hint) => hint.code),
      ).toEqual(['review_and_confirm']);
      await call(human(requester), 'confirm_goal', { goalRunId, revision: 1 });
      await advanceOnce(goalRunId, requester);
      await succeed(goalRunId, requester);
      const task = await reviewTask(goalRunId);

      // B2: not before the review passed — not through the gateway, not in the database.
      const early = await refusal(
        call(human(requester), 'confirm_goal_acceptance', { goalRunId, checkKey: 'ok' }),
      );
      expect(early.status).toBe(409);
      expect(early.message).toContain('the requester confirms after them');
      const decision = await confirmationDecision(goalRunId, requester, 1, 'ok');
      expect(
        await dbRefusal(
          guarded(
            `update goal_acceptance_checks
                set status = 'passed', decision_id = $3, settled_at = now()
              where workspace_id = $1 and goal_run_id = $2 and check_key = 'ok'`,
            [workspaceId, goalRunId, decision],
          ),
        ),
      ).toMatch(/a confirmation passes only after every review of its round passed/);
      // B3 (b): a review that cannot decide says so under a code of the closed list only.
      expect(
        await dbRefusal(
          guarded(
            `update goal_acceptance_checks
                set status = 'unavailable', last_error = 'the reviewer said so', settled_at = now()
              where workspace_id = $1 and goal_run_id = $2 and check_key = 'quality'`,
            [workspaceId, goalRunId],
          ),
        ),
      ).toMatch(/violates check constraint/);

      await reviewerReports(task.id, scores(4, 4));
      await advanceOnce(goalRunId, requester);
      expect(await checkRow(goalRunId)).toMatchObject({ status: 'passed' });
      expect(await goalRow(goalRunId)).toMatchObject({ status: 'verifying' });
      expect(
        await call(human(requester), 'confirm_goal_acceptance', { goalRunId, checkKey: 'ok' }),
      ).toMatchObject({ changed: true });
      // F7: every check passed, a review and a confirmation among them — never by check, nor on
      // the review alone.
      for (const basis of ['verified_by_check', 'reviewer_assessed']) {
        expect(
          await dbRefusal(
            guarded(
              `update goal_runs set status = 'completed', outcome = 'achieved',
                      outcome_basis = $3, ended_at = now()
                where workspace_id = $1 and id = $2`,
              [workspaceId, goalRunId, basis],
            ),
          ),
        ).toMatch(
          basis === 'verified_by_check'
            ? /none of them a review \(I-G5\)/
            : /none the requester's confirmation \(I-G5\)/,
        );
      }
      await advanceOnce(goalRunId, requester);
      const done = await goalRow(goalRunId);
      expect(done).toMatchObject({
        status: 'completed',
        outcome: 'achieved',
        outcome_basis: 'requester',
      });
      expect(done.outcome_decision_id).not.toBeNull();
      await notFlaggedByIG5([goalRunId]);
    });

    it('the goal planner reads a review sealed, and keeps it only exactly as read — the revision holds the requester’s review', async () => {
      const requester = await newPrincipal('member');
      const goalRunId = await startGoal(requester, planOf([REVIEW]), 'propose');
      const step = await liveStep(goalRunId, 'draft');
      await loseTask((await lastAttempt(step.id)).id, requester);
      await advanceOnce(goalRunId, requester);
      const [round] = await planningRounds(goalRunId);
      if (!round) throw new Error('no planning round');
      const [planner] = await raw<{ id: string; input: Record<string, unknown> }>(
        'select id, input from tasks where workspace_id = $1 and planning_round_id = $2',
        [workspaceId, round.id],
      );
      if (!planner) throw new Error('no planner Task');
      const read = planner.input.plan as {
        steps: Record<string, unknown>[];
        acceptance: unknown[];
      };
      const sealed = { ...REVIEW, criteria: REVIEW_SEALED, passAt: REVIEW_SEALED };
      expect(read.acceptance).toEqual([sealed]);
      expect(JSON.stringify(planner.input)).not.toContain('A reader new to the topic');

      const proposal = async (acceptance: readonly unknown[]) =>
        dispatchCapability({ pool }, await workerOf(planner.id), 'report_task_result', {
          summary: 'planned',
          output: {
            decision: 'revise',
            plan: { steps: read.steps.map((entry) => ({ ...entry, maxAttempts: 2 })), acceptance },
            reason: 'The draft lost its run; one more attempt is enough.',
          },
        });
      for (const changed of [
        { ...sealed, passAt: 10 },
        { ...sealed, subjects: [] },
        REVIEW,
        { ...REVIEW, key: 'mine' },
      ]) {
        const refused = await refusal(proposal([changed]));
        expect(refused.status).toBe(400);
        expect(refused.message).toContain('output.plan.acceptance.0');
      }
      await proposal([sealed]);
      await advanceOnce(goalRunId, requester);
      expect(await planningRounds(goalRunId)).toMatchObject([{ status: 'proposed', revision: 2 }]);
      const [revision] = await raw<{ plan: { acceptance: unknown[] } }>(
        `select plan from plan_revisions
          where workspace_id = $1 and goal_run_id = $2 and revision = 2`,
        [workspaceId, goalRunId],
      );
      expect(revision?.plan.acceptance).toEqual([REVIEW]);
    });
  },
);
