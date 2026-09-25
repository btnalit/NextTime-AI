import { randomUUID } from 'node:crypto';
import type { AgentRuntimeEventWire, KernelToAgentHostFrame } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import type { AttachedContainerIo, ContainerIoClient } from './container-io.js';
import { type Host, type HostOptions, createHost } from './host.js';
import type { KernelLink } from './kernel-link.js';
import type {
  ResidentStatus,
  SpawnInput,
  SpawnResult,
  SupervisorClientPort,
} from './supervisor-client.js';

/**
 * host.test: `createHost`'s full orchestration — spawn/attach via fakes for
 * `SupervisorClientPort`/`ContainerIoClient`/`KernelLink`, no real Docker/supervisor/kernel
 * involved. Exercises the same pi RPC event/response shapes `bridge.test.ts` covers in isolation,
 * here through the whole `handleStartTurn`/`handleLine`/`handleStopTurn`/container-close path.
 */

function startTurnCommand(
  overrides: Partial<Extract<KernelToAgentHostFrame, { type: 'startTurn' }>> = {},
): Extract<KernelToAgentHostFrame, { type: 'startTurn' }> {
  return {
    type: 'startTurn',
    workspaceId: randomUUID(),
    chatId: randomUUID(),
    turnId: randomUUID(),
    principalId: randomUUID(),
    prompt: 'hello',
    handle: 'jwt-token',
    kernelLlmUrl: 'http://llm-proxy:8082',
    ...overrides,
  };
}

function createFakeKernelLink() {
  const runtimeEvents: AgentRuntimeEventWire[] = [];
  const accepted: string[] = [];
  const rejected: Array<{ turnId: string; reason: string }> = [];
  const link: KernelLink = {
    start: () => {},
    stop: () => {},
    isConnected: () => true,
    sendRuntimeEvent: (event) => {
      runtimeEvents.push(event);
    },
    sendTurnAccepted: (turnId) => {
      accepted.push(turnId);
    },
    sendTurnRejected: (turnId, reason) => {
      rejected.push({ turnId, reason });
    },
  };
  return { link, runtimeEvents, accepted, rejected };
}

interface FakeAttachment {
  readonly containerId: string;
  readonly written: unknown[];
  readonly lineListeners: Array<(line: string) => void>;
  readonly closeListeners: Array<(err: Error | undefined) => void>;
  closed: boolean;
  emitLine(value: unknown): void;
  emitClose(err?: Error): void;
}

function createFakeContainerIoClient() {
  const attachmentsByContainerId = new Map<string, FakeAttachment>();
  const attachCalls: string[] = [];
  let attachError: Error | undefined;

  const client: ContainerIoClient = {
    async attach(containerId: string): Promise<AttachedContainerIo> {
      attachCalls.push(containerId);
      if (attachError) throw attachError;

      const record: FakeAttachment = {
        containerId,
        written: [],
        lineListeners: [],
        closeListeners: [],
        closed: false,
        emitLine(value: unknown): void {
          const line = JSON.stringify(value);
          for (const listener of record.lineListeners) listener(line);
        },
        emitClose(err?: Error): void {
          if (record.closed) return;
          record.closed = true;
          for (const listener of record.closeListeners) listener(err);
        },
      };
      attachmentsByContainerId.set(containerId, record);

      const io: AttachedContainerIo = {
        writeLine(value: unknown): void {
          if (!record.closed) record.written.push(value);
        },
        onLine(listener: (line: string) => void): void {
          record.lineListeners.push(listener);
        },
        onClose(listener: (err: Error | undefined) => void): void {
          record.closeListeners.push(listener);
        },
        close(): void {
          record.closed = true;
        },
      };
      return io;
    },
  };

  return {
    client,
    attachCalls,
    attachmentsByContainerId,
    setAttachError: (err: Error | undefined) => {
      attachError = err;
    },
  };
}

function createFakeSupervisorClient() {
  const spawnCalls: SpawnInput[] = [];
  const touchCalls: string[] = [];
  let spawnResult: SpawnResult = {
    containerId: 'c1',
    ip: '100.64.0.2',
    status: 'running',
    created: true,
    restarts: 0,
  };
  let spawnError: Error | undefined;
  let touchError: Error | undefined;
  /** Runs while a spawn is in flight — after the request is "sent", before its result comes back
   *  (leftover 44 tests below use it to model worker-supervisor stopping the previous container
   *  *inside* this very spawn call: its attach stream closes before the new id is returned). */
  let spawnInterceptor: ((input: SpawnInput) => Promise<void> | void) | undefined;

  const client: SupervisorClientPort = {
    async spawn(input: SpawnInput): Promise<SpawnResult> {
      spawnCalls.push(input);
      if (spawnError) throw spawnError;
      if (spawnInterceptor) await spawnInterceptor(input);
      return spawnResult;
    },
    async stop(): Promise<void> {},
    async status(): Promise<ResidentStatus | undefined> {
      return undefined;
    },
    async touch(principalId: string): Promise<boolean> {
      touchCalls.push(principalId);
      if (touchError) throw touchError;
      return true;
    },
  };

  return {
    client,
    spawnCalls,
    touchCalls,
    setSpawnResult: (result: SpawnResult) => {
      spawnResult = result;
    },
    setSpawnError: (err: Error | undefined) => {
      spawnError = err;
    },
    setTouchError: (err: Error | undefined) => {
      touchError = err;
    },
    setSpawnInterceptor: (hook: ((input: SpawnInput) => Promise<void> | void) | undefined) => {
      spawnInterceptor = hook;
    },
  };
}

/** `overrides.now` lets a test drive `refreshTouch`'s throttle window (leftover 46) without real
 *  timers — see that describe block below. */
