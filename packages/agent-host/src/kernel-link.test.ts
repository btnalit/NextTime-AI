import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { createKernelLink } from './kernel-link.js';
import type { KernelLink } from './kernel-link.js';

/**
 * kernel-link.test: a real `ws` server standing in for the kernel's `/internal/agent-host`
 * endpoint (same "real ephemeral listener" style `packages/kernel/src/interfaces/ws/server.test.ts`
 * and `agent-host.test.ts` already use, from the other side of the same wire).
 */

/** Stand-in internal-plane token for every test below — the fake server never actually checks it
 *  (the kernel-side guard is covered by packages/kernel/src/interfaces/ws/agent-host.test.ts); the
 *  "sends the Authorization header" test asserts the *client* presents it on the handshake. */
const TOKEN = randomBytes(32).toString('hex');

interface FakeKernelServer {
  readonly url: string;
  readonly connections: WebSocket[];
  /** The `Authorization` header (if any) each accepted connection's handshake request carried,
   *  same index as `connections`. */
  readonly authorizationHeaders: Array<string | undefined>;
  nextConnection(): Promise<WebSocket>;
  close(): Promise<void>;
}

function startFakeKernelServer(): Promise<FakeKernelServer> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    const connections: WebSocket[] = [];
    const authorizationHeaders: Array<string | undefined> = [];
    // Every accepted connection is queued here as a resolved promise slot — nextConnection()
    // always returns the *next* one it hasn't handed out yet (FIFO), whether it already arrived
    // or is still pending, without needing to track "already consumed" separately.
    const pending: Array<{
      resolve: (ws: WebSocket) => void;
    }> = [];
    let delivered = 0;

    wss.on('connection', (ws, req) => {
      connections.push(ws);
      authorizationHeaders.push(req.headers.authorization);
      const waiter = pending[delivered];
      if (waiter) {
        waiter.resolve(ws);
        delivered += 1;
      }
    });

    wss.once('listening', () => {
      const address = wss.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        url: `ws://127.0.0.1:${port}`,
        connections,
        authorizationHeaders,
        nextConnection(): Promise<WebSocket> {
          return new Promise((res) => {
            pending.push({ resolve: res });
            if (connections.length >= pending.length) {
              const ws = connections[pending.length - 1];
              if (ws) {
                delivered = pending.length;
                res(ws);
              }
            }
          });
        },
        close(): Promise<void> {
          for (const c of connections) c.terminate();
          return new Promise((res) => wss.close(() => res()));
        },
      });
    });
  });
}

function nextMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve) => {
    ws.once('message', (raw) => resolve(JSON.parse(raw.toString())));
  });
}

let link: KernelLink | undefined;
let server: FakeKernelServer | undefined;

afterEach(async () => {
  link?.stop();
  link = undefined;
  await server?.close();
  server = undefined;
});

