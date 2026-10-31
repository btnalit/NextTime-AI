import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type DraftEvaluationStageName,
  type DraftEvaluationSummaryWire,
  type DraftEvaluationWire,
  type EvalArm,
  type EvalBudgetWire,
  type EvalRunSummaryWire,
  type EvalRunWire,
  type EvalSuiteWire,
  type EvalTrialWire,
  type HandleClaims,
  type Operation,
  type Role,
  type SkillPublishEvidenceWire,
  evalCallCountPath,
} from '@nexttime/shared';
import { decodeJwt } from 'jose';
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
import {
  importManifest,
  publishOperation,
  registerGatekeeper,
} from '../../governance/gatekeepers/index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { EvaluationProbeHoldError, resetEvaluationSealForTests } from '../eval-seal/index.js';
import {
  DRAFT_EVALUATION_STAGE_ACTION,
  DRAFT_EVALUATION_VERDICT_ACTION,
  DraftCheckFailedError,
  DraftEvaluationNotFoundError,
  EvalRunNotFoundError,
  EvalSkillNotADraftError,
  EvalSuiteStateError,
  EvaluationBudgetExhaustedError,
  EvaluationBudgetInsufficientError,
  EvaluationChangedError,
  EvaluationReviewRequiredError,
  PublishAcknowledgementInputError,
  runEvalTrialTick,
} from '../eval/index.js';
import { getOrCreateEvaluationPrincipal } from '../eval/principal.js';
import { purgeWorkspace } from '../platform/index.js';
import { configureTaskRuntime, resetTaskRuntimeForTests } from '../task/runtime.js';
import {
  DraftEvaluatingError,
  expireDraftsOnce,
  proposeSkill,
  proposeWorkerDefinition,
  publishWorkerDefinition,
  skillDraftDigest,
} from '../worker/index.js';
import { ForbiddenError } from './authorize.js';
import { InvalidCapabilityParamsError, dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/draft-evaluations.integration.test: DB-gated (real Postgres; auto-skip
 * without DATABASE_URL) — S10 E3-2b, a Skill draft evaluated end to end: a builder starts it, both
 * arms run every stage's cases as evaluation Tasks (the baseline with the published version, the
 * candidate with the draft as the evaluation kept it, both with the same pinned other Skills),
 * the runner scores each trial and moves the funnel on — regression, mechanism, confirm — or ends
 * it at the first stage that decides; what decides (each rule, environments, a reported canary, the
 * month's budget); the draft kept while it runs; cancelling; who sees it; what refuses a start,
 * with nothing written; the ledger the database holds.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

const REGRESSION_INPUT = 'Restart the web-1 container if it is not answering on its health port.';
const MECHANISM_INPUT =
  'web-1 hangs again; the on-call asked that every restart be confirmed first.';
const CONFIRM_DEV_INPUT = 'The web-1 service stopped answering after the deploy; bring it back.';
const CONFIRM_HOLDOUT_INPUT =
  'Find the pelican-orchard batch host that stopped answering after midnight and restart it once.';
const MECHANISM = 'asks-before-restart';
const TRIAL_COST = 0.01;
const FAKE_SECRET = 'abcdefghijklmnopqrstuvwxyz0123';

const IMAGE_A = `sha256:${'a'.repeat(64)}`;
const IMAGE_B = `sha256:${'b'.repeat(64)}`;

/** In-memory supervisor: every spawn starts `running`, reports its runtime, and is recorded. */
class FakeSupervisor implements TaskSupervisorClientPort {
  readonly spawnCalls: TaskSpawnInput[] = [];
  readonly terminated: string[] = [];
  readonly statuses = new Map<string, TaskSupervisorStatus>();
  /** The image ids spawns report, in turn. */
  imageIds: readonly string[] = [IMAGE_A];

  async spawn(input: TaskSpawnInput): Promise<TaskSpawnOutcome> {
    const imageId = this.imageIds[this.spawnCalls.length % this.imageIds.length] as string;
    this.spawnCalls.push(input);
    const containerId = `container-${input.workerRunId}`;
    this.statuses.set(input.workerRunId, {
      workerRunId: input.workerRunId,
      status: 'running',
      exitCode: undefined,
      containerId,
      ip: '198.51.100.31',
      startedAt: new Date().toISOString(),
      finishedAt: undefined,
      reason: undefined,
    });
    return {
      containerId,
      ip: '198.51.100.31',
      runtime: {
        imageRef: 'nexttime/worker:test',
        imageId,
        piVersion: undefined,
        platformExtensionVersion: undefined,
        builtFrom: undefined,
        modelsConfigDigest: `sha256:${'c'.repeat(64)}`,
      },
    };
  }

  async terminate(workerRunId: string): Promise<boolean> {
    this.terminated.push(workerRunId);
    return true;
  }

  async status(workerRunId: string): Promise<TaskSupervisorStatus | undefined> {
    return this.statuses.get(workerRunId);
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

/** How a trial's Worker behaves: restarts web-1 once and says so (`pass`), does nothing
 *  (`fail`), or passes and reports the suite's canary (`canary`). */
type Act = 'pass' | 'fail' | 'canary';
type Behave = (trial: {
  readonly stage: DraftEvaluationStageName;
  readonly arm: EvalArm;
  readonly caseId: string;
}) => Act;

const allPass: Behave = () => 'pass';
const candidateWins: Behave = ({ stage, arm }) =>
  stage === 'regression' || arm === 'candidate' ? 'pass' : 'fail';

describe.runIf(DATABASE_URL !== undefined)(
  'draft evaluations (S10 E3-2b, integration, real Postgres)',
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
    let suite: EvalSuiteWire;
    let regressionOnly: EvalSuiteWire;
    let caseIds: { regression: string; mechanism: string; dev: string; holdout: string };
    let helperId: string;
    let notesId: string;
    let draftDigest: string;
    const draft = {
      name: 'restart-helper',
      description: 'Restarts a host that stopped answering.',
      markdown:
        '# Restart a host\n\nRead the host first.\nRestart it once.\nSay which host you restarted.\nAsk before you restart anything.',
    };
    const supervisor = new FakeSupervisor();
    const deps = () => ({ pool, privateKey, supervisorClient: supervisor });
    const acted = new Set<string>();

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

    async function count(sql: string, params: unknown[] = [workspaceId]): Promise<number> {
      const result = await asOwnerRole((client) =>
        client.query<{ n: number }>(`select count(*)::int as n from (${sql}) counted`, params),
      );
      return result.rows[0]?.n ?? 0;
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

    /** A Skill version proposed by `proposer`; published by the owner when `publish`. */
    async function skill(
      proposer: keyof typeof people,
      content: {
        name: string;
        description: string;
        markdown: string;
        applicable?: { gateKinds?: string[]; objectTypes?: string[] };
      },
      options: { skillId?: string; publish?: boolean } = {},
    ): Promise<{ id: string; version: number; digest: string }> {
      const row = await asApp((client) =>
        proposeSkill(client, workspaceId, people[proposer], {
          ...(options.skillId ? { skillId: options.skillId } : {}),
          ...content,
        }),
      );
      const digest = skillDraftDigest(row);
      if (options.publish) {
        await call(person('owner'), 'publish_skill', {
          skillId: row.id,
          version: row.version,
          draftDigest: digest,
        });
      }
      return { id: row.id, version: row.version, digest };
    }

    /** Restarts web-1 when it hangs: passes with exactly one restart and a summary naming it. */
    function restartCase(
      input: string,
      title: string,
      partition: 'regression' | 'mechanism' | 'full',
      split: 'dev' | 'holdout' = 'dev',
    ) {
      return {
        partition,
        split,
        title,
        input,
        ...(partition === 'mechanism' ? { mechanism: MECHANISM } : {}),
        fixtures: [
          {
            gatekeeperId: gate,
            operation: 'hosts.get',
            answer: { kind: 'data', data: { host: 'web-1', state: 'hung' } },
          },
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

    async function suiteWith(
      name: string,
      cases: ReadonlyArray<ReturnType<typeof restartCase>>,
    ): Promise<EvalSuiteWire> {
      const created = await call<EvalSuiteWire>(person('builder'), 'create_eval_suite', {
        name,
        workerDefinitionId,
        workerDefinitionVersion: 1,
      });
      let current = await call<EvalSuiteWire>(person('builder'), 'add_eval_fixture_gate', {
        suiteId: created.id,
        suiteVersion: created.version,
        gatekeeperId: gate,
      });
      for (const content of cases) {
        current = await call<EvalSuiteWire>(person('builder'), 'add_eval_case', {
          suiteId: current.id,
          suiteVersion: current.version,
          ...content,
        });
      }
      return current;
    }

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

    function spawnOf(taskId: string | null): TaskSpawnInput {
      const spawn = supervisor.spawnCalls.find((sent) => sent.taskId === taskId);
      if (!spawn) throw new Error(`no Worker was started for Task ${taskId}`);
      return spawn;
    }

    /** What the trial's model calls cost, as the LLM proxy records it. */
    async function recordUsage(claims: HandleClaims, costUsd: number): Promise<void> {
      await asOwnerRole((client) =>
        client.query(
          `insert into llm_usage (workspace_id, session_id, jti, provider, model, input_tokens, output_tokens, cost_usd, started_at, status)
           values ($1, $2, $3, 'p', 'm', 100, 20, $4, now(), 'completed')`,
          [workspaceId, claims.sid, claims.jti, costUsd],
        ),
      );
    }

    async function act(trial: EvalTrialWire, how: Act): Promise<void> {
      const claims = workerClaims(spawnOf(trial.taskId));
      const worker: ResolvedCaller = { channel: 'handle', claims };
      if (how !== 'fail') {
        await call(worker, 'request_action', {
          gatekeeperId: gate,
          operation: 'hosts.restart',
          params: { host: 'web-1' },
        });
      }
      await recordUsage(claims, TRIAL_COST);
      await call(worker, 'report_task_result', {
        summary:
          how === 'fail'
            ? 'Nothing needed doing.'
            : how === 'canary'
              ? `Restarted web-1 once. ${suite.canary}`
              : 'Restarted web-1 once.',
      });
    }

    async function readEvaluation(
      evaluationId: string,
      who: keyof typeof people = 'builder',
    ): Promise<DraftEvaluationWire> {
      return call<DraftEvaluationWire>(person(who), 'get_draft_evaluation', { evaluationId });
    }

    async function start(
      target: { suite?: EvalSuiteWire; mechanism?: string } = {},
    ): Promise<DraftEvaluationWire> {
      const on = target.suite ?? suite;
      return call<DraftEvaluationWire>(person('builder'), 'start_draft_evaluation', {
        skillId: helperId,
        version: 2,
        draftDigest,
        suiteId: on.id,
        suiteVersion: on.version,
        ...(target.mechanism ? { mechanism: target.mechanism } : {}),
      });
    }

    /** Plays each trial's Worker as `behave` says and ticks the runner, until the evaluation ends
     *  (or `until` holds). */
    async function drive(
      evaluationId: string,
      behave: Behave,
      until?: (evaluation: DraftEvaluationWire) => boolean,
    ): Promise<DraftEvaluationWire> {
      for (let tick = 0; tick < 60; tick += 1) {
        const evaluation = await readEvaluation(evaluationId);
        if (evaluation.status !== 'running' || until?.(evaluation)) return evaluation;
        const stage = evaluation.stages.find((s) => s.status === 'running');
        if (!stage?.runId) {
          throw new Error(`no stage runs: ${evaluation.stages.map((s) => s.status).join(', ')}`);
        }
        const run = await call<EvalRunWire>(person('builder'), 'get_eval_run', {
          runId: stage.runId,
        });
        for (const trial of run.trials) {
          if (trial.status !== 'running' || acted.has(trial.id)) continue;
          acted.add(trial.id);
          await act(trial, behave({ stage: stage.stage, arm: trial.arm, caseId: trial.caseId }));
        }
        await runEvalTrialTick(pool);
      }
      throw new Error(`evaluation ${evaluationId} did not end`);
    }

    function stageOf(evaluation: DraftEvaluationWire, stage: DraftEvaluationStageName) {
      const found = evaluation.stages.find((s) => s.stage === stage);
      if (!found) throw new Error(`no ${stage} stage`);
      return found;
    }

    async function budget(): Promise<EvalBudgetWire> {
      return call<EvalBudgetWire>(person('member'), 'get_eval_budget', {});
    }
    async function setBudget(value: number): Promise<void> {
      await call(person('owner'), 'set_quota', {
        key: 'evaluation.monthly_cost_budget_usd',
        value,
      });
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
            'e3-2b-draft-evaluations',
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
      configureTaskRuntime(deps());

      const notes = await skill(
        'owner',
        {
          name: 'notes',
          description: 'Keeps notes of what was done.',
          markdown: '# Notes\n\nWrite down each step.',
        },
        { publish: true },
      );
      notesId = notes.id;
      const helper = await skill(
        'owner',
        {
          name: 'restart-helper',
          description: 'Restarts a host that stopped answering.',
          markdown: '# Restart a host\n\nRead the host first.\nRestart it once.',
        },
        { publish: true },
      );
      helperId = helper.id;
      const proposed = await skill('builder', draft, { skillId: helperId });
      expect(proposed.version).toBe(2);
      draftDigest = proposed.digest;

      const definition = await asApp((client) =>
        proposeWorkerDefinition(client, workspaceId, people.owner, {
          kind: 'worker',
          definition: { systemPrompt: 'You restart hosts.', skills: ['restart-helper', 'notes'] },
        }),
      );
      await asApp((client) =>
        publishWorkerDefinition(client, workspaceId, people.owner, {
          definitionId: definition.id,
          version: definition.version,
        }),
      );
      workerDefinitionId = definition.id;
      gate = await registerGate('hosts', [
        operation('hosts.get'),
        operation('hosts.restart', {
          mode: 'execute',
          blast_radius: 'medium',
          auto_approvable: false,
          binding: { kind: 'http', method: 'POST', path: '/hosts/{host}/restart' },
        }),
      ]);
      suite = await suiteWith('Restarts', [
        restartCase(REGRESSION_INPUT, 'Restart web-1', 'regression'),
        restartCase(MECHANISM_INPUT, 'Ask before restarting', 'mechanism'),
        restartCase(CONFIRM_DEV_INPUT, 'Bring web-1 back', 'full'),
        restartCase(CONFIRM_HOLDOUT_INPUT, 'Restart the stopped batch host', 'full', 'holdout'),
      ]);
      const idOf = (title: string) => suite.cases.find((c) => c.title === title)?.id as string;
      caseIds = {
        regression: idOf('Restart web-1'),
        mechanism: idOf('Ask before restarting'),
        dev: idOf('Bring web-1 back'),
        holdout: idOf('Restart the stopped batch host'),
      };
      regressionOnly = await suiteWith('Restarts, regression only', [
        restartCase(REGRESSION_INPUT, 'Restart web-1', 'regression'),
      ]);
    });

    afterAll(async () => {
      resetTaskRuntimeForTests();
      await pool.end();
    });

    it('a builder evaluates the draft through every stage: both arms, the same pinned Skills, the funnel moved on by the runner, a verdict from the confirm stage', async () => {
      const started = await start({ mechanism: MECHANISM });
      expect(started).toMatchObject({
        status: 'running',
        stage: 'regression',
        verdict: null,
        reason: null,
        decidedBy: null,
        suite: { id: suite.id, name: 'Restarts', version: suite.version },
        workerDefinition: { id: workerDefinitionId, version: 1 },
        candidate: { skillId: helperId, version: 2, name: 'restart-helper', draftDigest },
        baseline: { skillId: helperId, version: 1, name: 'restart-helper' },
        mechanism: MECHANISM,
        otherSkills: [{ skillId: notesId, version: 1, name: 'notes' }],
        candidateContent: draft,
        baselineContent: { name: 'restart-helper' },
        createdBy: people.builder,
        cancelledBy: null,
      });
      expect(started.stages.map((s) => [s.stage, s.status, s.caseCount, s.k])).toEqual([
        ['regression', 'running', 1, 2],
        ['mechanism', 'waiting', 1, 10],
        ['confirm', 'waiting', 2, 3],
      ]);
      const regression = stageOf(started, 'regression');
      // Its four trials were started as the start committed.
      expect(regression.baseline).toMatchObject({ trials: 2, open: 2 });
      expect(regression.candidate).toMatchObject({ trials: 2, open: 2 });

      // Each arm mounts the pinned other Skill and its own restart-helper; only published rows
      // are what a run loaded.
      const run = await call<EvalRunWire>(person('builder'), 'get_eval_run', {
        runId: regression.runId,
      });
      expect(run).toMatchObject({
        kind: 'draft',
        draftEvaluationId: started.id,
        stage: 'regression',
        k: 2,
      });
      expect(run.trials.map((t) => [t.arm, t.status])).toEqual([
        ['baseline', 'running'],
        ['candidate', 'running'],
        ['baseline', 'running'],
        ['candidate', 'running'],
      ]);
      for (const trial of run.trials) {
        const spawn = spawnOf(trial.taskId);
        expect(spawn.skillsInline?.map((s) => s.name)).toEqual(['notes', 'restart-helper']);
        const helperFile = spawn.skillsInline?.[1]?.files['SKILL.md'] as string;
        expect(helperFile.includes('Ask before you restart anything.')).toBe(
          trial.arm === 'candidate',
        );
        const loaded = await asOwnerRole((client) =>
          client.query<{ skill_id: string; skill_version: number }>(
            `select skill_id, skill_version from worker_run_skills
              where workspace_id = $1 and worker_run_id = $2 order by skill_id`,
            [workspaceId, spawn.workerRunId],
          ),
        );
        const expected =
          trial.arm === 'baseline'
            ? [
                { skill_id: notesId, skill_version: 1 },
                { skill_id: helperId, skill_version: 1 },
              ]
            : [{ skill_id: notesId, skill_version: 1 }];
        expect(loaded.rows).toEqual(
          expect.arrayContaining(expected.map((row) => expect.objectContaining(row))),
        );
        expect(loaded.rows).toHaveLength(expected.length);
      }

      // While it runs the draft is kept: not discarded, rejected, deleted or expired, and not
      // evaluated twice.
      const discarded = await rejection(
        call(person('builder'), 'discard_draft', { kind: 'skill', id: helperId, version: 2 }),
      );
      expect(discarded).toBeInstanceOf(DraftEvaluatingError);
      expect(discarded).toMatchObject({ code: 'draft_evaluating' });
      expect(
        await rejection(
          call(person('owner'), 'reject_draft', {
            kind: 'skill',
            id: helperId,
            version: 2,
            draftDigest,
            reason: 'not now',
          }),
        ),
      ).toBeInstanceOf(DraftEvaluatingError);
      await expect(
        asApp((client) =>
          client.query('delete from skills where workspace_id = $1 and id = $2 and version = 2', [
            workspaceId,
            helperId,
          ]),
        ),
      ).rejects.toMatchObject({ code: '55006' });
      const inAMonth = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);
      await expireDraftsOnce(pool, { thresholdDays: 30, now: () => inAMonth });
      expect(
        await count('select 1 from skills where workspace_id = $1 and id = $2 and version = 2', [
          workspaceId,
          helperId,
        ]),
      ).toBe(1);
      expect(await rejection(start({ mechanism: MECHANISM }))).toBeInstanceOf(DraftEvaluatingError);

      // A member sees neither the evaluation of a draft that is not theirs nor its runs.
      expect(await rejection(readEvaluation(started.id, 'member'))).toBeInstanceOf(
        DraftEvaluationNotFoundError,
      );
      expect(
        await rejection(
          call(person('member'), 'get_eval_run', { runId: regression.runId as string }),
        ),
      ).toBeInstanceOf(EvalRunNotFoundError);
      expect(
        (
          await call<{ items: DraftEvaluationSummaryWire[] }>(
            person('member'),
            'list_draft_evaluations',
            {},
          )
        ).items,
      ).toEqual([]);
      const memberRuns = await call<{ items: EvalRunSummaryWire[] }>(
        person('member'),
        'list_eval_runs',
        { suiteId: suite.id, kind: 'draft' },
      );
      expect(memberRuns.items).toEqual([]);

      const ended = await drive(started.id, candidateWins);
      expect(ended).toMatchObject({
        status: 'finished',
        stage: null,
        verdict: 'better',
        reason: 'above_baseline',
        decidedBy: 'confirm',
      });
      expect(ended.finishedAt).not.toBeNull();
      expect(ended.costUsd).toBeCloseTo(36 * TRIAL_COST, 6);
      expect(ended.stages.map((s) => s.status)).toEqual(['ended', 'ended', 'ended']);
      expect(stageOf(ended, 'regression')).toMatchObject({
        baseline: { trials: 2, passed: 2, failed: 0, errored: 0, open: 0 },
        candidate: { trials: 2, passed: 2 },
        measure: { stage: 'regression', lostCaseIds: [], unsettledCaseIds: [] },
      });
      expect(stageOf(ended, 'mechanism')).toMatchObject({
        baseline: { trials: 10, passed: 0, failed: 10 },
        candidate: { trials: 10, passed: 10 },
        measure: {
          stage: 'mechanism',
          candidatePassed: 10,
          baselinePassed: 0,
          baselineMaxPassed: 4,
        },
      });
      const confirm = stageOf(ended, 'confirm');
      expect(confirm.measure).toMatchObject({
        stage: 'confirm',
        delta: 0.1,
        dev: { candidatePassed: 3, candidateTrials: 3, baselinePassed: 0, baselineTrials: 3 },
        holdout: { candidatePassed: 3, baselinePassed: 0, difference: 1 },
      });
      expect(confirm.cases.map((c) => [c.caseId, c.split])).toEqual([
        [caseIds.dev, 'dev'],
        [caseIds.holdout, 'holdout'],
      ]);
      expect(confirm.cases[0]?.candidate.costUsd).toBeCloseTo(3 * TRIAL_COST, 6);
      // One environment, every trial of both arms in it.
      expect(ended.environments).toHaveLength(1);
      expect(ended.environments[0]).toMatchObject({
        baselineTrials: 18,
        candidateTrials: 18,
        environment: { runtime: { imageId: IMAGE_A } },
      });

      expect(
        await count('select 1 from audit_records where workspace_id = $1 and action = $2', [
          workspaceId,
          DRAFT_EVALUATION_VERDICT_ACTION,
        ]),
      ).toBe(1);
      expect(
        await count('select 1 from audit_records where workspace_id = $1 and action = $2', [
          workspaceId,
          DRAFT_EVALUATION_STAGE_ACTION,
        ]),
      ).toBeGreaterThanOrEqual(2);
      expect(
        await count(
          "select 1 from audit_records where workspace_id = $1 and action = 'start_draft_evaluation'",
        ),
      ).toBe(1);

      const listed = await call<{ items: DraftEvaluationSummaryWire[] }>(
        person('builder'),
        'list_draft_evaluations',
        { skillId: helperId },
      );
      expect(listed.items[0]).toMatchObject({ id: started.id, verdict: 'better' });
      const draftRuns = await call<{ items: EvalRunSummaryWire[] }>(
        person('builder'),
        'list_eval_runs',
        { suiteId: suite.id, kind: 'draft' },
      );
      expect(draftRuns.items.map((r) => r.stage).sort()).toEqual([
        'confirm',
        'mechanism',
        'regression',
      ]);
      expect(
        (
          await call<{ items: EvalRunSummaryWire[] }>(person('builder'), 'list_eval_runs', {
            suiteId: suite.id,
            kind: 'case_trial',
          })
        ).items,
      ).toEqual([]);
    });

    it('a regression case the candidate loses ends it at the regression stage; later stages do not run', async () => {
      const started = await start({ mechanism: MECHANISM });
      const ended = await drive(started.id, ({ arm }) => (arm === 'baseline' ? 'pass' : 'fail'));
      expect(ended).toMatchObject({
        status: 'finished',
        verdict: 'regressed',
        reason: 'regression_case_lost',
        decidedBy: 'regression',
      });
      expect(ended.stages.map((s) => s.status)).toEqual(['ended', 'not_run', 'not_run']);
      expect(stageOf(ended, 'regression').measure).toEqual({
        stage: 'regression',
        lostCaseIds: [caseIds.regression],
        unsettledCaseIds: [],
      });
      expect(stageOf(ended, 'mechanism').runId).toBeNull();
    });

    it('a mechanism the baseline shows too refutes the draft', async () => {
      const started = await start({ mechanism: MECHANISM });
      const ended = await drive(started.id, allPass);
      expect(ended).toMatchObject({
        verdict: 'refuted',
        reason: 'mechanism_not_shown',
        decidedBy: 'mechanism',
      });
      expect(ended.stages.map((s) => s.status)).toEqual(['ended', 'ended', 'not_run']);
    });

    it('trials that ran in two environments are unmeasured; a reported canary is contaminated', async () => {
      supervisor.imageIds = [IMAGE_A, IMAGE_B];
      try {
        const started = await start();
        const ended = await drive(started.id, allPass);
        expect(ended).toMatchObject({
          verdict: 'unmeasured',
          reason: 'environment_differs',
          decidedBy: 'regression',
        });
        expect(ended.environments.map((e) => e.environment.runtime?.imageId).sort()).toEqual([
          IMAGE_A,
          IMAGE_B,
        ]);
      } finally {
        supervisor.imageIds = [IMAGE_A];
      }

      const started = await start();
      const ended = await drive(started.id, ({ arm }) => (arm === 'candidate' ? 'canary' : 'pass'));
      expect(ended).toMatchObject({
        verdict: 'contaminated',
        reason: 'canary_reported',
        decidedBy: 'regression',
      });
    });

    it('with no mechanism named and no full case, the stages skip and it ends inconclusive', async () => {
      const started = await start({ suite: regressionOnly });
      // What it will skip whatever happens reads so from the start.
      expect(started.stages.map((s) => [s.status, s.skipReason])).toEqual([
        ['running', null],
        ['skipped', 'no_mechanism'],
        ['skipped', 'no_cases'],
      ]);
      const ended = await drive(started.id, allPass);
      expect(ended).toMatchObject({
        verdict: 'inconclusive',
        reason: 'no_confirm_cases',
        decidedBy: 'confirm',
      });
      expect(ended.stages.map((s) => [s.status, s.skipReason])).toEqual([
        ['ended', null],
        ['skipped', 'no_mechanism'],
        ['skipped', 'no_cases'],
      ]);
    });

    it('a stage the month’s budget cannot cover is not run; a first stage that does not fit refuses the start', async () => {
      const before = await budget();
      expect(before.trialCostUsd).toBeCloseTo(TRIAL_COST, 6);
      const evaluations = await count(
        'select 1 from eval_draft_evaluations where workspace_id = $1',
      );
      try {
        // The regression stage's four trials do not fit.
        await setBudget(before.spentUsd + 0.02);
        const short = await rejection(start({ mechanism: MECHANISM }));
        expect(short).toBeInstanceOf(EvaluationBudgetInsufficientError);
        const details = (short as EvaluationBudgetInsufficientError).details;
        expect(details.estimateUsd).toBeCloseTo(4 * TRIAL_COST, 6);
        expect(details.spentUsd).toBeCloseTo(before.spentUsd, 6);
        expect(await count('select 1 from eval_draft_evaluations where workspace_id = $1')).toBe(
          evaluations,
        );

        // They fit; the mechanism stage's twenty do not, and nothing after it runs.
        await setBudget(before.spentUsd + 0.05);
        const started = await start({ mechanism: MECHANISM });
        const ended = await drive(started.id, allPass);
        expect(ended).toMatchObject({
          verdict: 'inconclusive',
          reason: 'budget',
          decidedBy: 'mechanism',
        });
        expect(ended.stages.map((s) => [s.status, s.skipReason])).toEqual([
          ['ended', null],
          ['skipped', 'budget'],
          ['not_run', null],
        ]);
        expect(stageOf(ended, 'mechanism').estimateUsd).toBeCloseTo(20 * TRIAL_COST, 6);

        // Spent: refused before anything is weighed.
        await setBudget((await budget()).spentUsd);
        expect(await rejection(start())).toBeInstanceOf(EvaluationBudgetExhaustedError);
      } finally {
        await setBudget(10);
      }
    });

    it('trials not ended yet count against the budget: two evaluations cannot both count on the same money (#833 review)', async () => {
      const before = await budget();
      expect(before.trialCostUsd).toBeCloseTo(TRIAL_COST, 6);
      try {
        // Room for one regression stage (four trials), not for two.
        await setBudget(before.spentUsd + before.committedUsd + 6 * TRIAL_COST);
        const first = await start({ suite: regressionOnly });
        const committed = await budget();
        expect(committed.committedUsd - before.committedUsd).toBeCloseTo(4 * TRIAL_COST, 6);

        const other = await skill('builder', {
          name: 'other-helper',
          description: 'Restarts a hung host and says so.',
          markdown: '# Other\n\nRestart the hung host once, then report what was done.',
        });
        const second = await rejection(
          call(person('builder'), 'start_draft_evaluation', {
            skillId: other.id,
            version: other.version,
            draftDigest: other.digest,
            suiteId: regressionOnly.id,
            suiteVersion: regressionOnly.version,
          }),
        );
        expect(second).toBeInstanceOf(EvaluationBudgetInsufficientError);
        const details = (second as EvaluationBudgetInsufficientError).details;
        expect(details.committedUsd).toBeCloseTo(committed.committedUsd, 6);
        expect(details.estimateUsd).toBeCloseTo(4 * TRIAL_COST, 6);

        // Once the first has ended, what it ran is spent and no longer committed.
        await drive(first.id, allPass);
        const after = await budget();
        expect(after.committedUsd).toBeCloseTo(before.committedUsd, 6);
        expect(after.spentUsd - before.spentUsd).toBeCloseTo(4 * TRIAL_COST, 6);
      } finally {
        await setBudget(10);
      }
    });

    it('refuses what it cannot evaluate, with nothing written', async () => {
      const evaluations = await count(
        'select 1 from eval_draft_evaluations where workspace_id = $1',
      );
      const base = {
        skillId: helperId,
        version: 2,
        draftDigest,
        suiteId: suite.id,
        suiteVersion: suite.version,
      };
      const startWith = (params: Record<string, unknown>, who: keyof typeof people = 'builder') =>
        rejection(call(person(who), 'start_draft_evaluation', { ...base, ...params }));

      expect(await startWith({}, 'member')).toBeInstanceOf(ForbiddenError);
      expect(await startWith({ version: 1 })).toBeInstanceOf(EvalSkillNotADraftError);
      expect(await startWith({ draftDigest: 'v1:not-it' })).toMatchObject({
        code: 'draft_changed',
      });
      expect(await startWith({ suiteVersion: suite.version + 1 })).toMatchObject({
        code: 'version_changed',
      });
      expect(await startWith({ mechanism: 'never-named' })).toBeInstanceOf(EvalSuiteStateError);

      // The check, before anything runs: what it found is counted, never shown.
      const leaky = await skill('builder', {
        name: 'leaky-helper',
        description: 'Restarts hosts with a stored key.',
        markdown: `# Restart\n\nexport API_TOKEN="${FAKE_SECRET}"\nUse host 0b6a1f9e-3c4d-4e5f-8a9b-0c1d2e3f4a5b.\nMention ${suite.canary}.`,
      });
      const failed = await startWith({
        skillId: leaky.id,
        version: leaky.version,
        draftDigest: leaky.digest,
      });
      expect(failed).toBeInstanceOf(DraftCheckFailedError);
      expect((failed as DraftCheckFailedError).details.problems).toEqual([
        { check: 'credential_like', count: 1, limit: null },
        { check: 'internal_id', count: 1, limit: null },
        { check: 'contaminated', count: null, limit: null },
      ]);
      expect((failed as Error).message).not.toContain(FAKE_SECRET);

      const same = await skill(
        'owner',
        { name: 'same-helper', description: 'Says the same.', markdown: '# Same\n\nNothing new.' },
        { publish: true },
      );
      const unchanged = await skill(
        'builder',
        { name: 'same-helper', description: 'Says the same.', markdown: '# Same\n\nNothing new.' },
        { skillId: same.id },
      );
      expect(
        (
          (await startWith({
            skillId: same.id,
            version: unchanged.version,
            draftDigest: unchanged.digest,
          })) as DraftCheckFailedError
        ).details.problems,
      ).toEqual([{ check: 'unchanged', count: null, limit: null }]);

      expect(await count('select 1 from eval_draft_evaluations where workspace_id = $1')).toBe(
        evaluations,
      );
    });

    // S10 E3-2c (legacy 514): the evaluation seal's pause of the evaluation Principal.
    it('while the evaluation Principal is paused its queued trials wait and no evaluation starts; the owner’s release starts them', async () => {
      const started = await start();
      const confirming = await drive(started.id, allPass, (e) => e.stage === 'confirm');
      const runId = stageOf(confirming, 'confirm').runId as string;
      const trials = async () =>
        (await call<EvalRunWire>(person('builder'), 'get_eval_run', { runId })).trials;
      expect((await trials()).filter((t) => t.status === 'queued')).toHaveLength(7);

      const evaluationPrincipalId = await asApp((client) =>
        getOrCreateEvaluationPrincipal(client, workspaceId),
      );
      const pause = () =>
        asApp(async (client) => {
          const inserted = await client.query<{ id: string }>(
            `insert into eval_seal_holds (workspace_id, principal_id, hits, places)
             values ($1, $2, 5, '{"capabilityResult": 5, "capabilityError": 0, "workerStart": 0}')
             returning id`,
            [workspaceId, evaluationPrincipalId],
          );
          return inserted.rows[0]?.id as string;
        });
      const release = (holdId: string) =>
        call(person('owner'), 'release_eval_seal_hold', {
          holdId,
          reason: 'The trial Worker echoed a fixture; not a probe.',
        });
      // The five running end, then the pause opens: the tick starts none of the seven waiting.
      for (const trial of await trials()) {
        if (trial.status !== 'running' || acted.has(trial.id)) continue;
        acted.add(trial.id);
        await act(trial, 'pass');
      }
      const hold = await pause();
      await runEvalTrialTick(pool);
      await runEvalTrialTick(pool);
      const waiting = await trials();
      expect(waiting.filter((t) => t.status === 'running')).toHaveLength(0);
      expect(waiting.filter((t) => t.status === 'queued')).toHaveLength(7);
      expect((await readEvaluation(started.id)).status).toBe('running');
      // No other evaluation starts either.
      expect(
        await rejection(
          call(person('builder'), 'start_eval_case_trial', {
            suiteId: suite.id,
            suiteVersion: suite.version,
            caseId: caseIds.dev,
          }),
        ),
      ).toBeInstanceOf(EvaluationProbeHoldError);

      await release(hold);
      // The release starts them at once, five at a time.
      const resumed = await trials();
      const running = resumed.filter((t) => t.status === 'running');
      expect(running).toHaveLength(5);
      expect(resumed.filter((t) => t.status === 'queued')).toHaveLength(2);
      // Paused again, a running trial's Worker gets nothing done.
      const again = await pause();
      const trial = running[0] as EvalTrialWire;
      expect(
        await rejection(
          call({ channel: 'handle', claims: workerClaims(spawnOf(trial.taskId)) }, 'get_task', {
            taskId: trial.taskId,
          }),
        ),
      ).toBeInstanceOf(EvaluationProbeHoldError);
      await release(again);
      await call(person('builder'), 'cancel_draft_evaluation', { evaluationId: started.id });
      await runEvalTrialTick(pool);
    });

    // #838 review (P2): a trial that ran while the evaluation Principal was paused has its calls
    // refused, so its failure or report says nothing about its arm — and a failed baseline would
    // favour the draft. It ends `paused`, with no outcome.
    it('a trial that ran while the evaluation Principal was paused has no outcome, never a failure; the tick stops its Worker; no evaluation starts meanwhile', async () => {
      const started = await start();
      const confirming = await drive(started.id, allPass, (e) => e.stage === 'confirm');
      const runId = stageOf(confirming, 'confirm').runId as string;
      const trials = async () =>
        (await call<EvalRunWire>(person('builder'), 'get_eval_run', { runId })).trials;
      const evaluationPrincipalId = await asApp((client) =>
        getOrCreateEvaluationPrincipal(client, workspaceId),
      );
      const pause = () =>
        asApp(async (client) => {
          const inserted = await client.query<{ id: string }>(
            `insert into eval_seal_holds (workspace_id, principal_id, hits, places)
             values ($1, $2, 5, '{"capabilityResult": 5, "capabilityError": 0, "workerStart": 0}')
             returning id`,
            [workspaceId, evaluationPrincipalId],
          );
          return inserted.rows[0]?.id as string;
        });
      const release = (holdId: string) =>
        call(person('owner'), 'release_eval_seal_hold', {
          holdId,
          reason: 'The trial Worker echoed a fixture; not a probe.',
        });
      const ended = async (ids: readonly string[]) =>
        (await trials()).filter((t) => ids.includes(t.id));

      // A short pause the tick never saw: the Workers' calls were refused meanwhile, and what they
      // report after the release — here, nothing done, which would fail the case — is not scored.
      const first = (await trials()).filter((t) => t.status === 'running');
      expect(first).toHaveLength(5);
      const brief = await pause();
      expect(
        await rejection(
          call(
            { channel: 'handle', claims: workerClaims(spawnOf(first[0]?.taskId ?? null)) },
            'report_task_result',
            { summary: 'Restarted web-1 once.' },
          ),
        ),
      ).toBeInstanceOf(EvaluationProbeHoldError);
      await release(brief);
      for (const trial of first) {
        acted.add(trial.id);
        await act(trial, 'fail');
      }
      await runEvalTrialTick(pool);
      expect(
        (await ended(first.map((t) => t.id))).map((t) => [t.status, t.verdict, t.error]),
      ).toEqual(first.map(() => ['errored', null, 'paused']));

      // Paused while trials run: the tick terminates their Workers, and they end `paused` too —
      // not `cancelled`, and not the `timeout` they would have come to on refused calls.
      const second = (await trials()).filter((t) => t.status === 'running');
      expect(second).toHaveLength(5);
      const hold = await pause();
      await runEvalTrialTick(pool);
      expect(supervisor.terminated).toEqual(
        expect.arrayContaining(second.map((t) => spawnOf(t.taskId).workerRunId)),
      );
      expect((await ended(second.map((t) => t.id))).map((t) => [t.status, t.error])).toEqual(
        second.map(() => ['errored', 'paused']),
      );
      expect((await trials()).filter((t) => t.status === 'queued')).toHaveLength(2);
      // None of the ten reads as failed in either arm.
      const confirm = stageOf(await readEvaluation(started.id), 'confirm');
      expect(confirm.baseline.failed + confirm.candidate.failed).toBe(0);
      expect(confirm.baseline.errored + confirm.candidate.errored).toBe(10);

      // No evaluation starts while paused (#838 review): with this one cancelled, a new start is
      // refused, and nothing is written.
      await call(person('builder'), 'cancel_draft_evaluation', { evaluationId: started.id });
      const evaluations = await count(
        'select 1 from eval_draft_evaluations where workspace_id = $1',
      );
      const refused = await rejection(start());
      expect(refused).toBeInstanceOf(EvaluationProbeHoldError);
      expect((refused as EvaluationProbeHoldError).subject).toBe('evaluation');
      expect(await count('select 1 from eval_draft_evaluations where workspace_id = $1')).toBe(
        evaluations,
      );
      await release(hold);
      await runEvalTrialTick(pool);
    });

    it('cancelling cancels the trials not started and terminates the running ones; it ends with no verdict and the draft can go', async () => {
      const started = await start();
      expect(stageOf(started, 'mechanism')).toMatchObject({
        status: 'skipped',
        skipReason: 'no_mechanism',
      });
      const confirming = await drive(started.id, allPass, (e) => e.stage === 'confirm');
      const confirm = stageOf(confirming, 'confirm');
      expect(confirm.status).toBe('running');
      // Twelve trials; the evaluation Principal runs five at a time.
      const open = await call<EvalRunWire>(person('builder'), 'get_eval_run', {
        runId: confirm.runId,
      });
      expect(open.trials.filter((t) => t.status === 'running')).toHaveLength(5);
      expect(open.trials.filter((t) => t.status === 'queued')).toHaveLength(7);
      const runningRuns = open.trials
        .filter((t) => t.status === 'running')
        .map((t) => spawnOf(t.taskId).workerRunId);

      expect(
        await rejection(
          call(person('member'), 'cancel_draft_evaluation', { evaluationId: started.id }),
        ),
      ).toBeInstanceOf(ForbiddenError);
      const cancelled = await call<DraftEvaluationWire>(
        person('builder'),
        'cancel_draft_evaluation',
        { evaluationId: started.id },
      );
      expect(cancelled).toMatchObject({
        status: 'cancelled',
        stage: null,
        verdict: null,
        reason: null,
        cancelledBy: people.builder,
      });
      expect(cancelled.stages.map((s) => s.status)).toEqual(['ended', 'skipped', 'cancelled']);
      expect(supervisor.terminated).toEqual(expect.arrayContaining(runningRuns));
      await runEvalTrialTick(pool);

      const after = await call<EvalRunWire>(person('builder'), 'get_eval_run', {
        runId: confirm.runId,
      });
      expect(after.status).toBe('finished');
      expect(after.trials.every((t) => t.status === 'errored' && t.error === 'cancelled')).toBe(
        true,
      );
      const neverStarted = after.trials.filter((t) => t.taskId === null);
      expect(neverStarted).toHaveLength(7);
      expect(neverStarted.every((t) => t.startedAt === null)).toBe(true);
      // The seven that never started are voided, not errored; the five it terminated ran.
      const stopped = stageOf(await readEvaluation(started.id), 'confirm');
      expect(stopped.baseline.voided + stopped.candidate.voided).toBe(7);
      expect(stopped.baseline.errored + stopped.candidate.errored).toBe(5);
      // Nothing started after the cancel.
      expect(
        await count("select 1 from eval_trials where workspace_id = $1 and status = 'queued'"),
      ).toBe(0);

      const again = await rejection(
        call(person('builder'), 'cancel_draft_evaluation', { evaluationId: started.id }),
      );
      expect(again).toBeInstanceOf(EvalSuiteStateError);

      await call(person('builder'), 'discard_draft', { kind: 'skill', id: helperId, version: 2 });
      // What it evaluated stays readable.
      expect((await readEvaluation(started.id)).candidateContent).toEqual(draft);
    });

    it('a member sees an evaluation once its very draft is published — not another draft under the same version', async () => {
      const earlier = await call<{ items: DraftEvaluationSummaryWire[] }>(
        person('builder'),
        'list_draft_evaluations',
        { skillId: helperId },
      );
      const oldEvaluationId = earlier.items[0]?.id as string;

      // Version 2 again, another text, published: the evaluations of the discarded draft stay
      // the builder's and the owner's.
      const other = await skill(
        'builder',
        { ...draft, markdown: `${draft.markdown}\nName the host twice.` },
        { skillId: helperId, publish: true },
      );
      expect(other.version).toBe(2);
      expect(await rejection(readEvaluation(oldEvaluationId, 'member'))).toBeInstanceOf(
        DraftEvaluationNotFoundError,
      );

      // Version 3, evaluated, then published as evaluated: everyone sees it.
      const next = await skill(
        'builder',
        { ...draft, markdown: `${draft.markdown}\nName the host twice.\nThen check it answers.` },
        { skillId: helperId },
      );
      const evaluation = await call<DraftEvaluationWire>(
        person('builder'),
        'start_draft_evaluation',
        {
          skillId: helperId,
          version: next.version,
          draftDigest: next.digest,
          suiteId: regressionOnly.id,
          suiteVersion: regressionOnly.version,
        },
      );
      expect(evaluation.baseline).toMatchObject({ version: 2 });
      await call(person('builder'), 'cancel_draft_evaluation', { evaluationId: evaluation.id });
      await runEvalTrialTick(pool);
      expect(await rejection(readEvaluation(evaluation.id, 'member'))).toBeInstanceOf(
        DraftEvaluationNotFoundError,
      );
      await call(person('owner'), 'publish_skill', {
        skillId: helperId,
        version: next.version,
        draftDigest: next.digest,
      });
      expect((await readEvaluation(evaluation.id, 'member')).id).toBe(evaluation.id);
      const memberList = await call<{ items: DraftEvaluationSummaryWire[] }>(
        person('member'),
        'list_draft_evaluations',
        {},
      );
      expect(memberList.items.map((e) => e.id)).toEqual([evaluation.id]);
      const regressionRun = stageOf(evaluation, 'regression').runId as string;
      expect(
        (await call<EvalRunWire>(person('member'), 'get_eval_run', { runId: regressionRun })).id,
      ).toBe(regressionRun);
      // A published version is not a draft to evaluate.
      expect(
        await rejection(
          call(person('builder'), 'start_draft_evaluation', {
            skillId: helperId,
            version: next.version,
            draftDigest: next.digest,
            suiteId: regressionOnly.id,
            suiteVersion: regressionOnly.version,
          }),
        ),
      ).toBeInstanceOf(EvalSkillNotADraftError);
    });

    it('the database keeps the ledger: an evaluation is never deleted, an ended one never changes, a draft run needs a running evaluation, a queued trial starts with its Task', async () => {
      const ended = await asOwnerRole((client) =>
        client.query<{ id: string }>(
          "select id from eval_draft_evaluations where workspace_id = $1 and status = 'finished' limit 1",
          [workspaceId],
        ),
      );
      const evaluationId = ended.rows[0]?.id as string;
      const write = (sql: string, params: unknown[]) =>
        asOwnerRole((client) => client.query(sql, params));

      await expect(
        write('delete from eval_draft_evaluations where workspace_id = $1 and id = $2', [
          workspaceId,
          evaluationId,
        ]),
      ).rejects.toThrow(/an evaluation is kept, never deleted/);
      await expect(
        write(
          "update eval_draft_evaluations set verdict = 'better', reason = 'above_baseline' where workspace_id = $1 and id = $2",
          [workspaceId, evaluationId],
        ),
      ).rejects.toThrow(/an ended evaluation never changes/);
      await expect(
        write(
          `insert into eval_runs (workspace_id, suite_id, suite_version, kind, worker_definition_id,
             worker_definition_version, arms, case_ids, k, created_by, draft_evaluation_id, stage)
           values ($1, $2, $3, 'draft', $4, 1, array['baseline', 'candidate'], array[$5]::uuid[], 1, $6, $7, 'confirm')`,
          [
            workspaceId,
            suite.id,
            suite.version,
            workerDefinitionId,
            caseIds.dev,
            people.builder,
            evaluationId,
          ],
        ),
      ).rejects.toThrow(/a draft run belongs to a running evaluation/);

      // A queued trial of a running evaluation: it starts only with a Task.
      const running = await call<DraftEvaluationWire>(
        person('builder'),
        'start_draft_evaluation',
        await (async () => {
          const fresh = await skill(
            'builder',
            {
              ...draft,
              markdown: `${draft.markdown}\nName the host twice.\nThen check it answers.\nLog it.`,
            },
            { skillId: helperId },
          );
          return {
            skillId: helperId,
            version: fresh.version,
            draftDigest: fresh.digest,
            suiteId: suite.id,
            suiteVersion: suite.version,
          };
        })(),
      );
      const confirming = await drive(running.id, allPass, (e) => e.stage === 'confirm');
      const queued = await asOwnerRole((client) =>
        client.query<{ id: string }>(
          `select id from eval_trials where workspace_id = $1 and run_id = $2 and status = 'queued' limit 1`,
          [workspaceId, stageOf(confirming, 'confirm').runId],
        ),
      );
      const queuedId = queued.rows[0]?.id as string;
      await expect(
        write(
          "update eval_trials set status = 'running', started_at = now() where workspace_id = $1 and id = $2",
          [workspaceId, queuedId],
        ),
      ).rejects.toThrow(/a queued trial starts once, with its Task and nothing recorded yet/);
      await expect(
        write(
          "update eval_trials set status = 'scored', verdict = 'passed', finished_at = now() where workspace_id = $1 and id = $2",
          [workspaceId, queuedId],
        ),
      ).rejects.toThrow(/a queued trial starts or is cancelled/);

      // The stage that decided read its own finished run (#833 review): here the mechanism stage
      // was skipped. Probed with every trial and run ended, in a savepoint undone after.
      await asOwnerRole(async (client) => {
        await client.query('savepoint probe');
        await client.query(
          `update eval_trials tr set status = 'errored', error = 'cancelled', finished_at = now()
             from eval_runs r
            where r.workspace_id = tr.workspace_id and r.id = tr.run_id
              and tr.workspace_id = $1 and r.draft_evaluation_id = $2
              and tr.status in ('queued', 'running')`,
          [workspaceId, running.id],
        );
        await client.query(
          `update eval_runs set status = 'finished', finished_at = now()
            where workspace_id = $1 and draft_evaluation_id = $2 and status = 'running'`,
          [workspaceId, running.id],
        );
        const finish = async (verdict: string, reason: string, decidedBy: string) => {
          await client.query('savepoint verdict');
          try {
            await client.query(
              `update eval_draft_evaluations
                  set status = 'finished', stage = null, verdict = $3, reason = $4,
                      decided_by = $5, finished_at = now()
                where workspace_id = $1 and id = $2`,
              [workspaceId, running.id, verdict, reason, decidedBy],
            );
            return 'accepted';
          } catch (err) {
            return (err as Error).message;
          } finally {
            await client.query('rollback to savepoint verdict');
          }
        };
        expect(await finish('refuted', 'mechanism_not_shown', 'mechanism')).toMatch(
          /given by the finished run of the stage that decided it \(mechanism has none\)/,
        );
        expect(await finish('inconclusive', 'budget', 'regression')).toMatch(
          /a budget verdict is given by a regression stage that did not run/,
        );
        expect(await finish('better', 'above_baseline', 'confirm')).toBe('accepted');
        await client.query('rollback to savepoint probe');
      });

      await call(person('builder'), 'cancel_draft_evaluation', { evaluationId: running.id });
      await runEvalTrialTick(pool);
    });

    it('publishing names the evidence and acknowledges each failure of a regressed or worse evaluation, with a reason; anything else refuses and publishes nothing (S10 E3-3)', async () => {
      const notesDraft = await skill(
        'builder',
        {
          name: 'notes',
          description: 'Keeps notes of what was done.',
          markdown: '# Notes\n\nWrite down each step.\nSay which host each step touched.',
        },
        { skillId: notesId },
      );
      expect(notesDraft.version).toBe(2);
      const target = { skillId: notesId, version: 2, draftDigest: notesDraft.digest };
      const evidence = (who: keyof typeof people = 'builder') =>
        call<SkillPublishEvidenceWire>(person(who), 'get_skill_publish_evidence', target);
      const startNotes = () =>
        call<DraftEvaluationWire>(person('builder'), 'start_draft_evaluation', {
          ...target,
          suiteId: suite.id,
          suiteVersion: suite.version,
        });
      const publish = (
        extra: Record<string, unknown> = {},
        who: ResolvedCaller = person('owner'),
      ) => call(who, 'publish_skill', { ...target, ...extra });
      const stillDraft = () =>
        count(
          "select 1 from skills where workspace_id = $1 and id = $2 and version = 2 and status = 'draft'",
          [workspaceId, notesId],
        );

      // No evaluation yet: nothing to name, nothing to acknowledge.
      expect(await evidence()).toEqual({
        evaluations: [],
        runningEvaluationId: null,
        acknowledge: [],
        familyHistory: [],
      });

      // The first evaluation loses the regression case.
      const regressed = await drive((await startNotes()).id, ({ arm }) =>
        arm === 'baseline' ? 'pass' : 'fail',
      );
      expect(regressed).toMatchObject({ verdict: 'regressed', decidedBy: 'regression' });

      // The second runs: the evidence says so, and the publish waits for it.
      const running = await startNotes();
      expect((await evidence()).runningEvaluationId).toBe(running.id);
      expect(
        await rejection(publish({ evaluationReview: { evaluationId: regressed.id } })),
      ).toBeInstanceOf(DraftEvaluatingError);
      // It holds the regression case and is worse on the confirmation's dev case.
      const worse = await drive(running.id, ({ stage, arm }) =>
        stage === 'regression' || arm === 'baseline' ? 'pass' : 'fail',
      );
      expect(worse).toMatchObject({
        verdict: 'worse',
        reason: 'below_margin',
        decidedBy: 'confirm',
      });

      const read = await evidence();
      expect(read.runningEvaluationId).toBeNull();
      expect(read.evaluations.map((e) => [e.id, e.verdict])).toEqual([
        [worse.id, 'worse'],
        [regressed.id, 'regressed'],
      ]);
      // The newest's deciding stage and both arms over every stage it ran.
      expect(read.evaluations[0]).toMatchObject({
        decidingStage: { stage: 'confirm', measure: { stage: 'confirm', dev: { difference: -1 } } },
        // Regression: one case twice; confirm: two cases three times — per arm.
        baselineTotal: { trials: 8, passed: 8 },
        candidateTotal: { trials: 8, passed: 2, failed: 6 },
      });
      expect(read.evaluations[0]?.candidateTotal.costUsd).toBeCloseTo(8 * TRIAL_COST, 6);
      expect(read.evaluations[1]?.decidingStage).toMatchObject({
        stage: 'regression',
        measure: { lostCaseIds: [caseIds.regression] },
      });
      // Both evaluations' failures, the newest's first: the dev case only — holdout did not
      // decide; the earlier evaluation's lost case still counts.
      expect(read.acknowledge).toEqual([
        {
          evaluationId: worse.id,
          caseId: caseIds.dev,
          title: 'Bring web-1 back',
          split: 'dev',
          stage: 'confirm',
          baseline: expect.objectContaining({ trials: 3, passed: 3 }),
          candidate: expect.objectContaining({ trials: 3, failed: 3 }),
        },
        {
          evaluationId: regressed.id,
          caseId: caseIds.regression,
          title: 'Restart web-1',
          split: 'dev',
          stage: 'regression',
          baseline: expect.objectContaining({ trials: 2, passed: 2 }),
          candidate: expect.objectContaining({ trials: 2, failed: 2 }),
        },
      ]);
      // A member does not see another's draft's evaluations.
      expect((await evidence('member')).evaluations).toEqual([]);

      // Evidence other than the latest, or none named, is stale.
      const stale = await rejection(publish({ evaluationReview: { evaluationId: regressed.id } }));
      expect(stale).toBeInstanceOf(EvaluationChangedError);
      expect((stale as EvaluationChangedError).details).toEqual({ evaluationId: worse.id });
      expect(await rejection(publish())).toBeInstanceOf(EvaluationChangedError);

      const reasons = [
        {
          evaluationId: worse.id,
          caseId: caseIds.dev,
          reason: 'The dev case asks for a host this Skill no longer restarts.',
        },
        {
          evaluationId: regressed.id,
          caseId: caseIds.regression,
          reason: 'Fixed in this version: the second evaluation keeps the case.',
        },
      ];
      // Each failure needs its acknowledgement.
      const none = await rejection(publish({ evaluationReview: { evaluationId: worse.id } }));
      expect(none).toBeInstanceOf(EvaluationReviewRequiredError);
      expect((none as EvaluationReviewRequiredError).details.items).toEqual([
        { evaluationId: worse.id, caseId: caseIds.dev },
        { evaluationId: regressed.id, caseId: caseIds.regression },
      ]);
      const one = await rejection(
        publish({ evaluationReview: { evaluationId: worse.id, acknowledgements: [reasons[0]] } }),
      );
      expect((one as EvaluationReviewRequiredError).details.items).toEqual([
        { evaluationId: regressed.id, caseId: caseIds.regression },
      ]);
      // An acknowledgement of no failure (the holdout case), one twice, or a blank reason.
      for (const acknowledgements of [
        [...reasons, { evaluationId: worse.id, caseId: caseIds.holdout, reason: 'n/a' }],
        [...reasons, reasons[0]],
      ]) {
        expect(
          await rejection(
            publish({ evaluationReview: { evaluationId: worse.id, acknowledgements } }),
          ),
        ).toBeInstanceOf(PublishAcknowledgementInputError);
      }
      expect(
        await rejection(
          publish({
            evaluationReview: {
              evaluationId: worse.id,
              acknowledgements: [reasons[0], { ...reasons[1], reason: '   ' }],
            },
          }),
        ),
      ).toBeInstanceOf(InvalidCapabilityParamsError);
      // Only a person acknowledges: a service Principal's API key is refused.
      const serviceId = randomUUID();
      await asOwnerRole((client) =>
        client.query(
          `insert into principals (workspace_id, id, kind, role, display_name)
           values ($1, $2, 'service', 'owner', 'e3-3-automation')`,
          [workspaceId, serviceId],
        ),
      );
      const owner = person('owner');
      if (owner.channel !== 'human') throw new Error('a person calls on the human channel');
      const service: ResolvedCaller = {
        ...owner,
        principal: {
          workspaceId,
          id: serviceId,
          kind: 'service',
          role: 'owner',
          displayName: 'e3-3-automation',
        },
      };
      expect(
        await rejection(
          publish(
            { evaluationReview: { evaluationId: worse.id, acknowledgements: reasons } },
            service,
          ),
        ),
      ).toBeInstanceOf(ForbiddenError);
      // Nothing of the above published.
      expect(await stillDraft()).toBe(1);

      // The evidence named and every failure acknowledged: published; the audit record keeps the
      // evidence and each acknowledgement with its reason.
      await publish({ evaluationReview: { evaluationId: worse.id, acknowledgements: reasons } });
      expect(await stillDraft()).toBe(0);
      const audit = await asOwnerRole((client) =>
        client.query<{ payload: Record<string, unknown> }>(
          `select payload from audit_records
            where workspace_id = $1 and action = 'publish_skill' and resource_id = $2
            order by created_at desc limit 1`,
          [workspaceId, notesId],
        ),
      );
      expect(audit.rows[0]?.payload).toMatchObject({
        // The count is the publish's, over both evaluations — not the named one's (#842 O1).
        acknowledgedFailures: 2,
        params: { evaluationReview: { evaluationId: worse.id, acknowledgements: reasons } },
      });
      expect(audit.rows[0]?.payload.evaluation).toEqual({
        id: worse.id,
        verdict: 'worse',
        reason: 'below_margin',
      });
      // Published as evaluated: everyone sees its evidence now.
      expect((await evidence('member')).evaluations.map((e) => e.id)).toEqual([
        worse.id,
        regressed.id,
      ]);

      // The family's next draft sees what was tried before and did not hold.
      const next = await skill(
        'builder',
        {
          name: 'notes',
          description: 'Keeps notes of what was done.',
          markdown:
            '# Notes\n\nWrite down each step.\nSay which host each step touched.\nKeep it short.',
        },
        { skillId: notesId },
      );
      const history = await call<SkillPublishEvidenceWire>(
        person('builder'),
        'get_skill_publish_evidence',
        { skillId: notesId, version: next.version, draftDigest: next.digest },
      );
      expect(history.evaluations).toEqual([]);
      // Published since, after its failures were acknowledged — not a change that was dropped.
      expect(
        history.familyHistory.map((e) => [e.id, e.verdict, e.candidate.version, e.candidateState]),
      ).toEqual([
        [worse.id, 'worse', 2, 'published'],
        [regressed.id, 'regressed', 2, 'published'],
      ]);

      // Running the same content again, more often than the evidence shows the newest of, does
      // not take a failure away: the regressed evaluation is still shown and still acknowledged.
      const nextTarget = { skillId: notesId, version: next.version, draftDigest: next.digest };
      const startNext = () =>
        call<DraftEvaluationWire>(person('builder'), 'start_draft_evaluation', {
          ...nextTarget,
          suiteId: regressionOnly.id,
          suiteVersion: regressionOnly.version,
        });
      const lost = await drive((await startNext()).id, ({ arm }) =>
        arm === 'baseline' ? 'pass' : 'fail',
      );
      expect(lost).toMatchObject({ verdict: 'regressed' });
      const reruns: string[] = [];
      for (let run = 0; run < 20; run += 1) {
        const held = await drive((await startNext()).id, () => 'pass');
        expect(held).toMatchObject({ verdict: 'inconclusive' });
        reruns.unshift(held.id);
      }
      const later = await call<SkillPublishEvidenceWire>(
        person('builder'),
        'get_skill_publish_evidence',
        nextTarget,
      );
      expect(later.evaluations.map((e) => e.id)).toEqual([...reruns, lost.id]);
      expect(later.acknowledge.map((item) => [item.evaluationId, item.caseId])).toEqual([
        [lost.id, regressionOnly.cases[0]?.id],
      ]);
      // The family's history still finds the earlier draft's evaluations past this draft's own.
      expect(later.familyHistory.map((e) => e.id)).toEqual([worse.id, regressed.id]);
      const unacknowledged = await rejection(
        call(person('owner'), 'publish_skill', {
          ...nextTarget,
          evaluationReview: { evaluationId: reruns[0] },
        }),
      );
      expect((unacknowledged as EvaluationReviewRequiredError).details.items).toEqual([
        { evaluationId: lost.id, caseId: regressionOnly.cases[0]?.id },
      ]);

      // What became of each version the family history shows: a draft still pending, one its
      // proposer discarded, one a reviewer rejected.
      const familyOf = async (draftOf: { version: number; digest: string }) =>
        (
          await call<SkillPublishEvidenceWire>(person('builder'), 'get_skill_publish_evidence', {
            skillId: notesId,
            version: draftOf.version,
            draftDigest: draftOf.digest,
          })
        ).familyHistory.map((e) => [e.id, e.candidateState]);
      await call(person('builder'), 'discard_draft', {
        kind: 'skill',
        id: notesId,
        version: next.version,
      });
      const another = await skill(
        'builder',
        {
          name: 'notes',
          description: 'Keeps notes of what was done.',
          markdown: '# Notes\n\nWrite down each step.\nName the host.',
        },
        { skillId: notesId },
      );
      const lostAgain = await drive(
        (
          await call<DraftEvaluationWire>(person('builder'), 'start_draft_evaluation', {
            skillId: notesId,
            version: another.version,
            draftDigest: another.digest,
            suiteId: regressionOnly.id,
            suiteVersion: regressionOnly.version,
          })
        ).id,
        ({ arm }) => (arm === 'baseline' ? 'pass' : 'fail'),
      );
      expect(lostAgain).toMatchObject({ verdict: 'regressed' });
      const third = await skill(
        'owner',
        {
          name: 'notes',
          description: 'Keeps notes of what was done.',
          markdown: '# Notes\n\nWrite down each step briefly.',
        },
        { skillId: notesId },
      ).catch((err: unknown) => err);
      // One pending draft per family: the next is proposed once this one is rejected.
      expect(third).toBeInstanceOf(Error);
      expect(await familyOf(another)).toEqual([
        [lost.id, 'discarded'],
        [worse.id, 'published'],
        [regressed.id, 'published'],
      ]);
      await call(person('owner'), 'reject_draft', {
        kind: 'skill',
        id: notesId,
        version: another.version,
        draftDigest: another.digest,
        reason: 'Restarting is out of scope for notes.',
      });
      const last = await skill(
        'owner',
        {
          name: 'notes',
          description: 'Keeps notes of what was done.',
          markdown: '# Notes\n\nWrite down each step briefly.',
        },
        { skillId: notesId },
      );
      expect(await familyOf(last)).toEqual([
        [lostAgain.id, 'rejected'],
        [lost.id, 'discarded'],
        [worse.id, 'published'],
        [regressed.id, 'published'],
      ]);

      // Review #493 on #842: the same text under another `applicable` is another draft — the
      // evaluation of the discarded one is not this one's, so it is not called a draft.
      const lostLast = await drive(
        (
          await call<DraftEvaluationWire>(person('builder'), 'start_draft_evaluation', {
            skillId: notesId,
            version: last.version,
            draftDigest: last.digest,
            suiteId: regressionOnly.id,
            suiteVersion: regressionOnly.version,
          })
        ).id,
        ({ arm }) => (arm === 'baseline' ? 'pass' : 'fail'),
      );
      expect(lostLast).toMatchObject({ verdict: 'regressed' });
      await call(person('owner'), 'discard_draft', {
        kind: 'skill',
        id: notesId,
        version: last.version,
      });
      const rescoped = await skill(
        'owner',
        {
          name: 'notes',
          description: 'Keeps notes of what was done.',
          markdown: '# Notes\n\nWrite down each step briefly.',
          applicable: { gateKinds: ['docker'] },
        },
        { skillId: notesId },
      );
      expect(rescoped.version).toBe(last.version);
      expect(rescoped.digest).not.toBe(last.digest);
      expect(await familyOf(rescoped)).toEqual([
        [lostLast.id, 'discarded'],
        [lostAgain.id, 'rejected'],
        [lost.id, 'discarded'],
        [worse.id, 'published'],
        [regressed.id, 'published'],
      ]);
    }, 180_000);

    // Last: it removes this test's workspace, the evaluations with it.
    it('the workspace purge removes draft evaluations with their runs and trials', async () => {
      const result = await purgeWorkspace(pool, { workspaceId, confirm: true, force: true });
      expect(result.executed).toBe(true);
      expect(result.counts.evalDraftEvaluations).toBeGreaterThan(0);
      for (const table of ['eval_draft_evaluations', 'eval_runs', 'eval_trials', 'skills']) {
        const left = await pool.query<{ count: string }>(
          `select count(*)::text as count from ${table} where workspace_id = $1`,
          [workspaceId],
        );
        expect(left.rows[0]?.count).toBe('0');
      }
    });
  },
);
