import { describe, expect, it, vi } from 'vitest';
import type { AgentRuntime, StartTurnInput } from './agent-runtime.js';
import { type TurnStartedSource, registerTurnStartedConsumer } from './turn-started-consumer.js';

/**
 * Unit tests (no IO) for registerTurnStartedConsumer — docs/development-tasks.md S1.4 deliverable
 * 5: "prefixing the prompt with the `<!--nexttime:turn_id=<id>-->` marker the extension expects";
 * "consumers idempotent (dedupe on the outbox row id)".
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

const EVENT = {
  type: 'TurnStarted' as const,
  workspaceId: 'ws1',
  chatId: 'chat1',
  turnId: 'turn1',
  principalId: 'p1',
  prompt: 'hi there',
};

describe('registerTurnStartedConsumer', () => {
  it('calls startTurn with the prompt prefixed by the turn_id marker', async () => {
    const dispatcher = createFakeDispatcher();
    const { runtime, started } = fakeRuntime();
    registerTurnStartedConsumer(dispatcher, runtime);

    await dispatcher.emit('outbox-1', EVENT);

    expect(started).toHaveLength(1);
    expect(started[0]).toEqual({
      workspaceId: EVENT.workspaceId,
      chatId: EVENT.chatId,
      turnId: EVENT.turnId,
      principalId: EVENT.principalId,
      prompt: `<!--nexttime:turn_id=${EVENT.turnId}-->\n${EVENT.prompt}`,
    });
  });

  it('dedupes redelivery of the same outbox row id — startTurn is called exactly once', async () => {
    const dispatcher = createFakeDispatcher();
    const { runtime, started } = fakeRuntime();
    registerTurnStartedConsumer(dispatcher, runtime);

    await dispatcher.emit('outbox-1', EVENT);
    await dispatcher.emit('outbox-1', EVENT); // simulated redelivery of the identical row

    expect(started).toHaveLength(1);
  });

  it('a different outbox row id for a different Turn is not deduped', async () => {
    const dispatcher = createFakeDispatcher();
    const { runtime, started } = fakeRuntime();
    registerTurnStartedConsumer(dispatcher, runtime);

    await dispatcher.emit('outbox-1', EVENT);
    await dispatcher.emit('outbox-2', { ...EVENT, turnId: 'turn2' });

    expect(started).toHaveLength(2);
  });

  it('unsubscribing stops further delivery to the runtime', async () => {
    const dispatcher = createFakeDispatcher();
    const { runtime, started } = fakeRuntime();
    const unsubscribe = registerTurnStartedConsumer(dispatcher, runtime);
    unsubscribe();

    await dispatcher.emit('outbox-1', EVENT);

    expect(started).toHaveLength(0);
  });
});
