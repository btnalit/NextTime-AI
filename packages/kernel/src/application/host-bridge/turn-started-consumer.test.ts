import { describe, expect, it, vi } from 'vitest';
import type { AgentRuntime, StartTurnInput } from './agent-runtime.js';
import {
  type ResolveTurnPrompt,
  type TurnStartedSource,
  registerTurnStartedConsumer,
} from './turn-started-consumer.js';

/**
 * Unit tests (no IO) for registerTurnStartedConsumer — docs/development-tasks.md S1.4 deliverable
 * 5: "prefixing the prompt with the `<!--nexttime:turn_id=<id>-->` marker the extension expects";
 * "consumers idempotent (dedupe on the outbox row id)". Lane-1 P2 fix: the event now carries a
 * `chatMessageId` reference, resolved to text via a `resolvePrompt` fake here (the real resolver,
 * a `chat_messages` read, is exercised by packages/kernel/src/index.ts's own wiring instead).
 */

type Consumer = Parameters<TurnStartedSource['subscribe']>[1];

function createFakeDispatcher(): TurnStartedSource & {
  emit: (outboxId: string, event: Parameters<Consumer>[0]) => Promise<void>;
} {
  let registered: Consumer | undefined;
  return {
    subscribe: (_eventType, consumer) => {
      registered = consumer;
      return () => {
        registered = undefined;
      };
    },
    emit: async (outboxId, event) => {
      await registered?.(event, { outboxId, workspaceId: event.workspaceId });
    },
  };
}

function fakeRuntime(): { runtime: AgentRuntime; started: StartTurnInput[] } {
  const started: StartTurnInput[] = [];
  return {
    runtime: {
      startTurn: vi.fn(async (input: StartTurnInput) => {
        started.push(input);
      }),
      stopTurn: vi.fn(async () => {}),
    },
    started,
  };
}

const PROMPT_TEXT = 'hi there';

/** A `resolvePrompt` fake that always returns `PROMPT_TEXT`, regardless of the event given. */
const resolvePrompt: ResolveTurnPrompt = async () => PROMPT_TEXT;

const EVENT = {
  type: 'TurnStarted' as const,
  workspaceId: 'ws1',
  chatId: 'chat1',
  turnId: 'turn1',
  principalId: 'p1',
  chatMessageId: 'msg1',
};

describe('registerTurnStartedConsumer', () => {
  it('calls startTurn with the resolved prompt prefixed by the turn_id marker', async () => {
    const dispatcher = createFakeDispatcher();
    const { runtime, started } = fakeRuntime();
    registerTurnStartedConsumer(dispatcher, runtime, resolvePrompt);

    await dispatcher.emit('outbox-1', EVENT);

    expect(started).toHaveLength(1);
    expect(started[0]).toEqual({
      workspaceId: EVENT.workspaceId,
      chatId: EVENT.chatId,
      turnId: EVENT.turnId,
      principalId: EVENT.principalId,
      prompt: `<!--nexttime:turn_id=${EVENT.turnId}-->\n${PROMPT_TEXT}`,
    });
  });

  it('passes the event to resolvePrompt so a real resolver can look up its chatMessageId', async () => {
    const dispatcher = createFakeDispatcher();
    const { runtime, started } = fakeRuntime();
    const resolve = vi.fn(async (event: Parameters<ResolveTurnPrompt>[0]) =>
      event.chatMessageId === EVENT.chatMessageId ? PROMPT_TEXT : 'wrong message',
    );
    registerTurnStartedConsumer(dispatcher, runtime, resolve);

    await dispatcher.emit('outbox-1', EVENT);

    expect(resolve).toHaveBeenCalledWith(EVENT);
    expect(started[0]?.prompt).toContain(PROMPT_TEXT);
  });

  it('dedupes redelivery of the same outbox row id — startTurn is called exactly once', async () => {
    const dispatcher = createFakeDispatcher();
    const { runtime, started } = fakeRuntime();
    registerTurnStartedConsumer(dispatcher, runtime, resolvePrompt);

    await dispatcher.emit('outbox-1', EVENT);
    await dispatcher.emit('outbox-1', EVENT); // simulated redelivery of the identical row

    expect(started).toHaveLength(1);
  });

  it('a different outbox row id for a different Turn is not deduped', async () => {
    const dispatcher = createFakeDispatcher();
    const { runtime, started } = fakeRuntime();
    registerTurnStartedConsumer(dispatcher, runtime, resolvePrompt);

    await dispatcher.emit('outbox-1', EVENT);
    await dispatcher.emit('outbox-2', { ...EVENT, turnId: 'turn2' });

    expect(started).toHaveLength(2);
  });

  it('unsubscribing stops further delivery to the runtime', async () => {
    const dispatcher = createFakeDispatcher();
    const { runtime, started } = fakeRuntime();
    const unsubscribe = registerTurnStartedConsumer(dispatcher, runtime, resolvePrompt);
    unsubscribe();

    await dispatcher.emit('outbox-1', EVENT);

    expect(started).toHaveLength(0);
  });

  it('lane-4 P1 fix: a throw is not deduped — redelivery of the same outbox row id retries it', async () => {
    const dispatcher = createFakeDispatcher();
    const started: StartTurnInput[] = [];
    let failNext = true;
    const runtime: AgentRuntime = {
      startTurn: vi.fn(async (input: StartTurnInput) => {
        if (failNext) {
          failNext = false;
          throw new Error('boom');
        }
        started.push(input);
      }),
      stopTurn: vi.fn(async () => true),
    };
    registerTurnStartedConsumer(dispatcher, runtime, resolvePrompt);

    // First delivery throws — the outboxId must not have been marked "seen" as a result (the
    // previous shape of this function added it *before* calling startTurn, which would have
    // silently swallowed every later redelivery of this exact row).
    await expect(dispatcher.emit('outbox-1', EVENT)).rejects.toThrow('boom');
    expect(started).toHaveLength(0);

    // Redelivery of the identical outbox row (dispatcher retry after its own transaction rolled
    // back) must actually retry the call, not be dropped by the dedupe Set.
    await dispatcher.emit('outbox-1', EVENT);
    expect(started).toHaveLength(1);

    // A *further* redelivery of the same row, now that it succeeded, is still deduped exactly
    // once (the Set was correctly populated after the successful attempt).
    await dispatcher.emit('outbox-1', EVENT);
    expect(started).toHaveLength(1);
  });

  it('a resolvePrompt rejection is not deduped either — same retry semantics as a startTurn throw', async () => {
    const dispatcher = createFakeDispatcher();
    const { runtime, started } = fakeRuntime();
    let failNext = true;
    const flakyResolve: ResolveTurnPrompt = async () => {
      if (failNext) {
        failNext = false;
        throw new Error('db down');
      }
      return PROMPT_TEXT;
    };
    registerTurnStartedConsumer(dispatcher, runtime, flakyResolve);

    await expect(dispatcher.emit('outbox-1', EVENT)).rejects.toThrow('db down');
    expect(started).toHaveLength(0);

    await dispatcher.emit('outbox-1', EVENT);
    expect(started).toHaveLength(1);
  });
});
