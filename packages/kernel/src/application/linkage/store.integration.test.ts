import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { endActivity, startActivity } from '../../substrate/epistemic/index.js';
import { newChat } from '../chat/index.js';
import {
  type EntryContextTurn,
  acknowledgeTurnContextItems,
  insertPendingContextItem,
  leaseContextItemsToTurn,
  peekContextItems,
} from './store.js';

/**
 * application/linkage/store.integration: DB-gated tests for the per-Turn delivery of
 * `pending_context_items` (2026-10-02 review R-57, maintainer decision D-23 — `store.ts`'s module
 * doc comment): an item belongs to one Chat, every call for one Turn returns the same items until
 * `report_turn` acknowledges that Turn, a peek consumes nothing, and a Chat never sees another
 * Chat's items. Each test uses its own principal, so tests never see each other's rows.
 *
 * The concurrency case uses two raw `PoolClient`s with manually-managed transactions (not
 * `withWorkspace`, which always commits/rolls back before returning) so the first lease's
 * transaction can be held open while the second runs against it.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

describe.runIf(DATABASE_URL !== undefined)(
  'pending_context_items — per-Turn lease, acknowledgement, peek (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let nextOutboxId = 1000;

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

    function inTx<T>(principalId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId }, fn);
    }

    async function createChat(principalId: string): Promise<string> {
      const chat = await inTx(principalId, (client) =>
        newChat(client, workspaceId, principalId, {}),
      );
      return chat.id;
    }

    async function startTurn(principalId: string, chatId: string): Promise<EntryContextTurn> {
      const turn = await inTx(principalId, (client) =>
        startActivity(client, workspaceId, { kind: 'agent_turn', chatId, principalId }),
      );
      return { turnId: turn.id, chatId };
    }

    async function endTurn(principalId: string, turn: EntryContextTurn): Promise<void> {
      await inTx(principalId, (client) =>
        endActivity(client, workspaceId, turn.turnId, 'completed'),
      );
    }

    async function insertItem(principalId: string, chatId: string, text: string): Promise<void> {
      nextOutboxId += 1;
      await inTx(principalId, (client) =>
        insertPendingContextItem(client, workspaceId, {
          principalId,
          chatId,
          kind: 'task_completed',
          subjectId: randomUUID(),
          payload: { text },
          sourceOutboxId: String(nextOutboxId),
        }),
      );
    }

    function lease(principalId: string, turn: EntryContextTurn) {
      return inTx(principalId, (client) =>
        leaseContextItemsToTurn(client, workspaceId, principalId, turn),
      );
    }

    function peek(principalId: string) {
      return inTx(principalId, (client) => peekContextItems(client, workspaceId, principalId));
    }

    function acknowledge(principalId: string, turn: EntryContextTurn) {
      return inTx(principalId, (client) =>
        acknowledgeTurnContextItems(client, workspaceId, principalId, turn.turnId),
      );
    }

    function texts(items: { tasks: readonly Record<string, unknown>[] }): unknown[] {
      return items.tasks.map((payload) => payload.text);
    }

    /** A raw client inside an open transaction scoped like `withWorkspace` — the caller commits. */
    async function beginScopedTransaction(principalId: string): Promise<PoolClient> {
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
    });

    afterAll(async () => {
      await pool.end();
    });

    it('every call for one Turn returns the same batch; report_turn’s acknowledgement removes it', async () => {
      const principalId = await adminInsertPrincipal();
      const chatId = await createChat(principalId);
      await insertItem(principalId, chatId, 'item 1');
      await insertItem(principalId, chatId, 'item 2');
      const turn = await startTurn(principalId, chatId);

      // The Turn's first and second LLM calls (or a provider-error retry) see the same items.
      expect(texts(await lease(principalId, turn))).toEqual(['item 1', 'item 2']);
      expect(texts(await lease(principalId, turn))).toEqual(['item 1', 'item 2']);

      expect(await acknowledge(principalId, turn)).toBe(2);
      await endTurn(principalId, turn);

      const nextTurn = await startTurn(principalId, chatId);
      expect(texts(await lease(principalId, nextTurn))).toEqual([]);
      expect(texts(await peek(principalId))).toEqual([]);
    });

    it('an item that arrives after the Turn’s last read is not acknowledged with it', async () => {
      const principalId = await adminInsertPrincipal();
      const chatId = await createChat(principalId);
      await insertItem(principalId, chatId, 'seen');
      const turn = await startTurn(principalId, chatId);
      expect(texts(await lease(principalId, turn))).toEqual(['seen']);

      await insertItem(principalId, chatId, 'late');
      expect(await acknowledge(principalId, turn)).toBe(1);
      await endTurn(principalId, turn);

      const nextTurn = await startTurn(principalId, chatId);
      expect(texts(await lease(principalId, nextTurn))).toEqual(['late']);
    });

    it('a Turn that ended without report_turn hands its items to the next Turn of the Chat', async () => {
      const principalId = await adminInsertPrincipal();
      const chatId = await createChat(principalId);
      await insertItem(principalId, chatId, 'not lost');
      const crashed = await startTurn(principalId, chatId);
      expect(texts(await lease(principalId, crashed))).toEqual(['not lost']);
      await endTurn(principalId, crashed); // the kernel ended it; the runtime never reported it

      const nextTurn = await startTurn(principalId, chatId);
      expect(texts(await lease(principalId, nextTurn))).toEqual(['not lost']);
      // A late report_turn for the earlier Turn no longer owns the item.
      expect(await acknowledge(principalId, crashed)).toBe(0);
      expect(texts(await lease(principalId, nextTurn))).toEqual(['not lost']);
    });

    it('a peek returns every unacknowledged item and consumes nothing', async () => {
      const principalId = await adminInsertPrincipal();
      const chatA = await createChat(principalId);
      const chatB = await createChat(principalId);
      await insertItem(principalId, chatA, 'from A');
      await insertItem(principalId, chatB, 'from B');

      expect(texts(await peek(principalId))).toEqual(['from A', 'from B']);
      expect(texts(await peek(principalId))).toEqual(['from A', 'from B']);

      // Chat A's Turn still gets its item after the peeks.
      const turn = await startTurn(principalId, chatA);
      expect(texts(await lease(principalId, turn))).toEqual(['from A']);
    });

    it('an item of chat A is never leased to a Turn of chat B of the same principal', async () => {
      const principalId = await adminInsertPrincipal();
      const chatA = await createChat(principalId);
      const chatB = await createChat(principalId);
      await insertItem(principalId, chatA, 'belongs to A');

      const turnB = await startTurn(principalId, chatB);
      expect(texts(await lease(principalId, turnB))).toEqual([]);
      expect(await acknowledge(principalId, turnB)).toBe(0);

      const turnA = await startTurn(principalId, chatA);
      expect(texts(await lease(principalId, turnA))).toEqual(['belongs to A']);
    });

    it('a row written before migration 0002 (no chat) is leased to any Turn of the principal', async () => {
      const principalId = await adminInsertPrincipal();
      const chatId = await createChat(principalId);
      nextOutboxId += 1;
      await inTx(principalId, (client) =>
        client.query(
          `insert into pending_context_items
             (workspace_id, principal_id, kind, subject_id, payload, source_outbox_id)
           values ($1, $2, 'task_completed', $3, $4::jsonb, $5)`,
          [
            workspaceId,
            principalId,
            randomUUID(),
            JSON.stringify({ text: 'legacy' }),
            nextOutboxId,
          ],
        ),
      );

      const turn = await startTurn(principalId, chatId);
      expect(texts(await lease(principalId, turn))).toEqual(['legacy']);
      expect(await acknowledge(principalId, turn)).toBe(1);
    });

    it('a concurrent lease for the same Turn returns the full batch once the first commits, never a duplicate', async () => {
      const principalId = await adminInsertPrincipal();
      const chatId = await createChat(principalId);
      await insertItem(principalId, chatId, 'item 1');
      await insertItem(principalId, chatId, 'item 2');
      const turn = await startTurn(principalId, chatId);

      const first = await beginScopedTransaction(principalId);
      let second: PoolClient | undefined;
      try {
        const firstLease = await leaseContextItemsToTurn(first, workspaceId, principalId, turn);
        expect(texts(firstLease)).toEqual(['item 1', 'item 2']);

        // The second call blocks on the rows the first holds, then sees the committed leases.
        second = await beginScopedTransaction(principalId);
        const secondLease = leaseContextItemsToTurn(second, workspaceId, principalId, turn);
        await new Promise((resolve) => setTimeout(resolve, 200));
        await first.query('COMMIT');
        expect(texts(await secondLease)).toEqual(['item 1', 'item 2']);
        await second.query('COMMIT');
      } catch (err) {
        await first.query('ROLLBACK').catch(() => {});
        await second?.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        first.release();
        second?.release();
      }

      expect(await acknowledge(principalId, turn)).toBe(2);
    });
  },
);
