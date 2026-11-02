import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HandleClaims } from '@nexttime/shared';
import Fastify from 'fastify';
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
import type { LlmUsageRecord } from '../../governance/llm-usage/index.js';
import { registerLlmUsageRoutes } from '../../interfaces/http/internal/llm-usage.js';
import { invokeWorker, readWorkerRunRow } from '../task/index.js';
import type { TaskRuntimeDeps } from '../task/runtime.js';
import { proposeWorkerDefinition, publishWorkerDefinition } from '../worker/index.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * Legacy 589 (real Postgres; auto-skip without DATABASE_URL): a Worker whose every model call
 * llm-proxy refused for the workspace budget reports a result its model never wrote (worker mode's
 * `agent_settled` fallback). The refusals reach the kernel as `refused` usage records through the
 * real `/internal/llm-usage` route, before llm-proxy answers the 402 (llm-proxy report.ts
 * `deliver`); `report_task_result` then fails the Task `model_refused` instead of completing it.
 *
 * Also locks what happens when the record did *not* arrive first (llm-proxy's 5 s delivery
 * timeout, `refusal_delivery_timeouts_total`): the report is judged as before — the Task completes
 * with what was sent — and the late refused record changes nothing about the ended Task.
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
  'report_task_result after refused model calls (legacy 589) — integration (real Postgres)',
  () => {
    let pool: Pool;
    let privateKey: Awaited<ReturnType<typeof generateEphemeralHandleKeyPair>>['privateKey'];
    let workspaceId: string;
    let ownerId: string;
    let workerDefinitionId: string;
    let app: Awaited<ReturnType<typeof Fastify>>;

    async function inTx<T>(
      principalId: string,
      fn: (client: PoolClient) => Promise<T>,
    ): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId }, fn);
    }

    async function asAdmin<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, fn, {
        skipRoleSwitch: true,
      });
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      privateKey = (await generateEphemeralHandleKeyPair()).privateKey;
      workspaceId = randomUUID();
      ownerId = randomUUID();
      await asAdmin(async (client) => {
        await client.query('insert into workspaces (id, name) values ($1, $2)', [
          workspaceId,
          'model-refusal-integration-test',
        ]);
        await client.query(
          "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'owner', 'owner')",
          [workspaceId, ownerId],
        );
      });
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
      app = Fastify();
      await registerLlmUsageRoutes(app, { pool });
    });

    afterAll(async () => {
      await app?.close();
      await pool.end();
    });

    /** A fresh entry session invokes the plain worker (wait: false); returns the WorkerRun's own
     *  minted claims, as `worker-result.integration.test.ts` does. */
    async function spawnWorkerRun(): Promise<{
      taskId: string;
      workerRunId: string;
      claims: HandleClaims;
    }> {
      const entrySessionId = await inTx(ownerId, async (client) => {
        const result = await client.query<{ id: string }>(
          `insert into sessions (workspace_id, principal_id, kind, on_behalf_of, status)
           values ($1, $2, 'entry', $2, 'active') returning id`,
          [workspaceId, ownerId],
        );
        return result.rows[0]?.id as string;
      });
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
      const deps: TaskRuntimeDeps = {
        pool,
        privateKey,
        supervisorClient: new FakeTaskSupervisorClient(),
      };
      const invoked = await invokeWorker(
        workspaceId,
        { principalId: ownerId, channel: 'handle', claims: entryClaims },
        { definitionId: workerDefinitionId, version: 1, input: { foo: 'bar' }, wait: false },
        deps,
      );
      const workerRun = await inTx(ownerId, (client) =>
        readWorkerRunRow(client, workspaceId, invoked.workerRunId),
      );
      if (!workerRun?.sessionId) throw new Error('spawned WorkerRun has no session');
      const handle = await inTx(ownerId, async (client) => {
        const result = await client.query<{
          jti: string;
          on_behalf_of: string;
          scope: HandleClaims['scope'];
          expires_at: Date;
        }>(
          'select jti, on_behalf_of, scope, expires_at from capability_handles where workspace_id = $1 and session_id = $2',
          [workspaceId, workerRun.sessionId],
        );
        return result.rows[0];
      });
      if (!handle) throw new Error('no Handle for the WorkerRun session');
      return {
        taskId: invoked.taskId,
        workerRunId: invoked.workerRunId,
        claims: {
          ws: workspaceId,
          sid: workerRun.sessionId,
          obo: handle.on_behalf_of,
          scope: handle.scope,
          jti: handle.jti,
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(new Date(handle.expires_at).getTime() / 1000),
        },
      };
    }

    let clock = Date.now();
    /** One usage record of the WorkerRun's session, as llm-proxy sends it. Distinct start times:
     *  `(workspace_id, jti, started_at)` is unique. */
    function usage(claims: HandleClaims, overrides: Partial<LlmUsageRecord>): LlmUsageRecord {
      clock += 1000;
      return {
        workspaceId,
        sessionId: claims.sid,
        jti: claims.jti,
        provider: 'example-provider',
        model: 'example-model',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        startedAt: new Date(clock).toISOString(),
        finishedAt: new Date(clock + 5).toISOString(),
        status: 'refused',
        refusalScope: 'workspace_daily_tokens',
        requestId: randomUUID(),
        ...overrides,
      };
    }

    async function ingest(records: LlmUsageRecord[]): Promise<void> {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/llm-usage',
        payload: records,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().result.groups).toEqual([
        { workspaceId, outcome: 'recorded', inserted: records.length, rejected: 0 },
      ]);
    }

    /** What worker mode's `agent_settled` fallback posts when the model never answered. */
    async function reportSynthesized(claims: HandleClaims) {
      const caller: ResolvedCaller = { channel: 'handle', claims };
      return (await dispatchCapability({ pool }, caller, 'report_task_result', {
        summary: '',
        findings: ['found something'],
        factsToAssert: [
          {
            linkType: 'observed_state',
            source: { objectType: 'Host', identity: { name: `refused-${claims.sid}` } },
            target: { objectType: 'Host', identity: { name: 'host-b' } },
          },
        ],
      })) as { id: string; status: string; activityId: string; factIds: string[] };
    }

    async function readState(taskId: string, workerRunId: string, jti: string) {
      return asAdmin(async (client) => {
        const task = await client.query<{
          status: string;
          failure_reason: string | null;
          result: unknown;
          tokens_used: string;
        }>(
          'select status, failure_reason, result, tokens_used from tasks where workspace_id = $1 and id = $2',
          [workspaceId, taskId],
        );
        const run = await client.query<{ status: string }>(
          'select status from worker_runs where workspace_id = $1 and id = $2',
          [workspaceId, workerRunId],
        );
        const handle = await client.query<{ revoked_at: Date | null }>(
          'select revoked_at from capability_handles where workspace_id = $1 and jti = $2',
          [workspaceId, jti],
        );
        const audit = await client.query<{ payload: Record<string, unknown> }>(
          `select payload from audit_records
            where workspace_id = $1 and action = 'report_task_result' and resource_id = $2`,
          [workspaceId, taskId],
        );
        const terminate = await client.query<{ payload: Record<string, unknown> }>(
          `select payload from audit_records
            where workspace_id = $1 and action = 'worker_run.terminate' and resource_id = $2`,
          [workspaceId, workerRunId],
        );
        return {
          task: task.rows[0],
          run: run.rows[0],
          handle: handle.rows[0],
          audit: audit.rows.map((row) => row.payload),
          terminate: terminate.rows.map((row) => row.payload),
        };
      });
    }

    it('every call refused: the Task fails model_refused, the WorkerRun ends, nothing of the report is stored', async () => {
      const { taskId, workerRunId, claims } = await spawnWorkerRun();
      await ingest([usage(claims, {}), usage(claims, { refusalScope: 'workspace_daily_cost' })]);

      const result = await reportSynthesized(claims);
      expect(result).toEqual({
        id: taskId,
        status: 'failed',
        activityId: expect.any(String),
        factIds: [],
      });

      const state = await readState(taskId, workerRunId, claims.jti);
      expect(state.task).toMatchObject({
        status: 'failed',
        failure_reason: 'model_refused',
        result: null,
      });
      // A refusal metered nothing: the Task's token count is untouched.
      expect(Number(state.task?.tokens_used)).toBe(0);
      expect(state.run?.status).toBe('terminated');
      expect(state.handle?.revoked_at).not.toBeNull();
      expect(state.terminate).toEqual([expect.objectContaining({ reason: 'model_refused' })]);
      // The latest refusal names the budget.
      expect(state.audit).toEqual([
        expect.objectContaining({
          modelRefused: { scope: 'workspace_daily_cost', refusedCalls: 2 },
        }),
      ]);
      // No `worker_result` Activity, so no Fact of the report was written.
      const written = await asAdmin(async (client) =>
        client.query(
          `select 1 from activities
            where workspace_id = $1 and kind = 'worker_result' and metadata ->> 'taskId' = $2`,
          [workspaceId, taskId],
        ),
      );
      expect(written.rowCount).toBe(0);
    });

    it("one call answered before the budget ran out: the report is the Worker's and completes the Task", async () => {
      const { taskId, workerRunId, claims } = await spawnWorkerRun();
      await ingest([
        usage(claims, {
          status: 'completed',
          refusalScope: undefined,
          inputTokens: 100,
          outputTokens: 20,
        }),
        usage(claims, {}),
      ]);
      const result = await reportSynthesized(claims);
      expect(result.status).toBe('completed');
      const state = await readState(taskId, workerRunId, claims.jti);
      expect(state.task?.status).toBe('completed');
      // Only the answered call counts toward the Task's budget.
      expect(Number(state.task?.tokens_used)).toBe(120);
      expect(state.audit[0]).not.toHaveProperty('modelRefused');
      const written = await asAdmin(async (client) =>
        client.query(
          `select 1 from activities
            where workspace_id = $1 and kind = 'worker_result' and metadata ->> 'taskId' = $2`,
          [workspaceId, taskId],
        ),
      );
      expect(written.rowCount).toBe(1);
    });

    it('an upstream error is not a refusal: error rows alone leave the result as reported', async () => {
      const { taskId, workerRunId, claims } = await spawnWorkerRun();
      await ingest([usage(claims, { status: 'error', refusalScope: undefined })]);
      expect((await reportSynthesized(claims)).status).toBe('completed');
      expect((await readState(taskId, workerRunId, claims.jti)).task?.status).toBe('completed');
    });

    it('a refusal record that arrives after the report (llm-proxy delivery timeout) leaves the ended Task as it is', async () => {
      const { taskId, workerRunId, claims } = await spawnWorkerRun();
      // The report beats the record: judged as before the fix — the Task completes.
      expect((await reportSynthesized(claims)).status).toBe('completed');
      await ingest([usage(claims, {})]);
      const state = await readState(taskId, workerRunId, claims.jti);
      expect(state.task).toMatchObject({ status: 'completed', failure_reason: null });
      const stored = await asAdmin(async (client) =>
        client.query<{ status: string; refusal_scope: string }>(
          'select status, refusal_scope from llm_usage where workspace_id = $1 and session_id = $2',
          [workspaceId, claims.sid],
        ),
      );
      expect(stored.rows).toEqual([{ status: 'refused', refusal_scope: 'workspace_daily_tokens' }]);
    });

    it('the ingest schema refuses a refused record with tokens, or without its scope, and a scope on any other status', async () => {
      const { claims } = await spawnWorkerRun();
      for (const bad of [
        usage(claims, { inputTokens: 1 }),
        usage(claims, { costUsd: 0.01 }),
        usage(claims, { refusalScope: undefined }),
        usage(claims, { status: 'completed' }),
      ]) {
        const res = await app.inject({
          method: 'POST',
          url: '/internal/llm-usage',
          payload: [bad],
        });
        expect(res.statusCode).toBe(400);
      }
    });

    it('the table holds the same invariant (llm-usage/0003 llm_usage_refusal)', async () => {
      const { claims } = await spawnWorkerRun();
      const insert = (status: string, scope: string | null, input: number) =>
        asAdmin(async (client) => {
          clock += 1000;
          const startedAt = new Date(clock);
          await client.query('savepoint probe');
          try {
            await client.query(
              `insert into llm_usage (workspace_id, session_id, jti, provider, model, input_tokens,
                 output_tokens, cost_usd, started_at, status, refusal_scope)
               values ($1, $2, $3, 'p', 'm', $4, 0, 0, $5, $6, $7)`,
              [workspaceId, claims.sid, claims.jti, input, startedAt, status, scope],
            );
            return 'inserted';
          } catch (err) {
            await client.query('rollback to savepoint probe');
            return (err as { constraint?: string }).constraint ?? String(err);
          }
        });
      expect(await insert('refused', 'workspace_daily_tokens', 0)).toBe('inserted');
      expect(await insert('refused', null, 0)).toBe('llm_usage_refusal');
      expect(await insert('refused', 'workspace_daily_tokens', 5)).toBe('llm_usage_refusal');
      expect(await insert('refused', 'some_other_budget', 0)).toBe('llm_usage_refusal');
      expect(await insert('completed', 'workspace_daily_tokens', 5)).toBe('llm_usage_refusal');
      expect(await insert('completed', null, 5)).toBe('inserted');
    });
  },
);
