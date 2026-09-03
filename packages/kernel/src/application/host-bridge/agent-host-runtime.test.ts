import { randomUUID } from 'node:crypto';
import type { AgentHostToKernelFrame, KernelToAgentHostFrame } from '@nexttime/shared';
import type { CryptoKey } from 'jose';
import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { PoolLike } from '../../adapters/db/pool.js';
import { generateEphemeralHandleKeyPair } from '../../governance/capability/keys.js';
import { type AgentHostLink, AgentHostRuntime } from './agent-host-runtime.js';
import type { AgentRuntimeEvent, AgentRuntimeEventSink, StartTurnInput } from './agent-runtime.js';

/**
 * agent-host-runtime.test: unit tests, no Postgres involved — a small fake `PoolLike` stands in
 * for `sessions`/`capability_handles`, matched against the exact SQL this class and
 * `governance/capability/handles.ts`'s `issueHandle` issue (same technique as
 * governance/capability/handles.test.ts's own `createFakeCapabilityClient` and
 * adapters/db/pool.test.ts's `createFakePool`, combined: this class drives real `withWorkspace`
 * transactions, which need BEGIN/set_config/set local role/COMMIT handled too).
 */

interface FakeSessionRow {
  id: string;
  workspaceId: string;
  principalId: string;
  onBehalfOf: string;
}

/** S2.6: an entry definition row `resolveEntryDefinition`'s `getPublishedEntryDefinition` query
 *  should find for a given `workspaceId`, keyed by `createFakePool`'s optional
 *  `publishedEntryDefinitions` seed map. */
interface FakeEntryDefinitionRow {
  readonly systemPrompt?: string;
  readonly model?: string;
}

function createFakePool(
  publishedEntryDefinitions: ReadonlyMap<string, FakeEntryDefinitionRow> = new Map(),
  /** S2.13: `governance/capability/grants.ts`'s `listActiveGrantResourceScopes`, called by
   *  `ensureEntryHandle` — keyed by `principalId`, the gatekeeperIds an active `connect_gatekeeper`
   *  Grant would surface. Empty by default (every pre-S2.13 test keeps its exact prior behavior). */
  grantedGatekeeperIdsByPrincipal: ReadonlyMap<string, readonly string[]> = new Map(),
) {
  const sessionsByPrincipal = new Map<string, FakeSessionRow>();
  const handleCount = new Map<string, number>();

  const query = vi.fn(async (text: string, params: unknown[] = []) => {
    const sql = text.trim();

    if (sql.startsWith('BEGIN') || sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith('select set_config') || sql.startsWith('set local role')) {
      return { rows: [], rowCount: 0 };
    }

    // application/worker/definitions.ts's getPublishedEntryDefinition.
    if (sql.startsWith('select workspace_id, id, version, kind, status, definition')) {
      const [workspaceId] = params as [string];
      const seed = publishedEntryDefinitions.get(workspaceId);
      if (!seed) return { rows: [], rowCount: 0 };
      return {
        rows: [
          {
            workspace_id: workspaceId,
            id: randomUUID(),
            version: 1,
            kind: 'entry',
            status: 'published',
            definition: { systemPrompt: seed.systemPrompt, model: seed.model },
            proposed_by: randomUUID(),
            published_by: randomUUID(),
            created_at: new Date(),
            published_at: new Date(),
          },
        ],
        rowCount: 1,
      };
    }

    if (sql.startsWith('select id from sessions')) {
      const [, principalId] = params as [string, string];
      const row = sessionsByPrincipal.get(principalId);
      return { rows: row ? [{ id: row.id }] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.startsWith('insert into sessions')) {
      const [workspaceId, principalId] = params as [string, string];
      const row: FakeSessionRow = {
        id: randomUUID(),
        workspaceId,
        principalId,
        onBehalfOf: principalId,
      };
      sessionsByPrincipal.set(principalId, row);
      return { rows: [{ id: row.id }], rowCount: 1 };
    }

    if (sql.startsWith('select workspace_id, on_behalf_of from sessions')) {
      const [sessionId] = params as [string];
      const row = [...sessionsByPrincipal.values()].find((s) => s.id === sessionId);
      return {
        rows: row ? [{ workspace_id: row.workspaceId, on_behalf_of: row.onBehalfOf }] : [],
        rowCount: row ? 1 : 0,
      };
    }

    // S2.13: governance/capability/grants.ts's listActiveGrantResourceScopes, called by
    // ensureEntryHandle below.
    if (sql.startsWith("select distinct scope ->> 'resourceScope'")) {
      const [, principalId] = params as [string, string];
      const ids = grantedGatekeeperIdsByPrincipal.get(principalId) ?? [];
      return { rows: ids.map((id) => ({ resource_scope: id })), rowCount: ids.length };
    }

    if (sql.startsWith('insert into capability_handles')) {
      // (workspace_id, jti, session_id, on_behalf_of, parent_jti, scope, expires_at) —
      // governance/capability/handles.ts's issueHandle; on_behalf_of is index 3, not jti (index 1).
      const onBehalfOf = params[3] as string;
      handleCount.set(onBehalfOf, (handleCount.get(onBehalfOf) ?? 0) + 1);
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`fake pool: unhandled query: ${sql}`);
  });

  const client = { query, release: vi.fn() } as unknown as PoolClient;
  const pool: PoolLike = { connect: vi.fn(async () => client) };

  return { pool, handleCount, sessionCount: () => sessionsByPrincipal.size };
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

function createFakeLink() {
  const sent: KernelToAgentHostFrame[] = [];
  let throwOnSend = false;
  const link: AgentHostLink = {
    send(frame) {
      if (throwOnSend) throw new Error('socket is not open');
      sent.push(frame);
    },
  };
  return {
    link,
    sent,
    setThrowOnSend: (value: boolean) => {
      throwOnSend = value;
    },
  };
}

function startTurnInput(overrides: Partial<StartTurnInput> = {}): StartTurnInput {
  return {
    workspaceId: randomUUID(),
    chatId: randomUUID(),
    turnId: randomUUID(),
    principalId: randomUUID(),
    prompt: '<!--nexttime:turn_id=x-->\nhello',
    ...overrides,
  };
}

async function ephemeralPrivateKey(): Promise<CryptoKey> {
  const { privateKey } = await generateEphemeralHandleKeyPair();
  return privateKey;
}

describe('AgentHostRuntime — startTurn with no agent-host connected', () => {
  it('emits turnEnded {status: failed} without touching the database', async () => {
    const { pool } = createFakePool();
    const { sink, events } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });

    const input = startTurnInput();
    await runtime.startTurn(input);

    expect(pool.connect).not.toHaveBeenCalled();
    expect(events).toEqual([
      {
        type: 'turnEnded',
        status: 'failed',
        workspaceId: input.workspaceId,
        chatId: input.chatId,
        turnId: input.turnId,
        principalId: input.principalId,
      },
    ]);
  });
});

