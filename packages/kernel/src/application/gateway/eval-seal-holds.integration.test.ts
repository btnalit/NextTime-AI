import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EvalSealHoldWire, EvalSuiteWire, HandleClaims } from '@nexttime/shared';
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
import { SqlGraphStore } from '../../substrate/graph/index.js';
import {
  EvaluationContentWithheldError,
  EvaluationProbeHoldError,
  SEAL_HOLD_OPENED_ACTION,
  SEAL_HOLD_REFUSED_ACTION,
  resetEvaluationSealForTests,
} from '../eval-seal/index.js';
import { EvalRunNotFoundError, EvalSuiteStateError } from '../eval/index.js';
import { getOrCreateEvaluationPrincipal } from '../eval/principal.js';
import type { AgentRuntimeEvent } from '../host-bridge/agent-runtime.js';
import { AgentHostRuntime } from '../host-bridge/index.js';
import { purgeWorkspace } from '../platform/index.js';
import {
  createEvaluationTask,
  getConfiguredTaskRuntime,
  startStepAttemptTask,
} from '../task/index.js';
import { configureTaskRuntime, resetTaskRuntimeForTests } from '../task/runtime.js';
import { proposeWorkerDefinition, publishWorkerDefinition } from '../worker/index.js';
import { ForbiddenError } from './authorize.js';
import type { CapabilityHandler } from './capability-handler.js';
import { InvalidCapabilityParamsError, dispatchCapability } from './dispatch.js';
import { CAPABILITY_HANDLERS } from './handlers.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/eval-seal-holds.integration.test: DB-gated (real Postgres; auto-skip without
 * DATABASE_URL) — S10 E3-2c (legacy 514), the evaluation seal's pauses. Each seal refusal tells
 * whoever provoked it one bit, so an agent varying a candidate text could read a held-out case back;
 * the seal counts the refusals an agent could have provoked (a call's result or error, what a Worker
 * would start with) per Principal they acted for, and 5 within 24 hours — since that Principal's
 * last release — pause every agent acting for it: every Handle call, Worker start and entry Turn is
 * refused with 403 `evaluation_probe_hold`, the same whichever path and whichever refusals opened
 * it, until the workspace owner releases it with a reason. A person's chat message and what the
 * entry agent starts with are not counted (people write those, and read the cases anyway); a
 * refusal under a pause is audited and not counted; concurrent refusals open one pause; the
 * evaluation Principal is paused the same way, and then no evaluation starts.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

const HOLDOUT_INPUT =
  'Drain the marigold-ibex pool on rack seven before rotating its relay keys, then confirm the heartbeat.';
/** A 40-character run of the holdout input. */
const HOLDOUT_RUN = 'marigold-ibex pool on rack seven before rotating';
const HARMLESS = 'Restart the web-1 container if it is not answering on its health port today.';

class FakeSupervisor implements TaskSupervisorClientPort {
  readonly spawnCalls: TaskSpawnInput[] = [];

  async spawn(input: TaskSpawnInput): Promise<TaskSpawnOutcome> {
    this.spawnCalls.push(input);
    return { containerId: `container-${input.workerRunId}`, ip: '198.51.100.10' };
  }

  async terminate(): Promise<boolean> {
    return true;
  }

  async status(): Promise<TaskSupervisorStatus | undefined> {
    return undefined;
  }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (err: unknown) => err,
  );
}

