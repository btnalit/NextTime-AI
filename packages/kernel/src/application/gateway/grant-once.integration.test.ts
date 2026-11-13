import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations, splitSqlStatements } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import {
  ensureCapabilityGrant,
  generateEphemeralHandleKeyPair,
  issueHandle,
  revokeCapabilityGrant,
} from '../../governance/capability/index.js';
import { dispatchCapability } from './dispatch.js';
import {
  humanCaller,
  newWorkspace,
  registerSeededGatekeeper,
  seedWorkspace,
} from './traversal-fixture.js';

/**
 * Legacy 647: a Principal holds one active grant of a scope. Granting what is already held —
 * `grant_capability`, `connect_gatekeeper`, or one after the other — returns the grant held and
 * writes nothing but the call's own audit row, marked `alreadyGranted`
 * (governance/capability/grants.ts `ensureCapabilityGrant`). Behind it,
 * migrations/governance/0041's unique index refuses a second active row however it is written,
 * and the migration refuses to build on a database that already holds one. Revoked and expired
 * grants stay history: granting their scope again creates a new grant.
 *
 * The repeat-call walk (repeat-call.integration.test.ts) checks the same answer for both
 * capabilities through the matrix; this file covers the paths it does not.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const MIGRATION_0041 = path.join(
  MIGRATIONS_DIR,
  'governance',
  '0041_one_active_grant_per_scope.sql',
);

interface GrantWire {
  readonly id: string;
  readonly principalId: string;
  readonly status: string;
}

describe.runIf(DATABASE_URL !== undefined)(
  'granting a scope already held returns the grant held — legacy 647 (integration, real Postgres)',
  () => {
    let pool: Pool;

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
    });

    afterAll(async () => {
      await pool?.end();
    });

    /** A seeded workspace (a registered gate) with an owner and a member. */
    async function workspace(name: string) {
      const created = await newWorkspace(pool, `grant-once-${name}`, ['owner', 'member']);
      const ownerId = created.principals.get('owner') as string;
      const memberId = created.principals.get('member') as string;
      const seed = await seedWorkspace(pool, created.workspaceId, ownerId, `grant-once-${name}`);
      await registerSeededGatekeeper(pool, seed);
      const owner = humanCaller(created.workspaceId, ownerId, 'owner');
      return { workspaceId: created.workspaceId, ownerId, memberId, seed, owner };
    }

    async function grantRows(workspaceId: string, principalId: string) {
      const result = await pool.query<{ id: string; status: string }>(
        `select id, status from capability_grants where workspace_id = $1 and principal_id = $2
         order by created_at, id`,
        [workspaceId, principalId],
      );
      return result.rows;
    }

    async function auditFor(workspaceId: string, action: string) {
      const result = await pool.query<{ payload: Record<string, unknown> }>(
        `select payload from audit_records where workspace_id = $1 and action = $2
         order by created_at, id`,
        [workspaceId, action],
      );
      return result.rows.map((row) => row.payload);
    }

    it('grant_capability twice: the same grant, one row, and the second audit row says it was held', async () => {
      const { workspaceId, ownerId, memberId, seed, owner } = await workspace('twice');
      const params = {
        principalId: memberId,
        resourceType: 'gatekeeper',
        resourceId: seed.gatekeeperId,
      };

      const first = (await dispatchCapability(
        { pool },
        owner,
        'grant_capability',
        params,
      )) as GrantWire;
      const second = (await dispatchCapability(
        { pool },
        owner,
        'grant_capability',
        params,
      )) as GrantWire;

      expect(second).toEqual(first);
      expect(await grantRows(workspaceId, memberId)).toEqual([{ id: first.id, status: 'active' }]);
      const audit = await auditFor(workspaceId, 'grant_capability');
      expect(audit).toHaveLength(2);
      expect(audit[0]?.alreadyGranted).toBeUndefined();
      expect(audit[1]?.alreadyGranted).toBe(true);
      expect(audit[1]?.onBehalfOf).toBe(ownerId);
    });

    it('connect_gatekeeper after grant_capability of the same gate returns that grant', async () => {
      const { workspaceId, memberId, seed, owner } = await workspace('both-entries');

      const granted = (await dispatchCapability({ pool }, owner, 'grant_capability', {
        principalId: memberId,
        resourceType: 'gatekeeper',
        resourceId: seed.gatekeeperId,
      })) as GrantWire;
      const connected = (await dispatchCapability({ pool }, owner, 'connect_gatekeeper', {
        gatekeeperId: seed.gatekeeperId,
        principalId: memberId,
      })) as GrantWire;

      expect(connected.id).toBe(granted.id);
      expect(await grantRows(workspaceId, memberId)).toHaveLength(1);
      expect((await auditFor(workspaceId, 'connect_gatekeeper'))[0]?.alreadyGranted).toBe(true);
    });

    it('a grant revoked does not hold the scope: granting it again creates a new grant', async () => {
      const { workspaceId, memberId, seed, owner } = await workspace('regrant');
      const params = {
        principalId: memberId,
        resourceType: 'gatekeeper',
        resourceId: seed.gatekeeperId,
      };

      const first = (await dispatchCapability(
        { pool },
        owner,
        'grant_capability',
        params,
      )) as GrantWire;
      await dispatchCapability({ pool }, owner, 'revoke_capability', { grantId: first.id });
      const again = (await dispatchCapability(
        { pool },
        owner,
        'grant_capability',
        params,
      )) as GrantWire;

      expect(again.id).not.toBe(first.id);
      expect(again.status).toBe('active');
      expect((await auditFor(workspaceId, 'grant_capability'))[1]?.alreadyGranted).toBeUndefined();
      // And the new grant is the one held: granting once more returns it, never the revoked one
      // (#493 on #1036).
      const held = (await dispatchCapability(
        { pool },
        owner,
        'grant_capability',
        params,
      )) as GrantWire;
      expect(held).toEqual(again);
      expect(await grantRows(workspaceId, memberId)).toEqual([
        { id: first.id, status: 'revoked' },
        { id: again.id, status: 'active' },
      ]);
    });

    it('a grant past its expiry is marked expired, and the scope granted anew', async () => {
      const { workspaceId, ownerId, memberId, seed, owner } = await workspace('expired');
      const ctx = { workspaceId, principalId: ownerId };
      const input = {
        principalId: memberId,
        resourceType: 'gatekeeper',
        resourceId: seed.gatekeeperId,
        grantedBy: ownerId,
      };

      const lapsed = await withWorkspace(pool, ctx, (client) =>
        ensureCapabilityGrant(client, workspaceId, {
          ...input,
          expiresAt: new Date(Date.now() - 60_000),
        }),
      );
      expect(lapsed.created).toBe(true);
      const renewed = (await dispatchCapability({ pool }, owner, 'grant_capability', {
        principalId: memberId,
        resourceType: 'gatekeeper',
        resourceId: seed.gatekeeperId,
      })) as GrantWire;

      expect(renewed.id).not.toBe(lapsed.grant.id);
      expect(await grantRows(workspaceId, memberId)).toEqual([
        { id: lapsed.grant.id, status: 'expired' },
        { id: renewed.id, status: 'active' },
      ]);
      // The transition is on the record: the call's own audit row names the grant it expired.
      const audit = await auditFor(workspaceId, 'grant_capability');
      expect(audit).toHaveLength(1);
      expect(audit[0]?.expiredGrantIds).toEqual([lapsed.grant.id]);
      expect(audit[0]?.alreadyGranted).toBeUndefined();
    });

    it('a grant revoked between the insert and the read: the scope is free, and the insert is tried again', async () => {
      const { workspaceId, ownerId, memberId, seed } = await workspace('revoked-between');
      const ctx = { workspaceId, principalId: ownerId };
      const input = {
        principalId: memberId,
        resourceType: 'gatekeeper',
        resourceId: seed.gatekeeperId,
        grantedBy: ownerId,
      };
      const held = await withWorkspace(pool, ctx, (client) =>
        ensureCapabilityGrant(client, workspaceId, input),
      );

      const outcome = await withWorkspace(pool, ctx, (client) => {
        // The first read after the insert met the held grant: another owner revokes it, and
        // commits, just before the read starts.
        let revoked = false;
        const racing = new Proxy(client, {
          get(target, property) {
            const value = Reflect.get(target, property, target);
            if (property !== 'query') {
              return typeof value === 'function' ? value.bind(target) : value;
            }
            return async (text: unknown, values?: unknown[]) => {
              if (!revoked && typeof text === 'string' && /^\s*select/i.test(text)) {
                revoked = true;
                await withWorkspace(pool, ctx, (other) =>
                  revokeCapabilityGrant(other, workspaceId, held.grant.id),
                );
              }
              return target.query(text as string, values);
            };
          },
        });
        return ensureCapabilityGrant(racing, workspaceId, input);
      });

      expect(outcome.created).toBe(true);
      expect(outcome.grant.id).not.toBe(held.grant.id);
      expect(await grantRows(workspaceId, memberId)).toEqual([
        { id: held.grant.id, status: 'revoked' },
        { id: outcome.grant.id, status: 'active' },
      ]);
    });

    it('a grant not yet expired holds the scope: it comes back as it is', async () => {
      const { workspaceId, ownerId, memberId, seed } = await workspace('expiring');
      const ctx = { workspaceId, principalId: ownerId };
      const expiresAt = new Date(Date.now() + 3_600_000);
      const input = {
        principalId: memberId,
        resourceType: 'gatekeeper',
        resourceId: seed.gatekeeperId,
        grantedBy: ownerId,
      };

      const first = await withWorkspace(pool, ctx, (client) =>
        ensureCapabilityGrant(client, workspaceId, { ...input, expiresAt }),
      );
      const second = await withWorkspace(pool, ctx, (client) =>
        ensureCapabilityGrant(client, workspaceId, input),
      );

      expect(second).toEqual({ grant: first.grant, created: false, expiredGrantIds: [] });
    });

    it('a wildcard scope (no resource id, a historical row shape) is held once too', async () => {
      const { workspaceId, ownerId, memberId } = await workspace('wildcard');
      const ctx = { workspaceId, principalId: ownerId };
      const input = {
        principalId: memberId,
        resourceType: 'e2e.wildcard_kind',
        grantedBy: ownerId,
      };

      const first = await withWorkspace(pool, ctx, (client) =>
        ensureCapabilityGrant(client, workspaceId, input),
      );
      const second = await withWorkspace(pool, ctx, (client) =>
        ensureCapabilityGrant(client, workspaceId, input),
      );

      expect(first.created).toBe(true);
      expect(second).toEqual({ grant: first.grant, created: false, expiredGrantIds: [] });
    });

    it('two grants of one scope at once: one row, both get it back', async () => {
      const { workspaceId, ownerId, memberId, seed } = await workspace('race');
      const grant = () =>
        withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          ensureCapabilityGrant(client, workspaceId, {
            principalId: memberId,
            resourceType: 'gatekeeper',
            resourceId: seed.gatekeeperId,
            grantedBy: ownerId,
          }),
        );

      const outcomes = await Promise.all([grant(), grant(), grant()]);

      const ids = new Set(outcomes.map((outcome) => outcome.grant.id));
      expect(ids.size).toBe(1);
      expect(outcomes.filter((outcome) => outcome.created)).toHaveLength(1);
      expect(await grantRows(workspaceId, memberId)).toHaveLength(1);
    });

    it('a repeated grant of a gate leaves the member’s live entry Handle alone; a new one reissues it', async () => {
      const { workspaceId, ownerId, memberId, seed, owner } = await workspace('handles');
      const { privateKey } = await generateEphemeralHandleKeyPair();
      const handle = async () =>
        withWorkspace(pool, { workspaceId, principalId: memberId }, async (client) => {
          const sessionId = randomUUID();
          await client.query(
            `insert into sessions (workspace_id, id, principal_id, kind, on_behalf_of, status)
             values ($1, $2, $3, 'entry', $3, 'ready')`,
            [workspaceId, sessionId, memberId],
          );
          const issued = await issueHandle(client, {
            sessionId,
            scope: { capabilities: ['get_object'], resources: {} },
            ttlSeconds: 300,
            privateKey,
            basis: { kind: 'role', role: 'member' },
          });
          return issued.jti;
        });
      const revokedAt = async (jti: string) =>
        (
          await pool.query<{ revoked_at: Date | null }>(
            'select revoked_at from capability_handles where workspace_id = $1 and jti = $2',
            [workspaceId, jti],
          )
        ).rows[0]?.revoked_at ?? null;
      const params = {
        principalId: memberId,
        resourceType: 'gatekeeper',
        resourceId: seed.gatekeeperId,
      };

      const beforeFirst = await handle();
      const first = (await dispatchCapability(
        { pool },
        owner,
        'grant_capability',
        params,
      )) as GrantWire;
      expect(await revokedAt(beforeFirst)).not.toBeNull();

      const beforeRepeat = await handle();
      await dispatchCapability({ pool }, owner, 'grant_capability', params);
      expect(await revokedAt(beforeRepeat)).toBeNull();

      await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        revokeCapabilityGrant(client, workspaceId, first.id),
      );
      expect(await revokedAt(beforeRepeat)).not.toBeNull();
    });

    it('the database refuses a second active grant of a held scope, however it is written', async () => {
      const { workspaceId, ownerId, memberId, seed } = await workspace('db-guard');
      const insert = (resourceType: string, resourceId: string | null, status = 'active') =>
        withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          client.query(
            `insert into capability_grants (workspace_id, principal_id, resource_type, resource_id, status, granted_by)
             values ($1, $2, $3, $4, $5, $6)`,
            [workspaceId, memberId, resourceType, resourceId, status, ownerId],
          ),
        );

      await insert('gatekeeper', seed.gatekeeperId);
      await expect(insert('gatekeeper', seed.gatekeeperId)).rejects.toMatchObject({
        code: '23505',
        constraint: 'capability_grants_one_active_per_scope',
      });
      // History is not held: a revoked row of the same scope goes in beside the active one.
      await insert('gatekeeper', seed.gatekeeperId, 'revoked');
      // Another gate, or another Principal, is another scope.
      await insert('gatekeeper', randomUUID());
      // A null resource id is one value (`nulls not distinct`).
      await insert('e2e.wildcard_kind', null);
      await expect(insert('e2e.wildcard_kind', null)).rejects.toMatchObject({ code: '23505' });
    });

    it('migration 0041 stops, changing nothing, on a database already holding a scope twice', async () => {
      const { workspaceId, ownerId, memberId, seed } = await workspace('migration');
      const statements = splitSqlStatements(readFileSync(MIGRATION_0041, 'utf8'));
      const client = await pool.connect();
      try {
        await client.query('begin');
        // The database as an earlier release left it: no index, the same gate granted twice.
        await client.query('drop index capability_grants_one_active_per_scope');
        for (let i = 0; i < 2; i += 1) {
          await client.query(
            `insert into capability_grants (workspace_id, principal_id, resource_type, resource_id, granted_by)
             values ($1, $2, 'gatekeeper', $3, $4)`,
            [workspaceId, memberId, seed.gatekeeperId, ownerId],
          );
        }
        let refusal: unknown;
        try {
          for (const statement of statements) await client.query(statement);
        } catch (error) {
          refusal = error;
        }
        expect(String(refusal)).toMatch(
          /1 scope\(s\) held by one Principal through more than one active grant; nothing was changed .*legacy 647/,
        );
      } finally {
        await client.query('rollback');
        client.release();
      }
      // The rollback restored the index and left no row behind.
      expect(await grantRows(workspaceId, memberId)).toEqual([]);
      const index = await pool.query(
        `select 1 from pg_indexes where indexname = 'capability_grants_one_active_per_scope'`,
      );
      expect(index.rowCount).toBe(1);
    });
  },
);
