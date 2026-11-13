import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Capability,
  type Operation,
  type Role,
  type WorkerSpec,
  getCapability,
} from '@nexttime/shared';
import { generateKeyPair } from 'jose';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import {
  type GatekeeperClient,
  createGateConnectionSecrets,
} from '../../adapters/gatekeeper-client/index.js';
import { ApprovalDrainer, requestAction } from '../../governance/approval/index.js';
import { HANDLE_SIGNING_ALG, issueHandle } from '../../governance/capability/index.js';
import {
  getPublishedOperation,
  importManifest,
  operationRecordDigest,
  publishOperation,
  registerGatekeeper,
} from '../../governance/gatekeepers/index.js';
import { mapCapabilityError } from '../../interfaces/http/capability-route.js';
import {
  attachEvidence,
  recordSourceObservation,
  registerPrivateSource,
  startActivity,
} from '../../substrate/epistemic/index.js';
import { SqlGraphStore } from '../../substrate/graph/index.js';
import { seedPlatformMetaOntology } from '../../substrate/ontology/index.js';
import { issueAdminAgentHandle } from '../admin-agent/identity.js';
import { createGoalRun } from '../goal/index.js';
import { type UserRow, createPlatformAdmin, createUser } from '../identity/index.js';
import { insertPendingContextItem } from '../linkage/index.js';
import { configureTaskRuntime, resetTaskRuntimeForTests } from '../task/runtime.js';
import { workerSpecDigest } from '../task/step-attempt.js';
import { createWorkspaceWithOwner } from '../workspace/index.js';
import { createAdminWithTransaction, createGatekeeperActionExecutor } from './action-executor.js';
import { setConnectionHandlerDeps } from './connection-handlers.js';
import { dispatchCapability } from './dispatch.js';
import { setRequestActionDeps } from './request-action-handler.js';
import {
  type ResolveCallerDeps,
  type ResolvedCaller,
  resolveCaller,
  resolveSourceBoundCaller,
} from './resolve-caller.js';
import {
  type Seeded,
  humanCaller,
  newWorkspace,
  paramsFor,
  registerSeededGatekeeper,
  seedWorkspace,
  workspaceDigest,
} from './traversal-fixture.js';

/**
 * Batch D4 (docs/test-coverage-gaps-2026-11-06.md §5.7, gap G6): a capability with side effects,
 * called twice with the same params, does what docs/contracts/capability-matrix.yaml says it does
 * (`repeat`, guard rule M6). The table drives the test: every row that declares an answer is
 * exercised here, so a declaration nobody checks cannot exist — a row whose first call the
 * fixture cannot make succeed fails, and needs a recipe below (or stays `unclear`).
 *
 * What each answer means, as asserted (per #493 on batch D4):
 * - `idempotent`: the second call succeeds and returns the same entity (same `id`, when it has
 *   one); every row the workspace owns is unchanged — outbox included, since a second outbox event
 *   is an external action done twice — except `audit_records`, which gains exactly the second
 *   call's own dispatch row (each call is audited, "审计只增不减") and no domain row (an `x.y`
 *   action: a second one would record a transition that did not happen).
 * - `creates`: the second call succeeds and returns a different entity (a new `id`).
 * - `repeats`: the second call succeeds, on the same entity (same `id`), and changes its state.
 * - `conflict: <code>`: the second call is refused with that wire error code, as a typed 4xx
 *   (`mapCapabilityError`, what HTTP and WS send); nothing changes, and the audit gains nothing
 *   but refusal records (`outcome: 'refused'`).
 *
 * Each row runs in a fresh, seeded workspace (traversal-fixture.ts), as its owner by the human
 * channel. What a capability does inside its gatekeeper (an execution-level idempotency store) is
 * another layer, not this column.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const MATRIX = path.join(KERNEL_ROOT, '..', '..', 'docs', 'contracts', 'capability-matrix.yaml');

/** What a recipe gets: the seeded workspace, its owner's caller, its member, and the pool. */
interface RecipeContext {
  readonly pool: Pool;
  readonly caller: ResolvedCaller;
  readonly seed: Seeded;
  readonly memberId: string;
  /** A platform row's caller: an administrator of the case's own (null for a workspace row). */
  readonly admin: UserRow | null;
}

/** One extra case: sets the workspace up before the first call and returns the params; `first`
 *  is what the first call must answer, so the case provably took the path it is named for. */
interface Recipe {
  readonly setUp: (ctx: RecipeContext) => Promise<Record<string, unknown>>;
  readonly first?: unknown;
  /** This path's answer, when it is not the row's: a row declares what its default path does
   *  (the params a caller sends most), and a known, intended other path says its own here. */
  readonly repeat?: string;
  /** The entity a result names, when `entityId` cannot tell (a result keyed by more than one
   *  field, such as an Operation draft's gate, name and version) — or, for a call whose result
   *  names none (a gate read), the one its params address. */
  readonly entity?: (result: unknown, params: Record<string, unknown>) => string | undefined;
  /** Who makes the two calls, when not the owner on the human channel: the Handle of a `handle`
   *  row's caller (a Worker's run, an agent session), got after `setUp`. Each call presents it the
   *  way its holder does (`callerFor`), so a Handle revoked, expired or not signed by the task
   *  runtime's key is refused before the handler (per #493 on batch 12). */
  readonly by?: (ctx: RecipeContext) => Promise<HeldHandle>;
  /** For a `repeats` row: what the second call moves, read after each call (the two reads must
   *  differ), so a change elsewhere in the digest cannot stand in for it. */
  readonly moves?: (ctx: RecipeContext, params: Record<string, unknown>) => Promise<unknown>;
  /** What the second call must answer, when the row's answer says what it did (a count of what
   *  it revoked): an idempotent row's second call did nothing (per #493 on batch 24). */
  readonly second?: unknown;
  /** What must still hold after both calls, beyond the digest: state neither call may change
   *  (an entry Handle a no-op must not re-issue, per #493 on batch 24). */
  readonly holds?: (ctx: RecipeContext, params: Record<string, unknown>) => Promise<void>;
}

/** The Handle each spawned WorkerRun was given, by WorkerRun id (the supervisor stub's record). */
const SPAWNED_HANDLES = new Map<string, string>();
/** Verifies the Handles the task runtime signs (its key pair is made in `beforeAll`). */
let loadHandlePublicKey: ResolveCallerDeps['loadHandlePublicKey'];

/** A Handle as its holder presents it: a container-held one through the source binding
 *  (`resolveSourceBoundCaller`), one handed to its holder as a bearer token in the request. */
interface HeldHandle {
  readonly handle: string;
  readonly presented: 'source' | 'bearer';
}

/** A request's caller for a Handle, resolved as the kernel resolves that presentation. */
function callerFor(pool: Pool, { handle, presented }: HeldHandle): Promise<ResolvedCaller> {
  const deps = { pool, loadHandlePublicKey };
  return presented === 'source'
    ? resolveSourceBoundCaller(handle, deps)
    : resolveCaller(`Bearer ${handle}`, deps);
}

/** The Handle of the WorkerRun the recipe started last, as its Worker holds it. */
async function workerHandle({ pool, seed }: RecipeContext): Promise<HeldHandle> {
  const result = await pool.query<{ id: string }>(
    'select id from worker_runs where workspace_id = $1 order by started_at desc limit 1',
    [seed.workspaceId],
  );
  const run = result.rows[0];
  const handle = run === undefined ? undefined : SPAWNED_HANDLES.get(run.id);
  if (handle === undefined) throw new Error('workerHandle: the recipe started no WorkerRun');
  return { handle, presented: 'source' };
}

/** An agent session's Handle for the owner (issue_handle), as the entry agent holds it. */
async function sessionHandle(ctx: RecipeContext): Promise<HeldHandle> {
  const { handle } = await as<{ handle: string }>(ctx, 'issue_handle', {
    sessionKind: 'interactive',
  });
  return { handle, presented: 'bearer' };
}

/** The Principal a caller acts as — who an audit row names. */
const actingPrincipal = (caller: ResolvedCaller, ownerId: string) =>
  caller.channel === 'handle' ? caller.claims.obo : ownerId;

/** The caller `resolvePlatformCaller` builds for an administrator's console session: no
 *  workspace, no Principal. */
function platformCaller(user: UserRow): ResolvedCaller {
  return {
    channel: 'platform',
    user: {
      id: user.id,
      login: user.login,
      displayName: user.displayName,
      platformRole: 'admin',
      mustChangePassword: false,
      consoleSessionId: randomUUID(),
    },
  };
}

/** A digest of the whole database but its audit trail: every `public` table, all of its rows. A
 *  platform row may write anywhere (another workspace, a member's Principals), and test files run
 *  one at a time, so nothing else writes while a case runs. Each table's digest is its row count
 *  and the sum of its rows' hashes: one linear scan, no sort, whatever earlier files left behind
 *  (#488 on 664 batch 21). */
async function databaseDigest(pool: Pool): Promise<Record<string, string>> {
  const tables = await pool.query<{ table_name: string }>(
    `select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
        and table_name not in ('audit_records', 'schema_migrations')
      order by table_name`,
  );
  const digest: Record<string, string> = {};
  for (const { table_name } of tables.rows) {
    const result = await pool.query<{ digest: string }>(
      `select count(*)::text || ':' ||
              coalesce(sum(('x' || left(md5(t::text), 16))::bit(64)::bigint), 0)::text as digest
         from "${table_name}" t`,
    );
    digest[table_name] = result.rows[0]?.digest ?? '';
  }
  return digest;
}

/** A call as the recipe's owner, for setting a case up. */
function as<T = Record<string, unknown>>(
  ctx: RecipeContext,
  name: string,
  params: Record<string, unknown>,
): Promise<T> {
  return dispatchCapability({ pool: ctx.pool }, ctx.caller, name, params) as Promise<T>;
}

/** A Skill / Procedure body the walk cannot build (a name, a description, Markdown or steps). */
const skillBody = () => ({
  name: `repeat-skill-${randomUUID().slice(0, 8)}`,
  description: 'A Skill for the repeat walk.',
  markdown: '# Steps\n\nOne.',
});
const procedureBody = () => ({
  name: `repeat-procedure-${randomUUID().slice(0, 8)}`,
  description: 'A Procedure for the repeat walk.',
  steps: [{ kind: 'approval', description: 'A human approves the change.' }],
});

interface Proposed {
  readonly id: string;
  readonly draftDigest: string;
}

/** v1 of a Skill (or Procedure), proposed and — when `publish` — published. */
async function familyV1(
  ctx: RecipeContext,
  kind: 'skill' | 'procedure',
  body: Record<string, unknown>,
  publish: boolean,
): Promise<Proposed> {
  const v1 = await as<Proposed>(ctx, `propose_${kind}`, { [kind]: body });
  if (publish) {
    await as(ctx, `publish_${kind}`, {
      [`${kind}Id`]: v1.id,
      version: 1,
      draftDigest: v1.draftDigest,
    });
  }
  return v1;
}

/** v1 of a worker WorkerDefinition, proposed and — when `publish` — published. */
async function workerV1(ctx: RecipeContext, publish: boolean): Promise<{ id: string }> {
  const v1 = await as<{ id: string }>(ctx, 'propose_worker_definition', {
    kind: 'worker',
    definition: { systemPrompt: 'A worker for the repeat walk.' },
  });
  if (publish) await as(ctx, 'publish_worker_definition', { definitionId: v1.id, version: 1 });
  return v1;
}

/** An evaluation suite on a published worker v1; `withGate`: the seeded gate frozen into it (v2). */
async function evalSuite(
  ctx: RecipeContext,
  withGate: boolean,
): Promise<{ id: string; version: number; workerId: string }> {
  const worker = await workerV1(ctx, true);
  const suite = await as<{ id: string; version: number }>(ctx, 'create_eval_suite', {
    name: `repeat-suite-${randomUUID().slice(0, 8)}`,
    workerDefinitionId: worker.id,
    workerDefinitionVersion: 1,
  });
  if (!withGate) return { ...suite, workerId: worker.id };
  await registerSeededGatekeeper(ctx.pool, ctx.seed);
  const frozen = await as<{ id: string; version: number }>(ctx, 'add_eval_fixture_gate', {
    suiteId: suite.id,
    suiteVersion: suite.version,
    gatekeeperId: ctx.seed.gatekeeperId,
  });
  return { ...frozen, workerId: worker.id };
}

/** A case on the seeded gate's one Operation (named after the marker). */
const evalCase = (seed: Seeded) => ({
  title: 'Restart web-1 when it hangs',
  input: 'web-1 hangs',
  fixtures: [
    {
      gatekeeperId: seed.gatekeeperId,
      operation: seed.marker,
      answer: { kind: 'data', data: { restarted: true } },
    },
  ],
  assertions: [{ expect: { path: 'result.summary', op: 'contains', value: 'web-1' } }],
});

/** A suite with one case (v3), and that case's id. */
async function suiteWithCase(ctx: RecipeContext) {
  const suite = await evalSuite(ctx, true);
  const withCase = await as<{ id: string; version: number; cases: { id: string }[] }>(
    ctx,
    'add_eval_case',
    {
      suiteId: suite.id,
      suiteVersion: suite.version,
      partition: 'regression',
      split: 'dev',
      ...evalCase(ctx.seed),
    },
  );
  return { suiteId: withCase.id, suiteVersion: withCase.version, caseId: withCase.cases[0]?.id };
}

/** start_draft_evaluation's params: a pending Skill v2 (v1 published) on a suite with one case. */
async function draftEvaluationParams(ctx: RecipeContext) {
  const suite = await suiteWithCase(ctx);
  const draft = await pendingV2(ctx, 'skill');
  return {
    skillId: draft.id,
    version: draft.version,
    draftDigest: draft.draftDigest,
    suiteId: suite.suiteId,
    suiteVersion: suite.suiteVersion,
  };
}

/**
 * propose_definition_from_combination's case (S11 GO16b): a goal the owner asked for, ended a day
 * ago as achieved by their word, whose one step `definitionId` v1 ran with `spec` — written with
 * the guards off, since the goal's own write paths are not this capability's.
 */
