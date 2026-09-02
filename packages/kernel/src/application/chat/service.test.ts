import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import {
  ChatNotFoundError,
  TurnAlreadyRunningError,
  currentPrincipalId,
  findRunningTurn,
  getChatHistory,
  insertChatMessage,
  listChats,
  newChat,
  requireChatAccess,
  sendChatMessage,
} from './service.js';

/**
 * Integration tests (real Postgres; auto-skip without DATABASE_URL) for application/chat/
 * service.ts — docs/development-tasks.md S1.4 acceptance criteria: one running Turn per Chat
 * (409-shaped error), history paging, and the isolation guarantee (a private Chat is invisible to
 * a different principal).
 */

const DATABASE_URL = process.env.DATABASE_URL;

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

describe.runIf(DATABASE_URL !== undefined)(
  'application/chat/service (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let otherId: string;

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

    async function adminInsertPrincipal(displayName: string): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: id },
        async (client) => {
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', 'member', $3)",
            [workspaceId, id, displayName],
          );
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    async function inTxAs<T>(
      principalId: string,
      fn: (client: PoolClient) => Promise<T>,
    ): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId }, fn);
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = await adminInsertWorkspace('chat-service-test-workspace');
      ownerId = await adminInsertPrincipal('owner');
      otherId = await adminInsertPrincipal('other');
    });

    afterAll(async () => {
      await pool.end();
    });

    it('currentPrincipalId reads back the app.principal_id RLS session variable', async () => {
      const read = await inTxAs(ownerId, (client) => currentPrincipalId(client));
      expect(read).toBe(ownerId);
    });

    it('newChat + listChats: a chat is listed for its owner', async () => {
      const chat = await inTxAs(ownerId, (client) =>
        newChat(client, workspaceId, ownerId, { title: 'first' }),
      );
      expect(chat.ownerPrincipalId).toBe(ownerId);
      expect(chat.visibility).toBe('private');

      const chats = await inTxAs(ownerId, (client) => listChats(client, workspaceId, ownerId));
      expect(chats.some((c) => c.id === chat.id)).toBe(true);
    });

    it('requireChatAccess throws ChatNotFoundError for a chat owned by a different principal (isolation, G4)', async () => {
      const chat = await inTxAs(ownerId, (client) => newChat(client, workspaceId, ownerId, {}));

      await expect(
        inTxAs(otherId, (client) => requireChatAccess(client, workspaceId, chat.id)),
      ).rejects.toThrow(ChatNotFoundError);

      // The owner themself can still see it.
      await expect(
        inTxAs(ownerId, (client) => requireChatAccess(client, workspaceId, chat.id)),
      ).resolves.toMatchObject({ id: chat.id });
    });

    it('requireChatAccess throws ChatNotFoundError for a genuinely nonexistent chat', async () => {
      await expect(
        inTxAs(ownerId, (client) => requireChatAccess(client, workspaceId, randomUUID())),
      ).rejects.toThrow(ChatNotFoundError);
    });

    it('sendChatMessage inserts the user message (sequence 1, its own turn_id) and starts a running Turn', async () => {
      const chat = await inTxAs(ownerId, (client) => newChat(client, workspaceId, ownerId, {}));

      const { message, turnId } = await inTxAs(ownerId, (client) =>
        sendChatMessage(client, workspaceId, ownerId, { chatId: chat.id, text: 'hello' }),
      );

      expect(message.role).toBe('user');
      expect(message.sequence).toBe(1);
      expect(message.turnId).toBe(turnId);

      const running = await inTxAs(ownerId, (client) =>
        findRunningTurn(client, workspaceId, chat.id),
      );
      expect(running?.id).toBe(turnId);

      const outboxRow = await inTxAs(ownerId, async (client) => {
        const result = await client.query<{ event_type: string; payload: { prompt: string } }>(
          `select event_type, payload from outbox
         where workspace_id = $1 and event_type = 'TurnStarted'
         order by id desc limit 1`,
          [workspaceId],
        );
        return result.rows[0];
      });
      expect(outboxRow?.event_type).toBe('TurnStarted');
      expect(outboxRow?.payload.prompt).toBe('hello');
    });

    it('a second send_chat_message while a Turn is running throws TurnAlreadyRunningError and writes nothing (§9.4)', async () => {
      const chat = await inTxAs(ownerId, (client) => newChat(client, workspaceId, ownerId, {}));
      await inTxAs(ownerId, (client) =>
        sendChatMessage(client, workspaceId, ownerId, { chatId: chat.id, text: 'first' }),
      );

      await expect(
        inTxAs(ownerId, (client) =>
          sendChatMessage(client, workspaceId, ownerId, { chatId: chat.id, text: 'second' }),
        ),
      ).rejects.toThrow(TurnAlreadyRunningError);

      // Rolled back cleanly: still exactly one message (the first), still exactly one running Turn.
      const history = await inTxAs(ownerId, (client) =>
        getChatHistory(client, workspaceId, { chatId: chat.id }),
      );
      expect(history.messages).toHaveLength(1);
      expect(history.messages[0]?.content).toEqual({ text: 'first' });
    });

    it('after the running Turn ends, send_chat_message can start a new one', async () => {
      const chat = await inTxAs(ownerId, (client) => newChat(client, workspaceId, ownerId, {}));
      const { turnId } = await inTxAs(ownerId, (client) =>
        sendChatMessage(client, workspaceId, ownerId, { chatId: chat.id, text: 'first' }),
      );

      await inTxAs(ownerId, async (client) => {
        await client.query(
          "update activities set status = 'completed', ended_at = now() where workspace_id = $1 and id = $2",
          [workspaceId, turnId],
        );
      });

      const second = await inTxAs(ownerId, (client) =>
        sendChatMessage(client, workspaceId, ownerId, { chatId: chat.id, text: 'second' }),
      );
      expect(second.turnId).not.toBe(turnId);
      expect(second.message.sequence).toBe(2);
    });

    it('getChatHistory pages by cursor=sequence, newest-last, and reports nextCursor only on a full page', async () => {
      const chat = await inTxAs(ownerId, (client) => newChat(client, workspaceId, ownerId, {}));
      const { turnId } = await inTxAs(ownerId, (client) =>
        sendChatMessage(client, workspaceId, ownerId, { chatId: chat.id, text: 'm1' }),
      );
      // Simulate the agent's own persisted replies directly via insertChatMessage (event-sink.ts's
      // own write path, exercised indirectly by the WS end-to-end test) so this test does not need
      // a running AgentRuntime.
      await inTxAs(ownerId, (client) =>
        insertChatMessage(client, workspaceId, {
          chatId: chat.id,
          turnId,
          role: 'assistant',
          content: { text: 'm2' },
        }),
      );
      await inTxAs(ownerId, (client) =>
        insertChatMessage(client, workspaceId, {
          chatId: chat.id,
          turnId,
          role: 'assistant',
          content: { text: 'm3' },
        }),
      );

      const firstPage = await inTxAs(ownerId, (client) =>
        getChatHistory(client, workspaceId, { chatId: chat.id, limit: 2 }),
      );
      expect(firstPage.messages.map((m) => m.sequence)).toEqual([1, 2]);
      expect(firstPage.nextCursor).toBe('2');

      const secondPage = await inTxAs(ownerId, (client) =>
        getChatHistory(client, workspaceId, {
          chatId: chat.id,
          cursor: firstPage.nextCursor,
          limit: 2,
        }),
      );
      expect(secondPage.messages.map((m) => m.sequence)).toEqual([3]);
      expect(secondPage.nextCursor).toBeUndefined();
    });

    it('getChatHistory on a chat with no messages returns an empty page and no nextCursor', async () => {
      const chat = await inTxAs(ownerId, (client) => newChat(client, workspaceId, ownerId, {}));
      const page = await inTxAs(ownerId, (client) =>
        getChatHistory(client, workspaceId, { chatId: chat.id }),
      );
      expect(page.messages).toEqual([]);
      expect(page.nextCursor).toBeUndefined();
    });

    it('findRunningTurn returns null when no Turn is running', async () => {
      const chat = await inTxAs(ownerId, (client) => newChat(client, workspaceId, ownerId, {}));
      const running = await inTxAs(ownerId, (client) =>
        findRunningTurn(client, workspaceId, chat.id),
      );
      expect(running).toBeNull();
    });
  },
);
