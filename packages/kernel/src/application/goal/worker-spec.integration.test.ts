import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlanHint, TaskFailureReason, WorkerSpec } from '@nexttime/shared';
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
import {
  WORKER_CEILING_CAPABILITIES,
  generateEphemeralHandleKeyPair,
} from '../../governance/capability/index.js';
import { registerGatekeeper } from '../../governance/gatekeepers/index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { STEP_INSTRUCTIONS_MARKER } from '../platform/index.js';
import {
  type RunConfigSnapshot,
  RunConfigSnapshotSchema,
  type TaskRuntimeDeps,
  createStepAttemptTask,
  workerSpecDigest,
} from '../task/index.js';
import { failTaskAndReapWorkerRuns } from '../task/lifecycle.js';
import { readSessionTaskObserveScope } from '../task/observe-scope.js';
import { proposeWorkerDefinition, publishWorkerDefinition } from '../worker/index.js';
import { type GoalAdvancerOptions, advanceGoalRun } from './advance.js';
import { pauseGoalRun, resumeGoalRun } from './control.js';
import { GoalPlanValidationError } from './plan.js';
import { getGoalRun, listStepRuns } from './reads.js';
import { reviseGoalRun } from './revise.js';
import { confirmGoalRun, createGoalRun } from './service.js';
import type { GoalRunBudget, GoalRunRow, StepRunRow } from './types.js';
import { readGoalRunDetail } from './views.js';

