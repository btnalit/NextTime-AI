import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EvalCaseWire, EvalSuiteWire, HandleClaims, Operation } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import {
  importManifest,
  publishOperation,
  registerGatekeeper,
} from '../../governance/gatekeepers/index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { SqlGraphStore } from '../../substrate/graph/index.js';
import {
  EVALUATION_WITHHELD_ACTION,
  EvaluationContentWithheldError,
  resetEvaluationSealForTests,
} from '../eval-seal/index.js';
import type { AgentRuntimeEvent } from '../host-bridge/agent-runtime.js';
import { AgentHostRuntime } from '../host-bridge/index.js';
import { completeTaskWithResult } from '../task/lifecycle.js';
import { configureTaskRuntime, resetTaskRuntimeForTests } from '../task/runtime.js';
import { proposeWorkerDefinition, publishWorkerDefinition } from '../worker/index.js';
import type { CapabilityHandler } from './capability-handler.js';
import { UNCHECKED_ERROR_MESSAGE, dispatchCapability } from './dispatch.js';
import { CAPABILITY_HANDLERS } from './handlers.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/eval-seal.integration.test: DB-gated (real Postgres; auto-skip without
 * DATABASE_URL) — S10 E3-1c, the evaluation seal (I-E4 评测对人透明、对 agent 封闭) on each way
 * evaluation content could reach an agent: a capability's result or error to a Handle (in the
 * call's own transaction, and after commit for `invoke_worker`'s `wait`), what a Worker starts
 * with, a person's chat message to the entry agent, and what the entry agent starts a Turn with.
 * Each refusal answers 403 `evaluation_content_withheld` (a Turn's start ends the Turn failed) and
 * writes one `evaluation.content_withheld` audit row; neither — nor anything logged — holds the
 * run of text that matched, the case, the suite, or its canary. Development cases, short runs and
 * a fixture rule's answer pass, a case added later is sealed from then on, a retired holdout case
 * stays sealed, and a person still reads every case in full.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

const HOLDOUT_TITLE = 'Quokka pool drain before rotation';
const HOLDOUT_INPUT =
  'Drain the zephyr-quokka pool on rack nine before rotating its relay keys, then confirm the heartbeat.';
/** A 40-character run of the holdout input, disguised the ways normalizing folds. */
const DISGUISED_RUN = 'ZEPHYR-QUOKKA   pool on\nRACK ｎｉｎｅ before rotating';
const DEV_INPUT = 'Restart the web-1 container if it is not answering on its health port today.';
/** Every piece a refusal must never carry (filled in once the suite exists). */
const NEVER_SHOWN: string[] = ['zephyr', 'quokka', 'rack nine', 'relay keys', HOLDOUT_TITLE];

/** In-memory supervisor: every spawn starts `running` and is recorded. */
class FakeSupervisor implements TaskSupervisorClientPort {
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
}

function operation(name: string): Operation {
  return {
    name,
    description: `reads ${name}`,
    binding: { kind: 'http', method: 'GET', path: `/${name}` },
    params_schema: { type: 'object', properties: { host: { type: 'string' } } },
    mode: 'observe',
    blast_radius: 'low',
    reversibility: false,
    auto_approvable: true,
    await_decision: false,
    reads: [],
    writes: [],
  };
}

describe.runIf(DATABASE_URL !== undefined)(
  'evaluation seal (S10 E3-1c, integration, real Postgres)',
  () => {
    let pool: Pool;
    let privateKey: Awaited<ReturnType<typeof generateEphemeralHandleKeyPair>>['privateKey'];
    let workspaceId: string;
    const ownerId = randomUUID();
    const builderId = randomUUID();
    let workerDefinitionId: string;
    let gate: string;
    let suite: EvalSuiteWire;
    let holdoutCaseId: string;
    const supervisor = new FakeSupervisor();
    const store = new SqlGraphStore();

    function person(id: string, role: 'owner' | 'builder'): ResolvedCaller {
      return {
        channel: 'human',
        principal: { workspaceId, id, kind: 'human', role, displayName: null },
        session: {
          workspaceId,
          id: randomUUID(),
          principalId: id,
          kind: 'web',
          onBehalfOf: id,
          status: 'active',
          createdAt: new Date(),
          expiresAt: null,
        },
      };
    }

    /** The owner's entry agent, on a real session and Handle. */
    async function ownerAgent(): Promise<ResolvedCaller> {
      const sessionId = await asApp(async (client) => {
        const result = await client.query<{ id: string }>(
          `insert into sessions (workspace_id, principal_id, kind, on_behalf_of, status)
           values ($1, $2, 'entry', $2, 'active') returning id`,
          [workspaceId, ownerId],
        );
        return result.rows[0]?.id as string;
      });
      const issued = await asApp((client) =>
        issueHandle(client, { sessionId, scope: entryScope(), ttlSeconds: 600, privateKey }),
      );
      const claims: HandleClaims = {
        ws: issued.workspaceId,
        sid: issued.sessionId,
        obo: issued.onBehalfOf,
        scope: issued.scope,
        jti: issued.jti,
        iat: Math.floor(issued.issuedAt.getTime() / 1000),
        exp: Math.floor(issued.expiresAt.getTime() / 1000),
      };
      return { channel: 'handle', claims };
    }

    async function asApp<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, fn);
    }

    async function call<T>(who: ResolvedCaller, capability: string, params: unknown): Promise<T> {
      return (await dispatchCapability({ pool }, who, capability, params)) as T;
    }

    async function refusal(promise: Promise<unknown>): Promise<EvaluationContentWithheldError> {
      const err = await promise.then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(EvaluationContentWithheldError);
      return err as EvaluationContentWithheldError;
    }

    /** An Object whose properties hold `note` — what an agent's `get_object` reads back. */
    async function objectHolding(note: string): Promise<string> {
      return asApp(async (client) => {
        const object = await store.upsertObject(client, workspaceId, {
          objectType: 'test.note',
          identity: { key: randomUUID() },
          properties: { note },
        });
        return object.id;
      });
    }

    async function sealRows(): Promise<
      Array<{
        actor_principal_id: string;
        resource_type: string | null;
        resource_id: string | null;
        payload: Record<string, unknown>;
        whole: string;
      }>
    > {
      return asApp(async (client) => {
        const result = await client.query(
          `select actor_principal_id, resource_type, resource_id, payload, row_to_json(a)::text as whole
             from audit_records a where workspace_id = $1 and action = $2 order by created_at, id`,
          [workspaceId, EVALUATION_WITHHELD_ACTION],
        );
        return result.rows;
      });
    }

    function expectNothingOf(text: string): void {
      const lowered = text.toLowerCase();
      for (const piece of NEVER_SHOWN) expect(lowered).not.toContain(piece.toLowerCase());
    }

    /** Every console line written while a test runs, to prove the seal logs no content. */
    let logged: string[];
    beforeEach(() => {
      logged = [];
      for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
        vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
          logged.push(
            args.map((arg) => (arg instanceof Error ? arg.stack : String(arg))).join(' '),
          );
        });
      }
    });
    afterEach(() => {
      vi.restoreAllMocks();
      for (const line of logged) expectNothingOf(line);
    });

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      resetEvaluationSealForTests();
      privateKey = (await generateEphemeralHandleKeyPair()).privateKey;
      workspaceId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'e3-1c-eval-seal',
          ]);
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name)
             values ($1, $2, 'human', 'owner', 'owner'), ($1, $3, 'human', 'builder', 'builder')`,
            [workspaceId, ownerId, builderId],
          );
        },
        { skipRoleSwitch: true },
      );
      const proposed = await asApp((client) =>
        proposeWorkerDefinition(client, workspaceId, ownerId, {
          kind: 'worker',
          definition: { systemPrompt: 'You are a plain worker.' },
        }),
      );
      await asApp((client) =>
        publishWorkerDefinition(client, workspaceId, ownerId, {
          definitionId: proposed.id,
          version: proposed.version,
        }),
      );
      workerDefinitionId = proposed.id;

      gate = await asApp(async (client) => {
        const activity = await startActivity(client, workspaceId, {
          kind: 'test.connection',
          principalId: ownerId,
        });
        const registered = await registerGatekeeper(client, workspaceId, {
          name: 'hosts',
          transportKind: 'http',
          target: 'hosts-system',
          endpoint: 'http://hosts.invalid',
          activityId: activity.id,
          registeredBy: { id: ownerId, kind: 'human' },
        });
        await importManifest(client, workspaceId, {
          gatekeeperId: registered.gatekeeperId,
          operations: [operation('hosts.list')],
          proposedBy: { id: ownerId, kind: 'human' },
          activityId: activity.id,
        });
        await publishOperation(client, workspaceId, {
          gatekeeperId: registered.gatekeeperId,
          name: 'hosts.list',
          actor: { principalId: ownerId, role: 'owner' },
        });
        return registered.gatekeeperId;
      });

      const created = await call<EvalSuiteWire>(person(builderId, 'builder'), 'create_eval_suite', {
        name: 'Sealed',
        workerDefinitionId,
        workerDefinitionVersion: 1,
      });
      const withGate = await call<EvalSuiteWire>(
        person(builderId, 'builder'),
        'add_eval_fixture_gate',
        { suiteId: created.id, suiteVersion: 1, gatekeeperId: gate },
      );
      const withHoldout = await call<EvalSuiteWire>(person(builderId, 'builder'), 'add_eval_case', {
        suiteId: withGate.id,
        suiteVersion: withGate.version,
        partition: 'regression',
        split: 'holdout',
        title: HOLDOUT_TITLE,
        input: HOLDOUT_INPUT,
        fixtures: [],
        assertions: [{ expect: { path: 'result.summary', op: 'contains', value: 'drained' } }],
      });
      suite = await call<EvalSuiteWire>(person(builderId, 'builder'), 'add_eval_case', {
        suiteId: withHoldout.id,
        suiteVersion: withHoldout.version,
        partition: 'regression',
        split: 'dev',
        title: 'Restart web-1',
        input: DEV_INPUT,
        fixtures: [],
        assertions: [{ expect: { path: 'result.summary', op: 'contains', value: 'web-1' } }],
      });
      holdoutCaseId = suite.cases.find((c) => c.split === 'holdout')?.id as string;
      NEVER_SHOWN.push(holdoutCaseId, suite.id, suite.canary.toLowerCase());

      configureTaskRuntime({ pool, privateKey, supervisorClient: supervisor });
    });

    afterAll(async () => {
      resetTaskRuntimeForTests();
      await pool.end();
    });

    it("an agent's call whose result carries a holdout run is refused, rolled back and audited without the content", async () => {
      const objectId = await objectHolding(`From the runbook: ${DISGUISED_RUN} — as written.`);
      const before = (await sealRows()).length;

      const err = await refusal(call(await ownerAgent(), 'get_object', { objectId }));
      expect(err.code).toBe('evaluation_content_withheld');
      expect(err.where).toBe('capability_result');
      expect(err.rolledBack).toBe(true);
      expectNothingOf(err.message);
      expectNothingOf(JSON.stringify(err));

      const rows = (await sealRows()).slice(before);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actor_principal_id).toBe(ownerId);
      expect(rows[0]?.resource_type).toBeNull();
      expect(rows[0]?.payload).toEqual({
        channel: 'handle',
        onBehalfOf: ownerId,
        where: 'capability_result',
        capability: 'get_object',
        rolledBack: true,
        outcome: 'withheld',
      });
      expectNothingOf(rows[0]?.whole ?? '');
      // The call's own audit row went with its rollback: nothing records the Object as read.
      const readRows = await asApp((client) =>
        client.query(
          "select 1 from audit_records where workspace_id = $1 and action = 'get_object' and resource_id = $2",
          [workspaceId, objectId],
        ),
      );
      expect(readRows.rowCount).toBe(0);
    });

    it("a suite's canary in a result is withheld the same way", async () => {
      const objectId = await objectHolding(`marker ${suite.canary} seen in a page`);
      const err = await refusal(call(await ownerAgent(), 'get_object', { objectId }));
      expect(err.where).toBe('capability_result');
      expectNothingOf(err.message);
    });

    it('development case content and short runs of holdout text pass', async () => {
      const agent = await ownerAgent();
      const dev = await objectHolding(`Ticket: ${DEV_INPUT}`);
      await expect(call(agent, 'get_object', { objectId: dev })).resolves.toMatchObject({
        id: dev,
      });
      // 39 characters of the holdout input, and its words in another order.
      const short = await objectHolding(HOLDOUT_INPUT.slice(4, 43));
      await expect(call(agent, 'get_object', { objectId: short })).resolves.toMatchObject({
        id: short,
      });
      const reworded = await objectHolding(
        'Rotate the relay keys on rack nine, then drain the zephyr-quokka pool and confirm.',
      );
      await expect(call(agent, 'get_object', { objectId: reworded })).resolves.toMatchObject({
        id: reworded,
      });
    });

    it('a holdout case added after a first read is sealed from then on, and stays sealed once retired', async () => {
      const later =
        'Archive the ledger shards of the obsidian-wren tenant after the audit window closes.';
      NEVER_SHOWN.push('obsidian-wren', 'ledger shards');
      const objectId = await objectHolding(later);
      const agent = await ownerAgent();
      await expect(call(agent, 'get_object', { objectId })).resolves.toMatchObject({
        id: objectId,
      });

      const current = await call<EvalSuiteWire>(person(builderId, 'builder'), 'get_eval_suite', {
        suiteId: suite.id,
      });
      const added = await call<EvalSuiteWire>(person(builderId, 'builder'), 'add_eval_case', {
        suiteId: suite.id,
        suiteVersion: current.version,
        partition: 'full',
        split: 'holdout',
        title: 'Ledger archive',
        input: later,
        fixtures: [],
        assertions: [{ expect: { path: 'result.summary', op: 'contains', value: 'archived' } }],
      });
      const laterCaseId = added.cases.find((c) => c.title === 'Ledger archive')?.id as string;
      NEVER_SHOWN.push(laterCaseId);
      await refusal(call(agent, 'get_object', { objectId }));

      const retired = await call<EvalSuiteWire>(person(ownerId, 'owner'), 'retire_eval_case', {
        suiteId: suite.id,
        suiteVersion: added.version,
        caseId: laterCaseId,
        reason: 'superseded by a broader case',
      });
      expect(retired.cases.some((c) => c.id === laterCaseId)).toBe(false);
      await refusal(call(agent, 'get_object', { objectId }));
    });

    it("a person's chat message carrying a holdout run is neither sent nor saved", async () => {
      const owner = person(ownerId, 'owner');
      const chat = await call<{ id: string }>(owner, 'new_chat', {});
      const before = (await sealRows()).length;

      const err = await refusal(
        call(owner, 'send_chat_message', { chatId: chat.id, text: `Please: ${DISGUISED_RUN}` }),
      );
      expect(err.where).toBe('entry_turn');
      expectNothingOf(err.message);
      const saved = await asApp((client) =>
        client.query(
          `select (select count(*) from chat_messages where workspace_id = $1 and chat_id = $2)::int as messages,
                  (select count(*) from activities where workspace_id = $1 and chat_id = $2)::int as turns`,
          [workspaceId, chat.id],
        ),
      );
      expect(saved.rows[0]).toEqual({ messages: 0, turns: 0 });

      const rows = (await sealRows()).slice(before);
      expect(rows.map((row) => row.payload)).toEqual([
        {
          channel: 'human',
          onBehalfOf: ownerId,
          where: 'entry_turn',
          capability: 'send_chat_message',
          outcome: 'withheld',
        },
      ]);
      expectNothingOf(rows[0]?.whole ?? '');

      // The same chat still takes an ordinary message.
      await expect(
        call(owner, 'send_chat_message', { chatId: chat.id, text: DEV_INPUT }),
      ).resolves.toMatchObject({ turnId: expect.any(String) });
    });

    it('a Worker never starts with holdout content: the Task fails to start, audited once against it', async () => {
      const before = (await sealRows()).length;
      const spawned = supervisor.spawnCalls.length;

      const err = await refusal(
        call(await ownerAgent(), 'invoke_worker', {
          definitionId: workerDefinitionId,
          version: 1,
          input: { brief: `Do this: ${DISGUISED_RUN}` },
          wait: false,
        }),
      );
      expect(err.where).toBe('worker_start');
      expectNothingOf(err.message);
      expect(supervisor.spawnCalls).toHaveLength(spawned);

      const rows = (await sealRows()).slice(before);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.resource_type).toBe('task');
      expect(rows[0]?.payload).toEqual({
        onBehalfOf: ownerId,
        where: 'worker_start',
        outcome: 'withheld',
      });
      expectNothingOf(rows[0]?.whole ?? '');
      const task = await asApp((client) =>
        client.query<{ status: string; failure_reason: string; runs: number }>(
          `select status, failure_reason,
                  (select count(*) from worker_runs w where w.workspace_id = t.workspace_id and w.task_id = t.id)::int as runs
             from tasks t where workspace_id = $1 and id = $2`,
          [workspaceId, rows[0]?.resource_id],
        ),
      );
      expect(task.rows[0]).toEqual({ status: 'failed', failure_reason: 'spawn_failed', runs: 0 });
    });

    it("a Worker whose definition's system prompt carries a holdout run is not started either", async () => {
      const proposed = await asApp((client) =>
        proposeWorkerDefinition(client, workspaceId, ownerId, {
          kind: 'worker',
          definition: { systemPrompt: `Always remember: ${HOLDOUT_INPUT}` },
        }),
      );
      await asApp((client) =>
        publishWorkerDefinition(client, workspaceId, ownerId, {
          definitionId: proposed.id,
          version: proposed.version,
        }),
      );
      const spawned = supervisor.spawnCalls.length;
      const err = await refusal(
        call(await ownerAgent(), 'invoke_worker', {
          definitionId: proposed.id,
          version: proposed.version,
          input: {},
          wait: false,
        }),
      );
      expect(err.where).toBe('worker_start');
      expect(supervisor.spawnCalls).toHaveLength(spawned);
    });

    it("a Worker's result carrying a holdout run is withheld from the waiting agent, though the Task stands", async () => {
      const before = (await sealRows()).length;
      // The Worker reports back while the call waits: its result quotes the holdout input.
      let reported = false;
      configureTaskRuntime({
        pool,
        privateKey,
        supervisorClient: supervisor,
        sleep: async () => {
          if (reported) return;
          reported = true;
          const spawn = supervisor.spawnCalls.at(-1) as TaskSpawnInput;
          await asApp((client) =>
            completeTaskWithResult(client, workspaceId, ownerId, spawn.taskId, spawn.workerRunId, {
              summary: `done — ${DISGUISED_RUN}`,
            }),
          );
        },
      });
      try {
        const err = await refusal(
          call(await ownerAgent(), 'invoke_worker', {
            definitionId: workerDefinitionId,
            version: 1,
            input: { brief: 'check the pools' },
            wait: true,
            timeout: 30,
          }),
        );
        expect(err.where).toBe('capability_result');
        expect(err.rolledBack).toBe(false);
        expectNothingOf(err.message);
      } finally {
        configureTaskRuntime({ pool, privateKey, supervisorClient: supervisor });
      }

      const rows = (await sealRows()).slice(before);
      expect(rows.map((row) => row.payload)).toEqual([
        {
          channel: 'handle',
          onBehalfOf: ownerId,
          where: 'capability_result',
          capability: 'invoke_worker',
          rolledBack: false,
          outcome: 'withheld',
        },
      ]);
      const spawn = supervisor.spawnCalls.at(-1) as TaskSpawnInput;
      const task = await asApp((client) =>
        client.query<{ status: string }>(
          'select status from tasks where workspace_id = $1 and id = $2',
          [workspaceId, spawn.taskId],
        ),
      );
      expect(task.rows[0]?.status).toBe('completed');
    });

    it("the error an agent's call fails with is withheld when it carries a holdout run, in the call and after commit", async () => {
      // A gate or a Worker answering with an error that quotes the content: stood in for by
      // `get_object`'s handler, swapped for this test only.
      const handlers = CAPABILITY_HANDLERS as Map<string, CapabilityHandler>;
      const original = handlers.get('get_object') as CapabilityHandler;
      const quoting = new Error(`upstream said: ${DISGUISED_RUN} (status 502)`);
      const before = (await sealRows()).length;
      try {
        handlers.set('get_object', async () => {
          throw quoting;
        });
        const inCall = await refusal(
          call(await ownerAgent(), 'get_object', { objectId: randomUUID() }),
        );
        expect(inCall.where).toBe('capability_error');
        expectNothingOf(inCall.message);

        handlers.set('get_object', async () => ({
          result: {},
          afterCommit: async () => {
            throw quoting;
          },
        }));
        const afterCommit = await refusal(
          call(await ownerAgent(), 'get_object', { objectId: randomUUID() }),
        );
        expect(afterCommit.where).toBe('capability_error');

        // An error without such a run passes as it is.
        const plain = new Error('upstream said: try again later (status 502)');
        handlers.set('get_object', async () => {
          throw plain;
        });
        await expect(
          call(await ownerAgent(), 'get_object', { objectId: randomUUID() }),
        ).rejects.toBe(plain);

        // One that cannot be checked (details the scan cannot walk) is not handed on either: a
        // fixed error takes its place, with no audit row (nothing was found), and the log line
        // holds none of its text.
        const cyclic: Record<string, unknown> = { said: DISGUISED_RUN };
        cyclic.self = cyclic;
        handlers.set('get_object', async () => {
          throw Object.assign(new Error(`upstream said: ${DISGUISED_RUN}`), { details: cyclic });
        });
        const unchecked = await call(await ownerAgent(), 'get_object', {
          objectId: randomUUID(),
        }).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(unchecked).toBeInstanceOf(Error);
        expect(unchecked).not.toBeInstanceOf(EvaluationContentWithheldError);
        expect((unchecked as Error).message).toBe(UNCHECKED_ERROR_MESSAGE);
        expect(logged.some((line) => line.includes('could not check the error'))).toBe(true);
      } finally {
        handlers.set('get_object', original);
      }
      const rows = (await sealRows()).slice(before);
      expect(rows.map((row) => row.payload)).toEqual([
        {
          channel: 'handle',
          onBehalfOf: ownerId,
          where: 'capability_error',
          capability: 'get_object',
          outcome: 'withheld',
        },
        {
          channel: 'handle',
          onBehalfOf: ownerId,
          where: 'capability_error',
          capability: 'get_object',
          outcome: 'withheld',
        },
      ]);
      for (const row of rows) expectNothingOf(row.whole);
    });

    // Review #493 of #813 (P2): the entry agent's system prompt — here the person's own prompt
    // addendum — goes through the seal before the Turn's start frame does.
    it('the entry agent never starts a Turn with holdout content in its system prompt', async () => {
      const owner = person(ownerId, 'owner');
      async function startTurn(): Promise<{
        events: AgentRuntimeEvent[];
        sent: unknown[];
        turnId: string;
      }> {
        const events: AgentRuntimeEvent[] = [];
        const sent: unknown[] = [];
        const runtime = new AgentHostRuntime({
          pool,
          sink: {
            handle(event) {
              events.push(event);
            },
          },
          privateKey,
          kernelLlmUrl: 'http://llm-proxy:8082',
        });
        runtime.connect({ send: (frame) => sent.push(frame) });
        const turnId = randomUUID();
        await runtime.startTurn({
          workspaceId,
          chatId: randomUUID(),
          turnId,
          principalId: ownerId,
          prompt: 'hello',
        });
        // Settle the accept wait so no timer outlives the test.
        if (sent.length > 0) runtime.handleFrame({ type: 'turnAccepted', turnId });
        return { events, sent, turnId };
      }

      await call(owner, 'set_agent_profile', {
        promptAddendum: `House notes: ${DISGUISED_RUN}, always.`,
      });
      const before = (await sealRows()).length;
      const refused = await startTurn();
      expect(refused.sent).toEqual([]);
      expect(refused.events).toEqual([
        expect.objectContaining({ type: 'turnEnded', status: 'failed', turnId: refused.turnId }),
      ]);
      const rows = (await sealRows()).slice(before);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actor_principal_id).toBe(ownerId);
      expect(rows[0]?.resource_type).toBeNull();
      expect(rows[0]?.payload).toEqual({
        onBehalfOf: ownerId,
        where: 'entry_start',
        outcome: 'withheld',
      });
      expectNothingOf(rows[0]?.whole ?? '');

      // Without it, the same person's Turn starts.
      await call(owner, 'set_agent_profile', { promptAddendum: null });
      const started = await startTurn();
      expect(started.sent).toHaveLength(1);
      expect(started.events).toEqual([]);
    });

    // Coordinator ruling on review #493 of #813: what a fixture rule answers stands in for a real
    // system's reply, so it is not sealed — only the rule's condition is.
    it("a fixture rule's answer is not sealed, its condition is", async () => {
      const condition = 'the canopy-heron replica set in the cold aisle';
      const answer = 'Hosts report: web-1 up, web-2 up, db-1 up, cache-1 degraded since noon.';
      const failure = 'The inventory service timed out after thirty seconds, try again later.';
      NEVER_SHOWN.push('canopy-heron');
      const current = await call<EvalSuiteWire>(person(builderId, 'builder'), 'get_eval_suite', {
        suiteId: suite.id,
      });
      const added = await call<EvalSuiteWire>(person(builderId, 'builder'), 'add_eval_case', {
        suiteId: suite.id,
        suiteVersion: current.version,
        partition: 'full',
        split: 'holdout',
        title: 'Host inventory',
        input: 'List the hosts.',
        fixtures: [
          {
            gatekeeperId: gate,
            operation: 'hosts.list',
            when: { path: 'host', op: 'eq', value: condition },
            answer: { kind: 'data', data: { report: answer } },
          },
          {
            gatekeeperId: gate,
            operation: 'hosts.list',
            answer: { kind: 'error', message: failure },
          },
        ],
        assertions: [{ expect: { path: 'calls', op: 'exists' } }],
      });
      NEVER_SHOWN.push(added.cases.find((c) => c.title === 'Host inventory')?.id as string);

      const agent = await ownerAgent();
      for (const text of [answer, failure]) {
        const objectId = await objectHolding(text);
        await expect(call(agent, 'get_object', { objectId })).resolves.toMatchObject({
          id: objectId,
        });
      }
      const err = await refusal(
        call(agent, 'get_object', { objectId: await objectHolding(`About ${condition}.`) }),
      );
      expect(err.where).toBe('capability_result');
    });

    it('a person still reads every holdout case in full: the seal stands only between content and agents', async () => {
      const read = await call<EvalCaseWire>(person(builderId, 'builder'), 'get_eval_case', {
        suiteId: suite.id,
        caseId: holdoutCaseId,
      });
      expect(read.input).toBe(HOLDOUT_INPUT);
      expect(read.title).toBe(HOLDOUT_TITLE);
    });
  },
);