function setUp(overrides: Partial<HostOptions> = {}) {
  const supervisor = createFakeSupervisorClient();
  const containerIo = createFakeContainerIoClient();
  const kernelLink = createFakeKernelLink();
  const host = createHost({
    supervisorClient: supervisor.client,
    containerIoClient: containerIo.client,
    kernelLink: kernelLink.link,
    kernelUrl: 'http://kernel:8080',
    defaultKernelLlmUrl: 'http://llm-proxy:8082',
    log: () => {},
    ...overrides,
  });
  return { host, supervisor, containerIo, kernelLink };
}

/** The `switch_session` command `handleStartTurn` writes whenever the container's pi process is
 *  not already on this chat's own session file (leftover 33) — which is every first turn on a
 *  freshly attached container, so most tests below see it before their `prompt`. */
function switchCommand(cmd: { turnId: string; chatId: string }): unknown {
  return {
    type: 'switch_session',
    id: `switch:${cmd.turnId}`,
    sessionPath: `/workspace/.pi/sessions/chat-${cmd.chatId}.jsonl`,
  };
}

function promptCommand(cmd: { turnId: string; prompt: string }): unknown {
  return { type: 'prompt', id: cmd.turnId, message: cmd.prompt };
}

/** pi's own success answer to that switch — the point at which the Turn's prompt is written. */
function emitSwitchOk(attachment: FakeAttachment | undefined, turnId: string): void {
  attachment?.emitLine({
    type: 'response',
    command: 'switch_session',
    id: `switch:${turnId}`,
    success: true,
    data: { cancelled: false },
  });
}

/** Drives one `startTurn` all the way to "pi accepted the prompt" — `switch_session`, pi's success
 *  answer, the `prompt`, pi's success answer — and returns the container's fake attachment. */
async function startTurnAndAccept(
  host: Host,
  containerIo: ReturnType<typeof createFakeContainerIoClient>,
  cmd: Extract<KernelToAgentHostFrame, { type: 'startTurn' }>,
  containerId = 'c1',
): Promise<FakeAttachment | undefined> {
  await host.handleStartTurn(cmd);
  const attachment = containerIo.attachmentsByContainerId.get(containerId);
  emitSwitchOk(attachment, cmd.turnId);
  attachment?.emitLine({ type: 'response', command: 'prompt', id: cmd.turnId, success: true });
  return attachment;
}

