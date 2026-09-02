import { describe, expect, it, vi } from 'vitest';
import type { AgentRuntimeEvent, StartTurnInput } from './agent-runtime.js';
import { FakeAgentRuntime } from './fake-runtime.js';

/**
 * Unit tests (no IO) for FakeAgentRuntime — docs/development-tasks.md S1.4 deliverable 5:
 * "streams a canned reply (echoes the prompt), ends the turn; optional configurable delay/failure
 * for tests".
 */

function collectingSink() {
  const events: AgentRuntimeEvent[] = [];
  return { sink: { handle: (event: AgentRuntimeEvent) => void events.push(event) }, events };
}

const INPUT: StartTurnInput = {
  workspaceId: 'ws1',
  chatId: 'chat1',
  turnId: 'turn1',
  principalId: 'p1',
  prompt: 'hello there',
};

/** Waits for the given predicate to hold true over `events`, polling on microtasks — the fake
 *  runtime's `startTurn` is fire-and-forget, so tests must wait for its async run() to settle. */
async function waitFor(
  events: readonly AgentRuntimeEvent[],
  predicate: () => boolean,
): Promise<void> {
  for (let i = 0; i < 1000 && !predicate(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (!predicate()) throw new Error(`waitFor timed out; events so far: ${JSON.stringify(events)}`);
}

describe('FakeAgentRuntime', () => {
  it('echoes the prompt as textDelta chunks, then a persisted assistant message, then turnEnded completed', async () => {
    const { sink, events } = collectingSink();
    const runtime = new FakeAgentRuntime({ sink, chunkSize: 5 });

    await runtime.startTurn(INPUT);
    await waitFor(events, () => events.some((e) => e.type === 'turnEnded'));

    const deltas = events.filter((e) => e.type === 'textDelta');
    expect(deltas.length).toBeGreaterThan(0);
    const joined = deltas.map((e) => (e.type === 'textDelta' ? e.delta : '')).join('');
    expect(joined).toBe(`echo: ${INPUT.prompt}`);

    const message = events.find((e) => e.type === 'message');
    expect(message).toMatchObject({
      type: 'message',
      role: 'assistant',
      content: { text: `echo: ${INPUT.prompt}` },
    });

    const turnEnded = events.find((e) => e.type === 'turnEnded');
    expect(turnEnded).toMatchObject({ type: 'turnEnded', status: 'completed' });

    // Every event carries the same correlation fields.
    for (const event of events) {
      expect(event.workspaceId).toBe(INPUT.workspaceId);
      expect(event.chatId).toBe(INPUT.chatId);
      expect(event.turnId).toBe(INPUT.turnId);
      expect(event.principalId).toBe(INPUT.principalId);
    }

    // message comes after every textDelta, and turnEnded is last.
    const types = events.map((e) => e.type);
    expect(types.at(-1)).toBe('turnEnded');
    expect(types.indexOf('message')).toBeGreaterThan(types.lastIndexOf('textDelta'));
  });

  it('shouldFail ends the turn with status failed instead of completed', async () => {
    const { sink, events } = collectingSink();
    const runtime = new FakeAgentRuntime({ sink, shouldFail: () => true });

    await runtime.startTurn(INPUT);
    await waitFor(events, () => events.some((e) => e.type === 'turnEnded'));

    expect(events.find((e) => e.type === 'turnEnded')).toMatchObject({ status: 'failed' });
  });

  it('stopTurn mid-stream ends the turn with status interrupted and never emits the assistant message', async () => {
    const { sink, events } = collectingSink();
    const runtime = new FakeAgentRuntime({ sink, chunkDelayMs: 5, chunkSize: 1 });

    await runtime.startTurn(INPUT);
    await waitFor(events, () => events.some((e) => e.type === 'textDelta'));
    await runtime.stopTurn(INPUT.turnId);
    await waitFor(events, () => events.some((e) => e.type === 'turnEnded'));

    expect(events.find((e) => e.type === 'turnEnded')).toMatchObject({ status: 'interrupted' });
    expect(events.some((e) => e.type === 'message')).toBe(false);
  });

  it('stopTurn on an unknown/already-ended turnId is a harmless no-op', async () => {
    const { sink } = collectingSink();
    const runtime = new FakeAgentRuntime({ sink });

    await expect(runtime.stopTurn('no-such-turn')).resolves.toBeUndefined();
  });

  it('runs two turns independently — stopping one does not affect the other', async () => {
    const { sink, events } = collectingSink();
    const runtime = new FakeAgentRuntime({ sink, chunkDelayMs: 5, chunkSize: 1 });
    const otherInput: StartTurnInput = { ...INPUT, turnId: 'turn2', chatId: 'chat2' };

    await runtime.startTurn(INPUT);
    await runtime.startTurn(otherInput);
    await waitFor(events, () =>
      events.some((e) => e.type === 'textDelta' && e.turnId === INPUT.turnId),
    );
    await runtime.stopTurn(INPUT.turnId);
    await waitFor(
      events,
      () =>
        events.some((e) => e.type === 'turnEnded' && e.turnId === INPUT.turnId) &&
        events.some((e) => e.type === 'turnEnded' && e.turnId === otherInput.turnId),
    );

    const turn1End = events.find((e) => e.type === 'turnEnded' && e.turnId === INPUT.turnId);
    const turn2End = events.find((e) => e.type === 'turnEnded' && e.turnId === otherInput.turnId);
    expect(turn1End).toMatchObject({ status: 'interrupted' });
    expect(turn2End).toMatchObject({ status: 'completed' });
  });

  it('startTurn returns before the sink is ever called — emission is asynchronous, not synchronous', () => {
    const handle = vi.fn();
    const runtime = new FakeAgentRuntime({ sink: { handle } });

    // Deliberately not awaited: `startTurn` resolving is not the signal a Turn is done (see
    // agent-runtime.ts's own doc comment) — asserting immediately after the call, before any
    // microtask has had a chance to run, is what actually proves nothing is emitted synchronously
    // inside the call itself.
    void runtime.startTurn(INPUT);
    expect(handle).not.toHaveBeenCalled();
  });
});
