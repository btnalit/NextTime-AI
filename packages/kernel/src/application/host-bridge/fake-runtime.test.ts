import { describe, expect, it, vi } from 'vitest';
import type { AgentRuntimeEvent, StartTurnInput } from './agent-runtime.js';
import {
  FAKE_ADMIN_PROPOSE_MARKER,
  FAKE_ADMIN_PROPOSE_PACK_MARKER,
  FAKE_DELEGATE_MARKER,
  type FakeAdminProposeOutcome,
  FakeAgentRuntime,
  type FakeDelegateOutcome,
} from './fake-runtime.js';

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
    await expect(runtime.stopTurn(INPUT.turnId)).resolves.toBe(true);
    await waitFor(events, () => events.some((e) => e.type === 'turnEnded'));

    expect(events.find((e) => e.type === 'turnEnded')).toMatchObject({ status: 'interrupted' });
    expect(events.some((e) => e.type === 'message')).toBe(false);
  });

  it('stopTurn on an unknown/already-ended turnId is a harmless no-op and reports it knew nothing', async () => {
    const { sink } = collectingSink();
    const runtime = new FakeAgentRuntime({ sink });

    await expect(runtime.stopTurn('no-such-turn')).resolves.toBe(false);
  });

  it('stopTurn after the turn has already ended reports it knew nothing (lane-4 P1/P2 fix)', async () => {
    const { sink, events } = collectingSink();
    const runtime = new FakeAgentRuntime({ sink });

    await runtime.startTurn(INPUT);
    await waitFor(events, () => events.some((e) => e.type === 'turnEnded'));

    await expect(runtime.stopTurn(INPUT.turnId)).resolves.toBe(false);
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

  // STATUS leftover 83 (CI invoke_worker path): `onDelegate` — see fake-runtime.ts's own doc
  // comment. The composition-root wiring (packages/kernel/src/fake-invoke-worker.ts) is exercised
  // for real by the e2e suite in CI; these are pure, no-IO unit tests of the marker/hook plumbing
  // itself, same shape as every other test in this file.
  describe('onDelegate (STATUS leftover 83)', () => {
    const OUTCOME: FakeDelegateOutcome = {
      taskId: 'task-1',
      workerRunId: 'run-1',
      status: 'completed',
    };

    it('a prompt without the marker still echoes even when onDelegate is wired', async () => {
      const { sink, events } = collectingSink();
      const onDelegate = vi.fn(async () => OUTCOME);
      const runtime = new FakeAgentRuntime({ sink, onDelegate });

      await runtime.startTurn(INPUT);
      await waitFor(events, () => events.some((e) => e.type === 'turnEnded'));

      expect(onDelegate).not.toHaveBeenCalled();
      expect(events.some((e) => e.type === 'message')).toBe(true);
      const message = events.find((e) => e.type === 'message');
      expect(message).toMatchObject({ content: { text: `echo: ${INPUT.prompt}` } });
    });

    it('a marker prompt with no onDelegate wired still echoes (opt-in, never a silent behavior change)', async () => {
      const { sink, events } = collectingSink();
      const runtime = new FakeAgentRuntime({ sink });
      const input: StartTurnInput = { ...INPUT, prompt: `${FAKE_DELEGATE_MARKER} 委派` };

      await runtime.startTurn(input);
      await waitFor(events, () => events.some((e) => e.type === 'turnEnded'));

      expect(events.some((e) => e.type === 'toolCallStarted')).toBe(false);
      const message = events.find((e) => e.type === 'message');
      expect(message).toMatchObject({ content: { text: `echo: ${input.prompt}` } });
    });

    it('a marker prompt with onDelegate wired calls it once, emits a toolCall pair, and ends completed', async () => {
      const { sink, events } = collectingSink();
      const onDelegate = vi.fn(async () => OUTCOME);
      const runtime = new FakeAgentRuntime({ sink, onDelegate });
      const input: StartTurnInput = {
        ...INPUT,
        prompt: `${FAKE_DELEGATE_MARKER} 委派给 ops-runner`,
      };

      await runtime.startTurn(input);
      await waitFor(events, () => events.some((e) => e.type === 'turnEnded'));

      expect(onDelegate).toHaveBeenCalledTimes(1);
      expect(onDelegate).toHaveBeenCalledWith(input);
      expect(events.some((e) => e.type === 'textDelta')).toBe(false);

      const started = events.find((e) => e.type === 'toolCallStarted');
      const ended = events.find((e) => e.type === 'toolCallEnded');
      expect(started).toMatchObject({ type: 'toolCallStarted', name: 'invoke_worker' });
      expect(ended).toMatchObject({ type: 'toolCallEnded', result: OUTCOME });
      expect((ended as { toolCallId?: string })?.toolCallId).toBe(
        (started as { toolCallId?: string })?.toolCallId,
      );

      const message = events.find((e) => e.type === 'message');
      expect(message).toMatchObject({
        role: 'assistant',
        content: {
          text: `invoke_worker: task ${OUTCOME.taskId} (worker run ${OUTCOME.workerRunId}) ended ${OUTCOME.status}.`,
        },
      });

      const turnEnded = events.find((e) => e.type === 'turnEnded');
      expect(turnEnded).toMatchObject({ status: 'completed' });
      // Started before ended, ended before the message, message before turnEnded.
      const types = events.map((e) => e.type);
      expect(types.indexOf('toolCallStarted')).toBeLessThan(types.indexOf('toolCallEnded'));
      expect(types.indexOf('toolCallEnded')).toBeLessThan(types.indexOf('message'));
      expect(types.indexOf('message')).toBeLessThan(types.indexOf('turnEnded'));
    });

    it('onDelegate rejecting ends the turn failed with the error message, never throwing out of startTurn', async () => {
      const { sink, events } = collectingSink();
      const onDelegate = vi.fn(async () => {
        throw new Error('no delegable WorkerDefinition');
      });
      const runtime = new FakeAgentRuntime({ sink, onDelegate });
      const input: StartTurnInput = { ...INPUT, prompt: `${FAKE_DELEGATE_MARKER} 委派` };

      await runtime.startTurn(input);
      await waitFor(events, () => events.some((e) => e.type === 'turnEnded'));

      const ended = events.find((e) => e.type === 'toolCallEnded');
      expect(ended).toMatchObject({ isError: true });
      const message = events.find((e) => e.type === 'message');
      expect(message).toMatchObject({
        content: { text: 'invoke_worker failed: no delegable WorkerDefinition' },
      });
      const turnEnded = events.find((e) => e.type === 'turnEnded');
      expect(turnEnded).toMatchObject({ status: 'failed' });
    });
  });
  describe('onAdminPropose (S11 AA4d, AA4 plan F9)', () => {
    const OUTCOME: FakeAdminProposeOutcome = {
      proposalId: 'proposal-1',
      title: 'CI admin proposal 1',
      status: 'proposed',
    };
    const ADMIN_INPUT: StartTurnInput = {
      ...INPUT,
      agentKind: 'admin_agent',
      sessionId: 'session-1',
      prompt: `${FAKE_ADMIN_PROPOSE_MARKER} 提一份管理员提案`,
    };

    async function run(
      options: Partial<ConstructorParameters<typeof FakeAgentRuntime>[0]>,
      input: StartTurnInput,
    ) {
      const { sink, events } = collectingSink();
      const runtime = new FakeAgentRuntime({ sink, ...options });
      await runtime.startTurn(input);
      await waitFor(events, () => events.some((e) => e.type === 'turnEnded'));
      return events;
    }

    it('an admin agent Turn with the marker calls it once, emits a propose_admin_proposal pair, and ends completed', async () => {
      const onAdminPropose = vi.fn(async () => OUTCOME);
      const onDelegate = vi.fn(async (): Promise<FakeDelegateOutcome> => {
        throw new Error('never');
      });
      const events = await run({ onAdminPropose, onDelegate }, ADMIN_INPUT);

      expect(onAdminPropose).toHaveBeenCalledTimes(1);
      expect(onAdminPropose).toHaveBeenCalledWith(ADMIN_INPUT);
      expect(onDelegate).not.toHaveBeenCalled();
      expect(events.some((e) => e.type === 'textDelta')).toBe(false);
      const started = events.find((e) => e.type === 'toolCallStarted');
      const ended = events.find((e) => e.type === 'toolCallEnded');
      expect(started).toMatchObject({ name: 'propose_admin_proposal' });
      expect(ended).toMatchObject({ result: OUTCOME });
      expect((ended as { toolCallId?: string })?.toolCallId).toBe(
        (started as { toolCallId?: string })?.toolCallId,
      );
      expect(events.find((e) => e.type === 'message')).toMatchObject({
        role: 'assistant',
        content: {
          text: `propose_admin_proposal: proposed "${OUTCOME.title}" (${OUTCOME.proposalId}), now ${OUTCOME.status}.`,
        },
      });
      expect(events.find((e) => e.type === 'turnEnded')).toMatchObject({ status: 'completed' });
      const types = events.map((e) => e.type);
      expect(types).toEqual(['toolCallStarted', 'toolCallEnded', 'message', 'turnEnded']);
    });

    it('the marker in an entry Turn is echoed: only an admin agent proposes', async () => {
      const onAdminPropose = vi.fn(async () => OUTCOME);
      const input: StartTurnInput = { ...INPUT, prompt: ADMIN_INPUT.prompt };
      const events = await run({ onAdminPropose }, input);

      expect(onAdminPropose).not.toHaveBeenCalled();
      expect(events.some((e) => e.type === 'toolCallStarted')).toBe(false);
      expect(events.find((e) => e.type === 'message')).toMatchObject({
        content: { text: `echo: ${input.prompt}` },
      });
    });

    it('with no hook wired the marker is echoed, in an admin agent Turn too', async () => {
      const events = await run({}, ADMIN_INPUT);

      expect(events.some((e) => e.type === 'toolCallStarted')).toBe(false);
      expect(events.find((e) => e.type === 'message')).toMatchObject({
        content: { text: `echo: ${ADMIN_INPUT.prompt}` },
      });
      expect(events.find((e) => e.type === 'turnEnded')).toMatchObject({ status: 'completed' });
    });

    it('the delegate marker in an admin agent Turn is echoed: an admin agent never calls invoke_worker', async () => {
      const onDelegate = vi.fn(async (): Promise<FakeDelegateOutcome> => {
        throw new Error('never');
      });
      const input: StartTurnInput = { ...ADMIN_INPUT, prompt: `${FAKE_DELEGATE_MARKER} 委派` };
      const events = await run({ onDelegate }, input);

      expect(onDelegate).not.toHaveBeenCalled();
      expect(events.find((e) => e.type === 'message')).toMatchObject({
        content: { text: `echo: ${input.prompt}` },
      });
    });

    it('a rejection ends the Turn failed with its message, never throwing out of startTurn', async () => {
      const onAdminPropose = vi.fn(async (): Promise<FakeAdminProposeOutcome> => {
        throw new Error('no proposal targets chosen');
      });
      const events = await run({ onAdminPropose }, ADMIN_INPUT);

      expect(events.find((e) => e.type === 'toolCallEnded')).toMatchObject({ isError: true });
      expect(events.find((e) => e.type === 'message')).toMatchObject({
        content: { text: 'propose_admin_proposal failed: no proposal targets chosen' },
      });
      expect(events.find((e) => e.type === 'turnEnded')).toMatchObject({ status: 'failed' });
    });

    describe('onAdminProposePack (S11 AA5g)', () => {
      const PACK_INPUT: StartTurnInput = {
        ...ADMIN_INPUT,
        prompt: `${FAKE_ADMIN_PROPOSE_PACK_MARKER} 建议装一个能力包`,
      };

      it('neither marker contains the other: a prompt carries one or the other', () => {
        expect(FAKE_ADMIN_PROPOSE_PACK_MARKER.includes(FAKE_ADMIN_PROPOSE_MARKER)).toBe(false);
        expect(FAKE_ADMIN_PROPOSE_MARKER.includes(FAKE_ADMIN_PROPOSE_PACK_MARKER)).toBe(false);
      });

      it('the pack marker calls the pack hook once, emits a propose_pack_install pair, and ends completed', async () => {
        const onAdminPropose = vi.fn(async () => OUTCOME);
        const onAdminProposePack = vi.fn(async () => OUTCOME);
        const events = await run({ onAdminPropose, onAdminProposePack }, PACK_INPUT);

        expect(onAdminProposePack).toHaveBeenCalledTimes(1);
        expect(onAdminProposePack).toHaveBeenCalledWith(PACK_INPUT);
        expect(onAdminPropose).not.toHaveBeenCalled();
        expect(events.find((e) => e.type === 'toolCallStarted')).toMatchObject({
          name: 'propose_pack_install',
        });
        expect(events.find((e) => e.type === 'message')).toMatchObject({
          content: {
            text: `propose_pack_install: proposed "${OUTCOME.title}" (${OUTCOME.proposalId}), now ${OUTCOME.status}.`,
          },
        });
        expect(events.map((e) => e.type)).toEqual([
          'toolCallStarted',
          'toolCallEnded',
          'message',
          'turnEnded',
        ]);
        expect(events.find((e) => e.type === 'turnEnded')).toMatchObject({ status: 'completed' });
      });

      it('the proposal marker still calls only the proposal hook', async () => {
        const onAdminPropose = vi.fn(async () => OUTCOME);
        const onAdminProposePack = vi.fn(async () => OUTCOME);
        await run({ onAdminPropose, onAdminProposePack }, ADMIN_INPUT);

        expect(onAdminPropose).toHaveBeenCalledTimes(1);
        expect(onAdminProposePack).not.toHaveBeenCalled();
      });

      it('in an entry Turn, or with no hook wired, the pack marker is echoed', async () => {
        const onAdminProposePack = vi.fn(async () => OUTCOME);
        const entry = await run({ onAdminProposePack }, { ...INPUT, prompt: PACK_INPUT.prompt });
        expect(onAdminProposePack).not.toHaveBeenCalled();
        expect(entry.find((e) => e.type === 'message')).toMatchObject({
          content: { text: `echo: ${PACK_INPUT.prompt}` },
        });
        const unwired = await run({}, PACK_INPUT);
        expect(unwired.some((e) => e.type === 'toolCallStarted')).toBe(false);
      });

      it('a rejection ends the Turn failed, naming propose_pack_install', async () => {
        const onAdminProposePack = vi.fn(async (): Promise<FakeAdminProposeOutcome> => {
          throw new Error('no proposal targets chosen');
        });
        const events = await run({ onAdminProposePack }, PACK_INPUT);
        expect(events.find((e) => e.type === 'message')).toMatchObject({
          content: { text: 'propose_pack_install failed: no proposal targets chosen' },
        });
        expect(events.find((e) => e.type === 'turnEnded')).toMatchObject({ status: 'failed' });
      });
    });
  });
});