describe('createHost — handleStartTurn happy path', () => {
  it("spawns, attaches, switches to this chat's pi session, then writes the prompt and waits for pi's own acceptance before sendTurnAccepted", async () => {
    const { host, supervisor, containerIo, kernelLink } = setUp();
    const cmd = startTurnCommand();

    await host.handleStartTurn(cmd);

    expect(supervisor.spawnCalls).toEqual([
      {
        workspaceId: cmd.workspaceId,
        principalId: cmd.principalId,
        handle: cmd.handle,
        kernelUrl: 'http://kernel:8080',
        llmUrl: cmd.kernelLlmUrl,
      },
    ]);
    expect(supervisor.touchCalls).toEqual([cmd.principalId]);
    expect(containerIo.attachCalls).toEqual(['c1']);

    // The session switch comes first and alone — the prompt waits for pi's answer to it.
    const attachment = containerIo.attachmentsByContainerId.get('c1');
    expect(attachment?.written).toEqual([switchCommand(cmd)]);

    emitSwitchOk(attachment, cmd.turnId);
    expect(attachment?.written).toEqual([switchCommand(cmd), promptCommand(cmd)]);
    expect(kernelLink.accepted).toEqual([]); // not yet — pi hasn't confirmed the prompt

    attachment?.emitLine({ type: 'response', command: 'prompt', id: cmd.turnId, success: true });
    expect(kernelLink.accepted).toEqual([cmd.turnId]);
  });

  it('forwards systemPrompt/model from the startTurn command to supervisorClient.spawn (S2.6)', async () => {
    const { host, supervisor } = setUp();
    const cmd = startTurnCommand({
      systemPrompt: 'you are the entry agent',
      model: 'example-provider/example-model',
    });

    await host.handleStartTurn(cmd);

    expect(supervisor.spawnCalls).toEqual([
      {
        workspaceId: cmd.workspaceId,
        principalId: cmd.principalId,
        handle: cmd.handle,
        kernelUrl: 'http://kernel:8080',
        llmUrl: cmd.kernelLlmUrl,
        systemPrompt: 'you are the entry agent',
        model: 'example-provider/example-model',
      },
    ]);
  });

  it('forwards egressDeny from the startTurn command to supervisorClient.spawn (feat/egress-definition-lists)', async () => {
    const { host, supervisor } = setUp();
    const cmd = startTurnCommand({ egressDeny: ['blocked.example.com'] });

    await host.handleStartTurn(cmd);

    expect(supervisor.spawnCalls).toEqual([
      {
        workspaceId: cmd.workspaceId,
        principalId: cmd.principalId,
        handle: cmd.handle,
        kernelUrl: 'http://kernel:8080',
        llmUrl: cmd.kernelLlmUrl,
        egressDeny: ['blocked.example.com'],
      },
    ]);
  });

  it('forwards skillsInline from the startTurn command to supervisorClient.spawn (S3.13)', async () => {
    const { host, supervisor } = setUp();
    const skillsInline = [{ name: 'writing-tips', files: { 'SKILL.md': '# writing tips' } }];
    const cmd = startTurnCommand({ skillsInline });

    await host.handleStartTurn(cmd);

    expect(supervisor.spawnCalls).toEqual([
      {
        workspaceId: cmd.workspaceId,
        principalId: cmd.principalId,
        handle: cmd.handle,
        kernelUrl: 'http://kernel:8080',
        llmUrl: cmd.kernelLlmUrl,
        skillsInline,
      },
    ]);
  });

  it('forwards image from the startTurn command to supervisorClient.spawn (S7-E 决定 E1)', async () => {
    const { host, supervisor } = setUp();
    const cmd = startTurnCommand({ image: 'nexttime-ai-worker-runtime:v2' });

    await host.handleStartTurn(cmd);

    expect(supervisor.spawnCalls).toEqual([
      {
        workspaceId: cmd.workspaceId,
        principalId: cmd.principalId,
        handle: cmd.handle,
        kernelUrl: 'http://kernel:8080',
        llmUrl: cmd.kernelLlmUrl,
        image: 'nexttime-ai-worker-runtime:v2',
      },
    ]);
  });

  it('rejects a second concurrent turn for the same principal without spawning again', async () => {
    const { host, supervisor, kernelLink } = setUp();
    const first = startTurnCommand();
    await host.handleStartTurn(first);

    const second = startTurnCommand({
      principalId: first.principalId,
      workspaceId: first.workspaceId,
    });
    await host.handleStartTurn(second);

    expect(supervisor.spawnCalls).toHaveLength(1); // only the first turn ever spawned
    expect(kernelLink.rejected).toEqual([
      {
        turnId: second.turnId,
        reason: 'entry container is already processing another turn for this principal',
      },
    ]);
  });

  it('rejects a second turn for the same principal fired before the first has resolved, without a duplicate spawn/attach (P2-6 race)', async () => {
    // Unlike the "rejects a second concurrent turn" test above (which awaits the first call fully
    // before issuing the second), this fires both handleStartTurn calls back to back with neither
    // awaited — the exact interleaving the pre-fix code got wrong: the pre-fix `activeTurns.set()`
    // ran only after `await ensureAttachment(...)` resolved, so a second startTurn arriving in that
    // gap would also pass the `activeTurns.has()` check, also spawn/attach, and whichever
    // `activeTurns.set()` ran last would silently clobber the other Turn's entry (the earlier
    // Turn's id then never matches an incoming event again and it never ends). Reserving the slot
    // synchronously before the first `await` closes the gap entirely.
    const { host, supervisor, containerIo, kernelLink } = setUp();
    const first = startTurnCommand();
    const second = startTurnCommand({
      principalId: first.principalId,
      workspaceId: first.workspaceId,
    });

    const firstPromise = host.handleStartTurn(first);
    const secondPromise = host.handleStartTurn(second); // fired before firstPromise's first await
    await Promise.all([firstPromise, secondPromise]);

    expect(supervisor.spawnCalls).toHaveLength(1); // second never reached spawn
    expect(containerIo.attachCalls).toEqual(['c1']); // exactly one attach, not two
    expect(kernelLink.rejected).toEqual([
      {
        turnId: second.turnId,
        reason: 'entry container is already processing another turn for this principal',
      },
    ]);

    // The first Turn's switch+prompt were written and it can still be correlated with pi's own
    // responses — proof the second call's set() never clobbered the first's activeTurns entry.
    const attachment = containerIo.attachmentsByContainerId.get('c1');
    expect(attachment?.written).toEqual([switchCommand(first)]);
    emitSwitchOk(attachment, first.turnId);
    expect(attachment?.written).toEqual([switchCommand(first), promptCommand(first)]);
    attachment?.emitLine({ type: 'response', command: 'prompt', id: first.turnId, success: true });
    expect(kernelLink.accepted).toEqual([first.turnId]);
  });

  it('rejects the turn when spawn fails, without attaching', async () => {
    const { host, supervisor, containerIo, kernelLink } = setUp();
    supervisor.setSpawnError(new Error('worker-supervisor unreachable'));
    const cmd = startTurnCommand();

    await host.handleStartTurn(cmd);

    expect(containerIo.attachCalls).toEqual([]);
    expect(kernelLink.rejected).toHaveLength(1);
    expect(kernelLink.rejected[0]?.turnId).toBe(cmd.turnId);
    expect(kernelLink.rejected[0]?.reason).toContain('worker-supervisor unreachable');
  });

  it('releases the reservation on spawn failure — a subsequent turn for the same principal is not permanently blocked', async () => {
    const { host, supervisor, kernelLink } = setUp();
    supervisor.setSpawnError(new Error('worker-supervisor unreachable'));
    const failed = startTurnCommand();
    await host.handleStartTurn(failed);
    expect(kernelLink.rejected[0]?.reason).toContain('worker-supervisor unreachable');

    supervisor.setSpawnError(undefined);
    const retry = startTurnCommand({
      principalId: failed.principalId,
      workspaceId: failed.workspaceId,
    });
    await host.handleStartTurn(retry);

    // Not rejected as "already processing another turn" — the failed attempt's reservation was
    // released, not left dangling.
    expect(kernelLink.rejected).toHaveLength(1); // still just the one, from the failed attempt
    expect(supervisor.spawnCalls).toHaveLength(2);
  });

  it('rejects the turn when attach fails', async () => {
    const { host, containerIo, kernelLink } = setUp();
    containerIo.setAttachError(new Error('docker attach failed'));
    const cmd = startTurnCommand();

    await host.handleStartTurn(cmd);

    expect(kernelLink.rejected).toHaveLength(1);
    expect(kernelLink.rejected[0]?.reason).toContain('docker attach failed');
  });

  it('does not let a touch failure block the turn (best-effort)', async () => {
    const { host, supervisor, containerIo } = setUp();
    supervisor.setTouchError(new Error('touch failed'));
    const cmd = startTurnCommand();

    await host.handleStartTurn(cmd);
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the fire-and-forget touch() settle

    const attachment = containerIo.attachmentsByContainerId.get('c1');
    emitSwitchOk(attachment, cmd.turnId);
    expect(attachment?.written).toEqual([switchCommand(cmd), promptCommand(cmd)]);
  });
});

