import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type EvalBudgetWire,
  type EvalRunSummaryWire,
  type EvalRunWire,
  type EvalSuiteWire,
  type HandleClaims,
  type Operation,
  type Role,
  type TaskWire,
  evalCallCountPath,
} from '@nexttime/shared';
import { decodeJwt } from 'jose';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { GatekeeperClientError } from '../../adapters/gatekeeper-client/index.js';
import type {
  TaskSpawnInput,
  TaskSpawnOutcome,
  TaskSupervisorClientPort,
  TaskSupervisorStatus,
} from '../../adapters/supervisor-client/index.js';
import {
  ReviewedVersionChangedError,
  entryScope,
  generateEphemeralHandleKeyPair,
  issueHandle,
} from '../../governance/capability/index.js';
import {
  OperationNotFoundError,
  importManifest,
  publishOperation,
  registerGatekeeper,
} from '../../governance/gatekeepers/index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import {
  EVALUATION_WITHHELD_ACTION,
  EvaluationContentWithheldError,
  resetEvaluationSealForTests,
} from '../eval-seal/index.js';
import {
  EVALUATION_PRINCIPAL_DISPLAY_NAME,
  EVALUATION_TRIAL_END_ACTION,
  EvalCaseNotFoundError,
  EvalRunNotFoundError,
  EvalSuiteNotFoundError,
  EvalSuiteStateError,
  EvaluationBudgetExhaustedError,
  runEvalTrialTick,
} from '../eval/index.js';
import { purgeWorkspace } from '../platform/index.js';
import { TaskNotFoundError } from '../task/index.js';
import { reactToSupervisorStatus } from '../task/lifecycle.js';
import { configureTaskRuntime, resetTaskRuntimeForTests } from '../task/runtime.js';
import { terminateTaskWith } from '../task/service.js';
import {
  deprecateWorkerDefinition,
  proposeWorkerDefinition,
  publishWorkerDefinition,
} from '../worker/index.js';
import { ForbiddenError } from './authorize.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/eval-runs.integration.test: DB-gated (real Postgres; auto-skip without
 * DATABASE_URL) — S10 E3-2a, a case's 试跑 end to end: a builder starts it (an evaluation Task for
 * the workspace's evaluation service Principal, its Handle closed to five capabilities, its egress
 * denied), its Worker reads only its own Task and has every gate call answered from the case's
 * fixtures (recorded on the trial, audited under its own action, never reaching a gate), its report
 * completes the Task and writes nothing else, and the runner scores it — or records how it ended
 * without a report (cancelled, crashed and not retried, withheld at start). What refuses a start,
 * with nothing written; the month's evaluation budget; the ledger the database holds.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

const HOLDOUT_INPUT =
  'Find the pelican-orchard batch host that stopped answering after midnight and restart it once.';
const DEV_INPUT = 'Restart the web-1 container if it is not answering on its health port.';

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
      ip: '198.51.100.30',
      startedAt: new Date().toISOString(),
      finishedAt: undefined,
      reason: undefined,
    });
    return { containerId, ip: '198.51.100.30' };
  }

  async terminate(): Promise<boolean> {
    return true;
  }

  async status(workerRunId: string): Promise<TaskSupervisorStatus | undefined> {
    return this.statuses.get(workerRunId);
  }

  crash(workerRunId: string): void {
    const current = this.statuses.get(workerRunId);
    if (current) this.statuses.set(workerRunId, { ...current, status: 'failed', exitCode: 137 });
  }
}

function operation(name: string, extra: Partial<Operation> = {}): Operation {
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
    ...extra,
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected the call to be refused');
    },
    (err: unknown) => err,
  );
}

