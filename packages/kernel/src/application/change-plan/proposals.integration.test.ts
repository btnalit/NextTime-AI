import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHANGE_PLAN_DAILY_LIMIT,
  CHANGE_PLAN_SEGMENT_EDGES,
  CHANGE_PLAN_SEGMENT_STATUS_VALUES,
  type ChangePlanSummaryWire,
  type ChangePlanWire,
  type ListEnvelope,
  SECRET_FIELD_MASK,
  changePlanStatusOf,
} from '@nexttime/shared';
import { generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADVISORY_LOCK_NAMESPACES } from '../../adapters/db/advisory-lock-namespaces.js';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { HANDLE_SIGNING_ALG } from '../../governance/capability/index.js';
import { mapCapabilityError } from '../../interfaces/http/capability-route.js';
import { mapCapabilityErrorToToolResult } from '../../interfaces/mcp/server-factory.js';
import { mapDispatchError } from '../../interfaces/ws/rpc.js';
import { issueAdminAgentHandle } from '../admin-agent/index.js';
import { withAdminClient } from '../gateway/auth.js';
import { changePlanReaderOf } from '../gateway/change-plan-proposal-handlers.js';
import { dispatchCapability } from '../gateway/dispatch.js';
import { authenticateHandle } from '../gateway/handle-auth.js';
import type { ResolvedCaller } from '../gateway/resolve-caller.js';
import { type UserRow, createUser } from '../identity/index.js';
import { purgeWorkspace } from '../platform/purge-workspace.js';
import { createWorkspaceWithOwner } from '../workspace/index.js';
import {
  ChangePlanCredentialError,
  ChangePlanNotFoundError,
  ChangePlanNotOpenError,
  ChangePlanProposalInvalidError,
  ChangePlanQuotaExceededError,
  ChangePlanTargetUnavailableError,
} from './index.js';

/**
 * application/change-plan/proposals integration (S11 AA3b-1; real Postgres, auto-skip without
 * DATABASE_URL): what an admin agent proposes from its trial workspace, through its Handle — and
 * migrations/governance/0032's guards, policies and quota helper under the application role.
 *
 *  - F10 (coordinator, 2026-11-02): an unknown, a disabled and a trial target are refused with the
 *    same code, the same text and the same details, over HTTP, WebSocket and MCP alike.
 *  - F9: a credential is refused with where it is, never the value.
 *  - F11: twenty plans a day per administrator, counted across trial workspaces; proposals at the
 *    limit wait on the administrator's lock, and only one of them passes.
 *  - F12: the agent reads only its own administrator's plans; a target workspace reads only the
 *    segment addressed to it.
 *  - The lifecycle (`CHANGE_PLAN_SEGMENT_EDGES`) is the database's, edge for edge, and each edge is
 *    decided where it may be.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const ONTOLOGY_DIR = path.join(KERNEL_ROOT, '..', '..', 'ontology');

/** Not a real credential: the shapes the high-confidence patterns know, with a filler value. */
const FAKE = 'abcdefghijklmnopqrstuvwxyz0123';

function skillItem(name: string, markdown = '# Steps\n\n1. Look at the disk.') {
  return {
    kind: 'skill_version' as const,
    skill: { name, description: `Triage ${name}.`, markdown },
  };
}

function workerItem(definition: Record<string, unknown>) {
  return { kind: 'worker_definition_version' as const, definition };
}

async function thrownBy(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected the call to be refused');
    },
    (err: unknown) => err,
  );
}