async function achievedGoalStep(
  ctx: RecipeContext,
  definitionId: string,
  spec: WorkerSpec,
): Promise<void> {
  const { workspaceId, ownerId } = ctx.seed;
  const endedAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await withWorkspace(
    ctx.pool,
    { workspaceId, principalId: ownerId },
    async (client) => {
      await client.query('set local session_replication_role = replica');
      const goal = await client.query<{ id: string }>(
        `insert into goal_runs (workspace_id, status, outcome, outcome_basis, on_behalf_of,
           statement, current_revision, confirmed_at, budget_max_tokens, budget_max_steps,
           budget_max_revisions, budget_max_wall_clock_seconds, ended_at)
         values ($1, 'completed', 'achieved', 'requester', $2, 'a goal for the repeat walk', 1,
           $3, 100000, 10, 5, 3600, $3) returning id`,
        [workspaceId, ownerId, endedAt],
      );
      const goalRunId = goal.rows[0]?.id;
      const plan = { steps: [{ key: 's0', worker: { definitionId, version: 1 }, spec }] };
      await client.query(
        `insert into plan_revisions (workspace_id, goal_run_id, revision, status, plan,
           proposed_by, decided_by, decided_at)
         values ($1, $2, 1, 'accepted', $3, $4, $4, now())`,
        [workspaceId, goalRunId, JSON.stringify(plan), ownerId],
      );
      const step = await client.query<{ id: string }>(
        `insert into step_runs (workspace_id, goal_run_id, step_key, introduced_in_revision,
           status, attempt_count, ended_at, updated_at)
         values ($1, $2, 's0', 1, 'succeeded', 1, $3, $3) returning id`,
        [workspaceId, goalRunId, endedAt],
      );
      await client.query(
        `insert into tasks (workspace_id, id, status, on_behalf_of, worker_definition_id,
           worker_definition_version, completed_at, goal_run_id, step_run_id, plan_revision,
           step_attempt, run_config_snapshot, created_at)
         values ($1, $2, 'completed', $3, $4, 1, $5, $6, $7, 1, 1, $8, $9)`,
        [
          workspaceId,
          randomUUID(),
          ownerId,
          definitionId,
          endedAt,
          goalRunId,
          step.rows[0]?.id,
          JSON.stringify({ v: 2, spec: { digest: workerSpecDigest(spec) } }),
          new Date(endedAt.getTime() - 60_000),
        ],
      );
    },
    { skipRoleSwitch: true },
  );
}

/** reject_draft's case: v1 published, v2 proposed — the pending draft the reviewer takes off. */
async function pendingV2(ctx: RecipeContext, kind: 'skill' | 'procedure') {
  const body = kind === 'skill' ? skillBody() : procedureBody();
  const v1 = await familyV1(ctx, kind, body, true);
  const next = kind === 'skill' ? { ...body, markdown: '# Two' } : { ...body, description: 'v2' };
  const v2 = await as<Proposed>(ctx, `propose_${kind}`, { [kind]: next, [`${kind}Id`]: v1.id });
  return { kind, id: v1.id, version: 2, draftDigest: v2.draftDigest, reason: 'Not this one.' };
}

/** Workspaces a goal recipe moved a run in: `afterAll` ends their runs, so no advancer of a later
 *  file (one that starts a whole kernel) claims one (as goal-operations.integration.test.ts does). */
const GOAL_WORKSPACES = new Set<string>();
const GOAL_BUDGET = {
  maxTokens: 100_000,
  maxSteps: 10,
  maxRevisions: 2,
  maxWallClockSeconds: 3600,
};

/** A goal run of one step on a published Worker, proposed for `requester` (the owner, unless
 *  named); `confirm`: confirmed by them, then `pause`: paused — by them, or by `pausedBy`. No
 *  advance runs in this file, so the run stays where the recipe left it. */
async function goalRun(
  ctx: RecipeContext,
  {
    requester = ctx.seed.ownerId,
    confirm = false,
    pause = false,
    pausedBy,
  }: { requester?: string; confirm?: boolean; pause?: boolean; pausedBy?: ResolvedCaller } = {},
): Promise<string> {
  const { workspaceId } = ctx.seed;
  GOAL_WORKSPACES.add(workspaceId);
  const worker = await workerV1(ctx, true);
  const created = await withWorkspace(ctx.pool, { workspaceId, principalId: requester }, (client) =>
    createGoalRun(client, workspaceId, {
      requesterId: requester,
      proposedBy: requester,
      statement: 'Restart web-1 and say when it answers again.',
      plan: {
        steps: [
          { key: 'a', worker: { definitionId: worker.id, version: 1 }, input: { step: 'a' } },
        ],
      },
      budget: GOAL_BUDGET,
    }),
  );
  const goalRunId = created.goalRunId;
  const byRequester =
    requester === ctx.seed.ownerId ? ctx.caller : humanCaller(workspaceId, requester, 'member');
  const by = (caller: ResolvedCaller, name: string, params: Record<string, unknown>) =>
    dispatchCapability({ pool: ctx.pool }, caller, name, params);
  if (confirm) await by(byRequester, 'confirm_goal', { goalRunId, revision: 1 });
  if (pause) await by(pausedBy ?? byRequester, 'pause_goal', { goalRunId });
  return goalRunId;
}

const graphStore = new SqlGraphStore();

/** Two Objects and a Fact between them, asserted by the owner under an Activity of their own;
 *  `from` names a private Source the Activity observed, so a second Fact from another Source with
 *  other content opens a Conflict. */
async function ownerFact(
  ctx: RecipeContext,
  objects?: { readonly hostId: string; readonly serviceId: string },
  port = 80,
): Promise<{ factId: string; hostId: string; serviceId: string }> {
  const { workspaceId, ownerId } = ctx.seed;
  return withWorkspace(ctx.pool, { workspaceId, principalId: ownerId }, async (client) => {
    const hostId =
      objects?.hostId ??
      (
        await graphStore.upsertObject(client, workspaceId, {
          objectType: 'test.host',
          identity: { hostname: `repeat-${randomUUID()}` },
        })
      ).id;
    const serviceId =
      objects?.serviceId ??
      (
        await graphStore.upsertObject(client, workspaceId, {
          objectType: 'test.service',
          identity: { name: `repeat-svc-${randomUUID()}` },
        })
      ).id;
    const source = await registerPrivateSource(client, workspaceId, {
      kind: 'test.collector',
      ownerPrincipalId: ownerId,
    });
    const activity = await startActivity(client, workspaceId, { kind: 'test.ingest' });
    await recordSourceObservation(client, workspaceId, {
      sourceId: source.id,
      activityId: activity.id,
    });
    const fact = await graphStore.assertFact(
      client,
      workspaceId,
      { id: ownerId, kind: 'human' },
      {
        linkType: 'test.runs_on',
        sourceObjectId: serviceId,
        targetObjectId: hostId,
        activityId: activity.id,
        properties: { port },
      },
    );
    return { factId: fact.id, hostId, serviceId };
  });
}

/** An action of the run's step whose outcome is unknown — what reconcile_goal_action records a
 *  finding on. Written with the guards off: nothing this file reaches fails an action that way. */
async function outcomeUnknownAction(ctx: RecipeContext, goalRunId: string): Promise<string> {
  const { workspaceId, ownerId, gatekeeperId } = ctx.seed;
  return withWorkspace(
    ctx.pool,
    { workspaceId, principalId: ownerId },
    async (client) => {
      await client.query('set local session_replication_role = replica');
      const result = await client.query<{ id: string }>(
        `insert into action_requests (workspace_id, status, failure_kind, gatekeeper_id,
           action_kind, blast_radius, policy_decision, await_decision, on_behalf_of,
           actor_runtime, requested_at, step_run_id)
         select $1, 'failed', 'outcome_unknown', $2, 'fixture.act', 'low', 'allow', false, $3,
                'pi', now(), s.id
           from step_runs s where s.workspace_id = $1 and s.goal_run_id = $4
         returning id`,
        [workspaceId, gatekeeperId, ownerId, goalRunId],
      );
      const id = result.rows[0]?.id;
      if (id === undefined) throw new Error('the run has no step to fail an action of');
      return id;
    },
    { skipRoleSwitch: true },
  );
}

const GATE_OP: Operation = {
  name: 'repeat.restart',
  description: 'Restarts a host.',
  binding: { kind: 'http', method: 'POST', path: '/restart' },
  params_schema: {},
  mode: 'execute',
  blast_radius: 'medium',
  reversibility: false,
  auto_approvable: true,
  await_decision: false,
  reads: [],
  writes: [],
};

/** An observe-class Operation on the same gate: reading a host's status. */
const OBSERVE_OP: Operation = {
  ...GATE_OP,
  name: 'repeat.status',
  description: "Reads a host's status.",
  binding: { kind: 'http', method: 'GET', path: '/status' },
  mode: 'observe',
  blast_radius: 'low',
};

/** A registered gate whose interface manifest is `GATE_OP` — imported as a draft, and published
 *  unless `publish` is false. The seeded gate's Operation is not a valid definition, so a call
 *  that reads one (an approval rule, a catalog transition) needs this gate. */
async function gateWithOperation(
  { pool, seed }: RecipeContext,
  publish = true,
  operation: Operation = GATE_OP,
): Promise<string> {
  const { workspaceId, ownerId } = seed;
  return withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
    const activity = await startActivity(client, workspaceId, {
      kind: 'test.connection',
      principalId: ownerId,
    });
    const { gatekeeperId } = await registerGatekeeper(client, workspaceId, {
      name: 'repeat-gate',
      transportKind: 'http',
      target: 'repeat-gate',
      endpoint: 'http://repeat-gate.invalid:8080',
      activityId: activity.id,
      registeredBy: { id: ownerId, kind: 'human' },
    });
    await importManifest(client, workspaceId, {
      gatekeeperId,
      operations: [operation],
      proposedBy: { id: ownerId, kind: 'human' },
      activityId: activity.id,
    });
    if (publish)
      await publishOperation(client, workspaceId, { gatekeeperId, name: operation.name });
    return gatekeeperId;
  });
}

/** A pending ActionRequest for `GATE_OP`, made as `request_action` makes it: against the
 *  definition published now (legacy 218). */
async function pendingRequest({ pool, seed }: RecipeContext, gatekeeperId: string) {
  const { workspaceId, ownerId } = seed;
  return withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
    const published = await getPublishedOperation(client, workspaceId, gatekeeperId, GATE_OP.name);
    if (published === null || published === undefined) throw new Error('GATE_OP is not published');
    const request = await requestAction(client, workspaceId, {
      gatekeeperId,
      actionKind: GATE_OP.name,
      resourceScope: gatekeeperId,
      blastRadius: 'medium',
      operationAutoApprovable: true,
      awaitDecision: false,
      onBehalfOf: ownerId,
      actorRuntime: 'pi',
      requesterScope: {
        capabilities: ['request_action'],
        resources: { gatekeeper: [gatekeeperId] },
      },
      idempotencyKey: randomUUID(),
      operationDigest: operationRecordDigest(published),
    });
    return request.id;
  });
}

/** The catalog's one draft of `GATE_OP` (version and draftDigest as list_operations shows them). */
async function draftOf(ctx: RecipeContext, gatekeeperId: string) {
  const listed = await as<{
    items: { name: string; status: string; version: number; draftDigest?: string }[];
  }>(ctx, 'list_operations', { gatekeeperId });
  const draft = listed.items.find((item) => item.name === GATE_OP.name && item.status === 'draft');
  if (draft === undefined)
    throw new Error(`no draft of ${GATE_OP.name}: ${JSON.stringify(listed)}`);
  return draft;
}

/** Workspaces a recipe started a Task in: `afterAll` cancels what is still unfinished, so no
 *  sweeper or quota of a later file counts a Worker that will never report. */
const TASK_WORKSPACES = new Set<string>();

/** invoke_worker's params for a published worker of the recipe's own. */
async function workerCall(ctx: RecipeContext, idempotencyKey?: string) {
  TASK_WORKSPACES.add(ctx.seed.workspaceId);
  return {
    definitionId: (await workerV1(ctx, true)).id,
    version: 1,
    input: { host: 'web-1' },
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  };
}

/** A gate that describes itself (GATE_OP) and answers an observe: create_connection imports the
 *  description, and a re-sync reads it again. Any call that would run something fails the test. */
const notInThisWalk = async (): Promise<never> => {
  throw new Error('the repeat walk calls no gate Operation');
};
const FAKE_GATE: GatekeeperClient = {
  describeOperations: async () =>
    ({ operations: [GATE_OP] }) as Awaited<ReturnType<GatekeeperClient['describeOperations']>>,
  // What a host's status read answers: the walk's one observe-class Operation (OBSERVE_OP).
  observe: async () => ({ data: { host: 'web-1', up: true } }),
  simulate: notInThisWalk,
  apply: notInThisWalk,
  lookupApply: notInThisWalk,
  revert: notInThisWalk,
  health: notInThisWalk,
  storeConnectedAccount: notInThisWalk,
  deleteConnectedAccount: notInThisWalk,
};

/** create_connection's params for a gate of the recipe's own, at an address no other row uses. */
async function connectionCall(ctx: RecipeContext) {
  const { connectionSecret } = await as<{ connectionSecret: string }>(
    ctx,
    'mint_connection_secret',
    {},
  );
  return {
    kind: 'http',
    target: 'repeat-connection',
    endpoint: `http://repeat-${randomUUID().slice(0, 8)}.invalid:8080`,
    connectionSecret,
  };
}

/** Legacy 701: a gate the case's owner connected, its move to a new address previewed — the
 *  params `propose_gate_address_change` takes. As the owner whatever the row's caller: a platform
 *  row decides a proposal the workspace made. */
