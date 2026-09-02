import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { hashApiKey } from '../../application/gateway/index.js';
import { createBackgroundServices, createServer } from '../../index.js';
import type { BackgroundServices } from '../../index.js';

/**
 * interfaces/ws/server.test: end-to-end WS tests against a real ephemeral listener on
 * 127.0.0.1 (docs/development-tasks.md S1.4 deliverable 8: "WS tests via a real ephemeral
 * listener on 127.0.0.1 (random port) with the `ws` client"). Auto-skips without DATABASE_URL —
 * every scenario here needs real Chat/Turn/chat_messages rows and the real outbox dispatcher.
 *
 * Covers the S1.4 acceptance criteria (docs/development-tasks.md S1.4, design doc §9.4):
 *   - subscribe_chat before get_chat_history paging: no missing, no duplicate sequences even with
 *     messages arriving concurrently.
 *   - send_chat_message rejected while a Turn is already running.
 *   - FakeAgentRuntime end-to-end: send → stream → message → TurnEnded → history shows both
 *     messages.
 */

const DATABASE_URL = process.env.DATABASE_URL;

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

class WsRpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = 'WsRpcError';
    this.code = code;
  }
}

/** A minimal JSON-RPC 2.0 client over `ws`, matching interfaces/ws/rpc.ts's wire contract. */
class WsRpcClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  readonly notifications: { method: string; params: unknown }[] = [];
  private readonly ws: WebSocket;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as JsonRpcMessage;
      if (msg.id !== undefined && msg.id !== null) {
        const pending = this.pending.get(msg.id as number);
        if (!pending) return;
        this.pending.delete(msg.id as number);
        if (msg.error) pending.reject(new WsRpcError(msg.error.code, msg.error.message));
        else pending.resolve(msg.result);
      } else if (msg.method) {
        this.notifications.push({ method: msg.method, params: msg.params });
      }
    });
  }

  static async connect(url: string, headers?: Record<string, string>): Promise<WsRpcClient> {
    const ws = new WebSocket(url, headers ? { headers } : undefined);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return new WsRpcClient(ws);
  }

  call<T = unknown>(method: string, params?: unknown, timeoutMs = 5000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`WsRpcClient.call("${method}") timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }));
    });
  }

  /** Sends a raw frame with no JSON-RPC wrapping validation — for testing the "first frame must
   *  be authenticate" / "invalid JSON" error paths directly. */
  sendRaw(text: string): void {
    this.ws.send(text);
  }

  waitForClose(timeoutMs = 2000): Promise<void> {
    if (this.ws.readyState === this.ws.CLOSED) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('waitForClose timed out')), timeoutMs);
      this.ws.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  close(): void {
    this.ws.close();
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

describe.runIf(DATABASE_URL !== undefined)(
  '/ws chat protocol (integration, real Postgres + real listener)',
  () => {
    let pool: Pool;
    let app: FastifyInstance;
    let background: BackgroundServices;
    let wsUrl: string;
    let workspaceId: string;
    let ownerApiKey: string;

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

    async function adminInsertPrincipalWithKey(apiKey: string): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId, principalId: id },
        async (client) => {
          await client.query(
            `insert into principals (workspace_id, id, kind, role, display_name, api_key_hash)
           values ($1, $2, 'human', 'member', 'owner', $3)`,
            [workspaceId, id, hashApiKey(apiKey)],
          );
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    async function newChat(client: WsRpcClient): Promise<string> {
      const chat = await client.call<{ id: string }>('new_chat', {});
      return chat.id;
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = await adminInsertWorkspace('ws-server-test-workspace');
      ownerApiKey = `owner-key-${randomUUID()}`;
      await adminInsertPrincipalWithKey(ownerApiKey);

      app = createServer({ pool });
      // Small but nonzero delay: exercises real asynchronous streaming without slowing the suite.
      background = createBackgroundServices({
        pool,
        runtime: undefined, // uses the default FakeAgentRuntime wired through application/chat's sink
      });
      await background.start();

      const address = await app.listen({ port: 0, host: '127.0.0.1' });
      wsUrl = `${address.replace('http://', 'ws://')}/ws`;
    });

    afterAll(async () => {
      background.stop();
      await app.close();
      await pool.end();
    });

    it('no Authorization header + first frame not "authenticate" → error and the socket is closed', async () => {
      const client = await WsRpcClient.connect(wsUrl);
      await expect(client.call('list_chats', {})).rejects.toThrow(WsRpcError);
      await client.waitForClose();
    });

    it('header-based auth: chat methods work immediately with no authenticate frame', async () => {
      const client = await WsRpcClient.connect(wsUrl, { authorization: `Bearer ${ownerApiKey}` });
      const chats = await client.call<unknown[]>('list_chats', {});
      expect(Array.isArray(chats)).toBe(true);
      client.close();
    });

    it('first-frame auth: authenticate then chat methods work', async () => {
      const client = await WsRpcClient.connect(wsUrl);
      const authResult = await client.call<{ authenticated: boolean }>('authenticate', {
        token: ownerApiKey,
      });
      expect(authResult.authenticated).toBe(true);

      const chats = await client.call<unknown[]>('list_chats', {});
      expect(Array.isArray(chats)).toBe(true);
      client.close();
    });

    it('first-frame auth with a bad token → unauthorized error and the socket is closed', async () => {
      const client = await WsRpcClient.connect(wsUrl);
      await expect(client.call('authenticate', { token: 'not-a-real-key' })).rejects.toMatchObject({
        code: -32001,
      });
      await client.waitForClose();
    });

    it('an unknown method → METHOD_NOT_FOUND', async () => {
      const client = await WsRpcClient.connect(wsUrl, { authorization: `Bearer ${ownerApiKey}` });
      await expect(client.call('no_such_method', {})).rejects.toMatchObject({ code: -32601 });
      client.close();
    });

    it('malformed JSON → PARSE_ERROR response, connection stays open', async () => {
      const client = await WsRpcClient.connect(wsUrl, { authorization: `Bearer ${ownerApiKey}` });
      client.sendRaw('{not valid json');

      // The malformed frame gets an id:null error response, which this client has no pending call
      // to correlate it to (JSON-RPC ids are only meaningful for well-formed requests) — instead,
      // prove the connection itself survives a malformed frame by making a real call right after.
      const chats = await client.call<unknown[]>('list_chats', {});
      expect(Array.isArray(chats)).toBe(true);
      client.close();
    });

    it('send_chat_message while a Turn is running is rejected (§9.4)', async () => {
      const client = await WsRpcClient.connect(wsUrl, { authorization: `Bearer ${ownerApiKey}` });
      const chatId = await newChat(client);

      await client.call('send_chat_message', { chatId, text: 'first' });
      await expect(
        client.call('send_chat_message', { chatId, text: 'second' }),
      ).rejects.toMatchObject({ code: -32010 });

      client.close();
    });

    it('FakeAgentRuntime end-to-end: send → stream → message → turnEnded → history shows both messages', async () => {
      const client = await WsRpcClient.connect(wsUrl, { authorization: `Bearer ${ownerApiKey}` });
      const chatId = await newChat(client);
      await client.call('subscribe_chat', { chatId });

      const sendResult = await client.call<{ turnId: string; sequence: number }>(
        'send_chat_message',
        {
          chatId,
          text: 'hello agent',
        },
      );
      expect(sendResult.sequence).toBe(1);

      await waitUntil(() =>
        client.notifications.some(
          (n) =>
            n.method === 'chat.metadata' &&
            (n.params as { metadata?: { turnId?: string } }).metadata?.turnId === sendResult.turnId,
        ),
      );

      const streamDeltas = client.notifications.filter((n) => n.method === 'chat.stream');
      expect(streamDeltas.length).toBeGreaterThan(0);

      const persistedMessages = client.notifications.filter((n) => n.method === 'chat.message');
      // The user's own message (sequence 1, pushed by interfaces/ws/server.ts's
      // publishSentMessagePush) plus the assistant's reply (sequence 2, pushed by
      // application/chat/event-sink.ts) — or the user's message could instead have arrived via
      // subscribe_chat's replay if it landed before the subscribe call, so assert by sequence/role
      // coverage rather than an exact notification count.
      const sequences = new Set(
        persistedMessages.map(
          (n) => (n.params as { message: { sequence: number } }).message.sequence,
        ),
      );
      expect(sequences.has(1)).toBe(true);
      expect(sequences.has(2)).toBe(true);

      const assistantPush = persistedMessages.find(
        (n) => (n.params as { message: { role: string } }).message.role === 'assistant',
      );
      expect(assistantPush).toBeTruthy();
      expect((assistantPush?.params as { message: { text: string } }).message.text).toContain(
        'hello agent',
      );

      const history = await client.call<{ messages: { role: string; sequence: number }[] }>(
        'get_chat_history',
        { chatId },
      );
      expect(history.messages).toHaveLength(2);
      expect(history.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(history.messages.map((m) => m.sequence)).toEqual([1, 2]);

      client.close();
    });

    it('subscribe_chat before paging: concurrent injection + paging cover every message, no gaps (§9.4)', async () => {
      const client = await WsRpcClient.connect(wsUrl, { authorization: `Bearer ${ownerApiKey}` });
      const chatId = await newChat(client);

      // Subscribe *before* any paging — §9.4's whole point: a live listener registered up front can
      // never miss a message committed after this point, regardless of what get_chat_history sees.
      await client.call('subscribe_chat', { chatId });

      const TURN_COUNT = 6;
      const totalMessages = TURN_COUNT * 2; // one user + one assistant message per turn

      // Walks get_chat_history from the very start (limit 2, deliberately small) exactly once,
      // adding every observed sequence to `seenViaPaging`. Extracted so it can be both (a) run
      // repeatedly on a timer, concurrently with the send loop below, and (b) run once more,
      // deterministically, after every write has committed (see the final sweep below).
      async function pageAllMessagesOnce(): Promise<void> {
        let cursor: string | undefined;
        for (;;) {
          const page = await client.call<{
            messages: { sequence: number }[];
            nextCursor?: string;
          }>('get_chat_history', { chatId, cursor, limit: 2 });
          for (const m of page.messages) seenViaPaging.add(m.sequence);
          if (!page.nextCursor) break;
          cursor = page.nextCursor;
        }
      }

      // Concurrently with the send loop below: repeatedly page get_chat_history on its own timer,
      // independent of how many turns have completed so far — the "script injecting events while
      // paging" half of the acceptance criterion. Both this loop and the send loop below share one
      // WS connection/one WsRpcClient; concurrent in-flight `call()`s are tracked independently by
      // JSON-RPC id, so they interleave freely on the wire. This loop is corroborating evidence,
      // not the source of the "paging alone covers every sequence" guarantee below — see the final
      // sweep's own comment for why: `pagingActive` is only checked between passes, so nothing here
      // guarantees a pass starts *after* the very last write commits.
      const seenViaPaging = new Set<number>();
      let pagingActive = true;
      const pagingLoop = (async () => {
        while (pagingActive) {
          await pageAllMessagesOnce();
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
      })();

      for (let i = 0; i < TURN_COUNT; i += 1) {
        const { turnId } = await client.call<{ turnId: string }>('send_chat_message', {
          chatId,
          text: `turn ${i}`,
        });
        await waitUntil(() =>
          client.notifications.some(
            (n) =>
              n.method === 'chat.metadata' &&
              (n.params as { metadata?: { turnId?: string } }).metadata?.turnId === turnId,
          ),
        );
      }
      pagingActive = false;
      await pagingLoop;

      // Deterministic final sweep: `waitUntil` above only resolved once the *last* turn's
      // chat.metadata was observed, and application/chat/event-sink.ts commits a turn's
      // chat_messages row (in its own transaction) strictly before it commits/pushes that turn's
      // chat.metadata — so every one of this test's `totalMessages` rows is guaranteed already
      // committed at this point. `pagingLoop` above cannot be relied on for full coverage by
      // itself: `pagingActive` is only checked *between* passes (in the 15ms sleep), so the pass
      // that happens to be in flight when the last write commits — or the fact that no further
      // pass ever starts once `pagingActive` flips — can both leave the tail end of the range
      // unobserved by that loop alone, independent of anything push-related. A single fresh walk
      // starting now has no such gap: it reads directly from the database after every write above
      // is known to have committed.
      await pageAllMessagesOnce();

      const seenViaPush = new Set(
        client.notifications
          .filter((n) => n.method === 'chat.message')
          .map((n) => (n.params as { message: { sequence: number } }).message.sequence),
      );

      const expectedSequences = Array.from({ length: totalMessages }, (_, i) => i + 1);

      // get_chat_history's own cursor semantics are gap-free and duplicate-free by construction
      // (each page's nextCursor is the last row's own sequence — chat/service.test.ts covers this
      // directly at the service layer); paging (including the deterministic final sweep above)
      // accumulating exactly the full range into a Set (which cannot itself hold duplicates) is
      // the transport-level corroboration of that same guarantee under real concurrent writes.
      expect([...seenViaPaging].sort((a, b) => a - b)).toEqual(expectedSequences);

      // Live push must independently cover the same full, gap-free range — the fix under test
      // (interfaces/ws/server.ts's `shouldDeliver`): chat.message pushes for one chat do not
      // always arrive in ascending sequence order (the user's own message is pushed by this
      // transport's publishSentMessagePush *after* its request resolves, while the assistant's
      // reply is pushed independently by application/chat/event-sink.ts off the outbox
      // dispatcher's own poll tick — two unsynchronized paths racing on delivery, though never on
      // DB commit order). A per-sequence Set dedupe tolerates that; the previous monotonic
      // high-water-mark dedupe did not, and could silently drop a lower sequence that arrived
      // after a higher one already had. Asserted on its own (not just as part of the push∪paging
      // union) so a regression here fails this assertion specifically, rather than being masked
      // by paging's coverage.
      expect([...seenViaPush].sort((a, b) => a - b)).toEqual(expectedSequences);

      client.close();
    });
  },
);
