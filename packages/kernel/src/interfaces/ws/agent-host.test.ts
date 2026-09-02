import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { PoolLike } from '../../adapters/db/pool.js';
import type {
  AgentRuntimeEvent,
  AgentRuntimeEventSink,
  StartTurnInput,
} from '../../application/host-bridge/index.js';
import { AgentHostRuntime } from '../../application/host-bridge/index.js';
import { generateEphemeralHandleKeyPair } from '../../governance/capability/keys.js';
import { createServer } from '../../index.js';
import {
  _resetAgentHostRuntimeForWsRouteForTests,
  setAgentHostRuntimeForWsRoute,
} from './agent-host.js';

/**
 * interfaces/ws/agent-host.test: end-to-end against a real ephemeral listener + a real `ws`
 * client, same style as interfaces/ws/server.test.ts — but backed by an in-memory fake `PoolLike`
 * (same technique as application/host-bridge/agent-host-runtime.test.ts) rather than real
 * Postgres, so this file needs no `DATABASE_URL` and always runs: it is testing the WebSocket
 * transport/wiring (frame parsing, `AgentHostLink`, connect/disconnect), not `AgentHostRuntime`'s
 * own protocol logic (already covered by agent-host-runtime.test.ts's unit tests).
 */

function createFakePool(): PoolLike {
  const sessionIdByPrincipal = new Map<string, string>();

  const query = vi.fn(async (text: string, params: unknown[] = []) => {
    const sql = text.trim();
    if (
      sql.startsWith('BEGIN') ||
      sql.startsWith('COMMIT') ||
      sql.startsWith('ROLLBACK') ||
      sql.startsWith('select set_config') ||
      sql.startsWith('set local role')
    ) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith('select id from sessions')) {
      const [, principalId] = params as [string, string];
      const id = sessionIdByPrincipal.get(principalId);
      return { rows: id ? [{ id }] : [], rowCount: id ? 1 : 0 };
    }
    if (sql.startsWith('insert into sessions')) {
      const [, principalId] = params as [string, string];
      const id = randomUUID();
      sessionIdByPrincipal.set(principalId, id);
      return { rows: [{ id }], rowCount: 1 };
    }
    if (sql.startsWith('select workspace_id, on_behalf_of from sessions')) {
      const [sessionId] = params as [string];
      const principalId = [...sessionIdByPrincipal.entries()].find(
        ([, id]) => id === sessionId,
      )?.[0];
      return {
        rows: principalId ? [{ workspace_id: 'unused', on_behalf_of: principalId }] : [],
        rowCount: principalId ? 1 : 0,
      };
    }
    if (sql.startsWith('insert into capability_handles')) {
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`fake pool: unhandled query: ${sql}`);
  });

  const client = { query, release: vi.fn() } as unknown as PoolClient;
  return { connect: vi.fn(async () => client) };
}

function createFakeSink() {
  const events: AgentRuntimeEvent[] = [];
  const sink: AgentRuntimeEventSink = {
    handle(event) {
      events.push(event);
    },
  };
  return { sink, events };
}

async function buildRuntime() {
  const { privateKey } = await generateEphemeralHandleKeyPair();
  const { sink, events } = createFakeSink();
  const runtime = new AgentHostRuntime({
    pool: createFakePool(),
    sink,
    privateKey,
    kernelLlmUrl: 'http://llm-proxy:8082',
    log: () => {},
  });
  return { runtime, events };
}

interface Listening {
  app: FastifyInstance;
  url: string;
}

async function listen(): Promise<Listening> {
  // createServer() already registers GET /internal/agent-host (packages/kernel/src/index.ts) —
  // no separate registerAgentHostWsRoute() call needed here.
  const app = createServer({ pool: createFakePool() });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, url: `${address.replace('http://', 'ws://')}/internal/agent-host` };
}

function connect(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve) => {
    ws.once('message', (raw) => resolve(JSON.parse(raw.toString())));
  });
}

let listening: Listening | undefined;

afterEach(async () => {
  _resetAgentHostRuntimeForWsRouteForTests();
  await listening?.app.close();
  listening = undefined;
});