async function addressChangeCall(ctx: RecipeContext) {
  const owner = { ...ctx, caller: humanCaller(ctx.seed.workspaceId, ctx.seed.ownerId, 'owner') };
  const { gatekeeperId } = await as<{ gatekeeperId: string }>(
    owner,
    'create_connection',
    await connectionCall(owner),
  );
  const { connectionSecret } = await as<{ connectionSecret: string }>(
    owner,
    'mint_connection_secret',
    {},
  );
  const endpoint = `http://repeat-moved-${randomUUID().slice(0, 8)}.invalid:8080`;
  const preview = await as<{ previewDigest: string }>(owner, 'preview_gate_address_change', {
    gatekeeperId,
    endpoint,
    connectionSecret,
  });
  return { gatekeeperId, endpoint, connectionSecret, previewDigest: preview.previewDigest };
}

/** Legacy 701: that move, proposed (by the owner). */
async function openAddressChange(ctx: RecipeContext) {
  const owner = { ...ctx, caller: humanCaller(ctx.seed.workspaceId, ctx.seed.ownerId, 'owner') };
  return as<{ id: string; previewDigest: string }>(
    owner,
    'propose_gate_address_change',
    await addressChangeCall(ctx),
  );
}

/** The session a Handle was issued for. */
const sessionOf = (result: unknown) => (result as { sessionId?: string }).sessionId;

const ONTOLOGY_CHANGE = {
  objectTypes: [
    { name: 'repeat.host', description: 'A host.', identityKey: ['hostname'] },
    { name: 'repeat.service', description: 'A service.', identityKey: ['name'] },
  ],
  linkTypes: [
    {
      name: 'repeat.runs_on',
      domain: 'repeat.service',
      range: 'repeat.host',
      description: 'Where a service runs.',
    },
  ],
};

/** One observation of the walk's ontology: host web-1, up. */
const REPEAT_HOST_OBSERVATION = {
  objectType: 'repeat.host',
  identity: { hostname: 'web-1' },
  properties: { up: true },
};

/** A collector Source of the owner, on a freshly published ONTOLOGY_CHANGE. */
async function observingSource(ctx: RecipeContext): Promise<string> {
  const draft = await as<{ id: string; version: number }>(ctx, 'propose_ontology_change', {
    change: ONTOLOGY_CHANGE,
  });
  await as(ctx, 'publish_ontology_version', { id: draft.id, version: draft.version });
  const source = await as<{ id: string }>(ctx, 'register_source', {
    kind: 'collector',
    name: `repeat-source-${randomUUID().slice(0, 8)}`,
    visibility: 'workspace',
  });
  return source.id;
}

/** A module install's provenance: the ChangePlan segment it applied, as a person. */
const APPLIED_HERE = { status: 'recorded', segmentStatus: 'applied', channel: 'human' };

/** A shipped module at the latest version the owner is shown (`list_workspace_modules`). */
async function latestModule(ctx: RecipeContext, name: string): Promise<Record<string, unknown>> {
  const listed = await as<{ items: { name: string; latestVersion: number }[] }>(
    ctx,
    'list_workspace_modules',
    {},
  );
  const module = listed.items.find((item) => item.name === name);
  if (module === undefined) throw new Error(`no module ${name}`);
  return { name, version: module.latestVersion };
}

/** A shipped pack's install as its dry run showed it: the reviewed version and digest, every
 *  authority-widening item confirmed. */
async function reviewedPack(ctx: RecipeContext, name: string): Promise<Record<string, unknown>> {
  const preview = await as<{
    targetVersion: number;
    digest: string;
    items: { ordinal: number; classification: string }[];
  }>(ctx, 'preview_pack_install', { name });
  return {
    name,
    version: preview.targetVersion,
    reviewedDigest: preview.digest,
    confirmedOrdinals: preview.items
      .filter((item) => item.classification === 'authority_widening')
      .map((item) => item.ordinal),
  };
}

/** A platform user of the case's own (no membership), for a platform row to act on. */
function platformUser(ctx: RecipeContext): Promise<UserRow> {
  return createUser(ctx.pool, {
    login: `repeat-user-${randomUUID().slice(0, 8)}`,
    displayName: 'Repeat Person',
    password: 'repeat-walk-password-1',
  });
}

/** A user the administrator creates (create_user) as a member of the case's workspace. */
async function workspaceMember(ctx: RecipeContext, role: Role = 'member'): Promise<string> {
  const created = await as<{ user: { id: string } }>(ctx, 'create_user', {
    login: `repeat-member-${randomUUID().slice(0, 8)}`,
    displayName: 'Repeat Member',
    workspaceId: ctx.seed.workspaceId,
    role,
  });
  return created.user.id;
}

/** A second owner of the case's workspace (workspaceMember) holding a live agent session: an
 *  interactive Handle the owner issued (issue_handle is the owner's), so a row that ends the
 *  member's sessions has one to end the first time and an already-revoked one the second (per
 *  #493 on batch 22). */
async function memberWithSession(ctx: RecipeContext): Promise<string> {
  const userId = await workspaceMember(ctx, 'owner');
  const principal = await ctx.pool.query<{ id: string }>(
    'select id from principals where user_id = $1 and workspace_id = $2',
    [userId, ctx.seed.workspaceId],
  );
  const principalId = principal.rows[0]?.id;
  if (principalId === undefined) throw new Error('memberWithSession: the member has no Principal');
  await dispatchCapability(
    { pool: ctx.pool },
    humanCaller(ctx.seed.workspaceId, principalId, 'owner'),
    'issue_handle',
    { sessionKind: 'interactive' },
  );
  return userId;
}

/** A user row's updated_at, as text: what a write of the same values still moves. */
async function userUpdatedAt(ctx: RecipeContext, userId: string): Promise<string | undefined> {
  const result = await ctx.pool.query<{ at: string }>(
    'select updated_at::text as at from users where id = $1',
    [userId],
  );
  return result.rows[0]?.at;
}

/** Platform-meta, as every workspace is born with it (`createWorkspaceWithOwner`): ops-assets
 *  v2's `served_by` LinkType names its `Gatekeeper` type (legacy 303). Only the module and pack
 *  rows seed it — a published ontology turns on link-write enforcement for every other row. */
async function withPlatformMeta(ctx: RecipeContext): Promise<void> {
  await withWorkspace(
    ctx.pool,
    { workspaceId: ctx.seed.workspaceId, principalId: ctx.seed.ownerId },
    async (client) => {
      await seedPlatformMetaOntology(client, ctx.seed.workspaceId, ctx.seed.ownerId);
    },
  );
}

/** The ChangePlan segment of a shipped pack installed here, as its dry run showed it. */
async function installedPackSegment(ctx: RecipeContext): Promise<string> {
  await withPlatformMeta(ctx);
  const installed = await as<{ segmentId: string }>(
    ctx,
    'install_pack',
    await reviewedPack(ctx, 'ops-assets'),
  );
  return installed.segmentId;
}

/** The entry template as the caller read it (`get_entry_template_status`): its digest and the
 *  published entry version it would be based on. */
async function entryTemplateRead(ctx: RecipeContext): Promise<Record<string, unknown>> {
  const now = await as<{
    template: { digest: string };
    current: { definitionId: string; version: number } | null;
  }>(ctx, 'get_entry_template_status', {});
  return {
    templateDigest: now.template.digest,
    basedOn:
      now.current === null
        ? null
        : { definitionId: now.current.definitionId, version: now.current.version },
  };
}

/** A gate the case's owner connected itself (create_connection lands a self connection), the
 *  workspace's entry agent holding a live Handle: the workspace and Gatekeeper the platform's
 *  cut-off (`suspend_self_connection`) takes. */
async function selfConnection(
  ctx: RecipeContext,
): Promise<{ workspaceId: string; gatekeeperId: string }> {
  const owner = { ...ctx, caller: humanCaller(ctx.seed.workspaceId, ctx.seed.ownerId, 'owner') };
  const { gatekeeperId } = await as<{ gatekeeperId: string }>(
    owner,
    'create_connection',
    await connectionCall(owner),
  );
  // The workspace's entry agent holds a Handle: a change re-issues it (and audits that), so a
  // second call that took itself for a change would write that audit row again (per #493 on
  // batch 24).
  await entryHandle(ctx);
  return { workspaceId: ctx.seed.workspaceId, gatekeeperId };
}

/** A live entry-agent Handle of the case's owner, on the seeded gate: an `entry` session holding
 *  one, as the entry agent's would (what a platform change to a gate the workspace uses
 *  re-issues). Returns its jti. */
async function entryHandle(ctx: RecipeContext): Promise<string> {
  const { privateKey } = await generateKeyPair(HANDLE_SIGNING_ALG, { crv: 'Ed25519' });
  const sessionId = randomUUID();
  return withWorkspace(
    ctx.pool,
    { workspaceId: ctx.seed.workspaceId, principalId: ctx.seed.ownerId },
    async (client) => {
      await client.query(
        `insert into sessions (workspace_id, id, principal_id, kind, on_behalf_of, status)
         values ($1, $2, $3, 'entry', $3, 'ready')`,
        [ctx.seed.workspaceId, sessionId, ctx.seed.ownerId],
      );
      const issued = await issueHandle(client, {
        sessionId,
        scope: {
          capabilities: ['observe_operation'],
          resources: { gatekeeper: [ctx.seed.gatekeeperId] },
        },
        ttlSeconds: 3600,
        privateKey,
        basis: { kind: 'role', role: 'owner' },
      });
      return issued.jti;
    },
  );
}

/** When a Handle was revoked (null: it was not). */
async function handleRevokedAt(ctx: RecipeContext, jti: string): Promise<string | null> {
  const result = await ctx.pool.query<{ at: string | null }>(
    'select revoked_at::text as at from capability_handles where jti = $1',
    [jti],
  );
  return result.rows[0]?.at ?? null;
}

/** A connector of the case's own, its one catalog gate linked into the case's workspace on the
 *  seeded Gatekeeper, the workspace's entry agent holding a live Handle (`entryHandle`): what
 *  `set_connector_mode` re-issues when it changes what the connector lets a workspace call. Its
 *  own, so no other file's connector is touched. */
async function linkedConnector(ctx: RecipeContext): Promise<{ name: string; jti: string }> {
  const name = `repeat-${randomUUID().slice(0, 8)}`;
  const gateId = `${name}-gate`;
  await ctx.pool.query(
    `insert into connectors (name, kind, mode) values ($1, 'http', 'self_serve')`,
    [name],
  );
  await ctx.pool.query(
    `insert into gate_instances (gate_id, connector, display_name, transport_kind, endpoint, status)
     values ($1, $2, $1, 'http', $3, 'enabled')`,
    [gateId, name, `https://${gateId}.example.invalid`],
  );
  await ctx.pool.query(
    `insert into workspace_gate_links (workspace_id, gate_id, gatekeeper_object_id, enabled_by)
     values ($1, $2, $3, $4)`,
    [ctx.seed.workspaceId, gateId, ctx.seed.gatekeeperId, ctx.seed.ownerId],
  );
  return { name, jti: await entryHandle(ctx) };
}

/** A user with no password yet (one an API key made, before anyone logged in as them), in no
 *  workspace: what `purge_user` purges, and what `merge_user` may merge away. */
async function passwordlessUser(ctx: RecipeContext): Promise<string> {
  const user = await createUser(ctx.pool, {
    login: `repeat-passwordless-${randomUUID().slice(0, 8)}`,
    displayName: 'Passwordless Person',
  });
  return user.id;
}

/** A workspace of the case's own, disabled past its retention: what `purge_workspace` purges. */
async function purgeableWorkspace(ctx: RecipeContext): Promise<string> {
  const owner = await platformUser(ctx);
  const created = await createWorkspaceWithOwner(ctx.pool, {
    name: `repeat-purgeable-${randomUUID().slice(0, 8)}`,
    owner: { userId: owner.id, displayName: owner.displayName },
  });
  await ctx.pool.query(
    `update workspaces set status = 'disabled', disabled_at = now() - interval '8 days'
      where id = $1`,
    [created.workspaceId],
  );
  return created.workspaceId;
}

/** A gate-host instance of the case's own (create_gate_instance, as a platform administrator: the
 *  case's own on a platform row, else one made for it), on the generic `mcp` connector. */
async function hostedGate(
  ctx: RecipeContext,
  credentialMode: 'shared' | 'connected_account',
): Promise<string> {
  const admin =
    ctx.admin ??
    (await createPlatformAdmin(ctx.pool, {
      login: `repeat-gate-admin-${randomUUID().slice(0, 8)}`,
      displayName: 'Repeat Gate Admin',
      password: 'repeat-walk-password-1',
    }));
  const gateId = `repeat-hosted-${randomUUID().slice(0, 8)}`;
  await dispatchCapability({ pool: ctx.pool }, platformCaller(admin), 'create_gate_instance', {
    gateId,
    transportKind: 'mcp',
    target: 'http://mcp.internal.test/',
    credentialMode,
  });
  return gateId;
}

/** A gate instance's updated_at, as text: what a write of the same values still moves. */
async function gateInstanceUpdatedAt(
  ctx: RecipeContext,
  gateId: string,
): Promise<string | undefined> {
  const result = await ctx.pool.query<{ at: string }>(
    'select updated_at::text as at from gate_instances where gate_id = $1',
    [gateId],
  );
  return result.rows[0]?.at;
}

/** The entry Handle `linkedConnector` issued, by connector name (for the recipe's `holds`). */
const ENTRY_JTI = new Map<string, string>();

/** A connector row as it stands: what `set_connector_mode` writes the same of again. */
async function connectorNow(
  ctx: RecipeContext,
  name: string,
): Promise<{ mode: string; disabledOperations: string[]; updatedAt: string }> {
  const result = await ctx.pool.query<{
    mode: string;
    disabled_operations: string[];
    updated_at: string;
  }>(
    'select mode, disabled_operations, updated_at::text as updated_at from connectors where name = $1',
    [name],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`no connector ${name}`);
  return { mode: row.mode, disabledOperations: row.disabled_operations, updatedAt: row.updated_at };
}