describe('createHost — pi prompt response correlation', () => {
  it('turns a success:false response into turnRejected and clears the active turn', async () => {
    const { host, containerIo, kernelLink } = setUp();
    const cmd = startTurnCommand();
    await host.handleStartTurn(cmd);
    const attachment = containerIo.attachmentsByContainerId.get('c1');
    emitSwitchOk(attachment, cmd.turnId);

    attachment?.emitLine({
      type: 'response',
      command: 'prompt',
      id: cmd.turnId,
      success: false,
      error: 'agent is already streaming',
    });

    expect(kernelLink.rejected).toEqual([
      { turnId: cmd.turnId, reason: 'agent is already streaming' },
    ]);
    expect(kernelLink.accepted).toEqual([]);

    // The turn is no longer tracked — a subsequent stopTurn for it is a no-op.
    host.handleStopTurn({ type: 'stopTurn', turnId: cmd.turnId, principalId: cmd.principalId });
    expect(attachment?.written).toEqual([switchCommand(cmd), promptCommand(cmd)]);
  });
});

describe('createHost — translated pi events reach the kernel with correlation fields attached', () => {
  it('forwards textDelta, tool call events, and a persisted assistant message', async () => {
    const { host, containerIo, kernelLink } = setUp();
    const cmd = startTurnCommand();
    const attachment = await startTurnAndAccept(host, containerIo, cmd);

    const base = {
      workspaceId: cmd.workspaceId,
      chatId: cmd.chatId,
      turnId: cmd.turnId,
      principalId: cmd.principalId,
    };

    attachment?.emitLine({
      type: 'message_update',
      usage: {},
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hi' },
    });
    attachment?.emitLine({
      type: 'tool_execution_start',
      toolCallId: 'call_1',
      toolName: 'search',
      args: { query: 'x' },
    });
    attachment?.emitLine({
      type: 'tool_execution_end',
      toolCallId: 'call_1',
      result: { ok: true },
    });
    attachment?.emitLine({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
    });

    expect(kernelLink.runtimeEvents).toEqual([
      { type: 'textDelta', delta: 'Hi', ...base },
      {
        type: 'toolCallStarted',
        toolCallId: 'call_1',
        name: 'search',
        args: { query: 'x' },
        ...base,
      },
      { type: 'toolCallEnded', toolCallId: 'call_1', result: { ok: true }, ...base },
      { type: 'message', role: 'assistant', content: { text: 'Done' }, ...base },
    ]);
  });

  it('ends the turn as completed on agent_settled when no stop was requested', async () => {
    const { host, containerIo, kernelLink } = setUp();
    const cmd = startTurnCommand();
    const attachment = await startTurnAndAccept(host, containerIo, cmd);

    attachment?.emitLine({ type: 'agent_settled' });

    expect(kernelLink.runtimeEvents).toEqual([
      {
        type: 'turnEnded',
        status: 'completed',
        workspaceId: cmd.workspaceId,
        chatId: cmd.chatId,
        turnId: cmd.turnId,
        principalId: cmd.principalId,
      },
    ]);

    // A second startTurn for the same principal is accepted again — the turn was cleared.
    const nextTurn = startTurnCommand({
      principalId: cmd.principalId,
      workspaceId: cmd.workspaceId,
    });
    await host.handleStartTurn(nextTurn);
    expect(kernelLink.rejected).toEqual([]);
  });

  it('drops an event with no tracked active turn to correlate it to', async () => {
    const { containerIo, kernelLink } = setUp();
    // No handleStartTurn ever called — attach a container directly to simulate a stray line.
    const io = await containerIo.client.attach('orphan-container');
    let captured: ((line: string) => void) | undefined;
    io.onLine((line) => {
      captured = captured ?? (() => {});
      void line;
    });
    const attachment = containerIo.attachmentsByContainerId.get('orphan-container');
    attachment?.emitLine({
      type: 'message_update',
      usage: {},
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hi' },
    });
    expect(kernelLink.runtimeEvents).toEqual([]);
  });
});