describe('AgentHostRuntime — startTurn happy path', () => {
  it('issues an entry Handle, sends startTurn, and resolves once turnAccepted arrives (no turnEnded yet)', async () => {
    const { pool, handleCount, sessionCount } = createFakePool();
    const { sink, events } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    const input = startTurnInput();
    const startPromise = runtime.startTurn(input);

    // startTurn's returned promise only resolves once accepted/rejected/timed-out — send the
    // acceptance while it's still pending, matching how interfaces/ws/agent-host.ts calls
    // handleFrame from a live socket.
    await Promise.resolve(); // let the async handle-issuance microtasks run before asserting `sent`
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    const command = sent[0] as Extract<KernelToAgentHostFrame, { type: 'startTurn' }>;
    expect(command.type).toBe('startTurn');
    expect(command.turnId).toBe(input.turnId);
    expect(command.principalId).toBe(input.principalId);
    expect(command.prompt).toBe(input.prompt);
    expect(command.kernelLlmUrl).toBe('http://llm-proxy:8082');
    expect(typeof command.handle).toBe('string');
    expect(command.handle.length).toBeGreaterThan(0);
    expect(sessionCount()).toBe(1);
    expect(handleCount.get(input.principalId)).toBe(1);

    runtime.handleFrame({ type: 'turnAccepted', turnId: input.turnId });
    await startPromise;

    // Accepted, not ended — no turnEnded (or any other) event yet.
    expect(events).toEqual([]);
  });

  it('S2.13: a connect_gatekeeper Grant populates the freshly issued entry Handle’s resources.gatekeeper', async () => {
    const principalId = randomUUID();
    const { pool } = createFakePool(new Map(), new Map([[principalId, ['gk-1', 'gk-2']]]));
    const { sink } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    const input = startTurnInput({ principalId });
    const startPromise = runtime.startTurn(input);
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    const command = sent[0] as Extract<KernelToAgentHostFrame, { type: 'startTurn' }>;
    // Decode the Handle's own JWT payload (no signature verification needed for this assertion —
    // governance/capability/handles.test.ts already covers signing/verification correctness) to
    // inspect the CapabilityScope ensureEntryHandle actually issued.
    const payloadSegment = command.handle.split('.')[1] ?? '';
    const claims = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8')) as {
      scope: { resources: Record<string, readonly string[]> };
    };
    expect(new Set(claims.scope.resources.gatekeeper)).toEqual(new Set(['gk-1', 'gk-2']));

    runtime.handleFrame({ type: 'turnAccepted', turnId: input.turnId });
    await startPromise;
  });

  it('reuses a cached entry Handle for a second turn from the same principal', async () => {
    const { pool, handleCount } = createFakePool();
    const { sink } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    const principalId = randomUUID();
    const workspaceId = randomUUID();

    const first = startTurnInput({ principalId, workspaceId });
    const firstPromise = runtime.startTurn(first);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    runtime.handleFrame({ type: 'turnAccepted', turnId: first.turnId });
    await firstPromise;

    const second = startTurnInput({ principalId, workspaceId });
    const secondPromise = runtime.startTurn(second);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    runtime.handleFrame({ type: 'turnAccepted', turnId: second.turnId });
    await secondPromise;

    expect(handleCount.get(principalId)).toBe(1); // issued once, reused the second time
    const firstCommand = sent[0] as Extract<KernelToAgentHostFrame, { type: 'startTurn' }>;
    const secondCommand = sent[1] as Extract<KernelToAgentHostFrame, { type: 'startTurn' }>;
    expect(secondCommand.handle).toBe(firstCommand.handle);
  });

  it('reissues the entry Handle once its cached ttl has mostly elapsed', async () => {
    const { pool, handleCount } = createFakePool();
    const { sink } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    let nowMs = Date.now();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      entryHandleTtlSeconds: 100,
      now: () => nowMs,
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    const principalId = randomUUID();
    const workspaceId = randomUUID();

    const first = startTurnInput({ principalId, workspaceId });
    const firstPromise = runtime.startTurn(first);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    runtime.handleFrame({ type: 'turnAccepted', turnId: first.turnId });
    await firstPromise;

    nowMs += 95_000; // <10% of the 100s ttl remaining

    const second = startTurnInput({ principalId, workspaceId });
    const secondPromise = runtime.startTurn(second);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    runtime.handleFrame({ type: 'turnAccepted', turnId: second.turnId });
    await secondPromise;

    expect(handleCount.get(principalId)).toBe(2);
  });
});

