import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatSubscriptionHandlers, WebSocketLike } from './ws-client.js';
import { RpcError, TurnAlreadyRunningError, WsClient } from './ws-client.js';

/**
 * ws-client.test.ts: exercises `WsClient` (lib/ws-client.ts) against a fake `WebSocketLike`
 * rather than a real socket — deterministic, no kernel required (the Playwright suite,
 * packages/web/e2e/chat.spec.ts, is what runs this against a real kernel). Covers the behaviors
 * docs/development-tasks.md S1.8 deliverable 3 names explicitly: the authenticate handshake,
 * subscribe-before-page ordering, replay/live dedupe on `sequence`, reconnect resubscribing from
 * the last seen sequence, and `-32010` surfacing as a typed error.
 */

interface SentFrame {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
}

class FakeWebSocket implements WebSocketLike {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sent: SentFrame[] = [];
  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as SentFrame);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({});
  }

  /** Test helper: simulate the connection opening. */
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  /** Test helper: simulate a frame arriving from the server. */
  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  /** Test helper: simulate the server dropping the connection (distinct from `close()`, which
   *  mimics the client itself closing — `WsClient` only auto-reconnects on the former). */
  remoteClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1006, reason: 'abnormal closure' });
  }
}

function msg(sequence: number, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `m${sequence}`,
    role: 'assistant',
    text: `text-${sequence}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    sequence,
    ...overrides,
  };
}

function respond(socket: FakeWebSocket, frame: SentFrame, result: unknown): void {
  socket.receive({ jsonrpc: '2.0', id: frame.id, result });
}

function respondError(
  socket: FakeWebSocket,
  frame: SentFrame,
  error: { code: number; message: string },
): void {
  socket.receive({ jsonrpc: '2.0', id: frame.id, error });
}

function sentFrame(socket: FakeWebSocket, index: number): SentFrame {
  const frame = socket.sent[index];
  if (!frame) throw new Error(`expected socket.sent[${index}] to exist`);
  return frame;
}

/** Flushes several microtask ticks — enough for the shallow `await` chains this client uses
 *  (rpc response -> resolve -> caller continuation -> next rpc call) to fully settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function noopHandlers(overrides: Partial<ChatSubscriptionHandlers> = {}): ChatSubscriptionHandlers {
  return {
    onMessage: vi.fn(),
    onStream: vi.fn(),
    onMetadata: vi.fn(),
    ...overrides,
  };
}

function createTestClient(): { client: WsClient; sockets: FakeWebSocket[] } {
  const sockets: FakeWebSocket[] = [];
  const client = new WsClient({
    url: 'ws://kernel.test/ws',
    createSocket: (url) => {
      const socket = new FakeWebSocket(url);
      sockets.push(socket);
      return socket;
    },
    reconnectDelayMs: 0,
  });
  return { client, sockets };
}

/**
 * Connects, opens the most recently created socket, and completes an `authenticate("test-key")`
 * round trip. `client.connect()` synchronously invokes the injected `createSocket` factory before
 * returning its (still-pending) promise — so `sockets` already holds the new socket by the time
 * this function's very first line finishes, and this is safe to call again after a reconnect to
 * grab the *new* socket.
 */
async function connectAndAuth(client: WsClient, sockets: FakeWebSocket[]): Promise<FakeWebSocket> {
  const connectPromise = client.connect();
  const socket = sockets[sockets.length - 1];
  if (!socket) throw new Error('expected connect() to have created a socket synchronously');
  socket.open();
  await connectPromise;

  const authPromise = client.authenticate('test-key');
  respond(socket, sentFrame(socket, socket.sent.length - 1), { authenticated: true });
  await authPromise;
  return socket;
}

describe('WsClient', () => {
  let harness: ReturnType<typeof createTestClient>;

  beforeEach(() => {
    harness = createTestClient();
  });

  describe('authenticate handshake', () => {
    it('sends {method: "authenticate", params: {token}} as the first frame and resolves on success', async () => {
      const { client, sockets } = harness;
      const connectPromise = client.connect();
      const socket = sockets[0];
      if (!socket) throw new Error('expected a socket');
      socket.open();
      await connectPromise;

      const authPromise = client.authenticate('sk-abc');
      expect(socket.sent).toHaveLength(1);
      expect(sentFrame(socket, 0)).toMatchObject({
        jsonrpc: '2.0',
        method: 'authenticate',
        params: { token: 'sk-abc' },
      });

      respond(socket, sentFrame(socket, 0), { authenticated: true });
      await expect(authPromise).resolves.toBeUndefined();
    });

    it('rejects on an unauthorized error response', async () => {
      const { client, sockets } = harness;
      const connectPromise = client.connect();
      const socket = sockets[0];
      if (!socket) throw new Error('expected a socket');
      socket.open();
      await connectPromise;

      const authPromise = client.authenticate('bad-key');
      respondError(socket, sentFrame(socket, 0), { code: -32001, message: 'unauthorized' });

      await expect(authPromise).rejects.toBeInstanceOf(RpcError);
    });

    it('rejects call() invoked before authenticate() has succeeded', async () => {
      const { client, sockets } = harness;
      const connectPromise = client.connect();
      const socket = sockets[0];
      if (!socket) throw new Error('expected a socket');
      socket.open();
      await connectPromise;

      await expect(client.call('list_chats')).rejects.toThrow(/authenticate/);
      expect(socket.sent).toHaveLength(0);
    });
  });

  describe('subscribe-then-page ordering', () => {
    it('does not send get_chat_history until subscribe_chat has been acknowledged', async () => {
      const { client, sockets } = harness;
      const socket = await connectAndAuth(client, sockets);

      const subscribePromise = client.subscribeChat('chat-1', 0, noopHandlers());

      // subscribe_chat was sent synchronously (right after the earlier authenticate); get_chat_history
      // must not have been sent yet.
      expect(socket.sent.map((frame) => frame.method)).toEqual(['authenticate', 'subscribe_chat']);

      respond(socket, sentFrame(socket, socket.sent.length - 1), { subscribed: true });
      await flush();

      expect(socket.sent.map((frame) => frame.method)).toEqual([
        'authenticate',
        'subscribe_chat',
        'get_chat_history',
      ]);

      respond(socket, sentFrame(socket, socket.sent.length - 1), { messages: [] });
      await subscribePromise;
    });

    it('walks multiple get_chat_history pages until a page with no nextCursor arrives', async () => {
      const { client, sockets } = harness;
      const socket = await connectAndAuth(client, sockets);
      const onMessage = vi.fn();

      const subscribePromise = client.subscribeChat('chat-1', 0, noopHandlers({ onMessage }));
      respond(socket, sentFrame(socket, socket.sent.length - 1), { subscribed: true });
      await flush();

      const page1 = sentFrame(socket, socket.sent.length - 1);
      expect(page1.params).toMatchObject({ chatId: 'chat-1', cursor: '0' });
      respond(socket, page1, { messages: [msg(1)], nextCursor: '1' });
      await flush();

      const page2 = sentFrame(socket, socket.sent.length - 1);
      expect(page2.params).toMatchObject({ chatId: 'chat-1', cursor: '1' });
      respond(socket, page2, { messages: [msg(2)] });

      await subscribePromise;
      expect(onMessage.mock.calls.map(([m]) => (m as ChatMessage).sequence)).toEqual([1, 2]);
    });
  });

  describe('replay/live dedupe on sequence', () => {
    it('delivers a message exactly once when it arrives via both a live push and a history page', async () => {
      const { client, sockets } = harness;
      const socket = await connectAndAuth(client, sockets);
      const onMessage = vi.fn();

      const subscribePromise = client.subscribeChat('chat-1', 0, noopHandlers({ onMessage }));
      respond(socket, sentFrame(socket, socket.sent.length - 1), { subscribed: true });
      await flush();

      // A live push for sequence 2 arrives while the history page request is still in flight.
      socket.receive({
        jsonrpc: '2.0',
        method: 'chat.message',
        params: { chatId: 'chat-1', message: msg(2) },
      });

      respond(socket, sentFrame(socket, socket.sent.length - 1), {
        messages: [msg(1), msg(2), msg(3)],
      });

      await subscribePromise;
      expect(onMessage).toHaveBeenCalledTimes(3);
      expect(onMessage.mock.calls.map(([m]) => (m as ChatMessage).sequence)).toEqual([2, 1, 3]);
    });

    it('ignores chat.message/chat.stream pushes for a different chatId', async () => {
      const { client, sockets } = harness;
      const socket = await connectAndAuth(client, sockets);
      const onMessage = vi.fn();
      const onStream = vi.fn();

      const subscribePromise = client.subscribeChat(
        'chat-1',
        0,
        noopHandlers({ onMessage, onStream }),
      );
      respond(socket, sentFrame(socket, socket.sent.length - 1), { subscribed: true });
      await flush();
      respond(socket, sentFrame(socket, socket.sent.length - 1), { messages: [] });
      await subscribePromise;

      socket.receive({
        jsonrpc: '2.0',
        method: 'chat.message',
        params: { chatId: 'other-chat', message: msg(1) },
      });
      socket.receive({
        jsonrpc: '2.0',
        method: 'chat.stream',
        params: {
          chatId: 'other-chat',
          turnId: 't1',
          payload: { streamKind: 'textDelta', delta: 'nope' },
        },
      });

      expect(onMessage).not.toHaveBeenCalled();
      expect(onStream).not.toHaveBeenCalled();
    });
  });

  describe('reconnect', () => {
    it('reconnects after an unexpected close and resubscribes with startAfter = last seen sequence', async () => {
      const { client, sockets } = harness;
      const socket1 = await connectAndAuth(client, sockets);
      const onMessage = vi.fn();

      const subscribePromise = client.subscribeChat('chat-1', 0, noopHandlers({ onMessage }));
      respond(socket1, sentFrame(socket1, socket1.sent.length - 1), { subscribed: true });
      await flush();
      respond(socket1, sentFrame(socket1, socket1.sent.length - 1), { messages: [msg(1), msg(2)] });
      await subscribePromise;

      socket1.remoteClose();
      await wait(0);
      await flush();

      expect(sockets).toHaveLength(2);
      const socket2 = sockets[1];
      if (!socket2) throw new Error('expected a reconnect socket');
      socket2.open();
      await flush();

      expect(sentFrame(socket2, 0)).toMatchObject({
        method: 'authenticate',
        params: { token: 'test-key' },
      });
      respond(socket2, sentFrame(socket2, 0), { authenticated: true });
      await flush();

      expect(sentFrame(socket2, 1)).toMatchObject({
        method: 'subscribe_chat',
        params: { chatId: 'chat-1', startAfter: '2' },
      });
      respond(socket2, sentFrame(socket2, 1), { subscribed: true });
      await flush();

      expect(sentFrame(socket2, 2)).toMatchObject({
        method: 'get_chat_history',
        params: { chatId: 'chat-1', cursor: '2' },
      });
      respond(socket2, sentFrame(socket2, 2), { messages: [msg(3)] });
      await flush();

      // sequence 3 is new; 1 and 2 must not be redelivered across the reconnect.
      expect(onMessage.mock.calls.map(([m]) => (m as ChatMessage).sequence)).toEqual([1, 2, 3]);
    });

    it('does not auto-reconnect when the client itself calls close()', async () => {
      const { client, sockets } = harness;
      await connectAndAuth(client, sockets);
      client.close();
      await wait(0);
      await flush();
      expect(sockets).toHaveLength(1);
    });

    it('does not auto-reconnect after a failed initial authenticate()', async () => {
      const { client, sockets } = harness;
      const connectPromise = client.connect();
      const socket = sockets[0];
      if (!socket) throw new Error('expected a socket');
      socket.open();
      await connectPromise;

      const authPromise = client.authenticate('bad-key');
      respondError(socket, sentFrame(socket, 0), { code: -32001, message: 'unauthorized' });
      await authPromise.catch(() => undefined);

      socket.remoteClose();
      await wait(0);
      await flush();

      // No token was ever successfully established, so no reconnect attempt should follow.
      expect(sockets).toHaveLength(1);
    });

    it('does not schedule another reconnect if close() races an in-flight reconnect attempt', async () => {
      const { client, sockets } = harness;
      await connectAndAuth(client, sockets);
      const socket1 = sockets[0];
      if (!socket1) throw new Error('expected a socket');

      socket1.remoteClose();
      await wait(0); // the reconnect timer fires; reconnect() calls connect(), creating socket2
      await flush();
      expect(sockets).toHaveLength(2);

      // close() while reconnect() is still suspended awaiting socket2's open — this closes
      // socket2 before it ever opens, which used to (incorrectly) trigger another reconnect
      // attempt from reconnect()'s own catch block. That rejection is delivered to reconnect()
      // as a microtask *after* this close() call returns, and any reconnect attempt it might
      // (incorrectly) schedule is a *new* same-delay timer registered *after* the first `wait(0)`
      // below's own timer — so this needs a second wait/flush round for a wrongly-scheduled
      // attempt to actually have fired before the final assertion.
      client.close();
      await wait(0);
      await flush();
      await wait(0);
      await flush();

      expect(sockets).toHaveLength(2);
    });
  });

  describe('typed errors', () => {
    it('surfaces a -32010 error response as TurnAlreadyRunningError', async () => {
      const { client, sockets } = harness;
      const socket = await connectAndAuth(client, sockets);

      const sendPromise = client.sendChatMessage('chat-1', 'hello');
      const frame = sentFrame(socket, socket.sent.length - 1);
      expect(frame.method).toBe('send_chat_message');
      respondError(socket, frame, {
        code: -32010,
        message: 'chat chat-1 already has a Turn in progress',
      });

      await expect(sendPromise).rejects.toBeInstanceOf(TurnAlreadyRunningError);
    });

    it('surfaces other JSON-RPC error codes as a generic RpcError, not TurnAlreadyRunningError', async () => {
      const { client, sockets } = harness;
      const socket = await connectAndAuth(client, sockets);

      const callPromise = client.call('send_chat_message', { chatId: 'chat-1', text: '' });
      const frame = sentFrame(socket, socket.sent.length - 1);
      respondError(socket, frame, { code: -32602, message: 'invalid params' });

      const err = await callPromise.catch((caught: unknown) => caught);
      expect(err).toBeInstanceOf(RpcError);
      expect(err).not.toBeInstanceOf(TurnAlreadyRunningError);
      expect((err as RpcError).code).toBe(-32602);
    });
  });
});
