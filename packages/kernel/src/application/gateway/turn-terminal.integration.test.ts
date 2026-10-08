import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KernelToAgentHostFrame } from '@nexttime/shared';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { generateEphemeralHandleKeyPair } from '../../governance/capability/keys.js';
import { createBackgroundServices } from '../../index.js';
import {
  type ChatPushEvent,
  createChatEventSink,
  interruptStaleRunningTurns,
  subscribeToChatPushEvents,
} from '../chat/index.js';
import type { AgentHostLink, AgentRuntimeEventSink } from '../host-bridge/index.js';
import { AgentHostRuntime } from '../host-bridge/index.js';
import { dispatchCapability } from './dispatch.js';
import { setAgentRuntimeForHandlers } from './handlers.js';
import type { ResolvedCaller } from './resolve-caller.js';

/**
 * Integration test (real Postgres; auto-skips without DATABASE_URL) for 2026-10-02 review R-55: a
 * stopped, interrupted or failed Turn can no longer start or finish, and its terminal status is
 * never overwritten. Real database because the guard is the UPDATE itself (`endTurn`'s
 * `status = any(<TURN_TRANSITIONS sources>)` and its stop-intent rule) and because the TurnStarted
 * check reads the Activity row through `createBackgroundServices`' own wiring. Also R-56's chat-level
 * outcome: after an agent-host link flap, the replayed terminal frames end the Turn and the chat
 * takes the next message. And the Turn-end ordering invariant: when a Turn reaches its terminal
 * status, every assistant message the kernel received for it is already committed, and a client is
 * told the Turn ended only after that commit.
 */

const DATABASE_URL = process.env.DATABASE_URL;

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

