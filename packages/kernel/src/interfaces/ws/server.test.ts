import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { generateKeyPair } from 'jose';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { publishPrincipalPushEvent } from '../../application/chat/index.js';
import { hashApiKey } from '../../application/gateway/index.js';
import { CONSOLE_SESSION_COOKIE, createUser } from '../../application/identity/index.js';
import { HANDLE_SIGNING_ALG, issueHandle } from '../../governance/capability/index.js';
import { createBackgroundServices, createServer } from '../../index.js';
import type { BackgroundServices } from '../../index.js';
import { WS_ERROR_CODES } from './rpc.js';
import { originMatchesHost } from './server.js';

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

describe('originMatchesHost (unit)', () => {
  it('no Origin header → true (non-browser clients: curl, the acceptance driver)', () => {
    expect(originMatchesHost({ host: 'example.com' })).toBe(true);
  });

  it('Origin host matches Host → true', () => {
    expect(originMatchesHost({ origin: 'https://example.com', host: 'example.com' })).toBe(true);
  });

  it('a different Origin host → false', () => {
    expect(originMatchesHost({ origin: 'https://evil.example', host: 'example.com' })).toBe(false);
  });

  it('X-Forwarded-Host wins over Host', () => {
    expect(
      originMatchesHost({
        origin: 'https://example.com',
        host: 'internal-upstream:8080',
        'x-forwarded-host': 'example.com',
      }),
    ).toBe(true);
    expect(
      originMatchesHost({
        origin: 'https://example.com',
        host: 'example.com',
        'x-forwarded-host': 'other.example',
      }),
    ).toBe(false);
  });

  it('a malformed Origin → false', () => {
    expect(originMatchesHost({ origin: 'not a url', host: 'example.com' })).toBe(false);
  });
});