/**
 * application/goal/worker-spec (S11 GO8a; plan §3.1, §4.4, I-G8) against real Postgres and the
 * real Task path, with an in-memory worker-supervisor: a step's WorkerSpec — validated with the
 * plan (what it names is there), hinted on the confirmation card and on a paused run, admitted when
 * its first attempt starts (`run` / `needs_approval` / `rejected`), and pinned by digest for every
 * later attempt. The two invariants the coordinator added to GO8a:
 *   1. a WorkerSpec only narrows — what an attempt holds never goes past the Worker ceiling and the
 *      requester's own authority (capabilities, gates, budget alike);
 *   2. a revision that changes a step's WorkerSpec admits it afresh — no earlier verdict carries over.
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
const BASE_PROMPT = 'You do one step of a goal.';

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
      ip: '198.51.100.21',
      startedAt: new Date().toISOString(),
      finishedAt: undefined,
      reason: undefined,
    });
    return { containerId, ip: '198.51.100.21' };
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

interface AttemptTaskRow {
  id: string;
  status: string;
  step_attempt: number;
  run_config_snapshot: unknown;
  token_budget: string | null;
  observe_scope: string[] | null;
}

describe.runIf(DATABASE_URL !== undefined)(
  'application/goal WorkerSpec (S11 GO8a, integration, real Postgres)',
  () => {
    let pool: Pool;
    let privateKey: Awaited<ReturnType<typeof generateEphemeralHandleKeyPair>>['privateKey'];
    let workspaceId: string;
    let ownerId: string;
    let worker: { definitionId: string; version: number };
    const supervisor = new FakeTaskSupervisorClient();
    const startErrors: unknown[] = [];

    const taskRuntime = (): TaskRuntimeDeps => ({
      pool,
      privateKey,
      supervisorClient: supervisor,
    });

    const admin = <T>(fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId, principalId: ownerId }, fn, { skipRoleSwitch: true });
    const asRequester = <T>(requesterId: string, fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId, principalId: requesterId }, fn);
    const by = (principalId: string) => ({ principalId, role: 'member' as const });

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

    async function newGate(grantTo: readonly string[] = []): Promise<string> {
      return admin(async (client) => {
        const activity = await startActivity(client, workspaceId, {
          kind: 'test.connection',
          principalId: ownerId,
        });
        const registered = await registerGatekeeper(client, workspaceId, {
          name: `go8-gate-${randomUUID().slice(0, 8)}`,
          transportKind: 'http',
          target: 'example-system',
          endpoint: 'http://127.0.0.1:9',
          connectionSecretSalt: 'go8-salt',
          activityId: activity.id,
          registeredBy: { id: ownerId, kind: 'human' },
        });
        for (const principal of grantTo) await grantGate(principal, registered.gatekeeperId);
        return registered.gatekeeperId;
      });
    }

    const grantGate = (principalId: string, gatekeeperId: string) =>
      admin((client) =>
        client.query(
          `insert into capability_grants (workspace_id, principal_id, resource_type, resource_id, granted_by)
           values ($1, $2, 'gatekeeper', $3::uuid, $4)`,
          [workspaceId, principalId, gatekeeperId, ownerId],
        ),
      );

    const revokeGrants = (principalId: string) =>
      admin((client) =>
        client.query(
          `update capability_grants set status = 'revoked', revoked_at = now()
            where workspace_id = $1 and principal_id = $2`,
          [workspaceId, principalId],
        ),
      );

    /** A Skill version written as it is (`status`), its name unique to the test. */
    async function seedSkill(
      status: 'draft' | 'published' | 'deprecated',
      proposedBy: string = ownerId,
      skill: { readonly id?: string; readonly name?: string; readonly version?: number } = {},
    ): Promise<{ id: string; name: string }> {
      const id = skill.id ?? randomUUID();
      const name = skill.name ?? `go8-skill-${randomUUID().slice(0, 8)}`;
      await admin((client) =>
        client.query(
          `insert into skills (workspace_id, id, version, status, name, description, markdown,
             proposed_by, published_by, published_at)
           values ($1, $2, $3, $4, $5, 'a skill', '# Do it', $6, $7, $8)`,
          [
            workspaceId,
            id,
            skill.version ?? 1,
            status,
            name,
            proposedBy,
            status === 'draft' ? null : ownerId,
            status === 'draft' ? null : new Date(),
          ],
        ),
      );
      return { id, name };
    }

    const setAllowedModels = (models: readonly string[], defaultModel: string | null) =>
      admin((client) =>
        client.query(
          `insert into agent_policies (workspace_id, allowed_models, default_model, updated_by)
           values ($1, $2::jsonb, $3, $4)
           on conflict (workspace_id) do update
             set allowed_models = excluded.allowed_models, default_model = excluded.default_model`,
          [workspaceId, JSON.stringify(models), defaultModel, ownerId],
        ),
      );

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

    interface StepOf {
      readonly key: string;
      readonly spec?: WorkerSpec;
      readonly dependsOn?: readonly string[];
    }

    const planOf = (steps: readonly StepOf[]) => ({
      steps: steps.map((step) => ({
        key: step.key,
        worker,
        input: { step: step.key },
        ...(step.spec !== undefined ? { spec: step.spec } : {}),
        ...(step.dependsOn ? { dependsOn: step.dependsOn } : {}),
      })),
    });

    const propose = (
      requesterId: string,
      steps: readonly StepOf[],
      modelCatalog?: () => Promise<ReadonlySet<string>>,
    ) =>
      asRequester(requesterId, (client) =>
        createGoalRun(client, workspaceId, {
          requesterId,
          proposedBy: requesterId,
          statement: 'reach the goal with a composed Worker',
          plan: planOf(steps),
          budget: BUDGET,
          ...(modelCatalog ? { modelCatalog } : {}),
        }),
      );

    async function startGoal(requesterId: string, steps: readonly StepOf[]): Promise<string> {
      const { goalRunId } = await propose(requesterId, steps);
      await asRequester(requesterId, (client) =>
        confirmGoalRun(client, workspaceId, { goalRunId, revision: 1, confirmedBy: requesterId }),
      );
      return goalRunId;
    }

    /** One advance; `catalog`: the llm-proxy catalog the attempts check a WorkerSpec model
     *  against (absent: not checked). */
    const advance = (goalRunId: string, requesterId: string, catalog?: readonly string[]) =>
      advanceGoalRun(
        {
          pool,
          taskRuntime: taskRuntime(),
          options: NO_BACKOFF,
          onStartError: (err) => startErrors.push(err),
          ...(catalog ? { modelCatalog: async () => new Set(catalog) } : {}),
        },
        { workspaceId, goalRunId, requesterId },
      );

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

    const stepOf = async (goalRunId: string, key: string): Promise<StepRunRow> => {
      const step = (await stepsOf(goalRunId))[key];
      if (!step) throw new Error(`goal run ${goalRunId} has no live step ${key}`);
      return step;
    };

    const attemptTasks = (stepRunId: string) =>
      admin(async (client) => {
        const result = await client.query<AttemptTaskRow>(
          `select id, status, step_attempt, run_config_snapshot, token_budget, observe_scope
             from tasks
            where workspace_id = $1 and step_run_id = $2 and step_attempt is not null
            order by step_attempt`,
          [workspaceId, stepRunId],
        );
        return result.rows;
      });

    async function latestAttempt(stepRunId: string): Promise<AttemptTaskRow> {
      const tasks = await attemptTasks(stepRunId);
      const latest = tasks[tasks.length - 1];
      if (!latest) throw new Error(`step ${stepRunId} has no attempt Task`);
      return latest;
    }

    const snapshotOf = (task: AttemptTaskRow): RunConfigSnapshot =>
      RunConfigSnapshotSchema.parse(task.run_config_snapshot);

    const failStep = async (stepRunId: string, requesterId: string, reason: TaskFailureReason) => {
      const task = await latestAttempt(stepRunId);
      await failTaskAndReapWorkerRuns(taskRuntime(), workspaceId, requesterId, task.id, reason);
      return task.id;
    };

    const spawnOf = (taskId: string): TaskSpawnInput => {
      const call = supervisor.spawnCalls.find((input) => input.taskId === taskId);
      if (!call) throw new Error(`no spawn for Task ${taskId}`);
      return call;
    };

    const detailHints = async (
      goalRunId: string,
      requesterId: string,
      catalog?: readonly string[],
    ) =>
      (
        await asRequester(requesterId, (client) =>
          readGoalRunDetail(
            client,
            workspaceId,
            { principalId: requesterId, seesEveryRun: false },
            goalRunId,
            catalog ? { modelCatalog: async () => new Set(catalog) } : {},
          ),
        )
      ).planRevision.hints;

    const stepHints = (hints: readonly PlanHint[]) => hints.filter((hint) => hint.stepKey);

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
            'go8-worker-spec',
          ]);
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'owner', 'owner')",
            [workspaceId, ownerId],
          );
        },
        { skipRoleSwitch: true },
      );
      worker = await publish({ systemPrompt: BASE_PROMPT });
    });

    afterAll(async () => {
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

    // -------------------------------------------------------------------------------------------

    describe('the plan names only what is there (400 with the plan)', () => {
      it('refuses each field that names nothing, every problem at once', async () => {
        const requester = await newPrincipal();
        const someoneElse = await newPrincipal();
        const othersDraft = await seedSkill('draft', someoneElse);
        const unknownGate = randomUUID();
        const unknownScope = randomUUID();
        const refused = propose(
          requester,
          [
            {
              key: 'a',
              spec: {
                capabilities: ['propose_goal', 'observe_operation'],
                gates: [unknownGate],
                observeScope: [unknownScope],
                skills: ['no-such-skill', othersDraft.name],
                model: 'nowhere/none',
              },
            },
          ],
          async () => new Set(['p/m1']),
        );
        await expect(refused).rejects.toBeInstanceOf(GoalPlanValidationError);
        const problems = await refused.catch((err: GoalPlanValidationError) => err.problems);
        expect(problems).toEqual([
          'step "a": spec: capabilities a Worker can never hold: "propose_goal"',
          `step "a": spec: gates — Gatekeepers this workspace does not have: "${unknownGate}"`,
          `step "a": spec: observeScope — Gatekeepers this workspace does not have: "${unknownScope}"`,
          `step "a": spec: skills that are not there: "no-such-skill", "${othersDraft.name}"`,
          'step "a": spec: model — one the llm-proxy catalog does not offer: "nowhere/none"',
        ]);
      });

      it('refuses a WorkerSpec that sets nothing, and leaves the model unchecked without a catalog', async () => {
        const requester = await newPrincipal();
        await expect(propose(requester, [{ key: 'a', spec: {} }])).rejects.toBeInstanceOf(
          GoalPlanValidationError,
        );
        const created = await propose(requester, [{ key: 'a', spec: { model: 'any/model' } }]);
        expect(created.status).toBe('proposed');
      });

      it('takes a draft the requester may see and a deprecated Skill: those are the admission’s', async () => {
        const requester = await newPrincipal();
        const ownDraft = await seedSkill('draft', requester);
        const deprecated = await seedSkill('deprecated');
        const created = await propose(requester, [
          { key: 'a', spec: { skills: [ownDraft.name, deprecated.id] } },
        ]);
        expect(stepHints(created.hints).map((hint) => [hint.code, hint.skillRefs])).toEqual([
          ['step_skill_deprecated', [deprecated.id]],
          ['step_skill_draft', [ownDraft.name]],
        ]);
      });
    });

    describe('the confirmation card hints what the admission would say', () => {
      it('one hint per reason, gates and capabilities as the requester’s authority', async () => {
        const requester = await newPrincipal();
        const held = await newGate([requester]);
        const notHeld = await newGate();
        const draft = await seedSkill('draft', requester);
        await setAllowedModels(['p/allowed'], 'p/allowed');
        try {
          const created = await propose(requester, [
            { key: 'ok', spec: { gates: [held], capabilities: ['request_action'] } },
            { key: 'gate', spec: { gates: [notHeld], capabilities: ['request_action'] } },
            { key: 'draft', spec: { skills: [draft.id] } },
            { key: 'model', spec: { model: 'p/other' } },
          ]);
          expect(
            stepHints(created.hints).map((hint) => ({
              code: hint.code,
              stepKey: hint.stepKey,
              ...(hint.gatekeeperIds ? { gatekeeperIds: hint.gatekeeperIds } : {}),
              ...(hint.skillRefs ? { skillRefs: hint.skillRefs } : {}),
              ...(hint.model ? { model: hint.model } : {}),
            })),
          ).toEqual([
            { code: 'step_gate_not_held', stepKey: 'gate', gatekeeperIds: [notHeld] },
            { code: 'step_skill_draft', stepKey: 'draft', skillRefs: [draft.id] },
            { code: 'step_model_not_allowed', stepKey: 'model', model: 'p/other' },
          ]);
        } finally {
          await setAllowedModels([], null);
        }
      });

      it('an execute-class capability the requester does not hold', async () => {
        // No gate granted: nothing delegates `request_action` to the requester's Workers.
        const requester = await newPrincipal();
        const created = await propose(requester, [
          { key: 'a', spec: { capabilities: ['request_action'] } },
        ]);
        expect(stepHints(created.hints)).toEqual([
          expect.objectContaining({
            code: 'step_capability_not_held',
            stepKey: 'a',
            capabilityNames: ['request_action'],
          }),
        ]);
      });
    });

    describe('admission when the first attempt starts', () => {
      it('run: the WorkerSpec composes the attempt, snapshot v2 pins it, a retry reuses it', async () => {
        const requester = await newPrincipal();
        const gate = await newGate([requester]);
        const skill = await seedSkill('published');
        const spec: WorkerSpec = {
          instructions: 'Check the backups only; report what is missing.',
          skills: [skill.name],
          gates: [gate],
          capabilities: ['request_action', 'find_workers', 'invoke_worker', 'observe_operation'],
          model: 'p/m1',
          observeScope: [gate],
          tokenBudget: 5000,
        };
        const goalRunId = await startGoal(requester, [{ key: 'a', spec }]);
        await advance(goalRunId, requester);
        expect(startErrors).toEqual([]);
        const stepA = await stepOf(goalRunId, 'a');
        const first = await latestAttempt(stepA.id);
        const snapshot = snapshotOf(first);
        if (snapshot.v !== 2) throw new Error('the advancer writes snapshot version 2');
        expect(snapshot).toMatchObject({
          v: 2,
          definition: { id: worker.definitionId, version: worker.version },
          skills: [{ skillId: skill.id, version: 1 }],
          model: 'p/m1',
          spec: { digest: workerSpecDigest(spec) },
          handle: { gatekeepers: [gate] },
        });
        // Invariant 1 — only narrows: within the Worker ceiling and the requester's scope; the
        // derivation capabilities stay out without `nested`; the budget is the least of the caps.
        const ceiling = new Set(WORKER_CEILING_CAPABILITIES);
        for (const name of snapshot.handle.capabilities) expect(ceiling.has(name)).toBe(true);
        expect(snapshot.handle.capabilities).toContain('request_action');
        expect(snapshot.handle.capabilities).not.toContain('invoke_worker');
        expect(snapshot.handle.capabilities).not.toContain('find_workers');
        expect(snapshot.budget.tokenBudget).toBe(5000);
        expect(Number(first.token_budget)).toBe(5000);
        // GO11: the Task observes only through its WorkerSpec's scope.
        expect(first.observe_scope).toEqual([gate]);
        const call = spawnOf(first.id);
        expect(call.model).toBe('p/m1');
        expect(call.skillsInline?.map((mount) => mount.name)).toEqual([skill.name]);
        expect(call.systemPrompt).toBe(
          `${BASE_PROMPT}\n\n${STEP_INSTRUCTIONS_MARKER}\n${spec.instructions}`,
        );
        const sessionScope = await admin(async (client) => {
          const run = await client.query<{ session_id: string }>(
            'select session_id from worker_runs where workspace_id = $1 and task_id = $2',
            [workspaceId, first.id],
          );
          return readSessionTaskObserveScope(client, workspaceId, run.rows[0]?.session_id);
        });
        expect(sessionScope).toEqual({ taskId: first.id, gatekeeperIds: [gate] });

        // A newer published version of the Skill does not reach the retry: it is pinned.
        await seedSkill('published', ownerId, { id: skill.id, name: skill.name, version: 2 });
        await failStep(stepA.id, requester, 'spawn_lost');
        await advance(goalRunId, requester);
        const retried = await latestAttempt(stepA.id);
        expect(retried.step_attempt).toBe(2);
        expect(snapshotOf(retried)).toMatchObject({
          v: 2,
          skills: [{ skillId: skill.id, version: 1 }],
          model: 'p/m1',
          spec: { digest: workerSpecDigest(spec) },
        });
        expect(retried.observe_scope).toEqual([gate]);
      });

      it('a Skill with a published version and a newer draft is published: no hint, the published one mounts', async () => {
        const requester = await newPrincipal();
        const skill = await seedSkill('published');
        await seedSkill('draft', requester, { id: skill.id, name: skill.name, version: 2 });
        const created = await propose(requester, [{ key: 'a', spec: { skills: [skill.name] } }]);
        expect(stepHints(created.hints)).toEqual([]);
        await asRequester(requester, (client) =>
          confirmGoalRun(client, workspaceId, {
            goalRunId: created.goalRunId,
            revision: 1,
            confirmedBy: requester,
          }),
        );
        await advance(created.goalRunId, requester);
        const task = await latestAttempt((await stepOf(created.goalRunId, 'a')).id);
        expect(snapshotOf(task).skills).toEqual([{ skillId: skill.id, version: 1 }]);
        expect(spawnOf(task.id).skillsInline?.map((mount) => mount.name)).toEqual([skill.name]);
      });

      it('the WorkerSpec budget never lifts the goal’s cap', async () => {
        const requester = await newPrincipal();
        const { goalRunId } = await asRequester(requester, (client) =>
          createGoalRun(client, workspaceId, {
            requesterId: requester,
            proposedBy: requester,
            statement: 'a small goal',
            plan: planOf([{ key: 'a', spec: { tokenBudget: 9_000_000 } }]),
            budget: { ...BUDGET, maxTokens: 2000 },
          }),
        );
        await asRequester(requester, (client) =>
          confirmGoalRun(client, workspaceId, { goalRunId, revision: 1, confirmedBy: requester }),
        );
        await advance(goalRunId, requester);
        const task = await latestAttempt((await stepOf(goalRunId, 'a')).id);
        expect(Number(task.token_budget)).toBeLessThanOrEqual(2000);
        expect(snapshotOf(task).budget.tokenBudget).toBeLessThanOrEqual(2000);
      });

      it('needs_approval: a draft Skill pauses the run needs_decision before any Task, and the pause says why', async () => {
        const requester = await newPrincipal();
        const draft = await seedSkill('draft', requester);
        const goalRunId = await startGoal(requester, [
          { key: 'a', spec: { skills: [draft.name] } },
        ]);
        const spawned = supervisor.spawnCalls.length;
        const outcome = await advance(goalRunId, requester);
        expect(outcome).toMatchObject({ status: 'paused', nextTickAt: null });
        expect(await goalOf(goalRunId)).toMatchObject({
          status: 'paused',
          pauseReason: 'needs_decision',
        });
        const stepA = await stepOf(goalRunId, 'a');
        expect(stepA).toMatchObject({ status: 'ready', attemptCount: 0 });
        expect(await attemptTasks(stepA.id)).toEqual([]);
        expect(supervisor.spawnCalls).toHaveLength(spawned);
        expect(stepHints(await detailHints(goalRunId, requester))).toEqual([
          expect.objectContaining({
            code: 'step_skill_draft',
            stepKey: 'a',
            skillRefs: [draft.name],
          }),
        ]);
        // Resuming changes nothing on its own: the platform never approves the draft by itself.
        await asRequester(requester, (client) =>
          resumeGoalRun(client, workspaceId, { goalRunId, actor: by(requester) }),
        );
        await advance(goalRunId, requester);
        expect(await goalOf(goalRunId)).toMatchObject({ pauseReason: 'needs_decision' });
        expect(await attemptTasks(stepA.id)).toEqual([]);
      });

      it('rejected: a deprecated Skill or a model the workspace does not allow pauses needs_decision', async () => {
        const requester = await newPrincipal();
        const deprecated = await seedSkill('deprecated');
        const deprecatedRun = await startGoal(requester, [
          { key: 'a', spec: { skills: [deprecated.name] } },
        ]);
        await advance(deprecatedRun, requester);
        expect(await goalOf(deprecatedRun)).toMatchObject({ pauseReason: 'needs_decision' });
        expect(await attemptTasks((await stepOf(deprecatedRun, 'a')).id)).toEqual([]);

        const modelRun = await startGoal(requester, [{ key: 'a', spec: { model: 'p/other' } }]);
        await setAllowedModels(['p/allowed'], 'p/allowed');
        try {
          await advance(modelRun, requester);
          expect(await goalOf(modelRun)).toMatchObject({ pauseReason: 'needs_decision' });
          expect(await attemptTasks((await stepOf(modelRun, 'a')).id)).toEqual([]);
          expect(stepHints(await detailHints(modelRun, requester))).toEqual([
            expect.objectContaining({
              code: 'step_model_not_allowed',
              stepKey: 'a',
              model: 'p/other',
            }),
          ]);
        } finally {
          await setAllowedModels([], null);
        }
      });

      it('rejected: a gate the requester cannot act on pauses authority_lost — and so does one revoked after confirming', async () => {
        const requester = await newPrincipal();
        const notHeld = await newGate();
        const neverHeld = await startGoal(requester, [
          { key: 'a', spec: { gates: [notHeld], capabilities: ['request_action'] } },
        ]);
        await advance(neverHeld, requester);
        expect(await goalOf(neverHeld)).toMatchObject({ pauseReason: 'authority_lost' });
        expect(await attemptTasks((await stepOf(neverHeld, 'a')).id)).toEqual([]);

        const held = await newGate([requester]);
        const revokedRun = await startGoal(requester, [
          { key: 'a', spec: { gates: [held], capabilities: ['request_action'] } },
        ]);
        await revokeGrants(requester);
        await advance(revokedRun, requester);
        expect(await goalOf(revokedRun)).toMatchObject({ pauseReason: 'authority_lost' });
        const stepA = await stepOf(revokedRun, 'a');
        expect(await attemptTasks(stepA.id)).toEqual([]);
        expect(stepHints(await detailHints(revokedRun, requester))).toEqual([
          expect.objectContaining({
            code: 'step_gate_not_held',
            stepKey: 'a',
            gatekeeperIds: [held],
          }),
        ]);
      });

      it('a step without a WorkerSpec runs as before, under snapshot v2 with no spec', async () => {
        const requester = await newPrincipal();
        const goalRunId = await startGoal(requester, [{ key: 'a' }]);
        await advance(goalRunId, requester);
        const task = await latestAttempt((await stepOf(goalRunId, 'a')).id);
        expect(snapshotOf(task)).toMatchObject({ v: 2, spec: null });
        expect(task.observe_scope).toBeNull();
        expect(spawnOf(task.id).systemPrompt).toBe(BASE_PROMPT);
      });
    });

    describe('every attempt: what the workspace allows now (review #493 on #853)', () => {
      it('a retry is refused for a model the workspace stopped allowing, and the pause says which step', async () => {
        const requester = await newPrincipal();
        const goalRunId = await startGoal(requester, [{ key: 'a', spec: { model: 'p/m1' } }]);
        await advance(goalRunId, requester);
        const stepA = await stepOf(goalRunId, 'a');
        const first = await latestAttempt(stepA.id);
        expect(spawnOf(first.id).model).toBe('p/m1');

        await setAllowedModels(['p/allowed'], 'p/allowed');
        try {
          const spawned = supervisor.spawnCalls.length;
          await failStep(stepA.id, requester, 'spawn_lost');
          await advance(goalRunId, requester);
          expect(await goalOf(goalRunId)).toMatchObject({
            status: 'paused',
            pauseReason: 'needs_decision',
          });
          expect(await stepOf(goalRunId, 'a')).toMatchObject({ status: 'ready', attemptCount: 1 });
          expect(await attemptTasks(stepA.id)).toHaveLength(1);
          expect(supervisor.spawnCalls).toHaveLength(spawned);
          // The step waits to be tried again: hinted as that attempt is admitted.
          expect(stepHints(await detailHints(goalRunId, requester))).toEqual([
            expect.objectContaining({
              code: 'step_model_not_allowed',
              stepKey: 'a',
              model: 'p/m1',
            }),
          ]);

          // Allowed again, the retry starts with the model it was admitted with.
          await setAllowedModels(['p/allowed', 'p/m1'], 'p/allowed');
          await asRequester(requester, (client) =>
            resumeGoalRun(client, workspaceId, { goalRunId, actor: by(requester) }),
          );
          await advance(goalRunId, requester);
          const retried = await latestAttempt(stepA.id);
          expect(retried.step_attempt).toBe(2);
          expect(spawnOf(retried.id).model).toBe('p/m1');
        } finally {
          await setAllowedModels([], null);
        }
      });
    });

    describe('the model as the llm-proxy catalog offers it now (coordinator on #853)', () => {
      it('with no allowedModels, a model the catalog does not offer is refused when the first attempt starts', async () => {
        const requester = await newPrincipal();
        const goalRunId = await startGoal(requester, [{ key: 'a', spec: { model: 'p/gone' } }]);
        const spawned = supervisor.spawnCalls.length;
        await advance(goalRunId, requester, ['p/m1']);
        expect(await goalOf(goalRunId)).toMatchObject({
          status: 'paused',
          pauseReason: 'needs_decision',
        });
        expect(await attemptTasks((await stepOf(goalRunId, 'a')).id)).toEqual([]);
        expect(supervisor.spawnCalls).toHaveLength(spawned);
        expect(stepHints(await detailHints(goalRunId, requester, ['p/m1']))).toEqual([
          expect.objectContaining({
            code: 'step_model_not_offered',
            stepKey: 'a',
            model: 'p/gone',
          }),
        ]);
      });

      it('a retry is refused once the catalog drops the model — not offered comes before not allowed', async () => {
        const requester = await newPrincipal();
        const goalRunId = await startGoal(requester, [{ key: 'a', spec: { model: 'p/m1' } }]);
        await advance(goalRunId, requester, ['p/m1']);
        const stepA = await stepOf(goalRunId, 'a');
        expect(await attemptTasks(stepA.id)).toHaveLength(1);
        await setAllowedModels(['p/allowed'], 'p/allowed');
        try {
          await failStep(stepA.id, requester, 'spawn_lost');
          await advance(goalRunId, requester, ['p/allowed']);
          expect(await goalOf(goalRunId)).toMatchObject({ pauseReason: 'needs_decision' });
          expect(await attemptTasks(stepA.id)).toHaveLength(1);
          expect(stepHints(await detailHints(goalRunId, requester, ['p/allowed']))).toEqual([
            expect.objectContaining({ code: 'step_model_not_offered', model: 'p/m1' }),
          ]);
        } finally {
          await setAllowedModels([], null);
        }
      });
    });

    describe('which steps a read of the run hints', () => {
      it('none while the run is running; once paused, only the steps whose attempt has not started', async () => {
        const requester = await newPrincipal();
        const gate = await newGate([requester]);
        const spec: WorkerSpec = { gates: [gate], capabilities: ['request_action'] };
        const goalRunId = await startGoal(requester, [
          { key: 'a', spec },
          { key: 'b', spec, dependsOn: ['a'] },
        ]);
        await advance(goalRunId, requester);
        expect(await stepOf(goalRunId, 'a')).toMatchObject({ status: 'running', attemptCount: 1 });
        expect(await stepOf(goalRunId, 'b')).toMatchObject({ status: 'pending', attemptCount: 0 });

        await revokeGrants(requester);
        expect(await goalOf(goalRunId)).toMatchObject({ status: 'running' });
        expect(stepHints(await detailHints(goalRunId, requester))).toEqual([]);

        await asRequester(requester, (client) =>
          pauseGoalRun(client, workspaceId, { goalRunId, actor: by(requester) }),
        );
        expect(stepHints(await detailHints(goalRunId, requester))).toEqual([
          expect.objectContaining({
            code: 'step_gate_not_held',
            stepKey: 'b',
            gatekeeperIds: [gate],
          }),
        ]);
      });
    });

    describe('invariant 2: a revision that changes a WorkerSpec is admitted afresh', () => {
      it('a step revised to name a draft Skill does not start, though its earlier attempt ran', async () => {
        const requester = await newPrincipal();
        const published = await seedSkill('published');
        const draft = await seedSkill('draft', requester);
        const before: WorkerSpec = { skills: [published.name] };
        const goalRunId = await startGoal(requester, [{ key: 'a', spec: before }]);
        await advance(goalRunId, requester);
        const firstStep = await stepOf(goalRunId, 'a');
        expect(snapshotOf(await latestAttempt(firstStep.id))).toMatchObject({
          spec: { digest: workerSpecDigest(before) },
        });
        await failStep(firstStep.id, requester, 'worker_failed');

        await asRequester(requester, (client) =>
          pauseGoalRun(client, workspaceId, { goalRunId, actor: by(requester) }),
        );
        const revised = await asRequester(requester, (client) =>
          reviseGoalRun(client, workspaceId, {
            goalRunId,
            actor: by(requester),
            basedOnRevision: 1,
            plan: planOf([{ key: 'a', spec: { skills: [published.name, draft.name] } }]),
          }),
        );
        expect(revised.supersededStepRunIds).toEqual([firstStep.id]);
        expect(stepHints(revised.hints)).toEqual([
          expect.objectContaining({
            code: 'step_skill_draft',
            stepKey: 'a',
            skillRefs: [draft.name],
          }),
        ]);
        await asRequester(requester, (client) =>
          resumeGoalRun(client, workspaceId, { goalRunId, actor: by(requester) }),
        );
        await advance(goalRunId, requester);
        const secondStep = await stepOf(goalRunId, 'a');
        expect(secondStep.id).not.toBe(firstStep.id);
        expect(secondStep).toMatchObject({ status: 'ready', attemptCount: 0 });
        expect(await attemptTasks(secondStep.id)).toEqual([]);
        expect(await goalOf(goalRunId)).toMatchObject({ pauseReason: 'needs_decision' });
      });

      it('a step revised to another admissible WorkerSpec starts at attempt 1 with the new digest', async () => {
        const requester = await newPrincipal();
        const before: WorkerSpec = { tokenBudget: 4000 };
        const after: WorkerSpec = { tokenBudget: 3000, instructions: 'Narrower now.' };
        const goalRunId = await startGoal(requester, [{ key: 'a', spec: before }]);
        await advance(goalRunId, requester);
        const firstStep = await stepOf(goalRunId, 'a');
        await failStep(firstStep.id, requester, 'worker_failed');
        await asRequester(requester, (client) =>
          pauseGoalRun(client, workspaceId, { goalRunId, actor: by(requester) }),
        );
        await asRequester(requester, (client) =>
          reviseGoalRun(client, workspaceId, {
            goalRunId,
            actor: by(requester),
            basedOnRevision: 1,
            plan: planOf([{ key: 'a', spec: after }]),
          }),
        );
        await asRequester(requester, (client) =>
          resumeGoalRun(client, workspaceId, { goalRunId, actor: by(requester) }),
        );
        await advance(goalRunId, requester);
        const secondStep = await stepOf(goalRunId, 'a');
        const task = await latestAttempt(secondStep.id);
        expect(task.step_attempt).toBe(1);
        expect(snapshotOf(task)).toMatchObject({
          spec: { digest: workerSpecDigest(after) },
          budget: { tokenBudget: 3000 },
        });
      });

      it('a later attempt never starts from a snapshot admitted for another WorkerSpec', async () => {
        const requester = await newPrincipal();
        const goalRunId = await startGoal(requester, [{ key: 'a', spec: { tokenBudget: 4000 } }]);
        await advance(goalRunId, requester);
        const stepA = await stepOf(goalRunId, 'a');
        const previous = snapshotOf(await latestAttempt(stepA.id));
        const attempt = (spec: WorkerSpec | null, from: RunConfigSnapshot) =>
          asRequester(requester, (client) =>
            createStepAttemptTask(client, workspaceId, requester, {
              goalRunId,
              stepRunId: stepA.id,
              planRevision: 1,
              stepAttempt: 2,
              worker,
              spec,
              input: null,
              nested: false,
              outputSchema: null,
              reworkOf: null,
              previous: from,
              tokenCap: null,
              durationCapSec: 60,
            }),
          );
        const changed = await attempt({ tokenBudget: 3000 }, previous);
        expect(changed).toMatchObject({
          kind: 'refused',
          refusal: { kind: 'unavailable', reason: 'spec' },
        });
        // A version 1 snapshot was admitted with no WorkerSpec at all.
        const { spec: _spec, ...rest } = previous as Extract<RunConfigSnapshot, { v: 2 }>;
        const v1 = { ...rest, v: 1 as const };
        expect(await attempt({ tokenBudget: 4000 }, v1)).toMatchObject({
          kind: 'refused',
          refusal: { kind: 'unavailable', reason: 'spec' },
        });
        expect(await attemptTasks(stepA.id)).toHaveLength(1);
      });
    });
  },
);