/** The platform settings' version: what each write of them takes the next of. */
async function platformSettingsVersion(ctx: RecipeContext): Promise<number | undefined> {
  const result = await ctx.pool.query<{ version: number }>(
    'select version from platform_settings where singleton',
  );
  return result.rows[0]?.version;
}

/** A trial workspace of the case's administrator (`admin_trial`, they its owner): where their
 *  admin agent lives. Its owner Principal is the agent's person. */
async function adminTrial(
  ctx: RecipeContext,
): Promise<{ workspaceId: string; principalId: string }> {
  if (ctx.admin === null) throw new Error('adminTrial: a platform row only');
  const created = await createWorkspaceWithOwner(ctx.pool, {
    name: `repeat-trial-${randomUUID().slice(0, 8)}`,
    owner: { userId: ctx.admin.id, displayName: ctx.admin.displayName },
    purpose: 'admin_trial',
  });
  return { workspaceId: created.workspaceId, principalId: created.ownerPrincipalId };
}

/** That trial workspace with the administrator's admin agent running in it: an `admin_agent`
 *  session holding a Handle, for `stop_admin_agent` to end the first time. The agent is switched
 *  on (`ADMIN_AGENT_ENABLED`) for the issue only: stopping it needs no switch. */
async function adminTrialWithSession(ctx: RecipeContext): Promise<string> {
  const trial = await adminTrial(ctx);
  const { privateKey } = await generateKeyPair(HANDLE_SIGNING_ALG, { crv: 'Ed25519' });
  const previous = process.env.ADMIN_AGENT_ENABLED;
  process.env.ADMIN_AGENT_ENABLED = '1';
  try {
    await withWorkspace(ctx.pool, trial, (client) =>
      issueAdminAgentHandle(client, { ...trial, ttlSeconds: 600, privateKey }),
    );
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, 'ADMIN_AGENT_ENABLED');
    else process.env.ADMIN_AGENT_ENABLED = previous;
  }
  return trial.workspaceId;
}

/** Extra cases for a row, beyond the one with schema-built params on the bare seed. A declaration
 *  holds on every path, so a row whose answer depends on state gets a case per state (per #493 on
 *  batch D4). */
