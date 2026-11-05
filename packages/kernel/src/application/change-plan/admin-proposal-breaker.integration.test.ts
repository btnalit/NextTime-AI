import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdminProposalWire } from '@nexttime/shared';
import { generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ADVISORY_LOCK_NAMESPACES } from '../../adapters/db/advisory-lock-namespaces.js';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { HANDLE_SIGNING_ALG } from '../../governance/capability/index.js';
import { mapCapabilityError } from '../../interfaces/http/capability-route.js';
import { mapCapabilityErrorToToolResult } from '../../interfaces/mcp/server-factory.js';
import { WS_ERROR_CODES, mapDispatchError } from '../../interfaces/ws/rpc.js';
import { issueAdminAgentHandle } from '../admin-agent/index.js';
import { withAdminClient } from '../gateway/auth.js';
import { dispatchCapability } from '../gateway/dispatch.js';
import { authenticateHandle } from '../gateway/handle-auth.js';
import type { ResolvedCaller } from '../gateway/resolve-caller.js';
import { type UserRow, createUser } from '../identity/index.js';
import { createWorkspaceWithOwner } from '../workspace/index.js';
import {
  ADMIN_PROPOSAL_REJECTION_LIMIT_VAR,
  ADMIN_PROPOSAL_REJECTION_WINDOW_DAYS_VAR,
  AdminProposalTargetRejectedRepeatedlyError,
} from './index.js';

/**
 * F6(a) (S11 AA5a-2, legacy 595) against a real Postgres (auto-skip without DATABASE_URL): a target
 * workspace whose owners rejected an administrator's workspace segments three times within seven
 * days is closed to that administrator's admin agent until the oldest of them leaves the window.
 *
 *  - Counted from the database (governance 0038), across the administrator's trial workspaces;
 *    not another administrator's rejections, not a withdrawal, not another target's.
 *  - The agent reads which segment, the rule and when it may propose there again — never why, nor
 *    which proposals; the refusal's audit row lists the rejected segments for the platform.
 *  - Under F11's per-administrator lock: proposals waiting on it read a rejection committed
 *    meanwhile.
 *  - `ADMIN_PROPOSAL_REJECTION_LIMIT` / `ADMIN_PROPOSAL_REJECTION_WINDOW_DAYS` move the rule.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const ONTOLOGY_DIR = path.join(KERNEL_ROOT, '..', '..', 'ontology');
const DAY_MS = 24 * 60 * 60 * 1000;
/** What an owner writes when rejecting: it must reach nobody but the platform's people. */
const OWNER_REASON = 'OWNER-REASON-not-for-the-agent';

interface Workspace {
  readonly workspaceId: string;
  readonly ownerPrincipalId: string;
}

