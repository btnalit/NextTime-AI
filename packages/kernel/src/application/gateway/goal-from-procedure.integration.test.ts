import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type CapabilityScope,
  GoalDetailWireSchema,
  type OutputSchema,
  PlanRevisionWireSchema,
  type PrincipalKind,
  type ProcedureStep,
  ProposeGoalResultWireSchema,
  type Role,
} from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { entryScope } from '../../governance/capability/index.js';
import { mapCapabilityError } from '../../interfaces/http/capability-route.js';
import {
  deprecateProcedure,
  procedureDraftDigest,
  proposeProcedure,
  proposeWorkerDefinition,
  publishWorkerDefinition,
} from '../worker/index.js';
import { dispatchCapability } from './dispatch.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * Integration tests (real Postgres; auto-skip without DATABASE_URL) for S11 GO5d-2: a goal's plan
 * made from a published Procedure (`propose_goal`'s `fromProcedure`) — the plan it makes is
 * revision 1's, held to everything a written plan is (the credential and `[redacted]` refusal, the
 * plan's checks), and the revision records the version it came from (`get_goal_revision`,
 * `get_goal`, the audit, goal/0009); the parameters are checked against the Procedure's schema and
 * refused for a credential before anything is written; a Procedure that is not published, or that
 * cannot make a plan, is a problem of the call. Publishing a Procedure that says how a plan is made
 * checks that plan (`publish_procedure`, 400 `details.problems`); worker/0005 keeps its parameters
 * with its content. What a Procedure expands to step by step is `goal/from-procedure.test.ts`'s.
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