describe.runIf(DATABASE_URL !== undefined)(
  'evaluation seal pauses (S10 E3-2c, integration, real Postgres)',
  () => {
    let pool: Pool;
    let privateKey: Awaited<ReturnType<typeof generateEphemeralHandleKeyPair>>['privateKey'];
    let workspaceId: string;
    const people = {
      owner: randomUUID(),
      builder: randomUUID(),
      member: randomUUID(),
      operator: randomUUID(),
      auditor: randomUUID(),
    } as const;
    type Who = keyof typeof people;
    let workerDefinitionId: string;
    let suite: EvalSuiteWire;
    const supervisor = new FakeSupervisor();
    const store = new SqlGraphStore();

    function person(who: Who): ResolvedCaller {
      const id = people[who];
      return {
        channel: 'human',
        principal: { workspaceId, id, kind: 'human', role: who, displayName: who },
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

    /** `who`'s entry agent, on a real session and Handle. */
    async function agentOf(who: Who): Promise<ResolvedCaller> {
      const principalId = people[who];
      const sessionId = await asApp(async (client) => {
        const result = await client.query<{ id: string }>(
          `insert into sessions (workspace_id, principal_id, kind, on_behalf_of, status)
           values ($1, $2, 'entry', $2, 'active') returning id`,
          [workspaceId, principalId],
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
      return withWorkspace(pool, { workspaceId, principalId: people.owner }, fn);
    }
    async function asOwnerRole<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId: people.owner }, fn, {
        skipRoleSwitch: true,
      });
    }

    async function call<T>(who: ResolvedCaller, capability: string, params: unknown): Promise<T> {
      return (await dispatchCapability({ pool }, who, capability, params)) as T;
    }

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

    /** One counted refusal: `agent` reads back an Object holding a run of the holdout case. */
    async function probe(agent: ResolvedCaller): Promise<unknown> {
      const objectId = await objectHolding(`Notes: ${HOLDOUT_RUN} — as written.`);
      return rejection(call(agent, 'get_object', { objectId }));
    }

    async function probeTimes(agent: ResolvedCaller, times: number): Promise<void> {
      for (let i = 0; i < times; i += 1) {
        expect(await probe(agent)).toBeInstanceOf(EvaluationContentWithheldError);
      }
    }

    async function holds(status?: 'active' | 'released'): Promise<EvalSealHoldWire[]> {
      const page = await call<{ items: EvalSealHoldWire[] }>(
        person('owner'),
        'list_eval_seal_holds',
        status ? { status } : {},
      );
      return page.items;
    }

    async function activeHoldOf(principalId: string): Promise<EvalSealHoldWire | undefined> {
      return (await holds('active')).find((hold) => hold.principal.id === principalId);
    }

    async function hits(principalId: string): Promise<number> {
      const result = await asApp((client) =>
        client.query<{ n: number }>(
          'select count(*)::int as n from eval_seal_hits where workspace_id = $1 and principal_id = $2',
          [workspaceId, principalId],
        ),
      );
      return result.rows[0]?.n ?? 0;
    }

    async function auditRows(action: string): Promise<
      Array<{
        actor_principal_id: string;
        resource_type: string | null;
        resource_id: string | null;
        payload: Record<string, unknown>;
      }>
    > {
      const result = await asApp((client) =>
        client.query(
          `select actor_principal_id, resource_type, resource_id, payload
             from audit_records where workspace_id = $1 and action = $2 order by created_at, id`,
          [workspaceId, action],
        ),
      );
      return result.rows;
    }

    /** Releases `principalId`'s pause, if any, as the owner. */
    async function releaseAny(principalId: string): Promise<void> {
      const hold = await activeHoldOf(principalId);
      if (hold) {
        await call(person('owner'), 'release_eval_seal_hold', {
          holdId: hold.id,
          reason: 'cleared in a test',
        });
      }
    }

    function expectPlaceAgnostic(err: unknown): void {
      expect(err).toBeInstanceOf(EvaluationProbeHoldError);
      const message = (err as Error).message;
      for (const place of ['capability_result', 'capability_error', 'worker_start', 'result']) {
        expect(message).not.toContain(place);
      }
    }

    beforeEach(() => {
      // The seal's own log lines would be noise here.
      for (const method of ['warn', 'error'] as const) {
        vi.spyOn(console, method).mockImplementation(() => undefined);
      }
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      resetEvaluationSealForTests();
      privateKey = (await generateEphemeralHandleKeyPair()).privateKey;
      workspaceId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: people.owner },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'e3-2c-seal-holds',
          ]);
          for (const [role, id] of Object.entries(people)) {
            await client.query(
              `insert into principals (workspace_id, id, kind, role, display_name)
               values ($1, $2, 'human', $3, $3)`,
              [workspaceId, id, role],
            );
          }
        },
        { skipRoleSwitch: true },
      );
      const proposed = await asApp((client) =>
        proposeWorkerDefinition(client, workspaceId, people.owner, {
          kind: 'worker',
          definition: { systemPrompt: 'You are a plain worker.' },
        }),
      );
      await asApp((client) =>
        publishWorkerDefinition(client, workspaceId, people.owner, {
          definitionId: proposed.id,
          version: proposed.version,
        }),
      );
      workerDefinitionId = proposed.id;
      const created = await call<EvalSuiteWire>(person('builder'), 'create_eval_suite', {
        name: 'Probed',
        workerDefinitionId,
        workerDefinitionVersion: 1,
      });
      suite = await call<EvalSuiteWire>(person('builder'), 'add_eval_case', {
        suiteId: created.id,
        suiteVersion: created.version,
        partition: 'regression',
        split: 'holdout',
        title: 'Ibex pool drain',
        input: HOLDOUT_INPUT,
        fixtures: [],
        assertions: [{ expect: { path: 'result.summary', op: 'contains', value: 'drained' } }],
      });
      configureTaskRuntime({ pool, privateKey, supervisorClient: supervisor });
    });

    afterAll(async () => {
      resetTaskRuntimeForTests();
      await pool.end();
    });

    it('five refusals an agent provoked within a day pause every agent acting for that person: the fifth is still withheld, then every call is refused the same way', async () => {
      const agent = await agentOf('builder');
      await probeTimes(agent, 4);
      expect(await activeHoldOf(people.builder)).toBeUndefined();

      expect(await probe(agent)).toBeInstanceOf(EvaluationContentWithheldError);
      const hold = await activeHoldOf(people.builder);
      expect(hold).toMatchObject({
        principal: { id: people.builder, kind: 'human', displayName: 'builder', evaluation: false },
        status: 'active',
        hits: 5,
        places: { capabilityResult: 5, capabilityError: 0, workerStart: 0 },
        releasedAt: null,
        releasedBy: null,
        releaseReason: null,
      });
      const opened = (await auditRows(SEAL_HOLD_OPENED_ACTION)).filter(
        (row) => row.actor_principal_id === people.builder,
      );
      expect(opened).toEqual([
        {
          actor_principal_id: people.builder,
          resource_type: 'eval_seal_hold',
          resource_id: hold?.id,
          payload: {
            onBehalfOf: people.builder,
            hits: 5,
            places: { capabilityResult: 5, capabilityError: 0, workerStart: 0 },
            threshold: 5,
            windowHours: 24,
            outcome: 'paused',
          },
        },
      ]);

      // Paused: a harmless read, the same read of nothing, a held-out read — all refused alike,
      // before they run, and none counted.
      const refusedBefore = (await auditRows(SEAL_HOLD_REFUSED_ACTION)).length;
      const harmless = await objectHolding(HARMLESS);
      const errs = [
        await rejection(call(agent, 'get_object', { objectId: harmless })),
        await rejection(call(await agentOf('builder'), 'get_object', { objectId: randomUUID() })),
        await probe(agent),
      ];
      for (const err of errs) expectPlaceAgnostic(err);
      expect(new Set(errs.map((err) => (err as Error).message)).size).toBe(1);
      expect((errs[0] as EvaluationProbeHoldError).code).toBe('evaluation_probe_hold');
      expect(await hits(people.builder)).toBe(5);
      const refused = (await auditRows(SEAL_HOLD_REFUSED_ACTION)).slice(refusedBefore);
      expect(refused).toHaveLength(3);
      expect(refused[0]?.payload).toEqual({
        channel: 'handle',
        onBehalfOf: people.builder,
        path: 'capability_call',
        capability: 'get_object',
        outcome: 'refused',
      });

      // The person's own message to their entry agent starts no Turn, and nothing is saved.
      const chat = await call<{ id: string }>(person('builder'), 'new_chat', {});
      expectPlaceAgnostic(
        await rejection(
          call(person('builder'), 'send_chat_message', { chatId: chat.id, text: 'hello' }),
        ),
      );
      const saved = await asApp((client) =>
        client.query<{ n: number }>(
          'select count(*)::int as n from chat_messages where workspace_id = $1 and chat_id = $2',
          [workspaceId, chat.id],
        ),
      );
      expect(saved.rows[0]?.n).toBe(0);

      // A Turn already on its way to the entry agent is not started either.
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
        chatId: chat.id,
        turnId,
        principalId: people.builder,
        prompt: 'hello',
      });
      expect(sent).toEqual([]);
      expect(events).toEqual([
        expect.objectContaining({ type: 'turnEnded', status: 'failed', turnId }),
      ]);
      expect((await auditRows(SEAL_HOLD_REFUSED_ACTION)).at(-1)?.payload).toEqual({
        onBehalfOf: people.builder,
        path: 'entry_start',
        outcome: 'refused',
      });

      // Another person's agents are not affected.
      await expect(
        call(await agentOf('owner'), 'get_object', { objectId: harmless }),
      ).resolves.toMatchObject({ id: harmless });
    });

    it('only the owner releases a pause, with a reason; the agents run again and the count starts afresh', async () => {
      const hold = await activeHoldOf(people.builder);
      expect(hold).toBeDefined();
      const holdId = hold?.id as string;
      for (const who of ['builder', 'member', 'auditor', 'operator'] as const) {
        expect(
          await rejection(
            call(person(who), 'release_eval_seal_hold', { holdId, reason: 'let me go' }),
          ),
        ).toBeInstanceOf(ForbiddenError);
      }
      expect(
        await rejection(call(person('owner'), 'release_eval_seal_hold', { holdId, reason: '  ' })),
      ).toBeInstanceOf(InvalidCapabilityParamsError);

      const released = await call<EvalSealHoldWire>(person('owner'), 'release_eval_seal_hold', {
        holdId,
        reason: 'Reviewed: the agent was summarising a runbook, not probing.',
      });
      expect(released).toMatchObject({
        id: holdId,
        status: 'released',
        releasedBy: people.owner,
        releaseReason: 'Reviewed: the agent was summarising a runbook, not probing.',
      });
      expect(released.releasedAt).not.toBeNull();
      const audited = await auditRows('release_eval_seal_hold');
      expect(audited.at(-1)).toMatchObject({
        actor_principal_id: people.owner,
        resource_type: 'eval_seal_hold',
        resource_id: holdId,
      });
      expect(audited.at(-1)?.payload).toMatchObject({ heldPrincipalId: people.builder });

      expect(
        await rejection(
          call(person('owner'), 'release_eval_seal_hold', { holdId, reason: 'again' }),
        ),
      ).toBeInstanceOf(EvalSuiteStateError);
      expect(
        await rejection(
          call(person('owner'), 'release_eval_seal_hold', {
            holdId: randomUUID(),
            reason: 'nothing',
          }),
        ),
      ).toBeInstanceOf(EvalRunNotFoundError);
      expect((await holds('active')).some((h) => h.id === holdId)).toBe(false);
      expect((await holds('released')).some((h) => h.id === holdId)).toBe(true);

      // The agents run again.
      const agent = await agentOf('builder');
      const harmless = await objectHolding(HARMLESS);
      await expect(call(agent, 'get_object', { objectId: harmless })).resolves.toMatchObject({
        id: harmless,
      });
      // The five before the release no longer count: four more do not pause, a fifth does.
      await probeTimes(agent, 4);
      expect(await activeHoldOf(people.builder)).toBeUndefined();
      await probeTimes(agent, 1);
      expect(await activeHoldOf(people.builder)).toMatchObject({ hits: 5 });
      await releaseAny(people.builder);
    });

    it('the owner and auditors read the pauses; no one else, and no agent', async () => {
      await expect(call(person('auditor'), 'list_eval_seal_holds', {})).resolves.toMatchObject({
        items: expect.any(Array),
      });
      for (const who of ['builder', 'member', 'operator'] as const) {
        expect(await rejection(call(person(who), 'list_eval_seal_holds', {}))).toBeInstanceOf(
          ForbiddenError,
        );
      }
      expect(
        await rejection(call(await agentOf('owner'), 'list_eval_seal_holds', {})),
      ).toBeInstanceOf(ForbiddenError);
    });

    it('refusals older than a day do not count', async () => {
      await asOwnerRole((client) =>
        client.query(
          `insert into eval_seal_hits (workspace_id, principal_id, place, at)
           select $1, $2, 'capability_result', now() - interval '25 hours'
             from generate_series(1, 4)`,
          [workspaceId, people.member],
        ),
      );
      const agent = await agentOf('member');
      await probeTimes(agent, 4);
      expect(await activeHoldOf(people.member)).toBeUndefined();
      await probeTimes(agent, 1);
      expect(await activeHoldOf(people.member)).toMatchObject({ hits: 5 });
      await releaseAny(people.member);
    });

    it("a person's chat messages and what the entry agent starts with are not counted", async () => {
      const chat = await call<{ id: string }>(person('owner'), 'new_chat', {});
      for (let i = 0; i < 6; i += 1) {
        const err = await rejection(
          call(person('owner'), 'send_chat_message', {
            chatId: chat.id,
            text: `Please: ${HOLDOUT_RUN}`,
          }),
        );
        expect(err).toBeInstanceOf(EvaluationContentWithheldError);
        expect((err as EvaluationContentWithheldError).where).toBe('entry_turn');
      }
      expect(await hits(people.owner)).toBe(0);
      expect(await activeHoldOf(people.owner)).toBeUndefined();
    });

    it('refusals at the same time open one pause', async () => {
      const agent = await agentOf('operator');
      await probeTimes(agent, 3);
      const results = await Promise.all(Array.from({ length: 6 }, () => probe(agent)));
      for (const err of results) {
        expect(
          err instanceof EvaluationContentWithheldError || err instanceof EvaluationProbeHoldError,
        ).toBe(true);
      }
      const withheld = results.filter((err) => err instanceof EvaluationContentWithheldError);
      const paused = await asApp((client) =>
        client.query<{ hits: number }>(
          `select hits from eval_seal_holds
            where workspace_id = $1 and principal_id = $2 and status = 'active'`,
          [workspaceId, people.operator],
        ),
      );
      expect(paused.rows).toHaveLength(1);
      expect(paused.rows[0]?.hits).toBeGreaterThanOrEqual(5);
      expect(await hits(people.operator)).toBe(3 + withheld.length);
      await releaseAny(people.operator);

      // #838 review: the two that make it five, at once. Counted one after the other (the lock),
      // the second sees the first; without it each would see four and neither open the pause.
      await probeTimes(agent, 3);
      const pair = await Promise.all([probe(agent), probe(agent)]);
      for (const err of pair) expect(err).toBeInstanceOf(EvaluationContentWithheldError);
      expect(await activeHoldOf(people.operator)).toMatchObject({ hits: 5 });
      await releaseAny(people.operator);
    });

    // #838 review: the other two places that count — a call's error, and what a Worker would
    // start with — count the same as a call's result, towards one pause.
    it("a call's error and a Worker's start count like a call's result", async () => {
      const agent = await agentOf('builder');
      const handlers = CAPABILITY_HANDLERS as Map<string, CapabilityHandler>;
      const original = handlers.get('get_object') as CapabilityHandler;
      try {
        // A gate or a Worker answering with an error that quotes the case, stood in for by
        // `get_object`'s handler.
        handlers.set('get_object', async () => {
          throw new Error(`upstream said: ${HOLDOUT_RUN} (status 502)`);
        });
        for (let i = 0; i < 2; i += 1) {
          const err = await rejection(call(agent, 'get_object', { objectId: randomUUID() }));
          expect(err).toBeInstanceOf(EvaluationContentWithheldError);
          expect((err as EvaluationContentWithheldError).where).toBe('capability_error');
        }
      } finally {
        handlers.set('get_object', original);
      }
      const spawned = supervisor.spawnCalls.length;
      for (let i = 0; i < 2; i += 1) {
        const err = await rejection(
          call(agent, 'invoke_worker', {
            definitionId: workerDefinitionId,
            version: 1,
            input: { brief: `Do this: ${HOLDOUT_RUN}` },
            wait: false,
          }),
        );
        expect(err).toBeInstanceOf(EvaluationContentWithheldError);
        expect((err as EvaluationContentWithheldError).where).toBe('worker_start');
      }
      expect(supervisor.spawnCalls).toHaveLength(spawned);
      expect(await activeHoldOf(people.builder)).toBeUndefined();

      expect(await probe(agent)).toBeInstanceOf(EvaluationContentWithheldError);
      expect(await activeHoldOf(people.builder)).toMatchObject({
        hits: 5,
        places: { capabilityResult: 1, capabilityError: 2, workerStart: 2 },
      });
      // Paused, an ordinary Worker start is refused like any call, before it creates anything.
      expectPlaceAgnostic(
        await rejection(
          call(agent, 'invoke_worker', {
            definitionId: workerDefinitionId,
            version: 1,
            input: { brief: HARMLESS },
            wait: false,
          }),
        ),
      );
      expect(supervisor.spawnCalls).toHaveLength(spawned);
      await releaseAny(people.builder);
    });

    it('the evaluation Principal is paused the same way: no evaluation starts, and a trial whose start meets the pause fails to start', async () => {
      const evaluationPrincipalId = await asApp((client) =>
        getOrCreateEvaluationPrincipal(client, workspaceId),
      );
      const pause = async () =>
        asApp((client) =>
          client.query(
            `insert into eval_seal_holds (workspace_id, principal_id, hits, places)
             values ($1, $2, 5, '{"capabilityResult": 2, "capabilityError": 0, "workerStart": 3}')`,
            [workspaceId, evaluationPrincipalId],
          ),
        );
      await pause();
      const held = await activeHoldOf(evaluationPrincipalId);
      expect(held?.principal).toEqual({
        id: evaluationPrincipalId,
        kind: 'service',
        displayName: null,
        evaluation: true,
      });
      expect(held?.places).toEqual({ capabilityResult: 2, capabilityError: 0, workerStart: 3 });

      const caseId = suite.cases[0]?.id as string;
      const runsBefore = await asApp((client) =>
        client.query('select 1 from eval_runs where workspace_id = $1', [workspaceId]),
      );
      const err = await rejection(
        call(person('builder'), 'start_eval_case_trial', {
          suiteId: suite.id,
          suiteVersion: suite.version,
          caseId,
        }),
      );
      expect(err).toBeInstanceOf(EvaluationProbeHoldError);
      expect((err as EvaluationProbeHoldError).subject).toBe('evaluation');
      const runsAfter = await asApp((client) =>
        client.query('select 1 from eval_runs where workspace_id = $1', [workspaceId]),
      );
      expect(runsAfter.rowCount).toBe(runsBefore.rowCount);
      expect((await auditRows(SEAL_HOLD_REFUSED_ACTION)).at(-1)?.payload).toEqual({
        channel: 'human',
        onBehalfOf: people.builder,
        heldPrincipalId: evaluationPrincipalId,
        path: 'capability_call',
        capability: 'start_eval_case_trial',
        outcome: 'refused',
      });
      await releaseAny(evaluationPrincipalId);

      // A trial's Task created before a pause opened, started after: its Worker does not start.
      const created = await asApp((client) =>
        createEvaluationTask(client, workspaceId, {
          evaluationPrincipalId,
          definition: { id: workerDefinitionId, version: 1 },
          input: HARMLESS,
          fixtureGateIds: [],
        }),
      );
      if (created.kind !== 'created') throw new Error(`no evaluation Task: ${created.kind}`);
      await pause();
      const spawned = supervisor.spawnCalls.length;
      expect(
        await startStepAttemptTask(getConfiguredTaskRuntime(), workspaceId, created.prepared),
      ).toBe(false);
      expect(supervisor.spawnCalls).toHaveLength(spawned);
      const task = await asApp((client) =>
        client.query<{ status: string; failure_reason: string }>(
          'select status, failure_reason from tasks where workspace_id = $1 and id = $2',
          [workspaceId, created.prepared.task.id],
        ),
      );
      expect(task.rows[0]).toEqual({ status: 'failed', failure_reason: 'spawn_failed' });
      expect((await auditRows(SEAL_HOLD_REFUSED_ACTION)).at(-1)).toMatchObject({
        actor_principal_id: evaluationPrincipalId,
        resource_type: 'task',
        resource_id: created.prepared.task.id,
        payload: { onBehalfOf: evaluationPrincipalId, path: 'worker_start', outcome: 'refused' },
      });
      await releaseAny(evaluationPrincipalId);
    });

    it('the database keeps them: a counted refusal never changes, a pause opens active and is released once, neither is deleted', async () => {
      await probeTimes(await agentOf('member'), 1);
      const failures: string[] = [];
      for (const sql of [
        `update eval_seal_hits set place = 'worker_start' where workspace_id = $1`,
        'delete from eval_seal_hits where workspace_id = $1',
        `insert into eval_seal_holds (workspace_id, principal_id, status, hits, places, released_at, released_by, release_reason)
         values ($1, '${people.member}', 'released', 5, '{}', now(), '${people.owner}', 'r')`,
        'update eval_seal_holds set hits = 99 where workspace_id = $1',
        `update eval_seal_holds set status = 'active', released_at = null, released_by = null, release_reason = null where workspace_id = $1 and status = 'released'`,
        'delete from eval_seal_holds where workspace_id = $1',
      ]) {
        const err = await rejection(asOwnerRole((client) => client.query(sql, [workspaceId])));
        if (!(err instanceof Error)) failures.push(sql);
      }
      expect(failures).toEqual([]);
      // One active pause per Principal.
      const insertActive = (client: PoolClient) =>
        client.query(
          `insert into eval_seal_holds (workspace_id, principal_id, hits, places)
           values ($1, $2, 5, '{}')`,
          [workspaceId, people.auditor],
        );
      await asOwnerRole(insertActive);
      expect(await rejection(asOwnerRole(insertActive))).toBeInstanceOf(Error);
      await releaseAny(people.auditor);
    });

    it('the workspace purge removes them', async () => {
      const result = await purgeWorkspace(pool, { workspaceId, confirm: true, force: true });
      expect(result.executed).toBe(true);
      for (const table of ['eval_seal_hits', 'eval_seal_holds']) {
        const left = await pool.query<{ count: string }>(
          `select count(*)::text as count from ${table} where workspace_id = $1`,
          [workspaceId],
        );
        expect(left.rows[0]?.count).toBe('0');
      }
    });
  },
);
