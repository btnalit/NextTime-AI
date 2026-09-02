import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { createKernelLink } from './kernel-link.js';
import type { KernelLink } from './kernel-link.js';

/**
 * kernel-link.test: a real `ws` server standing in for the kernel's `/internal/agent-host`
 * endpoint (same "real ephemeral listener" style `packages/kernel/src/interfaces/ws/server.test.ts`
 * and `agent-host.test.ts` already use, from the other side of the same wire).
 */

interface FakeKernelServer {
  readonly url: string;
  readonly connections: WebSocket[];
  nextConnection(): Promise<WebSocket>;
  close(): Promise<void>;
}

function startFakeKernelServer(): Promise<FakeKernelServer> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    const connections: WebSocket[] = [];
    // Every accepted connection is queued here as a resolved promise slot — nextConnection()
    // always returns the *next* one it hasn't handed out yet (FIFO), whether it already arrived
    // or is still pending, without needing to track "already consumed" separately.
    const pending: Array<{
      resolve: (ws: WebSocket) => void;
    }> = [];
    let delivered = 0;

    wss.on('connection', (ws) => {
      connections.push(ws);
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

  it('routes an inbound startTurn to onStartTurn and stopTurn to onStopTurn', async () => {
    server = await startFakeKernelServer();
    const startCalls: unknown[] = [];
    const stopCalls: unknown[] = [];
    link = createKernelLink({
      kernelWsUrl: server.url,
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

  it('sends well-shaped runtimeEvent/turnAccepted/turnRejected frames', async () => {
    server = await startFakeKernelServer();
    link = createKernelLink({
      kernelWsUrl: server.url,
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
    expect(await nextMessage(serverSideSocket)).toEqual({ type: 'turnAccepted', turnId: 'turn-1' });

    link.sendTurnRejected('turn-2', 'busy');
    expect(await nextMessage(serverSideSocket)).toEqual({
      type: 'turnRejected',
      turnId: 'turn-2',
      reason: 'busy',
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
    expect(await nextMessage(serverSideSocket)).toEqual({ type: 'runtimeEvent', event });
  });

  it('does not throw when sending while disconnected, and drops the frame', async () => {
    server = await startFakeKernelServer();
    link = createKernelLink({
      kernelWsUrl: server.url,
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

  it('stop() halts reconnection', async () => {
    server = await startFakeKernelServer();
    link = createKernelLink({
      kernelWsUrl: server.url,
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