interface Administrator {
  readonly user: UserRow;
  readonly trials: readonly Workspace[];
  readonly agents: readonly ResolvedCaller[];
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
  'S11 AA5a-2 Admin proposal rejection breaker (integration, real Postgres)',
  () => {
    let pool: Pool;
    let privateKey: CryptoKey;
    let publicKey: CryptoKey;
    let tag: string;
    let previousSwitch: string | undefined;
    const previousBreaker: Record<string, string | undefined> = {};

    async function newUser(prefix: string, platformRole?: 'admin'): Promise<UserRow> {
      return createUser(pool, {
        login: `aa5a2-${prefix}-${randomUUID().slice(0, 8)}`,
        displayName: `AA5a-2 ${prefix}`,
        ...(platformRole ? { platformRole } : {}),
      });
    }

    async function newWorkspace(
      owner: UserRow,
      purpose: 'standard' | 'admin_trial',
    ): Promise<Workspace> {
      return createWorkspaceWithOwner(pool, {
        name: `aa5a2-${purpose}-${randomUUID().slice(0, 8)}`,
        owner: { userId: owner.id, displayName: owner.displayName },
        ontologyDir: ONTOLOGY_DIR,
        purpose,
      });
    }

    async function agentIn(trial: Workspace): Promise<ResolvedCaller> {
      const issued = await withWorkspace(
        pool,
        { workspaceId: trial.workspaceId, principalId: trial.ownerPrincipalId },
        (client) =>
          issueAdminAgentHandle(client, {
            workspaceId: trial.workspaceId,
            principalId: trial.ownerPrincipalId,
            ttlSeconds: 600,
            privateKey,
          }),
      );
      const claims = await authenticateHandle(pool, issued.token, { publicKey }, 'source');
      return { channel: 'handle', claims };
    }

    /** A platform administrator with two trial workspaces and an admin agent in each. */
    async function administrator(): Promise<Administrator> {
      const user = await newUser('admin', 'admin');
      const first = await newWorkspace(user, 'admin_trial');
      const second = await newWorkspace(user, 'admin_trial');
      return {
        user,
        trials: [first, second],
        agents: [await agentIn(first), await agentIn(second)],
      };
    }

    async function target(): Promise<Workspace> {
      return newWorkspace(await newUser('owner'), 'standard');
    }

    /** The targets the administrator chose for their agent in `trial` (AA4c, governance 0036). */
    async function choose(trial: Workspace, targets: readonly Workspace[]): Promise<void> {
      await withAdminClient(pool, (client) =>
        client.query(
          `insert into admin_agent_targets
             (workspace_id, principal_id, target_workspace_id, chosen_by_user)
           select p.workspace_id, p.id, t.id, p.user_id
             from principals p, unnest($3::uuid[]) as t(id)
            where p.workspace_id = $1 and p.id = $2
           on conflict do nothing`,
          [trial.workspaceId, trial.ownerPrincipalId, targets.map((t) => t.workspaceId)],
        ),
      );
    }

    async function chooseEverywhere(admin: Administrator, targets: readonly Workspace[]) {
      for (const trial of admin.trials) await choose(trial, targets);
    }

    function propose(
      agent: ResolvedCaller,
      targets: readonly Workspace[],
    ): Promise<AdminProposalWire> {
      return dispatchCapability({ pool }, agent, 'propose_admin_proposal', {
        title: 'Disk triage everywhere',
        description: 'The Skill the trial workspace settled on.',
        sourceName: `aa5a2-${tag}`,
        segments: targets.map((t) => ({
          targetWorkspaceId: t.workspaceId,
          items: [
            {
              kind: 'skill_version',
              skill: {
                name: `triage-${randomUUID().slice(0, 6)}`,
                description: 'Triage disks.',
                markdown: '# Steps\n\n1. Look at the disk.',
              },
            },
          ],
        })),
      }) as Promise<AdminProposalWire>;
    }

    function segmentFor(proposal: AdminProposalWire, where: Workspace): string {
      const segment = proposal.segments.find((s) => s.targetWorkspaceId === where.workspaceId);
      if (!segment) throw new Error('no segment for that target');
      return segment.id;
    }

    function ownerOf(where: Workspace): ResolvedCaller {
      return {
        channel: 'human',
        principal: {
          workspaceId: where.workspaceId,
          id: where.ownerPrincipalId,
          kind: 'human',
          role: 'owner',
          displayName: 'owner',
        },
        session: {
          workspaceId: where.workspaceId,
          id: randomUUID(),
          principalId: where.ownerPrincipalId,
          kind: 'web',
          onBehalfOf: where.ownerPrincipalId,
          status: 'active',
          createdAt: new Date(),
          expiresAt: null,
        },
      };
    }

    function reject(where: Workspace, segmentId: string) {
      return dispatchCapability({ pool }, ownerOf(where), 'reject_admin_proposal_segment', {
        segmentId,
        reason: OWNER_REASON,
      });
    }

    /** Proposes to `where` through `agent` and has its owner reject it; returns the segment. */
    async function proposeAndReject(agent: ResolvedCaller, where: Workspace): Promise<string> {
      const segmentId = segmentFor(await propose(agent, [where]), where);
      await reject(where, segmentId);
      return segmentId;
    }

    /** Sets when segments were decided, past the guards (a fixture, not a lifecycle edge). */
    async function decidedAgo(segmentIds: readonly string[], daysAgo: readonly number[]) {
      await withAdminClient(pool, async (client) => {
        await client.query('set local session_replication_role = replica');
        for (const [i, id] of segmentIds.entries()) {
          await client.query(
            `update admin_proposal_segments
                set decided_at = now() - make_interval(secs => $2::double precision)
              where id = $1`,
            [id, (daysAgo[i] ?? 0) * 86400],
          );
        }
      });
    }

    async function decidedAt(segmentId: string): Promise<Date> {
      const result = await withAdminClient(pool, (client) =>
        client.query<{ decided_at: Date }>(
          'select decided_at from admin_proposal_segments where id = $1',
          [segmentId],
        ),
      );
      const at = result.rows[0]?.decided_at;
      if (!at) throw new Error('segment not decided');
      return at;
    }

    async function proposalCount(user: UserRow): Promise<number> {
      const result = await withAdminClient(pool, (client) =>
        client.query<{ n: number }>(
          'select count(*)::int as n from admin_proposals where proposed_by_user = $1',
          [user.id],
        ),
      );
      return result.rows[0]?.n ?? 0;
    }

    async function refusalAudits(trial: Workspace): Promise<Record<string, unknown>[]> {
      const result = await withAdminClient(pool, (client) =>
        client.query<{ payload: Record<string, unknown> }>(
          `select payload from audit_records
            where workspace_id = $1 and action = 'propose_admin_proposal'
              and payload->'refusal'->>'code' = 'admin_proposal_target_rejected_repeatedly'
            order by created_at, id`,
          [trial.workspaceId],
        ),
      );
      return result.rows.map((row) => row.payload);
    }

    function setBreaker(limit?: string, windowDays?: string) {
      for (const [name, value] of [
        [ADMIN_PROPOSAL_REJECTION_LIMIT_VAR, limit],
        [ADMIN_PROPOSAL_REJECTION_WINDOW_DAYS_VAR, windowDays],
      ] as const) {
        if (value === undefined) Reflect.deleteProperty(process.env, name);
        else process.env[name] = value;
      }
    }

    beforeAll(async () => {
      previousSwitch = process.env.ADMIN_AGENT_ENABLED;
      process.env.ADMIN_AGENT_ENABLED = '1';
      for (const name of [
        ADMIN_PROPOSAL_REJECTION_LIMIT_VAR,
        ADMIN_PROPOSAL_REJECTION_WINDOW_DAYS_VAR,
      ]) {
        previousBreaker[name] = process.env[name];
      }
      setBreaker();
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      const pair = await generateKeyPair(HANDLE_SIGNING_ALG, { crv: 'Ed25519' });
      privateKey = pair.privateKey;
      publicKey = pair.publicKey;
      tag = randomUUID().slice(0, 8);
    });

    afterEach(() => {
      setBreaker();
    });

    afterAll(async () => {
      if (previousSwitch === undefined) Reflect.deleteProperty(process.env, 'ADMIN_AGENT_ENABLED');
      else process.env.ADMIN_AGENT_ENABLED = previousSwitch;
      for (const [name, value] of Object.entries(previousBreaker)) {
        if (value === undefined) Reflect.deleteProperty(process.env, name);
        else process.env[name] = value;
      }
      await pool?.end();
    });

    it('a third rejection within seven days closes the target: 429 with when, never why; audited with the rejections; nothing written; other targets stay open', async () => {
      const admin = await administrator();
      const closing = await target();
      const other = await target();
      await chooseEverywhere(admin, [closing, other]);
      const [first, second] = admin.agents as [ResolvedCaller, ResolvedCaller];

      // Two rejections, one through each trial workspace: still open.
      const rejected = [
        await proposeAndReject(first, closing),
        await proposeAndReject(second, closing),
      ];
      const third = segmentFor(await propose(first, [closing]), closing);
      // The third, still open, does not count until its owner rejects it.
      await expect(propose(second, [other])).resolves.toMatchObject({ status: 'proposed' });
      await reject(closing, third);
      rejected.push(third);

      const before = await proposalCount(admin.user);
      const refused = await thrownBy(propose(second, [other, closing]));
      expect(refused).toBeInstanceOf(AdminProposalTargetRejectedRepeatedlyError);
      const err = refused as AdminProposalTargetRejectedRepeatedlyError;
      const oldest = await decidedAt(rejected[0] as string);
      const reopensAt = new Date(oldest.getTime() + 7 * DAY_MS).toISOString();
      expect(err.details).toEqual({ segment: 1, rejectionLimit: 3, windowDays: 7, reopensAt });
      expect(await proposalCount(admin.user)).toBe(before);

      // The same answer on every interface: HTTP 429, WS quota, MCP text with the code.
      expect(mapCapabilityError(err)).toMatchObject({
        status: 429,
        code: 'admin_proposal_target_rejected_repeatedly',
        details: { segment: 1, rejectionLimit: 3, windowDays: 7, reopensAt },
      });
      expect(mapDispatchError(err).code).toBe(WS_ERROR_CODES.QUOTA_EXCEEDED);
      const tool = mapCapabilityErrorToToolResult(err);
      expect(JSON.stringify(tool)).toContain('admin_proposal_target_rejected_repeatedly');

      // Never why, nor which proposals or segments, nor the target's id.
      const told = `${err.message} ${JSON.stringify(err.details)} ${JSON.stringify(tool)}`;
      expect(told).not.toContain(OWNER_REASON);
      expect(told).not.toContain(closing.workspaceId);
      for (const segmentId of rejected) expect(told).not.toContain(segmentId);

      // The platform's people read which rejections, in the trial workspace's audit.
      const audits = await refusalAudits(admin.trials[1] as Workspace);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        outcome: 'refused',
        sessionKind: 'admin_agent',
        refusal: {
          code: 'admin_proposal_target_rejected_repeatedly',
          status: 429,
          segment: 1,
          targetWorkspaceId: closing.workspaceId,
          rejectionLimit: 3,
          windowDays: 7,
          reopensAt,
        },
      });
      const listed = (audits[0]?.refusal as { rejections: { segmentId: string }[] }).rejections;
      expect(listed.map((r) => r.segmentId)).toEqual(rejected);
      expect(JSON.stringify(audits[0])).not.toContain(OWNER_REASON);

      // Only that target: the other one, alone, still goes in.
      await expect(propose(first, [other])).resolves.toMatchObject({ status: 'proposed' });
    });

    it('counts only this administrator’s rejections of that target: not another administrator’s, not a withdrawal, not another target’s', async () => {
      const admin = await administrator();
      const someoneElse = await administrator();
      const where = await target();
      const elsewhere = await target();
      await chooseEverywhere(admin, [where, elsewhere]);
      await chooseEverywhere(someoneElse, [where]);
      const [agent] = admin.agents as [ResolvedCaller];
      const [otherAgent] = someoneElse.agents as [ResolvedCaller];

      // Another administrator's three rejections close `where` to them, not to this one.
      for (let n = 0; n < 3; n += 1) await proposeAndReject(otherAgent, where);
      expect(await thrownBy(propose(otherAgent, [where]))).toBeInstanceOf(
        AdminProposalTargetRejectedRepeatedlyError,
      );

      // This administrator: two rejections at `where`, a withdrawal there, three elsewhere.
      await proposeAndReject(agent, where);
      await proposeAndReject(agent, where);
      const withdrawn = await propose(agent, [where]);
      await dispatchCapability({ pool }, agent, 'agent_withdraw_admin_proposal', {
        proposalId: withdrawn.id,
      });
      for (let n = 0; n < 3; n += 1) await proposeAndReject(agent, elsewhere);

      await expect(propose(agent, [where])).resolves.toMatchObject({ status: 'proposed' });
      expect(await thrownBy(propose(agent, [elsewhere]))).toBeInstanceOf(
        AdminProposalTargetRejectedRepeatedlyError,
      );
    });

    it('opens again when the oldest rejection leaves the window, and says when that is', async () => {
      const admin = await administrator();
      const where = await target();
      await chooseEverywhere(admin, [where]);
      const [agent] = admin.agents as [ResolvedCaller];
      const rejected = [
        await proposeAndReject(agent, where),
        await proposeAndReject(agent, where),
        await proposeAndReject(agent, where),
      ];

      // Decided six, five and one day(s) ago: closed until the six-day-old one is seven days old.
      await decidedAgo(rejected, [6, 5, 1]);
      const refused = (await thrownBy(
        propose(agent, [where]),
      )) as AdminProposalTargetRejectedRepeatedlyError;
      expect(refused).toBeInstanceOf(AdminProposalTargetRejectedRepeatedlyError);
      const oldest = await decidedAt(rejected[0] as string);
      expect(refused.details.reopensAt).toBe(new Date(oldest.getTime() + 7 * DAY_MS).toISOString());
      const inDays = (Date.parse(refused.details.reopensAt) - Date.now()) / DAY_MS;
      expect(inDays).toBeGreaterThan(0.99);
      expect(inDays).toBeLessThan(1.01);

      // Eight days ago: two left in the window, open.
      await decidedAgo(rejected, [8, 5, 1]);
      await expect(propose(agent, [where])).resolves.toMatchObject({ status: 'proposed' });
    });

    it('follows ADMIN_PROPOSAL_REJECTION_LIMIT and ADMIN_PROPOSAL_REJECTION_WINDOW_DAYS', async () => {
      const admin = await administrator();
      const where = await target();
      await chooseEverywhere(admin, [where]);
      const [agent] = admin.agents as [ResolvedCaller];
      const rejected = await proposeAndReject(agent, where);

      setBreaker('1', '7');
      const one = (await thrownBy(
        propose(agent, [where]),
      )) as AdminProposalTargetRejectedRepeatedlyError;
      expect(one).toBeInstanceOf(AdminProposalTargetRejectedRepeatedlyError);
      expect(one.details).toMatchObject({ rejectionLimit: 1, windowDays: 7 });

      // Two days ago, with a one-day window: open again.
      await decidedAgo([rejected], [2]);
      setBreaker('1', '1');
      await expect(propose(agent, [where])).resolves.toMatchObject({ status: 'proposed' });
      // And with the defaults, one rejection never closed it.
      setBreaker();
      await expect(propose(agent, [where])).resolves.toMatchObject({ status: 'proposed' });
    });

    it('proposals waiting on the administrator’s lock read a rejection committed meanwhile; each refusal is audited once and nothing is written', async () => {
      const admin = await administrator();
      const where = await target();
      await chooseEverywhere(admin, [where]);
      const [first, second] = admin.agents as [ResolvedCaller, ResolvedCaller];
      await proposeAndReject(first, where);
      await proposeAndReject(second, where);
      const third = segmentFor(await propose(first, [where]), where);
      const before = await proposalCount(admin.user);

      // Hold the administrator's lock (proposeAdminProposal takes it before it counts anything),
      // send two proposals that wait on it, then reject the third segment — which takes no such
      // lock — and let them go: both read three rejections.
      const holder = await pool.connect();
      await holder.query('begin');
      await holder.query('select pg_advisory_xact_lock($1, hashtext($2::text))', [
        ADVISORY_LOCK_NAMESPACES.adminProposalQuota,
        admin.user.id,
      ]);
      const racing = Promise.allSettled([propose(first, [where]), propose(second, [where])]);
      let waiting = 0;
      try {
        for (let tries = 0; tries < 200 && waiting < 2; tries += 1) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          const locks = await pool.query<{ n: number }>(
            `select count(*)::int as n from pg_locks
              where locktype = 'advisory' and classid = $1::oid and objsubid = 2 and not granted`,
            [ADVISORY_LOCK_NAMESPACES.adminProposalQuota],
          );
          waiting = locks.rows[0]?.n ?? 0;
        }
        await reject(where, third);
      } finally {
        await holder.query('commit');
        holder.release();
      }
      const raced = await racing;
      expect(waiting).toBe(2);
      for (const result of raced) {
        expect(result.status).toBe('rejected');
        expect((result as PromiseRejectedResult).reason).toBeInstanceOf(
          AdminProposalTargetRejectedRepeatedlyError,
        );
      }
      expect(await proposalCount(admin.user)).toBe(before);
      const audits = [
        ...(await refusalAudits(admin.trials[0] as Workspace)),
        ...(await refusalAudits(admin.trials[1] as Workspace)),
      ];
      expect(audits).toHaveLength(2);
      for (const audit of audits) {
        expect(
          (audit.refusal as { rejections: { segmentId: string }[] }).rejections.map(
            (r) => r.segmentId,
          ),
        ).toContain(third);
      }
    });

    it('the read answers only for the transaction’s own Principal: another administrator’s Principal reads none of these rejections', async () => {
      const admin = await administrator();
      const someoneElse = await administrator();
      const where = await target();
      await chooseEverywhere(admin, [where]);
      const [agent] = admin.agents as [ResolvedCaller];
      await proposeAndReject(agent, where);
      const read = (trial: Workspace) =>
        withWorkspace(
          pool,
          { workspaceId: trial.workspaceId, principalId: trial.ownerPrincipalId },
          async (client) =>
            (
              await client.query<{ segment_id: string }>(
                `select segment_id from admin_proposal_rejections_since(now() - interval '7 days')`,
              )
            ).rows,
        );
      expect(await read(admin.trials[1] as Workspace)).toHaveLength(1);
      expect(await read(someoneElse.trials[0] as Workspace)).toHaveLength(0);
      // Nor does the target's owner, whose rejection it was.
      expect(await read(where)).toHaveLength(0);
    });
  },
);
