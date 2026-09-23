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
import { publishOntologyDomainPack } from '../../substrate/ontology/index.js';
import { invokeWorker, readWorkerRunRow } from '../task/index.js';
import type { TaskRuntimeDeps } from '../task/runtime.js';
import { listSkills, proposeWorkerDefinition, publishWorkerDefinition } from '../worker/index.js';
import { createWorkspaceWithOwner } from '../workspace/index.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/worker-result.integration.test: DB-gated (real Postgres; auto-skip without
 * DATABASE_URL) end-to-end tests for `report_task_result` (docs/development-tasks.md S2.9
 * deliverable C acceptance): a posted contract creates Facts under a `worker_result` Activity,
 * completes the Task with the stored result, and `explain(fact)` reaches the WorkerRun; a contract
 * from a session that is not the Task's own WorkerRun → 403; a refused entry (ontology `reject`,
 * I16 meta-ontology ref, missing objectId, bogus gatekeeperId, out-of-range evidence) is recorded
 * and skipped while the Task still completes (the 2026-09-18 real-model rounds).
 *
 * epistemic_status: `inferred`. `SqlGraphStore.assertFact` derives the status from the caller's
 * real `principals.kind` row (lane-1 P2 fix — a caller-supplied `kind` is ignored, closing the
 * hole where any caller could claim `kind: 'human'` → `asserted`), and `postWorkerResult` now
 * asserts every contract Fact *as* a real `kind='agent'` principal — the (workspace,
 * WorkerDefinition) agent principal `invoke_worker`'s own `spawnWorkerRun` resolves via
 * `ensureWorkerAgentPrincipal` (`application/task/agent-principal.ts`) — instead of the interim
 * `CallerPrincipal.viaAgent` downgrade flag PR #84 introduced. This harness's `ownerId` is a
 * genuine `kind: 'human'` principal (`adminInsertPrincipal` below always inserts `'human'`) —
 * exactly the production shape, since it is the Task's `on_behalf_of` human, now recorded as
 * `activity.metadata.onBehalfOf` provenance rather than `asserted_by`/`started_by` — so this test
 * is the regression guard for both the original 2026-09-08 accept_s2 step-7 failure (deriving from
 * the human principal alone turned a Worker's inference into a human `asserted` Fact) and its
 * follow-up: `asserted_by`/`started_by` must resolve to a real agent principal, not just an
 * `inferred` status reached by a downgrade flag.
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
const ONTOLOGY_DIR = path.join(path.resolve(KERNEL_ROOT, '..', '..'), 'ontology');

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
     *  returns the real minted WorkerRun claims to call `report_task_result` as. `principalId`
     *  (default `ownerId`) is both the entry session's own principal and the Task's `on_behalf_of`
     *  — pass a second human principal (see `adminInsertPrincipal`) to spawn a run on their behalf
     *  instead of the suite's default owner (W5.5 cross-principal corroboration test). */
    async function spawnWorkerRun(principalId: string = ownerId): Promise<{
      taskId: string;
      workerRunId: string;
      claims: HandleClaims;
    }> {
      const entrySessionId = await insertSession('entry', principalId, principalId);
      const entryIssued = await inTx(principalId, (client) =>
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
        obo: principalId,
        scope: entryIssued.scope,
        jti: entryIssued.jti,
        iat: Math.floor(entryIssued.issuedAt.getTime() / 1000),
        exp: Math.floor(entryIssued.expiresAt.getTime() / 1000),
      };

      const supervisorClient = new FakeTaskSupervisorClient();
      const invoked = await invokeWorker(
        workspaceId,
        { principalId, channel: 'handle', claims: entryClaims },
        { definitionId: workerDefinitionId, version: 1, input: { foo: 'bar' }, wait: false },
        deps(supervisorClient),
      );

      const workerRun = await inTx(principalId, (client) =>
        readWorkerRunRow(client, workspaceId, invoked.workerRunId),
      );
      if (!workerRun?.sessionId) throw new Error('spawned WorkerRun has no session');
      const claims = await claimsForWorkerRunSession(workerRun.sessionId);
      return { taskId: invoked.taskId, workerRunId: invoked.workerRunId, claims };
    }

    it('writes facts_to_assert as Facts under a worker_result Activity, completes the Task, and explain reaches the WorkerRun', async () => {
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
      })) as { id: string; status: string; activityId: string; factIds: string[] };

      expect(result.id).toBe(taskId);
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
      // ownerId is a genuine 'human' principal, yet the Fact is asserted_by a real kind='agent'
      // principal — see this file's module doc comment: §5.6 agent → inferred, and this is the
      // regression guard for accept_s2 step 7 (2026-09-08) and its follow-up (replacing PR #84's
      // viaAgent downgrade flag with a real agent principal).
      expect(explained.fact?.epistemicStatus).toBe('inferred');
      expect(explained.fact?.assertedByPrincipal?.kind).toBe('agent');
      expect(explained.fact?.assertedByPrincipal?.displayName).toMatch(/^worker:/);
      expect(explained.fact?.assertedByPrincipal?.id).not.toBe(ownerId);
      expect(explained.activity?.kind).toBe('worker_result');
      expect(explained.activity?.metadata.taskId).toBe(taskId);
      expect(explained.activity?.metadata.workerRunId).toBe(workerRunId);
      // Activity started_by is the same agent principal — never the human — with the human kept
      // as onBehalfOf provenance, both directly on `metadata` and resolved by `explain` itself.
      expect(explained.activity?.startedByPrincipal?.kind).toBe('agent');
      expect(explained.activity?.startedByPrincipal?.id).toBe(
        explained.fact?.assertedByPrincipal?.id,
      );
      expect(explained.activity?.metadata.onBehalfOf).toBe(ownerId);
      expect(explained.activity?.onBehalfOfPrincipal?.id).toBe(ownerId);
      expect(explained.activity?.onBehalfOfPrincipal?.kind).toBe('human');
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
      const draft = ownList.items.find((s) => s.name === skillName);
      expect(draft?.status).toBe('draft');
      expect(draft?.proposedBy).toBe(ownerId);

      const otherId = await adminInsertPrincipal('operator', `other-${taskId}`);
      const otherList = await inTx(otherId, (client) => listSkills(client, workspaceId, otherId));
      expect(otherList.items.some((s) => s.name === skillName)).toBe(false);
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

    it('a factsToAssert objectId that does not exist costs that entry, not the result (object_not_found recorded)', async () => {
      const { taskId, claims } = await spawnWorkerRun();
      const caller: ResolvedCaller = { channel: 'handle', claims };

      const result = (await dispatchCapability({ pool }, caller, 'report_task_result', {
        summary: 'bad ref',
        factsToAssert: [
          {
            linkType: 'observed_state',
            source: { objectId: randomUUID() },
            target: { objectId: randomUUID() },
          },
        ],
      })) as { status: string; factIds: string[] };
      expect(result.status).toBe('completed');
      expect(result.factIds).toEqual([]);

      const stored = await inTx(ownerId, async (client) => {
        const rows = await client.query<{
          result: { factsRejected: { index: number; reason: string; detail?: string }[] };
        }>('select result from tasks where workspace_id = $1 and id = $2', [workspaceId, taskId]);
        return rows.rows[0];
      });
      expect(stored?.result.factsRejected).toHaveLength(1);
      expect(stored?.result.factsRejected[0]).toMatchObject({
        index: 0,
        reason: 'object_not_found',
      });
      expect(stored?.result.factsRejected[0]?.detail).toMatch(/does not exist/);
    });

    it('two runs of the same WorkerDefinition asserting contradicting facts open exactly one Conflict', async () => {
      // W5.5 (STATUS leftover 16): each WorkerRun now registers its own workspace-visible
      // `worker_run` Source before asserting — two runs of the *same* WorkerDefinition (one shared
      // agent principal) are therefore two different origins, so a contradicting re-assertion of the
      // same identity must open a Conflict rather than silently supersede.
      const identity = { name: `contradict-${randomUUID()}` };
      const otherIdentity = { name: `contradict-target-${randomUUID()}` };

      const run1 = await spawnWorkerRun();
      const caller1: ResolvedCaller = { channel: 'handle', claims: run1.claims };
      const result1 = (await dispatchCapability({ pool }, caller1, 'report_task_result', {
        summary: 'run 1',
        factsToAssert: [
          {
            linkType: 'observed_state',
            source: { objectType: 'Host', identity },
            target: { objectType: 'Host', identity: otherIdentity },
            properties: { port: 80 },
          },
        ],
      })) as { factIds: string[] };
      const [factId1] = result1.factIds;
      if (!factId1) throw new Error('expected run 1 to write a fact id');

      const run2 = await spawnWorkerRun();
      const caller2: ResolvedCaller = { channel: 'handle', claims: run2.claims };
      const result2 = (await dispatchCapability({ pool }, caller2, 'report_task_result', {
        summary: 'run 2',
        factsToAssert: [
          {
            linkType: 'observed_state',
            source: { objectType: 'Host', identity },
            target: { objectType: 'Host', identity: otherIdentity },
            properties: { port: 81 },
          },
        ],
      })) as { factIds: string[] };
      const [factId2] = result2.factIds;
      if (!factId2) throw new Error('expected run 2 to write a fact id');
      expect(factId2).not.toBe(factId1);

      const identityRow = await inTx(ownerId, async (client) => {
        const rows = await client.query<{
          link_type: string;
          source_object_id: string;
          target_object_id: string;
        }>(
          'select link_type, source_object_id, target_object_id from links where workspace_id = $1 and id = $2',
          [workspaceId, factId1],
        );
        return rows.rows[0];
      });
      if (!identityRow) throw new Error('expected fact1 to exist');

      const activeRows = await inTx(ownerId, async (client) => {
        const rows = await client.query<{ id: string }>(
          `select id from links
           where workspace_id = $1 and link_type = $2 and source_object_id = $3
             and target_object_id = $4 and superseded_at is null and invalidated_at is null`,
          [
            workspaceId,
            identityRow.link_type,
            identityRow.source_object_id,
            identityRow.target_object_id,
          ],
        );
        return rows.rows;
      });
      expect(activeRows).toHaveLength(2);

      const conflictRows = await inTx(ownerId, async (client) => {
        const rows = await client.query<{ status: string; link_a_id: string; link_b_id: string }>(
          `select status, link_a_id, link_b_id from conflicts
           where workspace_id = $1 and (link_a_id = any($2::uuid[]) or link_b_id = any($2::uuid[]))`,
          [workspaceId, [factId1, factId2]],
        );
        return rows.rows;
      });
      expect(conflictRows).toHaveLength(1);
      const [conflictRow] = conflictRows;
      expect(conflictRow?.status).toBe('open');
      expect([conflictRow?.link_a_id, conflictRow?.link_b_id]).toContain(factId1);
      expect([conflictRow?.link_a_id, conflictRow?.link_b_id]).toContain(factId2);

      // Each run's Fact carries its own Observation, pointing at its own workspace-visible
      // worker_run Source owned by the on_behalf_of principal (spawnWorkerRun's ownerId) — two
      // different Source rows, not one shared per-WorkerDefinition principal.
      const sourceRows = await inTx(ownerId, async (client) => {
        const rows = await client.query<{
          fact_id: string;
          source_id: string;
          kind: string;
          owner_principal_id: string;
        }>(
          `select l.id as fact_id, s.id as source_id, s.kind, s.owner_principal_id
           from links l
           join observations o on o.workspace_id = l.workspace_id and o.id = l.observation_id
           join sources s on s.workspace_id = o.workspace_id and s.id = o.source_id
           where l.workspace_id = $1 and l.id = any($2::uuid[])`,
          [workspaceId, [factId1, factId2]],
        );
        return rows.rows;
      });
      expect(sourceRows).toHaveLength(2);
      for (const row of sourceRows) {
        expect(row.kind).toBe('worker_run');
        expect(row.owner_principal_id).toBe(ownerId);
      }
      const sourceIds = new Set(sourceRows.map((row) => row.source_id));
      expect(sourceIds.size).toBe(2);
    });

    it('a second run reaching the same conclusion is a corroboration, not a Conflict', async () => {
      const identity = { name: `corroborate-${randomUUID()}` };
      const otherIdentity = { name: `corroborate-target-${randomUUID()}` };

      const run1 = await spawnWorkerRun();
      const caller1: ResolvedCaller = { channel: 'handle', claims: run1.claims };
      const result1 = (await dispatchCapability({ pool }, caller1, 'report_task_result', {
        summary: 'run 1',
        factsToAssert: [
          {
            linkType: 'observed_state',
            source: { objectType: 'Host', identity },
            target: { objectType: 'Host', identity: otherIdentity },
            properties: { port: 80 },
          },
        ],
      })) as { factIds: string[] };
      const [factId1] = result1.factIds;
      if (!factId1) throw new Error('expected run 1 to write a fact id');

      const run2 = await spawnWorkerRun();
      const caller2: ResolvedCaller = { channel: 'handle', claims: run2.claims };
      const result2 = (await dispatchCapability({ pool }, caller2, 'report_task_result', {
        summary: 'run 2',
        factsToAssert: [
          {
            linkType: 'observed_state',
            source: { objectType: 'Host', identity },
            target: { objectType: 'Host', identity: otherIdentity },
            properties: { port: 80 }, // identical to run 1 — corroboration, not disagreement
          },
        ],
      })) as { factIds: string[] };
      // The wire result's factIds still name the first run's Fact — assertFact's `unchanged: true`
      // path returns the prior Fact rather than inserting a second one.
      expect(result2.factIds).toEqual([factId1]);

      const identityRow = await inTx(ownerId, async (client) => {
        const rows = await client.query<{
          link_type: string;
          source_object_id: string;
          target_object_id: string;
        }>(
          'select link_type, source_object_id, target_object_id from links where workspace_id = $1 and id = $2',
          [workspaceId, factId1],
        );
        return rows.rows[0];
      });
      if (!identityRow) throw new Error('expected fact1 to exist');

      const activeRows = await inTx(ownerId, async (client) => {
        const rows = await client.query<{ id: string }>(
          `select id from links
           where workspace_id = $1 and link_type = $2 and source_object_id = $3
             and target_object_id = $4 and superseded_at is null and invalidated_at is null`,
          [
            workspaceId,
            identityRow.link_type,
            identityRow.source_object_id,
            identityRow.target_object_id,
          ],
        );
        return rows.rows;
      });
      expect(activeRows).toHaveLength(1);

      const conflictRows = await inTx(ownerId, async (client) => {
        const rows = await client.query<{ id: string }>(
          'select id from conflicts where workspace_id = $1 and (link_a_id = $2 or link_b_id = $2)',
          [workspaceId, factId1],
        );
        return rows.rows;
      });
      expect(conflictRows).toHaveLength(0);
    });

    it('a run without sessionJsonlPath gets a workspace-visible worker_run Source with null uri', async () => {
      const { workerRunId, claims } = await spawnWorkerRun();
      const caller: ResolvedCaller = { channel: 'handle', claims };
      const identity = { name: `visibility-workspace-${randomUUID()}` };
      const otherIdentity = { name: `visibility-workspace-target-${randomUUID()}` };

      const result = (await dispatchCapability({ pool }, caller, 'report_task_result', {
        summary: 'no session jsonl',
        factsToAssert: [
          {
            linkType: 'observed_state',
            source: { objectType: 'Host', identity },
            target: { objectType: 'Host', identity: otherIdentity },
            properties: { note: 'workspace visible' },
          },
        ],
      })) as { activityId: string; factIds: string[] };

      const activityRow = await inTx(ownerId, async (client) => {
        const rows = await client.query<{ kind: string }>(
          'select kind from activities where workspace_id = $1 and id = $2',
          [workspaceId, result.activityId],
        );
        return rows.rows[0];
      });
      expect(activityRow?.kind).toBe('worker_result');

      const observationRows = await inTx(ownerId, async (client) => {
        const rows = await client.query<{ uri: string | null; visibility: string; kind: string }>(
          `select s.uri, s.visibility, s.kind
           from observations o
           join sources s on s.workspace_id = o.workspace_id and s.id = o.source_id
           where o.workspace_id = $1 and o.activity_id = $2`,
          [workspaceId, result.activityId],
        );
        return rows.rows;
      });
      expect(observationRows).toHaveLength(1);
      expect(observationRows[0]?.uri).toBeNull();
      expect(observationRows[0]?.visibility).toBe('workspace');
      expect(observationRows[0]?.kind).toBe('worker_run');

      // No private worker_session transcript Source was ever registered for this run.
      const sessionSourceRows = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const rows = await client.query<{ id: string }>(
            `select id from sources
             where workspace_id = $1 and kind = 'worker_session'
               and metadata->>'workerRunId' = $2`,
            [workspaceId, workerRunId],
          );
          return rows.rows;
        },
        { skipRoleSwitch: true },
      );
      expect(sessionSourceRows).toHaveLength(0);

      // Workspace-visibility Source -> the Fact is readable by any other principal in the
      // workspace, not only the on_behalf_of owner (`links_visibility`, migrations/core/0013).
      const [factId] = result.factIds;
      if (!factId) throw new Error('expected a written fact id');
      const otherId = await adminInsertPrincipal('member', `visibility-workspace-${factId}`);
      const seenByOther = await inTx(otherId, async (client) => {
        const rows = await client.query<{ id: string }>(
          'select id from links where workspace_id = $1 and id = $2',
          [workspaceId, factId],
        );
        return rows.rows;
      });
      expect(seenByOther).toHaveLength(1);
    });

    it('a run with sessionJsonlPath keeps the transcript private but its Facts workspace-visible', async () => {
      const { claims } = await spawnWorkerRun();
      const caller: ResolvedCaller = { channel: 'handle', claims };
      const identity = { name: `visibility-private-${randomUUID()}` };
      const otherIdentity = { name: `visibility-private-target-${randomUUID()}` };

      const result = (await dispatchCapability({ pool }, caller, 'report_task_result', {
        summary: 'has session jsonl',
        sessionJsonlPath: '/workspace/sessions/visibility-private.jsonl',
        factsToAssert: [
          {
            linkType: 'observed_state',
            source: { objectType: 'Host', identity },
            target: { objectType: 'Host', identity: otherIdentity },
            properties: { note: 'private' },
          },
        ],
      })) as { activityId: string; factIds: string[] };

      // The Fact's own Observation -> Source is the workspace-visible worker_run Source, with a
      // null uri and a pointer to the private transcript Source in its metadata.
      const observationRows = await inTx(ownerId, async (client) => {
        const rows = await client.query<{
          uri: string | null;
          visibility: string;
          kind: string;
          metadata: { transcriptSourceId?: string };
        }>(
          `select s.uri, s.visibility, s.kind, s.metadata
           from observations o
           join sources s on s.workspace_id = o.workspace_id and s.id = o.source_id
           where o.workspace_id = $1 and o.activity_id = $2`,
          [workspaceId, result.activityId],
        );
        return rows.rows;
      });
      expect(observationRows).toHaveLength(1);
      const [runSourceRow] = observationRows;
      expect(runSourceRow?.uri).toBeNull();
      expect(runSourceRow?.visibility).toBe('workspace');
      expect(runSourceRow?.kind).toBe('worker_run');
      const transcriptSourceId = runSourceRow?.metadata.transcriptSourceId;
      expect(typeof transcriptSourceId).toBe('string');
      // uuid shape
      expect(transcriptSourceId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );

      // The transcript Source itself: private, owned by ownerId, uri = the JSONL path. Read with
      // skipRoleSwitch — it's expected to be invisible under RLS to everyone but its owner.
      const transcriptSourceRow = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const rows = await client.query<{
            kind: string;
            visibility: string;
            uri: string | null;
            owner_principal_id: string;
          }>(
            'select kind, visibility, uri, owner_principal_id from sources where workspace_id = $1 and id = $2',
            [workspaceId, transcriptSourceId],
          );
          return rows.rows[0];
        },
        { skipRoleSwitch: true },
      );
      expect(transcriptSourceRow?.kind).toBe('worker_session');
      expect(transcriptSourceRow?.visibility).toBe('private');
      expect(transcriptSourceRow?.uri).toBe('/workspace/sessions/visibility-private.jsonl');
      expect(transcriptSourceRow?.owner_principal_id).toBe(ownerId);

      // The transcript Source is observed on its own worker_session Activity — pointing back at
      // this Fact's own worker_result Activity via metadata.resultActivityId — never on the
      // worker_result Activity itself: exactly one Observation sits on that Activity, and it's the
      // worker_run Source, not the transcript.
      const transcriptObservationRows = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const rows = await client.query<{
            activity_kind: string;
            activity_metadata: { resultActivityId?: string };
          }>(
            `select a.kind as activity_kind, a.metadata as activity_metadata
             from observations o
             join activities a on a.workspace_id = o.workspace_id and a.id = o.activity_id
             where o.workspace_id = $1 and o.source_id = $2`,
            [workspaceId, transcriptSourceId],
          );
          return rows.rows;
        },
        { skipRoleSwitch: true },
      );
      expect(transcriptObservationRows).toHaveLength(1);
      expect(transcriptObservationRows[0]?.activity_kind).toBe('worker_session');
      expect(transcriptObservationRows[0]?.activity_metadata.resultActivityId).toBe(
        result.activityId,
      );

      const factActivityObservationRows = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const rows = await client.query<{ source_id: string }>(
            'select source_id from observations where workspace_id = $1 and activity_id = $2',
            [workspaceId, result.activityId],
          );
          return rows.rows;
        },
        { skipRoleSwitch: true },
      );
      expect(factActivityObservationRows).toHaveLength(1);
      expect(factActivityObservationRows[0]?.source_id).not.toBe(transcriptSourceId);

      // Workspace-visible Fact -> another member principal can read it; the private transcript
      // Source stays invisible to them, while ownerId (its owner) can read it.
      const [factId] = result.factIds;
      if (!factId) throw new Error('expected a written fact id');
      const otherId = await adminInsertPrincipal('member', `visibility-private-${factId}`);
      const seenByOther = await inTx(otherId, async (client) => {
        const rows = await client.query<{ id: string }>(
          'select id from links where workspace_id = $1 and id = $2',
          [workspaceId, factId],
        );
        return rows.rows;
      });
      expect(seenByOther).toHaveLength(1);

      const transcriptSeenByOther = await inTx(otherId, async (client) => {
        const rows = await client.query<{ id: string }>(
          'select id from sources where workspace_id = $1 and id = $2',
          [workspaceId, transcriptSourceId],
        );
        return rows.rows;
      });
      expect(transcriptSeenByOther).toHaveLength(0);

      const transcriptSeenByOwner = await inTx(ownerId, async (client) => {
        const rows = await client.query<{ id: string }>(
          'select id from sources where workspace_id = $1 and id = $2',
          [workspaceId, transcriptSourceId],
        );
        return rows.rows;
      });
      expect(transcriptSeenByOwner).toHaveLength(1);
    });

    it('two runs on behalf of different principals reaching the same conclusion corroborate one workspace-visible Fact, no Conflict', async () => {
      // W5.5 follow-up: with the Fact's Source now always workspace-visible (regardless of
      // transcript), run B can see run A's Fact — `assertFact`'s corroboration branch returns the
      // prior Fact rather than writing a second one. (The hidden-prior branch — a caller that
      // cannot see the prior Fact — is now covered by sql-store.test.ts, not here.)
      const otherId = await adminInsertPrincipal('member', 'cross-principal-corroborator');
      const identity = { name: `cross-principal-${randomUUID()}` };
      const otherIdentity = { name: `cross-principal-target-${randomUUID()}` };

      const runA = await spawnWorkerRun(ownerId);
      const callerA: ResolvedCaller = { channel: 'handle', claims: runA.claims };
      const resultA = (await dispatchCapability({ pool }, callerA, 'report_task_result', {
        summary: 'run A',
        sessionJsonlPath: '/workspace/sessions/cross-principal-a.jsonl',
        factsToAssert: [
          {
            linkType: 'observed_state',
            source: { objectType: 'Host', identity },
            target: { objectType: 'Host', identity: otherIdentity },
            properties: { port: 80 },
          },
        ],
      })) as { factIds: string[] };
      const [factIdA] = resultA.factIds;
      if (!factIdA) throw new Error('expected run A to write a fact id');

      const runB = await spawnWorkerRun(otherId);
      const callerB: ResolvedCaller = { channel: 'handle', claims: runB.claims };
      const resultB = (await dispatchCapability({ pool }, callerB, 'report_task_result', {
        summary: 'run B',
        sessionJsonlPath: '/workspace/sessions/cross-principal-b.jsonl',
        factsToAssert: [
          {
            linkType: 'observed_state',
            source: { objectType: 'Host', identity },
            target: { objectType: 'Host', identity: otherIdentity },
            properties: { port: 80 }, // identical to run A, and now B can see A's workspace Fact
          },
        ],
      })) as { factIds: string[] };
      const [factIdB] = resultB.factIds;
      if (!factIdB) throw new Error('expected run B to write a fact id');
      expect(factIdB).toBe(factIdA);

      const activeRows = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const rows = await client.query<{ id: string }>(
            `select id from links
             where workspace_id = $1 and id = $2
               and superseded_at is null and invalidated_at is null`,
            [workspaceId, factIdA],
          );
          return rows.rows;
        },
        { skipRoleSwitch: true },
      );
      expect(activeRows).toHaveLength(1);

      const conflictRows = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const rows = await client.query<{ id: string }>(
            `select id from conflicts
             where workspace_id = $1 and (link_a_id = $2 or link_b_id = $2)`,
            [workspaceId, factIdA],
          );
          return rows.rows;
        },
        { skipRoleSwitch: true },
      );
      expect(conflictRows).toHaveLength(0);

      // B can read the corroborated Fact back (it's workspace-visible, and B is the caller of the
      // second run regardless).
      const seenByB = await inTx(otherId, async (client) => {
        const rows = await client.query<{ id: string }>(
          'select id from links where workspace_id = $1 and id = $2',
          [workspaceId, factIdB],
        );
        return rows.rows;
      });
      expect(seenByB).toHaveLength(1);
    });

    // S5.1 × S2.9 (2026-09-18 real-model docker_restart regression, STATUS §4 leftover 30's
    // second root cause): in `reject` mode an ontology refusal of ONE factsToAssert entry must not
    // take the whole contract down — see application/task/result.ts's module doc comment ("the one
    // partial outcome"). The suite's own hand-inserted workspace has no published ontology and is
    // therefore never enforced, so this block re-points the suite's shared variables at a
    // bootstrap-born workspace (reject mode, platform-meta seeded) with ops-assets v1 published —
    // every helper above closes over those three variables. Last in the file on purpose.
    describe('S5.1 reject mode: one refused fact is a partial outcome, not a lost result', () => {
      beforeAll(async () => {
        const created = await createWorkspaceWithOwner(pool, {
          name: `worker-result-reject-${randomUUID().slice(0, 8)}`,
          owner: { displayName: 'Reject Owner' },
          ontologyDir: ONTOLOGY_DIR,
        });
        workspaceId = created.workspaceId;
        ownerId = created.ownerPrincipalId;
        await inTx(ownerId, (client) =>
          publishOntologyDomainPack(client, workspaceId, {
            packName: 'ops-assets',
            fileName: 'ops-assets-v1.yaml',
            dir: ONTOLOGY_DIR,
            principalId: ownerId,
          }),
        );
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
      }, 120_000);

      // ops-assets v1 declares `runs_on` Container -> Host.
      const validFact = () => ({
        linkType: 'runs_on',
        source: { objectType: 'Container', identity: { containerId: randomUUID() } },
        target: { objectType: 'Host', identity: { hostname: `h-${randomUUID().slice(0, 8)}` } },
      });
      // The incident's shape: an undeclared LinkType from an undeclared endpoint type — the
      // endpoint upsert must roll back together with the refused Link.
      const refusedFact = (marker: string) => ({
        linkType: 'observed_state_of',
        source: { objectType: 'DocContainer', identity: { marker } },
        target: { objectType: 'Host', identity: { hostname: `h-${marker}` } },
      });

      it('reject: the refused entry is dropped and recorded, the rest lands, the Task completes', async () => {
        const { taskId, claims } = await spawnWorkerRun();
        const marker = randomUUID().slice(0, 8);
        const caller: ResolvedCaller = { channel: 'handle', claims };
        const result = (await dispatchCapability({ pool }, caller, 'report_task_result', {
          summary: 'restart requested',
          factsToAssert: [validFact(), refusedFact(marker)],
          evidence: [
            { kind: 'note', content: { text: 'for the valid one' }, factIndex: 0 },
            { kind: 'note', content: { text: 'for the refused one' }, factIndex: 1 },
          ],
        })) as { id: string; status: string; factIds: string[] };
        expect(result.id).toBe(taskId);
        expect(result.status).toBe('completed');
        expect(result.factIds).toHaveLength(1);

        const stored = await inTx(ownerId, async (client) => {
          const task = await client.query<{
            status: string;
            result: {
              factIds: string[];
              factsRejected: { index: number; reason: string; linkType: string }[];
            };
          }>('select status, result from tasks where workspace_id = $1 and id = $2', [
            workspaceId,
            taskId,
          ]);
          const orphans = await client.query<{ n: string }>(
            "select count(*)::text as n from objects where workspace_id = $1 and object_type = 'DocContainer'",
            [workspaceId],
          );
          const audit = await client.query<{ payload: { factIndex: number; reason: string } }>(
            "select payload from audit_records where workspace_id = $1 and action = 'task.result_fact_rejected' and resource_id = $2",
            [workspaceId, taskId],
          );
          const evidenceRows = await client.query<{ link_id: string }>(
            'select link_id from evidence where workspace_id = $1 and link_id = any($2::uuid[])',
            [workspaceId, result.factIds],
          );
          return {
            task: task.rows[0],
            orphans: orphans.rows[0]?.n,
            audit: audit.rows,
            evidenceRows: evidenceRows.rows,
          };
        });
        expect(stored.task?.status).toBe('completed');
        expect(stored.task?.result.factIds).toEqual(result.factIds);
        expect(stored.task?.result.factsRejected).toHaveLength(1);
        expect(stored.task?.result.factsRejected[0]).toMatchObject({
          index: 1,
          reason: 'undeclared_link_type',
          linkType: 'observed_state_of',
        });
        // The savepoint took the undeclared-type endpoint upsert with it.
        expect(stored.orphans).toBe('0');
        expect(stored.audit).toHaveLength(1);
        expect(stored.audit[0]?.payload).toMatchObject({
          factIndex: 1,
          reason: 'undeclared_link_type',
        });
        // Evidence aimed at the refused entry has nothing to attach to; the valid one keeps its row.
        expect(stored.evidenceRows).toHaveLength(1);
      });

      it('warn: both entries are written and the guard’s own ontology_violation row records the second', async () => {
        await inTx(ownerId, (client) =>
          client.query('update workspaces set ontology_enforcement = $2 where id = $1', [
            workspaceId,
            'warn',
          ]),
        );
        const { taskId, claims } = await spawnWorkerRun();
        const marker = randomUUID().slice(0, 8);
        const caller: ResolvedCaller = { channel: 'handle', claims };
        const result = (await dispatchCapability({ pool }, caller, 'report_task_result', {
          summary: 'warn mode',
          factsToAssert: [validFact(), refusedFact(marker)],
        })) as { status: string; factIds: string[] };
        expect(result.status).toBe('completed');
        expect(result.factIds).toHaveLength(2);

        const stored = await inTx(ownerId, async (client) => {
          const task = await client.query<{ result: { factsRejected: unknown[] } }>(
            'select result from tasks where workspace_id = $1 and id = $2',
            [workspaceId, taskId],
          );
          const warned = await client.query<{ n: string }>(
            "select count(*)::text as n from audit_records where workspace_id = $1 and action = 'ontology_violation' and payload->>'linkType' = 'observed_state_of'",
            [workspaceId],
          );
          return { task: task.rows[0], warned: warned.rows[0]?.n };
        });
        expect(stored.task?.result.factsRejected).toEqual([]);
        expect(Number(stored.warned)).toBeGreaterThanOrEqual(1);
      });

      // The handler's pre-write refusals (2026-09-18 second round: a model-invented `Gatekeeper`
      // ref → I16 403, a model-invented gatekeeperId in proposedOperations → 400; six Tasks lost
      // their result to them): each costs its own entry only, and I16 still never writes.
      it('pre-write refusals — meta-ontology ref, bogus gatekeeperId, out-of-range evidence — are recorded per entry and the Task completes', async () => {
        const { taskId, claims } = await spawnWorkerRun();
        const caller: ResolvedCaller = { channel: 'handle', claims };
        const bogusGatekeeperId = randomUUID();
        const result = (await dispatchCapability({ pool }, caller, 'report_task_result', {
          summary: 'command ran',
          factsToAssert: [
            validFact(),
            {
              linkType: 'requested_execution_on',
              source: { objectType: 'Task', identity: { description: 'run uptime' } },
              target: { objectType: 'Gatekeeper', identity: { name: 'ssh' } },
            },
          ],
          evidence: [
            { kind: 'note', content: { text: 'valid target' }, factIndex: 0 },
            { kind: 'note', content: { text: 'nowhere to attach' }, factIndex: 7 },
          ],
          proposedOperations: [
            {
              gatekeeperId: bogusGatekeeperId,
              operation: {
                name: `demo.op.${randomUUID().slice(0, 8)}`,
                binding: { kind: 'http', method: 'GET', path: '/uptime' },
                params_schema: {},
                mode: 'observe',
                blast_radius: 'low',
                reversibility: false,
                auto_approvable: true,
                await_decision: false,
                reads: [],
                writes: [],
              },
            },
          ],
        })) as { status: string; factIds: string[] };
        expect(result.status).toBe('completed');
        expect(result.factIds).toHaveLength(1);

        const stored = await inTx(ownerId, async (client) => {
          const task = await client.query<{
            result: {
              factsRejected: { index: number; reason: string }[];
              proposedOperationsRejected: { index: number; gatekeeperId: string; reason: string }[];
              evidenceDropped: number[];
            };
          }>('select result from tasks where workspace_id = $1 and id = $2', [workspaceId, taskId]);
          const metaObjects = await client.query<{ n: string }>(
            "select count(*)::text as n from objects where workspace_id = $1 and object_type in ('Task', 'Gatekeeper')",
            [workspaceId],
          );
          const audit = await client.query<{ action: string }>(
            "select action from audit_records where workspace_id = $1 and resource_id = $2 and action in ('task.result_fact_rejected', 'task.result_proposal_rejected') order by action",
            [workspaceId, taskId],
          );
          const evidenceRows = await client.query<{ n: string }>(
            'select count(*)::text as n from evidence where workspace_id = $1 and link_id = any($2::uuid[])',
            [workspaceId, result.factIds],
          );
          return {
            task: task.rows[0],
            metaObjects: metaObjects.rows[0]?.n,
            audit: audit.rows.map((row) => row.action),
            evidenceRows: evidenceRows.rows[0]?.n,
          };
        });
        expect(stored.task?.result.factsRejected).toEqual([
          expect.objectContaining({ index: 1, reason: 'meta_ontology_type' }),
        ]);
        expect(stored.task?.result.proposedOperationsRejected).toEqual([
          { index: 0, gatekeeperId: bogusGatekeeperId, reason: 'gatekeeper_not_found' },
        ]);
        expect(stored.task?.result.evidenceDropped).toEqual([1]);
        // I16: the meta-ontology-typed endpoints were never upserted.
        expect(stored.metaObjects).toBe('0');
        expect(stored.audit).toEqual([
          'task.result_fact_rejected',
          'task.result_proposal_rejected',
        ]);
        expect(stored.evidenceRows).toBe('1');
      });
    });
  },
);