const SITE: OutputSchema = {
  type: 'object',
  properties: { site: { type: 'string', minLength: 1 }, value: { type: 'string' } },
  required: ['site'],
};
const HOSTS: OutputSchema = {
  type: 'object',
  properties: { hosts: { type: 'array', items: { type: 'string' } } },
};

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
  'propose_goal fromProcedure — S11 GO5d-2 (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let requesterId: string;
    let worker: { definitionId: string; version: number };
    let savedProposedCap: string | undefined;

    const admin = <T>(fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId, principalId: ownerId }, fn, { skipRoleSwitch: true });

    /** A write with the guards off — fixtures the write paths do not reach. */
    const raw = <T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) =>
      admin(async (client) => {
        await client.query('set local session_replication_role = replica');
        return (await client.query(sql, [...params])).rows as T[];
      });

    const as = <T>(principalId: string, fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId, principalId }, fn);

    const parkGoal = (goalRunId: string) =>
      raw('update goal_runs set next_tick_at = null where workspace_id = $1 and id = $2', [
        workspaceId,
        goalRunId,
      ]);

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
    const owner = () => human(ownerId, 'owner');
    const entryAgent = (obo: string, role: Role = 'member') =>
      handleCaller(workspaceId, obo, entryScope({}, { role }));

    const workerStep = (fields: Record<string, unknown> = {}): ProcedureStep =>
      ({ kind: 'worker', ...worker, ...fields }) as ProcedureStep;

    /** A draft Procedure the owner proposed — the next version of `procedureId` when given. */
    async function draftProcedure(
      steps: readonly ProcedureStep[],
      parameters?: OutputSchema,
      procedureId?: string,
    ): Promise<{ procedureId: string; version: number; name: string; draftDigest: string }> {
      const name = `renew-${randomUUID().slice(0, 8)}`;
      const row = await as(ownerId, (client) =>
        proposeProcedure(client, workspaceId, ownerId, {
          ...(procedureId !== undefined ? { procedureId } : {}),
          name,
          description: 'Renew the certificates of a site.',
          steps,
          ...(parameters !== undefined ? { parameters } : {}),
        }),
      );
      return {
        procedureId: row.id,
        version: row.version,
        name,
        draftDigest: procedureDraftDigest(row),
      };
    }

    /** Published through `publish_procedure`, as the console does — the template's checks run. */
    async function publishedProcedure(
      steps: readonly ProcedureStep[],
      parameters?: OutputSchema,
      procedureId?: string,
    ) {
      const draft = await draftProcedure(steps, parameters, procedureId);
      await call(owner(), 'publish_procedure', {
        procedureId: draft.procedureId,
        version: draft.version,
        draftDigest: draft.draftDigest,
        credentialsReviewed: true,
      });
      return draft;
    }

    const proposalFrom = (
      fromProcedure: Record<string, unknown>,
      statement = 'renew the site',
    ) => ({
      statement,
      fromProcedure,
      budget: BUDGET,
    });

    const goalCount = async () => {
      const [row] = await raw<{ count: number }>(
        'select count(*)::int as count from goal_runs where workspace_id = $1',
        [workspaceId],
      );
      return row?.count ?? 0;
    };

    /** The problems a refused `propose_goal` names (400 `invalid_params`). */
    async function problemsOf(params: Record<string, unknown>): Promise<string[]> {
      const mapped = await refusal(
        dispatchCapability({ pool }, entryAgent(requesterId), 'propose_goal', params),
      );
      expect(mapped).toMatchObject({ status: 400, code: 'invalid_params' });
      return (mapped.details as { problems: string[] }).problems;
    }

    beforeAll(async () => {
      savedProposedCap = process.env.GOAL_MAX_PROPOSED_PER_REQUESTER;
      process.env.GOAL_MAX_PROPOSED_PER_REQUESTER = '1000';
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = randomUUID();
      ownerId = randomUUID();
      requesterId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'go5d2-from-procedure',
          ]);
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name)
             values ($1, $2, 'human', 'owner', 'owner'), ($1, $3, 'human', 'member', 'member')`,
            [workspaceId, ownerId, requesterId],
          );
        },
        { skipRoleSwitch: true },
      );
      const proposed = await as(ownerId, (client) =>
        proposeWorkerDefinition(client, workspaceId, ownerId, {
          kind: 'worker',
          definition: { systemPrompt: 'You do one step of a goal.' },
        }),
      );
      await as(ownerId, (client) =>
        publishWorkerDefinition(client, workspaceId, ownerId, {
          definitionId: proposed.id,
          version: proposed.version,
        }),
      );
      worker = { definitionId: proposed.id, version: proposed.version };
    });

    afterAll(async () => {
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

    describe('a plan made from a Procedure', () => {
      it('is revision 1’s, concrete, and says which version it was made from — on the card, the goal and the audit', async () => {
        const procedure = await publishedProcedure(
          [
            workerStep({
              key: 'fetch',
              input: { mode: 'safe' },
              outputSchema: HOSTS,
              bindings: [{ to: 'target.site', from: '$params', path: 'site' }],
            }),
            { kind: 'verify', description: 'Every host answers on 443.' },
            workerStep({ key: 'apply', bindings: [{ to: 'hosts', from: 'fetch', path: 'hosts' }] }),
          ],
          SITE,
        );
        const agent = entryAgent(requesterId);
        const proposed = await propose(
          agent,
          proposalFrom({ procedureId: procedure.procedureId, parameters: { site: 'main' } }),
        );
        expect(proposed).toMatchObject({ status: 'proposed', changed: true });

        const card = PlanRevisionWireSchema.parse(
          await call(agent, 'get_goal_revision', { goalRunId: proposed.goalRunId, revision: 1 }),
        );
        expect(card.plan).toEqual({
          steps: [
            {
              key: 'fetch',
              worker,
              input: { mode: 'safe', target: { site: 'main' } },
              outputSchema: HOSTS,
            },
            {
              key: 'apply',
              worker,
              dependsOn: ['fetch'],
              bindings: [{ to: 'hosts', from: 'fetch', path: 'hosts' }],
            },
          ],
          acceptance: [
            { kind: 'requester_confirm', key: 'verify', prompt: 'Every host answers on 443.' },
          ],
        });
        // Legacy 454: the start parameters it was proposed with, and which check its verify step
        // (Procedure step 2, no check of its own) became.
        const source = {
          procedureId: procedure.procedureId,
          version: 1,
          name: procedure.name,
          parameters: { site: 'main' },
          confirmCheck: { key: 'verify', procedureSteps: [2] },
        };
        expect(card.fromProcedure).toEqual(source);

        const detail = GoalDetailWireSchema.parse(
          await call(agent, 'get_goal', { goalRunId: proposed.goalRunId }),
        );
        expect(detail.planRevision.fromProcedure).toEqual(source);
        expect(detail.revisions.map((revision) => revision.fromProcedure)).toEqual([source]);

        const [stored] = await raw<{
          id: string | null;
          version: number | null;
          parameters: unknown;
        }>(
          `select source_procedure_id as id, source_procedure_version as version,
                  source_procedure_parameters as parameters
             from plan_revisions
            where workspace_id = $1 and goal_run_id = $2 and revision = 1`,
          [workspaceId, proposed.goalRunId],
        );
        expect(stored).toEqual({
          id: procedure.procedureId,
          version: 1,
          parameters: { site: 'main' },
        });
        const [audit] = await raw<{ payload: Record<string, unknown> }>(
          `select payload from audit_records
            where workspace_id = $1 and resource_type = 'goal_run' and resource_id = $2
              and action = 'goal_run.propose'`,
          [workspaceId, proposed.goalRunId],
        );
        expect(audit?.payload).toMatchObject({
          fromProcedure: { procedureId: procedure.procedureId, version: 1 },
        });
        // Which version only: the values are on the revision, read masked, not in the audit.
        expect(
          (audit?.payload.fromProcedure as Record<string, unknown> | undefined)?.parameters,
        ).toBeUndefined();

        // A plan written out says it came from nothing.
        const written = await propose(agent, {
          statement: 'by hand',
          plan: { steps: [{ key: 'only', worker }] },
          budget: BUDGET,
        });
        const writtenCard = PlanRevisionWireSchema.parse(
          await call(agent, 'get_goal_revision', { goalRunId: written.goalRunId, revision: 1 }),
        );
        expect(writtenCard.fromProcedure).toBeNull();
      });

      it('takes the latest published version unless the call names one; a retry from the same session is the same run', async () => {
        const first = await publishedProcedure([workerStep({ input: { round: 1 } })]);
        await publishedProcedure(
          [workerStep({ input: { round: 2 } })],
          undefined,
          first.procedureId,
        );
        const agent = entryAgent(requesterId);
        const readPlan = async (goalRunId: string) =>
          PlanRevisionWireSchema.parse(
            await call(agent, 'get_goal_revision', { goalRunId, revision: 1 }),
          );

        const latest = await propose(agent, proposalFrom({ procedureId: first.procedureId }));
        const latestCard = await readPlan(latest.goalRunId);
        expect(latestCard.fromProcedure?.version).toBe(2);
        // Legacy 454: no parameters given, no verify step without a check.
        expect(latestCard.fromProcedure).toMatchObject({ parameters: null, confirmCheck: null });
        expect(latestCard.plan.steps[0]?.input).toEqual({ round: 2 });

        const named = await propose(
          agent,
          proposalFrom({ procedureId: first.procedureId, version: 1 }),
        );
        expect(named.goalRunId).not.toBe(latest.goalRunId);
        expect((await readPlan(named.goalRunId)).fromProcedure?.version).toBe(1);

        // R-54: the same fromProcedure from the same session is the run it proposed.
        expect(
          await propose(agent, proposalFrom({ procedureId: first.procedureId, version: 1 })),
        ).toEqual({ ...named, changed: false });
      });

      it('after a revision, the plan in force is the requester’s own; revision 1 still says where it came from', async () => {
        const procedure = await publishedProcedure([workerStep({ key: 'one' })]);
        const requester = human(requesterId, 'member');
        const { goalRunId } = await propose(
          requester,
          proposalFrom({ procedureId: procedure.procedureId }),
        );
        await call(requester, 'confirm_goal', { goalRunId, revision: 1 });
        await call(requester, 'pause_goal', { goalRunId });
        await call(requester, 'revise_goal', {
          goalRunId,
          basedOnRevision: 1,
          plan: {
            steps: [
              { key: 'one', worker },
              { key: 'two', worker, dependsOn: ['one'] },
            ],
          },
        });
        const detail = GoalDetailWireSchema.parse(await call(requester, 'get_goal', { goalRunId }));
        expect(detail.planRevision.revision).toBe(2);
        expect(detail.planRevision.fromProcedure).toBeNull();
        expect(
          detail.revisions.map((revision) => [revision.revision, revision.fromProcedure?.version]),
        ).toEqual(
          expect.arrayContaining([
            [1, 1],
            [2, undefined],
          ]),
        );
        // goal/0009: only revision 1 may name a Procedure.
        await expect(
          raw(
            `update plan_revisions set source_procedure_id = $3, source_procedure_version = 1
              where workspace_id = $1 and goal_run_id = $2 and revision = 2`,
            [workspaceId, goalRunId, procedure.procedureId],
          ),
        ).rejects.toThrow(/plan_revisions_source_procedure_first/);
      });
    });

    describe('what the call carries is refused before anything is written', () => {
      it('parameters the schema refuses, a credential or a [redacted] mark in them, or one bound under a secret-named field (400, the place named)', async () => {
        const procedure = await publishedProcedure(
          [
            workerStep({
              bindings: [
                { to: 'site', from: '$params', path: 'site' },
                { to: 'password', from: '$params', path: 'value' },
              ],
            }),
          ],
          SITE,
        );
        const before = await goalCount();
        const from = (parameters: Record<string, unknown>) =>
          proposalFrom({ procedureId: procedure.procedureId, parameters });

        expect(await problemsOf(from({ value: 'x' }))).toEqual([
          'fromProcedure.parameters.site: required, missing',
        ]);
        expect(await problemsOf(from({ site: '' }))).toEqual([
          'fromProcedure.parameters.site: shorter than 1 characters',
        ]);

        const agent = entryAgent(requesterId);
        const credential = await refusal(
          dispatchCapability(
            { pool },
            agent,
            'propose_goal',
            from({ site: 'main', auth: { token: FAKE } }),
          ),
        );
        expect(credential).toMatchObject({
          status: 400,
          code: 'credentials_in_text',
          details: {
            field: 'fromProcedure.parameters.auth.token',
            suspectedSecretPaths: ['fromProcedure.parameters.auth.token'],
          },
        });
        expect(credential.message).not.toContain(FAKE);
        expect(
          await refusal(
            dispatchCapability({ pool }, agent, 'propose_goal', from({ site: '[redacted]' })),
          ),
        ).toMatchObject({
          status: 400,
          code: 'redacted_text_submitted',
          details: { field: 'fromProcedure.parameters.site' },
        });

        // A value innocent where it was given is a credential where the plan puts it.
        const bound = await refusal(
          dispatchCapability({ pool }, agent, 'propose_goal', from({ site: 'main', value: FAKE })),
        );
        expect(bound).toMatchObject({
          status: 400,
          code: 'credentials_in_text',
          details: {
            field: 'plan.steps.0.input.password',
            suspectedSecretPaths: ['plan.steps.0.input.password'],
          },
        });
        expect(bound.message).not.toContain(FAKE);

        // Exactly one of plan and fromProcedure.
        for (const params of [
          { statement: 'neither', budget: BUDGET },
          {
            ...from({ site: 'main' }),
            plan: { steps: [{ key: 'only', worker }] },
          },
        ]) {
          expect(
            await refusal(dispatchCapability({ pool }, agent, 'propose_goal', params)),
          ).toMatchObject({ status: 400, code: 'invalid_params' });
        }
        expect(await goalCount()).toBe(before);
      });
    });

    describe('a Procedure that makes no plan is a problem of the call (400 invalid_params)', () => {
      it('unknown, a draft, deprecated, a version not published', async () => {
        const draft = await draftProcedure([workerStep()]);
        const deprecated = await publishedProcedure([workerStep()]);
        await as(ownerId, (client) =>
          deprecateProcedure(client, workspaceId, deprecated.procedureId),
        );
        const published = await publishedProcedure([workerStep()]);
        const before = await goalCount();
        for (const fromProcedure of [
          { procedureId: randomUUID() },
          { procedureId: draft.procedureId },
          { procedureId: deprecated.procedureId },
          { procedureId: published.procedureId, version: 2 },
        ]) {
          const [problem] = await problemsOf(proposalFrom(fromProcedure));
          expect(problem).toMatch(
            new RegExp(`^fromProcedure: no published Procedure ${fromProcedure.procedureId}`),
          );
        }
        expect(await goalCount()).toBe(before);
      });

      it('an approval or operation step, which it keeps for following by hand', async () => {
        const procedure = await publishedProcedure([
          workerStep({ key: 'prepare' }),
          { kind: 'approval', description: 'The site owner agrees.' },
        ]);
        expect(await problemsOf(proposalFrom({ procedureId: procedure.procedureId }))).toEqual([
          expect.stringMatching(/^Procedure step 2 is an approval step — /),
        ]);
      });

      it('a plan made from it is checked as a written one: a check on a gate that is not there, a credential in what the requester confirms', async () => {
        const gate = randomUUID();
        const unchecked = await publishedProcedure([
          workerStep(),
          {
            kind: 'verify',
            description: 'The certificate is valid.',
            check: {
              kind: 'observe_predicate',
              key: 'valid',
              check: {
                gatekeeperId: gate,
                operation: 'cert.status',
                params: {},
                expect: { path: 'state', op: 'eq', value: 'valid' },
              },
            },
          },
        ]);
        // What a written plan with that check is told.
        expect(await problemsOf(proposalFrom({ procedureId: unchecked.procedureId }))).toEqual([
          'acceptance[0] "valid": check: "cert.status" cannot be observed (gate_not_enabled)',
        ]);

        // No template field: published without the template's checks — the plan it makes is
        // refused when it is made.
        const confirmed = await publishedProcedure([
          workerStep(),
          { kind: 'verify', description: `Bearer ${FAKE} still works.` },
        ]);
        const refused = await refusal(
          dispatchCapability(
            { pool },
            entryAgent(requesterId),
            'propose_goal',
            proposalFrom({ procedureId: confirmed.procedureId }),
          ),
        );
        expect(refused).toMatchObject({
          status: 400,
          code: 'credentials_in_text',
          details: { field: 'plan.acceptance.0.prompt' },
        });
        expect(refused.message).not.toContain(FAKE);
      });
    });

    describe('publishing a Procedure that says how a plan is made checks that plan', () => {
      const publishRefusal = async (steps: readonly ProcedureStep[], parameters?: OutputSchema) => {
        const draft = await draftProcedure(steps, parameters);
        const refused = await refusal(
          dispatchCapability({ pool }, owner(), 'publish_procedure', {
            procedureId: draft.procedureId,
            version: draft.version,
            draftDigest: draft.draftDigest,
            credentialsReviewed: true,
          }),
        );
        const [row] = await raw<{ status: string }>(
          'select status from procedures where workspace_id = $1 and id = $2',
          [workspaceId, draft.procedureId],
        );
        expect(row?.status).toBe('draft');
        return refused;
      };

      it('refused (400 invalid_params, details.problems), the draft left as it was', async () => {
        expect(
          await publishRefusal([
            workerStep({ bindings: [{ to: 'site', from: '$params', path: 'site' }] }),
          ]),
        ).toMatchObject({
          status: 400,
          code: 'invalid_params',
          details: {
            problems: [
              'step "step-1": bindings[0]: takes from $params, but the Procedure declares no parameters',
            ],
          },
        });
        expect(
          await publishRefusal([
            workerStep({ key: 'fetch' }),
            workerStep({ bindings: [{ to: 'hosts', from: 'fetch', path: 'hosts' }] }),
          ]),
        ).toMatchObject({
          status: 400,
          code: 'invalid_params',
          details: { problems: [expect.stringMatching(/^the plan it makes: step "step-2"/)] },
        });
        // Reviewed or not, a credential never goes into a plan.
        const credential = await publishRefusal([workerStep({ input: { password: FAKE } })]);
        expect(credential).toMatchObject({
          status: 400,
          code: 'invalid_params',
          details: { problems: [expect.stringContaining('plan.steps.0.input.password')] },
        });
        expect(credential.message).not.toContain(FAKE);
      });

      it('one with an approval step is published, and list_procedures shows its parameters', async () => {
        const procedure = await publishedProcedure(
          [
            workerStep({ bindings: [{ to: 'site', from: '$params', path: 'site' }] }),
            { kind: 'approval', description: 'The site owner agrees.' },
          ],
          SITE,
        );
        const reader = handleCaller(workspaceId, requesterId, {
          capabilities: ['list_procedures'],
          resources: {},
        });
        const page = (await call(reader, 'list_procedures', {})) as {
          items: { id: string; status: string; parameters: unknown }[];
        };
        expect(page.items.find((item) => item.id === procedure.procedureId)).toMatchObject({
          status: 'published',
          parameters: SITE,
        });
        const plain = await publishedProcedure([workerStep()]);
        expect(
          ((await call(reader, 'list_procedures', {})) as typeof page).items.find(
            (item) => item.id === plain.procedureId,
          )?.parameters,
        ).toBeNull();
      });
    });

    describe('the schema holds it (worker/0005, goal/0009)', () => {
      it('a published version’s parameters never change; parameters are an object; a revision’s source never changes', async () => {
        const procedure = await publishedProcedure(
          [workerStep({ bindings: [{ to: 'site', from: '$params', path: 'site' }] })],
          SITE,
        );
        await expect(
          admin((client) =>
            client.query(
              `update procedures set parameters = '{"type":"object"}'::jsonb
                where workspace_id = $1 and id = $2`,
              [workspaceId, procedure.procedureId],
            ),
          ),
        ).rejects.toThrow(/immutable once published/);
        const draft = await draftProcedure([workerStep()]);
        await expect(
          admin((client) =>
            client.query(
              `update procedures set parameters = '[]'::jsonb where workspace_id = $1 and id = $2`,
              [workspaceId, draft.procedureId],
            ),
          ),
        ).rejects.toThrow(/procedures_parameters_object/);

        const { goalRunId } = await propose(
          entryAgent(requesterId),
          proposalFrom({ procedureId: procedure.procedureId, parameters: { site: 'main' } }),
        );
        await expect(
          admin((client) =>
            client.query(
              `update plan_revisions set source_procedure_version = null
                where workspace_id = $1 and goal_run_id = $2`,
              [workspaceId, goalRunId],
            ),
          ),
        ).rejects.toThrow(/content never changes/);
        await expect(
          raw(
            `update plan_revisions set source_procedure_version = null
              where workspace_id = $1 and goal_run_id = $2`,
            [workspaceId, goalRunId],
          ),
        ).rejects.toThrow(/plan_revisions_source_procedure_pair/);
        // Legacy 454 (goal/0010): the start parameters never change either, are an object, and
        // only sit beside a source.
        await expect(
          admin((client) =>
            client.query(
              `update plan_revisions set source_procedure_parameters = '{"site":"other"}'::jsonb
                where workspace_id = $1 and goal_run_id = $2`,
              [workspaceId, goalRunId],
            ),
          ),
        ).rejects.toThrow(/content never changes/);
        await expect(
          raw(
            `update plan_revisions set source_procedure_parameters = '[]'::jsonb
              where workspace_id = $1 and goal_run_id = $2`,
            [workspaceId, goalRunId],
          ),
        ).rejects.toThrow(/plan_revisions_source_procedure_parameters/);
        const written = await propose(entryAgent(requesterId), {
          statement: 'by hand',
          plan: { steps: [{ key: 'only', worker }] },
          budget: BUDGET,
        });
        await expect(
          raw(
            `update plan_revisions set source_procedure_parameters = '{}'::jsonb
              where workspace_id = $1 and goal_run_id = $2`,
            [workspaceId, written.goalRunId],
          ),
        ).rejects.toThrow(/plan_revisions_source_procedure_parameters/);
        // Whatever is stored reads masked, like the step inputs the values went into.
        await raw(
          `update plan_revisions set source_procedure_parameters = $3::jsonb
            where workspace_id = $1 and goal_run_id = $2`,
          [
            workspaceId,
            goalRunId,
            JSON.stringify({ site: 'main', auth: { token: FAKE }, hidden: 'a\u200bb' }),
          ],
        );
        const masked = PlanRevisionWireSchema.parse(
          await call(entryAgent(requesterId), 'get_goal_revision', { goalRunId, revision: 1 }),
        ).fromProcedure?.parameters;
        expect(masked?.site).toBe('main');
        expect(JSON.stringify(masked)).not.toContain(FAKE);
        expect(masked?.auth).toEqual({ token: '[redacted]' });
        expect(masked?.hidden).not.toContain('\u200b');
        expect(masked?.hidden).toMatch(/^a\\u\{200b\}b$/i);
        const [fk] = await raw<{ target: string; columns: string }>(
          `select confrelid::regclass::text as target, pg_get_constraintdef(oid) as columns
             from pg_constraint where conname = 'plan_revisions_source_procedure_fk'`,
        );
        expect(fk).toEqual({
          target: 'procedures',
          columns: expect.stringContaining(
            'FOREIGN KEY (workspace_id, source_procedure_id, source_procedure_version) REFERENCES procedures(workspace_id, id, version)',
          ),
        });
      });
    });
  },
);