describe('createHost — stopTurn', () => {
  it('writes an abort command and the eventual agent_settled is reported interrupted', async () => {
    const { host, containerIo, kernelLink } = setUp();
    const cmd = startTurnCommand();
    const attachment = await startTurnAndAccept(host, containerIo, cmd);

    host.handleStopTurn({ type: 'stopTurn', turnId: cmd.turnId, principalId: cmd.principalId });
    expect(attachment?.written).toEqual([
      switchCommand(cmd),
      promptCommand(cmd),
      { type: 'abort' },
    ]);

    attachment?.emitLine({ type: 'agent_settled' });
    expect(kernelLink.runtimeEvents).toContainEqual({
      type: 'turnEnded',
      status: 'interrupted',
      workspaceId: cmd.workspaceId,
      chatId: cmd.chatId,
      turnId: cmd.turnId,
      principalId: cmd.principalId,
    });
  });

  it('is a no-op for an unknown or already-ended turnId', async () => {
    const { host, containerIo } = setUp();
    const cmd = startTurnCommand();
    const attachment = await startTurnAndAccept(host, containerIo, cmd);

    host.handleStopTurn({ type: 'stopTurn', turnId: randomUUID(), principalId: cmd.principalId });
    expect(attachment?.written).toEqual([switchCommand(cmd), promptCommand(cmd)]);
  });

  it('does not write the prompt when a stopTurn for it arrives while ensureAttachment is still in flight, on the direct-write path (leftover 56)', async () => {
    // The direct-write path is only reachable when `record.currentChatId` already matches the
    // incoming chat — i.e. a second turn in the same chat, on the same still-attached container.
    // See host.ts's own comment on this branch: unlike `handleSwitchSessionResponse` (exercised by
    // the "stopTurn overtakes the pending switch" test above), this path used to write the prompt
    // to pi regardless of `turn.stopRequested`.
    const { host, supervisor, containerIo, kernelLink } = setUp();
    const first = startTurnCommand();
    const attachment = await startTurnAndAccept(host, containerIo, first);
    attachment?.emitLine({ type: 'agent_settled' }); // frees the principal for a second turn

    const second = startTurnCommand({
      principalId: first.principalId,
      workspaceId: first.workspaceId,
      chatId: first.chatId, // same chat as before — record.currentChatId already matches
    });
    supervisor.setSpawnInterceptor(() => {
      // A stopTurn frame for `second` reaches agent-host while its own ensureAttachment (spawn)
      // is still awaiting — the exact window leftover 56 describes. `handleStopTurn` finds no
      // `pendingSwitchId` yet (this turn hasn't reached the switch/direct-write decision at all)
      // and falls through to its own abort write, to whatever is currently attached (`c1`, the
      // first turn's now-idle attachment).
      host.handleStopTurn({
        type: 'stopTurn',
        turnId: second.turnId,
        principalId: second.principalId,
      });
    });

    await host.handleStartTurn(second);

    // The prompt for `second` must never reach pi — before the fix this branch ignored
    // `stopRequested` and wrote it anyway, swallowing the stop.
    expect(attachment?.written).toEqual([
      switchCommand(first),
      promptCommand(first),
      { type: 'abort' }, // handleStopTurn's own write during the in-flight spawn
    ]);
    expect(kernelLink.rejected).toEqual([
      { turnId: second.turnId, reason: 'turn stopped before the prompt was sent' },
    ]);
    expect(kernelLink.accepted).toEqual([first.turnId]); // never accepted for `second`

    // The reservation was released — a following turn for the same principal is not blocked as
    // "already processing".
    supervisor.setSpawnInterceptor(undefined);
    const third = startTurnCommand({
      principalId: first.principalId,
      workspaceId: first.workspaceId,
      chatId: first.chatId,
    });
    await host.handleStartTurn(third);
    expect(kernelLink.rejected).toHaveLength(1); // still just `second`'s own rejection
    expect(attachment?.written).toEqual([
      switchCommand(first),
      promptCommand(first),
      { type: 'abort' },
      promptCommand(third),
    ]);
  });
});

describe('createHost — mid-turn idle-clock refresh (leftover 46)', () => {
  it("refreshes the supervisor's idle clock as pi keeps emitting activity for a Turn long past the idle timeout, throttled so it is not a touch per line", async () => {
    let clock = 0;
    const { host, supervisor, containerIo } = setUp({ now: () => clock });
    const cmd = startTurnCommand();

    await host.handleStartTurn(cmd);
    expect(supervisor.touchCalls).toEqual([cmd.principalId]); // Turn-start touch only, so far

    const attachment = containerIo.attachmentsByContainerId.get('c1');

    // Activity soon after start, still inside the throttle window — no extra touch yet.
    clock += 1_000;
    emitSwitchOk(attachment, cmd.turnId);
    expect(supervisor.touchCalls).toEqual([cmd.principalId]);

    // The Turn keeps running well past worker-supervisor's idle timeout (30 min default) — the
    // exposure leftover 46 describes — but pi is still emitting activity for it. Once the
    // throttle window (5 min) has elapsed since the last touch, the next line refreshes it.
    clock += 6 * 60 * 1000;
    attachment?.emitLine({
      type: 'message_update',
      usage: {},
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'still working' },
    });
    expect(supervisor.touchCalls).toEqual([cmd.principalId, cmd.principalId]);

    // A further burst of lines inside the new throttle window does not re-touch again.
    attachment?.emitLine({
      type: 'message_update',
      usage: {},
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'more' },
    });
    expect(supervisor.touchCalls).toHaveLength(2);
  });

  it('does not refresh the idle clock for a line once the Turn it belonged to has already ended (idle-stop stray output)', async () => {
    let clock = 0;
    const { host, supervisor, containerIo } = setUp({ now: () => clock });
    const cmd = startTurnCommand();
    await host.handleStartTurn(cmd);
    const attachment = containerIo.attachmentsByContainerId.get('c1');
    emitSwitchOk(attachment, cmd.turnId);
    attachment?.emitLine({ type: 'response', command: 'prompt', id: cmd.turnId, success: true });

    clock += 6 * 60 * 1000;
    attachment?.emitLine({ type: 'agent_settled' }); // ends the turn — activeTurns entry is cleared
    const touchCallsAfterSettle = supervisor.touchCalls.length;

    // A stray line after the turn already ended (e.g. during the container's idle-timeout stop) —
    // `handleLine`'s own `turn` lookup finds nothing to correlate it to, so no refresh either.
    attachment?.emitLine({
      type: 'message_update',
      usage: {},
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'after the turn ended' },
    });
    expect(supervisor.touchCalls).toHaveLength(touchCallsAfterSettle); // no tracked turn, no refresh
  });
});

