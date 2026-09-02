import { randomUUID } from 'node:crypto';
import type { AgentRuntimeEventWire, KernelToAgentHostFrame } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import type { AttachedContainerIo, ContainerIoClient } from './container-io.js';
import { createHost } from './host.js';
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
    ip: '10.0.0.2',
    status: 'running',
    created: true,
    restarts: 0,
  };
  let spawnError: Error | undefined;
  let touchError: Error | undefined;

  const client: SupervisorClientPort = {
    async spawn(input: SpawnInput): Promise<SpawnResult> {
      spawnCalls.push(input);
      if (spawnError) throw spawnError;
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
  };
}

function setUp() {
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
  });
  return { host, supervisor, containerIo, kernelLink };
}

describe('createHost — handleStartTurn happy path', () => {
  it("spawns, attaches, writes the prompt command, and waits for pi's own acceptance before sendTurnAccepted", async () => {
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

    const attachment = containerIo.attachmentsByContainerId.get('c1');
    expect(attachment?.written).toEqual([{ type: 'prompt', id: cmd.turnId, message: cmd.prompt }]);
    expect(kernelLink.accepted).toEqual([]); // not yet — pi hasn't confirmed

    attachment?.emitLine({ type: 'response', command: 'prompt', id: cmd.turnId, success: true });
    expect(kernelLink.accepted).toEqual([cmd.turnId]);
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
    expect(attachment?.written).toEqual([{ type: 'prompt', id: cmd.turnId, message: cmd.prompt }]);
  });
});

describe('createHost — pi prompt response correlation', () => {
  it('turns a success:false response into turnRejected and clears the active turn', async () => {
    const { host, containerIo, kernelLink } = setUp();
    const cmd = startTurnCommand();
    await host.handleStartTurn(cmd);
    const attachment = containerIo.attachmentsByContainerId.get('c1');

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
    expect(attachment?.written).toEqual([{ type: 'prompt', id: cmd.turnId, message: cmd.prompt }]);
  });
});

describe('createHost — translated pi events reach the kernel with correlation fields attached', () => {
  it('forwards textDelta, tool call events, and a persisted assistant message', async () => {
    const { host, containerIo, kernelLink } = setUp();
    const cmd = startTurnCommand();
    await host.handleStartTurn(cmd);
    const attachment = containerIo.attachmentsByContainerId.get('c1');
    attachment?.emitLine({ type: 'response', command: 'prompt', id: cmd.turnId, success: true });

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
    await host.handleStartTurn(cmd);
    const attachment = containerIo.attachmentsByContainerId.get('c1');
    attachment?.emitLine({ type: 'response', command: 'prompt', id: cmd.turnId, success: true });

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
    await host.handleStartTurn(cmd);
    const attachment = containerIo.attachmentsByContainerId.get('c1');
    attachment?.emitLine({ type: 'response', command: 'prompt', id: cmd.turnId, success: true });

    host.handleStopTurn({ type: 'stopTurn', turnId: cmd.turnId, principalId: cmd.principalId });
    expect(attachment?.written).toEqual([
      { type: 'prompt', id: cmd.turnId, message: cmd.prompt },
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
    await host.handleStartTurn(cmd);
    const attachment = containerIo.attachmentsByContainerId.get('c1');

    host.handleStopTurn({ type: 'stopTurn', turnId: randomUUID(), principalId: cmd.principalId });
    expect(attachment?.written).toEqual([{ type: 'prompt', id: cmd.turnId, message: cmd.prompt }]);
  });
});

describe('createHost — container stdio closing', () => {
  it('reports turnEnded interrupted when the container closes mid-turn, and re-attaches on the next turn', async () => {
    const { host, supervisor, containerIo, kernelLink } = setUp();
    const cmd = startTurnCommand();
    await host.handleStartTurn(cmd);
    const attachment = containerIo.attachmentsByContainerId.get('c1');
    attachment?.emitLine({ type: 'response', command: 'prompt', id: cmd.turnId, success: true });

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
    });
    await host.handleStartTurn(nextTurn);
    expect(containerIo.attachCalls).toEqual(['c1', 'c1']);
    expect(supervisor.spawnCalls).toHaveLength(2);
  });

  it('does not report anything when the container closes with no active turn (idle stop)', async () => {
    const { host, containerIo, kernelLink } = setUp();
    const cmd = startTurnCommand();
    await host.handleStartTurn(cmd);
    const attachment = containerIo.attachmentsByContainerId.get('c1');
    attachment?.emitLine({ type: 'response', command: 'prompt', id: cmd.turnId, success: true });
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
    firstAttachment?.emitLine({
      type: 'response',
      command: 'prompt',
      id: cmd.turnId,
      success: true,
    });
    firstAttachment?.emitLine({ type: 'agent_settled' });

    supervisor.setSpawnResult({
      containerId: 'c2',
      ip: '10.0.0.3',
      status: 'running',
      created: true,
      restarts: 1,
    });
    const nextTurn = startTurnCommand({
      principalId: cmd.principalId,
      workspaceId: cmd.workspaceId,
    });
    await host.handleStartTurn(nextTurn);

    expect(containerIo.attachCalls).toEqual(['c1', 'c2']);
    expect(firstAttachment?.closed).toBe(true); // the stale attachment was dropped
  });
});

describe('createHost — extension_error', () => {
  it('does not translate extension_error into a runtimeEvent, and does not throw', async () => {
    const { host, containerIo, kernelLink } = setUp();
    const cmd = startTurnCommand();
    await host.handleStartTurn(cmd);
    const attachment = containerIo.attachmentsByContainerId.get('c1');
    attachment?.emitLine({ type: 'response', command: 'prompt', id: cmd.turnId, success: true });

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
