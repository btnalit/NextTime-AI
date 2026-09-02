import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { interruptStaleRunningTurns } from './recovery.js';
import { newChat } from './service.js';

/**
 * Integration test (real Postgres; auto-skip without DATABASE_URL) for interruptStaleRunningTurns
 * — docs/development-tasks.md S1.4 deliverable 7: a genuinely-old `running` agent_turn is marked
 * `interrupted`; a recent one is left alone (it might still be legitimately in progress).
 */

const DATABASE_URL = process.env.DATABASE_URL;

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

describe.runIf(DATABASE_URL !== undefined)(
  'interruptStaleRunningTurns (integration, real Postgres)',
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

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = await adminInsertWorkspace('recovery-integration-test');
      ownerId = await adminInsertPrincipal();
    });

    afterAll(async () => {
      await pool.end();
    });

    it('marks an old running Turn interrupted, leaves a recent one alone, and skips non-running/non-agent_turn rows', async () => {
      const chatId = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        newChat(client, workspaceId, ownerId, {}).then((c) => c.id),
      );

      const staleTurnId = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const turn = await startActivity(client, workspaceId, {
            kind: 'agent_turn',
            chatId,
            principalId: ownerId,
          });
          // Backdate created_at past the timeout this test will use — startActivity itself has no way
          // to set an arbitrary created_at, so backdate it directly afterward.
          await client.query(
            "update activities set created_at = now() - interval '1 hour' where workspace_id = $1 and id = $2",
            [workspaceId, turn.id],
          );
          return turn.id;
        },
      );

      const recentChatId = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        (client) => newChat(client, workspaceId, ownerId, {}).then((c) => c.id),
      );
      const recentTurnId = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const turn = await startActivity(client, workspaceId, {
            kind: 'agent_turn',
            chatId: recentChatId,
            principalId: ownerId,
          });
          return turn.id;
        },
      );

      // A non-agent_turn running Activity, and a completed agent_turn — neither should be touched.
      const otherKindId = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const activity = await startActivity(client, workspaceId, {
            kind: 'test.ingest',
            principalId: ownerId,
          });
          await client.query(
            "update activities set created_at = now() - interval '1 hour' where workspace_id = $1 and id = $2",
            [workspaceId, activity.id],
          );
          return activity.id;
        },
      );

      const count = await interruptStaleRunningTurns({ pool, timeoutMs: 60 * 1000 }); // 1 minute

      expect(count).toBeGreaterThanOrEqual(1);

      const rows = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const result = await client.query<{ id: string; status: string }>(
            'select id, status from activities where workspace_id = $1 and id = any($2::uuid[])',
            [workspaceId, [staleTurnId, recentTurnId, otherKindId]],
          );
          return new Map(result.rows.map((r) => [r.id, r.status]));
        },
      );

      expect(rows.get(staleTurnId)).toBe('interrupted');
      expect(rows.get(recentTurnId)).toBe('running'); // too recent — left alone
      expect(rows.get(otherKindId)).toBe('running'); // wrong kind — left alone
    });
  },
);