describe('createHost — container stdio closing', () => {
  it('reports turnEnded interrupted when the container closes mid-turn, and re-attaches on the next turn', async () => {
    const { host, supervisor, containerIo, kernelLink } = setUp();
    const cmd = startTurnCommand();
    const attachment = await startTurnAndAccept(host, containerIo, cmd);

    attachment?.emitClose(new Error('container exited'));

    expect(kernelLink.runtimeEvents).toEqual([
      {
        type: 'turnEnded',
        status: 'interrupted',
        workspaceId: cmd.workspaceId,
        chatId: cmd.chatId,
        turnId: cmd.turnId,
        principalId: cmd.principalId,
      },
    ]);

    // Next turn: supervisor respawns under the same containerId in this fixture — re-attaches
    // regardless, since the cached attachment was dropped on close.
    const nextTurn = startTurnCommand({
      principalId: cmd.principalId,
      workspaceId: cmd.workspaceId,
      chatId: cmd.chatId, // same chat as the closed container's turn
    });
    await host.handleStartTurn(nextTurn);
    expect(containerIo.attachCalls).toEqual(['c1', 'c1']);
    expect(supervisor.spawnCalls).toHaveLength(2);

    // The pi process behind the new attachment is a fresh one whose loaded session is unknown, so
    // this chat is switched to again even though the previous turn was already on it.
    const reattached = containerIo.attachmentsByContainerId.get('c1');
    expect(reattached?.written).toEqual([switchCommand(nextTurn)]);
  });

  it('does not report anything when the container closes with no active turn (idle stop)', async () => {
    const { host, containerIo, kernelLink } = setUp();
    const cmd = startTurnCommand();
    const attachment = await startTurnAndAccept(host, containerIo, cmd);
    attachment?.emitLine({ type: 'agent_settled' }); // turn ends normally first

    attachment?.emitClose(undefined); // idle-timeout stop, well after the turn ended

    expect(kernelLink.runtimeEvents).toEqual([
      {
        type: 'turnEnded',
        status: 'completed',
        workspaceId: cmd.workspaceId,
        chatId: cmd.chatId,
        turnId: cmd.turnId,
        principalId: cmd.principalId,
      },
    ]);
  });

  it('re-attaches when supervisor spawn returns a different containerId (respawn)', async () => {
    const { host, containerIo, supervisor } = setUp();
    const cmd = startTurnCommand();
    await host.handleStartTurn(cmd);
    expect(containerIo.attachCalls).toEqual(['c1']);
    const firstAttachment = containerIo.attachmentsByContainerId.get('c1');
    expect(firstAttachment?.closed).toBe(false);
    // Settle the first turn — a second startTurn for the same principal while one is still
    // active is rejected outright (see the "rejects a second concurrent turn" test above), which
    // would otherwise mask what this test is actually checking.
    emitSwitchOk(firstAttachment, cmd.turnId);
    firstAttachment?.emitLine({
      type: 'response',
      command: 'prompt',
      id: cmd.turnId,
      success: true,
    });
    firstAttachment?.emitLine({ type: 'agent_settled' });

    supervisor.setSpawnResult({
      containerId: 'c2',
      ip: '100.64.0.3',
      status: 'running',
      created: true,
      restarts: 1,
    });
    const nextTurn = startTurnCommand({
      principalId: cmd.principalId,
      workspaceId: cmd.workspaceId,
      chatId: cmd.chatId, // same chat, new container
    });
    await host.handleStartTurn(nextTurn);

    expect(containerIo.attachCalls).toEqual(['c1', 'c2']);
    expect(firstAttachment?.closed).toBe(true); // the stale attachment was dropped

    // A new containerId is a new pi process: which chat's session it has loaded is unknown again,
    // so the same chat is switched to once more rather than assumed still current.
    const secondAttachment = containerIo.attachmentsByContainerId.get('c2');
    expect(secondAttachment?.written).toEqual([switchCommand(nextTurn)]);
  });
});

describe('createHost — touch-throttle cache pruning (leftover 66)', () => {
  it('prunes the lastTouchAt entry once the container that earned it closes (idle stop) — otherwise it never shrinks for the life of this process', async () => {
    const lastTouchAtMap = new Map<string, number>();
    const { host, containerIo } = setUp({ lastTouchAtMap });
    const cmd = startTurnCommand();
    const attachment = await startTurnAndAccept(host, containerIo, cmd);
    attachment?.emitLine({ type: 'agent_settled' }); // turn ends normally first

    expect(lastTouchAtMap.has(cmd.principalId)).toBe(true); // set by ensureAttachment's own touch

    attachment?.emitClose(undefined); // idle-timeout stop, well after the turn ended

    expect(lastTouchAtMap.has(cmd.principalId)).toBe(false);
  });

  it('does not prune the entry when the closing stream belonged to a container already replaced by a fresh attachment', async () => {
    const lastTouchAtMap = new Map<string, number>();
    const { host, containerIo, supervisor } = setUp({ lastTouchAtMap });
    const cmd = startTurnCommand();
    await host.handleStartTurn(cmd);
    const firstAttachment = containerIo.attachmentsByContainerId.get('c1');
    emitSwitchOk(firstAttachment, cmd.turnId);
    firstAttachment?.emitLine({
      type: 'response',
      command: 'prompt',
      id: cmd.turnId,
      success: true,
    });
    firstAttachment?.emitLine({ type: 'agent_settled' });

    supervisor.setSpawnResult({
      containerId: 'c2',
      ip: '100.64.0.3',
      status: 'running',
      created: true,
      restarts: 1,
    });
    const nextTurn = startTurnCommand({
      principalId: cmd.principalId,
      workspaceId: cmd.workspaceId,
      chatId: cmd.chatId,
    });
    await host.handleStartTurn(nextTurn); // caches c2's attachment in place of c1's

    expect(lastTouchAtMap.has(cmd.principalId)).toBe(true); // refreshed by nextTurn's own touch

    // c1's own close event arrives late (its container actually finishing its stop) — must not
    // prune the entry the still-current c2 attachment (and this still-live principal) needs.
    firstAttachment?.emitClose(undefined);

    expect(lastTouchAtMap.has(cmd.principalId)).toBe(true);
  });
});