describe('AgentHostRuntime — startTurn resolves the published entry WorkerDefinition (S2.6)', () => {
  it('includes systemPrompt/model on the startTurn frame when the workspace has a published entry definition', async () => {
    const input = startTurnInput();
    const { pool } = createFakePool(
      new Map([
        [
          input.workspaceId,
          { systemPrompt: 'you are the entry agent', model: 'example-provider/example-model' },
        ],
      ]),
    );
    const { sink } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    const startPromise = runtime.startTurn(input);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    runtime.handleFrame({ type: 'turnAccepted', turnId: input.turnId });
    await startPromise;

    const command = sent[0] as Extract<KernelToAgentHostFrame, { type: 'startTurn' }>;
    expect(command.systemPrompt).toBe('you are the entry agent');
    expect(command.model).toBe('example-provider/example-model');
  });

  it('omits systemPrompt/model (never fails the turn) when no entry definition has been published', async () => {
    const { pool } = createFakePool(); // no seeded definitions
    const { sink, events } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    const input = startTurnInput();
    const startPromise = runtime.startTurn(input);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    runtime.handleFrame({ type: 'turnAccepted', turnId: input.turnId });
    await startPromise;

    const command = sent[0] as Extract<KernelToAgentHostFrame, { type: 'startTurn' }>;
    expect(command.systemPrompt).toBeUndefined();
    expect(command.model).toBeUndefined();
    expect(events).toEqual([]); // never a turnEnded — the lookup gap is not fatal
  });

  it('omits systemPrompt/model when the published definition has no model set', async () => {
    const input = startTurnInput();
    const { pool } = createFakePool(
      new Map([[input.workspaceId, { systemPrompt: 'you are the entry agent' }]]),
    );
    const { sink } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    const startPromise = runtime.startTurn(input);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    runtime.handleFrame({ type: 'turnAccepted', turnId: input.turnId });
    await startPromise;

    const command = sent[0] as Extract<KernelToAgentHostFrame, { type: 'startTurn' }>;
    expect(command.systemPrompt).toBe('you are the entry agent');
    expect(command.model).toBeUndefined();
  });
});

