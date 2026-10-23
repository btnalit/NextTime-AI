import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type CapabilityScope, type HandleClaims, RunEnvironmentWireSchema } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import {
  type TaskRuntimeReport,
  type TaskSpawnInput,
  type TaskSpawnOutcome,
  type TaskSupervisorClientPort,
  TaskSupervisorError,
  type TaskSupervisorStatus,
} from '../../adapters/supervisor-client/index.js';
import {
  type IssuedHandle,
  entryScope,
  generateEphemeralHandleKeyPair,
  issueHandle,
} from '../../governance/capability/index.js';
import { toWireRunEnvironment } from '../gateway/attribution-handlers.js';
import { composeSystemPrompt } from '../platform/index.js';
import { proposeWorkerDefinition, publishWorkerDefinition } from '../worker/index.js';
import { readTaskAttributions } from './attribution.js';
import { invokeWorker } from './invoke.js';
import { readTaskRow } from './lifecycle.js';
import { RunSpecSchema, environmentDigest, sha256Hex, toRunRuntimeReport } from './run-fingerprint.js';
import type { TaskRuntimeDeps } from './runtime.js';

/**
 * application/task/run-fingerprint.integration.test: DB-gated (real Postgres; auto-skip without
 * DATABASE_URL) tests for S11 W1a 运行指纹 (migrations/task/0009_worker_run_fingerprint.sql): a
 * WorkerRun records what it was started with when it is created, what its container runs when it
 * starts, and neither ever changes. Same fake supervisor shape as invoke.integration.test.ts, with
 * a runtime report the way worker-supervisor sends one.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const DEFINITION_SYSTEM_PROMPT = 'You check one thing.';
const IMAGE_ID = `sha256:${'a'.repeat(64)}`;
const MODELS_DIGEST = `sha256:${'b'.repeat(64)}`;

class FakeTaskSupervisorClient implements TaskSupervisorClientPort {
  readonly spawnCalls: TaskSpawnInput[] = [];
  /** What `spawn` reports about the container; `undefined` = a supervisor that reports nothing. */
  runtime: TaskRuntimeReport | undefined = {
    imageRef: 'nexttime-ai-worker-runtime',
    imageId: IMAGE_ID,
    piVersion: '1.2.3',
    platformExtensionVersion: '0.50.0',
    builtFrom: 'v0.50.0 (abc1234)',
    modelsConfigDigest: MODELS_DIGEST,
  };
  failSpawn = false;

  async spawn(input: TaskSpawnInput): Promise<TaskSpawnOutcome> {
    this.spawnCalls.push(input);
    if (this.failSpawn) throw new TaskSupervisorError('http_error', 'POST /task/spawn returned 500');
    return {
      containerId: `container-${input.workerRunId}`,
      ip: '198.51.100.10',
      ...(this.runtime ? { runtime: this.runtime } : {}),
    };
  }

  async terminate(): Promise<boolean> {
    return true;
  }

  async status(): Promise<TaskSupervisorStatus | undefined> {
    return undefined;
  }
}

interface FingerprintRow {
  status: string;
  run_spec: unknown;
  runtime_report: unknown;
  environment_digest: string | null;
}

