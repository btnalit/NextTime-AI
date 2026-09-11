import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Role } from '@nexttime/shared';
import { generateKeyPair } from 'jose';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { HandleRevoked, entryScope, issueHandle } from '../../governance/capability/index.js';
import { HANDLE_SIGNING_ALG } from '../../governance/capability/keys.js';
import { registerGatekeeper } from '../../governance/gatekeepers/index.js';
import { queryAudit } from '../../substrate/audit/index.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { createUser } from '../identity/index.js';
import { authenticateHuman, hashApiKey } from './auth.js';
import { ForbiddenError } from './authorize.js';
import { dispatchCapability } from './dispatch.js';
import { setGatekeeperReadHandlerDeps } from './gatekeeper-read-handlers.js';
import { authenticateHandle } from './handle-auth.js';
import {
  AlreadyMemberError,
  MemberUserNotFoundError,
  PrincipalNotFoundError,
  PrincipalOperationRefusedError,
} from './members-handlers.js';
import { ModelsCatalogUnavailableError } from './models-catalog-handler.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * application/gateway/members-flow.integration.test: DB-gated (real Postgres; auto-skip without
 * DATABASE_URL, same `describe.runIf` pattern as connection-flow.integration.test.ts) end-to-end
 * coverage for the S3.11 control-plane capabilities (docs/development-tasks.md "中台控制面"):
 * Principal CRUD (create/rotate/disable/set-role) and the read-side directories (grants/policies/
 * quotas/gatekeepers/operations/workspace/models).
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

function humanCaller(workspaceId: string, principalId: string, role: Role): ResolvedCaller {
  return {
    channel: 'human',
    principal: { workspaceId, id: principalId, kind: 'human', role, displayName: null },
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

/** Every `public`-schema base table — the "grep every kernel table" proof (same helper shape as
 *  connection-flow.integration.test.ts's own) that `dispatchCapability`'s audit write never
 *  captures a plaintext API key: `create_principal`/`rotate_api_key` return it only in the
 *  handler *result*, and dispatch.ts audits `params`, never `result` (dispatch.ts's own module
 *  doc comment). */
async function listPublicTables(pool: Pool): Promise<readonly string[]> {
  const client = await pool.connect();
  try {
    const result = await client.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'",
    );
    return result.rows.map((row) => row.table_name);
  } finally {
    client.release();
  }
}

async function tableContainsSubstring(pool: Pool, table: string, needle: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `select 1 from "${table}" where "${table}"::text ilike $1 limit 1`,
      [`%${needle}%`],
    );
    return (result.rowCount ?? 0) > 0;
  } finally {
    client.release();
  }
}