describe.runIf(DATABASE_URL !== undefined)(
  '/ws chat protocol (integration, real Postgres + real listener)',
  () => {
    let pool: Pool;
    let app: FastifyInstance;
    let background: BackgroundServices;
    let wsUrl: string;
    let workspaceId: string;
    let ownerApiKey: string;
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
      ownerId = await adminInsertPrincipalWithKey(ownerApiKey);

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
      const chats = await client.call<{ items: unknown[] }>('list_chats', {});
      expect(Array.isArray(chats.items)).toBe(true);
      client.close();
    });

    it('first-frame auth: authenticate then chat methods work', async () => {
      const client = await WsRpcClient.connect(wsUrl);
      const authResult = await client.call<{ authenticated: boolean }>('authenticate', {
        token: ownerApiKey,
      });
      expect(authResult.authenticated).toBe(true);

      const chats = await client.call<{ items: unknown[] }>('list_chats', {});
      expect(Array.isArray(chats.items)).toBe(true);
      client.close();
    });

    it('first-frame auth with a bad token → unauthorized error and the socket is closed', async () => {
      const client = await WsRpcClient.connect(wsUrl);
      await expect(client.call('authenticate', { token: 'not-a-real-key' })).rejects.toMatchObject({
        code: -32001,
      });
      await client.waitForClose();
    });

    // Lane-4 P2 fix (docs/development-tasks.md; design doc §9.4 "human 通道认证后使用"): `/ws` is
    // human-only — a Handle-channel caller (a Worker's Task Handle) must never be able to
    // authenticate here and receive the obo human's own chat.*/action.*/task.* pushes. A real,
    // verifiable Handle token needs its own server instance with an explicit `loadHandlePublicKey`
    // (the shared `app`/`wsUrl` above uses the default key loader, which fails closed with no
    // `HANDLE_PRIVATE_KEY_FILE`/`HANDLE_PUBLIC_KEY_FILE` configured in this test environment —
    // same reasoning interfaces/http/capability-route.test.ts's own Handle-channel test documents).
    it('a Handle token via the first-frame authenticate RPC → unauthorized (chat is human-only)', async () => {
      const { publicKey, privateKey } = await generateKeyPair(HANDLE_SIGNING_ALG, {
        crv: 'Ed25519',
        extractable: true,
      });
      const token = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const sessionResult = await client.query<{ id: string }>(
            `insert into sessions (workspace_id, principal_id, kind, on_behalf_of, status)
           values ($1, $2, 'entry', $2, 'active') returning id`,
            [workspaceId, ownerId],
          );
          const sessionRow = sessionResult.rows[0];
          if (!sessionRow) throw new Error('fixture: session insert produced no row');
          const issued = await issueHandle(client, {
            sessionId: sessionRow.id,
            scope: { capabilities: ['get_object'], resources: {} },
            ttlSeconds: 3600,
            privateKey,
          });
          return issued.token;
        },
      );

      const handleApp = createServer({ pool, loadHandlePublicKey: async () => publicKey });
      const address = await handleApp.listen({ port: 0, host: '127.0.0.1' });
      const handleWsUrl = `${address.replace('http://', 'ws://')}/ws`;
      try {
        const client = await WsRpcClient.connect(handleWsUrl);
        await expect(client.call('authenticate', { token })).rejects.toMatchObject({
          code: -32001,
        });
        await client.waitForClose();
      } finally {
        await handleApp.close();
      }
    });

    it('a Handle token via the Authorization header → unauthorized and the socket is closed (chat is human-only)', async () => {
      const { publicKey, privateKey } = await generateKeyPair(HANDLE_SIGNING_ALG, {
        crv: 'Ed25519',
        extractable: true,
      });
      const token = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const sessionResult = await client.query<{ id: string }>(
            `insert into sessions (workspace_id, principal_id, kind, on_behalf_of, status)
           values ($1, $2, 'entry', $2, 'active') returning id`,
            [workspaceId, ownerId],
          );
          const sessionRow = sessionResult.rows[0];
          if (!sessionRow) throw new Error('fixture: session insert produced no row');
          const issued = await issueHandle(client, {
            sessionId: sessionRow.id,
            scope: { capabilities: ['get_object'], resources: {} },
            ttlSeconds: 3600,
            privateKey,
          });
          return issued.token;
        },
      );

      const handleApp = createServer({ pool, loadHandlePublicKey: async () => publicKey });
      const address = await handleApp.listen({ port: 0, host: '127.0.0.1' });
      const handleWsUrl = `${address.replace('http://', 'ws://')}/ws`;
      try {
        const client = await WsRpcClient.connect(handleWsUrl, { authorization: `Bearer ${token}` });
        // initAuth()'s header-based rejection sends an error notification with id:null (there is
        // no in-flight request to key it to) and closes the socket — the close itself is the
        // observable proof of rejection here, not a specific call's rejection.
        await client.waitForClose();
      } finally {
        await handleApp.close();
      }
    });

    // S4.1 (design doc §7.11 "CSRF ... WS 握手校验 Origin"): a cross-origin upgrade is rejected
    // before any auth attempt — see interfaces/ws/server.ts's own `originMatchesHost` doc comment.
    it('a cross-origin Origin header → FORBIDDEN as the very first frame, then the socket closes', async () => {
      const rawSocket = new WebSocket(wsUrl, { headers: { origin: 'https://evil.example' } });
      const firstMessage = await new Promise<JsonRpcMessage>((resolve, reject) => {
        rawSocket.once('message', (raw) => resolve(JSON.parse(raw.toString()) as JsonRpcMessage));
        rawSocket.once('error', reject);
      });
      expect(firstMessage.error?.code).toBe(WS_ERROR_CODES.FORBIDDEN);
      await new Promise<void>((resolve) => {
        if (rawSocket.readyState === rawSocket.CLOSED) {
          resolve();
          return;
        }
        rawSocket.once('close', () => resolve());
      });
    });

    // S4.1: the console session cookie (application/identity/console-session.ts) authenticates
    // `/ws` via the first-frame `authenticate {workspaceId}` RPC — the WS equivalent of
    // resolveRequestCaller's cookie path (interfaces/http/capability-route.ts already covers the
    // HTTP side; interfaces/http/auth-routes.integration.test.ts covers `POST /api/auth/login`
    // itself). Needs its own server instance with an injected Handle keypair (the shared
    // `app`/`wsUrl` above has none — see the existing Handle-token tests' own comments for why).
    describe('console-session cookie authenticate {workspaceId}', () => {
      let keyApp: FastifyInstance;
      let keyWsUrl: string;
      let consoleLogin: string;
      const consolePassword = 'correct horse battery staple';
      let secondWorkspaceId: string;
      let unrelatedWorkspaceId: string;

      beforeAll(async () => {
        const { publicKey, privateKey } = await generateKeyPair(HANDLE_SIGNING_ALG, {
          crv: 'Ed25519',
          extractable: true,
        });

        keyApp = createServer({
          pool,
          loadHandlePublicKey: async () => publicKey,
          loadHandlePrivateKey: async () => privateKey,
        });
        const address = await keyApp.listen({ port: 0, host: '127.0.0.1' });
        keyWsUrl = `${address.replace('http://', 'ws://')}/ws`;

        secondWorkspaceId = await adminInsertWorkspace('ws-server-test-second-workspace');
        unrelatedWorkspaceId = await adminInsertWorkspace('ws-server-test-unrelated-workspace');

        consoleLogin = `ws-console-${randomUUID().slice(0, 8)}`;
        const user = await createUser(pool, {
          login: consoleLogin,
          displayName: 'WS Console User',
          password: consolePassword,
        });

        // Membership 1: the existing owner Principal in the outer describe's own `workspaceId`.
        await withWorkspace(
          pool,
          { workspaceId, principalId: ownerId },
          async (client) => {
            await client.query(
              'update principals set user_id = $3 where workspace_id = $1 and id = $2',
              [workspaceId, ownerId, user.id],
            );
          },
          { skipRoleSwitch: true },
        );

        // Membership 2: a second Principal in a second workspace — two active memberships total,
        // so `authenticate {}` with no workspaceId hint cannot resolve one on its own.
        const secondPrincipalId = randomUUID();
        await withWorkspace(
          pool,
          { workspaceId: secondWorkspaceId, principalId: secondPrincipalId },
          async (client) => {
            await client.query(
              `insert into principals (workspace_id, id, kind, role, display_name, user_id)
             values ($1, $2, 'human', 'member', 'ws console user', $3)`,
              [secondWorkspaceId, secondPrincipalId, user.id],
            );
          },
          { skipRoleSwitch: true },
        );
      });

      afterAll(async () => {
        await keyApp.close();
      });

      async function loginForCookie(): Promise<string> {
        const response = await keyApp.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { 'x-requested-with': 'nexttime', 'content-type': 'application/json' },
          payload: { login: consoleLogin, password: consolePassword },
        });
        const raw = response.headers['set-cookie'];
        const setCookie = Array.isArray(raw) ? raw[0] : raw;
        if (typeof setCookie !== 'string') throw new Error('no Set-Cookie header');
        const match = new RegExp(`^${CONSOLE_SESSION_COOKIE}=([^;]*)`).exec(setCookie);
        if (!match?.[1]) throw new Error(`unexpected Set-Cookie: ${setCookie}`);
        return match[1];
      }

      it('authenticate {workspaceId} with the cookie → {authenticated:true}, then list_chats works', async () => {
        const token = await loginForCookie();
        const client = await WsRpcClient.connect(keyWsUrl, {
          cookie: `${CONSOLE_SESSION_COOKIE}=${token}`,
        });
        const authResult = await client.call<{ authenticated: boolean }>('authenticate', {
          workspaceId,
        });
        expect(authResult.authenticated).toBe(true);
        const chats = await client.call<{ items: unknown[] }>('list_chats', {});
        expect(Array.isArray(chats.items)).toBe(true);
        client.close();
      });

      it('authenticate {workspaceId} for a workspace the user is not a member of → FORBIDDEN', async () => {
        const token = await loginForCookie();
        const client = await WsRpcClient.connect(keyWsUrl, {
          cookie: `${CONSOLE_SESSION_COOKIE}=${token}`,
        });
        await expect(
          client.call('authenticate', { workspaceId: unrelatedWorkspaceId }),
        ).rejects.toMatchObject({ code: WS_ERROR_CODES.FORBIDDEN });
        await client.waitForClose();
      });

      it('authenticate {} with no workspaceId and two memberships → FORBIDDEN naming X-Workspace-Id', async () => {
        const token = await loginForCookie();
        const client = await WsRpcClient.connect(keyWsUrl, {
          cookie: `${CONSOLE_SESSION_COOKIE}=${token}`,
        });
        await expect(client.call('authenticate', {})).rejects.toMatchObject({
          code: WS_ERROR_CODES.FORBIDDEN,
          message: expect.stringContaining('X-Workspace-Id'),
        });
        await client.waitForClose();
      });

      it('authenticate {} with no cookie at all → UNAUTHORIZED', async () => {
        const client = await WsRpcClient.connect(keyWsUrl);
        await expect(client.call('authenticate', {})).rejects.toMatchObject({
          code: WS_ERROR_CODES.UNAUTHORIZED,
        });
        await client.waitForClose();
      });
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
      const chats = await client.call<{ items: unknown[] }>('list_chats', {});
      expect(Array.isArray(chats.items)).toBe(true);
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

      // Review fix (code-review finding "chat.message payload drift"): every live-push producer
      // (this transport's own publishSentMessagePush for the user's message, application/chat/
      // event-sink.ts for the assistant's reply) now carries `content`, mirroring what
      // get_chat_history already returned for both roles — and `kind`, which was previously set
      // only by the two application/linkage system-message push call sites. Both are `undefined`/
      // `{text}` here since neither row's content has a `kind` field of its own.
      type PushedMessage = { role: string; text: string; kind?: string; content?: unknown };
      const userPush = persistedMessages.find(
        (n) => (n.params as { message: { role: string } }).message.role === 'user',
      );
      expect(userPush).toBeTruthy();
      const userMessage = (userPush?.params as { message: PushedMessage }).message;
      expect(userMessage.kind).toBeUndefined();
      expect(userMessage.content).toEqual({ text: 'hello agent' });

      const assistantMessage = (assistantPush?.params as { message: PushedMessage }).message;
      expect(assistantMessage.kind).toBeUndefined();
      expect(assistantMessage.content).toEqual({ text: assistantMessage.text });

      const history = await client.call<{
        items: { role: string; sequence: number; kind?: string; content?: unknown }[];
      }>('get_chat_history', { chatId });
      expect(history.items).toHaveLength(2);
      expect(history.items.map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(history.items.map((m) => m.sequence)).toEqual([1, 2]);
      expect(history.items.map((m) => m.kind)).toEqual([undefined, undefined]);

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
            items: { sequence: number }[];
            nextCursor?: string;
          }>('get_chat_history', { chatId, cursor, limit: 2 });
          for (const m of page.items) seenViaPaging.add(m.sequence);
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

    // S2.11 deliverable 2 (docs/development-tasks.md S2.11 "WS push test through the existing
    // server test harness for action.pending/task.updated"; §9.4). Pushes are exercised directly
    // via `publishPrincipalPushEvent` — the outbox→push plumbing itself (application/linkage's
    // consumers reading a real ActionRequest/Task row and calling this same function) is covered
    // end-to-end by application/linkage/{task-consumer,action-request-consumer}.integration.test.ts;
    // this file's job is only to prove interfaces/ws/server.ts's own wiring — every authenticated
    // connection auto-subscribes to its own principal's push events with no separate
    // `subscribe_principal` call — actually delivers over the wire.
    it('every authenticated connection receives its own principal’s action.pending/task.updated pushes with no subscribe_principal call', async () => {
      const client = await WsRpcClient.connect(wsUrl, { authorization: `Bearer ${ownerApiKey}` });
      // Header-based auth's own subscribeCallerToPrincipalPush call happens inside initAuth(),
      // asynchronously, *before* the connection starts accepting/replaying frames
      // (state.authReady) — the client-side 'open' event above only means the WS handshake itself
      // finished, not that the server has gotten that far yet. A real RPC round-trip is only ever
      // answered *after* authReady flips true, so awaiting one here is what actually guarantees
      // the push subscription is already registered before this test publishes anything.
      await client.call('list_chats', {});

      publishPrincipalPushEvent(ownerId, {
        type: 'task.updated',
        id: 'task-1',
        status: 'completed',
      });
      publishPrincipalPushEvent(ownerId, {
        type: 'action.pending',
        actionRequestId: 'ar-1',
        gatekeeperId: 'gk-1',
        title: 'Approval needed: test action',
        description: 'test.action (via gk-1)',
        actionKind: { tag: 'test.action', label: 'test action' },
        awaitDecision: false,
      });

      await waitUntil(() => client.notifications.some((n) => n.method === 'task.updated'));
      await waitUntil(() => client.notifications.some((n) => n.method === 'action.pending'));

      const taskPush = client.notifications.find((n) => n.method === 'task.updated');
      expect(taskPush?.params).toMatchObject({ id: 'task-1', status: 'completed' });

      const actionPush = client.notifications.find((n) => n.method === 'action.pending');
      expect(actionPush?.params).toMatchObject({ actionRequestId: 'ar-1', gatekeeperId: 'gk-1' });

      client.close();
    });

    it('a push for a different principal never reaches this connection', async () => {
      const otherApiKey = `other-key-${randomUUID()}`;
      const otherId = await adminInsertPrincipalWithKey(otherApiKey);
      const client = await WsRpcClient.connect(wsUrl, { authorization: `Bearer ${ownerApiKey}` });
      // Same reason as the previous test: wait for a real round-trip so the push subscription is
      // guaranteed registered before either publish below.
      await client.call('list_chats', {});

      publishPrincipalPushEvent(otherId, {
        type: 'task.updated',
        id: 'task-not-mine',
        status: 'failed',
      });
      // No positive event to wait on for "never arrives" — publish one more, to *this* connection's
      // own principal, and rely on push delivery being in-order per listener (application/chat/
      // push.ts's `publishPrincipalPushEvent` calls listeners synchronously) to know the first
      // publish, if it had been (mis)delivered here, would already be in `notifications` by now.
      publishPrincipalPushEvent(ownerId, {
        type: 'task.updated',
        id: 'task-mine',
        status: 'completed',
      });
      await waitUntil(() =>
        client.notifications.some(
          (n) => n.method === 'task.updated' && (n.params as { id?: string }).id === 'task-mine',
        ),
      );

      expect(
        client.notifications.some(
          (n) =>
            n.method === 'task.updated' && (n.params as { id?: string }).id === 'task-not-mine',
        ),
      ).toBe(false);

      client.close();
    });
  },
);