describe.runIf(DATABASE_URL !== undefined)(
  'evaluation runs (S10 E3-2a, integration, real Postgres)',
  () => {
    let pool: Pool;
    let privateKey: Awaited<ReturnType<typeof generateEphemeralHandleKeyPair>>['privateKey'];
    let workspaceId: string;
    const people = {
      owner: randomUUID(),
      builder: randomUUID(),
      member: randomUUID(),
    } as const;
    let workerDefinitionId: string;
    let gate: string;
    let otherGate: string;
    let suite: EvalSuiteWire;
    let devCaseId: string;
    let holdoutCaseId: string;
    const supervisor = new FakeSupervisor();
    const deps = () => ({ pool, privateKey, supervisorClient: supervisor });

    function person(role: keyof typeof people): ResolvedCaller {
      const id = people[role];
      return {
        channel: 'human',
        principal: { workspaceId, id, kind: 'human', role: role as Role, displayName: null },
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

    async function publishedDefinition(systemPrompt: string): Promise<string> {
      const proposed = await asApp((client) =>
        proposeWorkerDefinition(client, workspaceId, people.owner, {
          kind: 'worker',
          definition: { systemPrompt },
        }),
      );
      await asApp((client) =>
        publishWorkerDefinition(client, workspaceId, people.owner, {
          definitionId: proposed.id,
          version: proposed.version,
        }),
      );
      return proposed.id;
    }

    async function registerGate(name: string, operations: Operation[]): Promise<string> {
      return asApp(async (client) => {
        const activity = await startActivity(client, workspaceId, {
          kind: 'test.connection',
          principalId: people.owner,
        });
        const registered = await registerGatekeeper(client, workspaceId, {
          name,
          transportKind: 'http',
          target: `${name}-system`,
          endpoint: `http://${name}.invalid`,
          activityId: activity.id,
          registeredBy: { id: people.owner, kind: 'human' },
        });
        await importManifest(client, workspaceId, {
          gatekeeperId: registered.gatekeeperId,
          operations,
          proposedBy: { id: people.owner, kind: 'human' },
          activityId: activity.id,
        });
        for (const op of operations) {
          await publishOperation(client, workspaceId, {
            gatekeeperId: registered.gatekeeperId,
            name: op.name,
            actor: { principalId: people.owner, role: 'owner' },
            absentAnswersReviewed: true,
          });
        }
        return registered.gatekeeperId;
      });
    }

    /** A suite pinned to `definitionId` v1 with `gate` as its fixture gate. */
    async function suiteFor(name: string, definitionId: string): Promise<EvalSuiteWire> {
      const created = await call<EvalSuiteWire>(person('builder'), 'create_eval_suite', {
        name,
        workerDefinitionId: definitionId,
        workerDefinitionVersion: 1,
      });
      return call<EvalSuiteWire>(person('builder'), 'add_eval_fixture_gate', {
        suiteId: created.id,
        suiteVersion: created.version,
        gatekeeperId: gate,
      });
    }

    /** Restarts web-1 when it hangs; "not there" for any other host's read; restarts once. */
    function restartCase(input: string, split: 'dev' | 'holdout', title: string) {
      return {
        partition: 'regression',
        split,
        title,
        input,
        fixtures: [
          {
            gatekeeperId: gate,
            operation: 'hosts.get',
            when: { path: 'host', op: 'eq', value: 'web-1' },
            answer: { kind: 'data', data: { host: 'web-1', state: 'hung' } },
          },
          { gatekeeperId: gate, operation: 'hosts.get', answer: { kind: 'absent' } },
          {
            gatekeeperId: gate,
            operation: 'hosts.restart',
            answer: { kind: 'data', data: { restarted: true } },
          },
        ],
        assertions: [
          {
            expect: { path: evalCallCountPath(gate, 'hosts.restart'), op: 'eq', value: 1 },
            note: 'restarts exactly once',
          },
          { expect: { path: 'result.summary', op: 'contains', value: 'web-1' } },
        ],
      };
    }

    async function addCase(
      target: EvalSuiteWire,
      content: ReturnType<typeof restartCase>,
    ): Promise<EvalSuiteWire> {
      return call<EvalSuiteWire>(person('builder'), 'add_eval_case', {
        suiteId: target.id,
        suiteVersion: target.version,
        ...content,
      });
    }

    async function currentSuite(suiteId = suite.id): Promise<EvalSuiteWire> {
      return call<EvalSuiteWire>(person('builder'), 'get_eval_suite', { suiteId });
    }

    interface StartedTrial {
      readonly run: EvalRunWire;
      readonly taskId: string;
      readonly spawn: TaskSpawnInput;
      readonly worker: ResolvedCaller;
      readonly claims: HandleClaims;
    }

    /** A builder's 试跑 of `caseId`, and the Worker it started, as its Handle calls. */
    async function startTrial(caseId: string, suiteId = suite.id): Promise<StartedTrial> {
      const current = await currentSuite(suiteId);
      const run = await call<EvalRunWire>(person('builder'), 'start_eval_case_trial', {
        suiteId,
        suiteVersion: current.version,
        caseId,
      });
      const taskId = run.trials[0]?.taskId as string;
      const spawn = supervisor.spawnCalls.find((sent) => sent.taskId === taskId);
      if (!spawn) throw new Error(`no Worker was started for Task ${taskId}`);
      const claims = workerClaims(spawn);
      return { run, taskId, spawn, worker: { channel: 'handle', claims }, claims };
    }

    /** Placeholder claims for a usage row that only needs a session and a jti. */
    const trialLessClaims: HandleClaims = {
      ws: '',
      sid: '',
      obo: '',
      scope: { capabilities: [], resources: {} },
      jti: '',
      iat: 0,
      exp: 0,
    };

    function workerClaims(spawn: TaskSpawnInput): HandleClaims {
      const payload = decodeJwt(spawn.capabilityHandle) as unknown as HandleClaims;
      return {
        ws: payload.ws,
        sid: payload.sid,
        obo: payload.obo,
        scope: payload.scope,
        jti: payload.jti,
        iat: payload.iat,
        exp: payload.exp,
      };
    }

    async function readRun(runId: string): Promise<EvalRunWire> {
      return call<EvalRunWire>(person('member'), 'get_eval_run', { runId });
    }

    /** What the trial's model calls cost, as the LLM proxy records it. */
    async function recordUsage(
      claims: HandleClaims,
      costUsd: number | null,
      tokens = { input: 100, output: 20 },
    ): Promise<void> {
      await asOwnerRole((client) =>
        client.query(
          `insert into llm_usage (workspace_id, session_id, jti, provider, model, input_tokens, output_tokens, cost_usd, started_at, status)
           values ($1, $2, $3, 'p', 'm', $4, $5, $6, now(), 'completed')`,
          [workspaceId, claims.sid, claims.jti, tokens.input, tokens.output, costUsd],
        ),
      );
    }

    interface OrdinaryTaskRun {
      readonly taskId: string;
      readonly workerRunId: string;
      readonly sessionId: string;
      readonly jti: string;
    }

    /** A person's ordinary Task and its ended WorkerRun, written as the kernel leaves them, with
     *  a Handle for the run's session (what a model call's usage row names). */
    async function ordinaryTaskRun(): Promise<OrdinaryTaskRun> {
      return asOwnerRole(async (client) => {
        const session = await client.query<{ id: string }>(
          `insert into sessions (workspace_id, principal_id, kind, on_behalf_of, status)
           values ($1, $2, 'worker_run', $2, 'active') returning id`,
          [workspaceId, people.owner],
        );
        const sessionId = session.rows[0]?.id as string;
        const task = await client.query<{ id: string }>(
          `insert into tasks (workspace_id, status, on_behalf_of, worker_definition_id, worker_definition_version)
           values ($1, 'completed', $2, $3, 1) returning id`,
          [workspaceId, people.owner, workerDefinitionId],
        );
        const taskId = task.rows[0]?.id as string;
        const run = await client.query<{ id: string }>(
          `insert into worker_runs (workspace_id, status, task_id, session_id, depth, attempt)
           values ($1, 'terminated', $2, $3, 0, 1) returning id`,
          [workspaceId, taskId, sessionId],
        );
        const issued = await issueHandle(client, {
          sessionId,
          scope: entryScope(),
          ttlSeconds: 600,
          privateKey,
        });
        return { taskId, workerRunId: run.rows[0]?.id as string, sessionId, jti: issued.jti };
      });
    }

    async function count(sql: string, params: unknown[] = [workspaceId]): Promise<number> {
      const result = await asOwnerRole((client) =>
        client.query<{ n: number }>(`select count(*)::int as n from (${sql}) counted`, params),
      );
      return result.rows[0]?.n ?? 0;
    }

    async function evaluationPrincipalId(): Promise<string> {
      const found = await asOwnerRole((client) =>
        client.query<{ id: string }>(
          'select id from principals where workspace_id = $1 and display_name = $2',
          [workspaceId, EVALUATION_PRINCIPAL_DISPLAY_NAME],
        ),
      );
      return found.rows[0]?.id as string;
    }

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
            'e3-2a-eval-runs',
          ]);
          for (const [role, id] of Object.entries(people)) {
            await client.query(
              "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', $3, $3)",
              [workspaceId, id, role],
            );
          }
        },
        { skipRoleSwitch: true },
      );
      workerDefinitionId = await publishedDefinition('You are a plain worker.');
      gate = await registerGate('hosts', [
        operation('hosts.list'),
        operation('hosts.get', {
          binding: { kind: 'http', method: 'GET', path: '/hosts/{host}', absent_statuses: [404] },
        }),
        operation('hosts.restart', {
          mode: 'execute',
          blast_radius: 'medium',
          auto_approvable: false,
          binding: { kind: 'http', method: 'POST', path: '/hosts/{host}/restart' },
        }),
      ]);
      otherGate = await registerGate('tickets', [operation('tickets.list')]);

      const withGate = await suiteFor('Restarts', workerDefinitionId);
      const withDev = await addCase(withGate, restartCase(DEV_INPUT, 'dev', 'Restart web-1'));
      suite = await addCase(
        withDev,
        restartCase(HOLDOUT_INPUT, 'holdout', 'Restart the stopped batch host'),
      );
      devCaseId = suite.cases.find((c) => c.split === 'dev')?.id as string;
      holdoutCaseId = suite.cases.find((c) => c.split === 'holdout')?.id as string;

      configureTaskRuntime(deps());
    });

    afterAll(async () => {
      resetTaskRuntimeForTests();
      await pool.end();
    });

    it("a builder's 试跑 runs one evaluation Task for the evaluation Principal: closed Handle, fixture gates as its scope, egress denied", async () => {
      const trial = await startTrial(devCaseId);
      expect(trial.run).toMatchObject({
        suiteId: suite.id,
        suiteVersion: suite.version,
        kind: 'case_trial',
        workerDefinition: { id: workerDefinitionId, version: 1 },
        k: 1,
        status: 'running',
        createdBy: people.builder,
        finishedAt: null,
      });
      expect(trial.run.trials).toHaveLength(1);
      expect(trial.run.trials[0]).toMatchObject({
        arm: 'baseline',
        caseId: devCaseId,
        caseTitle: 'Restart web-1',
        rep: 1,
        status: 'running',
        verdict: null,
        error: null,
        assertions: [],
        result: null,
        calls: [],
      });

      const principal = await asOwnerRole((client) =>
        client.query<{ id: string; kind: string; role: string }>(
          'select id, kind, role from principals where workspace_id = $1 and display_name = $2',
          [workspaceId, EVALUATION_PRINCIPAL_DISPLAY_NAME],
        ),
      );
      expect(principal.rows).toHaveLength(1);
      expect(principal.rows[0]).toMatchObject({ kind: 'service', role: 'member' });
      const evaluator = principal.rows[0]?.id as string;

      const task = await asOwnerRole((client) =>
        client.query<{
          purpose: string;
          on_behalf_of: string;
          status: string;
          input: unknown;
          observe_scope: string[];
          worker_definition_id: string;
        }>(
          'select purpose, on_behalf_of, status, input, observe_scope, worker_definition_id from tasks where workspace_id = $1 and id = $2',
          [workspaceId, trial.taskId],
        ),
      );
      expect(task.rows[0]).toMatchObject({
        purpose: 'evaluation',
        on_behalf_of: evaluator,
        status: 'running',
        input: DEV_INPUT,
        observe_scope: [gate],
        worker_definition_id: workerDefinitionId,
      });

      expect(trial.spawn).toMatchObject({ onBehalfOf: evaluator, egressDenyAll: true });
      expect(trial.claims.obo).toBe(evaluator);
      expect([...trial.claims.scope.capabilities].sort()).toEqual(
        [
          'get_task',
          'list_allowed_operations',
          'observe_operation',
          'report_task_result',
          'request_action',
        ].sort(),
      );
      expect(trial.claims.scope.resources).toEqual({});

      // The start is the builder's, on the run.
      const audit = await asOwnerRole((client) =>
        client.query<{ actor_principal_id: string; resource_type: string; payload: unknown }>(
          `select actor_principal_id, resource_type, payload from audit_records
            where workspace_id = $1 and action = 'start_eval_case_trial' and resource_id = $2`,
          [workspaceId, trial.run.id],
        ),
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]).toMatchObject({
        actor_principal_id: people.builder,
        resource_type: 'eval_run',
        payload: { taskId: trial.taskId },
      });

      // A second 试跑 acts for the same Principal: one per workspace.
      const second = await startTrial(devCaseId);
      expect(second.claims.obo).toBe(evaluator);
      await terminateTaskWith(deps(), workspaceId, evaluator, second.taskId);
      await terminateTaskWith(deps(), workspaceId, evaluator, trial.taskId);
      await runEvalTrialTick(pool);
    });

    it('its Worker reads its own Task — a held-out case input included — and the suite’s fixture tools, and is refused anything else', async () => {
      const trial = await startTrial(holdoutCaseId);
      const other = await startTrial(devCaseId);

      // Its own Task, with the case's input, though the case is held out.
      const own = await call<TaskWire>(trial.worker, 'get_task', { taskId: trial.taskId });
      expect(own).toMatchObject({ id: trial.taskId, input: HOLDOUT_INPUT, purpose: 'evaluation' });
      // Another trial's Task acts for the same Principal, and is not there for it.
      expect(
        await rejection(call(trial.worker, 'get_task', { taskId: other.taskId })),
      ).toBeInstanceOf(TaskNotFoundError);
      // …while that trial's own Worker reads it — and reading it is no leak of the held-out case.
      await expect(
        call<TaskWire>(other.worker, 'get_task', { taskId: other.taskId }),
      ).resolves.toMatchObject({ input: DEV_INPUT });

      // Its tools: the fixture gate's Operations, as frozen.
      const tools = await call<{ items: Array<{ gatekeeperId: string; name: string }> }>(
        trial.worker,
        'list_allowed_operations',
        {},
      );
      expect(tools.items.map((op) => [op.gatekeeperId, op.name])).toEqual([
        [gate, 'hosts.get'],
        [gate, 'hosts.list'],
        [gate, 'hosts.restart'],
      ]);

      // A capability outside the five: the Handle's scope refuses it first…
      const outsideScope = await rejection(call(trial.worker, 'find_workers', {}));
      expect(outsideScope).toBeInstanceOf(ForbiddenError);
      // …and a Handle claiming more for this session meets the gateway's second wall.
      const widened: ResolvedCaller = {
        channel: 'handle',
        claims: {
          ...trial.claims,
          scope: {
            capabilities: [...trial.claims.scope.capabilities, 'get_object', 'invoke_worker'],
            resources: {},
          },
        },
      };
      const refused = await rejection(call(widened, 'get_object', { objectId: randomUUID() }));
      expect(refused).toBeInstanceOf(ForbiddenError);
      expect((refused as Error).message).toMatch(/^evaluation_run_capability_refused:/);

      const evaluator = await evaluationPrincipalId();
      for (const started of [trial, other]) {
        await terminateTaskWith(deps(), workspaceId, evaluator, started.taskId);
      }
      await runEvalTrialTick(pool);
    });

    it('gate calls are answered from the case’s fixtures, recorded in order and audited as evaluation calls — no gate, no request, no observation', async () => {
      const trial = await startTrial(devCaseId);
      const before = {
        requests: await count('select 1 from action_requests where workspace_id = $1'),
        observations: await count('select 1 from observations where workspace_id = $1'),
        gateAudits: await count(
          "select 1 from audit_records where workspace_id = $1 and action in ('observe_operation', 'request_action')",
        ),
      };

      // `when` matches: the data rule.
      await expect(
        call(trial.worker, 'observe_operation', {
          gatekeeperId: gate,
          operation: 'hosts.get',
          params: { host: 'web-1', apiToken: 'hunter2' },
        }),
      ).resolves.toEqual({
        status: 'ok',
        data: { host: 'web-1', state: 'hung' },
        observedFactCount: 0,
      });
      // Another host: the gate's declared "not there".
      await expect(
        call(trial.worker, 'observe_operation', {
          gatekeeperId: gate,
          operation: 'hosts.get',
          params: { host: 'db-9' },
        }),
      ).resolves.toEqual({
        status: 'ok',
        data: null,
        observedFactCount: 0,
        absent: { status: 404 },
      });
      // An execute-class request: simulated as executed, nothing queued for approval.
      await expect(
        call(trial.worker, 'request_action', {
          gatekeeperId: gate,
          operation: 'hosts.restart',
          params: { host: 'web-1' },
        }),
      ).resolves.toMatchObject({ status: 'executed', data: { restarted: true } });
      // No rule: the call fails as a gate whose target failed — after it is recorded.
      const unanswered = await rejection(
        call(trial.worker, 'observe_operation', {
          gatekeeperId: gate,
          operation: 'hosts.list',
          params: {},
        }),
      );
      expect(unanswered).toBeInstanceOf(GatekeeperClientError);
      expect(unanswered).toMatchObject({ status: 502, code: 'transport_error' });

      // Refused as the real call would be, and not recorded: an execute Operation through
      // observe_operation, a gate outside the suite, an Operation the gate does not have.
      const notObserve = await rejection(
        call(trial.worker, 'observe_operation', {
          gatekeeperId: gate,
          operation: 'hosts.restart',
          params: {},
        }),
      );
      expect(notObserve).toBeInstanceOf(ForbiddenError);
      const outside = await rejection(
        call(trial.worker, 'observe_operation', {
          gatekeeperId: otherGate,
          operation: 'tickets.list',
          params: {},
        }),
      );
      expect(outside).toBeInstanceOf(ForbiddenError);
      expect((outside as Error).message).toMatch(/^excluded_by_policy:/);
      expect(
        await rejection(
          call(trial.worker, 'observe_operation', {
            gatekeeperId: gate,
            operation: 'hosts.reboot',
            params: {},
          }),
        ),
      ).toBeInstanceOf(OperationNotFoundError);

      const run = await readRun(trial.run.id);
      const calls = run.trials[0]?.calls ?? [];
      expect(calls.map((c) => [c.seq, c.gate, c.operation, c.mode, c.answer, c.ruleIndex])).toEqual(
        [
          [1, 'hosts', 'hosts.get', 'observe', 'data', 0],
          [2, 'hosts', 'hosts.get', 'observe', 'absent', 1],
          [3, 'hosts', 'hosts.restart', 'execute', 'data', 2],
          [4, 'hosts', 'hosts.list', 'observe', 'unanswered', null],
        ],
      );
      // The recorded params keep a secret-named field's value out.
      expect(calls[0]?.params.host).toBe('web-1');
      expect(JSON.stringify(calls[0]?.params)).not.toContain('hunter2');

      // Audited as evaluation calls — none as a call a gate answered or refused.
      const fixtureAudits = await asOwnerRole((client) =>
        client.query<{ payload: Record<string, unknown> }>(
          `select payload from audit_records
            where workspace_id = $1 and action = 'evaluation.fixture_call'
              and payload -> 'evaluation' ->> 'trialId' = $2
            order by created_at, id`,
          [workspaceId, run.trials[0]?.id],
        ),
      );
      expect(
        fixtureAudits.rows.map((row) => [
          row.payload.capability,
          (row.payload.evaluation as { seq: number; answer: string }).seq,
          (row.payload.evaluation as { seq: number; answer: string }).answer,
        ]),
      ).toEqual([
        ['observe_operation', 1, 'data'],
        ['observe_operation', 2, 'absent'],
        ['request_action', 3, 'data'],
        ['observe_operation', 4, 'unanswered'],
      ]);
      expect(await count('select 1 from action_requests where workspace_id = $1')).toBe(
        before.requests,
      );
      expect(await count('select 1 from observations where workspace_id = $1')).toBe(
        before.observations,
      );
      expect(
        await count(
          "select 1 from audit_records where workspace_id = $1 and action in ('observe_operation', 'request_action')",
        ),
      ).toBe(before.gateAudits);

      const evaluator = await evaluationPrincipalId();
      await terminateTaskWith(deps(), workspaceId, evaluator, trial.taskId);
      await runEvalTrialTick(pool);
    });

    it('its report completes the Task and writes nothing else; the runner scores the trial on {result, calls} and finishes the run', async () => {
      const passing = await startTrial(devCaseId);
      const failing = await startTrial(devCaseId);
      const facts = await count('select 1 from links where workspace_id = $1');
      const activities = await count('select 1 from activities where workspace_id = $1');

      // Passing: one restart, a summary naming web-1.
      await call(passing.worker, 'request_action', {
        gatekeeperId: gate,
        operation: 'hosts.restart',
        params: { host: 'web-1' },
      });
      await recordUsage(passing.claims, 0.12, { input: 1000, output: 200 });
      await recordUsage(passing.claims, 0.03, { input: 300, output: 50 });
      const reported = await call<{ id: string; status: string; factIds: string[] }>(
        passing.worker,
        'report_task_result',
        {
          summary: 'Restarted web-1 once; it answers again.',
          factsToAssert: [
            {
              linkType: 'runs_on',
              source: { objectType: 'Host', identity: { name: 'web-1' } },
              target: { objectType: 'Host', identity: { name: 'rack-1' } },
            },
          ],
        },
      );
      expect(reported).toMatchObject({ id: passing.taskId, status: 'completed', factIds: [] });
      // Its report ends the trial for its Worker, before the runner scores it: a second restart
      // is refused, not recorded, and does not count against "restarts exactly once".
      const late = await rejection(
        call(passing.worker, 'request_action', {
          gatekeeperId: gate,
          operation: 'hosts.restart',
          params: { host: 'web-1' },
        }),
      );
      expect(late).toBeInstanceOf(ForbiddenError);
      expect((late as Error).message).toMatch(/^evaluation_run_ended:/);

      // Failing: restarts twice, and the summary does not name the host.
      for (let i = 0; i < 2; i += 1) {
        await call(failing.worker, 'request_action', {
          gatekeeperId: gate,
          operation: 'hosts.restart',
          params: { host: `web-${i}` },
        });
      }
      await recordUsage(failing.claims, null);
      await call(failing.worker, 'report_task_result', { summary: 'Restarted the hosts.' });

      expect(await count('select 1 from links where workspace_id = $1')).toBe(facts);
      expect(await count('select 1 from activities where workspace_id = $1')).toBe(activities);

      // Not scored before the tick.
      expect((await readRun(passing.run.id)).trials[0]?.status).toBe('running');
      expect(await runEvalTrialTick(pool)).toBeGreaterThanOrEqual(2);

      const passed = await readRun(passing.run.id);
      expect(passed.status).toBe('finished');
      expect(passed.finishedAt).not.toBeNull();
      expect(passed.trials[0]).toMatchObject({
        status: 'scored',
        verdict: 'passed',
        error: null,
        assertions: [
          { index: 0, outcome: 'satisfied', note: 'restarts exactly once' },
          { index: 1, outcome: 'satisfied', note: null },
        ],
        result: { summary: 'Restarted web-1 once; it answers again.' },
        tokens: 1550,
      });
      expect(passed.trials[0]?.costUsd).toBeCloseTo(0.15, 6);
      // The report is kept as reported (its facts unwritten, there for the assertions).
      expect(passed.trials[0]?.result).toHaveProperty('factsToAssert');

      const failed = await readRun(failing.run.id);
      expect(failed.trials[0]).toMatchObject({
        status: 'scored',
        verdict: 'failed',
        assertions: [
          { index: 0, outcome: 'unsatisfied' },
          { index: 1, outcome: 'unsatisfied' },
        ],
        // A model call with no price: no cost for the trial.
        costUsd: null,
      });

      // Audited on the run, without the report or the case.
      const ends = await asOwnerRole((client) =>
        client.query<{ actor_principal_id: string; payload: Record<string, unknown> }>(
          `select actor_principal_id, payload from audit_records
            where workspace_id = $1 and action = $2 and resource_type = 'eval_run' and resource_id = $3`,
          [workspaceId, EVALUATION_TRIAL_END_ACTION, passing.run.id],
        ),
      );
      expect(ends.rows).toHaveLength(1);
      expect(ends.rows[0]?.actor_principal_id).toBe(await evaluationPrincipalId());
      expect(ends.rows[0]?.payload).toMatchObject({
        suiteId: suite.id,
        trialId: passed.trials[0]?.id,
        taskId: passing.taskId,
        status: 'scored',
        verdict: 'passed',
        tokens: 1550,
        runFinished: true,
      });
      expect(JSON.stringify(ends.rows[0]?.payload)).not.toContain('web-1');

      // A second tick finds nothing more to score for these, and a call after the end is refused.
      await runEvalTrialTick(pool);
      expect(
        await count(
          'select 1 from audit_records where workspace_id = $1 and action = $2 and resource_id = $3',
          [workspaceId, EVALUATION_TRIAL_END_ACTION, passing.run.id],
        ),
      ).toBe(1);
      await expect(
        call(passing.worker, 'observe_operation', {
          gatekeeperId: gate,
          operation: 'hosts.get',
          params: { host: 'web-1' },
        }),
      ).rejects.toThrow();
      expect((await readRun(passing.run.id)).trials[0]?.calls).toHaveLength(1);
    });

    it('a trial whose Task ends without a report is errored: cancelled, a crash (never retried), a start the seal withheld', async () => {
      const evaluator = await evaluationPrincipalId();

      const cancelled = await startTrial(devCaseId);
      await terminateTaskWith(deps(), workspaceId, evaluator, cancelled.taskId);

      const crashed = await startTrial(devCaseId);
      const spawnsBefore = supervisor.spawnCalls.length;
      supervisor.crash(crashed.spawn.workerRunId);
      await reactToSupervisorStatus(deps(), workspaceId, evaluator, crashed.spawn.workerRunId);
      // One try: no second run.
      expect(supervisor.spawnCalls.length).toBe(spawnsBefore);
      const crashedTask = await asOwnerRole((client) =>
        client.query<{ status: string; failure_reason: string; retry_count: number }>(
          'select status, failure_reason, retry_count from tasks where workspace_id = $1 and id = $2',
          [workspaceId, crashed.taskId],
        ),
      );
      expect(crashedTask.rows[0]).toMatchObject({
        status: 'failed',
        failure_reason: 'worker_failed',
        retry_count: 0,
      });

      // A Worker whose system prompt carries a held-out case's text is not started.
      const leaky = await publishedDefinition(`Background notes. ${HOLDOUT_INPUT}`);
      const leakySuite = await addCase(
        await suiteFor('Leaky worker', leaky),
        restartCase(DEV_INPUT, 'dev', 'Restart web-1'),
      );
      const leakyCaseId = leakySuite.cases[0]?.id as string;
      const spawnsBeforeLeaky = supervisor.spawnCalls.length;
      const withheldRun = await call<EvalRunWire>(person('builder'), 'start_eval_case_trial', {
        suiteId: leakySuite.id,
        suiteVersion: leakySuite.version,
        caseId: leakyCaseId,
      });
      expect(supervisor.spawnCalls.length).toBe(spawnsBeforeLeaky);
      const withheldTaskId = withheldRun.trials[0]?.taskId as string;
      expect(
        await count(
          "select 1 from audit_records where workspace_id = $1 and action = $2 and resource_type = 'task' and resource_id = $3",
          [workspaceId, EVALUATION_WITHHELD_ACTION, withheldTaskId],
        ),
      ).toBe(1);

      await runEvalTrialTick(pool);
      const outcome = async (runId: string) => (await readRun(runId)).trials[0];
      expect(await outcome(cancelled.run.id)).toMatchObject({
        status: 'errored',
        verdict: null,
        error: 'cancelled',
        assertions: [],
      });
      expect(await outcome(crashed.run.id)).toMatchObject({
        status: 'errored',
        error: 'worker_failed',
      });
      expect(await outcome(withheldRun.id)).toMatchObject({
        status: 'errored',
        error: 'withheld',
      });
      for (const runId of [cancelled.run.id, crashed.run.id, withheldRun.id]) {
        expect((await readRun(runId)).status).toBe('finished');
      }
    });

    it('a start is refused, with nothing written, for a changed suite, a case it no longer holds, a version no longer published, a missing suite or case, and anyone but a builder in person', async () => {
      const written = async () => ({
        runs: await count('select 1 from eval_runs where workspace_id = $1'),
        tasks: await count('select 1 from tasks where workspace_id = $1'),
      });
      const before = await written();
      const current = await currentSuite();
      const start = (who: ResolvedCaller, params: Record<string, unknown>) =>
        call(who, 'start_eval_case_trial', {
          suiteId: suite.id,
          suiteVersion: current.version,
          caseId: devCaseId,
          ...params,
        });

      const stale = await rejection(
        start(person('builder'), { suiteVersion: current.version - 1 }),
      );
      expect(stale).toBeInstanceOf(ReviewedVersionChangedError);
      expect(await rejection(start(person('builder'), { caseId: randomUUID() }))).toBeInstanceOf(
        EvalCaseNotFoundError,
      );
      expect(await rejection(start(person('builder'), { suiteId: randomUUID() }))).toBeInstanceOf(
        EvalSuiteNotFoundError,
      );
      expect(await rejection(start(person('member'), {}))).toBeInstanceOf(ForbiddenError);
      const agent: ResolvedCaller = {
        channel: 'handle',
        claims: {
          ws: workspaceId,
          sid: randomUUID(),
          obo: people.owner,
          scope: { capabilities: ['start_eval_case_trial'], resources: {} },
          jti: randomUUID(),
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 600,
        },
      };
      expect(await rejection(start(agent, {}))).toBeInstanceOf(ForbiddenError);

      // A retired case: the suite no longer holds it.
      const withExtra = await addCase(current, restartCase(DEV_INPUT, 'dev', 'Retire me'));
      const extraId = withExtra.cases.find((c) => c.title === 'Retire me')?.id as string;
      const retired = await call<EvalSuiteWire>(person('builder'), 'retire_eval_case', {
        suiteId: suite.id,
        suiteVersion: withExtra.version,
        caseId: extraId,
        reason: 'Covered by the first case.',
      });
      const afterRetire = await written();
      expect(
        await rejection(
          call(person('builder'), 'start_eval_case_trial', {
            suiteId: suite.id,
            suiteVersion: retired.version,
            caseId: extraId,
          }),
        ),
      ).toBeInstanceOf(EvalSuiteStateError);

      // The pinned version deprecated since.
      const retiredDefinition = await publishedDefinition('You will be deprecated.');
      const pinned = await addCase(
        await suiteFor('Deprecated worker', retiredDefinition),
        restartCase(DEV_INPUT, 'dev', 'Restart web-1'),
      );
      await asApp((client) =>
        deprecateWorkerDefinition(client, workspaceId, {
          definitionId: retiredDefinition,
          version: 1,
        }),
      );
      const beforeDeprecated = await written();
      expect(
        await rejection(
          call(person('builder'), 'start_eval_case_trial', {
            suiteId: pinned.id,
            suiteVersion: pinned.version,
            caseId: pinned.cases[0]?.id,
          }),
        ),
      ).toBeInstanceOf(EvalSuiteStateError);

      expect(afterRetire).toEqual(before);
      expect(await written()).toEqual(beforeDeprecated);
    });

    it('the month’s evaluation budget: read from evaluation Tasks’ model calls only, set by the owner, and a start refused once it is spent', async () => {
      const budget = await call<EvalBudgetWire>(person('member'), 'get_eval_budget', {});
      expect(budget.monthlyBudgetUsd).toBe(10);
      // The priced calls of the scored trials above: 0.12 + 0.03.
      expect(budget.spentUsd).toBeCloseTo(0.15, 6);
      expect(budget.unpricedTrials).toBe(1);
      expect(budget.trialCostUsd).toBeCloseTo(0.15 / 1, 6);
      const start = new Date(budget.periodStart);
      expect(start.getUTCDate()).toBe(1);
      expect(start.getUTCHours()).toBe(0);
      expect(new Date(budget.periodEnd).getUTCMonth()).toBe((start.getUTCMonth() + 1) % 12);

      // An ordinary Task's model calls — a WorkerRun like a trial's — are not evaluation spending.
      const ordinary = await ordinaryTaskRun();
      await recordUsage({ ...trialLessClaims, sid: ordinary.sessionId, jti: ordinary.jti }, 3.0);
      expect(
        (await call<EvalBudgetWire>(person('member'), 'get_eval_budget', {})).spentUsd,
      ).toBeCloseTo(0.15, 6);

      // The owner sets it; it is never unlimited.
      expect(
        await rejection(
          call(person('owner'), 'set_quota', {
            key: 'evaluation.monthly_cost_budget_usd',
            value: null,
          }),
        ),
      ).toBeInstanceOf(Error);
      expect(
        await rejection(
          call(person('builder'), 'set_quota', {
            key: 'evaluation.monthly_cost_budget_usd',
            value: 50,
          }),
        ),
      ).toBeInstanceOf(ForbiddenError);
      await call(person('owner'), 'set_quota', {
        key: 'evaluation.monthly_cost_budget_usd',
        value: 0.1,
      });
      expect(
        (await call<EvalBudgetWire>(person('member'), 'get_eval_budget', {})).monthlyBudgetUsd,
      ).toBe(0.1);

      const runsBefore = await count('select 1 from eval_runs where workspace_id = $1');
      const current = await currentSuite();
      const exhausted = await rejection(
        call(person('builder'), 'start_eval_case_trial', {
          suiteId: suite.id,
          suiteVersion: current.version,
          caseId: devCaseId,
        }),
      );
      expect(exhausted).toBeInstanceOf(EvaluationBudgetExhaustedError);
      expect(exhausted).toMatchObject({
        code: 'evaluation_budget_exhausted',
        details: { budgetUsd: 0.1 },
      });
      expect((exhausted as EvaluationBudgetExhaustedError).details.spentUsd).toBeCloseTo(0.15, 6);
      expect(await count('select 1 from eval_runs where workspace_id = $1')).toBe(runsBefore);

      await call(person('owner'), 'set_quota', {
        key: 'evaluation.monthly_cost_budget_usd',
        value: 10,
      });
    });

    it('lists a suite’s runs newest first, by case; an unknown run or suite is not found', async () => {
      const listed = await call<{ items: EvalRunSummaryWire[] }>(
        person('member'),
        'list_eval_runs',
        {
          suiteId: suite.id,
        },
      );
      expect(listed.items.length).toBeGreaterThan(0);
      const times = listed.items.map((run) => run.createdAt);
      expect([...times].sort().reverse()).toEqual(times);
      const scored = listed.items.find((run) => run.passed === 1);
      expect(scored).toMatchObject({ kind: 'case_trial', caseIds: [devCaseId], failed: 0 });
      expect(scored?.costUsd).toBeCloseTo(0.15, 6);

      const holdoutRuns = await call<{ items: EvalRunSummaryWire[] }>(
        person('member'),
        'list_eval_runs',
        { suiteId: suite.id, caseId: holdoutCaseId },
      );
      expect(holdoutRuns.items.length).toBeGreaterThan(0);
      expect(holdoutRuns.items.every((run) => run.caseIds.includes(holdoutCaseId))).toBe(true);

      expect(
        await rejection(call(person('member'), 'get_eval_run', { runId: randomUUID() })),
      ).toBeInstanceOf(EvalRunNotFoundError);
      expect(
        await rejection(call(person('member'), 'list_eval_runs', { suiteId: randomUUID() })),
      ).toBeInstanceOf(EvalSuiteNotFoundError);
    });

    // After the budget and list tests: this trial is scored at no cost, which would move the average.
    it('a held-out case’s own fixture answers reach its Worker though its assertions quote them; text only its assertions hold stays withheld', async () => {
      const NOTE = 'heron-quay went quiet once the overnight ledger export finished writing';
      const FAILURE = 'heron-quay is draining its replication backlog and refuses reads for now';
      const ASSERTED_ONLY =
        'an operator confirmed that heron-quay recovered without anyone touching it';
      const INPUT =
        'Read heron-quay and one host next to it, and quote what each of them answered.';
      const target = await suiteFor('Quoted answers', workerDefinitionId);
      const quoting = await call<EvalSuiteWire>(person('builder'), 'add_eval_case', {
        suiteId: target.id,
        suiteVersion: target.version,
        partition: 'regression',
        split: 'holdout',
        title: 'Quote what the hosts answer',
        input: INPUT,
        fixtures: [
          {
            gatekeeperId: gate,
            operation: 'hosts.get',
            when: { path: 'host', op: 'eq', value: 'heron-quay' },
            answer: { kind: 'data', data: { host: 'heron-quay', note: NOTE } },
          },
          {
            gatekeeperId: gate,
            operation: 'hosts.get',
            answer: { kind: 'error', message: FAILURE },
          },
        ],
        assertions: [
          { expect: { path: 'result.summary', op: 'contains', value: NOTE } },
          { expect: { path: 'result.summary', op: 'contains', value: FAILURE } },
          { expect: { path: 'result.summary', op: 'contains', value: ASSERTED_ONLY } },
          { expect: { path: evalCallCountPath(gate, 'hosts.get'), op: 'eq', value: 2 } },
        ],
      });
      const evaluator = await evaluationPrincipalId();
      const withheld = () =>
        count(
          'select 1 from audit_records where workspace_id = $1 and action = $2 and actor_principal_id = $3',
          [workspaceId, EVALUATION_WITHHELD_ACTION, evaluator],
        );
      const withheldBefore = await withheld();
      const trial = await startTrial(quoting.cases[0]?.id as string, quoting.id);

      // A data answer the assertions quote: returned to the Worker, and recorded.
      await expect(
        call(trial.worker, 'observe_operation', {
          gatekeeperId: gate,
          operation: 'hosts.get',
          params: { host: 'heron-quay' },
        }),
      ).resolves.toEqual({
        status: 'ok',
        data: { host: 'heron-quay', note: NOTE },
        observedFactCount: 0,
      });
      // An error answer they quote: the call fails with it, as a gate whose target failed.
      const failed = await rejection(
        call(trial.worker, 'observe_operation', {
          gatekeeperId: gate,
          operation: 'hosts.get',
          params: { host: 'heron-annex' },
        }),
      );
      expect(failed).toBeInstanceOf(GatekeeperClientError);
      expect((failed as Error).message).toContain(FAILURE);
      await expect(
        call<TaskWire>(trial.worker, 'get_task', { taskId: trial.taskId }),
      ).resolves.toMatchObject({ input: INPUT });
      expect(await withheld()).toBe(withheldBefore);

      // What only the assertions hold is still stopped: the Worker's own report, read back, quotes
      // it, and is withheld.
      await call(trial.worker, 'report_task_result', {
        summary: `${NOTE}. ${FAILURE}. ${ASSERTED_ONLY}.`,
      });
      expect(
        await rejection(call(trial.worker, 'get_task', { taskId: trial.taskId })),
      ).toBeInstanceOf(EvaluationContentWithheldError);
      expect(await withheld()).toBe(withheldBefore + 1);

      await runEvalTrialTick(pool);
      const scored = (await readRun(trial.run.id)).trials[0];
      expect(scored).toMatchObject({ status: 'scored', verdict: 'passed' });
      expect(scored?.calls.map((c) => [c.seq, c.answer, c.ruleIndex])).toEqual([
        [1, 'data', 0],
        [2, 'error', 1],
      ]);
    });

    it('the database holds the ledger: a run finishes only with its trials ended, an ended trial and a recorded call never change', async () => {
      const trial = await startTrial(devCaseId);
      const trialId = trial.run.trials[0]?.id as string;
      await call(trial.worker, 'observe_operation', {
        gatekeeperId: gate,
        operation: 'hosts.get',
        params: { host: 'web-1' },
      });
      await expect(
        asOwnerRole((client) =>
          client.query(
            "update eval_runs set status = 'finished', finished_at = now() where workspace_id = $1 and id = $2",
            [workspaceId, trial.run.id],
          ),
        ),
      ).rejects.toThrow(/finishes only with all 1 trials ended/);
      await expect(
        asOwnerRole((client) =>
          client.query(
            "update eval_trial_calls set answer = 'error' where workspace_id = $1 and trial_id = $2",
            [workspaceId, trialId],
          ),
        ),
      ).rejects.toThrow(/kept as made/);

      await call(trial.worker, 'report_task_result', { summary: 'web-1 looked at.' });
      await runEvalTrialTick(pool);
      await expect(
        asOwnerRole((client) =>
          client.query(
            "update eval_trials set verdict = 'passed' where workspace_id = $1 and id = $2",
            [workspaceId, trialId],
          ),
        ),
      ).rejects.toThrow(/an ended trial never changes/);
      await expect(
        asOwnerRole((client) =>
          client.query('delete from eval_runs where workspace_id = $1 and id = $2', [
            workspaceId,
            trial.run.id,
          ]),
        ),
      ).rejects.toThrow(/never deleted/);
      // And a Task's purpose is fixed.
      await expect(
        asOwnerRole((client) =>
          client.query('update tasks set purpose = null where workspace_id = $1 and id = $2', [
            workspaceId,
            trial.taskId,
          ]),
        ),
      ).rejects.toThrow(/purpose never changes/);
    });

    it('the database holds an evaluation Task to its shape and its trials and calls to their order', async () => {
      const evaluator = await evaluationPrincipalId();
      const trial = await startTrial(devCaseId);
      const trialId = trial.run.trials[0]?.id as string;
      const ordinary = await ordinaryTaskRun();
      const write = (sql: string, params: unknown[]) =>
        asOwnerRole((client) => client.query(sql, params));
      const insertTask = (onBehalfOf: string, extra: Record<string, unknown> = {}) => {
        const columns = {
          workspace_id: workspaceId,
          status: 'queued',
          on_behalf_of: onBehalfOf,
          worker_definition_id: workerDefinitionId,
          worker_definition_version: 1,
          ...extra,
        };
        const names = Object.keys(columns);
        return write(
          `insert into tasks (${names.join(', ')}) values (${names.map((_, i) => `$${i + 1}`).join(', ')})`,
          Object.values(columns),
        );
      };

      // task/0011: the evaluation Principal acts in evaluation Tasks only, an evaluation Task
      // acts for it only, …
      const coupled = /an evaluation Task acts for the evaluation service principal/;
      await expect(insertTask(evaluator)).rejects.toThrow(coupled);
      await expect(
        insertTask(people.builder, { purpose: 'evaluation', observe_scope: [gate] }),
      ).rejects.toThrow(coupled);
      await expect(
        write('update tasks set on_behalf_of = $3 where workspace_id = $1 and id = $2', [
          workspaceId,
          trial.taskId,
          people.builder,
        ]),
      ).rejects.toThrow(coupled);
      // …with an observation scope and outside any goal, …
      await expect(insertTask(evaluator, { purpose: 'evaluation' })).rejects.toThrow(
        /tasks_evaluation_shape/,
      );
      // …and its run neither starts under another run nor starts one.
      const nested = /an evaluation Task's run neither starts under another run nor starts one/;
      const insertRun = (taskId: string, parentId: string) =>
        write(
          `insert into worker_runs (workspace_id, status, task_id, parent_worker_run_id, depth, attempt)
           values ($1, 'running', $2, $3, 1, 1)`,
          [workspaceId, taskId, parentId],
        );
      await expect(insertRun(ordinary.taskId, trial.spawn.workerRunId)).rejects.toThrow(nested);
      await expect(insertRun(trial.taskId, ordinary.workerRunId)).rejects.toThrow(nested);

      // worker/0009: a trial is added to a running run, as one of the run's own, running…
      const insertTrial = (runId: string, extra: Record<string, unknown> = {}) => {
        const columns = {
          workspace_id: workspaceId,
          run_id: runId,
          arm: 'baseline',
          case_id: devCaseId,
          rep: 1,
          ...extra,
        };
        const names = Object.keys(columns);
        return write(
          `insert into eval_trials (${names.join(', ')}) values (${names.map((_, i) => `$${i + 1}`).join(', ')})`,
          Object.values(columns),
        );
      };
      const notOwn = /a trial's arm, case and try are the run's own/;
      await expect(insertTrial(trial.run.id, { arm: 'candidate' })).rejects.toThrow(notOwn);
      await expect(insertTrial(trial.run.id, { case_id: holdoutCaseId })).rejects.toThrow(notOwn);
      await expect(insertTrial(trial.run.id, { rep: 2 })).rejects.toThrow(notOwn);
      await expect(
        insertTrial(trial.run.id, { status: 'scored', verdict: 'passed', finished_at: new Date() }),
      ).rejects.toThrow(/a trial starts running, with nothing recorded yet/);
      // …and its calls are numbered from 1, in order.
      const insertCall = (seq: number) =>
        write(
          `insert into eval_trial_calls (workspace_id, trial_id, seq, gatekeeper_id, gate_name, operation, mode, params, rule_index, answer)
           values ($1, $2, $3, $4, 'hosts', 'hosts.list', 'observe', '{}'::jsonb, null, 'unanswered')`,
          [workspaceId, trialId, seq, gate],
        );
      await expect(insertCall(2)).rejects.toThrow(/calls are numbered in order \(next is 1\)/);

      // Once the run has finished: no trial is added to it, no call to its trial.
      await call(trial.worker, 'report_task_result', { summary: 'Nothing to restart.' });
      await runEvalTrialTick(pool);
      expect((await readRun(trial.run.id)).status).toBe('finished');
      await expect(insertTrial(trial.run.id)).rejects.toThrow(/a trial is added to a running run/);
      await expect(insertCall(1)).rejects.toThrow(/a call is recorded only while its trial runs/);
    });

    // Last: it removes this test's workspace. The cascade runs with triggers off and finds the run
    // tables by their `workspace_id` like any other — the evaluation Principal and its Tasks too.
    it('the workspace purge removes runs, trials and calls with the evaluation Tasks', async () => {
      const result = await purgeWorkspace(pool, { workspaceId, confirm: true, force: true });
      expect(result.executed).toBe(true);
      expect(result.counts).toMatchObject({
        evalRuns: expect.any(Number),
        evalTrials: expect.any(Number),
        evalTrialCalls: expect.any(Number),
      });
      expect(result.counts.evalTrials).toBeGreaterThan(0);
      expect(result.counts.evalTrialCalls).toBeGreaterThan(0);
      for (const table of ['eval_runs', 'eval_trials', 'eval_trial_calls', 'tasks', 'principals']) {
        const left = await pool.query<{ count: string }>(
          `select count(*)::text as count from ${table} where workspace_id = $1`,
          [workspaceId],
        );
        expect(left.rows[0]?.count).toBe('0');
      }
    });
  },
);