describe('createHost — resident container recreated inside a Turn’s own spawn (leftover 44)', () => {
  /** A completed first Turn on `c1`, so the principal has a cached attachment worker-supervisor
   *  can retire, and a second `startTurn` for the same chat whose spawn comes back with `c2`. */
  async function firstTurnOnC1(setup: ReturnType<typeof setUp>) {
    const first = startTurnCommand();
    const c1 = await startTurnAndAccept(setup.host, setup.containerIo, first);
    c1?.emitLine({ type: 'agent_settled' });
    expect(setup.kernelLink.runtimeEvents.map((event) => event.type)).toEqual(['turnEnded']);
    setup.supervisor.setSpawnResult({
      containerId: 'c2',
      ip: '100.64.0.3',
      status: 'running',
      created: true,
      restarts: 1,
    });
    const second = startTurnCommand({
      principalId: first.principalId,
      workspaceId: first.workspaceId,
      chatId: first.chatId,
      handle: 'rotated-jwt', // a gate was connected in between: the kernel reissued the Handle
    });
    return { first, second, c1 };
  }

  it("does not report the new Turn interrupted when the previous container's stream closes while its spawn is still in flight, and delivers it to the new container", async () => {
    const setup = setUp();
    const { host, supervisor, containerIo, kernelLink } = setup;
    const { first, second, c1 } = await firstTurnOnC1(setup);

    // worker-supervisor's resident-service.ts: the incoming Handle's jti no longer matches the
    // running container's label → `docker stop` the old one → create a new one → only then
    // answer /resident/spawn. From here that is: c1's attach stream ends *during* the spawn call.
    supervisor.setSpawnInterceptor(() => {
      c1?.emitClose(undefined);
    });
    await host.handleStartTurn(second);

    // The close belonged to a container this Turn was never handed to — nothing was reported.
    expect(kernelLink.runtimeEvents).toHaveLength(1);
    expect(kernelLink.rejected).toEqual([]);
    expect(containerIo.attachCalls).toEqual(['c1', 'c2']);

    // The Turn went to the new container: session switch, prompt, acceptance, completion all on c2.
    const c2 = containerIo.attachmentsByContainerId.get('c2');
    expect(c2?.written).toEqual([switchCommand(second)]);
    emitSwitchOk(c2, second.turnId);
    expect(c2?.written).toEqual([switchCommand(second), promptCommand(second)]);
    c2?.emitLine({ type: 'response', command: 'prompt', id: second.turnId, success: true });
    expect(kernelLink.accepted).toEqual([first.turnId, second.turnId]);
    c2?.emitLine({ type: 'agent_settled' });
    expect(kernelLink.runtimeEvents.at(-1)).toEqual({
      type: 'turnEnded',
      status: 'completed',
      workspaceId: second.workspaceId,
      chatId: second.chatId,
      turnId: second.turnId,
      principalId: second.principalId,
    });
  });

  it('ignores stdout the retiring container still emits during the spawn (a stray agent_settled must not complete the unbound Turn)', async () => {
    const setup = setUp();
    const { host, supervisor, containerIo, kernelLink } = setup;
    const { second, c1 } = await firstTurnOnC1(setup);

    supervisor.setSpawnInterceptor(() => {
      c1?.emitLine({ type: 'agent_settled' }); // the old pi process winding down under SIGTERM
      c1?.emitLine({ type: 'response', command: 'switch_session', success: false, error: 'x' });
      c1?.emitClose(new Error('container exited'));
    });
    await host.handleStartTurn(second);

    expect(kernelLink.runtimeEvents).toHaveLength(1); // still only the first Turn's completion
    expect(kernelLink.rejected).toEqual([]);
    const c2 = containerIo.attachmentsByContainerId.get('c2');
    expect(c2?.written).toEqual([switchCommand(second)]);
    emitSwitchOk(c2, second.turnId);
    expect(c2?.written).toEqual([switchCommand(second), promptCommand(second)]);
  });

  it('still reports interrupted when the container the Turn is actually bound to closes (the bound-container path is unchanged)', async () => {
    const setup = setUp();
    const { host, containerIo, kernelLink } = setup;
    const { second } = await firstTurnOnC1(setup);
    await host.handleStartTurn(second);
    const c2 = containerIo.attachmentsByContainerId.get('c2');
    emitSwitchOk(c2, second.turnId);
    c2?.emitLine({ type: 'response', command: 'prompt', id: second.turnId, success: true });

    c2?.emitClose(new Error('container exited'));

    expect(kernelLink.runtimeEvents.at(-1)).toMatchObject({
      type: 'turnEnded',
      status: 'interrupted',
      turnId: second.turnId,
    });
    // ...and the next Turn re-spawns/re-attaches rather than reusing the dead attachment.
    const third = startTurnCommand({
      principalId: second.principalId,
      workspaceId: second.workspaceId,
      chatId: second.chatId,
    });
    await host.handleStartTurn(third);
    expect(containerIo.attachCalls).toEqual(['c1', 'c2', 'c2']);
  });
});

describe('createHost — extension_error', () => {
  it('does not translate extension_error into a runtimeEvent, and does not throw', async () => {
    const { host, containerIo, kernelLink } = setUp();
    const cmd = startTurnCommand();
    const attachment = await startTurnAndAccept(host, containerIo, cmd);

    expect(() =>
      attachment?.emitLine({
        type: 'extension_error',
        extensionPath: '/workspace/.pi/agent/extensions/x.ts',
        event: 'tool_call',
        error: 'boom',
      }),
    ).not.toThrow();
    expect(kernelLink.runtimeEvents).toEqual([]);
  });
});