describe('AgentHostRuntime — turnRejected and accept timeout', () => {
  it('turnRejected produces turnEnded {status: failed}', async () => {
    const { pool } = createFakePool();
    const { sink, events } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    const input = startTurnInput();
    const startPromise = runtime.startTurn(input);
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    runtime.handleFrame({ type: 'turnRejected', turnId: input.turnId, reason: 'busy' });
    await startPromise;

    expect(events).toEqual([
      {
        type: 'turnEnded',
        status: 'failed',
        workspaceId: input.workspaceId,
        chatId: input.chatId,
        turnId: input.turnId,
        principalId: input.principalId,
      },
    ]);
  });

  it('a turnAccepted timeout produces turnEnded {status: failed}', async () => {
    const { pool } = createFakePool();
    const { sink, events } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      turnAcceptedTimeoutMs: 10,
      log: () => {},
    });
    const { link } = createFakeLink();
    runtime.connect(link);

    const input = startTurnInput();
    await runtime.startTurn(input); // never sends turnAccepted — resolves once the 10ms timeout fires

    expect(events).toEqual([
      {
        type: 'turnEnded',
        status: 'failed',
        workspaceId: input.workspaceId,
        chatId: input.chatId,
        turnId: input.turnId,
        principalId: input.principalId,
      },
    ]);
  });

  it('a link.send failure produces turnEnded {status: failed} rather than throwing', async () => {
    const { pool } = createFakePool();
    const { sink, events } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });
    const { link, setThrowOnSend } = createFakeLink();
    setThrowOnSend(true);
    runtime.connect(link);

    const input = startTurnInput();
    await expect(runtime.startTurn(input)).resolves.toBeUndefined();

    expect(events).toEqual([
      {
        type: 'turnEnded',
        status: 'failed',
        workspaceId: input.workspaceId,
        chatId: input.chatId,
        turnId: input.turnId,
        principalId: input.principalId,
      },
    ]);
  });
});

describe('AgentHostRuntime — stopTurn', () => {
  it('sends a stopTurn command with the tracked principalId for an active turn', async () => {
    const { pool } = createFakePool();
    const { sink } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    const input = startTurnInput();
    const startPromise = runtime.startTurn(input);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    runtime.handleFrame({ type: 'turnAccepted', turnId: input.turnId });
    await startPromise;

    await runtime.stopTurn(input.turnId);

    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual({
      type: 'stopTurn',
      turnId: input.turnId,
      principalId: input.principalId,
    });
  });

  it('is a no-op for an unknown turnId (idempotent per the AgentRuntime port contract)', async () => {
    const { pool } = createFakePool();
    const { sink } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    await expect(runtime.stopTurn(randomUUID())).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
  });

  it('is a no-op for a turnId already ended (turnEnded clears it from the active set)', async () => {
    const { pool } = createFakePool();
    const { sink } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    const input = startTurnInput();
    const startPromise = runtime.startTurn(input);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    runtime.handleFrame({ type: 'turnAccepted', turnId: input.turnId });
    await startPromise;

    const event: AgentHostToKernelFrame = {
      type: 'runtimeEvent',
      event: {
        type: 'turnEnded',
        status: 'completed',
        workspaceId: input.workspaceId,
        chatId: input.chatId,
        turnId: input.turnId,
        principalId: input.principalId,
      },
    };
    runtime.handleFrame(event);
    await Promise.resolve();

    await runtime.stopTurn(input.turnId);
    expect(sent).toHaveLength(1); // only the original startTurn — no stopTurn was sent
  });
});