const RECIPES: Readonly<Record<string, Readonly<Record<string, Recipe>>>> = {
  stop_agent: {
    // The bare seed has no Turn, so the schema-built case only walks the idle path
    // (`stopped: false` twice). Here a Turn is running first — `send_chat_message` starts one,
    // and with no agent runtime wired nothing ends it — so both calls take the stop path.
    'a running Turn': {
      setUp: async ({ pool, caller, seed }) => {
        await dispatchCapability({ pool }, caller, 'send_chat_message', {
          chatId: seed.chatId,
          text: 'run, so that it can be stopped',
        });
        return { chatId: seed.chatId };
      },
      first: { stopped: true },
    },
  },
  // Legacy 647: a second grant of one scope returns the first. Both name a person, which the
  // schema walk cannot pick (`principalId` falls back to an Operation's id), so these rows run their
  // recipes only (`RECIPES_ONLY`).
  grant_capability: {
    'the member, the seeded gate': {
      setUp: async ({ seed, memberId }) => ({
        principalId: memberId,
        resourceType: 'gatekeeper',
        resourceId: seed.gatekeeperId,
      }),
    },
  },
  connect_gatekeeper: {
    'the member, the seeded gate': {
      setUp: async ({ pool, seed, memberId }) => {
        await registerSeededGatekeeper(pool, seed);
        return { gatekeeperId: seed.gatekeeperId, principalId: memberId };
      },
    },
  },
  // Legacy 664, batch 1. The rows below name a person, a Grant, a request or a draft the walk
  // cannot pick, so they run their recipes only (`RECIPES_ONLY`).
  set_principal_role: {
    'the member, to builder': {
      setUp: async ({ memberId }) => ({ principalId: memberId, role: 'builder' }),
    },
  },
  disable_principal: {
    'the member': { setUp: async ({ memberId }) => ({ principalId: memberId }) },
  },
  rotate_api_key: {
    // People sign in with a password (a person's key is refused): a service Principal's key.
    'a service Principal': {
      setUp: async (ctx) => {
        const made = await as<{ principal: { id: string } }>(ctx, 'create_principal', {
          role: 'member',
          displayName: 'repeat service',
        });
        return { principalId: made.principal.id };
      },
    },
  },
  revoke_capability: {
    // An already revoked Grant is not offered again: grants.ts `revokeCapabilityGrant` matches
    // active rows only, on purpose, so the second revoke is the not-found of a missing one.
    'a Grant to the member': {
      setUp: async (ctx) => {
        const grant = await as<{ id: string }>(ctx, 'grant_capability', {
          principalId: ctx.memberId,
          resourceType: 'gatekeeper',
          resourceId: ctx.seed.gatekeeperId,
        });
        return { grantId: grant.id };
      },
    },
  },
  cancel_connection_request: {
    'a pending request': {
      setUp: async (ctx) => {
        const request = await as<{ id: string }>(ctx, 'request_connection', {
          kind: 'ssh',
          target: 'repeat.example',
        });
        return { connectionRequestId: request.id };
      },
    },
  },
  record_decision: {
    // A Decision is attributed to the running Turn; with no agent runtime nothing ends it.
    'a running Turn': {
      setUp: async (ctx) => {
        await as(ctx, 'send_chat_message', { chatId: ctx.seed.chatId, text: 'decide something' });
        return { summary: 'Restart web-1 tonight.' };
      },
    },
  },
  publish_skill: {
    'a v1 draft': {
      setUp: async (ctx) => {
        const v1 = await familyV1(ctx, 'skill', skillBody(), false);
        return { skillId: v1.id, version: 1, draftDigest: v1.draftDigest };
      },
    },
  },
  deprecate_skill: {
    'a published v1': {
      setUp: async (ctx) => ({ skillId: (await familyV1(ctx, 'skill', skillBody(), true)).id }),
    },
  },
  publish_procedure: {
    'a v1 draft': {
      setUp: async (ctx) => {
        const v1 = await familyV1(ctx, 'procedure', procedureBody(), false);
        return { procedureId: v1.id, version: 1, draftDigest: v1.draftDigest };
      },
    },
  },
  deprecate_procedure: {
    'a published v1': {
      setUp: async (ctx) => ({
        procedureId: (await familyV1(ctx, 'procedure', procedureBody(), true)).id,
      }),
    },
  },
  // Without an id, each call starts a new draft family — same name or not; two families with
  // one name are stopped at publish (`skill_name_conflict`), by design (#493 on 664 batch 1). An
  // agent retrying a lost answer leaves extra drafts, never an extra published Skill. With the id
  // of a published family, the first call proposes its next version and a second one is refused
  // while that draft is pending.
  propose_skill: {
    'a new family': { setUp: async () => ({ skill: skillBody() }) },
    'the next version of a published one': {
      setUp: async (ctx) => {
        const body = skillBody();
        const v1 = await familyV1(ctx, 'skill', body, true);
        return { skill: { ...body, markdown: '# Two' }, skillId: v1.id };
      },
      repeat: 'conflict: draft_pending',
    },
  },
  propose_procedure: {
    'a new family': { setUp: async () => ({ procedure: procedureBody() }) },
    'the next version of a published one': {
      setUp: async (ctx) => {
        const body = procedureBody();
        const v1 = await familyV1(ctx, 'procedure', body, true);
        return { procedure: { ...body, description: 'v2' }, procedureId: v1.id };
      },
      repeat: 'conflict: draft_pending',
    },
  },
  // Legacy 679: saving the same profile again rewrites updated_at / updated_by
  // and revokes the person's entry Handles. It should be idempotent; until it is, `repeats`.
  set_agent_profile: {
    "the owner's own": { setUp: async () => ({ promptAddendum: 'Be brief.' }) },
  },
  propose_worker_definition: {
    'a new family': {
      setUp: async () => ({
        kind: 'worker',
        definition: { systemPrompt: 'A worker for the repeat walk.' },
      }),
    },
    // Legacy 680: unlike Skills and Procedures (E2-0, one pending draft a family),
    // a WorkerDefinition family stacks drafts — the second call makes v3 beside a pending v2.
    // As it is: `repeats`; once it is aligned, `conflict: draft_pending`.
    'the next version of a published one': {
      setUp: async (ctx) => ({
        definitionId: (await workerV1(ctx, true)).id,
        kind: 'worker',
        definition: { systemPrompt: 'Version two.' },
      }),
      repeat: 'repeats',
    },
  },
  // S11 GO16b: each call writes a new family's v1 draft from the combination — a second one is
  // another family (its derivation the family's own), as a second propose_worker_definition is.
  // A qualifying combination needs goals the schema walk cannot make: recipes only.
  propose_definition_from_combination: {
    'a combination that qualifies': {
      setUp: async (ctx) => {
        const base = await workerV1(ctx, true);
        const spec = { instructions: 'Read the logs first.' };
        for (let goal = 0; goal < 3; goal += 1) await achievedGoalStep(ctx, base.id, spec);
        return {
          definitionId: base.id,
          version: 1,
          specDigest: workerSpecDigest(spec),
          name: 'Kept for the repeat walk',
        };
      },
    },
  },
  publish_worker_definition: {
    'a v1 draft': {
      setUp: async (ctx) => ({ definitionId: (await workerV1(ctx, false)).id, version: 1 }),
    },
  },
  deprecate_worker_definition: {
    'a published v1': {
      setUp: async (ctx) => ({ definitionId: (await workerV1(ctx, true)).id, version: 1 }),
    },
  },
  discard_draft: {
    // The discarded draft is gone, so the second call finds no such version.
    'a worker draft': {
      setUp: async (ctx) => ({
        kind: 'worker_definition',
        id: (await workerV1(ctx, false)).id,
        version: 1,
        reason: 'Not needed.',
      }),
    },
    'a Skill draft': {
      setUp: async (ctx) => ({
        kind: 'skill',
        id: (await familyV1(ctx, 'skill', skillBody(), false)).id,
        version: 1,
        reason: 'Not needed.',
      }),
    },
  },
  // Evaluation suites (S10): a suite has one name in a workspace, and every change names the
  // version it was made against — a second identical change finds the suite one version on.
  create_eval_suite: {
    'a published worker': {
      setUp: async (ctx) => ({
        name: 'Restart drills',
        workerDefinitionId: (await workerV1(ctx, true)).id,
        workerDefinitionVersion: 1,
      }),
    },
  },
  repin_eval_suite: {
    'the worker’s v2, published': {
      setUp: async (ctx) => {
        const suite = await evalSuite(ctx, false);
        await as(ctx, 'propose_worker_definition', {
          definitionId: suite.workerId,
          kind: 'worker',
          definition: { systemPrompt: 'Version two.' },
        });
        await as(ctx, 'publish_worker_definition', { definitionId: suite.workerId, version: 2 });
        return {
          suiteId: suite.id,
          suiteVersion: suite.version,
          workerDefinitionVersion: 2,
          reason: 'v2 is the one in use.',
        };
      },
    },
  },
  add_eval_fixture_gate: {
    'the seeded gate': {
      setUp: async (ctx) => {
        await registerSeededGatekeeper(ctx.pool, ctx.seed);
        const suite = await evalSuite(ctx, false);
        return {
          suiteId: suite.id,
          suiteVersion: suite.version,
          gatekeeperId: ctx.seed.gatekeeperId,
        };
      },
    },
  },
  remove_eval_fixture_gate: {
    'the frozen seeded gate': {
      setUp: async (ctx) => {
        const suite = await evalSuite(ctx, true);
        return {
          suiteId: suite.id,
          suiteVersion: suite.version,
          gatekeeperId: ctx.seed.gatekeeperId,
          reason: 'Not needed.',
        };
      },
    },
  },
  add_eval_case: {
    'a case on the frozen gate': {
      setUp: async (ctx) => {
        const suite = await evalSuite(ctx, true);
        return {
          suiteId: suite.id,
          suiteVersion: suite.version,
          partition: 'regression',
          split: 'dev',
          ...evalCase(ctx.seed),
        };
      },
    },
  },
  edit_eval_case: {
    'its one case': {
      setUp: async (ctx) => ({
        ...(await suiteWithCase(ctx)),
        reason: 'Tighter.',
        ...evalCase(ctx.seed),
        title: 'Restart web-1 once',
      }),
    },
  },
  retire_eval_case: {
    'its one case': {
      setUp: async (ctx) => ({ ...(await suiteWithCase(ctx)), reason: 'Obsolete.' }),
    },
  },
  // The seeded gate's one Operation (named after the marker), once the gate is registered.
  update_operation_description: {
    'the seeded Operation': {
      setUp: async ({ pool, seed }) => {
        await registerSeededGatekeeper(pool, seed);
        return { gatekeeperId: seed.gatekeeperId, name: seed.marker, description: 'Lists hosts.' };
      },
    },
  },
  deprecate_operation: {
    'the seeded Operation': {
      setUp: async ({ pool, seed }) => {
        await registerSeededGatekeeper(pool, seed);
        return { gatekeeperId: seed.gatekeeperId, name: seed.marker };
      },
    },
  },
  // A Turn: `send_chat_message` starts one; with no agent runtime wired, `report_turn` (what the
  // entry agent sends at the end) is what ends it.
  report_turn: {
    'a running Turn': {
      setUp: async (ctx) => {
        const sent = await as<{ turnId: string }>(ctx, 'send_chat_message', {
          chatId: ctx.seed.chatId,
          text: 'report back',
        });
        return { turnId: sent.turnId, summary: 'Done.' };
      },
    },
  },
  mark_turn_outcome: {
    'a finished Turn': {
      setUp: async (ctx) => {
        const sent = await as<{ turnId: string }>(ctx, 'send_chat_message', {
          chatId: ctx.seed.chatId,
          text: 'finish, then be judged',
        });
        await as(ctx, 'report_turn', { turnId: sent.turnId, summary: 'Done.' });
        return { turnId: sent.turnId, outcome: 'achieved' };
      },
    },
  },
  get_entry_context: {
    // An item waiting for the Chat, so the first call leases it to the Turn and the second finds
    // it leased already (per #493 on batch 2: without one the lease path ran empty).
    'a running Turn, an item waiting for its Chat': {
      setUp: async (ctx) => {
        const sent = await as<{ turnId: string }>(ctx, 'send_chat_message', {
          chatId: ctx.seed.chatId,
          text: 'what is going on',
        });
        const { workspaceId, ownerId, chatId } = ctx.seed;
        await withWorkspace(ctx.pool, { workspaceId, principalId: ownerId }, (client) =>
          insertPendingContextItem(client, workspaceId, {
            principalId: ownerId,
            chatId,
            kind: 'task_completed',
            subjectId: randomUUID(),
            payload: { summary: 'web-1 restarted' },
            sourceOutboxId: String(Date.now()),
          }),
        );
        return { turnId: sent.turnId };
      },
    },
  },
  reject_draft: {
    // The rejected draft is taken off its family, so the second call finds no such version.
    'a pending Skill v2': { setUp: (ctx) => pendingV2(ctx, 'skill') },
    'a pending Procedure v2': { setUp: (ctx) => pendingV2(ctx, 'procedure') },
  },
  // A goal run's operations answer `changed: false` on a run already where the call puts it — the
  // run's state and the revision the call names make a retry safe, no key needed (goal/control.ts).
  confirm_goal: {
    'a proposed run': {
      setUp: async (ctx) => ({ goalRunId: await goalRun(ctx), revision: 1 }),
    },
  },
  reject_goal: {
    'a proposed run': {
      setUp: async (ctx) => ({ goalRunId: await goalRun(ctx), revision: 1 }),
    },
  },
  pause_goal: {
    'a running run': {
      setUp: async (ctx) => ({ goalRunId: await goalRun(ctx, { confirm: true }) }),
    },
  },
  resume_goal: {
    // The second call finds the run running: a plain resume changes nothing.
    'a run its requester paused': {
      setUp: async (ctx) => ({ goalRunId: await goalRun(ctx, { confirm: true, pause: true }) }),
    },
  },
  release_goal_hold: {
    "an owner's hold on a member's run": {
      setUp: async (ctx) => ({
        goalRunId: await goalRun(ctx, {
          requester: ctx.memberId,
          confirm: true,
          pause: true,
          pausedBy: ctx.caller,
        }),
      }),
    },
  },
  cancel_goal: {
    'a running run': {
      setUp: async (ctx) => ({ goalRunId: await goalRun(ctx, { confirm: true }) }),
    },
  },
  end_goal: {
    'a paused run, not achieved': {
      setUp: async (ctx) => ({
        goalRunId: await goalRun(ctx, { confirm: true, pause: true }),
        outcome: 'not_achieved',
      }),
    },
  },
  revise_goal: {
    // The second call is based on the revision the first replaced: stale.
    'a paused run': {
      setUp: async (ctx) => {
        const goalRunId = await goalRun(ctx, { confirm: true, pause: true });
        const worker = await workerV1(ctx, true);
        return {
          goalRunId,
          basedOnRevision: 1,
          plan: {
            steps: [
              { key: 'b', worker: { definitionId: worker.id, version: 1 }, input: { step: 'b' } },
            ],
          },
          reason: 'step b does it another way',
        };
      },
    },
  },
  propose_goal: {
    // The same proposal from the same session, while it is still proposed, is the run it proposed
    // (R-54) — in the console the person is the session, so a double submit is one run.
    'a plan on a published Worker': {
      setUp: async (ctx) => {
        GOAL_WORKSPACES.add(ctx.seed.workspaceId);
        const worker = await workerV1(ctx, true);
        return {
          statement: 'Restart web-1 and say when it answers again.',
          plan: {
            steps: [
              { key: 'a', worker: { definitionId: worker.id, version: 1 }, input: { step: 'a' } },
            ],
          },
          budget: GOAL_BUDGET,
        };
      },
    },
  },
  assert_fact: {
    'a Fact between two Objects': {
      setUp: async (ctx) => {
        const { hostId, serviceId } = await ownerFact(ctx);
        return {
          sourceObjectId: serviceId,
          targetObjectId: hostId,
          linkType: 'test.runs_on',
          properties: { port: 443 },
        };
      },
    },
  },
  supersede_fact: {
    'an active Fact': {
      setUp: async (ctx) => {
        const { factId, hostId, serviceId } = await ownerFact(ctx);
        return {
          factId,
          sourceObjectId: serviceId,
          targetObjectId: hostId,
          linkType: 'test.runs_on',
          properties: { port: 8080 },
        };
      },
    },
  },
  invalidate_fact: {
    'an active Fact': {
      setUp: async (ctx) => ({ factId: (await ownerFact(ctx)).factId, reason: 'gone' }),
    },
  },
  verify_fact: {
    'a Fact with Evidence on file': {
      setUp: async (ctx) => {
        const { factId } = await ownerFact(ctx);
        const { workspaceId, ownerId } = ctx.seed;
        await withWorkspace(ctx.pool, { workspaceId, principalId: ownerId }, (client) =>
          attachEvidence(client, workspaceId, {
            linkId: factId,
            kind: 'test.evidence',
            content: { note: 'looks right' },
            createdBy: ownerId,
          }),
        );
        return { factId };
      },
    },
  },
  attest_fact: {
    'an active Fact': {
      setUp: async (ctx) => ({
        factId: (await ownerFact(ctx)).factId,
        note: 'I checked it on the host.',
      }),
    },
  },
  resolve_conflict: {
    'an open Conflict between two Sources': {
      setUp: async (ctx) => {
        const a = await ownerFact(ctx);
        const b = await ownerFact(ctx, a, 81);
        const open = await as<{ items: { id: string; factAId: string; factBId: string }[] }>(
          ctx,
          'list_conflicts',
          { status: 'open' },
        );
        const conflict = open.items.find(
          (item) =>
            [item.factAId, item.factBId].includes(a.factId) &&
            [item.factAId, item.factBId].includes(b.factId),
        );
        if (conflict === undefined) throw new Error('the two Facts opened no Conflict');
        return { conflictId: conflict.id, resolution: 'keep_a', reason: 'the first is right' };
      },
    },
  },
  // Legacy 664, batch 5: the governance and agent-policy setters. Each is an upsert of one row,
  // and writing the same value again rewrites that row's updated_at, so they are `repeats`.
  set_policy: {
    "a rule for the seeded gate's Operation": {
      setUp: async ({ pool, seed }) => {
        await registerSeededGatekeeper(pool, seed);
        return {
          policy: {
            gatekeeperId: seed.gatekeeperId,
            actionKindTag: seed.marker,
            autoApprove: false,
          },
        };
      },
    },
  },
  set_quota: {
    'the evaluation budget': {
      setUp: async () => ({ key: 'evaluation.monthly_cost_budget_usd', value: 20 }),
    },
  },
  set_agent_policy: {
    'members may not edit their profile': {
      setUp: async () => ({ memberCanEditProfile: false }),
    },
  },
  // Legacy 664, batch 6: the Operation catalog and its approval rule, on a real gate.
  set_auto_approved_action_kind: {
    'a pending request for the published Operation': {
      setUp: async (ctx) => {
        const gatekeeperId = await gateWithOperation(ctx);
        return {
          gatekeeperId,
          actionKindTag: GATE_OP.name,
          actionRequestId: await pendingRequest(ctx, gatekeeperId),
        };
      },
    },
  },
  publish_operation: {
    "the gate's imported draft": {
      setUp: async (ctx) => {
        const gatekeeperId = await gateWithOperation(ctx, false);
        const draft = await draftOf(ctx, gatekeeperId);
        return { gatekeeperId, name: GATE_OP.name, draftDigest: draft.draftDigest };
      },
    },
  },
  publish_manifest: {
    "the gate's imported draft": {
      setUp: async (ctx) => {
        const gatekeeperId = await gateWithOperation(ctx, false);
        const draft = await draftOf(ctx, gatekeeperId);
        return { gatekeeperId, drafts: [{ name: GATE_OP.name, draftDigest: draft.draftDigest }] };
      },
    },
  },
  discard_operation_draft: {
    "the gate's imported draft": {
      setUp: async (ctx) => {
        const gatekeeperId = await gateWithOperation(ctx, false);
        const draft = await draftOf(ctx, gatekeeperId);
        return {
          gatekeeperId,
          name: GATE_OP.name,
          version: draft.version,
          draftDigest: draft.draftDigest,
        };
      },
    },
  },
  propose_operation: {
    // The result has no id: the draft is its gate, name and version, and what it says. A second
    // propose revises that same draft in place — not a new version (per #493 on batch 6).
    'a new Operation on the gate': {
      entity: (result) => {
        const draft = result as {
          gatekeeperId: string;
          name: string;
          version: number;
          draftDigest: string;
        };
        return `${draft.gatekeeperId}/${draft.name}@${draft.version} ${draft.draftDigest}`;
      },
      setUp: async (ctx) => ({
        gatekeeperId: await gateWithOperation(ctx),
        operation: { ...GATE_OP, name: 'repeat.status', mode: 'observe' },
      }),
    },
  },
  // Legacy 664, batch 7: a followed Procedure, the ontology.
  record_procedure_followed: {
    'a running Turn, a published Procedure': {
      setUp: async (ctx) => {
        const procedure = await familyV1(ctx, 'procedure', procedureBody(), true);
        await as(ctx, 'send_chat_message', { chatId: ctx.seed.chatId, text: 'follow it' });
        return { procedureId: procedure.id, version: 1 };
      },
    },
  },
  propose_ontology_change: {
    'a new family': {
      setUp: async () => ({ change: ONTOLOGY_CHANGE }),
    },
  },
  publish_ontology_version: {
    'its v1 draft': {
      setUp: async (ctx) => {
        const draft = await as<{ id: string; version: number }>(ctx, 'propose_ontology_change', {
          change: ONTOLOGY_CHANGE,
        });
        return { id: draft.id, version: draft.version };
      },
    },
  },
  // Legacy 664, batch 8: Handles. Each call mints a new session and its token; the session is the
  // entity (a service Handle's answer also names its Principal).
  issue_handle: {
    'an interactive session': {
      entity: sessionOf,
      setUp: async () => ({ sessionKind: 'interactive' }),
    },
  },
  issue_service_handle: {
    'a service Principal': {
      entity: sessionOf,
      setUp: async (ctx) => {
        const made = await as<{ principal: { id: string } }>(ctx, 'create_principal', {
          role: 'member',
          displayName: 'repeat runtime',
        });
        return { principalId: made.principal.id, scope: ['find_procedures'] };
      },
    },
  },
  // Legacy 664, batch 9: Tasks, on a published worker.
  invoke_worker: {
    'one idempotency key': {
      setUp: (ctx) => workerCall(ctx, `repeat-${randomUUID()}`),
    },
    // An explicit key returns its Task whatever state it is in, a finished one too (per #493 on
    // batch 9: with only running Tasks, matching unfinished Tasks alone would pass as well).
    'one idempotency key, its Task already cancelled': {
      first: expect.objectContaining({ status: 'cancelled' }),
      setUp: async (ctx) => {
        const params = await workerCall(ctx, `repeat-${randomUUID()}`);
        const task = await as<{ id: string }>(ctx, 'invoke_worker', params);
        await as(ctx, 'cancel_task', { taskId: task.id });
        return params;
      },
    },
    // Without a key an identical call returns the unfinished Task too (the Worker here never
    // reports); once a Task has finished, an identical call starts a new one.
    'no idempotency key, the first still running': {
      setUp: (ctx) => workerCall(ctx),
    },
  },
  report_task_result: {
    // The first report settles the Task, and ending its WorkerRun revokes the run's Handle: the
    // Worker's second call is refused at the door, before the handler (per #493 on batch 12).
    'a running Task, reported by its Worker': {
      first: expect.objectContaining({ status: 'completed' }),
      by: workerHandle,
      setUp: async (ctx) => {
        await as(ctx, 'invoke_worker', await workerCall(ctx));
        return { summary: 'Restarted web-1.' };
      },
    },
  },
  report_task_outcome: {
    // A finished Task the owner delegated, graded from the owner's agent session; the same grade
    // again is a no-op (a different one is the one correction allowed).
    'a finished Task, graded by the session that delegated it': {
      first: expect.objectContaining({ outcome: 'achieved', revision: 1 }),
      by: sessionHandle,
      setUp: async (ctx) => {
        const task = await as<{ id: string }>(ctx, 'invoke_worker', await workerCall(ctx));
        await dispatchCapability(
          { pool: ctx.pool },
          await callerFor(ctx.pool, await workerHandle(ctx)),
          'report_task_result',
          { summary: 'Restarted web-1.' },
        );
        return { taskId: task.id, outcome: 'achieved' };
      },
    },
  },
  request_action: {
    // An approval in flight: the same call (its key derived from the session, gate, Operation
    // and params) returns that ActionRequest.
    'a Worker that may act on the gate asks to run its published Operation': {
      first: expect.objectContaining({ status: 'pending_approval' }),
      by: workerHandle,
      setUp: async (ctx) => {
        const gatekeeperId = await gateWithOperation(ctx);
        // No rule denies it; this one asks a person to approve.
        await as(ctx, 'set_policy', {
          policy: { gatekeeperId, actionKindTag: GATE_OP.name, autoApprove: false },
        });
        const worker = await as<{ id: string }>(ctx, 'propose_worker_definition', {
          kind: 'worker',
          definition: {
            systemPrompt: 'A worker that restarts services.',
            capabilities: ['request_action'],
            gates: [gatekeeperId],
          },
        });
        await as(ctx, 'publish_worker_definition', { definitionId: worker.id, version: 1 });
        TASK_WORKSPACES.add(ctx.seed.workspaceId);
        await as(ctx, 'invoke_worker', {
          definitionId: worker.id,
          version: 1,
          input: { host: 'web-1' },
        });
        return { gatekeeperId, operation: GATE_OP.name, params: { host: 'web-1' } };
      },
    },
  },
  observe_operation: {
    // Each read calls the gate again and records another observe Activity on the same Gatekeeper
    // (its result names no entity: the gate it read is the one the params address).
    'a published observe-class Operation': {
      first: expect.objectContaining({ status: 'ok', data: { host: 'web-1', up: true } }),
      entity: (_result, params) => params.gatekeeperId as string,
      setUp: async (ctx) => ({
        gatekeeperId: await gateWithOperation(ctx, true, OBSERVE_OP),
        operation: OBSERVE_OP.name,
        params: { host: 'web-1' },
      }),
    },
  },
  submit_observations: {
    // One Activity per submission: the second is another Activity that upserts the same Object
    // (its identity names it), so the Object is the entity both calls act on.
    'a Source of the owner, on a published ontology': {
      first: expect.objectContaining({ objectsUpserted: 1 }),
      entity: (result) => (result as { objects: { id: string }[] }).objects[0]?.id,
      setUp: async (ctx) => ({
        sourceId: await observingSource(ctx),
        observations: [REPEAT_HOST_OBSERVATION],
      }),
    },
    // A run's window close, in the Activity its earlier submission returned: no new Activity and
    // nothing left to invalidate, so a second close changes no row (per #493 on batch 14).
    "a window close in the run's own Activity": {
      repeat: 'idempotent',
      first: expect.objectContaining({ objectsUpserted: 0, factsInvalidated: 0 }),
      setUp: async (ctx) => {
        const sourceId = await observingSource(ctx);
        const run = await as<{ activityId: string }>(ctx, 'submit_observations', {
          sourceId,
          observations: [REPEAT_HOST_OBSERVATION],
        });
        return {
          sourceId,
          activityId: run.activityId,
          observations: [],
          window: { complete: true, objectTypes: ['repeat.host'] },
        };
      },
    },
  },
  cancel_task: {
    // The first call cancels it; a second finds it cancelled already and changes nothing.
    'a running Task': {
      first: expect.objectContaining({ status: 'cancelled' }),
      setUp: async (ctx) => {
        const task = await as<{ id: string }>(ctx, 'invoke_worker', await workerCall(ctx));
        return { taskId: task.id };
      },
    },
  },
  add_member: {
    // A platform user who is not in the workspace yet; the second add finds them a member.
    'an active platform user not yet a member': {
      setUp: async ({ pool }) => {
        const login = `repeat-member-${randomUUID().slice(0, 8)}`;
        await createUser(pool, {
          login,
          displayName: 'Repeat Member',
          password: 'correct horse battery staple',
        });
        return { login, role: 'member' };
      },
    },
  },
  create_connection: {
    // The second finds a Gatekeeper at that address already: re-sync it or rotate its secret.
    'a gate not connected yet': { setUp: connectionCall },
  },
  refresh_operation_governance: {
    'a gate the workspace connected itself, its preview read': {
      setUp: async (ctx) => {
        const { gatekeeperId } = await as<{ gatekeeperId: string }>(
          ctx,
          'create_connection',
          await connectionCall(ctx),
        );
        const preview = await as<{ manifestDigest: string }>(ctx, 'preview_gatekeeper_resync', {
          gatekeeperId,
        });
        return { gatekeeperId, manifestDigest: preview.manifestDigest };
      },
    },
  },
  rotate_connection_secret: {
    // Each call stores a new salt on the same Gatekeeper: the secret before it stops working.
    'a gate the workspace connected itself': {
      setUp: async (ctx) => ({ gatekeeperId: await gateWithOperation(ctx, false) }),
    },
  },
  // Legacy 701: the same proposal again is refused — its secret already served one; the same
  // withdrawal or decision again finds the proposal decided.
  propose_gate_address_change: {
    'a gate the workspace connected itself, its move previewed': { setUp: addressChangeCall },
  },
  withdraw_gate_address_change: {
    'an open proposal': { setUp: async (ctx) => ({ id: (await openAddressChange(ctx)).id }) },
  },
  approve_gate_address_change: {
    'an open proposal, as read': {
      setUp: async (ctx) => {
        const proposal = await openAddressChange(ctx);
        return {
          workspaceId: ctx.seed.workspaceId,
          id: proposal.id,
          previewDigest: proposal.previewDigest,
        };
      },
      first: expect.objectContaining({ status: 'applied' }),
    },
  },
  reject_gate_address_change: {
    'an open proposal': {
      setUp: async (ctx) => ({
        workspaceId: ctx.seed.workspaceId,
        id: (await openAddressChange(ctx)).id,
      }),
      first: expect.objectContaining({ status: 'rejected' }),
    },
  },
  reconcile_goal_action: {
    'an action of the run whose outcome is unknown': {
      setUp: async (ctx) => {
        const goalRunId = await goalRun(ctx, { confirm: true });
        return {
          goalRunId,
          actionRequestId: await outcomeUnknownAction(ctx, goalRunId),
          verdict: 'effect_seen',
        };
      },
    },
  },
  // Legacy 664, batch 15: modules and packs the deployment ships, into a workspace that has none.
  install_module: {
    'a module not installed here': {
      first: expect.objectContaining({ provenance: expect.objectContaining(APPLIED_HERE) }),
      setUp: async (ctx) => {
        await withPlatformMeta(ctx);
        return latestModule(ctx, 'ops-assets');
      },
    },
  },
  upgrade_module: {
    'a module not installed here': {
      first: expect.objectContaining({ provenance: expect.objectContaining(APPLIED_HERE) }),
      setUp: async (ctx) => {
        await withPlatformMeta(ctx);
        return latestModule(ctx, 'ops-assets');
      },
    },
  },
  install_pack: {
    // The first install changes what the dry run shows, so the same reviewed digest again is
    // refused before anything is written: preview again to see it is up to date.
    'a pack not installed here, as its dry run showed it': {
      first: expect.objectContaining({ segmentId: expect.any(String) }),
      setUp: async (ctx) => {
        await withPlatformMeta(ctx);
        return reviewedPack(ctx, 'ops-assets');
      },
    },
    // Reviewed again once installed: up to date, so neither call records anything.
    'a pack already up to date, as its dry run shows it': {
      repeat: 'idempotent',
      first: expect.objectContaining({ segmentId: null }),
      setUp: async (ctx) => {
        await withPlatformMeta(ctx);
        await as(ctx, 'install_pack', await reviewedPack(ctx, 'ops-assets'));
        return reviewedPack(ctx, 'ops-assets');
      },
    },
  },
  propose_entry_template_upgrade: {
    // A published entry the template has moved past: the second call finds the caller's own
    // identical draft and returns it (`created: false`).
    'a published entry behind the template': {
      first: expect.objectContaining({ created: true, differs: ['systemPrompt'] }),
      entity: (result) => (result as { draft: { id: string } }).draft.id,
      setUp: async (ctx) => {
        const fresh = await as<{ draft: { id: string; version: number; definition: object } }>(
          ctx,
          'propose_entry_template_upgrade',
          await entryTemplateRead(ctx),
        );
        await as(ctx, 'publish_worker_definition', {
          definitionId: fresh.draft.id,
          version: fresh.draft.version,
        });
        const older = await as<{ id: string; version: number }>(ctx, 'propose_worker_definition', {
          definitionId: fresh.draft.id,
          kind: 'entry',
          definition: { ...fresh.draft.definition, systemPrompt: 'An older entry prompt.' },
        });
        await as(ctx, 'publish_worker_definition', {
          definitionId: older.id,
          version: older.version,
        });
        return entryTemplateRead(ctx);
      },
    },
    // Legacy 691: with no published entry (basedOn: null) a second call is a second entry family,
    // not the caller's identical draft — the lookup reads the published family's drafts only.
    // As it is: `creates`; once aligned, `idempotent`.
    'no published entry': {
      repeat: 'creates',
      first: expect.objectContaining({ created: true, basedOn: null }),
      entity: (result) => (result as { draft: { id: string } }).draft.id,
      setUp: (ctx) => entryTemplateRead(ctx),
    },
  },
  release_eval_seal_hold: {
    // The first call releases the pause; the same release again finds none active (409).
    "an active pause of the member's agents": {
      first: expect.objectContaining({ status: 'released' }),
      setUp: async ({ pool, seed, memberId }) => {
        const hold = await withWorkspace(
          pool,
          { workspaceId: seed.workspaceId, principalId: seed.ownerId },
          (client) =>
            client.query<{ id: string }>(
              `insert into eval_seal_holds (workspace_id, principal_id, hits, places)
               values ($1, $2, 3, '{"capabilityResult": 3, "capabilityError": 0, "workerStart": 0}')
               returning id`,
              [seed.workspaceId, memberId],
            ),
          { skipRoleSwitch: true },
        );
        return { holdId: hold.rows[0]?.id, reason: 'Checked: the refusals were a test.' };
      },
    },
  },
  start_eval_case_trial: {
    // Each call starts another case_trial run and its evaluation Task (left running: the Worker
    // never reports here; afterAll ends it).
    'its one case': {
      setUp: (ctx) => {
        TASK_WORKSPACES.add(ctx.seed.workspaceId);
        return suiteWithCase(ctx);
      },
    },
  },
  sync_eval_fixture_gate: {
    // The first sync freezes the gate again as a new suite version, so the same call again names a
    // suite version that is no longer the latest (409 version_changed), nothing written.
    'a frozen gate that publishes another Operation since': {
      first: expect.objectContaining({ version: expect.any(Number) }),
      setUp: async (ctx) => {
        const suite = await evalSuite(ctx, true);
        const { pool, seed } = ctx;
        await withWorkspace(
          pool,
          { workspaceId: seed.workspaceId, principalId: seed.ownerId },
          async (client) => {
            const activity = await startActivity(client, seed.workspaceId, {
              kind: 'test.connection',
              principalId: seed.ownerId,
            });
            await importManifest(client, seed.workspaceId, {
              gatekeeperId: seed.gatekeeperId,
              operations: [GATE_OP],
              proposedBy: { id: seed.ownerId, kind: 'human' },
              activityId: activity.id,
            });
            await publishOperation(client, seed.workspaceId, {
              gatekeeperId: seed.gatekeeperId,
              name: GATE_OP.name,
            });
          },
        );
        return {
          suiteId: suite.id,
          suiteVersion: suite.version,
          gatekeeperId: ctx.seed.gatekeeperId,
        };
      },
    },
  },
  start_draft_evaluation: {
    // While the first evaluation of the draft runs, the same start again is refused (409
    // draft_evaluating), nothing written. Its Tasks are left running: afterAll ends them.
    'a pending Skill v2 on a suite with one case': {
      first: expect.objectContaining({ status: 'running' }),
      setUp: (ctx) => {
        TASK_WORKSPACES.add(ctx.seed.workspaceId);
        return draftEvaluationParams(ctx);
      },
    },
  },
  cancel_draft_evaluation: {
    // The first call cancels the running evaluation; the same cancel again finds it ended (409
    // conflict), nothing written.
    'a running evaluation of a pending Skill v2': {
      setUp: async (ctx) => {
        TASK_WORKSPACES.add(ctx.seed.workspaceId);
        const started = await as<{ id: string }>(
          ctx,
          'start_draft_evaluation',
          await draftEvaluationParams(ctx),
        );
        return { evaluationId: started.id };
      },
    },
  },
  verify_change_segment: {
    // The first call checks the segment again and records it; the same call again inside the
    // cooldown is refused before anything is checked (429 change_verification_cooldown).
    // Installing verifies the segment once, so that run's time is set back past the cooldown
    // (with the guards off: verified_at is only ever a run's own stamp).
    'a pack install applied here, last verified two minutes ago': {
      first: expect.objectContaining({ verification: expect.any(Object) }),
      setUp: async (ctx) => {
        const segmentId = await installedPackSegment(ctx);
        await withWorkspace(
          ctx.pool,
          { workspaceId: ctx.seed.workspaceId, principalId: ctx.seed.ownerId },
          async (client) => {
            await client.query('set local session_replication_role = replica');
            await client.query(
              `update change_segments set verified_at = verified_at - interval '2 minutes'
                where workspace_id = $1 and id = $2`,
              [ctx.seed.workspaceId, segmentId],
            );
          },
          { skipRoleSwitch: true },
        );
        return { segmentId };
      },
    },
  },
  // Platform rows: run by an administrator of the case's own (platformCaller); their rows are the
  // whole database's (databaseDigest), their audit rows every one written since the case began.
  update_user: {
    // The same values written again: the row moves only by its updated_at.
    'another user, a new display name': {
      first: expect.objectContaining({ displayName: 'Renamed Person' }),
      setUp: async (ctx) => ({
        userId: (await platformUser(ctx)).id,
        displayName: 'Renamed Person',
      }),
      moves: (ctx, params) => userUpdatedAt(ctx, params.userId as string),
    },
  },
  set_user_status: {
    // Disabling again revokes the member's (already revoked) credentials again and moves the
    // user row's updated_at.
    "a member of the case's workspace, to disabled": {
      first: expect.objectContaining({ status: 'disabled' }),
      setUp: async (ctx) => ({ userId: await workspaceMember(ctx), status: 'disabled' }),
      moves: (ctx, params) => userUpdatedAt(ctx, params.userId as string),
    },
  },
  create_user: {
    // The login is taken by the first call, so the same call again is refused (409 login_taken).
    'a new login': {
      first: expect.objectContaining({ user: expect.objectContaining({ status: 'active' }) }),
      setUp: async () => ({
        login: `repeat-new-${randomUUID().slice(0, 8)}`,
        displayName: 'New Person',
        workspaceId: null,
      }),
    },
  },
  add_membership: {
    // The first call makes the user a member, so the same call again is refused (409
    // already_member).
    "a user who is not in the case's workspace": {
      first: expect.objectContaining({ role: 'member' }),
      setUp: async (ctx) => ({
        userId: (await platformUser(ctx)).id,
        workspaceId: ctx.seed.workspaceId,
        role: 'member',
      }),
    },
  },
  set_membership_role: {
    // The role is already the one asked for: nothing changes, no session ends and no Handle is
    // revoked (legacy 696).
    "a second owner of the case's workspace with a live session, to builder": {
      first: expect.objectContaining({ role: 'builder' }),
      setUp: async (ctx) => ({
        userId: await memberWithSession(ctx),
        workspaceId: ctx.seed.workspaceId,
        role: 'builder',
      }),
    },
  },
  remove_membership: {
    // The membership is already disabled and its credentials already revoked.
    "a second owner of the case's workspace with a live session": {
      first: expect.objectContaining({ removed: true }),
      setUp: async (ctx) => ({
        userId: await memberWithSession(ctx),
        workspaceId: ctx.seed.workspaceId,
      }),
    },
  },
  update_workspace: {
    // The workspace already has the name.
    "the case's workspace, a new name": {
      first: expect.objectContaining({ name: 'Renamed Workspace' }),
      setUp: async (ctx) => ({ workspaceId: ctx.seed.workspaceId, name: 'Renamed Workspace' }),
    },
  },
  set_workspace_status: {
    // Disabled already: its sessions are revoked, and disabled_at keeps the first time.
    "the case's workspace, a second owner with a live session, to disabled": {
      first: expect.objectContaining({ status: 'disabled' }),
      setUp: async (ctx) => {
        await memberWithSession(ctx);
        return { workspaceId: ctx.seed.workspaceId, status: 'disabled' };
      },
    },
  },
  set_user_budget: {
    // The same limit written again: the user row moves only by its updated_at.
    'another user, a daily call limit': {
      first: expect.objectContaining({ dailyCallLimit: 100 }),
      setUp: async (ctx) => ({ userId: (await platformUser(ctx)).id, dailyCallLimit: 100 }),
      moves: (ctx, params) => userUpdatedAt(ctx, params.userId as string),
    },
  },
  reset_user_password: {
    // Each reset hashes a new temporary password and revokes the user's credentials again (the
    // first time a live session's, per #493 on batch 23).
    "a second owner of the case's workspace with a live session": {
      first: expect.objectContaining({ temporaryPassword: expect.any(String) }),
      setUp: async (ctx) => ({ userId: await memberWithSession(ctx) }),
      moves: async (ctx, params) => {
        const result = await ctx.pool.query<{ hash: string }>(
          'select password_hash as hash from users where id = $1',
          [params.userId],
        );
        return result.rows[0]?.hash;
      },
    },
  },
  set_allowed_models: {
    // The same list written again: the workspace's AgentPolicy moves only by its updated_at.
    "the case's workspace, no cap": {
      first: expect.objectContaining({ allowedModels: [] }),
      setUp: async (ctx) => ({ workspaceId: ctx.seed.workspaceId, allowedModels: [] }),
      moves: async (ctx, params) => {
        const result = await ctx.pool.query<{ at: string }>(
          'select updated_at::text as at from agent_policies where workspace_id = $1',
          [params.workspaceId],
        );
        return result.rows[0]?.at;
      },
    },
  },
  update_platform_settings: {
    // The settings are one row: each update keeps the version it replaces in the history and
    // takes the next. The patch is the value already there, so nothing else in the platform's
    // behaviour changes for the files after this one.
    'the password minimum length it already has': {
      first: expect.objectContaining({ passwordMinLength: expect.any(Number) }),
      setUp: async (ctx) => {
        const current = await ctx.pool.query<{ settings: Record<string, unknown> }>(
          'select settings from platform_settings where singleton',
        );
        const length = current.rows[0]?.settings.passwordMinLength;
        return { passwordMinLength: typeof length === 'number' ? length : 8 };
      },
      entity: () => 'platform_settings',
      moves: async (ctx) => {
        const result = await ctx.pool.query<{ version: number }>(
          'select version from platform_settings where singleton',
        );
        return result.rows[0]?.version;
      },
    },
  },
  roll_back_change_segment: {
    // The first call rolls the segment back; the same call again finds it rolled back (409
    // change_segment_rolled_back), nothing written.
    'a pack install applied here': {
      first: expect.objectContaining({ status: 'rolled_back' }),
      setUp: async (ctx) => ({ segmentId: await installedPackSegment(ctx) }),
    },
  },
  create_gate_instance: {
    // The gate id is taken by the first call, so the same call again is refused (409
    // gate_id_taken), nothing written.
    'a new gate-host instance': {
      first: expect.objectContaining({ hosted: true, connector: 'mcp' }),
      setUp: async () => ({
        gateId: `repeat-hosted-${randomUUID().slice(0, 8)}`,
        transportKind: 'mcp',
        target: 'http://mcp.internal.test/',
        credentialMode: 'shared',
      }),
    },
  },
  update_gate_instance: {
    // The same display name again: the instance row moves only by its updated_at.
    "a gate-host instance of the case's own, a new display name": {
      first: expect.objectContaining({ displayName: 'Repeat Gate' }),
      setUp: async (ctx) => ({
        gateId: await hostedGate(ctx, 'shared'),
        displayName: 'Repeat Gate',
      }),
      moves: (ctx, params) => gateInstanceUpdatedAt(ctx, params.gateId as string),
    },
  },
  delete_gate_instance: {
    // The first call deletes the instance, so the same call again finds none (404
    // gate_not_found), nothing written.
    "a gate-host instance of the case's own, enabled nowhere": {
      first: expect.objectContaining({ deleted: true }),
      setUp: async (ctx) => ({ gateId: await hostedGate(ctx, 'shared') }),
    },
  },
  issue_gate_host_token: {
    // Stores nothing (the token is signed, not recorded): another call mints another 5-minute
    // token and changes no row.
    "a shared-credential gate-host instance of the case's own": {
      first: expect.objectContaining({ credentialMode: 'shared', token: expect.any(String) }),
      setUp: async (ctx) => ({ gateId: await hostedGate(ctx, 'shared') }),
    },
  },
  issue_gate_credential_token: {
    // Stores nothing, as issue_gate_host_token: another call mints another token for the
    // caller's own slot and changes no row.
    "a per-member gate-host instance linked into the case's workspace": {
      first: expect.objectContaining({ token: expect.any(String) }),
      setUp: async (ctx) => {
        const gateId = await hostedGate(ctx, 'connected_account');
        await ctx.pool.query(
          `insert into workspace_gate_links (workspace_id, gate_id, gatekeeper_object_id, enabled_by)
           values ($1, $2, $3, $4)`,
          [ctx.seed.workspaceId, gateId, ctx.seed.gatekeeperId, ctx.seed.ownerId],
        );
        return { gateId };
      },
    },
  },
  create_workspace: {
    // Names are not unique: each call makes another workspace, with an owner of its own Principal.
    'a new workspace, another user its owner': {
      first: expect.objectContaining({ name: 'Repeat Workspace', status: 'active' }),
      setUp: async (ctx) => ({
        name: 'Repeat Workspace',
        ownerUserId: (await platformUser(ctx)).id,
      }),
    },
  },
  merge_user: {
    // The first call moves the source's memberships to the target and deletes the source, so the
    // same call again finds no source (404 user_not_found), nothing written.
    "a member of the case's workspace with no password, into another user": {
      first: expect.objectContaining({
        memberships: [expect.objectContaining({ role: 'member' })],
      }),
      setUp: async (ctx) => {
        const sourceUserId = await passwordlessUser(ctx);
        await as(ctx, 'add_membership', {
          userId: sourceUserId,
          workspaceId: ctx.seed.workspaceId,
          role: 'member',
        });
        return { sourceUserId, targetUserId: (await platformUser(ctx)).id };
      },
    },
  },
  purge_user: {
    // Purged already: the second call skips the user as not found, nothing written.
    'a user with no password, in no workspace': {
      first: expect.objectContaining({ purgedCount: 1 }),
      second: expect.objectContaining({
        purgedCount: 0,
        outcomes: [expect.objectContaining({ status: 'skipped', reason: 'user_not_found' })],
      }),
      setUp: async (ctx) => ({ userIds: [await passwordlessUser(ctx)] }),
    },
  },
  purge_workspace: {
    // The preview (no confirm) counts what a purge would remove and removes nothing.
    'a workspace disabled past its retention, previewed': {
      first: expect.objectContaining({ executed: false }),
      second: expect.objectContaining({ executed: false }),
      setUp: async (ctx) => ({ workspaceId: await purgeableWorkspace(ctx) }),
    },
    // Confirmed: the first call removes the workspace, so the same call again finds none (404
    // workspace_not_found), nothing written.
    'a workspace disabled past its retention, confirmed': {
      repeat: 'conflict: workspace_not_found',
      first: expect.objectContaining({ executed: true }),
      setUp: async (ctx) => ({ workspaceId: await purgeableWorkspace(ctx), confirm: true }),
    },
  },
  set_default_modules: {
    // The default modules it already has: the settings keep the version they replace in the
    // history and take the next (as update_platform_settings does); what a new workspace gets
    // does not change for the files after this one.
    'the default modules it already has': {
      first: expect.objectContaining({ defaultModules: expect.any(Array) }),
      setUp: async (ctx) => {
        const current = await ctx.pool.query<{ settings: { defaultModules?: string[] } }>(
          'select settings from platform_settings where singleton',
        );
        return { defaultModules: current.rows[0]?.settings.defaultModules ?? [] };
      },
      entity: () => 'platform_settings',
      moves: (ctx) => platformSettingsVersion(ctx),
    },
  },
  set_connector_mode: {
    // The mode and deny list it already has: the connector row moves only by its updated_at, and
    // since what it lets a workspace call does not change, the linked workspace's entry Handle is
    // not re-issued, by either call.
    "a connector of the case's own, linked here with a live entry Handle, as it already is": {
      first: expect.objectContaining({ mode: 'self_serve', disabledOperations: [] }),
      setUp: async (ctx) => {
        const { name, jti } = await linkedConnector(ctx);
        ENTRY_JTI.set(name, jti);
        const { mode, disabledOperations } = await connectorNow(ctx, name);
        return { name, mode, disabledOperations };
      },
      entity: (result) => (result as { name?: string }).name,
      moves: async (ctx, params) => (await connectorNow(ctx, params.name as string)).updatedAt,
      holds: async (ctx, params) => {
        const jti = ENTRY_JTI.get(params.name as string) as string;
        expect(await handleRevokedAt(ctx, jti), 'the entry Handle is not re-issued').toBeNull();
      },
    },
  },
  suspend_self_connection: {
    // Suspended already: the row keeps the first suspension (its time, administrator and
    // reason), and nothing is re-issued.
    "a gate the case's workspace connected itself": {
      first: expect.objectContaining({
        suspendedAt: expect.any(String),
        suspensionReason: 'under review',
      }),
      setUp: async (ctx) => ({ ...(await selfConnection(ctx)), reason: 'under review' }),
      entity: (result) => (result as { gatekeeperId?: string }).gatekeeperId,
    },
  },
  resume_self_connection: {
    // Not suspended any more: nothing is written, and nothing is re-issued.
    "a gate the case's workspace connected itself, suspended": {
      first: expect.objectContaining({ suspendedAt: null }),
      setUp: async (ctx) => {
        const connection = await selfConnection(ctx);
        await as(ctx, 'suspend_self_connection', { ...connection, reason: 'under review' });
        return connection;
      },
      entity: (result) => (result as { gatekeeperId?: string }).gatekeeperId,
    },
  },
  set_admin_agent_targets: {
    // The list it already is: nothing is added or removed, nothing written.
    "the administrator's trial workspace, the case's workspace as its one target": {
      first: expect.objectContaining({ added: [expect.any(String)], removed: [] }),
      second: expect.objectContaining({ added: [], removed: [] }),
      setUp: async (ctx) => ({
        trialWorkspaceId: (await adminTrial(ctx)).workspaceId,
        targetWorkspaceIds: [ctx.seed.workspaceId],
      }),
    },
  },
  stop_admin_agent: {
    // The session is already revoked, its Handles with it: nothing is left to revoke or stop.
    "the administrator's trial workspace, its admin agent running": {
      first: { revokedSessions: 1, stoppedTurns: 0 },
      second: { revokedSessions: 0, stoppedTurns: 0 },
      setUp: async (ctx) => ({ trialWorkspaceId: await adminTrialWithSession(ctx) }),
    },
    'every trial workspace of the administrator, its admin agent running': {
      first: { revokedSessions: 1, stoppedTurns: 0 },
      second: { revokedSessions: 0, stoppedTurns: 0 },
      setUp: async (ctx) => {
        await adminTrialWithSession(ctx);
        return {};
      },
    },
  },
};

