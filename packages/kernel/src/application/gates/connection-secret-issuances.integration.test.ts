import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import {
  connectionSecretIssuanceState,
  consumeConnectionSecret,
  recordMintedConnectionSecret,
  recordRotatedConnectionSecret,
} from './connection-secret-issuances.js';

/**
 * application/gates/connection-secret-issuances.integration.test (legacy 711, core 0058): the
 * ledger's own rules, as the database keeps them whatever the code does — a salt is consumed once,
 * only before it expires, and only in its own workspace; an issued row's fields never change; only
 * an expired, unconsumed row is ever deleted by a workspace.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

const newSalt = () => randomBytes(16).toString('hex');

describe.runIf(DATABASE_URL !== undefined)(
  'application/gates — the connection-secret issuance ledger (integration, real Postgres)',
  () => {
    let pool: Pool;
    const workspaces: { id: string; ownerId: string }[] = [];

    const asApp = <T>(index: number, fn: (client: PoolClient) => Promise<T>) => {
      const ws = workspaces[index] as { id: string; ownerId: string };
      return withWorkspace(pool, { workspaceId: ws.id, principalId: ws.ownerId }, fn);
    };
    const asSuperuser = <T>(fn: (client: PoolClient) => Promise<T>) => {
      const ws = workspaces[0] as { id: string; ownerId: string };
      return withWorkspace(pool, { workspaceId: ws.id, principalId: ws.ownerId }, fn, {
        skipRoleSwitch: true,
      });
    };

    async function rowOf(workspaceId: string, salt: string) {
      const result = await asSuperuser((client) =>
        client.query<{ consumed_by: string | null }>(
          'select consumed_by from connection_secret_issuances where workspace_id = $1 and salt = $2',
          [workspaceId, salt],
        ),
      );
      return result.rows;
    }

    /** An issued row, as `issued_at` / `expires_at` say — written past RLS. */
    async function issuedAt(index: number, salt: string, hoursAgo: number) {
      const ws = workspaces[index] as { id: string; ownerId: string };
      await asSuperuser((client) =>
        client.query(
          `insert into connection_secret_issuances
             (workspace_id, salt, issued_via, issued_by, issued_at, expires_at)
           values ($1, $2, 'mint_connection_secret', $3,
                   now() - make_interval(hours => $4), now() - make_interval(hours => $4 - 24))`,
          [ws.id, salt, ws.ownerId, hoursAgo],
        ),
      );
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      for (const label of ['a', 'b']) {
        const id = randomUUID();
        const ownerId = randomUUID();
        await withWorkspace(
          pool,
          { workspaceId: id, principalId: ownerId },
          async (client) => {
            await client.query('insert into workspaces (id, name) values ($1, $2)', [
              id,
              `issuance-ledger-${label}`,
            ]);
            await client.query(
              `insert into principals (workspace_id, id, kind, role, display_name)
               values ($1, $2, 'human', 'owner', 'Ledger Owner')`,
              [id, ownerId],
            );
          },
          { skipRoleSwitch: true },
        );
        workspaces.push({ id, ownerId });
      }
    });

    afterAll(async () => {
      await pool.end();
    });

    it('a minted salt is usable, consumed once; a second consumption finds it consumed', async () => {
      const ws = workspaces[0] as { id: string; ownerId: string };
      const salt = newSalt();
      await asApp(0, (client) => recordMintedConnectionSecret(client, ws.id, salt, ws.ownerId));
      expect(await asApp(0, (c) => connectionSecretIssuanceState(c, ws.id, salt))).toEqual({
        state: 'usable',
      });
      expect(
        await asApp(0, (c) => consumeConnectionSecret(c, ws.id, salt, 'create_connection')),
      ).toEqual({ state: 'usable' });
      expect(
        await asApp(0, (c) =>
          consumeConnectionSecret(c, ws.id, salt, 'propose_gate_address_change'),
        ),
      ).toEqual({ state: 'consumed', consumedBy: 'create_connection' });
      expect(await rowOf(ws.id, salt)).toEqual([{ consumed_by: 'create_connection' }]);
    });

    it('a rotation records its salt consumed by itself; nothing consumes it again', async () => {
      const ws = workspaces[0] as { id: string; ownerId: string };
      const salt = newSalt();
      await asApp(0, (client) => recordRotatedConnectionSecret(client, ws.id, salt, ws.ownerId));
      expect(
        await asApp(0, (c) => consumeConnectionSecret(c, ws.id, salt, 'create_connection')),
      ).toEqual({ state: 'consumed', consumedBy: 'rotate_connection_secret' });
    });

    it('a salt another workspace issued is no salt here: refused as not issued, and left as it was', async () => {
      const [a, b] = workspaces as [
        { id: string; ownerId: string },
        { id: string; ownerId: string },
      ];
      const salt = newSalt();
      await asApp(1, (client) => recordMintedConnectionSecret(client, b.id, salt, b.ownerId));
      // Workspace a's transaction cannot see or touch b's row, even naming b's workspace id.
      expect(
        await asApp(0, (c) => consumeConnectionSecret(c, b.id, salt, 'create_connection')),
      ).toEqual({ state: 'expired' });
      expect(await rowOf(b.id, salt)).toEqual([{ consumed_by: null }]);
      expect(await rowOf(a.id, salt)).toEqual([]);
    });

    it('past expires_at a salt is not consumed — by the code, and by the trigger even on a direct write', async () => {
      const ws = workspaces[0] as { id: string; ownerId: string };
      const salt = newSalt();
      await issuedAt(0, salt, 25);
      expect(
        await asApp(0, (c) => consumeConnectionSecret(c, ws.id, salt, 'create_connection')),
      ).toEqual({ state: 'expired' });
      await expect(
        asSuperuser((client) =>
          client.query(
            `update connection_secret_issuances
                set consumed_at = now(), consumed_by = 'create_connection'
              where workspace_id = $1 and salt = $2`,
            [ws.id, salt],
          ),
        ),
      ).rejects.toThrow(/expired at .* cannot be consumed/);
    });

    it('the trigger keeps a consumed row and an issued row’s own fields as they are; the check bounds the lifetime at 24 hours', async () => {
      const ws = workspaces[0] as { id: string; ownerId: string };
      const consumed = newSalt();
      await asApp(0, async (client) => {
        await recordMintedConnectionSecret(client, ws.id, consumed, ws.ownerId);
        await consumeConnectionSecret(client, ws.id, consumed, 'create_connection');
      });
      await expect(
        asSuperuser((client) =>
          client.query(
            `update connection_secret_issuances set consumed_at = null, consumed_by = null
              where workspace_id = $1 and salt = $2`,
            [ws.id, consumed],
          ),
        ),
      ).rejects.toThrow(/consumed by create_connection and serves nothing else/);
      const issued = newSalt();
      await asApp(0, (client) => recordMintedConnectionSecret(client, ws.id, issued, ws.ownerId));
      await expect(
        asSuperuser((client) =>
          client.query(
            `update connection_secret_issuances set expires_at = expires_at + interval '1 hour'
              where workspace_id = $1 and salt = $2`,
            [ws.id, issued],
          ),
        ),
      ).rejects.toThrow(/own fields never change/);
      await expect(
        asApp(0, (client) =>
          client.query(
            `insert into connection_secret_issuances (workspace_id, salt, issued_via, issued_by, expires_at)
             values ($1, $2, 'mint_connection_secret', $3, now() + interval '25 hours')`,
            [ws.id, newSalt(), ws.ownerId],
          ),
        ),
      ).rejects.toThrow(/check constraint/);
      // A minted row is never consumed by a rotation, nor a rotation's by anything else.
      await expect(
        asApp(0, (client) =>
          client.query(
            `insert into connection_secret_issuances
               (workspace_id, salt, issued_via, issued_by, consumed_at, consumed_by)
             values ($1, $2, 'mint_connection_secret', $3, now(), 'rotate_connection_secret')`,
            [ws.id, newSalt(), ws.ownerId],
          ),
        ),
      ).rejects.toThrow(/check constraint/);
      await expect(
        asApp(0, (client) =>
          client.query(
            `insert into connection_secret_issuances (workspace_id, salt, issued_via, issued_by)
             values ($1, $2, 'rotate_connection_secret', $3)`,
            [ws.id, newSalt(), ws.ownerId],
          ),
        ),
      ).rejects.toThrow(/check constraint/);
    });

    it('a workspace deletes only its own expired, unconsumed rows — the next mint’s clean-up', async () => {
      const ws = workspaces[0] as { id: string; ownerId: string };
      const live = newSalt();
      const consumed = newSalt();
      const expired = newSalt();
      await asApp(0, async (client) => {
        await recordMintedConnectionSecret(client, ws.id, live, ws.ownerId);
        await recordMintedConnectionSecret(client, ws.id, consumed, ws.ownerId);
        await consumeConnectionSecret(client, ws.id, consumed, 'create_connection');
      });
      await issuedAt(0, expired, 30);
      const deleted = await asApp(0, (client) =>
        client.query('delete from connection_secret_issuances where salt = any($1::text[])', [
          [live, consumed, expired],
        ]),
      );
      expect(deleted.rowCount).toBe(1);
      expect(await rowOf(ws.id, live)).toHaveLength(1);
      expect(await rowOf(ws.id, consumed)).toHaveLength(1);
      expect(await rowOf(ws.id, expired)).toEqual([]);

      // The mint's own clean-up takes the same rows, and only in its workspace.
      const b = workspaces[1] as { id: string; ownerId: string };
      const expiredHere = newSalt();
      const expiredThere = newSalt();
      await issuedAt(0, expiredHere, 30);
      await issuedAt(1, expiredThere, 30);
      await asApp(0, (client) =>
        recordMintedConnectionSecret(client, ws.id, newSalt(), ws.ownerId),
      );
      expect(await rowOf(ws.id, expiredHere)).toEqual([]);
      expect(await rowOf(b.id, expiredThere)).toHaveLength(1);
    });
  },
);
