import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { drainPendingContextItems, insertPendingContextItem } from './store.js';

/**
 * application/linkage/store.integration: DB-gated test for the lane-4 P3 fix to
 * `drainPendingContextItems` — `FOR UPDATE SKIP LOCKED` (docs/development-tasks.md: "concurrent
 * get_entry_context double-delivers"). Proves two *concurrent* `get_entry_context`-shaped calls for
 * the same principal never both see the same undelivered row — the second sees fewer/zero items
 * (skipped, not duplicated) while the first's transaction is still open, and nothing is lost: once
 * the first commits, a third call sees exactly what remains (zero, in this test, since the first
 * call already drained and committed everything).
 *
 * Uses two raw `PoolClient`s with manually-managed transactions (not `withWorkspace`, which always
 * commits/rolls back before returning) so the first drain's transaction can be held open while the
 * second drain runs concurrently against it — the only way to actually exercise `SKIP LOCKED`'s
 * row-level lock contention rather than merely asserting the SQL text changed.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

describe.runIf(DATABASE_URL !== undefined)(
  'drainPendingContextItems — FOR UPDATE SKIP LOCKED (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let principalId: string;

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

    async function adminInsertPrincipal(): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: id },
        async (client) => {
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'member', 'p')",
            [workspaceId, id],
          );
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    /** Opens a raw client, sets the same RLS session variables `withWorkspace` sets, starts a
     *  transaction, and leaves it *open* (no COMMIT/ROLLBACK) — caller controls the transaction
     *  boundary from here on, which `withWorkspace` itself does not allow. */
    async function beginScopedTransaction(): Promise<PoolClient> {
      const client = await pool.connect();
      await client.query('BEGIN');
      await client.query("select set_config('app.workspace_id', $1, true)", [workspaceId]);
      await client.query("select set_config('app.principal_id', $1, true)", [principalId]);
      await client.query('set local role nexttime_app');
      return client;
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = await adminInsertWorkspace('linkage-store-integration-test');
      principalId = await adminInsertPrincipal();
    });

    afterAll(async () => {
      await pool.end();
    });

    it('a concurrent drain while the first is still open sees none of the locked rows (no double-delivery)', async () => {
      await withWorkspace(pool, { workspaceId, principalId }, async (client) => {
        await insertPendingContextItem(client, workspaceId, {
          principalId,
          kind: 'task_completed',
          subjectId: randomUUID(),
          payload: { text: 'item 1' },
          sourceOutboxId: '1001',
        });
        await insertPendingContextItem(client, workspaceId, {
          principalId,
          kind: 'task_completed',
          subjectId: randomUUID(),
          payload: { text: 'item 2' },
          sourceOutboxId: '1002',
        });
      });

      const first = await beginScopedTransaction();
      try {
        const firstDrain = await drainPendingContextItems(first, workspaceId, principalId);
        expect(firstDrain.tasks).toHaveLength(2); // both rows locked by this open transaction

        // Concurrent second drain, on a separate connection/transaction, while `first` is still
        // open — SKIP LOCKED means it must see neither row (both locked, not blocked-then-
        // duplicated), rather than hanging or racing a duplicate delivery.
        const second = await beginScopedTransaction();
        try {
          const secondDrain = await drainPendingContextItems(second, workspaceId, principalId);
          expect(secondDrain.tasks).toHaveLength(0);
          await second.query('COMMIT');
        } catch (err) {
          await second.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          second.release();
        }

        await first.query('COMMIT');
      } catch (err) {
        await first.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        first.release();
      }

      // Nothing left undelivered — the first call's commit durably marked both rows delivered;
      // a fresh call sees zero, proving nothing was silently lost by the skipped second attempt.
      const finalDrain = await withWorkspace(pool, { workspaceId, principalId }, (client) =>
        drainPendingContextItems(client, workspaceId, principalId),
      );
      expect(finalDrain.tasks).toHaveLength(0);
    });
  },
);