/** Rows whose schema-built params cannot make a first call succeed on the bare seed — a param
 *  naming something the walk has no value for — run their recipes instead of that case. */
const RECIPES_ONLY: ReadonlySet<string> = new Set([
  'create_gate_instance',
  'update_gate_instance',
  'delete_gate_instance',
  'issue_gate_host_token',
  'issue_gate_credential_token',
  'create_workspace',
  'merge_user',
  'purge_user',
  'purge_workspace',
  'set_default_modules',
  'set_connector_mode',
  'suspend_self_connection',
  'resume_self_connection',
  'set_admin_agent_targets',
  'stop_admin_agent',
  'set_user_budget',
  'reset_user_password',
  'set_allowed_models',
  'update_platform_settings',
  'set_membership_role',
  'remove_membership',
  'update_workspace',
  'set_workspace_status',
  'create_user',
  'add_membership',
  'update_user',
  'set_user_status',
  'verify_change_segment',
  'roll_back_change_segment',
  'start_draft_evaluation',
  'cancel_draft_evaluation',
  'start_eval_case_trial',
  'sync_eval_fixture_gate',
  'release_eval_seal_hold',
  'propose_entry_template_upgrade',
  'install_module',
  'upgrade_module',
  'install_pack',
  'grant_capability',
  'connect_gatekeeper',
  'set_principal_role',
  'disable_principal',
  'rotate_api_key',
  'revoke_capability',
  'cancel_connection_request',
  'record_decision',
  'publish_skill',
  'deprecate_skill',
  'publish_procedure',
  'deprecate_procedure',
  'reject_draft',
  'propose_skill',
  'propose_procedure',
  'set_agent_profile',
  'propose_worker_definition',
  'propose_definition_from_combination',
  'publish_worker_definition',
  'deprecate_worker_definition',
  'discard_draft',
  'create_eval_suite',
  'repin_eval_suite',
  'add_eval_fixture_gate',
  'remove_eval_fixture_gate',
  'add_eval_case',
  'edit_eval_case',
  'retire_eval_case',
  'update_operation_description',
  'deprecate_operation',
  'report_turn',
  'mark_turn_outcome',
  'get_entry_context',
  'confirm_goal',
  'reject_goal',
  'pause_goal',
  'resume_goal',
  'release_goal_hold',
  'cancel_goal',
  'end_goal',
  'revise_goal',
  'reconcile_goal_action',
  'propose_goal',
  'assert_fact',
  'supersede_fact',
  'invalidate_fact',
  'verify_fact',
  'attest_fact',
  'resolve_conflict',
  'set_policy',
  'set_quota',
  'set_agent_policy',
  'set_auto_approved_action_kind',
  'publish_operation',
  'publish_manifest',
  'discard_operation_draft',
  'propose_operation',
  'record_procedure_followed',
  'propose_ontology_change',
  'publish_ontology_version',
  'add_member',
  'create_connection',
  'refresh_operation_governance',
  'report_task_result',
  'report_task_outcome',
  'request_action',
  'observe_operation',
  'submit_observations',
  'rotate_connection_secret',
  'propose_gate_address_change',
  'withdraw_gate_address_change',
  'approve_gate_address_change',
  'reject_gate_address_change',
  'issue_handle',
  'issue_service_handle',
  'invoke_worker',
  'cancel_task',
]);