describe('createKernelLink', () => {
  it('sends hello with the given instanceId immediately on connect', async () => {
    server = await startFakeKernelServer();
    const instanceId = randomUUID();
    link = createKernelLink({
      kernelWsUrl: server.url,
      authorizationHeader: `Bearer ${TOKEN}`,
      instanceId,
      onStartTurn: () => {},
      onStopTurn: () => {},
      log: () => {},
    });

    const connectionPromise = server.nextConnection();
    link.start();
    const serverSideSocket = await connectionPromise;
    const hello = await nextMessage(serverSideSocket);

    expect(hello).toEqual({ type: 'hello', instanceId });
    await vi.waitFor(() => expect(link?.isConnected()).toBe(true));
  });

  it('sends the configured Authorization header on the WS handshake, on every (re)connect', async () => {
    server = await startFakeKernelServer();
    link = createKernelLink({
      kernelWsUrl: server.url,
      authorizationHeader: `Bearer ${TOKEN}`,
      instanceId: randomUUID(),
      onStartTurn: () => {},
      onStopTurn: () => {},
      reconnectBaseDelayMs: 5,
      reconnectMaxDelayMs: 20,
      log: () => {},
    });

    const firstConnection = server.nextConnection();
    link.start();
    const firstServerSocket = await firstConnection;
    await nextMessage(firstServerSocket); // hello
    expect(server.authorizationHeaders[0]).toBe(`Bearer ${TOKEN}`);

    // A reconnect is a brand-new HTTP upgrade request — the header must be present again, not
    // only on the very first attempt.
    const secondConnectionPromise = server.nextConnection();
    firstServerSocket.terminate();
    const secondServerSocket = await secondConnectionPromise;
    await nextMessage(secondServerSocket); // hello
    expect(server.authorizationHeaders[1]).toBe(`Bearer ${TOKEN}`);
  });

  it('routes an inbound startTurn to onStartTurn and stopTurn to onStopTurn', async () => {
    server = await startFakeKernelServer();
    const startCalls: unknown[] = [];
    const stopCalls: unknown[] = [];
    link = createKernelLink({
      kernelWsUrl: server.url,
      authorizationHeader: `Bearer ${TOKEN}`,
      instanceId: randomUUID(),
      onStartTurn: (cmd) => startCalls.push(cmd),
      onStopTurn: (cmd) => stopCalls.push(cmd),
      log: () => {},
    });

    const connectionPromise = server.nextConnection();
    link.start();
    const serverSideSocket = await connectionPromise;
    await nextMessage(serverSideSocket); // hello

    const startTurn = {
      type: 'startTurn',
      workspaceId: 'ws-1',
      chatId: 'chat-1',
      turnId: 'turn-1',
      principalId: 'p-1',
      prompt: 'hello',
      handle: 'jwt',
      kernelLlmUrl: 'http://llm-proxy:8082',
    };
    serverSideSocket.send(JSON.stringify(startTurn));
    await vi.waitFor(() => expect(startCalls).toHaveLength(1));
    expect(startCalls[0]).toEqual(startTurn);

    const stopTurn = { type: 'stopTurn', turnId: 'turn-1', principalId: 'p-1' };
    serverSideSocket.send(JSON.stringify(stopTurn));
    await vi.waitFor(() => expect(stopCalls).toHaveLength(1));
    expect(stopCalls[0]).toEqual(stopTurn);
  });

  it('ignores malformed/invalid frames from the kernel without disconnecting', async () => {
    server = await startFakeKernelServer();
    const startCalls: unknown[] = [];
    link = createKernelLink({
      kernelWsUrl: server.url,
      authorizationHeader: `Bearer ${TOKEN}`,
      instanceId: randomUUID(),
      onStartTurn: (cmd) => startCalls.push(cmd),
      onStopTurn: () => {},
      log: () => {},
    });

    const connectionPromise = server.nextConnection();
    link.start();
    const serverSideSocket = await connectionPromise;
    await nextMessage(serverSideSocket); // hello

    serverSideSocket.send('not json');
    serverSideSocket.send(JSON.stringify({ type: 'notAKnownFrame' }));
    serverSideSocket.send(JSON.stringify({ type: 'startTurn' /* missing required fields */ }));

    const startTurn = {
      type: 'startTurn',
      workspaceId: 'ws-1',
      chatId: 'chat-1',
      turnId: 'turn-1',
      principalId: 'p-1',
      prompt: 'hello',
      handle: 'jwt',
      kernelLlmUrl: 'http://llm-proxy:8082',
    };
    serverSideSocket.send(JSON.stringify(startTurn));
    await vi.waitFor(() => expect(startCalls).toHaveLength(1));
  });

  it('sends well-shaped runtimeEvent/turnAccepted/turnRejected/turnUnknown frames, numbered in order', async () => {
    server = await startFakeKernelServer();
    link = createKernelLink({
      kernelWsUrl: server.url,
      authorizationHeader: `Bearer ${TOKEN}`,
      instanceId: randomUUID(),
      onStartTurn: () => {},
      onStopTurn: () => {},
      log: () => {},
    });

    const connectionPromise = server.nextConnection();
    link.start();
    const serverSideSocket = await connectionPromise;
    await nextMessage(serverSideSocket); // hello

    link.sendTurnAccepted('turn-1');
    expect(await nextMessage(serverSideSocket)).toEqual({
      type: 'turnAccepted',
      turnId: 'turn-1',
      seq: 1,
    });

    link.sendTurnRejected('turn-2', 'busy');
    expect(await nextMessage(serverSideSocket)).toEqual({
      type: 'turnRejected',
      turnId: 'turn-2',
      reason: 'busy',
      seq: 2,
    });

    const event = {
      type: 'textDelta' as const,
      delta: 'hi',
      workspaceId: 'ws-1',
      chatId: 'chat-1',
      turnId: 'turn-1',
      principalId: 'p-1',
    };
    link.sendRuntimeEvent(event);
    expect(await nextMessage(serverSideSocket)).toEqual({ type: 'runtimeEvent', event, seq: 3 });

    link.sendTurnUnknown('turn-3');
    expect(await nextMessage(serverSideSocket)).toEqual({
      type: 'turnUnknown',
      turnId: 'turn-3',
      seq: 4,
    });
  });

  it('does not throw when sending while disconnected', async () => {
    server = await startFakeKernelServer();
    link = createKernelLink({
      kernelWsUrl: server.url,
      authorizationHeader: `Bearer ${TOKEN}`,
      instanceId: randomUUID(),
      onStartTurn: () => {},
      onStopTurn: () => {},
      log: () => {},
    });
    // Never started — never connected.
    expect(link.isConnected()).toBe(false);
    expect(() => link?.sendTurnAccepted('turn-1')).not.toThrow();
  });

  it('reconnects with backoff after a drop, re-sending hello', async () => {
    server = await startFakeKernelServer();
    link = createKernelLink({
      kernelWsUrl: server.url,
      authorizationHeader: `Bearer ${TOKEN}`,
      instanceId: randomUUID(),
      onStartTurn: () => {},
      onStopTurn: () => {},
      reconnectBaseDelayMs: 5,
      reconnectMaxDelayMs: 20,
      log: () => {},
    });

    const firstConnection = server.nextConnection();
    link.start();
    const firstServerSocket = await firstConnection;
    await nextMessage(firstServerSocket); // hello
    await vi.waitFor(() => expect(link?.isConnected()).toBe(true));

    // Not asserted in between: with a 5ms reconnectBaseDelayMs, the reconnect can complete before
    // any poll of isConnected() ever observes the brief `false` window — flaky by construction.
    // The real assertion is what follows: a genuinely new connection arrives at the server and
    // sends its own hello.
    const secondConnectionPromise = server.nextConnection();
    firstServerSocket.terminate();

    const secondServerSocket = await secondConnectionPromise;
    const hello = await nextMessage(secondServerSocket);
    expect(hello).toMatchObject({ type: 'hello' });
    await vi.waitFor(() => expect(link?.isConnected()).toBe(true));
  });

  it('backs off while the kernel refuses the link with 1013 (another link is registered), instead of retrying at the base delay', async () => {
    // The kernel accepts the upgrade and then closes a refused second link with 1013, so `open`
    // fires on every attempt — the backoff must not be reset by it.
    const refusing = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    const connectedAt: number[] = [];
    refusing.on('connection', (ws) => {
      connectedAt.push(Date.now());
      ws.close(1013, 'agent-host link already registered');
    });
    await new Promise<void>((resolve) => refusing.once('listening', () => resolve()));
    const address = refusing.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const lines: string[] = [];
    link = createKernelLink({
      kernelWsUrl: `ws://127.0.0.1:${port}`,
      authorizationHeader: `Bearer ${TOKEN}`,
      instanceId: randomUUID(),
      onStartTurn: () => {},
      onStopTurn: () => {},
      reconnectBaseDelayMs: 25,
      reconnectMaxDelayMs: 10_000,
      log: (line) => lines.push(line),
    });
    try {
      link.start();
      // Delays 25, 50, 100, 200 ms: the fifth attempt lands ~375 ms in. Without the backoff it
      // would land ~100 ms in, every gap ~25 ms.
      await vi.waitFor(() => expect(connectedAt.length).toBeGreaterThanOrEqual(5), {
        timeout: 3_000,
      });
      const gaps = connectedAt.slice(1).map((t, i) => t - (connectedAt[i] as number));
      expect(gaps[3]).toBeGreaterThanOrEqual(150);
      expect(gaps[3]).toBeGreaterThan(gaps[0] as number);
      expect(lines.some((l) => l.includes('kernel-link: refused'))).toBe(true);
    } finally {
      link.stop();
      for (const client of refusing.clients) client.terminate();
      await new Promise<void>((resolve) => refusing.close(() => resolve()));
    }
  });

  it('stop() halts reconnection', async () => {
    server = await startFakeKernelServer();
    link = createKernelLink({
      kernelWsUrl: server.url,
      authorizationHeader: `Bearer ${TOKEN}`,
      instanceId: randomUUID(),
      onStartTurn: () => {},
      onStopTurn: () => {},
      reconnectBaseDelayMs: 5,
      reconnectMaxDelayMs: 20,
      log: () => {},
    });

    const firstConnection = server.nextConnection();
    link.start();
    const firstServerSocket = await firstConnection;
    await nextMessage(firstServerSocket); // hello

    link.stop();
    firstServerSocket.terminate();

    const connectionCountAfterStop = server.connections.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.connections.length).toBe(connectionCountAfterStop);
    expect(link.isConnected()).toBe(false);
  });
});

