import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { startActivity } from '../../substrate/epistemic/index.js';
import { newChat } from '../chat/index.js';
import type { EgressObservationInput } from './egress-observations.js';
import { recordEgressObservations } from './egress-observations.js';

/**
 * Integration test (real Postgres; auto-skip without DATABASE_URL) for
 * `recordEgressObservations` — docs/development-tasks.md S1.10 kernel gap deliverable: a running
 * Turn gets `metadata.egress` appended and a matching `outbox` row exists.
 */

const DATABASE_URL = process.env.DATABASE_URL;

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

describe.runIf(DATABASE_URL !== undefined)(
  'recordEgressObservations (integration, real Postgres)',
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

    async function adminInsertPrincipal(forWorkspaceId: string): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId: forWorkspaceId, principalId: id },
        async (client) => {
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'member', 'p')",
            [forWorkspaceId, id],
          );
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    async function startRunningTurn(): Promise<string> {
      return withWorkspace(pool, { workspaceId, principalId }, async (client) => {
        const chat = await newChat(client, workspaceId, principalId, {});
        const turn = await startActivity(client, workspaceId, {
          kind: 'agent_turn',
          chatId: chat.id,
          principalId,
        });
        return turn.id;
      });
    }

    async function readActivity(
      activityId: string,
    ): Promise<{ status: string; metadata: Record<string, unknown> }> {
      return withWorkspace(pool, { workspaceId, principalId }, async (client) => {
        const result = await client.query<{ status: string; metadata: Record<string, unknown> }>(
          'select status, metadata from activities where workspace_id = $1 and id = $2',
          [workspaceId, activityId],
        );
        const row = result.rows[0];
        if (!row) throw new Error('activity not found');
        return row;
      });
    }

    async function readOutboxEvents(): Promise<
      readonly { event_type: string; payload: Record<string, unknown> }[]
    > {
      return withWorkspace(pool, { workspaceId, principalId }, async (client) => {
        const result = await client.query<{
          event_type: string;
          payload: Record<string, unknown>;
        }>(
          `select event_type, payload from outbox
           where workspace_id = $1 and event_type = 'EgressObserved'
           order by id asc`,
          [workspaceId],
        );
        return result.rows;
      });
    }

    function observation(overrides: Partial<EgressObservationInput> = {}): EgressObservationInput {
      return {
        sourceId: `entry:${workspaceId}:${principalId}`,
        hostname: 'example.com',
        port: 443,
        bytesIn: 4096,
        bytesOut: 128,
        allowed: true,
        at: new Date().toISOString(),
        ...overrides,
      };
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = await adminInsertWorkspace('egress-observations-integration-test');
    });

    afterAll(async () => {
      await pool.end();
    });

    // A fresh principal per test (not one shared across the whole describe block, in beforeAll):
    // `startRunningTurn()` deliberately leaves its Turn `status = 'running'` in several tests
    // (that's the scenario under test) — sharing one principal across tests would let an earlier
    // test's still-running Turn leak into a later test's "no running Turn" / "most recent Turn"
    // assertions. `workspaceId` itself is still shared; only identity, not the workspace, needs to
    // be test-local here.
    beforeEach(async () => {
      principalId = await adminInsertPrincipal(workspaceId);
    });

    it('appends the observation to a running Turn and enqueues one EgressObserved event', async () => {
      const turnId = await startRunningTurn();

      const result = await recordEgressObservations({ pool }, [
        observation({ hostname: 'example.com', reason: undefined }),
      ]);

      expect(result).toEqual({
        attributedToRunningTurn: 1,
        attributedToRecentTurn: 0,
        skippedUnknownSource: 0,
        skippedNoTurn: 0,
      });

      const activity = await readActivity(turnId);
      expect(activity.status).toBe('running');
      const egress = activity.metadata.egress as readonly Record<string, unknown>[];
      expect(egress).toHaveLength(1);
      expect(egress[0]).toMatchObject({
        hostname: 'example.com',
        port: 443,
        bytesIn: 4096,
        bytesOut: 128,
        allowed: true,
      });

      const events = await readOutboxEvents();
      const forThisTurn = events.filter((e) => e.payload.activityId === turnId);
      expect(forThisTurn).toHaveLength(1);
      expect(forThisTurn[0]?.payload).toMatchObject({
        type: 'EgressObserved',
        workspaceId,
        activityId: turnId,
        domain: 'example.com',
        bytes: 4096 + 128,
      });
    });

    it('falls back to the most recent agent_turn when none is running, and skips unknown sourceId/no-turn cases', async () => {
      const turnId = await startRunningTurn();
      await withWorkspace(pool, { workspaceId, principalId }, (client) =>
        client.query(
          "update activities set status = 'completed', ended_at = now() where workspace_id = $1 and id = $2",
          [workspaceId, turnId],
        ),
      );

      const result = await recordEgressObservations({ pool }, [
        observation({ hostname: 'fallback.example.com' }),
        observation({ sourceId: 'not-a-recognized-format' }),
      ]);

      expect(result.attributedToRecentTurn).toBe(1);
      expect(result.attributedToRunningTurn).toBe(0);
      expect(result.skippedUnknownSource).toBe(1);

      const activity = await readActivity(turnId);
      const egress = activity.metadata.egress as readonly Record<string, unknown>[];
      expect(egress.some((e) => e.hostname === 'fallback.example.com')).toBe(true);
    });

    it('reports skippedNoTurn when the principal has no running or recent agent_turn', async () => {
      const freshWorkspaceId = await adminInsertWorkspace('egress-observations-no-turn-test');
      const freshPrincipalId = await adminInsertPrincipal(freshWorkspaceId);

      const result = await recordEgressObservations({ pool, recentTurnWindowMinutes: 5 }, [
        {
          sourceId: `entry:${freshWorkspaceId}:${freshPrincipalId}`,
          hostname: 'nobody-home.example.com',
          port: 443,
          bytesIn: 0,
          bytesOut: 0,
          allowed: true,
          at: new Date().toISOString(),
        },
      ]);

      expect(result.skippedNoTurn).toBe(1);
      expect(result.attributedToRunningTurn).toBe(0);
      expect(result.attributedToRecentTurn).toBe(0);
    });

    it('keeps metadata.egress bounded to the last 200 entries', async () => {
      const turnId = await startRunningTurn();
      const seeded = Array.from({ length: 200 }, (_, i) => ({
        hostname: `seed-${i}.example.com`,
        allowed: true,
        at: new Date().toISOString(),
      }));
      await withWorkspace(pool, { workspaceId, principalId }, (client) =>
        client.query(
          "update activities set metadata = jsonb_set(metadata, '{egress}', $3::jsonb) where workspace_id = $1 and id = $2",
          [workspaceId, turnId, JSON.stringify(seeded)],
        ),
      );

      await recordEgressObservations({ pool }, [observation({ hostname: 'newest.example.com' })]);

      const activity = await readActivity(turnId);
      const egress = activity.metadata.egress as readonly Record<string, unknown>[];
      expect(egress).toHaveLength(200);
      expect(egress[egress.length - 1]).toMatchObject({ hostname: 'newest.example.com' });
      expect(egress[0]).toMatchObject({ hostname: 'seed-1.example.com' });
      expect(egress.some((e) => e.hostname === 'seed-0.example.com')).toBe(false);
    });
  },
);