interface Declared {
  readonly capability: Capability;
  readonly repeat: string;
  /** The recipe case this is, or undefined for schema-built params on the bare seed. */
  readonly recipe?: string;
}

function declaredRows(): Declared[] {
  const matrix = parse(readFileSync(MATRIX, 'utf8')) as {
    capabilities: Record<string, { repeat?: string }>;
  };
  const out: Declared[] = [];
  for (const [name, row] of Object.entries(matrix.capabilities)) {
    if (row.repeat === undefined || row.repeat.startsWith('unclear:')) continue;
    const capability = getCapability(name);
    if (capability === undefined) throw new Error(`matrix row ${name} has no capability`);
    const recipes = Object.keys(RECIPES[name] ?? {});
    if (RECIPES_ONLY.has(name) && recipes.length === 0) {
      throw new Error(`matrix row ${name} runs its recipes only, and has none`);
    }
    if (!RECIPES_ONLY.has(name)) out.push({ capability, repeat: row.repeat });
    for (const recipe of recipes) {
      out.push({ capability, repeat: RECIPES[name]?.[recipe]?.repeat ?? row.repeat, recipe });
    }
  }
  return out;
}

/** The entity a result names: its own `id`, or the `id` of its one object-valued field, or else
 *  its one `…Id` field (`rotate_api_key` answers `{ principalId, apiKey }`), or else its `key`
 *  (a Quota is keyed by name: `set_quota` answers `{ key, value, … }`). */
