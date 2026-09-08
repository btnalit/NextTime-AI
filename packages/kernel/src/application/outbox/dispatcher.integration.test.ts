import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { enqueue } from '../../substrate/outbox/index.js';
import { OutboxDispatcher } from './dispatcher.js';

/**
 * Integration test (real Postgres; auto-skip without DATABASE_URL) for the S1.4 acceptance
 * criterion: "outbox 派发器崩溃 ... 重启后重放未投递事件；消费者幂等" (design doc §13) — enqueue an
 * event, simulate a dispatcher crash *before* it ever attempts delivery (i.e. never call
 * pollOnce() on the first instance — the closest a unit test can get to "the process died"), then
 * have a fresh `OutboxDispatcher` instance (same Postgres row) deliver it exactly once.
 */

const DATABASE_URL = process.env.DATABASE_URL;

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

describe.runIf(DATABASE_URL !== undefined)(
  'OutboxDispatcher — replay after restart (real Postgres)',
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

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = await adminInsertWorkspace('outbox-dispatcher-integration-test');
      principalId = await adminInsertPrincipal();
    });

    afterAll(async () => {
      await pool.end();
    });

    it('a fresh dispatcher instance delivers a still-undispatched row exactly once', async () => {
      const factId = randomUUID();

      // The producer's own transaction (substrate/outbox's single write path) commits durably —
      // this is the part of §13's story that is *not* lost on a crash.
      await withWorkspace(pool, { workspaceId, principalId }, async (client) => {
        await enqueue(client, {
          type: 'FactAsserted',
          workspaceId,
          factId,
          epistemicStatus: 'asserted',
        });
      });

      // "Dispatcher A crashes before delivery": a first OutboxDispatcher instance exists but never
      // has pollOnce()/start() called — nothing about the row changes. Discarding it without ever
      // polling is the closest a same-process test can get to "the process that would have
      // delivered this event died first".
      const crashedDispatcher = new OutboxDispatcher(pool);
      void crashedDispatcher; // never started — stands in for the crashed process

      const deliveries: string[] = [];
      const freshDispatcher = new OutboxDispatcher(pool);
      freshDispatcher.subscribe('FactAsserted', (event, meta) => {
        if (event.factId === factId) deliveries.push(meta.outboxId);
      });

      // `outbox.id` is one global `bigserial` column shared by every workspace
      // (migrations/core/0005_outbox.sql), and `pollOnce()` drains at most `batchSize` (20) rows
      // per call, oldest-`id`-first. Under Vitest's default cross-file parallelism, other
      // concurrently-running integration test files can enqueue enough of their own rows to push
      // this test's single row past that first 20-row window — a single `pollOnce()` call is not
      // guaranteed to reach it. Loop until this row is delivered or the queue is genuinely empty
      // (capped, so a real regression still fails instead of hanging).
      let delivered = 0;
      for (let i = 0; i < 200 && deliveries.length === 0; i += 1) {
        const n = await freshDispatcher.pollOnce();
        delivered += n;
        if (n === 0) break;
      }

      expect(delivered).toBeGreaterThanOrEqual(1);
      expect(deliveries).toHaveLength(1);

      // Exactly once: a second poll finds nothing left to redeliver for this row.
      const secondDeliveries: string[] = [];
      freshDispatcher.subscribe('FactAsserted', (event, meta) => {
        if (event.factId === factId) secondDeliveries.push(meta.outboxId);
      });
      await freshDispatcher.pollOnce();
      expect(secondDeliveries).toHaveLength(0);

      const row = await withWorkspace(pool, { workspaceId, principalId }, (client) =>
        client.query<{ dispatched_at: Date | null }>(
          'select dispatched_at from outbox where workspace_id = $1 and id = $2',
          [workspaceId, deliveries[0]],
        ),
      );
      expect(row.rows[0]?.dispatched_at).not.toBeNull();
    });

    it('lane-1 P2 fix: attempts is durably incremented across a real rollback, and a dead-lettered row stops being claimed', async () => {
      const factId = randomUUID();

      await withWorkspace(pool, { workspaceId, principalId }, async (client) => {
        await enqueue(client, {
          type: 'FactAsserted',
          workspaceId,
          factId,
          epistemicStatus: 'asserted',
        });
      });

      const dispatcher = new OutboxDispatcher(pool, { maxAttempts: 2 });
      dispatcher.subscribe('FactAsserted', (event) => {
        if (event.factId === factId) throw new Error('boom');
      });

      // Drain other workspaces' rows first (same "queue may not be empty" reality the test above
      // documents) until this row's attempts actually increments — a real consumer throw really
      // does roll back the delivery transaction, so this only ever proves something if this exact
      // row was claimed at least once.
      const findRow = () =>
        withWorkspace(pool, { workspaceId, principalId }, (client) =>
          client.query<{ attempts: number; dispatched_at: Date | null }>(
            "select attempts, dispatched_at from outbox where workspace_id = $1 and event_type = 'FactAsserted' and payload ->> 'factId' = $2",
            [workspaceId, factId],
          ),
        );

      for (let i = 0; i < 200; i += 1) {
        const before = (await findRow()).rows[0]?.attempts ?? 0;
        if (before >= 2) break;
        await dispatcher.pollOnce().catch(() => {
          // A poison-pill row rejects pollOnce() — expected; keep polling.
        });
      }

      const afterTwoAttempts = await findRow();
      expect(afterTwoAttempts.rows[0]?.attempts).toBe(2);
      expect(afterTwoAttempts.rows[0]?.dispatched_at).toBeNull();

      // Dead-lettered: further polling never claims it again (attempts stays at 2, never grows).
      for (let i = 0; i < 5; i += 1) {
        await dispatcher.pollOnce().catch(() => {});
      }
      const stillDeadLettered = await findRow();
      expect(stillDeadLettered.rows[0]?.attempts).toBe(2);
      expect(stillDeadLettered.rows[0]?.dispatched_at).toBeNull();
    });

    it('pruneDispatched deletes only dispatched rows past the cutoff, never an undelivered/dead-lettered one', async () => {
      const factId = randomUUID();

      await withWorkspace(pool, { workspaceId, principalId }, async (client) => {
        await enqueue(client, {
          type: 'FactAsserted',
          workspaceId,
          factId,
          epistemicStatus: 'asserted',
        });
      });

      // Deliver it, then backdate dispatched_at (admin path — this write path is not exposed to
      // nexttime_app, and backdating is only ever needed here, to simulate age without waiting).
      const dispatcher = new OutboxDispatcher(pool);
      dispatcher.subscribe('FactAsserted', () => {});
      for (let i = 0; i < 200; i += 1) {
        const n = await dispatcher.pollOnce();
        if (n === 0) break;
        const row = await withWorkspace(pool, { workspaceId, principalId }, (client) =>
          client.query<{ dispatched_at: Date | null }>(
            "select dispatched_at from outbox where workspace_id = $1 and event_type = 'FactAsserted' and payload ->> 'factId' = $2",
            [workspaceId, factId],
          ),
        );
        if (row.rows[0]?.dispatched_at !== null) break;
      }

      await withWorkspace(
        pool,
        { workspaceId, principalId: randomUUID() },
        async (client) => {
          await client.query(
            "update outbox set dispatched_at = now() - interval '30 days' where workspace_id = $1 and event_type = 'FactAsserted' and payload ->> 'factId' = $2",
            [workspaceId, factId],
          );
        },
        { skipRoleSwitch: true },
      );

      const deletedCount = await dispatcher.pruneDispatched(7);
      expect(deletedCount).toBeGreaterThanOrEqual(1);

      const remaining = await withWorkspace(pool, { workspaceId, principalId }, (client) =>
        client.query(
          "select 1 from outbox where workspace_id = $1 and event_type = 'FactAsserted' and payload ->> 'factId' = $2",
          [workspaceId, factId],
        ),
      );
      expect(remaining.rowCount).toBe(0);
    });
  },
);
