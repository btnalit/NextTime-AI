import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { _resetChatPushEventsForTests, subscribeToChatPushEvents } from './push.js';
import {
  CHAT_AUTO_TITLE_MAX_CHARS,
  ChatNotFoundError,
  TurnAlreadyRunningError,
  chatMessageKind,
  currentPrincipalId,
  findRunningTurn,
  getChatHistory,
  insertChatMessage,
  listChats,
  newChat,
  normalizeChatTitle,
  renameChat,
  requireChatAccess,
  sendChatMessage,
  setChatArchived,
} from './service.js';

/**
 * Integration tests (real Postgres; auto-skip without DATABASE_URL) for application/chat/
 * service.ts — docs/development-tasks.md S1.4 acceptance criteria: one running Turn per Chat
 * (409-shaped error), history paging, and the isolation guarantee (a private Chat is invisible to
 * a different principal).
 */

const DATABASE_URL = process.env.DATABASE_URL;

// Pure-function unit coverage (no DB) — runs regardless of DATABASE_URL, unlike every other
// describe block below. Review fix (code-review finding "chat.message payload drift"):
// `chatMessageKind` is the one helper every `chat.message` producer now shares to derive the
// top-level `kind` field (see this function's own doc comment in service.ts for the full story).
describe('chatMessageKind (unit, no DB)', () => {
  it('returns content.kind when it is a string, the same way the system-message producers already do', () => {
    expect(chatMessageKind({ kind: 'system.task_update', text: 'Task done' })).toBe(
      'system.task_update',
    );
  });

  it('returns undefined for a plain {text} content blob (user/assistant/tool messages today)', () => {
    expect(chatMessageKind({ text: 'hello' })).toBeUndefined();
  });

  it('returns undefined when content.kind is present but not a string', () => {
    expect(chatMessageKind({ kind: 42 })).toBeUndefined();
  });
});

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