function entityId(result: unknown): string | undefined {
  if (result === null || typeof result !== 'object') return undefined;
  const record = result as Record<string, unknown>;
  if (typeof record.id === 'string') return record.id;
  const nested = Object.values(record).filter(
    (value): value is Record<string, unknown> =>
      value !== null &&
      typeof value === 'object' &&
      typeof (value as { id?: unknown }).id === 'string',
  );
  if (nested.length === 1) return nested[0]?.id as string;
  if (nested.length > 1) return undefined;
  const ids = Object.entries(record).filter(
    ([key, value]) => key.endsWith('Id') && typeof value === 'string',
  );
  if (ids.length === 1) return ids[0]?.[1] as string;
  if (ids.length > 1) return undefined;
  return typeof record.key === 'string' ? record.key : undefined;
}

/** A case's time limit: a platform row reads the whole database twice (databaseDigest), which
 *  grows with what earlier files left in it; Vitest's default 5 s is not that budget. */
const CASE_TIMEOUT_MS = 60_000;

interface AuditRow {
  readonly id: string;
  readonly action: string;
  readonly actor_principal_id: string | null;
  readonly actor_user_id: string | null;
  readonly payload: Record<string, unknown>;
}

describe.runIf(DATABASE_URL !== undefined)(
  'a second identical call does what capability-matrix.yaml says — batch D4 / G6 (integration, real Postgres)',
  () => {
    let pool: Pool;

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      // Issuing a Handle signs it: the task runtime holds the key (as the kernel's main() wires
      // it). A spawned Worker never runs: no container, no report. (The CI-only fake one in
      // fake-invoke-worker.ts may be imported by index.ts alone — guard fake-markers rule 2.)
      const { privateKey, publicKey } = await generateKeyPair(HANDLE_SIGNING_ALG, {
        crv: 'Ed25519',
      });
      loadHandlePublicKey = async () => publicKey;
      configureTaskRuntime({
        pool,
        privateKey,
        supervisorClient: {
          // A Worker "starts" and never reports: its Task stays running for cancel_task.
          spawn: async (input) => {
            SPAWNED_HANDLES.set(input.workerRunId, input.capabilityHandle);
            return { containerId: `repeat-${randomUUID()}`, ip: undefined };
          },
          terminate: async () => false,
          status: async () => undefined,
        },
      });
      // The connection rows issue a secret from the gate token (a test one here) and describe a
      // gate through FAKE_GATE; nothing leaves the process.
      const gateToken = `repeat-gate-token-${randomUUID()}`;
      setConnectionHandlerDeps({
        gatekeeperClient: FAKE_GATE,
        connectionSecrets: createGateConnectionSecrets(gateToken),
        outboundTargetGuard: async () => {},
      });
      // observe_operation reads a gate through the request-action deps; nothing here is approved,
      // so the drainer's executor never applies anything.
      const adminWithTransaction = createAdminWithTransaction(pool);
      setRequestActionDeps({
        gatekeeperClient: FAKE_GATE,
        drainer: new ApprovalDrainer({
          executor: createGatekeeperActionExecutor({
            gatekeeperClient: FAKE_GATE,
            withTransaction: adminWithTransaction,
          }),
          withTransaction: adminWithTransaction,
        }),
      });
    });

    afterAll(async () => {
      // Leave no run for a later file's kernel to advance.
      for (const workspaceId of GOAL_WORKSPACES) {
        const client = await pool.connect();
        try {
          await client.query('begin');
          await client.query('set local session_replication_role = replica');
          await client.query(
            `update goal_runs set status = 'cancelled', pause_reason = null, paused_by = null,
                    paused_by_authority = null, ended_at = now(), next_tick_at = null
              where workspace_id = $1 and status not in ('completed', 'cancelled', 'failed')`,
            [workspaceId],
          );
          await client.query('commit');
        } finally {
          client.release();
        }
      }
      for (const workspaceId of TASK_WORKSPACES) {
        await withWorkspace(
          pool,
          { workspaceId, principalId: randomUUID() },
          (client) =>
            client.query(
              `update tasks set status = 'cancelled', cancelled_at = now()
                where workspace_id = $1 and status in ('created', 'queued', 'running', 'waiting_approval')`,
              [workspaceId],
            ),
          { skipRoleSwitch: true },
        );
      }
      resetTaskRuntimeForTests();
      await pool?.end();
    });

    /** Every row the case can touch, but audit: its workspace's; for a platform row, every row
     *  of the database. */
    async function rowsBut(
      workspaceId: string,
      platform: boolean,
    ): Promise<Record<string, string>> {
      if (platform) return databaseDigest(pool);
      const { audit_records: _audit, ...rest } = await workspaceDigest(pool, workspaceId);
      return rest;
    }

    /** The case's audit rows: its workspace's; for a platform row, every row written since the
     *  case began (`since`), wherever it landed. */
    async function auditRows(workspaceId: string, since: Date | null): Promise<AuditRow[]> {
      const result =
        since === null
          ? await pool.query<AuditRow>(
              `select id, action, actor_principal_id, actor_user_id, payload from audit_records
                where workspace_id = $1`,
              [workspaceId],
            )
          : await pool.query<AuditRow>(
              `select id, action, actor_principal_id, actor_user_id, payload from audit_records
                where created_at >= $1`,
              [since],
            );
      return result.rows;
    }

    const declared = declaredRows();

    it('the matrix declares some rows (the walk is not empty)', () => {
      expect(declared.length).toBeGreaterThan(0);
    });

    it.each(
      declared.map(
        (row) =>
          [
            row.recipe === undefined
              ? row.capability.name
              : `${row.capability.name} — ${row.recipe}`,
            row,
          ] as const,
      ),
    )(
      '%s',
      async (_name, { capability, repeat, recipe }) => {
        const platform = capability.scope === 'platform';
        const workspace = await newWorkspace(pool, `repeat-${capability.name}`, [
          'owner',
          'member',
        ]);
        const ownerId = workspace.principals.get('owner') as string;
        const seed = await seedWorkspace(
          pool,
          workspace.workspaceId,
          ownerId,
          `repeat-${randomUUID()}`,
        );
        // A platform row runs as an administrator of its own, so its audit rows are told apart.
        const admin = platform
          ? await createPlatformAdmin(pool, {
              login: `repeat-admin-${randomUUID().slice(0, 8)}`,
              displayName: 'Repeat Admin',
              password: 'repeat-walk-password-1',
            })
          : null;
        const caller =
          admin === null
            ? humanCaller(workspace.workspaceId, ownerId, 'owner')
            : platformCaller(admin);
        const chosen = recipe === undefined ? undefined : RECIPES[capability.name]?.[recipe];
        const params =
          chosen === undefined
            ? paramsFor(capability.paramsSchema, seed)
            : await chosen.setUp({
                pool,
                caller,
                seed,
                memberId: workspace.principals.get('member') as string,
                admin,
              });
        const held =
          chosen?.by === undefined
            ? undefined
            : await chosen.by({
                pool,
                caller,
                seed,
                memberId: workspace.principals.get('member') as string,
                admin,
              });
        const callerNow = () =>
          held === undefined ? Promise.resolve(caller) : callerFor(pool, held);
        const by = await callerNow();
        const call = async () =>
          dispatchCapability({ pool }, await callerNow(), capability.name, params);
        const entityOf = chosen?.entity ?? entityId;
        const ctx: RecipeContext = {
          pool,
          caller,
          seed,
          memberId: workspace.principals.get('member') as string,
          admin,
        };
        // A platform row's audit rows are told apart by time: those written from here on.
        const since = platform
          ? ((await pool.query<{ now: Date }>('select clock_timestamp() as now')).rows[0]?.now ??
            null)
          : null;

        let first: unknown;
        try {
          first = await call();
        } catch (error) {
          throw new Error(
            `${capability.name} declares repeat: ${repeat}, but its first call failed (${String(error)}) — fix the recipe or add one to RECIPES, or declare it unclear`,
          );
        }
        if (chosen?.first !== undefined) expect(first).toEqual(chosen.first);
        const rowsAfterFirst = await rowsBut(workspace.workspaceId, platform);
        const movedAfterFirst = await chosen?.moves?.(ctx, params);
        const auditAfterFirst = new Set(
          (await auditRows(workspace.workspaceId, since)).map((row) => row.id),
        );

        let second: unknown;
        let refusal: unknown;
        try {
          second = await call();
        } catch (error) {
          refusal = error;
        }
        const rowsAfterSecond = await rowsBut(workspace.workspaceId, platform);
        const movedAfterSecond = await chosen?.moves?.(ctx, params);
        const newAudit = (await auditRows(workspace.workspaceId, since)).filter(
          (row) => !auditAfterFirst.has(row.id),
        );

        if (repeat.startsWith('conflict: ')) {
          expect(refusal, 'the second call must be refused').toBeDefined();
          const mapped = mapCapabilityError(refusal);
          expect(mapped.code).toBe(repeat.slice('conflict: '.length));
          expect(mapped.status).toBeGreaterThanOrEqual(400);
          expect(mapped.status).toBeLessThan(500);
          expect(rowsAfterSecond).toEqual(rowsAfterFirst);
          expect(newAudit.filter((row) => row.payload.outcome !== 'refused')).toEqual([]);
          return;
        }

        expect(refusal, 'the second call must succeed').toBeUndefined();
        if (chosen?.second !== undefined) expect(second).toEqual(chosen.second);
        await chosen?.holds?.(ctx, params);
        if (repeat === 'idempotent') {
          const firstId = entityOf(first, params);
          if (firstId !== undefined) expect(entityOf(second, params)).toBe(firstId);
          expect(rowsAfterSecond).toEqual(rowsAfterFirst);
          expect(newAudit.map((row) => row.action)).toEqual([capability.name]);
          if (admin === null) {
            expect(newAudit[0]?.actor_principal_id).toBe(actingPrincipal(by, ownerId));
          } else {
            expect(newAudit[0]?.actor_user_id).toBe(admin.id);
          }
        } else if (repeat === 'creates') {
          const firstId = entityOf(first, params);
          expect(firstId, 'creates: the result names the entity it made').toBeDefined();
          expect(entityOf(second, params)).not.toBe(firstId);
          // A new id with nothing stored for it would not be a second entity (per #488).
          expect(rowsAfterSecond).not.toEqual(rowsAfterFirst);
        } else if (repeat === 'repeats') {
          const firstId = entityOf(first, params);
          expect(firstId, 'repeats: the result names the entity it acted on').toBeDefined();
          expect(entityOf(second, params)).toBe(firstId);
          expect(rowsAfterSecond).not.toEqual(rowsAfterFirst);
          if (chosen?.moves !== undefined) {
            expect(
              movedAfterSecond,
              'repeats: the second call moves what the recipe names',
            ).not.toEqual(movedAfterFirst);
          }
        } else {
          throw new Error(`unknown repeat declaration ${repeat} (guard M6 should have refused it)`);
        }
      },
      CASE_TIMEOUT_MS,
    );
  },
);
