import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ApproveStepTrialResultWireSchema,
  type CapabilityScope,
  type GoalDetailWire,
  GoalDetailWireSchema,
  type PlanHint,
  type Role,
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
import { advanceGoalRun } from '../goal/advance.js';
import { createGoalRun } from '../goal/index.js';
import { RunConfigSnapshotSchema, workerSpecDigest } from '../task/index.js';
import { failTaskAndReapWorkerRuns } from '../task/lifecycle.js';
import { proposeWorkerDefinition, publishWorkerDefinition } from '../worker/index.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * Integration tests (real Postgres; auto-skip without DATABASE_URL) for S11 GO8b: a person
 * approving one trial of a step whose WorkerSpec names Skills that are only drafts
 * (`approve_step_trial`, `application/goal/trial-approvals.ts`, goal/0013), dispatched through the
 * capability gateway as the console calls it, and what the advancer and `get_goal` make of it.
 *
 * The two points the coordinator asked tests for on GO8b:
 *   1. only a person's Principal writes an approval — a service Principal and any agent acting for
 *      someone (a Handle, its `obo` a person or not) are refused, by dispatch and by the database;
 *   2. an approval is never reused — not for another StepRun of the step (a revision that replaces
 *      it, same WorkerSpec), not for another WorkerSpec, not after a draft changed.
 *
 * Every run this file moves is left with no `next_tick_at`, so no advancer of another file claims
 * it; the advances a test needs are driven by hand, with an in-memory supervisor.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

const BUDGET = { maxTokens: 100_000, maxSteps: 10, maxRevisions: 3, maxWallClockSeconds: 3600 };
/** Synthetic — `.gitleaks.toml` allows fixtures spelled out from the alphabet. */
const FAKE = 'abcdefghijklmnopqrstuvwxyz0123';

