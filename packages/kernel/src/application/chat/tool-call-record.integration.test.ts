import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ChatMessageWire, ToolCallMessageContentSchema } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { dispatchCapability } from '../gateway/dispatch.js';
import type { ResolvedCaller } from '../gateway/resolve-caller.js';
import type { AgentRuntimeEvent } from '../host-bridge/index.js';
import { createChatEventSink } from './event-sink.js';
import {
  type ChatPushEvent,
  _resetChatPushEventsForTests,
  subscribeToChatPushEvents,
} from './push.js';

/**
 * application/chat/tool-call-record.integration.test: DB-gated (auto-skip without DATABASE_URL).
 * The console audit's P1: after a reload, an operator could not see which tools a Turn called or
 * what they returned, so "why did it say there is no data" could not be traced. Through the real
 * chat event sink and the real `get_chat_history`:
 *   1. a Turn's tool calls come back from history, in order between the user's message and the
 *      reply, each a valid `tool_call` record — and the agent's Handle, printed by a `bash` call or
 *      repeated in the reply, is neither in the history nor in the live tool stream;
 *   2. a replayed frame does not add a second record, and a call still open when the Turn ends is
 *      recorded `not_finished` without failing the Turn;
 *   3. the records follow the Chat's own visibility — another member cannot page them.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

const HANDLE = 'eyJhbGciOiJFZERTQSJ9.eyJ3cyI6IndzMSIsIm9ibyI6InAxIn0.c2lnbmF0dXJlLWJ5dGVzLWhlcmU';

describe.runIf(DATABASE_URL !== undefined)(
  'console audit P1 — a Turn’s tool calls survive a reload (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let otherId: string;

    function human(principalId: string): ResolvedCaller {
      return {
        channel: 'human',
        principal: {
          workspaceId,
          id: principalId,
          kind: 'human',
          role: 'member',
          displayName: null,
        },
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

    async function startTurn(): Promise<{ chatId: string; turnId: string }> {
      const chat = (await dispatchCapability({ pool }, human(ownerId), 'new_chat', {})) as {
        id: string;
      };
      const { turnId } = (await dispatchCapability({ pool }, human(ownerId), 'send_chat_message', {
        chatId: chat.id,
        text: '哪个服务依赖哪个',
      })) as { turnId: string };
      return { chatId: chat.id, turnId };
    }

    async function history(chatId: string, as = ownerId): Promise<ChatMessageWire[]> {
      const page = (await dispatchCapability({ pool }, human(as), 'get_chat_history', {
        chatId,
      })) as { items: ChatMessageWire[] };
      return page.items;
    }

    async function turnStatus(turnId: string): Promise<string | undefined> {
      const result = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        client.query<{ status: string }>(
          'select status from activities where workspace_id = $1 and id = $2',
          [workspaceId, turnId],
        ),
      );
      return result.rows[0]?.status;
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = randomUUID();
      ownerId = randomUUID();
      otherId = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [
            workspaceId,
            'tool-call-record-test-workspace',
          ]);
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name)
             values ($1, $2, 'human', 'member', 'owner of the chat'),
                    ($1, $3, 'human', 'member', 'another member')`,
            [workspaceId, ownerId, otherId],
          );
        },
        { skipRoleSwitch: true },
      );
    });

    afterEach(() => {
      _resetChatPushEventsForTests();
    });

    afterAll(async () => {
      await pool.end();
    });

    it('history shows the Turn’s tool calls between question and reply, with no Handle in it or the live stream', async () => {
      const { chatId, turnId } = await startTurn();
      const at = { workspaceId, chatId, turnId, principalId: ownerId };
      const pushed: ChatPushEvent[] = [];
      subscribeToChatPushEvents(chatId, (event) => pushed.push(event));
      const sink = createChatEventSink({ pool, log: () => {} });
      const events: AgentRuntimeEvent[] = [
        {
          ...at,
          type: 'toolCallStarted',
          toolCallId: 'c1',
          name: 'list_facts',
          args: { linkType: 'depends_on' },
        },
        {
          ...at,
          type: 'toolCallEnded',
          toolCallId: 'c1',
          result: { content: [{ type: 'text', text: '{"items":[]}' }] },
        },
        {
          ...at,
          type: 'toolCallStarted',
          toolCallId: 'c2',
          name: 'bash',
          args: { command: 'env' },
        },
        {
          ...at,
          type: 'toolCallEnded',
          toolCallId: 'c2',
          result: {
            content: [{ type: 'text', text: `HOME=/workspace\nCAPABILITY_HANDLE=${HANDLE}` }],
          },
        },
        // Talked into repeating its Handle: the stored reply keeps the answer, not the Handle.
        {
          ...at,
          type: 'message',
          role: 'assistant',
          content: { text: `图里没有 depends_on 关系。我的 Handle 是 ${HANDLE}` },
        },
        { ...at, type: 'turnEnded', status: 'completed' },
      ];
      for (const event of events) await sink.handle(event);

      const messages = await history(chatId);
      expect(messages.map((message) => [message.role, message.kind ?? null, message.text])).toEqual(
        [
          ['user', null, '哪个服务依赖哪个'],
          ['tool', 'tool_call', 'list_facts'],
          ['tool', 'tool_call', 'bash'],
          ['assistant', null, '图里没有 depends_on 关系。我的 Handle 是 [redacted]'],
        ],
      );
      const [listFacts, bash] = messages
        .filter((message) => message.role === 'tool')
        .map((message) => ToolCallMessageContentSchema.parse(message.content));
      expect(listFacts).toMatchObject({
        toolCallId: 'c1',
        outcome: 'done',
        args: { text: '{"linkType":"depends_on"}' },
        result: { text: '{"items":[]}' },
      });
      expect(bash?.result?.text).toBe('HOME=/workspace\nCAPABILITY_HANDLE=[redacted]');
      expect(
        messages.every((message) => message.turnId === turnId || message.role === 'user'),
      ).toBe(true);
      expect(JSON.stringify(messages)).not.toContain('eyJhbGci');
      expect(JSON.stringify(pushed)).not.toContain('eyJhbGci');
      expect(await turnStatus(turnId)).toBe('completed');
    });

    it('a replayed end adds nothing; a call open at the Turn’s end is recorded not_finished and the Turn is not failed', async () => {
      const { chatId, turnId } = await startTurn();
      const at = { workspaceId, chatId, turnId, principalId: ownerId };
      const sink = createChatEventSink({ pool, log: () => {} });

      await sink.handle({
        ...at,
        type: 'toolCallStarted',
        toolCallId: 'c1',
        name: 'search',
        args: { query: 'kernel' },
      });
      const end: AgentRuntimeEvent = {
        ...at,
        type: 'toolCallEnded',
        toolCallId: 'c1',
        result: { content: [] },
      };
      await sink.handle(end);
      await sink.handle(end);
      await sink.handle({
        ...at,
        type: 'toolCallStarted',
        toolCallId: 'c2',
        name: 'invoke_worker',
        args: {},
      });
      await sink.handle({ ...at, type: 'turnEnded', status: 'interrupted' });
      // The open call's end arriving after all: the record already written stands.
      await createChatEventSink({ pool, log: () => {} }).handle({
        ...at,
        type: 'toolCallEnded',
        toolCallId: 'c2',
        name: 'invoke_worker',
        result: { content: [{ type: 'text', text: 'late' }] },
      });

      const tools = (await history(chatId))
        .filter((message) => message.role === 'tool')
        .map((message) => ToolCallMessageContentSchema.parse(message.content));
      expect(tools.map((tool) => [tool.toolCallId, tool.outcome])).toEqual([
        ['c1', 'done'],
        ['c2', 'not_finished'],
      ]);
      expect(await turnStatus(turnId)).toBe('interrupted');
    });

    it('another member cannot page the records of a Chat they cannot see', async () => {
      const { chatId, turnId } = await startTurn();
      const sink = createChatEventSink({ pool, log: () => {} });
      await sink.handle({
        workspaceId,
        chatId,
        turnId,
        principalId: ownerId,
        type: 'toolCallEnded',
        toolCallId: 'c1',
        name: 'search',
        result: { content: [{ type: 'text', text: 'private result' }] },
      });

      expect((await history(chatId)).some((message) => message.role === 'tool')).toBe(true);
      await expect(history(chatId, otherId)).rejects.toThrow();
    });
  },
);