describe('AgentHostRuntime — runtimeEvent forwarding', () => {
  it('forwards textDelta/toolCallStarted/toolCallEnded/message/turnEnded verbatim to the sink', async () => {
    const { pool } = createFakePool();
    const { sink, events } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    const input = startTurnInput();
    const startPromise = runtime.startTurn(input);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    runtime.handleFrame({ type: 'turnAccepted', turnId: input.turnId });
    await startPromise;

    const base = {
      workspaceId: input.workspaceId,
      chatId: input.chatId,
      turnId: input.turnId,
      principalId: input.principalId,
    };
    const frames: AgentHostToKernelFrame[] = [
      { type: 'runtimeEvent', event: { type: 'textDelta', delta: 'hi', ...base } },
      {
        type: 'runtimeEvent',
        event: { type: 'toolCallStarted', toolCallId: 'c1', name: 'search', ...base },
      },
      { type: 'runtimeEvent', event: { type: 'toolCallEnded', toolCallId: 'c1', ...base } },
      {
        type: 'runtimeEvent',
        event: { type: 'message', role: 'assistant', content: { text: 'hi' }, ...base },
      },
      { type: 'runtimeEvent', event: { type: 'turnEnded', status: 'completed', ...base } },
    ];
    for (const frame of frames) runtime.handleFrame(frame);
    await Promise.resolve();

    expect(events).toHaveLength(5);
    expect(events[0]).toEqual({ type: 'textDelta', delta: 'hi', ...base });
    expect(events[4]).toEqual({ type: 'turnEnded', status: 'completed', ...base });
  });
});

describe('AgentHostRuntime — connect/disconnect', () => {
  it('a stale link disconnecting does not clear the current link', async () => {
    const { pool } = createFakePool();
    const { sink } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });
    const oldLink = createFakeLink();
    const newLink = createFakeLink();

    runtime.connect(oldLink.link);
    runtime.connect(newLink.link);
    runtime.disconnect(oldLink.link); // stale — must not clear newLink

    const input = startTurnInput();
    void runtime.startTurn(input);
    await vi.waitFor(() => expect(newLink.sent).toHaveLength(1));
    expect(oldLink.sent).toHaveLength(0);
  });
});

describe('AgentHostRuntime — hello / instanceId restart detection', () => {
  it('a hello with the same instanceId as before does not disturb active turns', async () => {
    const { pool } = createFakePool();
    const { sink, events } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    const instanceId = randomUUID();
    runtime.handleFrame({ type: 'hello', instanceId });

    const input = startTurnInput();
    const startPromise = runtime.startTurn(input);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    runtime.handleFrame({ type: 'turnAccepted', turnId: input.turnId });
    await startPromise;

    runtime.handleFrame({ type: 'hello', instanceId }); // same instance reconnecting — a mere blip
    await Promise.resolve();

    expect(events).toEqual([]); // turn still active, nothing abandoned

    await runtime.stopTurn(input.turnId);
    expect(sent).toHaveLength(2); // stopTurn actually sent — proves the turn is still tracked active
  });

  it('a hello with a new instanceId abandons every still-active turn as interrupted', async () => {
    const { pool } = createFakePool();
    const { sink, events } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    runtime.handleFrame({ type: 'hello', instanceId: randomUUID() });

    const input = startTurnInput();
    const startPromise = runtime.startTurn(input);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    runtime.handleFrame({ type: 'turnAccepted', turnId: input.turnId });
    await startPromise;

    runtime.handleFrame({ type: 'hello', instanceId: randomUUID() }); // a genuinely new process
    await Promise.resolve();

    expect(events).toEqual([
      {
        type: 'turnEnded',
        status: 'interrupted',
        workspaceId: input.workspaceId,
        chatId: input.chatId,
        turnId: input.turnId,
        principalId: input.principalId,
      },
    ]);

    // The turn is no longer tracked active — a stopTurn call for it is now a no-op.
    await runtime.stopTurn(input.turnId);
    expect(sent).toHaveLength(1);
  });

  it('a restart also fails any turn still waiting on turnAccepted, without waiting for its timeout', async () => {
    const { pool } = createFakePool();
    const { sink, events } = createFakeSink();
    const privateKey = await ephemeralPrivateKey();
    const runtime = new AgentHostRuntime({
      pool,
      sink,
      privateKey,
      kernelLlmUrl: 'http://llm-proxy:8082',
      turnAcceptedTimeoutMs: 60_000,
      log: () => {},
    });
    const { link, sent } = createFakeLink();
    runtime.connect(link);

    runtime.handleFrame({ type: 'hello', instanceId: randomUUID() });

    const input = startTurnInput();
    const startPromise = runtime.startTurn(input);
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    // Restart arrives before turnAccepted ever does.
    runtime.handleFrame({ type: 'hello', instanceId: randomUUID() });
    await startPromise;

    expect(events).toEqual([
      {
        type: 'turnEnded',
        status: 'failed',
        workspaceId: input.workspaceId,
        chatId: input.chatId,
        turnId: input.turnId,
        principalId: input.principalId,
      },
    ]);
  });
});
