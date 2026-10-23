import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type CapabilityScope,
  GoalDetailWireSchema,
  GoalRunWireSchema,
  PlanRevisionWireSchema,
  type PrincipalKind,
  ProposeGoalResultWireSchema,
  type Role,
  listEnvelope,
} from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { setAgentProfile } from '../../governance/agent-profile/index.js';
import { WORKER_CEILING_CAPABILITIES, entryScope } from '../../governance/capability/index.js';
import { registerGatekeeper } from '../../governance/gatekeepers/index.js';
import { mapCapabilityError } from '../../interfaces/http/capability-route.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { createGoalRun } from '../goal/index.js';
import { proposeWorkerDefinition, publishWorkerDefinition } from '../worker/index.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * Integration tests (real Postgres; auto-skip without DATABASE_URL) for S11 GO5c: `propose_goal`
 * through the capability gateway — the entry agent's call on its person's Handle (the entry
 * ceiling; never a Worker's), or a person's own in the console — and what comes with it: the
 * requester is the caller (a Handle's `obo`), the Turn the entry agent ran in is the run's origin,
 * a retry returns the run it proposed (R-54), a statement or plan carrying a credential or the
 * `[redacted]` mark is refused with the place named (the format the console's plan editor reads),
 * the plan's problems are named by step, and the confirmation card's hints say which step the
 * requester could not start now. `revise_goal` refuses a plan the same way. A Handle reads only its
 * `obo`'s own goals, an owner's included. The requester must be a person, and has at most
 * `GOAL_MAX_PROPOSED_PER_REQUESTER` goals waiting to be confirmed (this file sets it high and
 * lowers it for its own test). What a run does once confirmed is `application/goal`'s tests'.
 *
 * Every run this file proposes is left with no `next_tick_at`, so no advancer of another file
 * claims it.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

const BUDGET = { maxTokens: 100_000, maxSteps: 10, maxRevisions: 2, maxWallClockSeconds: 3600 };
/** Synthetic — `.gitleaks.toml` allows fixtures spelled out from the alphabet. */
const FAKE = 'abcdefghijklmnopqrstuvwxyz0123';

function humanCaller(
  workspaceId: string,
  principalId: string,
  role: Role,
  kind: PrincipalKind = 'human',
): ResolvedCaller {
  return {
    channel: 'human',
    principal: { workspaceId, id: principalId, kind, role, displayName: null },
    session: {
      workspaceId,
      id: randomUUID(),
      principalId,
      kind: 'web',
      onBehalfOf: principalId,
      status: 'active',
      createdAt: new Date(),
      expiresAt: null,
    },
  };
}

/** A Handle of its own session (`sid`): reuse the caller to call again from the same session. */
function handleCaller(workspaceId: string, obo: string, scope: CapabilityScope): ResolvedCaller {
  const now = Math.floor(Date.now() / 1000);
  return {
    channel: 'handle',
    claims: {
      ws: workspaceId,
      sid: randomUUID(),
      obo,
      scope,
      jti: randomUUID(),
      iat: now,
      exp: now + 600,
    },
  };
}

/** What the HTTP transport answers for the call's refusal (it must refuse). */
async function refusal(call: Promise<unknown>) {
  let thrown: unknown;
  try {
    await call;
  } catch (err) {
    thrown = err;
  }
  if (thrown === undefined) throw new Error('expected the call to be refused');
  return mapCapabilityError(thrown);
}

describe.runIf(DATABASE_URL !== undefined)(
  'propose_goal — S11 GO5c (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let requesterId: string;
    let auditorId: string;
    let worker: { definitionId: string; version: number };
    /** `GOAL_MAX_PROPOSED_PER_REQUESTER` before this file raised it; restored afterwards. */
    let savedProposedCap: string | undefined;
    const FILE_PROPOSED_CAP = '1000';

    const admin = <T>(fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId, principalId: ownerId }, fn, { skipRoleSwitch: true });

    /** A write with the guards off — fixtures the write paths of this wave do not reach. */
    const raw = <T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) =>
      admin(async (client) => {
        await client.query('set local session_replication_role = replica');
        return (await client.query(sql, [...params])).rows as T[];
      });

    const as = <T>(principalId: string, fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId, principalId }, fn);

    async function newPrincipal(role: Role, kind: PrincipalKind = 'human'): Promise<string> {
      const id = randomUUID();
      await admin((client) =>
        client.query(
          `insert into principals (workspace_id, id, kind, role, display_name)
           values ($1, $2, $3, $4, $5)`,
          [workspaceId, id, kind, role, `${role}-${id.slice(0, 8)}`],
        ),
      );
      return id;
    }

    async function publish(definition: Record<string, unknown>) {
      const proposed = await as(ownerId, (client) =>
        proposeWorkerDefinition(client, workspaceId, ownerId, { kind: 'worker', definition }),
      );
      await as(ownerId, (client) =>
        publishWorkerDefinition(client, workspaceId, ownerId, {
          definitionId: proposed.id,
          version: proposed.version,
        }),
      );
      return { definitionId: proposed.id, version: proposed.version };
    }

    function planOf(
      keys: readonly string[],
      on: { definitionId: string; version: number } = worker,
    ): { steps: Record<string, unknown>[]; acceptance?: Record<string, unknown>[] } {
      return {
        steps: keys.map((key, index) => ({
          key,
          worker: on,
          input: { step: key },
          ...(index > 0 ? { dependsOn: [keys[index - 1]] } : {}),
        })),
      };
    }

    const proposalOf = (statement: string, plan: unknown = planOf(['a', 'b'])) => ({
      statement,
      plan,
      budget: BUDGET,
    });

    const parkGoal = (goalRunId: string) =>
      raw('update goal_runs set next_tick_at = null where workspace_id = $1 and id = $2', [
        workspaceId,
        goalRunId,
      ]);

    /** A call through the gateway; a run it names is parked again afterwards, refused or not. */
    async function call(caller: ResolvedCaller, name: string, params: Record<string, unknown>) {
      try {
        return await dispatchCapability({ pool }, caller, name, params);
      } finally {
        if (typeof params.goalRunId === 'string') await parkGoal(params.goalRunId);
      }
    }

    async function propose(caller: ResolvedCaller, params: Record<string, unknown>) {
      const result = ProposeGoalResultWireSchema.parse(
        await dispatchCapability({ pool }, caller, 'propose_goal', params),
      );
      await parkGoal(result.goalRunId);
      return result;
    }

    const human = (principalId: string, role: Role) => humanCaller(workspaceId, principalId, role);
    /** The entry agent's Handle for `obo` — the entry ceiling for their role, as the kernel mints it. */
    const entryAgent = (obo: string, role: Role = 'member') =>
      handleCaller(workspaceId, obo, entryScope({}, { role }));

    const goalCount = async () => {
      const [row] = await raw<{ count: number }>(
        'select count(*)::int as count from goal_runs where workspace_id = $1',
        [workspaceId],
      );
      return row?.count ?? 0;
    };

    const goalRow = async (goalRunId: string) => {
      const [row] = await raw<{
        status: string;
        on_behalf_of: string;
        originated_in_turn_id: string | null;
        idempotency_key: string | null;
      }>(
        `select status, on_behalf_of, originated_in_turn_id, idempotency_key
           from goal_runs where workspace_id = $1 and id = $2`,
        [workspaceId, goalRunId],
      );
      if (!row) throw new Error(`goal run ${goalRunId} is gone`);
      return row;
    };

    const hintCodes = (hints: readonly { code: string }[]) => hints.map((hint) => hint.code);

    /** The proposal as the confirmation card reads it (`get_goal_revision`, revision 1). */
    const readProposal = async (by: ResolvedCaller, goalRunId: string) =>
      PlanRevisionWireSchema.parse(await call(by, 'get_goal_revision', { goalRunId, revision: 1 }));

    beforeAll(async () => {
      // The file's requesters propose more goals than the default cap; one test lowers it.
      savedProposedCap = process.env.GOAL_MAX_PROPOSED_PER_REQUESTER;
      process.env.GOAL_MAX_PROPOSED_PER_REQUESTER = FILE_PROPOSED_CAP;
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = randomUUID();
      ownerId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'go5c-propose-goal',
          ]);
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'owner', 'owner')",
            [workspaceId, ownerId],
          );
        },
        { skipRoleSwitch: true },
      );
      requesterId = await newPrincipal('member');
      auditorId = await newPrincipal('auditor');
      worker = await publish({ systemPrompt: 'You do one step of a goal.' });
    });

    afterAll(async () => {
      // Leave nothing for another file's kernel to advance, and no Turn running.
      await raw(
        `update goal_runs set status = 'cancelled', pause_reason = null, paused_by = null,
                paused_by_authority = null, ended_at = now(), next_tick_at = null
          where workspace_id = $1 and status not in ('completed', 'cancelled', 'failed')`,
        [workspaceId],
      );
      await pool.end();
      if (savedProposedCap === undefined)
        Reflect.deleteProperty(process.env, 'GOAL_MAX_PROPOSED_PER_REQUESTER');
      else process.env.GOAL_MAX_PROPOSED_PER_REQUESTER = savedProposedCap;
    });

    describe('who proposes', () => {
      it("the entry agent proposes for its person: the requester is the Handle's obo, the Turn it runs in the run's origin", async () => {
        const turnId = await as(requesterId, async (client) => {
          const chat = await client.query<{ id: string }>(
            `insert into chats (workspace_id, owner_principal_id, visibility)
             values ($1, $2, 'private') returning id`,
            [workspaceId, requesterId],
          );
          const turn = await client.query<{ id: string }>(
            `insert into activities (workspace_id, kind, chat_id, sequence, status, started_by)
             values ($1, 'agent_turn', $2, 1, 'running', $3) returning id`,
            [workspaceId, chat.rows[0]?.id, requesterId],
          );
          return turn.rows[0]?.id as string;
        });
        try {
          const agent = entryAgent(requesterId);
          const proposed = await propose(agent, proposalOf('tidy the release notes'));
          expect(proposed).toMatchObject({ status: 'proposed', changed: true });
          expect(hintCodes(proposed.hints)).toEqual(['requester_confirm_only']);
          const row = await goalRow(proposed.goalRunId);
          expect(row).toMatchObject({
            status: 'proposed',
            on_behalf_of: requesterId,
            originated_in_turn_id: turnId,
          });
          const sid = agent.channel === 'handle' ? agent.claims.sid : '';
          expect(row.idempotency_key).toMatch(new RegExp(`^auto:${sid}:`));

          // The entry agent reads what it proposed: the run, and the proposal the card shows.
          const detail = GoalDetailWireSchema.parse(
            await call(agent, 'get_goal', { goalRunId: proposed.goalRunId }),
          );
          expect(detail).toMatchObject({
            id: proposed.goalRunId,
            status: 'proposed',
            statement: 'tidy the release notes',
          });
          expect(detail.planRevision.id).toBe(proposed.planRevisionId);
          expect((await readProposal(agent, proposed.goalRunId)).hints).toEqual(proposed.hints);

          // A person's own proposal is theirs, whatever Turn their agent is running.
          const own = await propose(human(requesterId, 'member'), proposalOf('mine, by hand'));
          expect(await goalRow(own.goalRunId)).toMatchObject({
            on_behalf_of: requesterId,
            originated_in_turn_id: null,
            idempotency_key: expect.stringMatching(new RegExp(`^auto:${requesterId}:`)),
          });
        } finally {
          await raw(
            `update activities set status = 'completed', ended_at = now()
              where workspace_id = $1 and id = $2`,
            [workspaceId, turnId],
          );
        }
      });

      it("never a Worker's Handle nor an auditor: refused (403), nothing written", async () => {
        const before = await goalCount();
        const workerScope: CapabilityScope = {
          capabilities: [...WORKER_CEILING_CAPABILITIES],
          resources: {},
        };
        expect(workerScope.capabilities).not.toContain('propose_goal');
        for (const caller of [
          handleCaller(workspaceId, requesterId, workerScope),
          entryAgent(auditorId, 'auditor'),
          human(auditorId, 'auditor'),
        ]) {
          expect(
            await refusal(dispatchCapability({ pool }, caller, 'propose_goal', proposalOf('no'))),
          ).toMatchObject({ status: 403, code: 'forbidden' });
        }
        expect(await goalCount()).toBe(before);
      });
    });

    describe('a retry returns the run it proposed (R-54)', () => {
      it('without a key: the same proposal from the same session while it is still proposed; another session, another budget, or once turned down, a new one', async () => {
        const agent = entryAgent(requesterId);
        const params = proposalOf('rotate the staging certificate');
        const first = await propose(agent, params);
        const again = await propose(agent, params);
        expect(again).toEqual({ ...first, changed: false });

        const otherSession = await propose(entryAgent(requesterId), params);
        expect(otherSession.goalRunId).not.toBe(first.goalRunId);
        const otherBudget = await propose(agent, {
          ...params,
          budget: { ...BUDGET, maxTokens: 50_000 },
        });
        expect(otherBudget.goalRunId).not.toBe(first.goalRunId);

        // In the console, the person is the session: a double submit is one run.
        const byHand = proposalOf('rotate the staging certificate, by hand');
        const clicked = await propose(human(requesterId, 'member'), byHand);
        expect(await propose(human(requesterId, 'member'), byHand)).toMatchObject({
          goalRunId: clicked.goalRunId,
          changed: false,
        });

        // Turned down, the same proposal again is a new goal.
        await call(human(requesterId, 'member'), 'reject_goal', {
          goalRunId: first.goalRunId,
          revision: 1,
        });
        const afterReject = await propose(agent, params);
        expect(afterReject).toMatchObject({ status: 'proposed', changed: true });
        expect(afterReject.goalRunId).not.toBe(first.goalRunId);
      });

      it('with a key: the run it first proposed, whatever its status since and whatever the call carries now; the key is its session’s', async () => {
        const agent = entryAgent(requesterId);
        const first = await propose(agent, {
          ...proposalOf('archive last quarter'),
          idempotencyKey: 'archive-q3',
        });
        await call(human(requesterId, 'member'), 'confirm_goal', {
          goalRunId: first.goalRunId,
          revision: 1,
        });
        const replay = await propose(agent, {
          ...proposalOf('archive last quarter, and the one before', planOf(['a'])),
          idempotencyKey: 'archive-q3',
        });
        // No longer proposed: the card's authority check is not worked out for it.
        expect(replay).toEqual({
          goalRunId: first.goalRunId,
          status: 'running',
          changed: false,
          planRevisionId: first.planRevisionId,
          hints: [first.hints[0]],
        });
        const [stored] = await raw<{ count: number }>(
          `select count(*)::int as count from goal_runs where workspace_id = $1 and id = $2
              and statement = 'archive last quarter'`,
          [workspaceId, first.goalRunId],
        );
        expect(stored?.count).toBe(1);

        const otherSession = await propose(entryAgent(requesterId), {
          ...proposalOf('archive last quarter'),
          idempotencyKey: 'archive-q3',
        });
        expect(otherSession).toMatchObject({ status: 'proposed', changed: true });
        expect(otherSession.goalRunId).not.toBe(first.goalRunId);
      });

      it('two concurrent calls with one key, or the same proposal from one session, make one run', async () => {
        for (const extra of [{ idempotencyKey: 'race' }, {}]) {
          const agent = entryAgent(requesterId);
          const params = { ...proposalOf(`race ${JSON.stringify(extra)}`), ...extra };
          const results = await Promise.all([propose(agent, params), propose(agent, params)]);
          expect(results[0].goalRunId).toBe(results[1].goalRunId);
          expect(results.map((result) => result.changed).sort()).toEqual([false, true]);
          const [row] = await raw<{ count: number }>(
            `select count(*)::int as count from goal_runs
              where workspace_id = $1 and idempotency_key = $2`,
            [workspaceId, (await goalRow(results[0].goalRunId)).idempotency_key],
          );
          expect(row?.count).toBe(1);
        }
      });
    });

    describe('what a proposal may not carry', () => {
      it('a credential or the [redacted] mark in the statement or the plan is refused (400) with the place named; nothing is written', async () => {
        const agent = entryAgent(requesterId);
        const before = await goalCount();

        const statement = await refusal(
          dispatchCapability(
            { pool },
            agent,
            'propose_goal',
            proposalOf(`rotate it, the old one is API_KEY=${FAKE}`),
          ),
        );
        expect(statement).toMatchObject({
          status: 400,
          code: 'credentials_in_text',
          details: { field: 'statement', suspectedSecretValues: 1 },
        });
        expect(statement.message).not.toContain(FAKE);
        expect(
          await refusal(
            dispatchCapability(
              { pool },
              agent,
              'propose_goal',
              proposalOf('rotate it, the old one is API_KEY=[redacted]'),
            ),
          ),
        ).toMatchObject({
          status: 400,
          code: 'redacted_text_submitted',
          details: { field: 'statement' },
        });

        const withPassword = planOf(['a', 'b']);
        withPassword.steps[0] = { ...withPassword.steps[0], input: { password: FAKE } };
        const plan = await refusal(
          dispatchCapability({ pool }, agent, 'propose_goal', proposalOf('deploy', withPassword)),
        );
        expect(plan).toMatchObject({
          status: 400,
          code: 'credentials_in_text',
          details: {
            field: 'plan.steps.0.input.password',
            suspectedSecretValues: 1,
            suspectedSecretPaths: ['plan.steps.0.input.password'],
          },
        });
        expect(plan.message).not.toContain(FAKE);

        const withPrompt = planOf(['a']);
        withPrompt.acceptance = [
          { kind: 'requester_confirm', key: 'ok', prompt: `does Bearer ${FAKE} still work?` },
        ];
        expect(
          await refusal(
            dispatchCapability({ pool }, agent, 'propose_goal', proposalOf('check', withPrompt)),
          ),
        ).toMatchObject({
          status: 400,
          code: 'credentials_in_text',
          details: {
            field: 'plan.acceptance.0.prompt',
            suspectedSecretPaths: ['plan.acceptance.0.prompt'],
          },
        });

        const withMark = planOf(['a', 'b']);
        withMark.steps[1] = { ...withMark.steps[1], input: { note: 'API_KEY=[redacted]' } };
        expect(
          await refusal(
            dispatchCapability({ pool }, agent, 'propose_goal', proposalOf('copy', withMark)),
          ),
        ).toMatchObject({
          status: 400,
          code: 'redacted_text_submitted',
          details: { field: 'plan.steps.1.input.note', paths: ['plan.steps.1.input.note'] },
        });

        // The gateway's own check: a statement that says nothing.
        const blank = await refusal(
          dispatchCapability({ pool }, agent, 'propose_goal', proposalOf('   ')),
        );
        expect(blank).toMatchObject({ status: 400, code: 'invalid_params' });
        expect(await goalCount()).toBe(before);
      });

      it('a retry carrying a credential is refused too, though its key proposed a run before', async () => {
        const agent = entryAgent(requesterId);
        const first = await propose(agent, {
          ...proposalOf('renew the domain'),
          idempotencyKey: 'renew',
        });
        expect(
          await refusal(
            dispatchCapability({ pool }, agent, 'propose_goal', {
              ...proposalOf(`renew the domain with TOKEN=${FAKE}`),
              idempotencyKey: 'renew',
            }),
          ),
        ).toMatchObject({ status: 400, code: 'credentials_in_text' });
        expect((await goalRow(first.goalRunId)).status).toBe('proposed');
      });

      it('a plan the platform refuses names each problem by its step (400 invalid_params, details.problems)', async () => {
        const problemsOf = async (plan: unknown) => {
          const mapped = await refusal(
            dispatchCapability(
              { pool },
              entryAgent(requesterId),
              'propose_goal',
              proposalOf('a plan with problems', plan),
            ),
          );
          expect(mapped).toMatchObject({ status: 400, code: 'invalid_params' });
          return (mapped.details as { problems: string[] }).problems;
        };
        // The plan's shape first, then what it references.
        const unknownDependency = planOf(['a', 'b', 'c']);
        unknownDependency.steps[1] = { ...unknownDependency.steps[1], dependsOn: ['zz'] };
        unknownDependency.steps[2] = { ...unknownDependency.steps[2], dependsOn: ['c'] };
        expect(await problemsOf(unknownDependency)).toEqual([
          'step "b": depends on "zz", which is not in the plan',
          'step "c": depends on itself',
        ]);
        const unknownWorker = planOf(['a', 'b']);
        unknownWorker.steps[1] = {
          ...unknownWorker.steps[1],
          worker: { ...worker, version: worker.version + 7 },
        };
        expect(await problemsOf(unknownWorker)).toEqual([
          `step "b": WorkerDefinition ${worker.definitionId}@${worker.version + 7} does not exist`,
        ]);
      });

      it('revise_goal refuses a plan, or a reason, the same way; nothing is written', async () => {
        const created = await as(requesterId, (client) =>
          createGoalRun(client, workspaceId, {
            requesterId,
            proposedBy: requesterId,
            statement: 'a goal to revise',
            plan: planOf(['a', 'b']),
            budget: BUDGET,
          }),
        );
        const goalRunId = created.goalRunId;
        const requester = human(requesterId, 'member');
        await call(requester, 'confirm_goal', { goalRunId, revision: 1 });
        await call(requester, 'pause_goal', { goalRunId });
        const revise = (plan: unknown, reason?: string) =>
          refusal(
            call(requester, 'revise_goal', {
              goalRunId,
              basedOnRevision: 1,
              plan,
              ...(reason !== undefined ? { reason } : {}),
            }),
          );

        const withPassword = planOf(['a', 'c']);
        withPassword.steps[1] = {
          ...withPassword.steps[1],
          input: { targets: ['one', { header: `Bearer ${FAKE}` }] },
        };
        expect(await revise(withPassword)).toMatchObject({
          status: 400,
          code: 'credentials_in_text',
          details: {
            field: 'plan.steps.1.input.targets.1.header',
            suspectedSecretPaths: ['plan.steps.1.input.targets.1.header'],
          },
        });
        const withMark = planOf(['a', 'c']);
        withMark.steps[0] = { ...withMark.steps[0], input: { command: 'PGPASSWORD=[redacted]' } };
        expect(await revise(withMark)).toMatchObject({
          status: 400,
          code: 'redacted_text_submitted',
          details: { field: 'plan.steps.0.input.command' },
        });
        expect(
          await revise(planOf(['a', 'c']), 'retry with Authorization: [redacted]'),
        ).toMatchObject({
          status: 400,
          code: 'redacted_text_submitted',
          details: { field: 'reason' },
        });
        const [row] = await raw<{ count: number }>(
          `select count(*)::int as count from plan_revisions
            where workspace_id = $1 and goal_run_id = $2`,
          [workspaceId, goalRunId],
        );
        expect(row?.count).toBe(1);
      });
    });

    describe('revise_goal: a value left as the read showed it is the value itself', () => {
      it('keeps what is stored for every value left as read — beside a changed one too — checks what was written, and never lets one entry take another’s original', async () => {
        const created = await as(requesterId, (client) =>
          createGoalRun(client, workspaceId, {
            requesterId,
            proposedBy: requesterId,
            statement: 'a goal whose stored plan predates the write checks',
            plan: planOf(['a', 'b', 'z']),
            budget: { ...BUDGET, maxRevisions: 5 },
          }),
        );
        const goalRunId = created.goalRunId;
        const requester = human(requesterId, 'member');
        await call(requester, 'confirm_goal', { goalRunId, revision: 1 });
        await call(requester, 'pause_goal', { goalRunId });

        // A plan stored before the write checks: two steps alike but for their key and the
        // credential each holds, and a note and a check prompt with a joined emoji (a prompt never
        // held a credential: `parsePlan` refused one from the start).
        const emoji = 'family \u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
        const stored = {
          steps: [
            { key: 'a', worker, input: { host: 'db1', password: `${FAKE}A` } },
            { key: 'b', worker, input: { host: 'db1', password: `${FAKE}B` } },
            { key: 'z', worker, input: { note: emoji } },
          ],
          acceptance: [
            { key: 'ok', kind: 'requester_confirm', prompt: `the ${emoji} photo is up` },
          ],
        };
        await raw(
          `update plan_revisions set plan = $3::jsonb
            where workspace_id = $1 and goal_run_id = $2 and revision = 1`,
          [workspaceId, goalRunId, JSON.stringify(stored)],
        );
        const storedPlanOf = async (revision: number) => {
          const [row] = await raw<{ plan: typeof stored & { steps: { key: string }[] } }>(
            `select plan from plan_revisions
              where workspace_id = $1 and goal_run_id = $2 and revision = $3`,
            [workspaceId, goalRunId, revision],
          );
          return row?.plan;
        };
        const revise = (basedOnRevision: number, plan: unknown) =>
          call(requester, 'revise_goal', { goalRunId, basedOnRevision, plan });

        const read = (await readProposal(requester, goalRunId)).plan;
        const [readA, readB, readZ] = read.steps;
        expect(readA?.input).toEqual({ host: 'db1', password: '[redacted]' });
        expect(JSON.stringify(readZ?.input)).toContain('\\u{200D}');
        expect(read.acceptance?.[0]).toMatchObject({
          prompt: expect.stringContaining('\\u{200D}'),
        });

        const supersededKeys = async (result: unknown) => {
          const ids = (result as { supersededStepRunIds: string[] }).supersededStepRunIds;
          const rows = await raw<{ step_key: string }>(
            'select step_key from step_runs where workspace_id = $1 and id = any($2::uuid[])',
            [workspaceId, ids],
          );
          return rows.map((row) => row.step_key).sort();
        };

        // Sent back as read, with one step added: the masked step and the step with the joined
        // emoji keep what is stored, and no step is replaced.
        const added = { key: 'c', worker, input: { step: 'c' } };
        const first = await revise(1, { ...read, steps: [...read.steps, added] });
        expect(await supersededKeys(first)).toEqual([]);
        const second = await storedPlanOf(2);
        expect(second?.steps.map((step) => step.key)).toEqual(['a', 'b', 'z', 'c']);
        expect(second?.steps[0]).toEqual(stored.steps[0]);
        expect(second?.steps[1]).toEqual(stored.steps[1]);
        expect(second?.steps[2]).toEqual(stored.steps[2]);
        expect(second?.acceptance).toEqual(stored.acceptance);

        // a's attempts changed, its input left as read: the input keeps what is stored, leaf by
        // leaf, and only a is replaced.
        const third = await revise(2, {
          ...read,
          steps: [{ ...readA, maxAttempts: 2 }, readB, readZ, added],
        });
        expect(await supersededKeys(third)).toEqual(['a']);
        expect((await storedPlanOf(3))?.steps[0]).toEqual({ ...stored.steps[0], maxAttempts: 2 });

        // One character changed beside the mark: that value is what this writer wrote, refused.
        expect(
          await refusal(
            revise(3, {
              ...read,
              steps: [
                { ...readA, maxAttempts: 2, input: { host: 'db1', password: '[redacted]!' } },
                readB,
                readZ,
                added,
              ],
            }),
          ),
        ).toMatchObject({
          status: 400,
          code: 'redacted_text_submitted',
          details: { field: 'plan.steps.0.input.password', paths: ['plan.steps.0.input.password'] },
        });

        // b's read under another key is not b: as a new step it is refused; as a it is a's own
        // read, so a gets its own original back — never b's.
        const readBAs = (key: string) => ({ ...readB, key });
        expect(
          await refusal(revise(3, { ...read, steps: [readA, readB, readZ, readBAs('d')] })),
        ).toMatchObject({
          status: 400,
          code: 'redacted_text_submitted',
          details: { field: 'plan.steps.3.input.password' },
        });
        await revise(3, { ...read, steps: [readBAs('a'), readB, readZ, added] });
        const fourth = await storedPlanOf(4);
        expect(fourth?.steps[0]).toEqual(stored.steps[0]);
        expect(fourth?.steps[1]).toEqual(stored.steps[1]);

        // A check whose prompt was changed to hold the mark is refused at its place.
        expect(
          await refusal(
            revise(4, {
              ...read,
              steps: [readA, readB, readZ, added],
              acceptance: [
                { ...read.acceptance?.[0], prompt: 'confirm with PGPASSWORD=[redacted]' },
              ],
            }),
          ),
        ).toMatchObject({
          status: 400,
          code: 'redacted_text_submitted',
          details: { field: 'plan.acceptance.0.prompt' },
        });
      });
    });

    describe("the confirmation card: what the requester's authority would stop now (hints, not refusals)", () => {
      it('a step whose Worker acts on a gate the requester cannot act on — gone once they are granted it', async () => {
        const member = await newPrincipal('member');
        const gatekeeperId = await admin(async (client) => {
          const activity = await startActivity(client, workspaceId, {
            kind: 'test.connection',
            principalId: ownerId,
          });
          const registered = await registerGatekeeper(client, workspaceId, {
            name: `go5c-gate-${randomUUID().slice(0, 8)}`,
            transportKind: 'http',
            target: 'example-system',
            endpoint: 'http://127.0.0.1:9',
            connectionSecretSalt: 'go5c-salt',
            activityId: activity.id,
            registeredBy: { id: ownerId, kind: 'human' },
          });
          return registered.gatekeeperId;
        });
        const gated = await publish({
          systemPrompt: 'You act on a gate.',
          capabilities: ['request_action'],
          gates: [gatekeeperId],
        });
        const plan = {
          steps: [
            { key: 'look', worker },
            { key: 'act', worker: gated, dependsOn: ['look'] },
          ],
        };
        const proposed = await propose(entryAgent(member), proposalOf('act on the gate', plan));
        expect(proposed.status).toBe('proposed');
        const gateHint = proposed.hints.find((hint) => hint.code === 'step_gate_not_held');
        expect(gateHint).toMatchObject({ stepKey: 'act', gatekeeperIds: [gatekeeperId] });
        expect(gateHint?.message).toMatch(/^step "act": /);
        expect(hintCodes(proposed.hints)).toEqual(['requester_confirm_only', 'step_gate_not_held']);
        expect((await readProposal(human(member, 'member'), proposed.goalRunId)).hints).toEqual(
          proposed.hints,
        );

        // Worked out on every read: the owner grants the gate, and the card no longer says it.
        await admin((client) =>
          client.query(
            `insert into capability_grants (workspace_id, principal_id, resource_type, resource_id, granted_by)
             values ($1, $2, 'gatekeeper', $3::uuid, $4)`,
            [workspaceId, member, gatekeeperId, ownerId],
          ),
        );
        expect(
          hintCodes((await readProposal(human(member, 'member'), proposed.goalRunId)).hints),
        ).toEqual(['requester_confirm_only']);
      });

      it('a step whose Worker needs a capability the requester does not hold; confirming is not refused for it', async () => {
        const member = await newPrincipal('member');
        const acting = await publish({
          systemPrompt: 'You act.',
          capabilities: ['request_action'],
        });
        const proposed = await propose(
          entryAgent(member),
          proposalOf('act without a gate', planOf(['a'], acting)),
        );
        expect(
          proposed.hints.find((hint) => hint.code === 'step_capability_not_held'),
        ).toMatchObject({ stepKey: 'a', message: expect.stringMatching(/^step "a": /) });

        // A hint, not a refusal: the requester confirms; the run would pause at the step instead.
        await call(human(member, 'member'), 'confirm_goal', {
          goalRunId: proposed.goalRunId,
          revision: 1,
        });
        expect(
          hintCodes((await readProposal(human(member, 'member'), proposed.goalRunId)).hints),
        ).toEqual(['requester_confirm_only']);
      });

      it("a step whose Worker the requester's agent profile excludes", async () => {
        const member = await newPrincipal('member');
        await admin((client) =>
          setAgentProfile(client, workspaceId, member, ownerId, {
            excludedWorkerDefinitions: [worker.definitionId],
          }),
        );
        const proposed = await propose(
          entryAgent(member),
          proposalOf('excluded', planOf(['a', 'b'])),
        );
        // Two steps on the one Worker: a hint for each, the Worker checked once.
        expect(
          proposed.hints
            .filter((hint) => hint.code === 'step_definition_excluded')
            .map((hint) => hint.stepKey),
        ).toEqual(['a', 'b']);
      });

      it('a requester who can no longer start Workers at all: one hint for the plan, as the owner reads it', async () => {
        const member = await newPrincipal('member');
        const proposed = await propose(human(member, 'member'), proposalOf('soon an auditor'));
        await raw('update principals set role = $3 where workspace_id = $1 and id = $2', [
          workspaceId,
          member,
          'auditor',
        ]);
        const hints = (await readProposal(human(ownerId, 'owner'), proposed.goalRunId)).hints;
        expect(hintCodes(hints)).toEqual([
          'requester_confirm_only',
          'requester_cannot_start_workers',
        ]);
        expect(hints[1]).not.toHaveProperty('stepKey');
      });
    });

    describe("a Handle reads only its obo's own goals", () => {
      it("an owner's entry agent: a member's run is not found on every goal read and not listed; the console shows it", async () => {
        const members = await propose(entryAgent(requesterId), proposalOf('a member’s goal'));
        const ownersAgent = entryAgent(ownerId, 'owner');
        const owners = await propose(ownersAgent, proposalOf('the owner’s own goal'));

        for (const [name, params] of [
          ['get_goal', { goalRunId: members.goalRunId }],
          ['get_goal_revision', { goalRunId: members.goalRunId, revision: 1 }],
          ['list_goal_unresolved_actions', { goalRunId: members.goalRunId }],
        ] as const) {
          expect(await refusal(call(ownersAgent, name, params))).toMatchObject({
            status: 404,
            code: 'not_found',
          });
        }
        const listed = listEnvelope(GoalRunWireSchema)
          .parse(await call(ownersAgent, 'list_goals', {}))
          .items.map((item) => item.id);
        expect(listed).toContain(owners.goalRunId);
        expect(listed).not.toContain(members.goalRunId);
        expect(
          listEnvelope(GoalRunWireSchema).parse(
            await call(ownersAgent, 'list_goals', { onBehalfOf: requesterId }),
          ).items,
        ).toEqual([]);

        // On the human channel the owner sees every run: the console's goal pages.
        expect(
          GoalDetailWireSchema.parse(
            await call(human(ownerId, 'owner'), 'get_goal', { goalRunId: members.goalRunId }),
          ).id,
        ).toBe(members.goalRunId);
      });
    });

    describe('the requester is a person', () => {
      it('a service or agent Principal is refused (403) — on its own key and on its Handle — and nothing is written', async () => {
        const before = await goalCount();
        for (const kind of ['service', 'agent'] as const) {
          const principal = await newPrincipal('member', kind);
          for (const caller of [
            humanCaller(workspaceId, principal, 'member', kind),
            handleCaller(workspaceId, principal, { capabilities: ['propose_goal'], resources: {} }),
          ]) {
            const refused = await refusal(
              dispatchCapability({ pool }, caller, 'propose_goal', proposalOf('nobody confirms')),
            );
            expect(refused).toMatchObject({ status: 403, code: 'forbidden' });
            expect(refused.message).toContain('made only for a person');
            expect(refused.message).toContain(`a ${kind} Principal`);
          }
        }
        expect(await goalCount()).toBe(before);
      });
    });

    describe('how many goals one requester may have waiting', () => {
      it('one past GOAL_MAX_PROPOSED_PER_REQUESTER is refused (409) and writes nothing; a retry is still answered; a rejected one frees a place; another requester is not counted', async () => {
        const person = await newPrincipal('member');
        const other = await newPrincipal('member');
        process.env.GOAL_MAX_PROPOSED_PER_REQUESTER = '2';
        try {
          const agent = entryAgent(person);
          const first = await propose(agent, {
            ...proposalOf('the first'),
            idempotencyKey: 'cap-first',
          });
          await propose(human(person, 'member'), proposalOf('the second, by hand'));

          const before = await goalCount();
          for (const caller of [agent, human(person, 'member')]) {
            const refused = await refusal(
              dispatchCapability({ pool }, caller, 'propose_goal', proposalOf('the third')),
            );
            expect(refused).toMatchObject({
              status: 409,
              code: 'proposed_goal_limit',
              details: { limit: 2, proposed: 2 },
            });
            expect(refused.message).toContain('confirm or reject one of them first');
          }
          expect(await goalCount()).toBe(before);

          // A retry proposes nothing, so it is answered at the cap.
          expect(
            await propose(agent, { ...proposalOf('the first'), idempotencyKey: 'cap-first' }),
          ).toMatchObject({ goalRunId: first.goalRunId, changed: false, status: 'proposed' });

          // The cap is each requester's own.
          expect(await propose(entryAgent(other), proposalOf('theirs'))).toMatchObject({
            changed: true,
          });

          // Turning one down frees its place.
          await call(human(person, 'member'), 'reject_goal', {
            goalRunId: first.goalRunId,
            revision: 1,
          });
          expect(await propose(agent, proposalOf('the third'))).toMatchObject({
            status: 'proposed',
            changed: true,
          });
        } finally {
          process.env.GOAL_MAX_PROPOSED_PER_REQUESTER = FILE_PROPOSED_CAP;
        }
      });
    });
  },
);
