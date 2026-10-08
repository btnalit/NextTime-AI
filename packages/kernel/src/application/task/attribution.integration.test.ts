import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CapabilityScope, HandleClaims } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import type {
  TaskSpawnInput,
  TaskSpawnOutcome,
  TaskSupervisorClientPort,
  TaskSupervisorStatus,
} from '../../adapters/supervisor-client/index.js';
import {
  type IssuedHandle,
  entryScope,
  generateEphemeralHandleKeyPair,
  issueHandle,
} from '../../governance/capability/index.js';
import {
  deprecateSkill,
  proposeProcedure,
  proposeSkill,
  proposeWorkerDefinition,
  publishProcedure,
  publishSkill,
  publishWorkerDefinition,
} from '../worker/index.js';
import {
  ObjectiveOutcomeConflictError,
  ObjectiveOutcomeForbiddenError,
  listChatTurns,
  markTurnOutcome,
  readTaskAttributions,
  recordProcedureFollowed,
  reportTaskOutcome,
} from './attribution.js';
import { invokeWorker } from './invoke.js';
import { reactToSupervisorStatus, readTaskRow } from './lifecycle.js';
import type { TaskRuntimeDeps } from './runtime.js';

/**
 * application/task/attribution.integration.test: DB-gated (real Postgres; auto-skip without
 * DATABASE_URL) tests for S10 E1 结果归因 (docs/s10-evolution-plan-2026-10-04.md §5.3 验收:
 * "新 Task 在读模型里能查到 WorkerDefinition / Skill 版本，所属 Turn 的 Procedure 与目标结果；旧数据
 * 保持 null，读模型如实显示'未记录'"). Same fake supervisor shape as invoke.integration.test.ts.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

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
      ip: '198.51.100.10',
      startedAt: new Date().toISOString(),
      finishedAt: undefined,
      reason: undefined,
    });
    return { containerId, ip: '198.51.100.10' };
  }

  async terminate(): Promise<boolean> {
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

describe.runIf(DATABASE_URL !== undefined)(
  'S10 E1 attribution — integration (real Postgres)',
  () => {
    let pool: Pool;
    let privateKey: Awaited<ReturnType<typeof generateEphemeralHandleKeyPair>>['privateKey'];
    let workspaceId: string;
    let ownerId: string;
    let memberId: string;
    let skillId: string;
    let workerDefinitionId: string;
    let procedureId: string;

    async function adminInsertPrincipal(role: string, displayName: string): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: id },
        (client) =>
          client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', $3, $4)",
            [workspaceId, id, role, displayName],
          ),
        { skipRoleSwitch: true },
      );
      return id;
    }

    function inTx<T>(principalId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId }, fn);
    }

    async function entryClaims(principalId: string): Promise<HandleClaims> {
      const sessionId = await inTx(principalId, async (client) => {
        const result = await client.query<{ id: string }>(
          `insert into sessions (workspace_id, principal_id, kind, on_behalf_of, status)
         values ($1, $2, 'entry', $2, 'active') returning id`,
          [workspaceId, principalId],
        );
        return result.rows[0]?.id as string;
      });
      return claimsOf(
        await inTx(principalId, (client) =>
          issueHandle(client, { sessionId, scope: entryScope(), ttlSeconds: 3600, privateKey }),
        ),
      );
    }

    function claimsOf(issued: IssuedHandle): HandleClaims {
      return {
        ws: issued.workspaceId,
        sid: issued.sessionId,
        obo: issued.onBehalfOf,
        scope: issued.scope as CapabilityScope,
        jti: issued.jti,
        iat: Math.floor(issued.issuedAt.getTime() / 1000),
        exp: Math.floor(issued.expiresAt.getTime() / 1000),
        ...(issued.parentJti !== undefined ? { par: issued.parentJti } : {}),
      };
    }

    /** A Chat of `principalId` with one Turn in `status`, started by `principalId`. */
    async function insertTurn(
      principalId: string,
      status: 'running' | 'completed' = 'completed',
      visibility: 'private' | 'workspace' = 'private',
    ): Promise<{ chatId: string; turnId: string }> {
      return inTx(principalId, async (client) => {
        const chat = await client.query<{ id: string }>(
          `insert into chats (workspace_id, owner_principal_id, visibility) values ($1, $2, $3)
         returning id`,
          [workspaceId, principalId, visibility],
        );
        const chatId = chat.rows[0]?.id as string;
        const turn = await client.query<{ id: string }>(
          `insert into activities (workspace_id, kind, chat_id, status, started_by, ended_at)
         values ($1, 'agent_turn', $2, $3, $4, case when $3 = 'running' then null else now() end)
         returning id`,
          [workspaceId, chatId, status, principalId],
        );
        return { chatId, turnId: turn.rows[0]?.id as string };
      });
    }

    function deps(supervisorClient: FakeTaskSupervisorClient): TaskRuntimeDeps {
      return { pool, privateKey, supervisorClient };
    }

    async function finishTask(taskId: string): Promise<void> {
      await inTx(ownerId, (client) =>
        client.query(
          `update tasks set status = 'completed', completed_at = now()
         where workspace_id = $1 and id = $2`,
          [workspaceId, taskId],
        ),
      );
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      privateKey = (await generateEphemeralHandleKeyPair()).privateKey;
      workspaceId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: randomUUID() },
        (client) =>
          client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'attribution-integration-test',
          ]),
        { skipRoleSwitch: true },
      );
      ownerId = await adminInsertPrincipal('owner', 'owner');
      memberId = await adminInsertPrincipal('member', 'member');

      const skill = await inTx(ownerId, (client) =>
        proposeSkill(client, workspaceId, ownerId, {
          name: `diagnose-${randomUUID().slice(0, 8)}`,
          description: 'How to diagnose a slow service.',
          markdown: 'Check latency first.',
        }),
      );
      await inTx(ownerId, (client) => publishSkill(client, workspaceId, ownerId, skill.id));
      skillId = skill.id;

      const definition = await inTx(ownerId, (client) =>
        proposeWorkerDefinition(client, workspaceId, ownerId, {
          kind: 'worker',
          definition: { systemPrompt: 'You diagnose.', skills: [skill.name] },
        }),
      );
      await inTx(ownerId, (client) =>
        publishWorkerDefinition(client, workspaceId, ownerId, {
          definitionId: definition.id,
          version: definition.version,
        }),
      );
      workerDefinitionId = definition.id;

      const procedure = await inTx(ownerId, (client) =>
        proposeProcedure(client, workspaceId, ownerId, {
          name: `diagnose-flow-${randomUUID().slice(0, 8)}`,
          description: 'Delegate a diagnosis, then verify it.',
          steps: [
            { kind: 'worker', definitionId: workerDefinitionId, version: 1 },
            { kind: 'verify', description: 'The root cause names one service.' },
          ],
        }),
      );
      await inTx(ownerId, (client) => publishProcedure(client, workspaceId, ownerId, procedure.id));
      procedureId = procedure.id;
    });

    // The per-user concurrency quota counts unfinished Tasks; each test leaves its spawns running.
    afterEach(async () => {
      await inTx(ownerId, (client) =>
        client.query(
          `update tasks set status = 'cancelled', cancelled_at = now()
         where workspace_id = $1 and status in ('queued', 'running', 'waiting_approval')`,
          [workspaceId],
        ),
      );
    });

    afterAll(async () => {
      await pool.end();
    });

    describe('worker_run_skills — WorkerRun loaded SkillVersion', () => {
      it('records the loaded Skill version with the WorkerRun, and re-records it for a requeue', async () => {
        const supervisorClient = new FakeTaskSupervisorClient();
        const runtimeDeps = deps(supervisorClient);
        const spawned = await invokeWorker(
          workspaceId,
          { principalId: ownerId, channel: 'handle', claims: await entryClaims(ownerId) },
          { definitionId: workerDefinitionId, version: 1, input: {}, wait: false },
          runtimeDeps,
        );
        expect(supervisorClient.spawnCalls[0]?.skillsInline?.length).toBe(1);

        // Crash → requeue once: the retry run records what *it* loads.
        supervisorClient.setStatus(spawned.workerRunId, { status: 'failed', exitCode: 1 });
        await reactToSupervisorStatus(runtimeDeps, workspaceId, ownerId, spawned.workerRunId);
        const retryRunId = supervisorClient.spawnCalls[1]?.workerRunId as string;
        expect(retryRunId).toBeDefined();

        const attributions = await inTx(ownerId, async (client) => {
          const task = await readTaskRow(client, workspaceId, spawned.taskId);
          if (!task) throw new Error('task missing');
          return readTaskAttributions(
            client,
            workspaceId,
            [task],
            [spawned.workerRunId, retryRunId],
          );
        });
        for (const runId of [spawned.workerRunId, retryRunId]) {
          expect(attributions.skillsByRun.get(runId)).toEqual([
            expect.objectContaining({ skillId, version: 1 }),
          ]);
        }
      });

      it('a run of a definition with no Skills is recorded as [], a pre-E1 run reads null (未记录)', async () => {
        const bare = await inTx(ownerId, (client) =>
          proposeWorkerDefinition(client, workspaceId, ownerId, {
            kind: 'worker',
            definition: { systemPrompt: 'No skills.' },
          }),
        );
        await inTx(ownerId, (client) =>
          publishWorkerDefinition(client, workspaceId, ownerId, {
            definitionId: bare.id,
            version: bare.version,
          }),
        );
        const spawned = await invokeWorker(
          workspaceId,
          { principalId: ownerId, channel: 'handle', claims: await entryClaims(ownerId) },
          { definitionId: bare.id, version: bare.version, input: {}, wait: false },
          deps(new FakeTaskSupervisorClient()),
        );
        // A run written before E1: no `skills_recorded`.
        const legacyRunId = await inTx(ownerId, async (client) => {
          const result = await client.query<{ id: string }>(
            `insert into worker_runs (workspace_id, status, task_id, depth, attempt)
           values ($1, 'terminated', $2, 1, 1) returning id`,
            [workspaceId, spawned.taskId],
          );
          return result.rows[0]?.id as string;
        });

        const attributions = await inTx(ownerId, async (client) => {
          const task = await readTaskRow(client, workspaceId, spawned.taskId);
          if (!task) throw new Error('task missing');
          return readTaskAttributions(
            client,
            workspaceId,
            [task],
            [spawned.workerRunId, legacyRunId],
          );
        });
        expect(attributions.skillsByRun.get(spawned.workerRunId)).toEqual([]);
        expect(attributions.skillsByRun.get(legacyRunId)).toBeNull();
        expect(attributions.outcomeByTask.get(spawned.taskId)).toBeNull();
      });

      it('a deprecated Skill is no longer loaded or recorded', async () => {
        const skill = await inTx(ownerId, (client) =>
          proposeSkill(client, workspaceId, ownerId, {
            name: `retired-${randomUUID().slice(0, 8)}`,
            description: 'Retired.',
            markdown: 'Old.',
          }),
        );
        await inTx(ownerId, (client) => publishSkill(client, workspaceId, ownerId, skill.id));
        const definition = await inTx(ownerId, (client) =>
          proposeWorkerDefinition(client, workspaceId, ownerId, {
            kind: 'worker',
            definition: { systemPrompt: 'Uses a retired skill.', skills: [skill.name] },
          }),
        );
        await inTx(ownerId, (client) =>
          publishWorkerDefinition(client, workspaceId, ownerId, {
            definitionId: definition.id,
            version: definition.version,
          }),
        );
        await inTx(ownerId, (client) => deprecateSkill(client, workspaceId, skill.id));

        const spawned = await invokeWorker(
          workspaceId,
          { principalId: ownerId, channel: 'handle', claims: await entryClaims(ownerId) },
          { definitionId: definition.id, version: definition.version, input: {}, wait: false },
          deps(new FakeTaskSupervisorClient()),
        );
        const attributions = await inTx(ownerId, async (client) => {
          const task = await readTaskRow(client, workspaceId, spawned.taskId);
          if (!task) throw new Error('task missing');
          return readTaskAttributions(client, workspaceId, [task], [spawned.workerRunId]);
        });
        expect(attributions.skillsByRun.get(spawned.workerRunId)).toEqual([]);
      });
    });

    describe('Turn attribution of a nested Worker Task (leftover 123)', () => {
      it("a Worker's own invoke_worker inherits its root Task's Turn, not the caller's running Turn", async () => {
        const { turnId: rootTurn } = await insertTurn(ownerId, 'running');
        const supervisorClient = new FakeTaskSupervisorClient();
        const root = await invokeWorker(
          workspaceId,
          {
            principalId: ownerId,
            channel: 'handle',
            claims: await entryClaims(ownerId),
            turnId: rootTurn,
          },
          { definitionId: workerDefinitionId, version: 1, input: {}, wait: false },
          deps(supervisorClient),
        );

        // The root Task's WorkerRun Handle, as the supervisor received it.
        const workerSessionId = await inTx(ownerId, async (client) => {
          const result = await client.query<{ session_id: string }>(
            'select session_id from worker_runs where workspace_id = $1 and id = $2',
            [workspaceId, root.workerRunId],
          );
          return result.rows[0]?.session_id as string;
        });
        const workerClaims = claimsOf(
          await inTx(ownerId, (client) =>
            issueHandle(client, {
              sessionId: workerSessionId,
              scope: { capabilities: ['invoke_worker', 'get_task'], resources: {} },
              ttlSeconds: 600,
              privateKey,
            }),
          ),
        );
        // Meanwhile the user started a Turn in another chat; the gateway would pass that one.
        const { turnId: otherTurn } = await insertTurn(ownerId, 'running');

        const nested = await invokeWorker(
          workspaceId,
          { principalId: ownerId, channel: 'handle', claims: workerClaims, turnId: otherTurn },
          { definitionId: workerDefinitionId, version: 1, input: {}, wait: false },
          deps(supervisorClient),
        );
        const nestedTask = await inTx(ownerId, (client) =>
          readTaskRow(client, workspaceId, nested.taskId),
        );
        expect(nestedTask?.createdByActivityId).toBe(rootTurn);
      });
    });

    describe('mark_turn_outcome — the requester judges a finished Turn', () => {
      it('unknown → achieved, a repeat is a no-op, one correction, then 409', async () => {
        const { turnId } = await insertTurn(memberId);
        const first = await inTx(memberId, (client) =>
          markTurnOutcome(client, workspaceId, memberId, turnId, 'achieved'),
        );
        expect(first?.outcome).toMatchObject({
          basis: 'requester',
          outcome: 'achieved',
          givenBy: memberId,
          revision: 1,
          previousOutcome: null,
        });

        const repeat = await inTx(memberId, (client) =>
          markTurnOutcome(client, workspaceId, memberId, turnId, 'achieved'),
        );
        expect(repeat?.outcome?.revision).toBe(1);

        const corrected = await inTx(memberId, (client) =>
          markTurnOutcome(client, workspaceId, memberId, turnId, 'not_achieved'),
        );
        expect(corrected?.outcome).toMatchObject({
          outcome: 'not_achieved',
          revision: 2,
          previousOutcome: 'achieved',
        });

        await expect(
          inTx(memberId, (client) =>
            markTurnOutcome(client, workspaceId, memberId, turnId, 'achieved'),
          ),
        ).rejects.toBeInstanceOf(ObjectiveOutcomeConflictError);
      });

      it('refuses a running Turn (409) and anyone but the requester (403); an invisible Turn is not found', async () => {
        const running = await insertTurn(memberId, 'running');
        await expect(
          inTx(memberId, (client) =>
            markTurnOutcome(client, workspaceId, memberId, running.turnId, 'achieved'),
          ),
        ).rejects.toBeInstanceOf(ObjectiveOutcomeConflictError);

        const shared = await insertTurn(memberId, 'completed', 'workspace');
        await expect(
          inTx(ownerId, (client) =>
            markTurnOutcome(client, workspaceId, ownerId, shared.turnId, 'achieved'),
          ),
        ).rejects.toBeInstanceOf(ObjectiveOutcomeForbiddenError);

        const privateTurn = await insertTurn(memberId);
        const invisible = await inTx(ownerId, (client) =>
          markTurnOutcome(client, workspaceId, ownerId, privateTurn.turnId, 'achieved'),
        );
        expect(invisible).toBeUndefined();
      });

      it('the database refuses an outcome shape the capability never writes', async () => {
        const { turnId } = await insertTurn(memberId);
        await expect(
          inTx(memberId, (client) =>
            client.query(
              `insert into turn_outcomes (workspace_id, turn_id, outcome, given_by, revision)
             values ($1, $2, 'achieved', $3, 3)`,
              [workspaceId, turnId, memberId],
            ),
          ),
        ).rejects.toThrow(/check/i);
      });
    });

    describe('record_procedure_followed — the Turn claims a published Procedure', () => {
      it('records the first published Procedure claimed; a later claim returns it unchanged', async () => {
        const { chatId, turnId } = await insertTurn(memberId, 'running');
        const claim = await inTx(memberId, (client) =>
          recordProcedureFollowed(client, workspaceId, memberId, turnId, {
            procedureId,
            version: 1,
          }),
        );
        expect(claim).toMatchObject({ procedureId, version: 1 });

        const other = await inTx(ownerId, (client) =>
          proposeProcedure(client, workspaceId, ownerId, {
            name: `other-${randomUUID().slice(0, 8)}`,
            description: 'Another flow.',
            steps: [{ kind: 'verify', description: 'Check.' }],
          }),
        );
        await inTx(ownerId, (client) => publishProcedure(client, workspaceId, ownerId, other.id));
        const second = await inTx(memberId, (client) =>
          recordProcedureFollowed(client, workspaceId, memberId, turnId, {
            procedureId: other.id,
            version: 1,
          }),
        );
        expect(second).toMatchObject({ procedureId, version: 1 });

        const page = await inTx(memberId, (client) => listChatTurns(client, workspaceId, chatId));
        expect(page.items[0]?.procedure).toMatchObject({ procedureId, version: 1 });
        expect(page.items[0]?.outcome).toBeNull();
      });

      it('a draft or unknown Procedure version is not followable', async () => {
        const { turnId } = await insertTurn(memberId, 'running');
        const draft = await inTx(memberId, (client) =>
          proposeProcedure(client, workspaceId, memberId, {
            name: `draft-${randomUUID().slice(0, 8)}`,
            description: 'Never published.',
            steps: [{ kind: 'verify', description: 'Check.' }],
          }),
        );
        for (const ref of [
          { procedureId: draft.id, version: 1 },
          { procedureId, version: 99 },
        ]) {
          const claim = await inTx(memberId, (client) =>
            recordProcedureFollowed(client, workspaceId, memberId, turnId, ref),
          );
          expect(claim).toBe(false);
        }
      });
    });

    describe('report_task_outcome — a verify step judges a delegated Task', () => {
      it('only once finished, only for the caller’s own Task, correctable once', async () => {
        const { turnId } = await insertTurn(ownerId, 'running');
        const spawned = await invokeWorker(
          workspaceId,
          { principalId: ownerId, channel: 'handle', claims: await entryClaims(ownerId), turnId },
          { definitionId: workerDefinitionId, version: 1, input: {}, wait: false },
          deps(new FakeTaskSupervisorClient()),
        );

        await expect(
          inTx(ownerId, (client) =>
            reportTaskOutcome(client, workspaceId, ownerId, spawned.taskId, 'achieved'),
          ),
        ).rejects.toBeInstanceOf(ObjectiveOutcomeConflictError);

        await finishTask(spawned.taskId);
        const notMine = await inTx(memberId, (client) =>
          reportTaskOutcome(client, workspaceId, memberId, spawned.taskId, 'achieved'),
        );
        expect(notMine).toBeUndefined();

        const first = await inTx(ownerId, (client) =>
          reportTaskOutcome(client, workspaceId, ownerId, spawned.taskId, 'not_achieved'),
        );
        // The giver is the principal the agent acts for; `basis` says it is the agent's report.
        expect(first).toMatchObject({
          basis: 'agent_reported',
          outcome: 'not_achieved',
          revision: 1,
          givenBy: ownerId,
        });
        const corrected = await inTx(ownerId, (client) =>
          reportTaskOutcome(client, workspaceId, ownerId, spawned.taskId, 'achieved'),
        );
        expect(corrected).toMatchObject({
          outcome: 'achieved',
          revision: 2,
          previousOutcome: 'not_achieved',
        });

        // The read model: the Task's own outcome, its Turn with the Procedure claim and the
        // requester's outcome, the Skill version its run loaded.
        await inTx(ownerId, (client) =>
          recordProcedureFollowed(client, workspaceId, ownerId, turnId, {
            procedureId,
            version: 1,
          }),
        );
        await inTx(ownerId, (client) =>
          client.query(
            `update activities set status = 'completed', ended_at = now()
           where workspace_id = $1 and id = $2`,
            [workspaceId, turnId],
          ),
        );
        await inTx(ownerId, (client) =>
          markTurnOutcome(client, workspaceId, ownerId, turnId, 'achieved'),
        );
        const attributions = await inTx(ownerId, async (client) => {
          const task = await readTaskRow(client, workspaceId, spawned.taskId);
          if (!task) throw new Error('task missing');
          return readTaskAttributions(client, workspaceId, [task], [spawned.workerRunId]);
        });
        expect(attributions.outcomeByTask.get(spawned.taskId)).toMatchObject({
          basis: 'agent_reported',
          outcome: 'achieved',
        });
        expect(attributions.turns.get(turnId)).toMatchObject({
          procedure: { procedureId, version: 1 },
          outcome: { basis: 'requester', outcome: 'achieved', givenBy: ownerId },
        });
        expect(attributions.skillsByRun.get(spawned.workerRunId)).toEqual([
          expect.objectContaining({ skillId, version: 1 }),
        ]);
      });
    });
  },
);
