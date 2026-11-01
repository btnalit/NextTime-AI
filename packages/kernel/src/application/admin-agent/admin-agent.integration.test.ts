import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HandleClaims, PrincipalKind, Role } from '@nexttime/shared';
import { getCapability } from '@nexttime/shared';
import { generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { HANDLE_SIGNING_ALG, HandleRevoked } from '../../governance/capability/index.js';
import {
  ChangeApplierNotAPersonError,
  applyWorkspaceSegment,
  rollBackWorkspaceSegment,
} from '../change-plan/index.js';
import { withAdminClient } from '../gateway/auth.js';
import { ForbiddenError, authorizeCapabilityCall } from '../gateway/authorize.js';
import { AdminAgentCallRefusedError, dispatchCapability } from '../gateway/dispatch.js';
import { HandlePresentationRefused, authenticateHandle } from '../gateway/handle-auth.js';
import type { ResolvedCaller } from '../gateway/resolve-caller.js';
import { type UserRow, createUser } from '../identity/index.js';
import { createWorkspaceWithOwner } from '../workspace/index.js';
import { type AdminAgentRefusalReason, AdminAgentRefused, issueAdminAgentHandle } from './index.js';

/**
 * application/admin-agent integration (S11 AA1; real Postgres, auto-skip without DATABASE_URL):
 * an admin agent acts as its administrator's own human Principal under an `admin_agent` session,
 * through a container-held Handle held to `ADMIN_AGENT_CEILING_CAPABILITIES` — and its authority is
 * checked on every call (I-A3), never trusted from issuance. The coordinator's two constraints on
 * "the same Principal" are what most of this proves:
 *
 *   a) every audit row of the agent's calls carries `sessionKind: 'admin_agent'` and the session,
 *      refusals included, so nothing it did reads as the person's own;
 *   b) approving, publishing, applying, rolling back and confirming refuse the agent's Handle
 *      even though its Principal is the person, who still passes the same authorization on the
 *      human channel.
 *
 * Also STATUS legacy 407: a ChangePlan segment's applier is a person at run time.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const ONTOLOGY_DIR = path.join(KERNEL_ROOT, '..', '..', 'ontology');

/** Human-channel capabilities that are a person's decision (constraint b). Refused before their
 *  params are read, so none are given. */
const PERSON_DECISIONS = [
  'approve',
  'publish_skill',
  'install_pack',
  'roll_back_change_segment',
  'decide_plan_revision',
  'confirm_goal',
  'approve_step_trial',
] as const;

describe.runIf(DATABASE_URL !== undefined)(
  'S11 AA1 admin agent identity and ceiling (integration, real Postgres)',
  () => {
    let pool: Pool;
    let privateKey: CryptoKey;
    let publicKey: CryptoKey;
    let workspaceId: string;
    /** The administrator the agent acts for: a platform admin, owner of `workspaceId`. */
    let admin: UserRow;
    let adminPrincipalId: string;
    /** A second administrator: the one who demotes `admin`, so `last_admin` never fires. */
    let otherAdmin: UserRow;
    let previousSwitch: string | undefined;

    async function insertPrincipal(
      kind: PrincipalKind,
      role: Role,
      userId: string | null,
    ): Promise<string> {
      const id = randomUUID();
      await withAdminClient(pool, (client) =>
        client.query(
          `insert into principals (workspace_id, id, kind, role, display_name, user_id)
           values ($1, $2, $3, $4, $5, $6)`,
          [workspaceId, id, kind, role, `${kind}-${role}`, userId],
        ),
      );
      return id;
    }

    function issue(principalId: string, ttlSeconds = 600) {
      return withWorkspace(pool, { workspaceId, principalId }, (client) =>
        issueAdminAgentHandle(client, { workspaceId, principalId, ttlSeconds, privateKey }),
      );
    }

    async function issueRefusal(principalId: string): Promise<AdminAgentRefusalReason | null> {
      const thrown = await issue(principalId).then(
        () => null,
        (err: unknown) => err,
      );
      if (thrown === null) return null;
      expect(thrown).toBeInstanceOf(AdminAgentRefused);
      return (thrown as AdminAgentRefused).reason;
    }

    async function agentCaller(token: string): Promise<ResolvedCaller> {
      const claims = await authenticateHandle(pool, token, { publicKey }, 'source');
      return { channel: 'handle', claims };
    }

    /** The human channel: the administrator signed in to the console, unless another Principal
     *  (a service's API key) is named. */
    function personCaller(
      principalId = adminPrincipalId,
      kind: PrincipalKind = 'human',
    ): ResolvedCaller {
      return {
        channel: 'human',
        principal: { workspaceId, id: principalId, kind, role: 'owner', displayName: null },
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

    async function lastAudit(action: string): Promise<Record<string, unknown> | undefined> {
      const result = await withAdminClient(pool, (client) =>
        client.query<{ payload: Record<string, unknown>; actor_principal_id: string }>(
          `select payload, actor_principal_id from audit_records
            where workspace_id = $1 and action = $2 order by created_at desc, id desc limit 1`,
          [workspaceId, action],
        ),
      );
      const row = result.rows[0];
      return row ? { ...row.payload, actor: row.actor_principal_id } : undefined;
    }

    async function setPlatformRole(user: UserRow, role: 'admin' | 'user'): Promise<void> {
      await withAdminClient(pool, (client) =>
        client.query('update users set platform_role = $2 where id = $1', [user.id, role]),
      );
    }

    beforeAll(async () => {
      previousSwitch = process.env.ADMIN_AGENT_ENABLED;
      process.env.ADMIN_AGENT_ENABLED = '1';
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      const pair = await generateKeyPair(HANDLE_SIGNING_ALG, { crv: 'Ed25519' });
      privateKey = pair.privateKey;
      publicKey = pair.publicKey;
      const tag = randomUUID().slice(0, 8);
      admin = await createUser(pool, {
        login: `aa1-admin-${tag}`,
        displayName: 'AA1 Admin',
        platformRole: 'admin',
      });
      otherAdmin = await createUser(pool, {
        login: `aa1-other-${tag}`,
        displayName: 'AA1 Other Admin',
        platformRole: 'admin',
      });
      const created = await createWorkspaceWithOwner(pool, {
        name: `aa1-${tag}`,
        owner: { userId: admin.id, displayName: 'AA1 Admin' },
        ontologyDir: ONTOLOGY_DIR,
      });
      workspaceId = created.workspaceId;
      adminPrincipalId = created.ownerPrincipalId;
    });

    afterAll(async () => {
      if (previousSwitch === undefined) Reflect.deleteProperty(process.env, 'ADMIN_AGENT_ENABLED');
      else process.env.ADMIN_AGENT_ENABLED = previousSwitch;
      await pool?.end();
    });

    it('issues a container-held Handle under an admin_agent session of the administrator, held to the ceiling', async () => {
      const issued = await issue(adminPrincipalId);
      expect(issued.holder).toBe('container');
      const session = await withAdminClient(pool, (client) =>
        client.query<{ kind: string; on_behalf_of: string; principal_id: string }>(
          'select kind, on_behalf_of, principal_id from sessions where id = $1',
          [issued.sessionId],
        ),
      );
      expect(session.rows[0]).toEqual({
        kind: 'admin_agent',
        on_behalf_of: adminPrincipalId,
        principal_id: adminPrincipalId,
      });
      const caller = await agentCaller(issued.token);
      const claims = (caller as { claims: HandleClaims }).claims;
      for (const name of claims.scope.capabilities) {
        expect(getCapability(name)?.mode, name).toBe('observe');
      }
      // Container-held: never accepted as a bearer token.
      await expect(authenticateHandle(pool, issued.token, { publicKey })).rejects.toBeInstanceOf(
        HandlePresentationRefused,
      );
      // A second issuance reuses the open session.
      expect((await issue(adminPrincipalId)).sessionId).toBe(issued.sessionId);
    });

    it('reads through the Handle, and the audit row says the admin agent did it, not the person (constraint a)', async () => {
      const issued = await issue(adminPrincipalId);
      const caller = await agentCaller(issued.token);
      await expect(dispatchCapability({ pool }, caller, 'list_skills', {})).resolves.toBeDefined();
      expect(await lastAudit('list_skills')).toMatchObject({
        actor: adminPrincipalId,
        channel: 'handle',
        sessionKind: 'admin_agent',
        sessionId: issued.sessionId,
      });
      // The person's own call carries no session kind.
      await dispatchCapability({ pool }, personCaller(), 'list_skills', {});
      expect(await lastAudit('list_skills')).not.toHaveProperty('sessionKind');
    });

    it("refuses a person's decisions through the Handle though its Principal is that person, who still passes on the human channel (constraint b)", async () => {
      const issued = await issue(adminPrincipalId);
      const caller = await agentCaller(issued.token);
      for (const name of PERSON_DECISIONS) {
        const capability = getCapability(name);
        expect(capability?.channel, name).toBe('human');
        await expect(dispatchCapability({ pool }, caller, name, {}), name).rejects.toBeInstanceOf(
          ForbiddenError,
        );
        // The same administrator, signed in to the console: not refused by authorization.
        expect(() => {
          if (capability) authorizeCapabilityCall(personCaller(), capability);
        }, name).not.toThrow();
      }
      // Platform capabilities too.
      for (const name of ['list_users', 'update_user', 'create_workspace']) {
        await expect(dispatchCapability({ pool }, caller, name, {}), name).rejects.toBeInstanceOf(
          ForbiddenError,
        );
      }
    });

    it('refuses, at dispatch and with an audit row, a call outside the ceiling whatever the Handle says', async () => {
      const issued = await issue(adminPrincipalId);
      const real = (await agentCaller(issued.token)) as { claims: HandleClaims };
      // A caller built by hand around the session, with a scope the ceiling never grants.
      const forged: ResolvedCaller = {
        channel: 'handle',
        claims: {
          ...real.claims,
          scope: { capabilities: ['propose_skill', 'list_skills'], resources: {} },
        },
      };
      const thrown = await dispatchCapability({ pool }, forged, 'propose_skill', {
        skill: { name: 'aa1-forged', description: 'never written', body: 'x' },
      }).then(
        () => null,
        (err: unknown) => err,
      );
      expect(thrown).toBeInstanceOf(AdminAgentCallRefusedError);
      expect((thrown as AdminAgentCallRefusedError).refusal).toBe('outside_ceiling');
      expect(await lastAudit('propose_skill')).toMatchObject({
        actor: adminPrincipalId,
        sessionKind: 'admin_agent',
        sessionId: issued.sessionId,
        outcome: 'refused',
        refusal: { code: 'admin_agent_refused', status: 403, reason: 'outside_ceiling' },
      });
      const drafts = await withAdminClient(pool, (client) =>
        client.query("select 1 from skills where workspace_id = $1 and name = 'aa1-forged'", [
          workspaceId,
        ]),
      );
      expect(drafts.rowCount).toBe(0);
    });

    it('checks the platform role on every call, not at issuance (I-A3)', async () => {
      const issued = await issue(adminPrincipalId);
      const caller = await agentCaller(issued.token);
      // Only the role changes — nothing is revoked.
      await setPlatformRole(admin, 'user');
      try {
        await expect(
          authenticateHandle(pool, issued.token, { publicKey }, 'source'),
        ).rejects.toBeInstanceOf(HandleRevoked);
        const thrown = await dispatchCapability({ pool }, caller, 'list_skills', {}).then(
          () => null,
          (err: unknown) => err,
        );
        expect(thrown).toBeInstanceOf(AdminAgentCallRefusedError);
        expect((thrown as AdminAgentCallRefusedError).refusal).toBe('not_platform_admin');
        expect(await lastAudit('list_skills')).toMatchObject({
          sessionKind: 'admin_agent',
          outcome: 'refused',
          refusal: { reason: 'not_platform_admin' },
        });
        expect(await issueRefusal(adminPrincipalId)).toBe('not_platform_admin');
      } finally {
        await setPlatformRole(admin, 'admin');
      }
      await expect(dispatchCapability({ pool }, caller, 'list_skills', {})).resolves.toBeDefined();
    });

    it('update_user demotion revokes the admin agent at once, and a new one gets a new session', async () => {
      const issued = await issue(adminPrincipalId);
      await dispatchCapability({ pool }, platformCaller(otherAdmin), 'update_user', {
        userId: admin.id,
        platformRole: 'user',
      });
      try {
        const handle = await withAdminClient(pool, (client) =>
          client.query<{ revoked_at: Date | null; status: string }>(
            `select h.revoked_at, s.status from capability_handles h
               join sessions s on s.id = h.session_id where h.jti = $1`,
            [issued.jti],
          ),
        );
        expect(handle.rows[0]?.revoked_at).not.toBeNull();
        expect(handle.rows[0]?.status).toBe('revoked');
      } finally {
        await dispatchCapability({ pool }, platformCaller(otherAdmin), 'update_user', {
          userId: admin.id,
          platformRole: 'admin',
        });
      }
      await expect(
        authenticateHandle(pool, issued.token, { publicKey }, 'source'),
      ).rejects.toBeInstanceOf(HandleRevoked);
      expect((await issue(adminPrincipalId)).sessionId).not.toBe(issued.sessionId);
    });

    it('with the switch off, issues nothing and refuses every call of a Handle already issued', async () => {
      const issued = await issue(adminPrincipalId);
      const caller = await agentCaller(issued.token);
      process.env.ADMIN_AGENT_ENABLED = '0';
      try {
        expect(await issueRefusal(adminPrincipalId)).toBe('switched_off');
        await expect(
          authenticateHandle(pool, issued.token, { publicKey }, 'source'),
        ).rejects.toBeInstanceOf(HandleRevoked);
        const thrown = await dispatchCapability({ pool }, caller, 'list_skills', {}).then(
          () => null,
          (err: unknown) => err,
        );
        expect((thrown as AdminAgentCallRefusedError).refusal).toBe('switched_off');
      } finally {
        process.env.ADMIN_AGENT_ENABLED = '1';
      }
    });

    it('refuses a non-administrator, a service or agent Principal, a disabled user and a disabled Principal', async () => {
      const tag = randomUUID().slice(0, 8);
      const plain = await createUser(pool, { login: `aa1-plain-${tag}`, displayName: 'Plain' });
      expect(await issueRefusal(await insertPrincipal('human', 'owner', plain.id))).toBe(
        'not_platform_admin',
      );
      expect(await issueRefusal(await insertPrincipal('service', 'owner', null))).toBe(
        'not_a_person',
      );
      expect(await issueRefusal(await insertPrincipal('agent', 'owner', null))).toBe(
        'not_a_person',
      );
      expect(await issueRefusal(randomUUID())).toBe('unknown_principal');

      const gone = await createUser(pool, {
        login: `aa1-gone-${tag}`,
        displayName: 'Gone',
        platformRole: 'admin',
      });
      const goneId = await insertPrincipal('human', 'owner', gone.id);
      await withAdminClient(pool, (client) =>
        client.query("update users set status = 'disabled' where id = $1", [gone.id]),
      );
      expect(await issueRefusal(goneId)).toBe('user_disabled');

      const paused = await createUser(pool, {
        login: `aa1-paused-${tag}`,
        displayName: 'Paused',
        platformRole: 'admin',
      });
      const pausedId = await insertPrincipal('human', 'owner', paused.id);
      await withAdminClient(pool, (client) =>
        client.query('update principals set disabled_at = now() where id = $1', [pausedId]),
      );
      expect(await issueRefusal(pausedId)).toBe('principal_disabled');
    });

    it('an administrator who is an auditor in the workspace gets the ceiling narrowed to the auditor’s reads', async () => {
      const tag = randomUUID().slice(0, 8);
      const member = await createUser(pool, {
        login: `aa1-member-${tag}`,
        displayName: 'Member Admin',
        platformRole: 'admin',
      });
      const memberId = await insertPrincipal('human', 'auditor', member.id);
      const issued = await issue(memberId);
      const { claims } = (await agentCaller(issued.token)) as { claims: HandleClaims };
      expect(claims.scope.capabilities).not.toContain('<gate>.<op>');
      expect(claims.scope.capabilities).toContain('list_skills');
    });

    it('legacy 407: a ChangePlan segment is applied and rolled back by a person only, whatever the caller casts', async () => {
      const serviceId = await insertPrincipal('service', 'owner', null);
      const segment = {
        source: { kind: 'pack' as const, name: 'aa1', version: '1', digest: 'sha256:aa1' },
        items: [],
        reviewedDigest: 'sha256:aa1',
        confirmedOrdinals: [],
      };
      await expect(
        withWorkspace(pool, { workspaceId, principalId: serviceId }, (client) =>
          applyWorkspaceSegment(client, workspaceId, {
            ...segment,
            proposedBy: serviceId,
            appliedBy: serviceId,
            channel: 'human',
          }),
        ),
      ).rejects.toBeInstanceOf(ChangeApplierNotAPersonError);
      await expect(
        withWorkspace(pool, { workspaceId, principalId: adminPrincipalId }, (client) =>
          applyWorkspaceSegment(client, workspaceId, {
            ...segment,
            proposedBy: adminPrincipalId,
            appliedBy: adminPrincipalId,
            channel: 'handle' as unknown as 'human',
          }),
        ),
      ).rejects.toBeInstanceOf(ChangeApplierNotAPersonError);
      for (const [rolledBackBy, channel] of [
        [serviceId, 'human'],
        [adminPrincipalId, 'handle'],
      ] as const) {
        await expect(
          withWorkspace(pool, { workspaceId, principalId: rolledBackBy }, (client) =>
            rollBackWorkspaceSegment(client, workspaceId, {
              segmentId: randomUUID(),
              rolledBackBy,
              channel: channel as 'human',
              confirmedOrdinals: [],
            }),
          ),
        ).rejects.toBeInstanceOf(ChangeApplierNotAPersonError);
      }

      // And a service Principal's API key is refused at dispatch, before any of it.
      const service = personCaller(serviceId, 'service');
      for (const name of [
        'install_pack',
        'install_module',
        'upgrade_module',
        'roll_back_change_segment',
        'verify_change_segment',
      ]) {
        await expect(dispatchCapability({ pool }, service, name, {}), name).rejects.toThrow(
          'made only for a person',
        );
      }
    });
  },
);