describe('createHost — one pi session per chat (leftover 33)', () => {
  it('writes no switch_session for a second turn in the same chat on the same container', async () => {
    const { host, containerIo } = setUp();
    const first = startTurnCommand();
    const attachment = await startTurnAndAccept(host, containerIo, first);
    attachment?.emitLine({ type: 'agent_settled' });

    const second = startTurnCommand({
      principalId: first.principalId,
      workspaceId: first.workspaceId,
      chatId: first.chatId,
      prompt: 'and one more thing',
    });
    await host.handleStartTurn(second);

    // Straight to the prompt — this pi process is already on that chat's session file.
    expect(attachment?.written).toEqual([
      switchCommand(first),
      promptCommand(first),
      promptCommand(second),
    ]);
  });

  it("switches to the other chat's session file when the same user's second chat takes a turn", async () => {
    const { host, containerIo } = setUp();
    const first = startTurnCommand();
    const attachment = await startTurnAndAccept(host, containerIo, first);
    attachment?.emitLine({ type: 'agent_settled' });

    const other = startTurnCommand({
      principalId: first.principalId,
      workspaceId: first.workspaceId,
      prompt: 'a conversation that must not see the first one',
    });
    expect(other.chatId).not.toBe(first.chatId);
    await host.handleStartTurn(other);

    expect(attachment?.written).toEqual([
      switchCommand(first),
      promptCommand(first),
      switchCommand(other),
    ]);

    emitSwitchOk(attachment, other.turnId);
    expect(attachment?.written).toEqual([
      switchCommand(first),
      promptCommand(first),
      switchCommand(other),
      promptCommand(other),
    ]);
  });

  it('rejects the turn when pi fails the switch, and releases the active slot', async () => {
    const { host, containerIo, kernelLink } = setUp();
    const cmd = startTurnCommand();
    await host.handleStartTurn(cmd);
    const attachment = containerIo.attachmentsByContainerId.get('c1');

    attachment?.emitLine({
      type: 'response',
      command: 'switch_session',
      id: `switch:${cmd.turnId}`,
      success: false,
      error: 'failed to load session file',
    });

    expect(kernelLink.rejected).toEqual([
      { turnId: cmd.turnId, reason: 'failed to load session file' },
    ]);
    expect(kernelLink.accepted).toEqual([]);
    expect(attachment?.written).toEqual([switchCommand(cmd)]); // no prompt was ever sent

    // The slot was released — a following turn is not rejected as "already processing".
    const retry = startTurnCommand({
      principalId: cmd.principalId,
      workspaceId: cmd.workspaceId,
      chatId: cmd.chatId,
    });
    await host.handleStartTurn(retry);
    expect(kernelLink.rejected).toHaveLength(1); // still just the failed switch's own rejection
    expect(attachment?.written).toEqual([switchCommand(cmd), switchCommand(retry)]);
  });

  it('rejects the turn when an extension cancels the switch', async () => {
    const { host, containerIo, kernelLink } = setUp();
    const cmd = startTurnCommand();
    await host.handleStartTurn(cmd);
    const attachment = containerIo.attachmentsByContainerId.get('c1');

    attachment?.emitLine({
      type: 'response',
      command: 'switch_session',
      id: `switch:${cmd.turnId}`,
      success: true,
      data: { cancelled: true },
    });

    expect(kernelLink.rejected).toEqual([
      { turnId: cmd.turnId, reason: 'pi cancelled the session switch' },
    ]);
    expect(attachment?.written).toEqual([switchCommand(cmd)]);
  });

  it('rejects the turn and writes neither prompt nor abort when a stopTurn overtakes the pending switch', async () => {
    const { host, containerIo, kernelLink } = setUp();
    const cmd = startTurnCommand();
    await host.handleStartTurn(cmd);
    const attachment = containerIo.attachmentsByContainerId.get('c1');

    host.handleStopTurn({ type: 'stopTurn', turnId: cmd.turnId, principalId: cmd.principalId });
    expect(attachment?.written).toEqual([switchCommand(cmd)]); // no abort — pi has no prompt yet

    emitSwitchOk(attachment, cmd.turnId);
    expect(attachment?.written).toEqual([switchCommand(cmd)]); // and no prompt either
    expect(kernelLink.rejected).toEqual([
      { turnId: cmd.turnId, reason: 'turn stopped before the session switch completed' },
    ]);
    expect(kernelLink.accepted).toEqual([]);
    expect(kernelLink.runtimeEvents).toEqual([]); // never accepted, so turnRejected, not turnEnded
  });

  it('rejects a chatId that could escape the session directory, without writing anything', async () => {
    const { host, containerIo, kernelLink } = setUp();
    const cmd = startTurnCommand({ chatId: '../../etc/pi/sessions/someone-else' });

    await host.handleStartTurn(cmd);

    const attachment = containerIo.attachmentsByContainerId.get('c1');
    expect(attachment?.written).toEqual([]);
    expect(kernelLink.rejected).toHaveLength(1);
    expect(kernelLink.rejected[0]?.turnId).toBe(cmd.turnId);

    // The reservation was released too — a well-formed chatId still gets its turn.
    const next = startTurnCommand({
      principalId: cmd.principalId,
      workspaceId: cmd.workspaceId,
    });
    await host.handleStartTurn(next);
    expect(kernelLink.rejected).toHaveLength(1);
    expect(attachment?.written).toEqual([switchCommand(next)]);
  });

  it('ignores a switch_session response that does not match the pending switch', async () => {
    const { host, containerIo, kernelLink } = setUp();
    const cmd = startTurnCommand();
    await host.handleStartTurn(cmd);
    const attachment = containerIo.attachmentsByContainerId.get('c1');

    attachment?.emitLine({
      type: 'response',
      command: 'switch_session',
      id: 'switch:some-other-turn',
      success: false,
      error: 'not this turn',
    });
    expect(kernelLink.rejected).toEqual([]);
    expect(attachment?.written).toEqual([switchCommand(cmd)]);

    // The turn is still waiting for its own answer.
    emitSwitchOk(attachment, cmd.turnId);
    expect(attachment?.written).toEqual([switchCommand(cmd), promptCommand(cmd)]);
  });
});
