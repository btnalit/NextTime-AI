import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HandleClaims } from '@nexttime/shared';
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
  entryScope,
  generateEphemeralHandleKeyPair,
  issueHandle,
} from '../../governance/capability/index.js';
import { explain } from '../../substrate/epistemic/index.js';
import { invokeWorker, readWorkerRunRow } from '../task/index.js';
import type { TaskRuntimeDeps } from '../task/runtime.js';
import { listSkills, proposeWorkerDefinition, publishWorkerDefinition } from '../worker/index.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/worker-result.integration.test: DB-gated (real Postgres; auto-skip without
 * DATABASE_URL) end-to-end tests for `report_task_result` (docs/development-tasks.md S2.9
 * deliverable C acceptance): a posted contract creates `inferred` Facts under a `worker_result`
 * Activity, completes the Task with the stored result, and `explain(fact)` reaches the WorkerRun;
 * a contract from a session that is not the Task's own WorkerRun → 403; a malformed contract → 400.
 *
 * Reuses `invoke.integration.test.ts`'s own harness shape (fake, in-memory
 * `TaskSupervisorClientPort` — no real Docker/worker-supervisor) so a real WorkerRun + a real
 * minted child Handle exist to call `report_task_result` *as*, exercising the actual
 * `computeChildHandleScope` grant (S2.9's own `WORKER_INFRASTRUCTURE_CAPABILITY_NAMES` force-union)
 * rather than a hand-constructed scope that could silently drift from what `invoke_worker` really
 * mints.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

class FakeTaskSupervisorClient implements TaskSupervisorClientPort {
  readonly statuses = new Map<string, TaskSupervisorStatus>();

  async spawn(input: TaskSpawnInput): Promise<TaskSpawnOutcome> {
    const containerId = `container-${input.workerRunId}`;
    this.statuses.set(input.workerRunId, {
      workerRunId: input.workerRunId,
      status: 'running',
      exitCode: undefined,
      containerId,
      ip: '198.51.100.11',
      startedAt: new Date().toISOString(),
      finishedAt: undefined,
      reason: undefined,
    });
    return { containerId, ip: '198.51.100.11' };
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

describe.runIf(DATABASE_URL !== undefined)(
  'report_task_result — integration (real Postgres)',
  () => {
    let pool: Pool;
    let privateKey: Awaited<ReturnType<typeof generateEphemeralHandleKeyPair>>['privateKey'];
    let workspaceId: string;
    let ownerId: string;
    let workerDefinitionId: string;

    async function adminInsertWorkspace(name: string): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId: id, principalId: randomUUID() },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [id, name]);
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    async function adminInsertPrincipal(role: string, displayName: string): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: id },
        async (client) => {
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', $3, $4)",
            [workspaceId, id, role, displayName],
          );
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    async function inTx<T>(
      principalId: string,
      fn: (client: PoolClient) => Promise<T>,
    ): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId }, fn);
    }

    async function insertSession(
      kind: string,
      principalId: string,
      onBehalfOf: string,
    ): Promise<string> {
      return inTx(principalId, async (client) => {
        const result = await client.query<{ id: string }>(
          `insert into sessions (workspace_id, principal_id, kind, on_behalf_of, status)
         values ($1, $2, $3, $4, 'active') returning id`,
          [workspaceId, principalId, kind, onBehalfOf],
        );
        const id = result.rows[0]?.id;
        if (!id) throw new Error('failed to insert session');
        return id;
      });
    }

    /** Reads back the child Handle `invoke_worker` minted for a WorkerRun's own session (a real,
     *  already-committed row — never a freshly-issued test Handle) and builds the `HandleClaims`
     *  `dispatchCapability` needs to call as that WorkerRun. */
    async function claimsForWorkerRunSession(sessionId: string): Promise<HandleClaims> {
      const row = await inTx(ownerId, async (client) => {
        const result = await client.query<{
          jti: string;
          on_behalf_of: string;
          scope: HandleClaims['scope'];
          expires_at: Date;
        }>(
          'select jti, on_behalf_of, scope, expires_at from capability_handles where workspace_id = $1 and session_id = $2',
          [workspaceId, sessionId],
        );
        return result.rows[0];
      });
      if (!row) throw new Error(`no capability_handles row for session ${sessionId}`);
      return {
        ws: workspaceId,
        sid: sessionId,
        obo: row.on_behalf_of,
        scope: row.scope,
        jti: row.jti,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(new Date(row.expires_at).getTime() / 1000),
      };
    }

    function deps(supervisorClient: FakeTaskSupervisorClient): TaskRuntimeDeps {
      return { pool, privateKey, supervisorClient };
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      const keyPair = await generateEphemeralHandleKeyPair();
      privateKey = keyPair.privateKey;

      workspaceId = await adminInsertWorkspace('worker-result-integration-test');
      ownerId = await adminInsertPrincipal('owner', 'owner');

      const proposed = await inTx(ownerId, (client) =>
        proposeWorkerDefinition(client, workspaceId, ownerId, {
          kind: 'worker',
          definition: { systemPrompt: 'You are a plain worker.' },
        }),
      );
      await inTx(ownerId, (client) =>
        publishWorkerDefinition(client, workspaceId, ownerId, {
          definitionId: proposed.id,
          version: proposed.version,
        }),
      );
      workerDefinitionId = proposed.id;
    });

    afterAll(async () => {
      await pool.end();
    });

    /** Spawns a fresh entry session + Handle, invokes the plain worker definition (wait: false), and
     *  returns the real minted WorkerRun claims to call `report_task_result` as. */
    async function spawnWorkerRun(): Promise<{
      taskId: string;
      workerRunId: string;
      claims: HandleClaims;
    }> {
      const entrySessionId = await insertSession('entry', ownerId, ownerId);
      const entryIssued = await inTx(ownerId, (client) =>
        issueHandle(client, {
          sessionId: entrySessionId,
          scope: entryScope(),
          ttlSeconds: 3600,
          privateKey,
        }),
      );
      const entryClaims: HandleClaims = {
        ws: workspaceId,
        sid: entrySessionId,
        obo: ownerId,
        scope: entryIssued.scope,
        jti: entryIssued.jti,
        iat: Math.floor(entryIssued.issuedAt.getTime() / 1000),
        exp: Math.floor(entryIssued.expiresAt.getTime() / 1000),
      };

      const supervisorClient = new FakeTaskSupervisorClient();
      const invoked = await invokeWorker(
        workspaceId,
        { principalId: ownerId, channel: 'handle', claims: entryClaims },
        { definitionId: workerDefinitionId, version: 1, input: { foo: 'bar' }, wait: false },
        deps(supervisorClient),
      );

      const workerRun = await inTx(ownerId, (client) =>
        readWorkerRunRow(client, workspaceId, invoked.workerRunId),
      );
      if (!workerRun?.sessionId) throw new Error('spawned WorkerRun has no session');
      const claims = await claimsForWorkerRunSession(workerRun.sessionId);
      return { taskId: invoked.taskId, workerRunId: invoked.workerRunId, claims };
    }

    it('writes facts_to_assert as inferred Facts under a worker_result Activity, completes the Task, and explain reaches the WorkerRun', async () => {
      const { taskId, workerRunId, claims } = await spawnWorkerRun();
      expect(claims.scope.capabilities).toContain('report_task_result');

      const caller: ResolvedCaller = { channel: 'handle', claims };
      const result = (await dispatchCapability({ pool }, caller, 'report_task_result', {
        summary: 'pong',
        findings: ['found nothing unusual'],
        factsToAssert: [
          {
            linkType: 'observed_state',
            source: { objectType: 'Host', identity: { name: 'host-a' } },
            target: { objectType: 'Host', identity: { name: 'host-b' } },
            properties: { note: 'a reaches b' },
          },
        ],
        evidence: [{ kind: 'note', content: { text: 'checked twice' } }],
        artifacts: [{ path: 'artifacts/report.txt' }],
      })) as { taskId: string; status: string; activityId: string; factIds: string[] };

      expect(result.taskId).toBe(taskId);
      expect(result.status).toBe('completed');
      expect(result.factIds).toHaveLength(1);

      const task = await inTx(ownerId, async (client) => {
        const rows = await client.query<{ status: string; result: { summary: string } }>(
          'select status, result from tasks where workspace_id = $1 and id = $2',
          [workspaceId, taskId],
        );
        return rows.rows[0];
      });
      expect(task?.status).toBe('completed');
      expect(task?.result?.summary).toBe('pong');

      const [factId] = result.factIds;
      if (!factId) throw new Error('expected a written fact id');
      const explained = await inTx(ownerId, (client) => explain(client, workspaceId, { factId }));
      expect(explained.fact?.epistemicStatus).toBe('inferred');
      expect(explained.activity?.kind).toBe('worker_result');
      expect(explained.activity?.metadata.taskId).toBe(taskId);
      expect(explained.activity?.metadata.workerRunId).toBe(workerRunId);
    });

    it('proposedSkill (S2.14) creates a draft Skill owned by the Task’s on_behalf_of principal, private until published', async () => {
      const { taskId, claims } = await spawnWorkerRun();
      const caller: ResolvedCaller = { channel: 'handle', claims };
      const skillName = `worker-discovered-skill-${taskId}`;

      await dispatchCapability({ pool }, caller, 'report_task_result', {
        summary: 'found a reusable trick',
        proposedSkill: {
          name: skillName,
          description: 'A genuinely new, reusable way to do the thing.',
          markdown: 'Step one. Step two.',
        },
      });

      // Owned by on_behalf_of (ownerId, per spawnWorkerRun's own `caller.principalId: ownerId`) —
      // visible to ownerId's own listSkills, and (I16 read-privacy) not to another principal.
      const ownList = await inTx(ownerId, (client) => listSkills(client, workspaceId, ownerId));
      const draft = ownList.find((s) => s.name === skillName);
      expect(draft?.status).toBe('draft');
      expect(draft?.proposedBy).toBe(ownerId);

      const otherId = await adminInsertPrincipal('operator', `other-${taskId}`);
      const otherList = await inTx(otherId, (client) => listSkills(client, workspaceId, otherId));
      expect(otherList.some((s) => s.name === skillName)).toBe(false);
    });

    it('rejects a report_task_result call from a session that is not a WorkerRun’s own session (403)', async () => {
      // report_task_result derives the Task/WorkerRun to report for entirely from the calling
      // Handle's own claims.sid (never a caller-supplied taskId/workerRunId — this module's own doc
      // comment) — the only way to name "the wrong" WorkerRun is a session that is not a WorkerRun's
      // own session at all. An entry session's Handle is exactly that.
      const entrySessionId = await insertSession('entry', ownerId, ownerId);
      const entryIssued = await inTx(ownerId, (client) =>
        issueHandle(client, {
          sessionId: entrySessionId,
          scope: entryScope(),
          ttlSeconds: 3600,
          privateKey,
        }),
      );
      const entryCaller: ResolvedCaller = {
        channel: 'handle',
        claims: {
          ws: workspaceId,
          sid: entrySessionId,
          obo: ownerId,
          scope: entryIssued.scope,
          jti: entryIssued.jti,
          iat: Math.floor(entryIssued.issuedAt.getTime() / 1000),
          exp: Math.floor(entryIssued.expiresAt.getTime() / 1000),
        },
      };
      await expect(
        dispatchCapability({ pool }, entryCaller, 'report_task_result', {
          summary: 'not a worker run',
        }),
      ).rejects.toThrow(/not bound|not a WorkerRun/i);
    });

    it('rejects a malformed contract (a factsToAssert objectId that does not exist) with a 400-class error', async () => {
      const { claims } = await spawnWorkerRun();
      const caller: ResolvedCaller = { channel: 'handle', claims };

      await expect(
        dispatchCapability({ pool }, caller, 'report_task_result', {
          summary: 'bad ref',
          factsToAssert: [
            {
              linkType: 'observed_state',
              source: { objectId: randomUUID() },
              target: { objectId: randomUUID() },
            },
          ],
        }),
      ).rejects.toThrow(/does not exist/);
    });
  },
);
