import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { mapCapabilityError } from '../../interfaces/http/capability-route.js';
import { sendChatMessage } from '../chat/index.js';
import { dispatchCapability } from './dispatch.js';
import { humanCaller, newWorkspace } from './traversal-fixture.js';

/**
 * Legacy 673: a message sent with an `idempotencyKey` is sent once. A send the console gave up on
 * may still have reached the kernel; sending it again with the same key returns that message and
 * its Turn as it stands (`changed: false`, `turnStatus`), and starts no second Turn — whose tool
 * calls and approvals would act twice (application/chat/service.ts `sendChatMessage`). The same
 * key with another text, or a key another person sent with, is refused and nothing is written.
 * Behind the kernel's look-up, migrations/core/0055's unique index holds one message per key in a
 * Chat, for two sends of one key at the same moment.
 *
 * The repeat-call walk (repeat-call.integration.test.ts) checks `send_chat_message`'s declared
 * answer (`idempotent`, with the key its schema-built params carry); this file covers the paths it
 * does not.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

interface SentWire {
  readonly messageId: string;
  readonly sequence: number;
  readonly turnId: string;
  readonly changed: boolean;
  readonly turnStatus: string;
}

describe.runIf(DATABASE_URL !== undefined)(
  'a message sent again with its idempotencyKey is sent once — legacy 673 (integration, real Postgres)',
  () => {
    let pool: Pool;

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
    });

    afterAll(async () => {
      await pool?.end();
    });

    /** A workspace with an owner and a member, and a Chat of the owner's. */
    async function workspace(name: string) {
      const created = await newWorkspace(pool, `send-once-${name}`, ['owner', 'member']);
      const ownerId = created.principals.get('owner') as string;
      const memberId = created.principals.get('member') as string;
      const owner = humanCaller(created.workspaceId, ownerId, 'owner');
      const member = humanCaller(created.workspaceId, memberId, 'member');
      const chat = (await dispatchCapability({ pool }, owner, 'new_chat', {})) as { id: string };
      return {
        workspaceId: created.workspaceId,
        ownerId,
        memberId,
        owner,
        member,
        chatId: chat.id,
      };
    }

    function send(
      caller: ReturnType<typeof humanCaller>,
      params: Record<string, unknown>,
    ): Promise<SentWire> {
      return dispatchCapability({ pool }, caller, 'send_chat_message', params) as Promise<SentWire>;
    }

    async function turnsOf(workspaceId: string, chatId: string) {
      const result = await pool.query<{ id: string; status: string }>(
        `select id, status from activities
         where workspace_id = $1 and chat_id = $2 and kind = 'agent_turn'
         order by created_at, id`,
        [workspaceId, chatId],
      );
      return result.rows;
    }

    async function userMessagesOf(workspaceId: string, chatId: string) {
      const result = await pool.query<{ id: string; turn_id: string; text: string }>(
        `select id, turn_id, content->>'text' as text from chat_messages
         where workspace_id = $1 and chat_id = $2 and role = 'user'
         order by sequence`,
        [workspaceId, chatId],
      );
      return result.rows;
    }

    async function turnStartedOf(workspaceId: string, chatId: string) {
      const result = await pool.query<{ turn_id: string }>(
        `select payload->>'turnId' as turn_id from outbox
         where workspace_id = $1 and event_type = 'TurnStarted' and payload->>'chatId' = $2
         order by id`,
        [workspaceId, chatId],
      );
      return result.rows.map((row) => row.turn_id);
    }

    async function sendAudit(workspaceId: string) {
      const result = await pool.query<{ payload: Record<string, unknown> }>(
        `select payload from audit_records where workspace_id = $1 and action = 'send_chat_message'
         order by created_at, id`,
        [workspaceId],
      );
      return result.rows.map((row) => row.payload);
    }

    /** Ends a Turn as the agent's report would (no runtime is wired in this test). */
    async function endTurn(turnId: string, status: 'completed' | 'failed' = 'completed') {
      await pool.query('update activities set status = $2, ended_at = now() where id = $1', [
        turnId,
        status,
      ]);
    }

    /** The refusal a call answers with, as HTTP and WS send it. */
    async function refusalOf(call: Promise<unknown>) {
      const error = await call.then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(error, 'the call must be refused').toBeDefined();
      return mapCapabilityError(error);
    }

    /** A client whose first `SAVEPOINT` runs `race` first, on other connections: what another send
     *  does between this send's look-up of its key and its Turn. */
    function racingAt(client: PoolClient, race: () => Promise<void>): PoolClient {
      let raced = false;
      return new Proxy(client, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (property !== 'query') {
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return async (text: unknown, values?: unknown[]) => {
            if (!raced && typeof text === 'string' && /^\s*savepoint/i.test(text)) {
              raced = true;
              await race();
            }
            return target.query(text as string, values);
          };
        },
      });
    }

    it('sent again with its key: the message sent, its Turn, nothing started, one audit row each', async () => {
      const { workspaceId, ownerId, owner, chatId } = await workspace('twice');
      const params = { chatId, text: 'open the ticket', idempotencyKey: randomUUID() };

      const first = await send(owner, params);
      const again = await send(owner, params);

      expect(first).toMatchObject({ changed: true, turnStatus: 'running', sequence: 1 });
      expect(again).toEqual({ ...first, changed: false });
      expect(await turnsOf(workspaceId, chatId)).toEqual([{ id: first.turnId, status: 'running' }]);
      expect(await userMessagesOf(workspaceId, chatId)).toEqual([
        { id: first.messageId, turn_id: first.turnId, text: 'open the ticket' },
      ]);
      expect(await turnStartedOf(workspaceId, chatId)).toEqual([first.turnId]);
      const audit = await sendAudit(workspaceId);
      expect(audit).toHaveLength(2);
      expect(audit[0]?.alreadySent).toBeUndefined();
      expect(audit[1]).toMatchObject({
        alreadySent: true,
        messageId: first.messageId,
        onBehalfOf: ownerId,
      });
    });

    it('its Turn already over: sent again, the message comes back with the Turn as it ended, and no other starts', async () => {
      const { workspaceId, owner, chatId } = await workspace('ended');
      const params = { chatId, text: 'restart the service', idempotencyKey: randomUUID() };
      const first = await send(owner, params);
      await endTurn(first.turnId, 'failed');

      const again = await send(owner, params);

      expect(again).toEqual({ ...first, changed: false, turnStatus: 'failed' });
      expect(await turnsOf(workspaceId, chatId)).toEqual([{ id: first.turnId, status: 'failed' }]);
      expect(await turnStartedOf(workspaceId, chatId)).toEqual([first.turnId]);

      // A new message — a new key — is a new Turn, as before.
      const next = await send(owner, { ...params, idempotencyKey: randomUUID() });
      expect(next).toMatchObject({ changed: true, turnStatus: 'running', sequence: 2 });
      expect(next.turnId).not.toBe(first.turnId);
    });

    it('the same key with another text is refused, naming the message it holds, and nothing is written', async () => {
      const { workspaceId, owner, chatId } = await workspace('other-text');
      const idempotencyKey = randomUUID();
      const first = await send(owner, { chatId, text: 'delete the branch', idempotencyKey });

      // Its Turn still runs, and the key's answer comes before that one.
      const refused = await refusalOf(
        send(owner, { chatId, text: 'delete the other branch', idempotencyKey }),
      );

      expect(refused).toMatchObject({
        status: 409,
        code: 'idempotency_key_reused',
        details: { messageId: first.messageId },
      });
      expect(await userMessagesOf(workspaceId, chatId)).toHaveLength(1);
      expect(await turnsOf(workspaceId, chatId)).toHaveLength(1);
    });

    it('a key another person sent with on a shared Chat is refused, even with the same text', async () => {
      const { workspaceId, owner, member, chatId } = await workspace('other-sender');
      await pool.query(`update chats set visibility = 'workspace' where id = $1`, [chatId]);
      const params = { chatId, text: 'same words', idempotencyKey: randomUUID() };
      const first = await send(owner, params);
      await endTurn(first.turnId);

      const refused = await refusalOf(send(member, params));

      expect(refused).toMatchObject({
        status: 409,
        code: 'idempotency_key_reused',
        details: { messageId: first.messageId },
      });
      expect(await turnsOf(workspaceId, chatId)).toHaveLength(1);
    });

    it('a key names a message of its own Chat only', async () => {
      const { workspaceId, owner, chatId } = await workspace('two-chats');
      const other = (await dispatchCapability({ pool }, owner, 'new_chat', {})) as { id: string };
      const idempotencyKey = randomUUID();

      const first = await send(owner, { chatId, text: 'hello', idempotencyKey });
      const elsewhere = await send(owner, { chatId: other.id, text: 'hello', idempotencyKey });

      expect(elsewhere.changed).toBe(true);
      expect(elsewhere.messageId).not.toBe(first.messageId);
      expect(await turnsOf(workspaceId, other.id)).toHaveLength(1);
    });

    it('without a key, a send while the Turn runs is refused as before', async () => {
      const { workspaceId, owner, chatId } = await workspace('no-key');
      const first = await send(owner, { chatId, text: 'first' });

      const refused = await refusalOf(send(owner, { chatId, text: 'first' }));

      expect(first).toMatchObject({ changed: true, turnStatus: 'running' });
      expect(refused).toMatchObject({ status: 409, code: 'turn_already_running' });
      expect(await userMessagesOf(workspaceId, chatId)).toHaveLength(1);
    });

    it('a new key while another message’s Turn runs is refused as before, and nothing is written', async () => {
      const { workspaceId, owner, chatId } = await workspace('other-key-running');
      await send(owner, { chatId, text: 'first', idempotencyKey: randomUUID() });

      const refused = await refusalOf(
        send(owner, { chatId, text: 'second', idempotencyKey: randomUUID() }),
      );

      expect(refused).toMatchObject({ status: 409, code: 'turn_already_running' });
      expect(await userMessagesOf(workspaceId, chatId)).toHaveLength(1);
      expect(await turnsOf(workspaceId, chatId)).toHaveLength(1);
    });

    it('a Chat archived since: sent again, the message comes back; a new message is refused', async () => {
      const { owner, chatId } = await workspace('archived');
      const params = { chatId, text: 'before the archive', idempotencyKey: randomUUID() };
      const first = await send(owner, params);
      await endTurn(first.turnId);
      await dispatchCapability({ pool }, owner, 'archive_chat', { chatId });

      const again = await send(owner, params);
      const refused = await refusalOf(send(owner, { ...params, idempotencyKey: randomUUID() }));

      expect(again).toEqual({ ...first, changed: false, turnStatus: 'completed' });
      expect(refused).toMatchObject({ status: 409, code: 'chat_archived' });
    });

    it('three sends of one key at once: one message, one Turn, every send answered with it', async () => {
      const { workspaceId, owner, chatId } = await workspace('at-once');
      const params = { chatId, text: 'at once', idempotencyKey: randomUUID() };

      const results = await Promise.all([
        send(owner, params),
        send(owner, params),
        send(owner, params),
      ]);

      const messageIds = new Set(results.map((result) => result.messageId));
      expect(messageIds.size).toBe(1);
      expect(results.filter((result) => result.changed)).toHaveLength(1);
      expect(await turnsOf(workspaceId, chatId)).toHaveLength(1);
      expect(await userMessagesOf(workspaceId, chatId)).toHaveLength(1);
      expect(await turnStartedOf(workspaceId, chatId)).toHaveLength(1);
    });

    it('the key sent by another call after this one looked it up: this one meets its running Turn and returns it', async () => {
      const { workspaceId, ownerId, owner, chatId } = await workspace('race-running');
      const params = { chatId, text: 'raced', idempotencyKey: randomUUID() };
      let winner: SentWire | undefined;

      const loser = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        sendChatMessage(
          racingAt(client, async () => {
            winner = await send(owner, params);
          }),
          workspaceId,
          ownerId,
          params,
        ),
      );

      expect(winner?.changed).toBe(true);
      expect(loser).toMatchObject({
        changed: false,
        turnId: winner?.turnId,
        turnStatus: 'running',
      });
      expect(loser.message.id).toBe(winner?.messageId);
      expect(await turnsOf(workspaceId, chatId)).toHaveLength(1);
      expect(await userMessagesOf(workspaceId, chatId)).toHaveLength(1);
    });

    it('the key sent and its Turn over after this one looked it up: the key’s index stops this one’s Turn', async () => {
      const { workspaceId, ownerId, owner, chatId } = await workspace('race-ended');
      const params = { chatId, text: 'raced and done', idempotencyKey: randomUUID() };
      let winner: SentWire | undefined;

      const loser = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        sendChatMessage(
          racingAt(client, async () => {
            winner = await send(owner, params);
            await endTurn(winner.turnId);
          }),
          workspaceId,
          ownerId,
          params,
        ),
      );

      expect(loser).toMatchObject({
        changed: false,
        turnId: winner?.turnId,
        turnStatus: 'completed',
      });
      // The Turn this send began before it met the key was rolled back with it.
      expect(await turnsOf(workspaceId, chatId)).toEqual([
        { id: winner?.turnId, status: 'completed' },
      ]);
      expect(await turnStartedOf(workspaceId, chatId)).toEqual([winner?.turnId]);
    });

    it('the database holds one message per key in a Chat, a key only on a person’s message, at most 200 characters', async () => {
      const { workspaceId, owner, chatId } = await workspace('guard');
      const other = (await dispatchCapability({ pool }, owner, 'new_chat', {})) as { id: string };
      const idempotencyKey = randomUUID();
      const insert = (chat: string, role: string, key: string | null, sequence: number) =>
        pool.query(
          `insert into chat_messages (workspace_id, chat_id, role, content, sequence, idempotency_key)
           values ($1, $2, $3, '{"text":"x"}', $4, $5)`,
          [workspaceId, chat, role, sequence, key],
        );

      await insert(chatId, 'user', idempotencyKey, 100);
      await expect(insert(chatId, 'user', idempotencyKey, 101)).rejects.toMatchObject({
        code: '23505',
        constraint: 'chat_messages_idempotency_key_uidx',
      });
      await insert(other.id, 'user', idempotencyKey, 100);
      await insert(chatId, 'user', null, 102);
      await insert(chatId, 'user', null, 103);
      await expect(insert(chatId, 'assistant', randomUUID(), 104)).rejects.toMatchObject({
        code: '23514',
        constraint: 'chat_messages_idempotency_key_shape',
      });
      await insert(chatId, 'user', 'k'.repeat(200), 105);
      await expect(insert(chatId, 'user', 'k'.repeat(201), 106)).rejects.toMatchObject({
        code: '23514',
        constraint: 'chat_messages_idempotency_key_shape',
      });
    });
  },
);