describe.runIf(DATABASE_URL !== undefined)(
  'S11 W1a run fingerprint — integration (real Postgres)',
  () => {
    let pool: Pool;
    let privateKey: Awaited<ReturnType<typeof generateEphemeralHandleKeyPair>>['privateKey'];
    let workspaceId: string;
    let ownerId: string;
    let definitionId: string;
    let previousKernelVersion: string | undefined;

    async function adminInsertPrincipal(role: string): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: id },
        (client) =>
          client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', $3, $3)",
            [workspaceId, id, role],
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
      const issued: IssuedHandle = await inTx(principalId, (client) =>
        issueHandle(client, { sessionId, scope: entryScope(), ttlSeconds: 3600, privateKey }),
      );
      return {
        ws: issued.workspaceId,
        sid: issued.sessionId,
        obo: issued.onBehalfOf,
        scope: issued.scope as CapabilityScope,
        jti: issued.jti,
        iat: Math.floor(issued.issuedAt.getTime() / 1000),
        exp: Math.floor(issued.expiresAt.getTime() / 1000),
      };
    }

    async function publish(definition: Record<string, unknown>): Promise<string> {
      const proposed = await inTx(ownerId, (client) =>
        proposeWorkerDefinition(client, workspaceId, ownerId, { kind: 'worker', definition }),
      );
      await inTx(ownerId, (client) =>
        publishWorkerDefinition(client, workspaceId, ownerId, {
          definitionId: proposed.id,
          version: proposed.version,
        }),
      );
      return proposed.id;
    }

    async function invoke(supervisorClient: FakeTaskSupervisorClient, id = definitionId) {
      const deps: TaskRuntimeDeps = { pool, privateKey, supervisorClient };
      return invokeWorker(
        workspaceId,
        { principalId: ownerId, channel: 'handle', claims: await entryClaims(ownerId) },
        { definitionId: id, version: 1, input: {}, wait: false },
        deps,
      );
    }

    async function fingerprintOf(workerRunId: string): Promise<FingerprintRow> {
      const result = await inTx(ownerId, (client) =>
        client.query<FingerprintRow>(
          `select status, run_spec, runtime_report, environment_digest from worker_runs
           where workspace_id = $1 and id = $2`,
          [workspaceId, workerRunId],
        ),
      );
      const row = result.rows[0];
      if (!row) throw new Error(`no worker run ${workerRunId}`);
      return row;
    }

    async function attempt(sql: string, params: unknown[]): Promise<unknown> {
      return inTx(ownerId, (client) => client.query(sql, params)).then(
        () => null,
        (err: unknown) => err,
      );
    }

    beforeAll(async () => {
      previousKernelVersion = process.env.KERNEL_VERSION;
      process.env.KERNEL_VERSION = 'v0.50.0 (abc1234)';
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
            'run-fingerprint-integration-test',
          ]),
        { skipRoleSwitch: true },
      );
      ownerId = await adminInsertPrincipal('owner');
      definitionId = await publish({
        systemPrompt: DEFINITION_SYSTEM_PROMPT,
        model: 'anthropic/model-a',
      });
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
      if (previousKernelVersion === undefined) delete process.env.KERNEL_VERSION;
      else process.env.KERNEL_VERSION = previousKernelVersion;
      await pool.end();
    });

    it('records what the run was started with and what its container runs, and reads them back on the Task', async () => {
      const supervisor = new FakeTaskSupervisorClient();
      const spawned = await invoke(supervisor);

      const row = await fingerprintOf(spawned.workerRunId);
      expect(row.status).toBe('running');
      const spec = RunSpecSchema.parse(row.run_spec);
      const sent = supervisor.spawnCalls[0];
      // Exactly what was forwarded to the supervisor — the prompt only as its digest.
      expect(spec).toEqual({
        v: 1,
        definition: { id: definitionId, version: 1 },
        model: 'anthropic/model-a',
        image: sent?.image ?? null,
        systemPromptDigest: sha256Hex(sent?.systemPrompt as string),
        kernelVersion: 'v0.50.0 (abc1234)',
      });
      expect(sent?.model).toBe('anthropic/model-a');
      expect(sent?.systemPrompt).toBe(
        composeSystemPrompt({ base: DEFINITION_SYSTEM_PROMPT, instanceInstructions: undefined }),
      );
      expect(JSON.stringify(row.run_spec)).not.toContain(DEFINITION_SYSTEM_PROMPT);

      const runtime = toRunRuntimeReport(supervisor.runtime as TaskRuntimeReport);
      expect(row.runtime_report).toEqual(runtime);
      expect(row.environment_digest).toBe(environmentDigest(spec, runtime));
      expect(row.environment_digest).toMatch(/^v1:[0-9a-f]{64}$/);

      const attributions = await inTx(ownerId, async (client) => {
        const task = await readTaskRow(client, workspaceId, spawned.taskId);
        if (!task) throw new Error('task missing');
        return readTaskAttributions(client, workspaceId, [task], [spawned.workerRunId]);
      });
      const wire = RunEnvironmentWireSchema.parse(
        toWireRunEnvironment(attributions.environmentByRun.get(spawned.workerRunId)),
      );
      expect(wire).toEqual({
        definition: { id: definitionId, version: 1 },
        model: 'anthropic/model-a',
        image: spec.image,
        systemPromptDigest: spec.systemPromptDigest,
        kernelVersion: 'v0.50.0 (abc1234)',
        runtime: {
          imageRef: 'nexttime-ai-worker-runtime',
          imageId: IMAGE_ID,
          piVersion: '1.2.3',
          platformExtensionVersion: '0.50.0',
          builtFrom: 'v0.50.0 (abc1234)',
          modelsConfigDigest: MODELS_DIGEST,
        },
        environmentDigest: row.environment_digest,
      });
    });

    it('a run that named no model is grouped by the models.json pi took its default from', async () => {
      const defaultModel = await publish({ systemPrompt: DEFINITION_SYSTEM_PROMPT });
      // The requester has no agent profile naming one either.
      const supervisor = new FakeTaskSupervisorClient();
      const withDigest = await fingerprintOf((await invoke(supervisor, defaultModel)).workerRunId);
      expect(RunSpecSchema.parse(withDigest.run_spec).model).toBeNull();
      expect(withDigest.environment_digest).toMatch(/^v1:/);

      supervisor.runtime = {
        ...(supervisor.runtime as TaskRuntimeReport),
        modelsConfigDigest: undefined,
      };
      const unread = await fingerprintOf((await invoke(supervisor, defaultModel)).workerRunId);
      expect(unread.runtime_report).toMatchObject({ imageId: IMAGE_ID, modelsConfigDigest: null });
      expect(unread.environment_digest).toBeNull();
    });

    it('a supervisor that reports nothing, or a run that never started, leaves the runtime unrecorded', async () => {
      const silent = new FakeTaskSupervisorClient();
      silent.runtime = undefined;
      const quiet = await fingerprintOf((await invoke(silent)).workerRunId);
      expect(quiet.status).toBe('running');
      expect(RunSpecSchema.safeParse(quiet.run_spec).success).toBe(true);
      expect(quiet.runtime_report).toBeNull();
      expect(quiet.environment_digest).toBeNull();

      const failing = new FakeTaskSupervisorClient();
      failing.failSpawn = true;
      await invoke(failing).catch(() => undefined);
      const runId = failing.spawnCalls[0]?.workerRunId as string;
      const never = await fingerprintOf(runId);
      expect(never.status).toBe('terminated');
      expect(RunSpecSchema.safeParse(never.run_spec).success).toBe(true);
      expect(never.runtime_report).toBeNull();
    });

    it('the database refuses to change a recorded fingerprint, or to record a runtime outside the run’s start', async () => {
      const spawned = await invoke(new FakeTaskSupervisorClient());
      const runId = spawned.workerRunId;

      expect(
        await attempt(
          `update worker_runs set run_spec = jsonb_set(run_spec, '{model}', '"other"')
           where workspace_id = $1 and id = $2`,
          [workspaceId, runId],
        ),
      ).toMatchObject({ message: expect.stringMatching(/never change/) });
      expect(
        await attempt(
          `update worker_runs set runtime_report = jsonb_set(runtime_report, '{imageId}', '"x"')
           where workspace_id = $1 and id = $2`,
          [workspaceId, runId],
        ),
      ).toMatchObject({ message: expect.stringMatching(/never change/) });
      expect(
        await attempt(
          `update worker_runs set environment_digest = $3 where workspace_id = $1 and id = $2`,
          [workspaceId, runId, `v1:${'0'.repeat(64)}`],
        ),
      ).toMatchObject({ message: expect.stringMatching(/never change/) });
      // A run's later moves leave it as it is.
      expect(
        await attempt(
          `update worker_runs set status = 'terminated', terminated_at = now()
           where workspace_id = $1 and id = $2`,
          [workspaceId, runId],
        ),
      ).toBeNull();

      // A run still provisioning cannot be given a runtime except by starting it.
      const provisioning = await inTx(ownerId, async (client) => {
        const result = await client.query<{ id: string }>(
          `insert into worker_runs (workspace_id, status, task_id, depth, attempt, run_spec)
           values ($1, 'provisioning', $2, 1, 1, $3::jsonb) returning id`,
          [workspaceId, spawned.taskId, JSON.stringify(RunSpecSchema.parse((await fingerprintOf(runId)).run_spec))],
        );
        return result.rows[0]?.id as string;
      });
      const report = JSON.stringify(toRunRuntimeReport(new FakeTaskSupervisorClient().runtime as TaskRuntimeReport));
      expect(
        await attempt(
          `update worker_runs set runtime_report = $3::jsonb where workspace_id = $1 and id = $2`,
          [workspaceId, provisioning, report],
        ),
      ).toMatchObject({ message: expect.stringMatching(/only as it starts/) });
      expect(
        await attempt(
          `update worker_runs set status = 'running', runtime_report = $3::jsonb
           where workspace_id = $1 and id = $2`,
          [workspaceId, provisioning, report],
        ),
      ).toBeNull();

      // A run with no spec of its own cannot carry a runtime or an environment.
      expect(
        await attempt(
          `insert into worker_runs (workspace_id, status, task_id, depth, attempt, runtime_report)
           values ($1, 'running', $2, 1, 1, $3::jsonb)`,
          [workspaceId, spawned.taskId, report],
        ),
      ).toMatchObject({ message: expect.stringMatching(/worker_runs_runtime_report_object/) });
      expect(
        await attempt(
          `insert into worker_runs (workspace_id, status, task_id, depth, attempt, run_spec,
             environment_digest)
           values ($1, 'running', $2, 1, 1, '{}'::jsonb, $3)`,
          [workspaceId, spawned.taskId, `v1:${'0'.repeat(64)}`],
        ),
      ).toMatchObject({ message: expect.stringMatching(/worker_runs_environment_digest/) });
    });

    it('a run from before W1a reads 未记录 (null)', async () => {
      const spawned = await invoke(new FakeTaskSupervisorClient());
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
        return readTaskAttributions(client, workspaceId, [task], [spawned.workerRunId, legacyRunId]);
      });
      expect(attributions.environmentByRun.get(legacyRunId)).toBeNull();
      expect(toWireRunEnvironment(attributions.environmentByRun.get(legacyRunId))).toBeNull();
      expect(attributions.environmentByRun.get(spawned.workerRunId)).not.toBeNull();
    });
  },
);