// S6-A auto-title / rename (docs/console-completion-plan.md §4 "title 在第一条用户消息落库时自动生成
// （截断）", §5.1 "前 40 字"): the pure normalizer both `sendChatMessage`'s auto-title and
// `renameChat` share.
describe('normalizeChatTitle (unit, no DB)', () => {
  it('trims and collapses inner whitespace (newlines included) to one line', () => {
    expect(normalizeChatTitle('  hello \n\t world  ', 40)).toBe('hello world');
  });

  it('returns null when nothing printable is left', () => {
    expect(normalizeChatTitle('   \n\t ', 40)).toBeNull();
    expect(normalizeChatTitle('', 40)).toBeNull();
  });

  it('cuts to maxChars code points, never splitting a surrogate pair or a CJK character', () => {
    const cjk = '这是一个很长的对话标题'.repeat(5); // 55 code points
    const cut = normalizeChatTitle(cjk, CHAT_AUTO_TITLE_MAX_CHARS);
    expect(Array.from(cut ?? '')).toHaveLength(CHAT_AUTO_TITLE_MAX_CHARS);
    const emoji = '😀'.repeat(45);
    const cutEmoji = normalizeChatTitle(emoji, CHAT_AUTO_TITLE_MAX_CHARS);
    expect(Array.from(cutEmoji ?? '')).toHaveLength(CHAT_AUTO_TITLE_MAX_CHARS);
    expect(cutEmoji?.endsWith('😀')).toBe(true);
  });

  it('leaves a title at or under the limit untouched and trims a trailing space left by the cut', () => {
    expect(normalizeChatTitle('short title', 40)).toBe('short title');
    expect(normalizeChatTitle('abcd efgh', 5)).toBe('abcd');
  });
});

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
        const result = await client.query<{
          event_type: string;
          payload: { chatMessageId: string };
        }>(
          `select event_type, payload from outbox
         where workspace_id = $1 and event_type = 'TurnStarted'
         order by id desc limit 1`,
          [workspaceId],
        );
        return result.rows[0];
      });
      expect(outboxRow?.event_type).toBe('TurnStarted');
      expect(outboxRow?.payload.chatMessageId).toBe(message.id);
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

    // ---------------------------------------------------------------------------------------
    // S6-A chat lifecycle (docs/console-completion-plan.md §4, §5.1): auto-title on the first user
    // message, rename wins forever, archive/unarchive is a list-visibility change only.
    // ---------------------------------------------------------------------------------------

    it('auto-title: the first user message sets a null title (40 code points, one line) and pushes chat.metadata {title}; later messages never overwrite it', async () => {
      _resetChatPushEventsForTests();
      const chat = await inTxAs(ownerId, (client) => newChat(client, workspaceId, ownerId, {}));
      expect(chat.title).toBeNull();
      const pushed: unknown[] = [];
      subscribeToChatPushEvents(chat.id, (event) => pushed.push(event));

      const longText = `  first\nline ${'x'.repeat(60)}`;
      await inTxAs(ownerId, (client) =>
        sendChatMessage(client, workspaceId, ownerId, { chatId: chat.id, text: longText }),
      );
      const afterFirst = await inTxAs(ownerId, (client) =>
        requireChatAccess(client, workspaceId, chat.id),
      );
      expect(afterFirst.title).toBe(normalizeChatTitle(longText, CHAT_AUTO_TITLE_MAX_CHARS));
      expect(Array.from(afterFirst.title ?? '')).toHaveLength(CHAT_AUTO_TITLE_MAX_CHARS);
      expect(afterFirst.title).not.toContain('\n');
      expect(pushed).toContainEqual({
        type: 'chat.metadata',
        chatId: chat.id,
        metadata: { title: afterFirst.title },
      });

      // End the running Turn so a second message can be sent, then prove the title is stable.
      await inTxAs(ownerId, (client) =>
        client.query(
          `update activities set status = 'completed', ended_at = now()
           where workspace_id = $1 and chat_id = $2 and kind = 'agent_turn' and status = 'running'`,
          [workspaceId, chat.id],
        ),
      );
      await inTxAs(ownerId, (client) =>
        sendChatMessage(client, workspaceId, ownerId, { chatId: chat.id, text: 'second message' }),
      );
      const afterSecond = await inTxAs(ownerId, (client) =>
        requireChatAccess(client, workspaceId, chat.id),
      );
      expect(afterSecond.title).toBe(afterFirst.title);
    });

    it('auto-title: an explicit new_chat title is kept, and a whitespace-only first message leaves a null title alone', async () => {
      const titled = await inTxAs(ownerId, (client) =>
        newChat(client, workspaceId, ownerId, { title: 'given up front' }),
      );
      await inTxAs(ownerId, (client) =>
        sendChatMessage(client, workspaceId, ownerId, { chatId: titled.id, text: 'hello there' }),
      );
      const titledAfter = await inTxAs(ownerId, (client) =>
        requireChatAccess(client, workspaceId, titled.id),
      );
      expect(titledAfter.title).toBe('given up front');

      const blank = await inTxAs(ownerId, (client) => newChat(client, workspaceId, ownerId, {}));
      await inTxAs(ownerId, (client) =>
        sendChatMessage(client, workspaceId, ownerId, { chatId: blank.id, text: '   \n  ' }),
      );
      const blankAfter = await inTxAs(ownerId, (client) =>
        requireChatAccess(client, workspaceId, blank.id),
      );
      expect(blankAfter.title).toBeNull();
    });

    it('renameChat: normalizes the title, wins over a later auto-title, and audits chat.rename with the before/after pair', async () => {
      const chat = await inTxAs(ownerId, (client) => newChat(client, workspaceId, ownerId, {}));
      const renamed = await inTxAs(ownerId, (client) =>
        renameChat(client, workspaceId, {
          chatId: chat.id,
          title: '  my\n  renamed   chat ',
          actorPrincipalId: ownerId,
        }),
      );
      expect(renamed.title).toBe('my renamed chat');

      await inTxAs(ownerId, (client) =>
        sendChatMessage(client, workspaceId, ownerId, {
          chatId: chat.id,
          text: 'this would have been the auto-title',
        }),
      );
      const after = await inTxAs(ownerId, (client) =>
        requireChatAccess(client, workspaceId, chat.id),
      );
      expect(after.title).toBe('my renamed chat');

      const audit = await inTxAs(ownerId, (client) =>
        client.query<{ action: string; payload: Record<string, unknown> }>(
          `select action, payload from audit_records
           where workspace_id = $1 and resource_type = 'chat' and resource_id = $2 and action = 'chat.rename'`,
          [workspaceId, chat.id],
        ),
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]?.payload).toMatchObject({ from: null, to: 'my renamed chat' });
    });

    it('setChatArchived: archive hides the chat from listChats by default (includeArchived shows it), is idempotent, unarchive restores; both audited', async () => {
      const chat = await inTxAs(ownerId, (client) =>
        newChat(client, workspaceId, ownerId, { title: 'to archive' }),
      );
      const archived = await inTxAs(ownerId, (client) =>
        setChatArchived(client, workspaceId, {
          chatId: chat.id,
          archived: true,
          actorPrincipalId: ownerId,
        }),
      );
      expect(archived.archivedAt).toBeInstanceOf(Date);

      const defaultList = await inTxAs(ownerId, (client) =>
        listChats(client, workspaceId, ownerId),
      );
      expect(defaultList.some((c) => c.id === chat.id)).toBe(false);
      const withArchived = await inTxAs(ownerId, (client) =>
        listChats(client, workspaceId, ownerId, { includeArchived: true }),
      );
      const listed = withArchived.find((c) => c.id === chat.id);
      expect(listed?.archivedAt?.toISOString()).toBe(archived.archivedAt?.toISOString());

      // Idempotent: a second archive keeps the original timestamp.
      const again = await inTxAs(ownerId, (client) =>
        setChatArchived(client, workspaceId, {
          chatId: chat.id,
          archived: true,
          actorPrincipalId: ownerId,
        }),
      );
      expect(again.archivedAt?.toISOString()).toBe(archived.archivedAt?.toISOString());

      // History and access are untouched by archiving.
      const history = await inTxAs(ownerId, (client) =>
        getChatHistory(client, workspaceId, { chatId: chat.id }),
      );
      expect(history.messages).toEqual([]);

      const restored = await inTxAs(ownerId, (client) =>
        setChatArchived(client, workspaceId, {
          chatId: chat.id,
          archived: false,
          actorPrincipalId: ownerId,
        }),
      );
      expect(restored.archivedAt).toBeNull();
      const afterRestore = await inTxAs(ownerId, (client) =>
        listChats(client, workspaceId, ownerId),
      );
      expect(afterRestore.some((c) => c.id === chat.id)).toBe(true);

      const audit = await inTxAs(ownerId, (client) =>
        client.query<{ action: string }>(
          `select action from audit_records
           where workspace_id = $1 and resource_type = 'chat' and resource_id = $2
             and action in ('chat.archive', 'chat.unarchive')
           order by created_at asc, id asc`,
          [workspaceId, chat.id],
        ),
      );
      expect(audit.rows.map((r) => r.action)).toEqual([
        'chat.archive',
        'chat.archive',
        'chat.unarchive',
      ]);
    });

    it("setChatArchived / renameChat on another principal's private chat throw ChatNotFoundError (RLS, existence never leaked)", async () => {
      const chat = await inTxAs(ownerId, (client) => newChat(client, workspaceId, ownerId, {}));
      await expect(
        inTxAs(otherId, (client) =>
          setChatArchived(client, workspaceId, {
            chatId: chat.id,
            archived: true,
            actorPrincipalId: otherId,
          }),
        ),
      ).rejects.toBeInstanceOf(ChatNotFoundError);
      await expect(
        inTxAs(otherId, (client) =>
          renameChat(client, workspaceId, {
            chatId: chat.id,
            title: 'hijack',
            actorPrincipalId: otherId,
          }),
        ),
      ).rejects.toBeInstanceOf(ChatNotFoundError);
    });
  },
);