describe.runIf(DATABASE_URL !== undefined)(
  'R-55 Turn terminal-state integrity (integration, real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let sink: AgentRuntimeEventSink;

    function admin<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      return withWorkspace(pool, { workspaceId, principalId: randomUUID() }, fn, {
        skipRoleSwitch: true,
      });
    }

    function human(): ResolvedCaller {
      return {
        channel: 'human',
        principal: { workspaceId, id: ownerId, kind: 'human', role: 'member', displayName: null },
        session: {
          workspaceId,
          id: randomUUID(),
          principalId: ownerId,
          kind: 'web',
          onBehalfOf: ownerId,
          status: 'active',
          createdAt: new Date(),
          expiresAt: null,
        },
      };
    }

    function entryHandle(): ResolvedCaller {
      return {
        channel: 'handle',
        claims: {
          ws: workspaceId,
          sid: randomUUID(),
          obo: ownerId,
          scope: { capabilities: ['report_turn'], resources: {} },
          jti: randomUUID(),
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 3600,
        },
      };
    }

    async function startTurn(): Promise<{ chatId: string; turnId: string }> {
      const chat = (await dispatchCapability({ pool }, human(), 'new_chat', {})) as { id: string };
      const { turnId } = (await dispatchCapability({ pool }, human(), 'send_chat_message', {
        chatId: chat.id,
        text: 'hello',
      })) as { turnId: string };
      return { chatId: chat.id, turnId };
    }

    async function turnRow(
      turnId: string,
    ): Promise<{ status: string; metadata: Record<string, unknown> } | undefined> {
      const result = await admin((client) =>
        client.query<{ status: string; metadata: Record<string, unknown> }>(
          'select status, metadata from activities where workspace_id = $1 and id = $2',
          [workspaceId, turnId],
        ),
      );
      return result.rows[0];
    }

    async function turnCompletedStatuses(turnId: string): Promise<string[]> {
      const result = await admin((client) =>
        client.query<{ status: string }>(
          `select payload->>'status' as status from outbox
           where workspace_id = $1 and event_type = 'TurnCompleted' and payload->>'turnId' = $2
           order by id`,
          [workspaceId, turnId],
        ),
      );
      return result.rows.map((row) => row.status);
    }

    function turnEnded(
      chatId: string,
      turnId: string,
      status: 'completed' | 'interrupted' | 'failed',
    ) {
      return {
        type: 'turnEnded' as const,
        status,
        workspaceId,
        chatId,
        turnId,
        principalId: ownerId,
      };
    }

    /** Polls `background`'s dispatcher until `turnId`'s TurnStarted row has been dispatched.
     *  Rows other suites left behind may fail their own consumers; that is not this test's
     *  concern, so a rejecting poll is retried. */
    async function deliverTurnStarted(
      background: ReturnType<typeof createBackgroundServices>,
      turnId: string,
    ): Promise<void> {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        await background.dispatcher.pollOnce().catch(() => 0);
        const result = await admin((client) =>
          client.query<{ dispatched: boolean }>(
            `select dispatched_at is not null as dispatched from outbox
             where workspace_id = $1 and event_type = 'TurnStarted' and payload->>'turnId' = $2`,
            [workspaceId, turnId],
          ),
        );
        if (result.rows[0]?.dispatched) return;
      }
      throw new Error(`TurnStarted for ${turnId} was never dispatched`);
    }

    async function agentHostRuntime(): Promise<{
      runtime: AgentHostRuntime;
      sent: KernelToAgentHostFrame[];
      link: AgentHostLink;
    }> {
      const { privateKey } = await generateEphemeralHandleKeyPair();
      const runtime = new AgentHostRuntime({
        pool,
        sink,
        privateKey,
        kernelLlmUrl: 'http://llm-proxy:8082',
        // Rows other suites left undelivered may start Turns here too — never let their accept
        // timeouts fire during the run.
        turnAcceptedTimeoutMs: 60 * 60 * 1000,
        log: () => {},
      });
      const sent: KernelToAgentHostFrame[] = [];
      const link: AgentHostLink = { send: (frame) => sent.push(frame) };
      runtime.connect(link);
      return { runtime, sent, link };
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      workspaceId = randomUUID();
      ownerId = randomUUID();
      await admin(async (client) => {
        await client.query('insert into workspaces (id, name) values ($1, $2)', [
          workspaceId,
          'r55-turn-terminal-test',
        ]);
        await client.query(
          `insert into principals (workspace_id, id, kind, role, display_name)
           values ($1, $2, 'human', 'member', 'owner')`,
          [workspaceId, ownerId],
        );
      });
      sink = createChatEventSink({ pool });
    });

    afterAll(async () => {
      await pool.end();
    });

    it('a late completed after interrupted does not overwrite it — one TurnCompleted, interrupted', async () => {
      const { chatId, turnId } = await startTurn();

      await sink.handle(turnEnded(chatId, turnId, 'interrupted'));
      await sink.handle(turnEnded(chatId, turnId, 'completed'));

      expect((await turnRow(turnId))?.status).toBe('interrupted');
      expect(await turnCompletedStatuses(turnId)).toEqual(['interrupted']);
    });

    it('a late completed after failed does not overwrite it, and report_turn cannot complete it either', async () => {
      const { chatId, turnId } = await startTurn();

      await sink.handle(turnEnded(chatId, turnId, 'failed'));
      await sink.handle(turnEnded(chatId, turnId, 'completed'));
      const reported = (await dispatchCapability({ pool }, entryHandle(), 'report_turn', {
        turnId,
        summary: 'answered after the accept timeout',
      })) as { status: string };

      expect(reported.status).toBe('failed');
      const row = await turnRow(turnId);
      expect(row?.status).toBe('failed');
      expect(row?.metadata.summary).toBe('answered after the accept timeout');
      expect(await turnCompletedStatuses(turnId)).toEqual(['failed']);
    });

    it('report_turn on a running Turn completes it once; agent-host’s own completed is then a no-op', async () => {
      const { chatId, turnId } = await startTurn();

      const reported = (await dispatchCapability({ pool }, entryHandle(), 'report_turn', {
        turnId,
        summary: 'done',
      })) as { status: string };
      await sink.handle(turnEnded(chatId, turnId, 'completed'));

      expect(reported.status).toBe('completed');
      expect((await turnRow(turnId))?.status).toBe('completed');
      expect(await turnCompletedStatuses(turnId)).toEqual(['completed']);
    });

    it('after Stop, the extension’s report_turn racing agent-host’s report ends the Turn interrupted, not completed', async () => {
      // A runtime that knows the Turn: the end is reported back asynchronously, as in production.
      setAgentRuntimeForHandlers({ startTurn: async () => {}, stopTurn: async () => true });
      const { chatId, turnId } = await startTurn();

      await dispatchCapability({ pool }, human(), 'stop_agent', { chatId });
      expect((await turnRow(turnId))?.status).toBe('running');
      expect((await turnRow(turnId))?.metadata.stopRequestedAt).toBeDefined();

      // The abort settles pi: the extension's report_turn lands first ...
      const reported = (await dispatchCapability({ pool }, entryHandle(), 'report_turn', {
        turnId,
        summary: 'partial answer',
      })) as { status: string };
      // ... then agent-host's own `interrupted`.
      await sink.handle(turnEnded(chatId, turnId, 'interrupted'));

      expect(reported.status).toBe('interrupted');
      const row = await turnRow(turnId);
      expect(row?.status).toBe('interrupted');
      expect(row?.metadata.summary).toBe('partial answer');
      expect(await turnCompletedStatuses(turnId)).toEqual(['interrupted']);
    });

    it('Stop before TurnStarted is delivered: the agent never starts and the Turn stays interrupted', async () => {
      const { runtime, sent } = await agentHostRuntime();
      const background = createBackgroundServices({ pool, runtime });
      try {
        const { chatId, turnId } = await startTurn();

        await dispatchCapability({ pool }, human(), 'stop_agent', { chatId });
        expect((await turnRow(turnId))?.status).toBe('interrupted');

        await deliverTurnStarted(background, turnId);

        expect(sent.filter((frame) => 'turnId' in frame && frame.turnId === turnId)).toEqual([]);
        expect((await turnRow(turnId))?.status).toBe('interrupted');
        expect(await turnCompletedStatuses(turnId)).toEqual(['interrupted']);
      } finally {
        background.stop();
      }
    });

    it('a TurnStarted left undelivered across a restart is not replayed for the Turn recovery interrupted', async () => {
      const { runtime, sent } = await agentHostRuntime();
      const background = createBackgroundServices({ pool, runtime });
      try {
        const { turnId } = await startTurn();

        // A fresh kernel process: its startup scan runs before the dispatcher's first poll.
        await interruptStaleRunningTurns({ pool });
        await deliverTurnStarted(background, turnId);

        expect(sent.filter((frame) => 'turnId' in frame && frame.turnId === turnId)).toEqual([]);
        expect((await turnRow(turnId))?.status).toBe('interrupted');
      } finally {
        background.stop();
      }
    });

    it('R-56: the agent-host link drops mid-Turn — after the reconnect the replayed answer and turnEnded land, and the chat takes the next message', async () => {
      const { runtime, sent, link } = await agentHostRuntime();
      const instanceId = randomUUID();
      runtime.handleFrame({ type: 'hello', instanceId });
      const { chatId, turnId } = await startTurn();
      await runtime.startTurn({
        workspaceId,
        chatId,
        turnId,
        principalId: ownerId,
        prompt: 'hello',
      });
      expect(sent.map((frame) => frame.type)).toContain('startTurn');
      runtime.handleFrame({ type: 'turnAccepted', turnId, seq: 1 });

      // The link flaps while agent-host is still producing the answer: the old socket closes and
      // agent-host's reconnect registers a new one.
      runtime.disconnect(link);
      const replacement: KernelToAgentHostFrame[] = [];
      expect(runtime.connect({ send: (frame) => replacement.push(frame) })).toBe(true);
      runtime.handleFrame({ type: 'hello', instanceId });
      // agent-host sends what it had not seen acknowledged.
      runtime.handleFrame({
        type: 'runtimeEvent',
        seq: 2,
        event: {
          type: 'message',
          role: 'assistant',
          content: { text: 'the answer after the flap' },
          workspaceId,
          chatId,
          turnId,
          principalId: ownerId,
        },
      });
      runtime.handleFrame({
        type: 'runtimeEvent',
        seq: 3,
        event: turnEnded(chatId, turnId, 'completed'),
      });

      await vi.waitFor(async () => expect((await turnRow(turnId))?.status).toBe('completed'));
      expect(replacement.filter((frame) => frame.type === 'ack')).toEqual([
        { type: 'ack', seq: 2 },
        { type: 'ack', seq: 3 },
      ]);
      const history = (await dispatchCapability({ pool }, human(), 'get_chat_history', {
        chatId,
      })) as { items: { role: string; text: string }[] };
      expect(history.items).toContainEqual(
        expect.objectContaining({ role: 'assistant', text: 'the answer after the flap' }),
      );
      await expect(
        dispatchCapability({ pool }, human(), 'send_chat_message', { chatId, text: 'next' }),
      ).resolves.toMatchObject({ turnId: expect.any(String) });
    });

    /** An accepted Turn on a fresh AgentHostRuntime whose sink is `turnSink` (the real chat sink
     *  unless a test wraps it), and the frame helpers agent-host's own order needs. */
    async function acceptedRuntimeTurn(turnSink: AgentRuntimeEventSink) {
      const { privateKey } = await generateEphemeralHandleKeyPair();
      const runtime = new AgentHostRuntime({
        pool,
        sink: turnSink,
        privateKey,
        kernelLlmUrl: 'http://llm-proxy:8082',
        turnAcceptedTimeoutMs: 60 * 60 * 1000,
        log: () => {},
      });
      runtime.connect({ send: () => {} });
      const { chatId, turnId } = await startTurn();
      await runtime.startTurn({ workspaceId, chatId, turnId, principalId: ownerId, prompt: 'hi' });
      runtime.handleFrame({ type: 'turnAccepted', turnId });
      const answer = (text: string) =>
        runtime.handleFrame({
          type: 'runtimeEvent',
          event: {
            type: 'message',
            role: 'assistant',
            content: { text },
            workspaceId,
            chatId,
            turnId,
            principalId: ownerId,
          },
        });
      const end = () =>
        runtime.handleFrame({
          type: 'runtimeEvent',
          event: turnEnded(chatId, turnId, 'completed'),
        });
      return { runtime, chatId, turnId, answer, end };
    }

    /** The real sink, with each `message` held back `ms` first — the insert's own transaction
     *  (chat sequence lock) is slower than `turnEnded`'s single UPDATE; this makes it reliably so. */
    function slowMessageSink(ms: number): AgentRuntimeEventSink {
      return {
        async handle(event) {
          if (event.type === 'message') await new Promise((resolve) => setTimeout(resolve, ms));
          await sink.handle(event);
        },
      };
    }

    async function assistantTexts(chatId: string): Promise<string[]> {
      const history = (await dispatchCapability({ pool }, human(), 'get_chat_history', {
        chatId,
      })) as { items: { role: string; text: string }[] };
      return history.items.filter((item) => item.role === 'assistant').map((item) => item.text);
    }

    it('Turn-end ordering: the answer agent-host sent before turnEnded is stored before the Turn reads completed', async () => {
      const { chatId, turnId, answer, end } = await acceptedRuntimeTurn(slowMessageSink(300));
      const pushes: ChatPushEvent['type'][] = [];
      const unsubscribe = subscribeToChatPushEvents(chatId, (event) => pushes.push(event.type));
      try {
        answer('the stored answer');
        end();

        // The first moment the Turn reads completed, its answer must already be there.
        let historyAtCompletion: string[] | undefined;
        await vi.waitFor(
          async () => {
            const status = (await turnRow(turnId))?.status;
            if (status === 'completed' && historyAtCompletion === undefined) {
              historyAtCompletion = await assistantTexts(chatId);
            }
            expect(status).toBe('completed');
          },
          { timeout: 5000, interval: 10 },
        );
        expect(historyAtCompletion).toEqual(['the stored answer']);
        // A client is told about the answer before it is told the Turn ended.
        await vi.waitFor(() => expect(pushes).toContain('chat.metadata'));
        expect(pushes.filter((type) => type !== 'chat.stream')).toEqual([
          'chat.message',
          'chat.metadata',
        ]);
      } finally {
        unsubscribe();
      }
    });

    it('Turn-end ordering: report_turn arriving before agent-host’s frames records the summary but leaves the end to the runtime', async () => {
      const { runtime, chatId, turnId, answer, end } = await acceptedRuntimeTurn(
        slowMessageSink(300),
      );
      setAgentRuntimeForHandlers(runtime);

      // pi's agent_settled reaches the extension and agent-host at once; the extension's HTTP
      // call wins the race to the kernel.
      const reported = (await dispatchCapability({ pool }, entryHandle(), 'report_turn', {
        turnId,
        summary: 'answered',
      })) as { status: string };
      expect(reported.status).toBe('running');
      expect((await turnRow(turnId))?.metadata.summary).toBe('answered');
      expect(await turnCompletedStatuses(turnId)).toEqual([]);

      answer('the answer');
      end();
      // Still queued behind the answer: report_turn again (a retry) must not end it either.
      await dispatchCapability({ pool }, entryHandle(), 'report_turn', {
        turnId,
        summary: 'answered',
      });
      expect((await turnRow(turnId))?.status).toBe('running');

      await vi.waitFor(async () => expect((await turnRow(turnId))?.status).toBe('completed'), {
        timeout: 5000,
      });
      expect(await assistantTexts(chatId)).toEqual(['the answer']);
      expect(await turnCompletedStatuses(turnId)).toEqual(['completed']);
      expect(runtime.ownsTurnEnd(turnId)).toBe(false);
    });
  },
);