describe.runIf(DATABASE_URL !== undefined)(
  'S11 AA3b-1 ChangePlan proposals (integration, real Postgres)',
  () => {
    let pool: Pool;
    let privateKey: CryptoKey;
    let publicKey: CryptoKey;
    let tag: string;
    /** The administrator whose agent proposes; owner of `trialId`. */
    let admin: UserRow;
    let trialId: string;
    let adminPrincipalId: string;
    /** A second administrator, a member of the same trial workspace (F12). */
    let otherAdmin: UserRow;
    let otherAdminPrincipalId: string;
    /** Two standard workspaces a plan may address, each with an owner of its own. */
    let targetA: { workspaceId: string; ownerPrincipalId: string };
    let targetB: { workspaceId: string; ownerPrincipalId: string };
    let disabledId: string;
    /** Another trial workspace of `admin`'s. */
    let otherTrialId: string;
    let previousSwitch: string | undefined;

    async function agent(workspaceId: string, principalId: string): Promise<ResolvedCaller> {
      const issued = await withWorkspace(pool, { workspaceId, principalId }, (client) =>
        issueAdminAgentHandle(client, { workspaceId, principalId, ttlSeconds: 600, privateKey }),
      );
      const claims = await authenticateHandle(pool, issued.token, { publicKey }, 'source');
      return { channel: 'handle', claims };
    }

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

    async function newWorkspace(
      owner: UserRow,
      purpose: 'standard' | 'admin_trial',
    ): Promise<{ workspaceId: string; ownerPrincipalId: string }> {
      return createWorkspaceWithOwner(pool, {
        name: `aa3b-${purpose}-${randomUUID().slice(0, 8)}`,
        owner: { userId: owner.id, displayName: owner.displayName },
        ontologyDir: ONTOLOGY_DIR,
        purpose,
      });
    }

    function propose(caller: ResolvedCaller, params: Record<string, unknown>) {
      return dispatchCapability(
        { pool },
        caller,
        'propose_change_plan',
        params,
      ) as Promise<ChangePlanWire>;
    }

    function planParams(
      segments: readonly Record<string, unknown>[],
      extra: Record<string, unknown> = {},
    ): Record<string, unknown> {
      return {
        title: 'Disk triage everywhere',
        description: 'The Skill the trial workspace settled on.',
        sourceName: `aa3b-${tag}`,
        segments,
        ...extra,
      };
    }

    async function planCount(): Promise<number> {
      const result = await withAdminClient(pool, (client) =>
        client.query<{ n: number }>(
          'select count(*)::int as n from change_plans where proposed_by_user = $1',
          [admin.id],
        ),
      );
      return result.rows[0]?.n ?? 0;
    }

    async function lastAudit(
      workspaceId: string | null,
      action: string,
    ): Promise<Record<string, unknown> | undefined> {
      const result = await withAdminClient(pool, (client) =>
        client.query<{
          payload: Record<string, unknown>;
          resource_type: string | null;
          resource_id: string | null;
          actor_user_id: string | null;
        }>(
          `select payload, resource_type, resource_id, actor_user_id from audit_records
            where workspace_id is not distinct from $1 and action = $2
            order by created_at desc, id desc limit 1`,
          [workspaceId, action],
        ),
      );
      const row = result.rows[0];
      return row
        ? {
            ...row.payload,
            resourceType: row.resource_type,
            resourceId: row.resource_id,
            actorUserId: row.actor_user_id,
          }
        : undefined;
    }

    /** A statement in `workspaceId`'s transaction as the application role, rolled back. */
    async function inWorkspace<T>(
      workspaceId: string,
      principalId: string,
      run: (client: PoolClient) => Promise<T>,
    ): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId }, run);
    }

    beforeAll(async () => {
      previousSwitch = process.env.ADMIN_AGENT_ENABLED;
      process.env.ADMIN_AGENT_ENABLED = '1';
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      const pair = await generateKeyPair(HANDLE_SIGNING_ALG, { crv: 'Ed25519' });
      privateKey = pair.privateKey;
      publicKey = pair.publicKey;
      tag = randomUUID().slice(0, 8);
      admin = await createUser(pool, {
        login: `aa3b-admin-${tag}`,
        displayName: 'AA3b Admin',
        platformRole: 'admin',
      });
      otherAdmin = await createUser(pool, {
        login: `aa3b-other-${tag}`,
        displayName: 'AA3b Other Admin',
        platformRole: 'admin',
      });
      const ownerA = await createUser(pool, { login: `aa3b-a-${tag}`, displayName: 'Owner A' });
      const ownerB = await createUser(pool, { login: `aa3b-b-${tag}`, displayName: 'Owner B' });
      const trial = await newWorkspace(admin, 'admin_trial');
      trialId = trial.workspaceId;
      adminPrincipalId = trial.ownerPrincipalId;
      otherAdminPrincipalId = randomUUID();
      await withAdminClient(pool, (client) =>
        client.query(
          `insert into principals (workspace_id, id, kind, role, display_name, user_id)
           values ($1, $2, 'human', 'owner', 'AA3b Other Admin', $3)`,
          [trialId, otherAdminPrincipalId, otherAdmin.id],
        ),
      );
      targetA = await newWorkspace(ownerA, 'standard');
      targetB = await newWorkspace(ownerB, 'standard');
      disabledId = (await newWorkspace(ownerA, 'standard')).workspaceId;
      await withAdminClient(pool, (client) =>
        client.query(`update workspaces set status = 'disabled' where id = $1`, [disabledId]),
      );
      otherTrialId = (await newWorkspace(admin, 'admin_trial')).workspaceId;
    });

    afterAll(async () => {
      if (previousSwitch === undefined) Reflect.deleteProperty(process.env, 'ADMIN_AGENT_ENABLED');
      else process.env.ADMIN_AGENT_ENABLED = previousSwitch;
      await pool?.end();
    });

    it('the database allows exactly the lifecycle edges CHANGE_PLAN_SEGMENT_EDGES lists', async () => {
      const edges = new Set(CHANGE_PLAN_SEGMENT_EDGES.map((edge) => `${edge.from}>${edge.to}`));
      await withAdminClient(pool, async (client) => {
        for (const from of CHANGE_PLAN_SEGMENT_STATUS_VALUES) {
          for (const to of CHANGE_PLAN_SEGMENT_STATUS_VALUES) {
            const result = await client.query<{ allowed: boolean }>(
              'select change_plan_segment_transition_allowed($1, $2) as allowed',
              [from, to],
            );
            expect(result.rows[0]?.allowed, `${from} -> ${to}`).toBe(edges.has(`${from}>${to}`));
          }
        }
      });
    });

    it('proposes a plan through the Handle: one segment per target, origin agent, nothing changed there', async () => {
      const caller = await agent(trialId, adminPrincipalId);
      const before = await planCount();
      const plan = await propose(
        caller,
        planParams([
          {
            targetWorkspaceId: targetA.workspaceId,
            items: [
              skillItem('disk-triage'),
              workerItem({ name: 'disk-worker', systemPrompt: 'You triage disks.' }),
              {
                kind: 'operation_version',
                gateId: 'ssh-lab',
                name: 'df',
                set: { auto_approvable: false },
              },
            ],
          },
          { targetWorkspaceId: targetB.workspaceId, items: [skillItem('disk-triage')] },
        ]),
      );
      expect(await planCount()).toBe(before + 1);
      expect(plan).toMatchObject({
        title: 'Disk triage everywhere',
        sourceName: `aa3b-${tag}`,
        origin: 'agent',
        proposedBy: { userId: admin.id, displayName: 'AA3b Admin' },
        status: 'proposed',
        segmentCounts: { proposed: 2, applied: 0, rejected: 0, withdrawn: 0, rolledBack: 0 },
      });
      expect(plan.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(plan.segments.map((s) => [s.ordinal, s.targetWorkspaceId, s.status])).toEqual([
        [1, targetA.workspaceId, 'proposed'],
        [2, targetB.workspaceId, 'proposed'],
      ]);
      expect(plan.segments[0]?.items).toHaveLength(3);
      expect(plan.segments[0]?.contentDigest).not.toBe(plan.segments[1]?.contentDigest);
      // Proposing changes no workspace: the target has no Skill of that name.
      const skills = await inWorkspace(targetA.workspaceId, targetA.ownerPrincipalId, (client) =>
        client.query('select 1 from skills where workspace_id = $1 and name = $2', [
          targetA.workspaceId,
          'disk-triage',
        ]),
      );
      expect(skills.rows).toHaveLength(0);
      // The trial workspace's audit row: the agent did it, about this plan.
      expect(await lastAudit(trialId, 'propose_change_plan')).toMatchObject({
        sessionKind: 'admin_agent',
        resourceType: 'change_plan',
        resourceId: plan.id,
        contentDigest: plan.contentDigest,
        segments: [
          { ordinal: 1, targetWorkspaceId: targetA.workspaceId, items: 3 },
          { ordinal: 2, targetWorkspaceId: targetB.workspaceId, items: 1 },
        ],
      });
    });

    it('F10: an unknown, a disabled and a trial target are refused alike — one code, one text, one shape on every channel — and nothing is written', async () => {
      const caller = await agent(trialId, adminPrincipalId);
      const before = await planCount();
      const refusals = [];
      const targets = [randomUUID(), disabledId, otherTrialId, trialId];
      for (const target of targets) {
        refusals.push(
          await thrownBy(
            propose(
              caller,
              planParams([
                { targetWorkspaceId: targetA.workspaceId, items: [skillItem('disk-triage')] },
                { targetWorkspaceId: target, items: [skillItem('disk-triage')] },
              ]),
            ),
          ),
        );
      }
      expect(await planCount()).toBe(before);
      const [first, ...rest] = refusals;
      expect(first).toBeInstanceOf(ChangePlanTargetUnavailableError);
      const shape = (err: unknown) => ({
        http: mapCapabilityError(err),
        ws: mapDispatchError(err),
        mcp: mapCapabilityErrorToToolResult(err),
      });
      expect(shape(first).http).toEqual({
        status: 400,
        code: 'change_plan_target_unavailable',
        message: (first as Error).message,
        details: { segment: 1 },
      });
      for (const other of rest) expect(shape(other)).toEqual(shape(first));
      // The text names none of the workspaces.
      for (const target of targets) expect((first as Error).message).not.toContain(target);
    });

    it('F9: a credential is refused with where it is, never the value; a [redacted] mark too', async () => {
      const caller = await agent(trialId, adminPrincipalId);
      const before = await planCount();
      const secret = `postgres://ops:${FAKE}@db.example.invalid/app`;
      const err = await thrownBy(
        propose(
          caller,
          planParams([
            {
              targetWorkspaceId: targetA.workspaceId,
              items: [skillItem('disk-triage', `# Steps\n\nConnect to ${secret} and look.`)],
            },
          ]),
        ),
      );
      expect(err).toBeInstanceOf(ChangePlanCredentialError);
      const mapped = mapCapabilityError(err);
      expect(mapped).toMatchObject({
        status: 400,
        code: 'change_plan_credential',
        details: {
          suspectedSecretValues: 1,
          suspectedSecretPaths: ['segments[0].items[0].skill.markdown'],
        },
      });
      expect(JSON.stringify(mapped)).not.toContain(FAKE);
      expect(mapCapabilityErrorToToolResult(err).content).toEqual([
        { type: 'text', text: expect.stringMatching(/^change_plan_credential: /) },
      ]);

      const masked = await thrownBy(
        propose(
          caller,
          planParams([
            {
              targetWorkspaceId: targetA.workspaceId,
              items: [skillItem('disk-triage', `# Steps\n\nUse ${SECRET_FIELD_MASK} here.`)],
            },
          ]),
        ),
      );
      expect(mapCapabilityError(masked)).toMatchObject({
        status: 400,
        code: 'redacted_text_submitted',
        details: {
          field: 'plan.segments[0].items[0].skill.markdown',
          paths: ['plan.segments[0].items[0].skill.markdown'],
        },
      });
      expect(await planCount()).toBe(before);
    });

    it('refuses a plan that would not apply as written, naming each place', async () => {
      const caller = await agent(trialId, adminPrincipalId);
      const before = await planCount();
      const err = await thrownBy(
        propose(
          caller,
          planParams(
            [
              {
                targetWorkspaceId: targetA.workspaceId,
                items: [
                  skillItem('disk-triage'),
                  skillItem('disk-triage'),
                  workerItem({ name: 'disk-worker', systemPrompt: 'x', gates: ['gk-1'] }),
                  workerItem({ systemPrompt: 'nameless' }),
                  skillItem('blank-body', '   '),
                ],
              },
              { targetWorkspaceId: targetA.workspaceId, items: [skillItem('disk-triage')] },
            ],
            { sourceName: 'ops-base' },
          ),
        ),
      );
      expect(err).toBeInstanceOf(ChangePlanProposalInvalidError);
      const mapped = mapCapabilityError(err);
      expect(mapped.status).toBe(400);
      expect(mapped.code).toBe('invalid_params');
      const paths = (mapped.details as { problems: { path: string }[] }).problems.map(
        (problem) => problem.path,
      );
      expect(paths).toEqual(
        expect.arrayContaining([
          'sourceName',
          'segments[0].items[1]',
          'segments[0].items[2].definition.gates',
          'segments[0].items[3].definition.name',
          'segments[0].items[4].skill',
          'segments[1].targetWorkspaceId',
        ]),
      );
      expect(mapCapabilityErrorToToolResult(err).content).toEqual([
        { type: 'text', text: expect.stringMatching(/^invalid_params: /) },
      ]);
      expect(await planCount()).toBe(before);
    });

    it('F12: the agent reads and withdraws only its own administrator’s plans in the trial workspace', async () => {
      const mine = await agent(trialId, adminPrincipalId);
      const theirs = await agent(trialId, otherAdminPrincipalId);
      const own = await propose(
        mine,
        planParams([{ targetWorkspaceId: targetA.workspaceId, items: [skillItem('mine')] }]),
      );
      const other = await propose(
        theirs,
        planParams([{ targetWorkspaceId: targetA.workspaceId, items: [skillItem('theirs')] }]),
      );
      const listed = (await dispatchCapability(
        { pool },
        mine,
        'agent_list_change_plans',
        {},
      )) as ListEnvelope<ChangePlanSummaryWire>;
      const ids = listed.items.map((plan) => plan.id);
      expect(ids).toContain(own.id);
      expect(ids).not.toContain(other.id);
      for (const plan of listed.items) expect(plan.proposedBy.userId).toBe(admin.id);
      await expect(
        dispatchCapability({ pool }, mine, 'agent_get_change_plan', { planId: own.id }),
      ).resolves.toMatchObject({ id: own.id });
      for (const name of ['agent_get_change_plan', 'agent_withdraw_change_plan']) {
        const err = await thrownBy(dispatchCapability({ pool }, mine, name, { planId: other.id }));
        expect(err, name).toBeInstanceOf(ChangePlanNotFoundError);
        expect(mapCapabilityError(err)).toMatchObject({
          status: 404,
          code: 'change_plan_not_found',
        });
      }
      // The platform sees both.
      const platform = (await dispatchCapability(
        { pool },
        platformCaller(otherAdmin),
        'list_change_plans',
        {},
      )) as ListEnvelope<ChangePlanSummaryWire>;
      expect(platform.items.map((plan) => plan.id)).toEqual(
        expect.arrayContaining([own.id, other.id]),
      );
    });

    it('F4: a target workspace reads the segment addressed to it and its plan’s head, and no other segment; an unrelated workspace reads nothing', async () => {
      const caller = await agent(trialId, adminPrincipalId);
      const plan = await propose(
        caller,
        planParams([
          { targetWorkspaceId: targetA.workspaceId, items: [skillItem('for-a')] },
          { targetWorkspaceId: targetB.workspaceId, items: [skillItem('for-b')] },
        ]),
      );
      const seen = await inWorkspace(targetA.workspaceId, targetA.ownerPrincipalId, async (c) => ({
        segments: (
          await c.query<{ target_workspace_id: string }>(
            'select target_workspace_id from change_plan_segments where plan_id = $1',
            [plan.id],
          )
        ).rows.map((row) => row.target_workspace_id),
        plans: (await c.query('select title from change_plans where id = $1', [plan.id])).rows,
      }));
      expect(seen.segments).toEqual([targetA.workspaceId]);
      expect(seen.plans).toHaveLength(1);
      const unrelated = await newWorkspace(otherAdmin, 'standard');
      const none = await inWorkspace(
        unrelated.workspaceId,
        unrelated.ownerPrincipalId,
        async (c) => [
          ...(await c.query('select 1 from change_plan_segments where plan_id = $1', [plan.id]))
            .rows,
          ...(await c.query('select 1 from change_plans where id = $1', [plan.id])).rows,
        ],
      );
      expect(none).toEqual([]);
    });

    it('withdraws through the agent (origin agent) and on the platform (origin human, platform audit row); a plan with nothing open is 409', async () => {
      const caller = await agent(trialId, adminPrincipalId);
      const viaAgent = await propose(
        caller,
        planParams([{ targetWorkspaceId: targetA.workspaceId, items: [skillItem('w-agent')] }]),
      );
      const withdrawn = (await dispatchCapability({ pool }, caller, 'agent_withdraw_change_plan', {
        planId: viaAgent.id,
        reason: 'Superseded by a smaller plan.',
      })) as ChangePlanWire;
      expect(withdrawn.status).toBe('closed');
      expect(withdrawn.segments[0]).toMatchObject({
        status: 'withdrawn',
        withdrawnOrigin: 'agent',
        reason: 'Superseded by a smaller plan.',
      });
      expect(withdrawn.segments[0]?.decidedAt).not.toBeNull();
      expect(await lastAudit(trialId, 'agent_withdraw_change_plan')).toMatchObject({
        sessionKind: 'admin_agent',
        resourceType: 'change_plan',
        resourceId: viaAgent.id,
      });
      const again = await thrownBy(
        dispatchCapability({ pool }, caller, 'agent_withdraw_change_plan', { planId: viaAgent.id }),
      );
      expect(again).toBeInstanceOf(ChangePlanNotOpenError);
      expect(mapCapabilityError(again)).toMatchObject({
        status: 409,
        code: 'change_plan_not_open',
      });

      const viaPlatform = await propose(
        caller,
        planParams([{ targetWorkspaceId: targetA.workspaceId, items: [skillItem('w-console')] }]),
      );
      const closed = (await dispatchCapability(
        { pool },
        platformCaller(otherAdmin),
        'withdraw_change_plan',
        { planId: viaPlatform.id },
      )) as ChangePlanWire;
      expect(closed.segments[0]).toMatchObject({
        status: 'withdrawn',
        withdrawnOrigin: 'human',
        reason: null,
      });
      const recorded = await withAdminClient(pool, (client) =>
        client.query<{ withdrawn_by_user: string }>(
          'select withdrawn_by_user from change_plan_segments where plan_id = $1',
          [viaPlatform.id],
        ),
      );
      expect(recorded.rows[0]?.withdrawn_by_user).toBe(otherAdmin.id);
      expect(await lastAudit(null, 'withdraw_change_plan')).toMatchObject({
        channel: 'platform',
        actorUserId: otherAdmin.id,
        resourceType: 'change_plan',
        resourceId: viaPlatform.id,
      });

      // The status filter narrows before the list's limit, and agrees with the wire's status.
      for (const status of ['proposed', 'closed'] as const) {
        const listed = (await dispatchCapability(
          { pool },
          platformCaller(admin),
          'list_change_plans',
          { status },
        )) as ListEnvelope<ChangePlanSummaryWire>;
        expect(listed.items.length, status).toBeGreaterThan(0);
        for (const plan of listed.items) expect(plan.status, plan.id).toBe(status);
        expect(listed.items.map((plan) => plan.id).includes(viaAgent.id)).toBe(status === 'closed');
      }
      // `changePlanStatusOf` is what the wire says.
      expect(changePlanStatusOf(['withdrawn'])).toBe('closed');
    });

    it('the guards: a plan never changes; a segment is added only by its plan’s transaction, never to a trial workspace, and moves only along an edge decided where it may be', async () => {
      const caller = await agent(trialId, adminPrincipalId);
      const plan = await propose(
        caller,
        planParams([{ targetWorkspaceId: targetA.workspaceId, items: [skillItem('guarded')] }]),
      );
      const segmentId = plan.segments[0]?.id as string;
      const asTrial = <T>(run: (client: PoolClient) => Promise<T>) =>
        inWorkspace(trialId, adminPrincipalId, run);
      const asTarget = <T>(run: (client: PoolClient) => Promise<T>) =>
        inWorkspace(targetA.workspaceId, targetA.ownerPrincipalId, run);

      // A plan, once proposed: no update, no delete — not even for the superuser.
      await expect(
        withAdminClient(pool, (c) =>
          c.query(`update change_plans set title = 'other' where id = $1`, [plan.id]),
        ),
      ).rejects.toThrow(/a proposed plan never changes/);
      await expect(
        withAdminClient(pool, (c) => c.query('delete from change_plans where id = $1', [plan.id])),
      ).rejects.toThrow(/a proposed plan never changes/);
      // A segment added later, or addressed to a trial workspace.
      const digest = plan.segments[0]?.contentDigest as string;
      const addSegment = (target: string, ordinal: number) =>
        asTrial((c) =>
          c.query(
            `insert into change_plan_segments
               (workspace_id, plan_id, ordinal, authority, target_workspace_id, items, content_digest)
             values ($1, $2, $3, 'workspace', $4, '[{"kind":"x"}]'::jsonb, $5)`,
            [trialId, plan.id, ordinal, target, digest],
          ),
        );
      await expect(addSegment(targetB.workspaceId, 2)).rejects.toThrow(
        /written by the transaction that proposes their plan/,
      );
      // What a segment proposes never changes.
      await expect(
        withAdminClient(pool, (c) =>
          c.query(`update change_plan_segments set items = '[]'::jsonb where id = $1`, [segmentId]),
        ),
      ).rejects.toThrow(/never changes \(items\)/);
      // Applied or rejected only in the target workspace; withdrawn only by the proposer's side.
      await expect(
        asTrial((c) =>
          c.query(
            `update change_plan_segments
                set status = 'rejected', decided_by = $2, reason = 'no'
              where id = $1`,
            [segmentId, adminPrincipalId],
          ),
        ),
      ).rejects.toThrow(/is rejected in its target workspace/);
      await expect(
        asTarget((c) =>
          c.query(
            `update change_plan_segments set status = 'withdrawn', withdrawn_by_user = $2
              where id = $1`,
            [segmentId, admin.id],
          ),
        ),
      ).rejects.toThrow(/withdrawn by its proposer or on the platform plane/);
      // The target rejects it, with its own person as the decider.
      await asTarget((c) =>
        c.query(
          `update change_plan_segments set status = 'rejected', decided_by = $2, reason = 'Not here.'
            where id = $1`,
          [segmentId, targetA.ownerPrincipalId],
        ),
      );
      const read = (await dispatchCapability({ pool }, caller, 'agent_get_change_plan', {
        planId: plan.id,
      })) as ChangePlanWire;
      // The agent reads that it was rejected, and when — not why: what the owner wrote stays with
      // them and the platform's people (coordinator 11-02, as for what their dry run finds).
      expect(read.segments[0]).toMatchObject({ status: 'rejected', reason: null });
      expect(read.segments[0]?.decidedAt).not.toBeNull();
      expect(JSON.stringify(read)).not.toContain('Not here.');
      expect(read.status).toBe('closed');
      const listedByAgent = (await dispatchCapability(
        { pool },
        caller,
        'agent_list_change_plans',
        {},
      )) as ListEnvelope<ChangePlanSummaryWire>;
      expect(JSON.stringify(listedByAgent)).not.toContain('Not here.');
      const readOnPlatform = (await dispatchCapability(
        { pool },
        platformCaller(admin),
        'get_change_plan',
        { planId: plan.id },
      )) as ChangePlanWire;
      expect(readOnPlatform.segments[0]).toMatchObject({ status: 'rejected', reason: 'Not here.' });
      // The same administrator's identity through the admin agent's session never reads it on the
      // platform side either: the reader comes from the session kind, not the Principal (AA1: the
      // agent acts as its administrator's own) nor anything the call passes. The platform reads
      // are the platform channel's only — a console cookie; no Handle reaches them.
      for (const [name, params] of [
        ['get_change_plan', { planId: plan.id }],
        ['list_change_plans', {}],
      ] as const) {
        const attempt = dispatchCapability({ pool }, caller, name, params);
        await expect(attempt, name).rejects.toThrow(/requires a platform administrator/);
        await attempt.catch((err: unknown) =>
          expect(JSON.stringify(err), name).not.toContain('Not here.'),
        );
      }
      // And were the handler ever handed an admin agent's context, it reads as the agent does.
      const adminAgentCtx = { sessionId: randomUUID(), userId: admin.id };
      const platformUserCtx = { id: admin.id, login: admin.login };
      expect(
        changePlanReaderOf('get_change_plan', {
          channel: 'human',
          principalId: '',
          adminAgent: adminAgentCtx,
          platformUser: platformUserCtx,
        }),
      ).toBe('agent');
      expect(
        changePlanReaderOf('get_change_plan', {
          channel: 'human',
          principalId: '',
          platformUser: platformUserCtx,
        }),
      ).toBe('platform');
      expect(() =>
        changePlanReaderOf('get_change_plan', { channel: 'human', principalId: '' }),
      ).toThrow(/neither an admin agent nor a platform user/);
      // Final: no edge out of rejected.
      await expect(
        asTarget((c) =>
          c.query(
            `update change_plan_segments set status = 'proposed', decided_by = null,
                     decided_at = null, reason = null where id = $1`,
            [segmentId],
          ),
        ),
      ).rejects.toThrow(/a rejected segment is final/);

      // §3.2 at the database too: a plan whose segment names a trial workspace never lands.
      await expect(
        asTrial(async (c) => {
          const session = await c.query<{ id: string }>(
            `select id from sessions where workspace_id = $1 and kind = 'admin_agent' limit 1`,
            [trialId],
          );
          const inserted = await c.query<{ id: string }>(
            `insert into change_plans
               (workspace_id, proposed_by, proposed_by_user, proposer_display_name, session_id,
                origin, title, source_name, content_digest)
             values ($1, $2, $3, 'AA3b Admin', $4, 'agent', 't', 'x', $5) returning id`,
            [trialId, adminPrincipalId, admin.id, session.rows[0]?.id, digest],
          );
          await c.query(
            `insert into change_plan_segments
               (workspace_id, plan_id, ordinal, authority, target_workspace_id, items, content_digest)
             values ($1, $2, 1, 'workspace', $3, '[{"kind":"x"}]'::jsonb, $4)`,
            [trialId, inserted.rows[0]?.id, otherTrialId, digest],
          );
        }),
      ).rejects.toThrow(/never addressed to a trial workspace/);
      // And a plan is proposed only in a trial workspace (the insert policy) — here by the same
      // administrator, owner of a standard workspace, so only the policy refuses it.
      const standard = await newWorkspace(admin, 'standard');
      await expect(
        inWorkspace(standard.workspaceId, standard.ownerPrincipalId, (c) =>
          c.query(
            `insert into change_plans
               (workspace_id, proposed_by, proposed_by_user, proposer_display_name, session_id,
                origin, title, source_name, content_digest)
             values ($1, $2, $3, 'x', $4, 'agent', 't', 'x', $5)`,
            [standard.workspaceId, standard.ownerPrincipalId, admin.id, randomUUID(), digest],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it('purging a target deletes the segment addressed to it and keeps the plan; purging the trial workspace deletes its plans', async () => {
      const owner = await createUser(pool, {
        login: `aa3b-purge-${tag}`,
        displayName: 'Purge Owner',
      });
      const doomed = await newWorkspace(owner, 'standard');
      const trial = await newWorkspace(admin, 'admin_trial');
      const caller = await agent(trial.workspaceId, trial.ownerPrincipalId);
      const plan = await propose(
        caller,
        planParams([
          { targetWorkspaceId: doomed.workspaceId, items: [skillItem('purged')] },
          { targetWorkspaceId: targetA.workspaceId, items: [skillItem('kept')] },
        ]),
      );
      await withAdminClient(pool, (c) =>
        c.query(`update workspaces set status = 'disabled' where id = $1`, [doomed.workspaceId]),
      );
      await purgeWorkspace(pool, { workspaceId: doomed.workspaceId, confirm: true, force: true });
      const after = (await dispatchCapability({ pool }, caller, 'agent_get_change_plan', {
        planId: plan.id,
      })) as ChangePlanWire;
      expect(after.segments.map((segment) => segment.targetWorkspaceId)).toEqual([
        targetA.workspaceId,
      ]);

      await withAdminClient(pool, (c) =>
        c.query(`update workspaces set status = 'disabled' where id = $1`, [trial.workspaceId]),
      );
      await purgeWorkspace(pool, { workspaceId: trial.workspaceId, confirm: true, force: true });
      const left = await withAdminClient(pool, (c) =>
        c.query<{ n: number }>(
          `select (select count(*) from change_plans where id = $1)::int
                + (select count(*) from change_plan_segments where plan_id = $1)::int as n`,
          [plan.id],
        ),
      );
      expect(left.rows[0]?.n).toBe(0);
    });

    it('F11: twenty plans a day per administrator across trial workspaces; three at the limit wait on one lock and one passes', async () => {
      const quotaAdmin = await createUser(pool, {
        login: `aa3b-quota-${tag}`,
        displayName: 'Quota Admin',
        platformRole: 'admin',
      });
      const first = await newWorkspace(quotaAdmin, 'admin_trial');
      const second = await newWorkspace(quotaAdmin, 'admin_trial');
      const callers = [
        await agent(first.workspaceId, first.ownerPrincipalId),
        await agent(second.workspaceId, second.ownerPrincipalId),
      ] as const;
      const params = (n: number) =>
        planParams([{ targetWorkspaceId: targetA.workspaceId, items: [skillItem(`q-${n}`)] }]);
      for (let n = 0; n < CHANGE_PLAN_DAILY_LIMIT - 1; n += 1) {
        await propose(callers[n % 2] as ResolvedCaller, params(n));
      }
      // Three at the limit, from both trial workspaces. Hold the administrator's quota lock first,
      // so all three are seen waiting on it (proposeChangePlan takes it before it counts) and none
      // can count before another commits; then let them go: exactly one passes.
      const holder = await pool.connect();
      await holder.query('begin');
      await holder.query('select pg_advisory_xact_lock($1, hashtext($2::text))', [
        ADVISORY_LOCK_NAMESPACES.changePlanQuota,
        quotaAdmin.id,
      ]);
      const racing = Promise.allSettled([
        propose(callers[0], params(100)),
        propose(callers[1], params(101)),
        propose(callers[0], params(102)),
      ]);
      let waiting = 0;
      try {
        for (let tries = 0; tries < 200 && waiting < 3; tries += 1) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          const locks = await pool.query<{ n: number }>(
            `select count(*)::int as n from pg_locks
              where locktype = 'advisory' and classid = $1::oid and objsubid = 2 and not granted`,
            [ADVISORY_LOCK_NAMESPACES.changePlanQuota],
          );
          waiting = locks.rows[0]?.n ?? 0;
        }
      } finally {
        await holder.query('commit');
        holder.release();
      }
      const raced = await racing;
      expect(waiting).toBe(3);
      expect(raced.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const refusals = raced.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      expect(refusals).toHaveLength(2);
      for (const refusal of refusals) {
        expect(refusal.reason).toBeInstanceOf(ChangePlanQuotaExceededError);
      }
      const refused = refusals[0] as PromiseRejectedResult;
      const mapped = mapCapabilityError(refused.reason);
      expect(mapped).toMatchObject({
        status: 429,
        code: 'change_plan_quota_exceeded',
        details: { dailyLimit: CHANGE_PLAN_DAILY_LIMIT },
      });
      const resetsAt = new Date((mapped.details as { resetsAt: string }).resetsAt);
      expect(resetsAt.getUTCHours()).toBe(0);
      expect(resetsAt.getTime()).toBeGreaterThan(Date.now());
      expect(mapDispatchError(refused.reason).code).toBe(-32012);
      // Counted for this administrator only: the other one still proposes.
      await expect(
        propose(
          await agent(trialId, adminPrincipalId),
          planParams([{ targetWorkspaceId: targetA.workspaceId, items: [skillItem('free')] }]),
        ),
      ).resolves.toMatchObject({ status: 'proposed' });
      const counted = await withAdminClient(pool, (c) =>
        c.query<{ n: number }>(
          'select count(*)::int as n from change_plans where proposed_by_user = $1',
          [quotaAdmin.id],
        ),
      );
      expect(counted.rows[0]?.n).toBe(CHANGE_PLAN_DAILY_LIMIT);
    });

    it('only an admin agent proposes: the same administrator in the console, or another Handle, is refused', async () => {
      const person: ResolvedCaller = {
        channel: 'human',
        principal: {
          workspaceId: trialId,
          id: adminPrincipalId,
          kind: 'human',
          role: 'owner',
          displayName: null,
        },
        session: {
          workspaceId: trialId,
          id: randomUUID(),
          principalId: adminPrincipalId,
          kind: 'web',
          onBehalfOf: adminPrincipalId,
          status: 'active',
          createdAt: new Date(),
          expiresAt: null,
        },
      };
      for (const name of [
        'propose_change_plan',
        'agent_list_change_plans',
        'agent_get_change_plan',
        'agent_withdraw_change_plan',
      ]) {
        await expect(dispatchCapability({ pool }, person, name, {}), name).rejects.toThrow();
      }
      await expect(
        dispatchCapability({ pool }, platformCaller(admin), 'propose_change_plan', {}),
      ).rejects.toThrow();
    });
  },
);
