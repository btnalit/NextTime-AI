import { randomBytes, randomUUID } from 'node:crypto';
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
import type { InternalPlaneAuthConfig } from '../internal-auth/index.js';
import {
  _resetAgentHostRuntimeForWsRouteForTests,
  setAgentHostRuntimeForWsRoute,
} from './agent-host.js';

/**
 * interfaces/ws/agent-host.test: end-to-end against a real ephemeral listener + a real `ws`
 * client, same style as interfaces/ws/server.test.ts — but backed by an in-memory fake `PoolLike`
 * (same technique as application/host-bridge/agent-host-runtime.test.ts) rather than real
 * Postgres, so this file needs no `DATABASE_URL` and always runs: it is testing the WebSocket
 * transport/wiring (frame parsing, `AgentHostLink`, connect/disconnect) and the internal-plane
 * guard's effect on the upgrade (fix/internal-plane-auth), not `AgentHostRuntime`'s own protocol
 * logic (already covered by agent-host-runtime.test.ts's unit tests).
 */

/** The internal-plane shared secret the listener below is built with; every "happy path"
 *  connection presents it, the rejection tests withhold or alter it. */
const INTERNAL_TOKEN = randomBytes(32).toString('hex');
const AUTH_HEADERS = { authorization: `Bearer ${INTERNAL_TOKEN}` };

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
    // S2.13: governance/capability/grants.ts's listActiveGrantResourceScopes, called by
    // AgentHostRuntime's ensureEntryHandle — no Grant is ever seeded here, matching this test
    // file's pre-S2.13 behavior (empty resources.gatekeeper).
    if (sql.startsWith("select distinct scope ->> 'resourceScope'")) {
      return { rows: [], rowCount: 0 };
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

async function listen(
  internalAuth: InternalPlaneAuthConfig = { token: INTERNAL_TOKEN },
): Promise<Listening> {
  // createServer() already registers GET /internal/agent-host (packages/kernel/src/index.ts) —
  // no separate registerAgentHostWsRoute() call needed here — and installs the internal-plane
  // guard from `internalAuth`.
  const app = createServer({ pool: createFakePool() }, { internalAuth });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, url: `${address.replace('http://', 'ws://')}/internal/agent-host` };
}

function connect(url: string, headers: Record<string, string> = AUTH_HEADERS): Promise<WebSocket> {
  const ws = new WebSocket(url, { headers });
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/** Resolves with the HTTP status the server answered the upgrade with (the `ws` client surfaces a
 *  non-101 response as an `error` "Unexpected server response: <status>"), or rejects if the
 *  upgrade unexpectedly succeeded. */
function attemptUpgrade(url: string, headers: Record<string, string>): Promise<number> {
  const ws = new WebSocket(url, { headers });
  return new Promise((resolve, reject) => {
    ws.once('open', () => {
      ws.close();
      reject(new Error('upgrade was accepted but should have been rejected'));
    });
    ws.once('error', (err) => {
      const match = /Unexpected server response: (\d+)/.exec(err.message);
      if (match?.[1]) resolve(Number(match[1]));
      else reject(err);
    });
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

describe('GET /internal/agent-host upgrade is behind the internal-plane guard', () => {
  it('rejects the upgrade with 401 when no Authorization header is sent, before any hello is read', async () => {
    listening = await listen();
    const { runtime, events } = await buildRuntime();
    setAgentHostRuntimeForWsRoute(runtime);

    await expect(attemptUpgrade(listening.url, {})).resolves.toBe(401);

    // Nothing registered itself as the link: a startTurn still reports "no agent-host connected".
    const input = startTurnInput();
    await runtime.startTurn(input);
    expect(events.at(-1)).toMatchObject({ turnId: input.turnId, status: 'failed' });
  });

  it('rejects the upgrade with 401 for a wrong token', async () => {
    listening = await listen();
    const { runtime, events } = await buildRuntime();
    setAgentHostRuntimeForWsRoute(runtime);

    const wrong = randomBytes(32).toString('hex');
    await expect(attemptUpgrade(listening.url, { authorization: `Bearer ${wrong}` })).resolves.toBe(
      401,
    );

    const input = startTurnInput();
    await runtime.startTurn(input);
    expect(events.at(-1)).toMatchObject({ turnId: input.turnId, status: 'failed' });
  });

  it('rejects the upgrade with 401 from a peer inside NEXTTIME_SUBNET_WORKERS even with the right token', async () => {
    // The test client connects from loopback; declaring loopback as the Worker subnet makes this
    // very connection "a Worker holding a leaked token".
    listening = await listen({ token: INTERNAL_TOKEN, workersSubnet: '127.0.0.0/8' });
    const { runtime, events } = await buildRuntime();
    setAgentHostRuntimeForWsRoute(runtime);

    await expect(attemptUpgrade(listening.url, AUTH_HEADERS)).resolves.toBe(401);

    const input = startTurnInput();
    await runtime.startTurn(input);
    expect(events.at(-1)).toMatchObject({ turnId: input.turnId, status: 'failed' });
  });

  it('accepts the upgrade with the right token (the connection tests below all present it)', async () => {
    listening = await listen();
    const { runtime } = await buildRuntime();
    setAgentHostRuntimeForWsRoute(runtime);

    const ws = await connect(listening.url);
    expect(ws.readyState).toBe(1);
    ws.close();
  });
});

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