describe.runIf(DATABASE_URL !== undefined)(
  'S3.11 control-plane capabilities (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;

    async function adminInsertWorkspace(name: string): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId: id, principalId: randomUUID() },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [id, name]);
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    async function adminInsertPrincipal(
      ws: string,
      role: string,
      displayName: string,
      kind: 'human' | 'agent' | 'service' = 'human',
      apiKey?: string,
    ): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId: ws, principalId: id },
        async (client) => {
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name, api_key_hash)
             values ($1, $2, $3, $4, $5, $6)`,
            [ws, id, kind, role, displayName, apiKey ? hashApiKey(apiKey) : null],
          );
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    /** Sets up an `entry` session + a real, verifiable Handle for `principalId`, using an
     *  ephemeral EdDSA keypair (no dependency on real HANDLE_PRIVATE_KEY_FILE config) — the exact
     *  shape `disable_principal`'s own acceptance criterion ("entry Handle revoked") needs to
     *  observe. Returns the signed token, the session id, and the minted Handle's `jti`. */
    async function issueEntryHandle(
      ws: string,
      principalId: string,
      keyPair: Awaited<ReturnType<typeof generateKeyPair>>,
    ): Promise<{ token: string; jti: string }> {
      return withWorkspace(
        pool,
        { workspaceId: ws, principalId },
        async (client) => {
          const sessionResult = await client.query<{ id: string }>(
            `insert into sessions (workspace_id, principal_id, kind, on_behalf_of, status)
             values ($1, $2, 'entry', $2, 'active') returning id`,
            [ws, principalId],
          );
          const sessionId = sessionResult.rows[0]?.id;
          if (!sessionId) throw new Error('issueEntryHandle: failed to insert entry session');
          const issued = await issueHandle(client, {
            sessionId,
            scope: entryScope(),
            ttlSeconds: 3600,
            privateKey: keyPair.privateKey,
          });
          return { token: issued.token, jti: issued.jti };
        },
        { skipRoleSwitch: true },
      );
    }

    /** Seeds one `action_requests` row directly (bypasses the governed `requestAction`/`decide.ts`
     *  flow — this test only exercises `get_operation_stats`'s own read-side aggregation, not the
     *  state machine that produces these rows in production) — satisfies that table's own CHECK
     *  constraints (migrations/governance/0003_action_requests.sql): every non-`proposed` status
     *  needs `policyDecision` set, and `approved`/`rejected` additionally need a real
     *  `approvalDecisionId` (a `decisions` row — see `adminInsertDecision` below). */
    async function adminInsertActionRequest(params: {
      gatekeeperId: string;
      actionKind: string;
      status: string;
      policyDecision: string;
      approvalDecisionId?: string;
      requestedAt: Date;
    }): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query(
            `insert into action_requests
               (workspace_id, id, status, gatekeeper_id, action_kind, resource_scope, blast_radius,
                policy_decision, approval_decision_id, await_decision, on_behalf_of, actor_runtime,
                requested_at)
             values ($1, $2, $3, $4::uuid, $5, $4::text, 'low', $6, $7, false, $8, 'human', $9)`,
            [
              workspaceId,
              id,
              params.status,
              params.gatekeeperId,
              params.actionKind,
              params.policyDecision,
              params.approvalDecisionId ?? null,
              ownerId,
              params.requestedAt,
            ],
          );
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    /** A minimal `decisions` row — `action_requests`'s own `approval_decision_id` FK target for a
     *  seeded `approved`/`rejected` row above; needs a real `activities` row of its own
     *  (`decisions.activity_id` is `not null`). */
    async function adminInsertDecision(status: 'approved' | 'rejected'): Promise<string> {
      return withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const activity = await startActivity(client, workspaceId, {
            kind: 'test.get_operation_stats_decision',
            principalId: ownerId,
          });
          const result = await client.query<{ id: string }>(
            `insert into decisions (workspace_id, status, activity_id, decided_by, decided_at)
             values ($1, $2, $3, $4, now()) returning id`,
            [workspaceId, status, activity.id, ownerId],
          );
          const row = result.rows[0];
          if (!row) throw new Error('adminInsertDecision: INSERT ... RETURNING produced no row');
          return row.id;
        },
        { skipRoleSwitch: true },
      );
    }

    async function adminRegisterGatekeeper(name: string): Promise<string> {
      return withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
        const activity = await startActivity(client, workspaceId, {
          kind: 'test.register_gatekeeper',
          principalId: ownerId,
        });
        const { gatekeeperId } = await registerGatekeeper(client, workspaceId, {
          name,
          transportKind: 'http',
          target: `members-flow-test-system-${name}`,
          endpoint: `https://gate.members-flow-test.invalid/${name}`,
          activityId: activity.id,
          registeredBy: { id: ownerId, kind: 'human' },
        });
        return gatekeeperId;
      });
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = await adminInsertWorkspace('members-flow-test-workspace');
      ownerId = await adminInsertPrincipal(workspaceId, 'owner', 'owner');
    });

    afterAll(async () => {
      await pool.end();
    });

    it('create_principal returns a key that authenticates once; the audit trail never stores it', async () => {
      const owner = humanCaller(workspaceId, ownerId, 'owner');

      const created = (await dispatchCapability({ pool }, owner, 'create_principal', {
        role: 'member',
        displayName: 'Bob',
      })) as { principal: { id: string; kind: string; hasApiKey: boolean }; apiKey: string };

      // P-A1 (docs/platform-admin-design.md §5): `create_principal` now always mints a `service`
      // Principal — a human Principal is a platform user's membership (`add_member`/
      // `add_membership`), never this capability.
      expect(created.principal.kind).toBe('service');
      expect(created.principal.hasApiKey).toBe(true);
      expect(typeof created.apiKey).toBe('string');
      expect(created.apiKey.length).toBeGreaterThan(0);

      const authed = await authenticateHuman(pool, created.apiKey);
      expect(authed?.principal.id).toBe(created.principal.id);

      // dispatch.ts's audit write is automatic for every capability — confirm it actually ran
      // for this one (a row exists, params recorded) and that it never captured `result`, only
      // `params` (dispatch.ts's own module doc comment), so the key never reaches it either way.
      const auditRows = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        queryAudit(client, workspaceId, {
          action: 'create_principal',
          resourceId: created.principal.id,
        }),
      );
      expect(auditRows.length).toBeGreaterThan(0);
      expect(JSON.stringify(auditRows[0]?.payload)).not.toContain(created.apiKey);

      const tables = await listPublicTables(pool);
      for (const table of tables) {
        expect(await tableContainsSubstring(pool, table, created.apiKey)).toBe(false);
      }
    });

    it('add_member: creates a human Principal linked to that platform user by login, no API key', async () => {
      const owner = humanCaller(workspaceId, ownerId, 'owner');
      const login = `add-member-${randomUUID().slice(0, 8)}`;
      const user = await createUser(pool, {
        login,
        displayName: 'Add Member Fixture',
        password: 'correct horse battery staple',
      });

      const membership = (await dispatchCapability({ pool }, owner, 'add_member', {
        login,
        role: 'member',
      })) as { id: string; kind: string; role: string; hasApiKey: boolean };

      expect(membership.kind).toBe('human');
      expect(membership.role).toBe('member');
      expect(membership.hasApiKey).toBe(false);

      const principalRow = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        (client) =>
          client.query<{ user_id: string | null }>(
            'select user_id from principals where workspace_id = $1 and id = $2',
            [workspaceId, membership.id],
          ),
      );
      expect(principalRow.rows[0]?.user_id).toBe(user.id);
    });

    it('add_member: an unknown login → 404 user_not_found', async () => {
      const owner = humanCaller(workspaceId, ownerId, 'owner');
      await expect(
        dispatchCapability({ pool }, owner, 'add_member', {
          login: `no-such-login-${randomUUID().slice(0, 8)}`,
          role: 'member',
        }),
      ).rejects.toThrow(MemberUserNotFoundError);
    });

    it('add_member: a repeat add → 409 already_member', async () => {
      const owner = humanCaller(workspaceId, ownerId, 'owner');
      const login = `add-member-dup-${randomUUID().slice(0, 8)}`;
      await createUser(pool, {
        login,
        displayName: 'Add Member Dup Fixture',
        password: 'correct horse battery staple',
      });

      await dispatchCapability({ pool }, owner, 'add_member', { login, role: 'member' });
      await expect(
        dispatchCapability({ pool }, owner, 'add_member', { login, role: 'member' }),
      ).rejects.toThrow(AlreadyMemberError);
    });

    it('rotate_api_key: self-service invalidates the old key immediately and issues a new one', async () => {
      const oldKey = `key-${randomUUID()}`;
      const memberId = await adminInsertPrincipal(workspaceId, 'member', 'Carol', 'human', oldKey);
      const memberCaller = humanCaller(workspaceId, memberId, 'member');

      const rotated = (await dispatchCapability({ pool }, memberCaller, 'rotate_api_key', {
        principalId: memberId,
      })) as { principalId: string; apiKey: string };

      expect(rotated.principalId).toBe(memberId);
      expect(await authenticateHuman(pool, oldKey)).toBeNull();
      expect((await authenticateHuman(pool, rotated.apiKey))?.principal.id).toBe(memberId);
    });

    it('rotate_api_key: a non-owner cannot rotate another principal’s key (403)', async () => {
      const key1 = `key-${randomUUID()}`;
      const member1 = await adminInsertPrincipal(workspaceId, 'member', 'Dan', 'human', key1);
      const member2 = await adminInsertPrincipal(workspaceId, 'member', 'Eve', 'human');
      const member1Caller = humanCaller(workspaceId, member1, 'member');

      await expect(
        dispatchCapability({ pool }, member1Caller, 'rotate_api_key', { principalId: member2 }),
      ).rejects.toThrow(ForbiddenError);
      // the untouched principal's own key still authenticates — nothing changed under refusal.
      expect((await authenticateHuman(pool, key1))?.principal.id).toBe(member1);
    });

    it('rotate_api_key/set_principal_role/disable_principal refuse a non-human principal target', async () => {
      const agentId = await adminInsertPrincipal(workspaceId, 'member', 'Agent X', 'agent');
      const owner = humanCaller(workspaceId, ownerId, 'owner');

      await expect(
        dispatchCapability({ pool }, owner, 'set_principal_role', {
          principalId: agentId,
          role: 'operator',
        }),
      ).rejects.toThrow(PrincipalOperationRefusedError);
      await expect(
        dispatchCapability({ pool }, owner, 'rotate_api_key', { principalId: agentId }),
      ).rejects.toThrow(PrincipalOperationRefusedError);
      await expect(
        dispatchCapability({ pool }, owner, 'disable_principal', { principalId: agentId }),
      ).rejects.toThrow(PrincipalOperationRefusedError);
    });

    it('a not-found principalId → PrincipalNotFoundError (404 family) for every member-management capability', async () => {
      const owner = humanCaller(workspaceId, ownerId, 'owner');
      const missingId = randomUUID();

      await expect(
        dispatchCapability({ pool }, owner, 'set_principal_role', {
          principalId: missingId,
          role: 'member',
        }),
      ).rejects.toThrow(PrincipalNotFoundError);
      await expect(
        dispatchCapability({ pool }, owner, 'disable_principal', { principalId: missingId }),
      ).rejects.toThrow(PrincipalNotFoundError);
    });

    it('disable_principal: 401 on the old API key, the entry Handle revoked, and refuses self-disable', async () => {
      const key = `key-${randomUUID()}`;
      const targetId = await adminInsertPrincipal(workspaceId, 'member', 'Frank', 'human', key);
      const keyPair = await generateKeyPair(HANDLE_SIGNING_ALG, {
        crv: 'Ed25519',
        extractable: true,
      });
      const { token, jti } = await issueEntryHandle(workspaceId, targetId, keyPair);

      // Sanity: the Handle verifies before the disable.
      await expect(
        authenticateHandle(pool, token, { publicKey: keyPair.publicKey }),
      ).resolves.toMatchObject({ obo: targetId });

      const owner = humanCaller(workspaceId, ownerId, 'owner');

      // Refuses disabling oneself, independent of the target-under-test.
      await expect(
        dispatchCapability({ pool }, owner, 'disable_principal', { principalId: ownerId }),
      ).rejects.toThrow(PrincipalOperationRefusedError);

      const disabled = (await dispatchCapability({ pool }, owner, 'disable_principal', {
        principalId: targetId,
      })) as { id: string; disabledAt: string | null };
      expect(disabled.id).toBe(targetId);
      expect(disabled.disabledAt).not.toBeNull();

      // 401 on the old API key.
      expect(await authenticateHuman(pool, key)).toBeNull();

      // The entry Handle is revoked — both directly (capability_handles.revoked_at) and via
      // authenticateHandle's own belt-and-suspenders disabled-principal check.
      const revokedRow = await pool.query<{ revoked_at: Date | null }>(
        'select revoked_at from capability_handles where jti = $1',
        [jti],
      );
      expect(revokedRow.rows[0]?.revoked_at).not.toBeNull();
      await expect(
        authenticateHandle(pool, token, { publicKey: keyPair.publicKey }),
      ).rejects.toThrow(HandleRevoked);
    });

    /** Mirrors `issue-handle-handler.ts`'s own `kind='mcp_session'` session + Handle issuance,
     *  the shape `revokeRoleScopedSessionHandles` (governance/capability/handles.ts, W5.5 review
     *  fix) must also reach — unlike `revokeEntrySessionHandles`, which is `kind='entry'` only. */
    async function issueMcpSessionHandle(
      ws: string,
      principalId: string,
      keyPair: Awaited<ReturnType<typeof generateKeyPair>>,
    ): Promise<{ token: string; jti: string }> {
      return withWorkspace(
        pool,
        { workspaceId: ws, principalId },
        async (client) => {
          const sessionResult = await client.query<{ id: string }>(
            `insert into sessions (workspace_id, principal_id, kind, on_behalf_of, status)
             values ($1, $2, 'mcp_session', $2, 'active') returning id`,
            [ws, principalId],
          );
          const sessionId = sessionResult.rows[0]?.id;
          if (!sessionId) throw new Error('issueMcpSessionHandle: failed to insert mcp_session');
          const issued = await issueHandle(client, {
            sessionId,
            scope: entryScope(),
            ttlSeconds: 3600,
            privateKey: keyPair.privateKey,
          });
          return { token: issued.token, jti: issued.jti };
        },
        { skipRoleSwitch: true },
      );
    }

    it('set_principal_role: an actual role change revokes both the target’s entry and mcp_session Handles, but not another principal’s (W5.5, STATUS leftover 18)', async () => {
      const targetId = await adminInsertPrincipal(workspaceId, 'member', 'Grace');
      const otherId = await adminInsertPrincipal(workspaceId, 'member', 'Ivan');
      const keyPair = await generateKeyPair(HANDLE_SIGNING_ALG, {
        crv: 'Ed25519',
        extractable: true,
      });
      const { token, jti } = await issueEntryHandle(workspaceId, targetId, keyPair);
      const { token: mcpToken, jti: mcpJti } = await issueMcpSessionHandle(
        workspaceId,
        targetId,
        keyPair,
      );
      const { token: otherToken } = await issueEntryHandle(workspaceId, otherId, keyPair);

      // Sanity: all three Handles verify before the role change.
      await expect(
        authenticateHandle(pool, token, { publicKey: keyPair.publicKey }),
      ).resolves.toMatchObject({ obo: targetId });
      await expect(
        authenticateHandle(pool, mcpToken, { publicKey: keyPair.publicKey }),
      ).resolves.toMatchObject({ obo: targetId });
      await expect(
        authenticateHandle(pool, otherToken, { publicKey: keyPair.publicKey }),
      ).resolves.toMatchObject({ obo: otherId });

      const owner = humanCaller(workspaceId, ownerId, 'owner');
      const updated = (await dispatchCapability({ pool }, owner, 'set_principal_role', {
        principalId: targetId,
        role: 'builder',
      })) as { role: string };
      expect(updated.role).toBe('builder');

      // Both the entry and mcp_session Handles are revoked — directly (capability_handles.
      // revoked_at) and via authenticateHandle's own verification path (mirrors
      // disable_principal's own assertion above; here the *role*, not disabled_at, is what
      // changed).
      const revokedRows = await pool.query<{ jti: string; revoked_at: Date | null }>(
        'select jti, revoked_at from capability_handles where jti = any($1)',
        [[jti, mcpJti]],
      );
      expect(revokedRows.rows).toHaveLength(2);
      for (const row of revokedRows.rows) {
        expect(row.revoked_at, `expected jti ${row.jti} to be revoked`).not.toBeNull();
      }
      await expect(
        authenticateHandle(pool, token, { publicKey: keyPair.publicKey }),
      ).rejects.toThrow(HandleRevoked);
      await expect(
        authenticateHandle(pool, mcpToken, { publicKey: keyPair.publicKey }),
      ).rejects.toThrow(HandleRevoked);

      // A different principal's Handle is untouched.
      await expect(
        authenticateHandle(pool, otherToken, { publicKey: keyPair.publicKey }),
      ).resolves.toMatchObject({ obo: otherId });
    });

    it('set_principal_role: setting the same role is a no-op and does not revoke the target’s entry Handle', async () => {
      const targetId = await adminInsertPrincipal(workspaceId, 'member', 'Heidi');
      const keyPair = await generateKeyPair(HANDLE_SIGNING_ALG, {
        crv: 'Ed25519',
        extractable: true,
      });
      const { token } = await issueEntryHandle(workspaceId, targetId, keyPair);

      const owner = humanCaller(workspaceId, ownerId, 'owner');
      const updated = (await dispatchCapability({ pool }, owner, 'set_principal_role', {
        principalId: targetId,
        role: 'member',
      })) as { role: string };
      expect(updated.role).toBe('member');

      // Same role in, same role out — the Handle issued under that (unchanged) role stays valid.
      await expect(
        authenticateHandle(pool, token, { publicKey: keyPair.publicKey }),
      ).resolves.toMatchObject({ obo: targetId });
    });

    it('last-owner protection: refuses demoting or disabling the sole active owner, but allows it once a second owner exists', async () => {
      const soloWs = await adminInsertWorkspace('members-flow-last-owner-workspace');
      const soloOwnerId = await adminInsertPrincipal(soloWs, 'owner', 'Solo Owner');
      const soloOwner = humanCaller(soloWs, soloOwnerId, 'owner');

      await expect(
        dispatchCapability({ pool }, soloOwner, 'set_principal_role', {
          principalId: soloOwnerId,
          role: 'member',
        }),
      ).rejects.toThrow(PrincipalOperationRefusedError);
      await expect(
        dispatchCapability({ pool }, soloOwner, 'disable_principal', { principalId: soloOwnerId }),
      ).rejects.toThrow(PrincipalOperationRefusedError);

      // A second owner exists — demoting the first is now allowed.
      const secondOwnerId = await adminInsertPrincipal(soloWs, 'owner', 'Second Owner');
      const secondOwnerCaller = humanCaller(soloWs, secondOwnerId, 'owner');
      const demoted = (await dispatchCapability({ pool }, secondOwnerCaller, 'set_principal_role', {
        principalId: soloOwnerId,
        role: 'member',
      })) as { role: string };
      expect(demoted.role).toBe('member');

      // Now the second owner is the sole active one again — disabling them is refused.
      await expect(
        dispatchCapability({ pool }, secondOwnerCaller, 'disable_principal', {
          principalId: secondOwnerId,
        }),
      ).rejects.toThrow(PrincipalOperationRefusedError);
    });

    it('list_principals: {items}, includes disabled principals with disabledAt set', async () => {
      const owner = humanCaller(workspaceId, ownerId, 'owner');
      const listed = (await dispatchCapability({ pool }, owner, 'list_principals', {})) as {
        items: readonly { id: string; disabledAt: string | null }[];
      };
      expect(Array.isArray(listed.items)).toBe(true);
      expect(listed.items.some((p) => p.id === ownerId)).toBe(true);
      // At least one disabled principal from the earlier test in this file remains listed.
      expect(listed.items.some((p) => p.disabledAt !== null)).toBe(true);
    });

    it('list_grants / list_policies / list_quotas: {items} envelopes over an operator caller', async () => {
      const operatorId = await adminInsertPrincipal(workspaceId, 'operator', 'Grace');
      const operatorCaller = humanCaller(workspaceId, operatorId, 'operator');

      const grants = (await dispatchCapability({ pool }, operatorCaller, 'list_grants', {})) as {
        items: readonly unknown[];
      };
      expect(Array.isArray(grants.items)).toBe(true);

      const policies = (await dispatchCapability(
        { pool },
        operatorCaller,
        'list_policies',
        {},
      )) as {
        items: readonly unknown[];
      };
      expect(Array.isArray(policies.items)).toBe(true);

      const quotas = (await dispatchCapability({ pool }, operatorCaller, 'list_quotas', {})) as {
        items: readonly { key: string; isDefault: boolean }[];
      };
      expect(quotas.items.length).toBeGreaterThan(0);
      expect(quotas.items.every((entry) => entry.isDefault)).toBe(true);
    });

    it('list_gatekeepers / get_gatekeeper / list_operations: shapes match, health probe never throws', async () => {
      const owner = humanCaller(workspaceId, ownerId, 'owner');

      const activity = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        startActivity(client, workspaceId, {
          kind: 'test.register_gatekeeper',
          principalId: ownerId,
        }),
      );
      const { gatekeeperId } = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        (client) =>
          registerGatekeeper(client, workspaceId, {
            name: 'members-flow-test-gate',
            transportKind: 'http',
            target: 'members-flow-test-system',
            endpoint: 'https://gate.members-flow-test.invalid',
            activityId: activity.id,
            registeredBy: { id: ownerId, kind: 'human' },
          }),
      );

      // Never make a real network call for the health probe — inject a fake client that always
      // reports 'ok', matching the capability's own "never throw on failure" contract without a
      // real gate process in this test.
      setGatekeeperReadHandlerDeps({
        gatekeeperClient: {
          describeOperations: async () => ({ operations: [] }),
          observe: async () => ({ data: null }),
          simulate: async () => ({ description: 'no-op (test fake)' }),
          apply: async () => ({ data: null, replayed: false }),
          revert: async () => ({ data: null }),
          health: async () => ({ status: 'ok' }),
          storeConnectedAccount: async () => {},
          deleteConnectedAccount: async () => {},
        },
      });

      const listed = (await dispatchCapability({ pool }, owner, 'list_gatekeepers', {})) as {
        items: readonly { id: string; operationCount: number }[];
      };
      expect(listed.items.some((g) => g.id === gatekeeperId)).toBe(true);

      const got = (await dispatchCapability({ pool }, owner, 'get_gatekeeper', {
        gatekeeperId,
      })) as { id: string; health: string; operations: readonly unknown[] };
      expect(got.id).toBe(gatekeeperId);
      expect(got.health).toBe('ok');
      expect(Array.isArray(got.operations)).toBe(true);

      const ops = (await dispatchCapability({ pool }, owner, 'list_operations', {
        gatekeeperId,
      })) as { items: readonly unknown[] };
      expect(Array.isArray(ops.items)).toBe(true);
    });

    it('get_operation_stats: aggregates seeded action_requests by current status within the days window, filterable by gatekeeperId', async () => {
      const owner = humanCaller(workspaceId, ownerId, 'owner');
      const gateA = await adminRegisterGatekeeper('get-operation-stats-gate-a');
      const gateB = await adminRegisterGatekeeper('get-operation-stats-gate-b');
      const now = new Date();
      const days45Ago = new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000);

      const approvedDecisionId = await adminInsertDecision('approved');
      const rejectedDecisionId = await adminInsertDecision('rejected');

      // gateA / opA: one row each of auto_approved / approved / rejected / failed / pending_approval
      // (5 calls total; pending_approval counts toward `calls` but none of the four named buckets),
      // plus one auto_approved row 45 days back — outside the default 30-day window, inside a 60-day
      // one.
      await adminInsertActionRequest({
        gatekeeperId: gateA,
        actionKind: 'opA',
        status: 'auto_approved',
        policyDecision: 'allow',
        requestedAt: now,
      });
      await adminInsertActionRequest({
        gatekeeperId: gateA,
        actionKind: 'opA',
        status: 'approved',
        policyDecision: 'require_approval',
        approvalDecisionId: approvedDecisionId,
        requestedAt: now,
      });
      await adminInsertActionRequest({
        gatekeeperId: gateA,
        actionKind: 'opA',
        status: 'rejected',
        policyDecision: 'require_approval',
        approvalDecisionId: rejectedDecisionId,
        requestedAt: now,
      });
      await adminInsertActionRequest({
        gatekeeperId: gateA,
        actionKind: 'opA',
        status: 'failed',
        policyDecision: 'allow',
        requestedAt: now,
      });
      await adminInsertActionRequest({
        gatekeeperId: gateA,
        actionKind: 'opA',
        status: 'pending_approval',
        policyDecision: 'require_approval',
        requestedAt: now,
      });
      await adminInsertActionRequest({
        gatekeeperId: gateA,
        actionKind: 'opA',
        status: 'auto_approved',
        policyDecision: 'allow',
        requestedAt: days45Ago,
      });

      // gateB / opB: one `executed` row — proves a status outside the four named buckets still
      // counts toward `calls` without polluting approved/rejected/autoApproved/failed.
      await adminInsertActionRequest({
        gatekeeperId: gateB,
        actionKind: 'opB',
        status: 'executed',
        policyDecision: 'allow',
        requestedAt: now,
      });

      type OperationStatsWire = {
        gatekeeperId: string;
        operationName: string;
        calls: number;
        approved: number;
        rejected: number;
        autoApproved: number;
        failed: number;
        lastCalledAt: string;
      };

      const defaultWindow = (await dispatchCapability(
        { pool },
        owner,
        'get_operation_stats',
        {},
      )) as { items: readonly OperationStatsWire[] };
      const opAStats = defaultWindow.items.find(
        (item) => item.gatekeeperId === gateA && item.operationName === 'opA',
      );
      expect(opAStats).toBeDefined();
      expect(opAStats).toMatchObject({
        calls: 5,
        approved: 1,
        rejected: 1,
        autoApproved: 1,
        failed: 1,
      });
      expect(new Date(opAStats?.lastCalledAt ?? 0).getTime()).toBeGreaterThanOrEqual(
        now.getTime() - 1000,
      );

      const opBStats = defaultWindow.items.find(
        (item) => item.gatekeeperId === gateB && item.operationName === 'opB',
      );
      expect(opBStats).toMatchObject({
        calls: 1,
        approved: 0,
        rejected: 0,
        autoApproved: 0,
        failed: 0,
      });

      // days=60 pulls the 45-day-old row back into the window.
      const widerWindow = (await dispatchCapability({ pool }, owner, 'get_operation_stats', {
        days: 60,
      })) as { items: readonly OperationStatsWire[] };
      const opAWider = widerWindow.items.find(
        (item) => item.gatekeeperId === gateA && item.operationName === 'opA',
      );
      expect(opAWider?.calls).toBe(6);
      expect(opAWider?.autoApproved).toBe(2);

      // gatekeeperId filters to just that gate.
      const scoped = (await dispatchCapability({ pool }, owner, 'get_operation_stats', {
        gatekeeperId: gateB,
      })) as { items: readonly OperationStatsWire[] };
      expect(scoped.items.every((item) => item.gatekeeperId === gateB)).toBe(true);
      expect(scoped.items.some((item) => item.gatekeeperId === gateA)).toBe(false);
    });

    it('get_workspace: id/name/counts, plus the resolved caller (no re-query by API key)', async () => {
      const owner = humanCaller(workspaceId, ownerId, 'owner');
      const ws = (await dispatchCapability({ pool }, owner, 'get_workspace', {})) as {
        id: string;
        name: string;
        principalCount: number;
        gatekeeperCount: number;
        caller: { id: string; role: string; displayName: string | null; kind: string };
      };
      expect(ws.id).toBe(workspaceId);
      expect(ws.principalCount).toBeGreaterThan(0);
      expect(ws.gatekeeperCount).toBeGreaterThanOrEqual(0);
      expect(ws.caller).toEqual({
        id: ownerId,
        role: 'owner',
        displayName: null,
        kind: 'human',
      });

      // A member caller sees themselves, not the owner — proves this is the resolved caller's
      // own identity, not a hardcoded/first-principal read.
      const memberId = await adminInsertPrincipal(workspaceId, 'member', 'Heidi');
      const memberCaller = humanCaller(workspaceId, memberId, 'member');
      const wsAsMember = (await dispatchCapability(
        { pool },
        memberCaller,
        'get_workspace',
        {},
      )) as {
        caller: { id: string; role: string };
      };
      expect(wsAsMember.caller).toEqual(expect.objectContaining({ id: memberId, role: 'member' }));
    });

    describe('list_models', () => {
      let modelsJsonDir: string;
      const originalModelsJsonFile = process.env.MODELS_JSON_FILE;

      afterEach(async () => {
        if (modelsJsonDir) await rm(modelsJsonDir, { recursive: true, force: true });
        if (originalModelsJsonFile === undefined) {
          // biome-ignore lint/performance/noDelete: process.env coerces `= undefined` to the string "undefined" instead of unsetting the var; delete is the only way to make it actually absent.
          delete process.env.MODELS_JSON_FILE;
        } else {
          process.env.MODELS_JSON_FILE = originalModelsJsonFile;
        }
      });

      it('projects providers.<name>.models[].id to {id, provider, model}', async () => {
        modelsJsonDir = await mkdtemp(join(tmpdir(), 'models-json-'));
        const file = join(modelsJsonDir, 'models.json');
        await writeFile(
          file,
          JSON.stringify({
            providers: {
              anthropic: {
                baseUrl: 'http://llm-proxy:8082/anthropic',
                apiKey: '$CAPABILITY_HANDLE',
                api: 'anthropic-messages',
                models: [{ id: 'claude-sonnet-5' }],
              },
            },
          }),
        );
        process.env.MODELS_JSON_FILE = file;

        const owner = humanCaller(workspaceId, ownerId, 'owner');
        const result = (await dispatchCapability({ pool }, owner, 'list_models', {})) as {
          items: readonly { id: string; provider: string; model: string }[];
        };
        expect(result.items).toEqual([
          { id: 'anthropic/claude-sonnet-5', provider: 'anthropic', model: 'claude-sonnet-5' },
        ]);
      });

      it('missing models.json → ModelsCatalogUnavailableError (503 family), never a raw crash', async () => {
        process.env.MODELS_JSON_FILE = join(
          await mkdtemp(join(tmpdir(), 'models-json-missing-')),
          'does-not-exist.json',
        );
        modelsJsonDir = path.dirname(process.env.MODELS_JSON_FILE);

        const owner = humanCaller(workspaceId, ownerId, 'owner');
        await expect(dispatchCapability({ pool }, owner, 'list_models', {})).rejects.toThrow(
          ModelsCatalogUnavailableError,
        );
      });
    });
  },
);