function startTurnInput(): StartTurnInput {
  return {
    workspaceId: randomUUID(),
    chatId: randomUUID(),
    turnId: randomUUID(),
    principalId: randomUUID(),
    prompt: 'hello',
  };
}

describe('GET /internal/agent-host', () => {
  it('closes the connection immediately when no AgentHostRuntime is registered', async () => {
    listening = await listen();
    const ws = await connect(listening.url);
    await new Promise<void>((resolve, reject) => {
      ws.once('close', () => resolve());
      ws.once('error', reject);
      setTimeout(() => reject(new Error('did not close in time')), 2000);
    });
  });

  it('relays a startTurn command to the connected client and delivers turnAccepted back to AgentHostRuntime', async () => {
    listening = await listen();
    const { runtime } = await buildRuntime();
    setAgentHostRuntimeForWsRoute(runtime);

    const ws = await connect(listening.url);
    ws.send(JSON.stringify({ type: 'hello', instanceId: randomUUID() }));

    const input = startTurnInput();
    const startPromise = runtime.startTurn(input);

    const received = (await nextMessage(ws)) as { type: string; turnId: string; handle: string };
    expect(received.type).toBe('startTurn');
    expect(received.turnId).toBe(input.turnId);
    expect(typeof received.handle).toBe('string');
    expect(received.handle.length).toBeGreaterThan(0);

    ws.send(JSON.stringify({ type: 'turnAccepted', turnId: input.turnId }));
    await expect(startPromise).resolves.toBeUndefined();

    ws.close();
  });

  it('forwards a runtimeEvent frame from the client to the sink', async () => {
    listening = await listen();
    const { runtime, events } = await buildRuntime();
    setAgentHostRuntimeForWsRoute(runtime);

    const ws = await connect(listening.url);
    const input = startTurnInput();
    const startPromise = runtime.startTurn(input);
    await nextMessage(ws);
    ws.send(JSON.stringify({ type: 'turnAccepted', turnId: input.turnId }));
    await startPromise;

    ws.send(
      JSON.stringify({
        type: 'runtimeEvent',
        event: {
          type: 'textDelta',
          delta: 'hi',
          workspaceId: input.workspaceId,
          chatId: input.chatId,
          turnId: input.turnId,
          principalId: input.principalId,
        },
      }),
    );

    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({ type: 'textDelta', delta: 'hi' });

    ws.close();
  });

  it('ignores a malformed frame (invalid JSON, and one that fails schema validation) without closing the connection', async () => {
    listening = await listen();
    const { runtime } = await buildRuntime();
    setAgentHostRuntimeForWsRoute(runtime);

    const ws = await connect(listening.url);
    ws.send('not json');
    ws.send(JSON.stringify({ type: 'notAKnownFrameType' }));
    ws.send(JSON.stringify({ type: 'hello' /* missing instanceId */ }));

    // The socket is still usable afterward — proven by a subsequent well-formed exchange working.
    const input = startTurnInput();
    const startPromise = runtime.startTurn(input);
    const received = (await nextMessage(ws)) as { type: string; turnId: string };
    expect(received.type).toBe('startTurn');
    ws.send(JSON.stringify({ type: 'turnAccepted', turnId: input.turnId }));
    await expect(startPromise).resolves.toBeUndefined();

    ws.close();
  });

  it('disconnects the runtime when the socket closes, so a later startTurn reports no agent-host connected', async () => {
    listening = await listen();
    const { runtime, events } = await buildRuntime();
    setAgentHostRuntimeForWsRoute(runtime);

    const ws = await connect(listening.url);
    await new Promise<void>((resolve) => {
      ws.close();
      ws.once('close', () => resolve());
    });
    // The client-side `close` event and the server-side socket `close` handler (which calls
    // `runtime.disconnect`) both fire off the same underlying TCP teardown but are not
    // synchronized with each other — a short, generous wait here is simpler and just as reliable
    // as polling via repeated startTurn calls (each of which would itself have side effects).
    await new Promise((resolve) => setTimeout(resolve, 100));

    const input = startTurnInput();
    await runtime.startTurn(input);
    expect(events.at(-1)).toMatchObject({ turnId: input.turnId, status: 'failed' });
  });
});