function humanCaller(
  workspaceId: string,
  principalId: string,
  role: Role,
  kind: 'human' | 'service' = 'human',
): ResolvedCaller {
  return {
    channel: 'human',
    principal: { workspaceId, id: principalId, kind, role, displayName: null },
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

function handleCaller(workspaceId: string, obo: string, scope: CapabilityScope): ResolvedCaller {
  const now = Math.floor(Date.now() / 1000);
  return {
    channel: 'handle',
    claims: {
      ws: workspaceId,
      sid: randomUUID(),
      obo,
      scope,
      jti: randomUUID(),
      iat: now,
      exp: now + 600,
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
      ip: '198.51.100.23',
      startedAt: new Date().toISOString(),
      finishedAt: undefined,
      reason: undefined,
    });
    return { containerId, ip: '198.51.100.23' };
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

/** What the HTTP transport answers for the call's refusal (it must refuse). */
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

/** The database refusing a write (a guard, a grant): its message. */
async function dbRefusal(write: Promise<unknown>): Promise<string> {
  try {
    await write;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('expected the database to refuse the write');
}

type TrialHint = NonNullable<PlanHint['trial']>;

describe.runIf(DATABASE_URL !== undefined)(
  'approve_step_trial — S11 GO8b (integration, real Postgres)',
  () => {
    let pool: Pool;
    let privateKey: Awaited<ReturnType<typeof generateEphemeralHandleKeyPair>>['privateKey'];
    let workspaceId: string;
    let ownerId: string;
    let builderId: string;
    let otherBuilderId: string;
    let memberId: string;
    let serviceId: string;
    let worker: { definitionId: string; version: number };
    const supervisor = new FakeTaskSupervisorClient();
    const startErrors: unknown[] = [];

    const admin = <T>(fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId, principalId: ownerId }, fn, { skipRoleSwitch: true });

    /** A write with the guards off — fixtures the write paths of this wave do not reach. */
    const raw = <T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) =>
      admin(async (client) => {
        await client.query('set local session_replication_role = replica');
        return (await client.query(sql, [...params])).rows as T[];
      });

    /** As the application's database role (RLS, grants and guards on). */
    const asApp = <T>(principalId: string, fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId, principalId }, fn);

    async function newPrincipal(role: Role, kind: 'human' | 'service' = 'human'): Promise<string> {
      const id = randomUUID();
      await admin((client) =>
        client.query(
          `insert into principals (workspace_id, id, kind, role, display_name)
           values ($1, $2, $3, $4, $5)`,
          [workspaceId, id, kind, role, `${role}-${id.slice(0, 8)}`],
        ),
      );
      return id;
    }

    /** A Skill draft (version 1 of a new family unless named), proposed by `proposedBy`. */
    async function seedDraft(
      proposedBy: string,
      skill: { readonly id?: string; readonly name?: string; readonly markdown?: string } = {},
    ): Promise<{ id: string; name: string }> {
      const id = skill.id ?? randomUUID();
      const name = skill.name ?? `go8b-skill-${randomUUID().slice(0, 8)}`;
      await admin((client) =>
        client.query(
          `insert into skills (workspace_id, id, version, status, name, description, markdown,
             proposed_by)
           values ($1, $2, 1, 'draft', $3, 'a skill', $4, $5)`,
          [workspaceId, id, name, skill.markdown ?? '# Do it', proposedBy],
        ),
      );
      return { id, name };
    }

    /** The draft discarded and proposed again under the same version, with other content. */
    async function reproposeDraft(draft: { id: string; name: string }, proposedBy: string) {
      await raw("delete from skills where workspace_id = $1 and id = $2 and status = 'draft'", [
        workspaceId,
        draft.id,
      ]);
      await seedDraft(proposedBy, { ...draft, markdown: '# Do it another way' });
    }

    interface StepOf {
      readonly key: string;
      readonly skills?: readonly string[];
      readonly instructions?: string;
      readonly input?: Record<string, unknown>;
    }

    const planOf = (steps: readonly StepOf[]) => ({
      steps: steps.map((step) => ({
        key: step.key,
        worker,
        input: step.input ?? { step: step.key },
        ...(step.skills || step.instructions
          ? {
              spec: {
                ...(step.skills ? { skills: [...step.skills] } : {}),
                ...(step.instructions ? { instructions: step.instructions } : {}),
              },
            }
          : {}),
      })),
    });

    async function proposeGoal(by: string, steps: readonly StepOf[]) {
      const created = await asApp(by, (client) =>
        createGoalRun(client, workspaceId, {
          requesterId: by,
          proposedBy: by,
          statement: `goal of ${by.slice(0, 8)}`,
          plan: planOf(steps),
          budget: BUDGET,
        }),
      );
      return created.goalRunId;
    }

    const parkGoal = (goalRunId: string) =>
      raw('update goal_runs set next_tick_at = null where workspace_id = $1 and id = $2', [
        workspaceId,
        goalRunId,
      ]);

    const roles = new Map<string, Role>();
    const human = (principalId: string) =>
      humanCaller(workspaceId, principalId, roles.get(principalId) ?? 'member');

    async function call(caller: ResolvedCaller, name: string, params: Record<string, unknown>) {
      try {
        return await dispatchCapability({ pool }, caller, name, params);
      } finally {
        if (typeof params.goalRunId === 'string') await parkGoal(params.goalRunId);
      }
    }

    async function advanceOnce(goalRunId: string, by: string) {
      await advanceGoalRun(
        {
          pool,
          taskRuntime: { pool, privateKey, supervisorClient: supervisor },
          options: { retryBackoffMs: () => 0 },
          onStartError: (err) => startErrors.push(err),
        },
        { workspaceId, goalRunId, requesterId: by },
      );
      await parkGoal(goalRunId);
    }

    /** Proposed with `steps`, confirmed, and advanced once — paused at the draft step. */
    async function pausedAtDraft(by: string, steps: readonly StepOf[]) {
      const goalRunId = await proposeGoal(by, steps);
      await call(human(by), 'confirm_goal', { goalRunId, revision: 1 });
      await advanceOnce(goalRunId, by);
      expect(await goalRow(goalRunId)).toMatchObject({
        status: 'paused',
        pause_reason: 'needs_decision',
      });
      return goalRunId;
    }

    const getGoal = async (goalRunId: string, by: string): Promise<GoalDetailWire> =>
      GoalDetailWireSchema.parse(await call(human(by), 'get_goal', { goalRunId }));

    const draftHint = (detail: GoalDetailWire, stepKey: string) =>
      detail.planRevision.hints.find(
        (hint) => hint.code === 'step_skill_draft' && hint.stepKey === stepKey,
      );

    async function trialOf(goalRunId: string, by: string, stepKey = 'a'): Promise<TrialHint> {
      const trial = draftHint(await getGoal(goalRunId, by), stepKey)?.trial;
      if (!trial) throw new Error(`step ${stepKey} of ${goalRunId} hints no trial`);
      return trial;
    }

    const approve = (
      caller: ResolvedCaller,
      goalRunId: string,
      trial: TrialHint,
      extra: Record<string, unknown> = {},
    ) =>
      call(caller, 'approve_step_trial', {
        goalRunId,
        stepKey: 'a',
        specDigest: trial.specDigest,
        drafts: trial.drafts.map((draft) => ({
          skillId: draft.skillId,
          version: draft.version,
          draftDigest: draft.draftDigest,
        })),
        ...extra,
      });

    const goalRow = async (goalRunId: string) => {
      const [row] = await raw<{ status: string; pause_reason: string | null }>(
        'select status, pause_reason from goal_runs where workspace_id = $1 and id = $2',
        [workspaceId, goalRunId],
      );
      if (!row) throw new Error(`goal run ${goalRunId} is gone`);
      return row;
    };

    const liveStep = async (goalRunId: string, key = 'a') => {
      const [row] = await raw<{ id: string; attempt_count: number; status: string }>(
        `select id, attempt_count, status from step_runs
          where workspace_id = $1 and goal_run_id = $2 and step_key = $3
            and superseded_in_revision is null`,
        [workspaceId, goalRunId, key],
      );
      if (!row) throw new Error(`goal run ${goalRunId} has no live step ${key}`);
      return row;
    };

    const attemptTasks = (stepRunId: string) =>
      raw<{ id: string; step_attempt: number; run_config_snapshot: unknown }>(
        `select id, step_attempt, run_config_snapshot from tasks
          where workspace_id = $1 and step_run_id = $2 and step_attempt is not null
          order by step_attempt`,
        [workspaceId, stepRunId],
      );

    const approvalRows = (goalRunId: string) =>
      raw<{ id: string; step_run_id: string | null; plan_revision: number; approved_by: string }>(
        `select id, step_run_id, plan_revision, approved_by from goal_step_trial_approvals
          where workspace_id = $1 and goal_run_id = $2 order by approved_at`,
        [workspaceId, goalRunId],
      );

    /** The details the advancer paused (or noted a pause of) the run with, oldest first. */
    const pauseDetails = async (goalRunId: string) =>
      (
        await raw<{ detail: string }>(
          `select payload ->> 'detail' as detail from audit_records
            where workspace_id = $1 and resource_id = $2
              and action in ('goal_run.pause', 'goal_run.pause_noted')
            order by created_at`,
          [workspaceId, goalRunId],
        )
      ).map((row) => row.detail);

    /** A row written straight into the table as the application's role, past the gateway. */
    const insertApproval = (
      goalRunId: string,
      stepRunId: string | null,
      trial: TrialHint,
      approvedBy: string = builderId,
    ) =>
      asApp(approvedBy, (client) =>
        client.query(
          `insert into goal_step_trial_approvals
             (workspace_id, goal_run_id, step_key, plan_revision, step_run_id, spec_digest,
              drafts, approved_by)
           values ($1, $2, 'a', 1, $3, $4, $5::jsonb, $6)`,
          [
            workspaceId,
            goalRunId,
            stepRunId,
            trial.specDigest,
            JSON.stringify(trial.drafts),
            approvedBy,
          ],
        ),
      );

    const nameStepRun = (approvalId: string, stepRunId: string) =>
      asApp(builderId, (client) =>
        client.query(
          'update goal_step_trial_approvals set step_run_id = $3 where workspace_id = $1 and id = $2',
          [workspaceId, approvalId, stepRunId],
        ),
      );

    /** Started with an approval of its trial (made on the paused run) and running its first
     *  attempt, which then fails as `spawn_lost` — so the next advance tries it again. */
    async function trialStartedThenLost(draft: { id: string; name: string }) {
      const goalRunId = await pausedAtDraft(builderId, [{ key: 'a', skills: [draft.name] }]);
      const approved = ApproveStepTrialResultWireSchema.parse(
        await approve(human(builderId), goalRunId, await trialOf(goalRunId, builderId)),
      );
      await call(human(builderId), 'resume_goal', { goalRunId });
      await advanceOnce(goalRunId, builderId);
      const step = await liveStep(goalRunId);
      const [first] = await attemptTasks(step.id);
      if (!first) throw new Error('the first attempt did not start');
      expect(RunConfigSnapshotSchema.parse(first.run_config_snapshot)).toMatchObject({
        trial: { approvalId: approved.approvalId },
      });
      const lose = async (taskId: string) =>
        failTaskAndReapWorkerRuns(
          { pool, privateKey, supervisorClient: supervisor },
          workspaceId,
          builderId,
          taskId,
          'spawn_lost',
        );
      await lose(first.id);
      return { goalRunId, step, lose };
    }

    const spawnOf = (taskId: string): TaskSpawnInput => {
      const spawned = supervisor.spawnCalls.find((input) => input.taskId === taskId);
      if (!spawned) throw new Error(`no spawn for Task ${taskId}`);
      return spawned;
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
            'go8b-trial-approvals',
          ]);
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'owner', 'owner')",
            [workspaceId, ownerId],
          );
        },
        { skipRoleSwitch: true },
      );
      roles.set(ownerId, 'owner');
      builderId = await newPrincipal('builder');
      roles.set(builderId, 'builder');
      otherBuilderId = await newPrincipal('builder');
      roles.set(otherBuilderId, 'builder');
      memberId = await newPrincipal('member');
      roles.set(memberId, 'member');
      serviceId = await newPrincipal('owner', 'service');
      const proposed = await asApp(ownerId, (client) =>
        proposeWorkerDefinition(client, workspaceId, ownerId, {
          kind: 'worker',
          definition: { systemPrompt: 'You do one step of a goal.' },
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

    describe('one trial of a paused step', () => {
      it('the requester approves; resuming starts the step with the draft mounted; a retry mounts the same; a discard stops the next', async () => {
        const draft = await seedDraft(builderId);
        const goalRunId = await pausedAtDraft(builderId, [{ key: 'a', skills: [draft.name] }]);
        const step = await liveStep(goalRunId);
        const trial = await trialOf(goalRunId, builderId);
        expect(trial.drafts).toEqual([
          {
            skillId: draft.id,
            version: 1,
            name: draft.name,
            draftDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
            proposedBy: builderId,
          },
        ]);

        const approved = ApproveStepTrialResultWireSchema.parse(
          await approve(human(builderId), goalRunId, trial),
        );
        expect(approved).toEqual({
          goalRunId,
          status: 'paused',
          changed: true,
          approvalId: expect.any(String),
        });
        // A replay changes nothing.
        expect(
          ApproveStepTrialResultWireSchema.parse(await approve(human(builderId), goalRunId, trial)),
        ).toEqual({ ...approved, changed: false });
        expect(await approvalRows(goalRunId)).toEqual([
          {
            id: approved.approvalId,
            step_run_id: step.id,
            plan_revision: 1,
            approved_by: builderId,
          },
        ]);
        const audit = await raw<{ actor_principal_id: string; payload: Record<string, unknown> }>(
          `select actor_principal_id, payload from audit_records
            where workspace_id = $1 and action = 'step_trial.approve' and resource_id = $2`,
          [workspaceId, goalRunId],
        );
        expect(audit).toEqual([
          {
            actor_principal_id: builderId,
            payload: expect.objectContaining({
              approvalId: approved.approvalId,
              stepKey: 'a',
              stepRunId: step.id,
              specDigest: trial.specDigest,
              drafts: [
                { skillId: draft.id, version: 1, draftDigest: trial.drafts[0]?.draftDigest },
              ],
              authority: 'requester',
            }),
          },
        ]);

        // Approving does not resume: the run stays paused, and the read says the trial is pending
        // and the step no longer waits for an approval.
        let detail = await getGoal(goalRunId, builderId);
        expect(detail.status).toBe('paused');
        expect(draftHint(detail, 'a')).toBeUndefined();
        expect(detail.trialApprovals).toEqual([
          expect.objectContaining({
            id: approved.approvalId,
            stepKey: 'a',
            stepRunId: step.id,
            state: 'pending',
            lapsedBecause: null,
            usedByTaskId: null,
            approvedBy: builderId,
          }),
        ]);

        await call(human(builderId), 'resume_goal', { goalRunId });
        await advanceOnce(goalRunId, builderId);
        expect(startErrors).toEqual([]);
        const [first] = await attemptTasks(step.id);
        if (!first) throw new Error('the approved step started no attempt');
        const snapshot = RunConfigSnapshotSchema.parse(first.run_config_snapshot);
        if (snapshot.v !== 2) throw new Error('the advancer writes snapshot version 2');
        expect(snapshot.trial).toEqual({
          approvalId: approved.approvalId,
          drafts: [{ skillId: draft.id, version: 1, draftDigest: trial.drafts[0]?.draftDigest }],
        });
        // The draft is mounted inline, never recorded as a published Skill the run loaded.
        expect(snapshot.skills).toEqual([]);
        expect(spawnOf(first.id).skillsInline?.map((mount) => mount.name)).toEqual([draft.name]);
        detail = await getGoal(goalRunId, builderId);
        expect(detail.trialApprovals).toEqual([
          expect.objectContaining({ state: 'used', usedByTaskId: first.id }),
        ]);

        // A retry of that attempt mounts the same draft version.
        await failTaskAndReapWorkerRuns(
          { pool, privateKey, supervisorClient: supervisor },
          workspaceId,
          builderId,
          first.id,
          'spawn_lost',
        );
        await advanceOnce(goalRunId, builderId);
        const [, second] = await attemptTasks(step.id);
        if (!second) throw new Error('the retry did not start');
        expect(RunConfigSnapshotSchema.parse(second.run_config_snapshot)).toMatchObject({
          trial: { approvalId: approved.approvalId },
        });
        expect(spawnOf(second.id).skillsInline?.map((mount) => mount.name)).toEqual([draft.name]);

        // The draft discarded mid-trial: the next retry does not start, and the run pauses.
        await failTaskAndReapWorkerRuns(
          { pool, privateKey, supervisorClient: supervisor },
          workspaceId,
          builderId,
          second.id,
          'spawn_lost',
        );
        await raw('delete from skills where workspace_id = $1 and id = $2', [
          workspaceId,
          draft.id,
        ]);
        await advanceOnce(goalRunId, builderId);
        expect(await attemptTasks(step.id)).toHaveLength(2);
        expect(await goalRow(goalRunId)).toMatchObject({
          status: 'paused',
          pause_reason: 'needs_decision',
        });
      });

      it('an approval made on the proposal is for the StepRun its confirmation creates, named when its first attempt starts', async () => {
        const draft = await seedDraft(builderId);
        const goalRunId = await proposeGoal(builderId, [{ key: 'a', skills: [draft.name] }]);
        const trial = await trialOf(goalRunId, builderId);
        const approved = ApproveStepTrialResultWireSchema.parse(
          await approve(human(builderId), goalRunId, trial),
        );
        expect(approved.status).toBe('proposed');
        expect(await approvalRows(goalRunId)).toEqual([
          expect.objectContaining({ step_run_id: null, plan_revision: 1 }),
        ]);
        const proposal = await getGoal(goalRunId, builderId);
        expect(draftHint(proposal, 'a')).toBeUndefined();
        expect(proposal.trialApprovals).toEqual([
          expect.objectContaining({ state: 'pending', stepRunId: null }),
        ]);

        await call(human(builderId), 'confirm_goal', { goalRunId, revision: 1 });
        await advanceOnce(goalRunId, builderId);
        // The run never paused: the step started with the approval.
        expect((await goalRow(goalRunId)).status).toBe('running');
        const step = await liveStep(goalRunId);
        const [first] = await attemptTasks(step.id);
        expect(RunConfigSnapshotSchema.parse(first?.run_config_snapshot)).toMatchObject({
          trial: { approvalId: approved.approvalId },
        });
        expect(await approvalRows(goalRunId)).toEqual([
          expect.objectContaining({ id: approved.approvalId, step_run_id: step.id }),
        ]);

        // The guard: named once, never again, and what it approved never changes.
        const otherStep = randomUUID();
        expect(
          await dbRefusal(
            asApp(builderId, (client) =>
              client.query(
                'update goal_step_trial_approvals set step_run_id = $3 where workspace_id = $1 and id = $2',
                [workspaceId, approved.approvalId, otherStep],
              ),
            ),
          ),
        ).toMatch(/one StepRun, ever|violates foreign key/);
        expect(
          await dbRefusal(
            asApp(builderId, (client) =>
              client.query(
                `update goal_step_trial_approvals set spec_digest = repeat('0', 64)
                  where workspace_id = $1 and id = $2`,
                [workspaceId, approved.approvalId],
              ),
            ),
          ),
        ).toMatch(/never change/);
        expect(
          await dbRefusal(
            asApp(builderId, (client) =>
              client.query(
                'delete from goal_step_trial_approvals where workspace_id = $1 and id = $2',
                [workspaceId, approved.approvalId],
              ),
            ),
          ),
        ).toMatch(/permission denied/);
      });
    });

    describe('only a person approves (coordinator on GO8b)', () => {
      it('a service Principal and a Handle — for a person or not — are refused, and the database refuses one too', async () => {
        const draft = await seedDraft(ownerId);
        const goalRunId = await pausedAtDraft(ownerId, [{ key: 'a', skills: [draft.name] }]);
        const trial = await trialOf(goalRunId, ownerId);
        // A service Principal's API key on the human channel, an owner's role and all.
        expect(
          await refusal(
            approve(humanCaller(workspaceId, serviceId, 'owner', 'service'), goalRunId, trial),
          ),
        ).toMatchObject({ status: 403, code: 'forbidden' });
        // An agent acting for the requester, the capability in its scope: a person's only.
        const scope: CapabilityScope = { capabilities: ['approve_step_trial'], resources: {} };
        expect(
          await refusal(approve(handleCaller(workspaceId, ownerId, scope), goalRunId, trial)),
        ).toMatchObject({ status: 403, code: 'forbidden' });
        expect(
          await refusal(approve(handleCaller(workspaceId, serviceId, scope), goalRunId, trial)),
        ).toMatchObject({ status: 403, code: 'forbidden' });
        expect(await approvalRows(goalRunId)).toEqual([]);

        // Below the gateway: a row naming anyone but a person of the workspace is refused.
        const step = await liveStep(goalRunId);
        const insert = (approvedBy: string) =>
          asApp(ownerId, (client) =>
            client.query(
              `insert into goal_step_trial_approvals
                 (workspace_id, goal_run_id, step_key, plan_revision, step_run_id, spec_digest,
                  drafts, approved_by)
               values ($1, $2, 'a', 1, $3, $4, $5::jsonb, $6)`,
              [
                workspaceId,
                goalRunId,
                step.id,
                trial.specDigest,
                JSON.stringify(trial.drafts),
                approvedBy,
              ],
            ),
          );
        expect(await dbRefusal(insert(serviceId))).toMatch(/approved by a person/);
        const disabled = await newPrincipal('owner');
        await raw('update principals set disabled_at = now() where workspace_id = $1 and id = $2', [
          workspaceId,
          disabled,
        ]);
        expect(await dbRefusal(insert(disabled))).toMatch(/approved by a person/);
        expect(await approvalRows(goalRunId)).toEqual([]);
      });
    });

    describe('who may approve: whoever could publish every draft now', () => {
      it("another builder's draft is not_proposer for the requester; the owner approves it", async () => {
        const draft = await seedDraft(otherBuilderId);
        const goalRunId = await pausedAtDraft(builderId, [{ key: 'a', skills: [draft.name] }]);
        const trial = await trialOf(goalRunId, builderId);
        expect(trial.drafts[0]?.proposedBy).toBe(otherBuilderId);
        expect(await refusal(approve(human(builderId), goalRunId, trial))).toMatchObject({
          status: 403,
          code: 'not_proposer',
        });
        // The draft's proposer cannot read the requester's run: not found.
        expect(await refusal(approve(human(otherBuilderId), goalRunId, trial))).toMatchObject({
          status: 404,
        });
        expect(await approvalRows(goalRunId)).toEqual([]);
        const approved = ApproveStepTrialResultWireSchema.parse(
          await approve(human(ownerId), goalRunId, trial),
        );
        expect(await approvalRows(goalRunId)).toEqual([
          expect.objectContaining({ id: approved.approvalId, approved_by: ownerId }),
        ]);
      });

      it('a member is refused by the capability (403); the owner approves for them', async () => {
        const draft = await seedDraft(memberId);
        const goalRunId = await pausedAtDraft(memberId, [{ key: 'a', skills: [draft.name] }]);
        const trial = await trialOf(goalRunId, memberId);
        expect(await refusal(approve(human(memberId), goalRunId, trial))).toMatchObject({
          status: 403,
          code: 'forbidden',
        });
        ApproveStepTrialResultWireSchema.parse(await approve(human(ownerId), goalRunId, trial));
        expect(await approvalRows(goalRunId)).toHaveLength(1);
      });

      it('a draft carrying a suspected credential needs the approver to confirm it (400), as a publish would', async () => {
        const draft = await seedDraft(builderId, { markdown: `# Do it\nPGPASSWORD=${FAKE} psql` });
        const goalRunId = await pausedAtDraft(builderId, [{ key: 'a', skills: [draft.name] }]);
        const trial = await trialOf(goalRunId, builderId);
        const mapped = await refusal(approve(human(builderId), goalRunId, trial));
        expect(mapped).toMatchObject({ status: 400, code: 'credentials_review_required' });
        expect(mapped.message).not.toContain(FAKE);
        expect(await approvalRows(goalRunId)).toEqual([]);
        ApproveStepTrialResultWireSchema.parse(
          await approve(human(builderId), goalRunId, trial, { credentialsReviewed: true }),
        );
        const [audit] = await raw<{ payload: Record<string, unknown> }>(
          `select payload from audit_records
            where workspace_id = $1 and action = 'step_trial.approve' and resource_id = $2`,
          [workspaceId, goalRunId],
        );
        expect(audit?.payload).toMatchObject({
          credentialReview: { confirmed: true, suspectedSecretValues: 1 },
        });
      });
    });

    describe('when: a proposed or paused run, before the step has started', () => {
      it('a running run is 409; so is a step whose attempt started', async () => {
        const draft = await seedDraft(builderId);
        const proposed = await proposeGoal(builderId, [{ key: 'a', skills: [draft.name] }]);
        const trial = await trialOf(proposed, builderId);
        await call(human(builderId), 'confirm_goal', { goalRunId: proposed, revision: 1 });
        expect(await refusal(approve(human(builderId), proposed, trial))).toMatchObject({
          status: 409,
          code: 'illegal_transition',
        });

        // Approved, started, then paused by its requester: that StepRun's trial is spent.
        const goalRunId = await pausedAtDraft(builderId, [{ key: 'a', skills: [draft.name] }]);
        const first = await trialOf(goalRunId, builderId);
        await approve(human(builderId), goalRunId, first);
        await call(human(builderId), 'resume_goal', { goalRunId });
        await advanceOnce(goalRunId, builderId);
        await call(human(builderId), 'pause_goal', { goalRunId });
        expect(await refusal(approve(human(builderId), goalRunId, first))).toMatchObject({
          status: 409,
          code: 'illegal_transition',
        });
        expect(await approvalRows(goalRunId)).toHaveLength(1);
      });
    });

    describe('an approval is never reused (coordinator on GO8b)', () => {
      it('not for another StepRun of the step: a revision that replaces it, with the same WorkerSpec, waits for a person again', async () => {
        const draft = await seedDraft(builderId);
        const goalRunId = await pausedAtDraft(builderId, [{ key: 'a', skills: [draft.name] }]);
        const before = await liveStep(goalRunId);
        const trial = await trialOf(goalRunId, builderId);
        const approved = ApproveStepTrialResultWireSchema.parse(
          await approve(human(builderId), goalRunId, trial),
        );
        // Same WorkerSpec, another input: the StepRun is replaced.
        await call(human(builderId), 'revise_goal', {
          goalRunId,
          basedOnRevision: 1,
          plan: planOf([{ key: 'a', skills: [draft.name], input: { step: 'a', again: true } }]),
        });
        const after = await liveStep(goalRunId);
        expect(after.id).not.toBe(before.id);
        const detail = await getGoal(goalRunId, builderId);
        expect(detail.trialApprovals).toEqual([
          expect.objectContaining({
            id: approved.approvalId,
            state: 'lapsed',
            lapsedBecause: 'step_changed',
          }),
        ]);
        // The new StepRun's trial is hinted again — the same WorkerSpec and drafts.
        expect(await trialOf(goalRunId, builderId)).toEqual(trial);
        await call(human(builderId), 'resume_goal', { goalRunId });
        await advanceOnce(goalRunId, builderId);
        expect(await goalRow(goalRunId)).toMatchObject({
          status: 'paused',
          pause_reason: 'needs_decision',
        });
        expect(await attemptTasks(after.id)).toEqual([]);
        expect(await attemptTasks(before.id)).toEqual([]);

        // Below the gateway: it cannot be pointed at the new StepRun either.
        expect(
          await dbRefusal(
            asApp(builderId, (client) =>
              client.query(
                'update goal_step_trial_approvals set step_run_id = $3 where workspace_id = $1 and id = $2',
                [workspaceId, approved.approvalId, after.id],
              ),
            ),
          ),
        ).toMatch(/one StepRun, ever/);

        // A new approval for the new StepRun starts it.
        await approve(human(builderId), goalRunId, trial);
        await call(human(builderId), 'resume_goal', { goalRunId });
        await advanceOnce(goalRunId, builderId);
        expect(await attemptTasks(after.id)).toHaveLength(1);
      });

      it('not for another WorkerSpec: a revised spec lapses it, and an approval naming another spec is draft_changed', async () => {
        const draft = await seedDraft(builderId);
        const goalRunId = await pausedAtDraft(builderId, [{ key: 'a', skills: [draft.name] }]);
        const trial = await trialOf(goalRunId, builderId);
        await approve(human(builderId), goalRunId, trial);
        await call(human(builderId), 'revise_goal', {
          goalRunId,
          basedOnRevision: 1,
          plan: planOf([
            { key: 'a', skills: [draft.name], instructions: 'Only read; change nothing.' },
          ]),
        });
        const revised = await trialOf(goalRunId, builderId);
        expect(revised.specDigest).not.toBe(trial.specDigest);
        expect(revised.drafts).toEqual(trial.drafts);
        expect((await getGoal(goalRunId, builderId)).trialApprovals).toEqual([
          expect.objectContaining({ state: 'lapsed', lapsedBecause: 'step_changed' }),
        ]);
        // The earlier spec named: refused, nothing written.
        expect(await refusal(approve(human(builderId), goalRunId, trial))).toMatchObject({
          status: 409,
          code: 'draft_changed',
        });
        expect(await approvalRows(goalRunId)).toHaveLength(1);
        await call(human(builderId), 'resume_goal', { goalRunId });
        await advanceOnce(goalRunId, builderId);
        expect(await goalRow(goalRunId)).toMatchObject({ pause_reason: 'needs_decision' });
        expect(await attemptTasks((await liveStep(goalRunId)).id)).toEqual([]);
      });

      it('not after a draft changed: discarded and proposed again under its version, the approval lapses and the step waits', async () => {
        const draft = await seedDraft(builderId);
        const goalRunId = await pausedAtDraft(builderId, [{ key: 'a', skills: [draft.name] }]);
        const trial = await trialOf(goalRunId, builderId);
        await approve(human(builderId), goalRunId, trial);
        await reproposeDraft(draft, builderId);
        const detail = await getGoal(goalRunId, builderId);
        expect(detail.trialApprovals).toEqual([
          expect.objectContaining({ state: 'lapsed', lapsedBecause: 'draft_changed' }),
        ]);
        const now = draftHint(detail, 'a')?.trial;
        expect(now?.drafts[0]?.draftDigest).not.toBe(trial.drafts[0]?.draftDigest);
        expect(await refusal(approve(human(builderId), goalRunId, trial))).toMatchObject({
          status: 409,
          code: 'draft_changed',
        });
        await call(human(builderId), 'resume_goal', { goalRunId });
        await advanceOnce(goalRunId, builderId);
        expect(await goalRow(goalRunId)).toMatchObject({ pause_reason: 'needs_decision' });
        const step = await liveStep(goalRunId);
        expect(await attemptTasks(step.id)).toEqual([]);
        expect(step.attempt_count).toBe(0);
        // Refused by the admission (the draft waits for a person), the approval named as stale —
        // not let in and then refused for a draft it cannot mount (review #493 T10 on #855).
        expect((await pauseDetails(goalRunId)).at(-1)).toMatch(
          /only drafts.*the approval of its trial does not match it any more/,
        );
      });
    });

    describe('a retry mounts exactly what was approved (review #493 on #855)', () => {
      it('not a draft discarded and proposed again under its version, with other content: the retry does not start', async () => {
        const draft = await seedDraft(builderId);
        const { goalRunId, step } = await trialStartedThenLost(draft);
        await reproposeDraft(draft, builderId);
        await advanceOnce(goalRunId, builderId);
        expect(await attemptTasks(step.id)).toHaveLength(1);
        expect(await goalRow(goalRunId)).toMatchObject({
          status: 'paused',
          pause_reason: 'needs_decision',
        });
        expect((await pauseDetails(goalRunId)).at(-1)).toMatch(
          /trial was approved for were changed, discarded or deprecated since/,
        );
      });

      it('a draft published since is mounted again (its content unchanged); deprecated after, it is not', async () => {
        const draft = await seedDraft(builderId);
        const { goalRunId, step, lose } = await trialStartedThenLost(draft);
        await raw(
          `update skills set status = 'published', published_by = $3, published_at = now()
            where workspace_id = $1 and id = $2`,
          [workspaceId, draft.id, ownerId],
        );
        await advanceOnce(goalRunId, builderId);
        const [, second] = await attemptTasks(step.id);
        if (!second) throw new Error('the retry did not start');
        expect(spawnOf(second.id).skillsInline?.map((mount) => mount.name)).toEqual([draft.name]);

        await lose(second.id);
        await raw(`update skills set status = 'deprecated' where workspace_id = $1 and id = $2`, [
          workspaceId,
          draft.id,
        ]);
        await advanceOnce(goalRunId, builderId);
        expect(await attemptTasks(step.id)).toHaveLength(2);
        expect(await goalRow(goalRunId)).toMatchObject({
          status: 'paused',
          pause_reason: 'needs_decision',
        });
      });
    });

    describe('the guard, below the gateway (review #493 on #855)', () => {
      it('an approval made on a proposal names, once, a StepRun of its own run while it runs — the one its confirmation created', async () => {
        const draft = await seedDraft(builderId);
        const goalRunId = await proposeGoal(builderId, [{ key: 'a', skills: [draft.name] }]);
        const approved = ApproveStepTrialResultWireSchema.parse(
          await approve(human(builderId), goalRunId, await trialOf(goalRunId, builderId)),
        );
        await call(human(builderId), 'confirm_goal', { goalRunId, revision: 1 });
        const step = await liveStep(goalRunId);
        const names =
          /names, once, the StepRun of its step that the proposal's confirmation created/;

        // Another run's StepRun, running too.
        const other = await proposeGoal(builderId, [{ key: 'a', skills: [draft.name] }]);
        await call(human(builderId), 'confirm_goal', { goalRunId: other, revision: 1 });
        expect(
          await dbRefusal(nameStepRun(approved.approvalId, (await liveStep(other)).id)),
        ).toMatch(names);

        // Its own StepRun, while the run is paused.
        await call(human(builderId), 'pause_goal', { goalRunId });
        expect(await dbRefusal(nameStepRun(approved.approvalId, step.id))).toMatch(names);

        // A StepRun a revision brought in (the same WorkerSpec, another input), the run running.
        await call(human(builderId), 'revise_goal', {
          goalRunId,
          basedOnRevision: 1,
          plan: planOf([{ key: 'a', skills: [draft.name], input: { step: 'a', again: true } }]),
        });
        const revised = await liveStep(goalRunId);
        expect(revised.id).not.toBe(step.id);
        await call(human(builderId), 'resume_goal', { goalRunId });
        expect(await dbRefusal(nameStepRun(approved.approvalId, revised.id))).toMatch(names);
        // Nor does the advancer take it for that StepRun: the step waits for a person.
        await advanceOnce(goalRunId, builderId);
        expect(await goalRow(goalRunId)).toMatchObject({
          status: 'paused',
          pause_reason: 'needs_decision',
        });
        expect(await attemptTasks(revised.id)).toEqual([]);
        expect(await approvalRows(goalRunId)).toEqual([
          expect.objectContaining({ id: approved.approvalId, step_run_id: null }),
        ]);
      });

      it('on a paused run, a row names the live StepRun of its own run that has not started an attempt', async () => {
        const draft = await seedDraft(builderId);
        const goalRunId = await pausedAtDraft(builderId, [{ key: 'a', skills: [draft.name] }]);
        const trial = await trialOf(goalRunId, builderId);
        const live =
          /a trial is approved for the live StepRun of the step that has not started an attempt/;

        // Another run's StepRun.
        const other = await proposeGoal(builderId, [{ key: 'a', skills: [draft.name] }]);
        await call(human(builderId), 'confirm_goal', { goalRunId: other, revision: 1 });
        expect(
          await dbRefusal(insertApproval(goalRunId, (await liveStep(other)).id, trial)),
        ).toMatch(live);

        // Its own run's StepRun, once an attempt of it started.
        const started = await proposeGoal(builderId, [{ key: 'a' }]);
        await call(human(builderId), 'confirm_goal', { goalRunId: started, revision: 1 });
        await advanceOnce(started, builderId);
        const startedStep = await liveStep(started);
        expect(startedStep.attempt_count).toBe(1);
        await call(human(builderId), 'pause_goal', { goalRunId: started });
        expect(await goalRow(started)).toMatchObject({ status: 'paused' });
        expect(await dbRefusal(insertApproval(started, startedStep.id, trial))).toMatch(live);
        expect(await approvalRows(goalRunId)).toEqual([]);
        expect(await approvalRows(started)).toEqual([]);
      });
    });

    describe('no single trial to approve', () => {
      it('a draft named like a published Skill of another family is no trial: hinted why, approving is 409', async () => {
        const name = `go8b-shared-${randomUUID().slice(0, 8)}`;
        const draft = await seedDraft(builderId, { name });
        const goalRunId = await pausedAtDraft(builderId, [{ key: 'a', skills: [draft.id] }]);
        // Another family publishes under the draft's name since.
        await raw(
          `insert into skills (workspace_id, id, version, status, name, description, markdown,
             proposed_by, published_by, published_at)
           values ($1, $2, 1, 'published', $3, 'a skill', '# Other', $4, $4, now())`,
          [workspaceId, randomUUID(), name, ownerId],
        );
        const hint = draftHint(await getGoal(goalRunId, builderId), 'a');
        expect(hint).toBeDefined();
        expect(hint?.trial).toBeUndefined();
        expect(
          await refusal(
            call(human(builderId), 'approve_step_trial', {
              goalRunId,
              stepKey: 'a',
              specDigest: workerSpecDigest({ skills: [draft.id] }),
              drafts: [{ skillId: draft.id, version: 1, draftDigest: `sha256:${'0'.repeat(64)}` }],
            }),
          ),
        ).toMatchObject({ status: 409, code: 'illegal_transition' });
        expect(await approvalRows(goalRunId)).toEqual([]);
      });
    });
  },
);