/** Every message `ws` receives from here on, parsed, in arrival order. */
function collect(ws: WebSocket): unknown[] {
  const received: unknown[] = [];
  ws.on('message', (raw) => received.push(JSON.parse(raw.toString())));
  return received;
}

const CORRELATION = { workspaceId: 'ws-1', chatId: 'chat-1', principalId: 'p-1' };

function finalMessage(turnId: string, text: string) {
  return {
    type: 'message' as const,
    role: 'assistant' as const,
    content: { text },
    ...CORRELATION,
    turnId,
  };
}

function turnEnded(turnId: string) {
  return { type: 'turnEnded' as const, status: 'completed' as const, ...CORRELATION, turnId };
}

function textDelta(turnId: string, delta: string) {
  return { type: 'textDelta' as const, delta, ...CORRELATION, turnId };
}

type ReceivedFrame = {
  type: string;
  turnId?: string;
  seq?: number;
  event?: { type: string; turnId: string };
};

function frameTurnId(frame: ReceivedFrame): string | undefined {
  return frame.turnId ?? frame.event?.turnId;
}

function frameKind(frame: ReceivedFrame): string | undefined {
  return frame.type === 'runtimeEvent' ? frame.event?.type : frame.type;
}

describe('createKernelLink — replay after a flap (R-56)', () => {
  it('a Turn that ends while the link is down: its final message and turnEnded follow hello on reconnect', async () => {
    server = await startFakeKernelServer();
    link = createKernelLink({
      kernelWsUrl: server.url,
      authorizationHeader: `Bearer ${TOKEN}`,
      instanceId: randomUUID(),
      onStartTurn: () => {},
      onStopTurn: () => {},
      reconnectBaseDelayMs: 150, // a wide enough window to send into while the link is down
      log: () => {},
    });

    const first = server.nextConnection();
    link.start();
    const firstSocket = await first;
    await nextMessage(firstSocket); // hello

    const second = server.nextConnection();
    firstSocket.terminate();
    await vi.waitFor(() => expect(link?.isConnected()).toBe(false));
    link.sendRuntimeEvent(finalMessage('turn-1', 'the answer'));
    link.sendRuntimeEvent(turnEnded('turn-1'));

    const secondSocket = await second;
    const received = collect(secondSocket);
    await vi.waitFor(() => expect(received).toHaveLength(3));
    expect(received[0]).toMatchObject({ type: 'hello' });
    expect(received[1]).toEqual({
      type: 'runtimeEvent',
      event: finalMessage('turn-1', 'the answer'),
      seq: 1,
    });
    expect(received[2]).toEqual({ type: 'runtimeEvent', event: turnEnded('turn-1'), seq: 2 });
  });

  it('frames written into a link that then dropped are sent again unless the kernel acknowledged them', async () => {
    server = await startFakeKernelServer();
    link = createKernelLink({
      kernelWsUrl: server.url,
      authorizationHeader: `Bearer ${TOKEN}`,
      instanceId: randomUUID(),
      onStartTurn: () => {},
      onStopTurn: () => {},
      reconnectBaseDelayMs: 5,
      reconnectMaxDelayMs: 20,
      log: () => {},
    });

    const first = server.nextConnection();
    link.start();
    const firstSocket = await first;
    await nextMessage(firstSocket); // hello
    const onFirst = collect(firstSocket);

    link.sendTurnAccepted('turn-1');
    link.sendRuntimeEvent(finalMessage('turn-1', 'the answer'));
    link.sendRuntimeEvent(turnEnded('turn-1'));
    await vi.waitFor(() => expect(onFirst).toHaveLength(3));
    // The kernel got all three onto its socket but only processed (acknowledged) the first
    // before the link died — the other two must not be lost.
    firstSocket.send(JSON.stringify({ type: 'ack', seq: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 30));

    const second = server.nextConnection();
    firstSocket.terminate();
    const secondSocket = await second;
    const onSecond = collect(secondSocket);
    await vi.waitFor(() => expect(onSecond).toHaveLength(3));
    expect((onSecond as ReceivedFrame[]).map((frame) => frame.seq)).toEqual([undefined, 2, 3]);

    // Acknowledged now: the next reconnect sends hello and nothing else.
    secondSocket.send(JSON.stringify({ type: 'ack', seq: 3 }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const third = server.nextConnection();
    secondSocket.terminate();
    const thirdSocket = await third;
    const onThird = collect(thirdSocket);
    await vi.waitFor(() => expect(onThird).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onThird).toEqual([expect.objectContaining({ type: 'hello' })]);
  });

  it('keeps a bounded number of frames per Turn: stream deltas go first, the final message and turnEnded stay', async () => {
    server = await startFakeKernelServer();
    const lines: string[] = [];
    link = createKernelLink({
      kernelWsUrl: server.url,
      authorizationHeader: `Bearer ${TOKEN}`,
      instanceId: randomUUID(),
      onStartTurn: () => {},
      onStopTurn: () => {},
      maxBufferedFramesPerTurn: 4,
      log: (line) => lines.push(line),
    });

    // Not started yet — everything is kept for the first connection.
    link.sendTurnAccepted('turn-2');
    link.sendTurnAccepted('turn-1');
    for (let i = 0; i < 20; i += 1) link.sendRuntimeEvent(textDelta('turn-1', `d${i}`));
    link.sendRuntimeEvent(finalMessage('turn-1', 'first'));
    for (let i = 20; i < 30; i += 1) link.sendRuntimeEvent(textDelta('turn-1', `d${i}`));
    link.sendRuntimeEvent(finalMessage('turn-1', 'final'));
    link.sendRuntimeEvent(turnEnded('turn-1'));

    const first = server.nextConnection();
    link.start();
    const socket = await first;
    const received = collect(socket);
    await vi.waitFor(() => expect(received).toHaveLength(6));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(received).toHaveLength(6); // hello + turn-2's frame + turn-1's four

    const frames = received.slice(1) as ReceivedFrame[];
    const turn1 = frames.filter((frame) => frameTurnId(frame) === 'turn-1');
    expect(turn1.map(frameKind)).toEqual(['turnAccepted', 'message', 'message', 'turnEnded']);
    expect(frames).toContainEqual({ type: 'turnAccepted', turnId: 'turn-2', seq: 1 });
    const seqs = frames.map((frame) => frame.seq as number);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(lines.filter((l) => l.includes('over the per-Turn bound'))).toHaveLength(1);
  });

  it('under the per-Turn bound, text deltas go before tool events — the kernel stores a record of each tool call', async () => {
    server = await startFakeKernelServer();
    link = createKernelLink({
      kernelWsUrl: server.url,
      authorizationHeader: `Bearer ${TOKEN}`,
      instanceId: randomUUID(),
      onStartTurn: () => {},
      onStopTurn: () => {},
      maxBufferedFramesPerTurn: 4,
      log: () => {},
    });

    link.sendTurnAccepted('turn-1');
    link.sendRuntimeEvent({
      type: 'toolCallStarted',
      toolCallId: 'c1',
      name: 'list_facts',
      args: { linkType: 'depends_on' },
      ...CORRELATION,
      turnId: 'turn-1',
    });
    for (let i = 0; i < 10; i += 1) link.sendRuntimeEvent(textDelta('turn-1', `d${i}`));
    link.sendRuntimeEvent({
      type: 'toolCallEnded',
      toolCallId: 'c1',
      result: { content: [] },
      ...CORRELATION,
      turnId: 'turn-1',
    });
    link.sendRuntimeEvent(turnEnded('turn-1'));

    const first = server.nextConnection();
    link.start();
    const received = collect(await first);
    await vi.waitFor(() => expect(received).toHaveLength(5));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((received.slice(1) as ReceivedFrame[]).map(frameKind)).toEqual([
      'turnAccepted',
      'toolCallStarted',
      'toolCallEnded',
      'turnEnded',
    ]);
  });

  it('a ping the kernel never answers drops the link, and agent-host reconnects', async () => {
    const silent = new WebSocketServer({ port: 0, host: '127.0.0.1', autoPong: false });
    let connections = 0;
    silent.on('connection', () => {
      connections += 1;
    });
    await new Promise<void>((resolve) => silent.once('listening', () => resolve()));
    const address = silent.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const lines: string[] = [];
    link = createKernelLink({
      kernelWsUrl: `ws://127.0.0.1:${port}`,
      authorizationHeader: `Bearer ${TOKEN}`,
      instanceId: randomUUID(),
      onStartTurn: () => {},
      onStopTurn: () => {},
      heartbeatIntervalMs: 25,
      reconnectBaseDelayMs: 5,
      reconnectMaxDelayMs: 20,
      log: (line) => lines.push(line),
    });
    try {
      link.start();
      await vi.waitFor(() => expect(connections).toBeGreaterThanOrEqual(2), { timeout: 2_000 });
      expect(lines.some((l) => l.includes('no pong from the kernel'))).toBe(true);
    } finally {
      link.stop();
      for (const client of silent.clients) client.terminate();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });
});
