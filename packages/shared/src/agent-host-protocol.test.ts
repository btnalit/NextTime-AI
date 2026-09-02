import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AgentHostHelloFrameSchema,
  AgentHostToKernelFrameSchema,
  AgentRuntimeEventWireSchema,
  KernelStartTurnCommandSchema,
  KernelStopTurnCommandSchema,
  KernelToAgentHostFrameSchema,
} from './agent-host-protocol.js';

/** agent-host-protocol.test: pure schema tests, no I/O — mirrors handle-token.test.ts's own
 *  "unit, no filesystem/DB" style for a shared wire primitive. */

function correlation() {
  return {
    workspaceId: randomUUID(),
    chatId: randomUUID(),
    turnId: randomUUID(),
    principalId: randomUUID(),
  };
}

describe('AgentRuntimeEventWireSchema', () => {
  it('accepts every variant with exactly its own fields plus the four correlation fields', () => {
    const variants: unknown[] = [
      { type: 'textDelta', delta: 'hi', ...correlation() },
      { type: 'toolCallStarted', toolCallId: 'call_1', name: 'search', ...correlation() },
      {
        type: 'toolCallStarted',
        toolCallId: 'call_1',
        name: 'search',
        args: { query: 'x' },
        ...correlation(),
      },
      { type: 'toolCallEnded', toolCallId: 'call_1', ...correlation() },
      { type: 'toolCallEnded', toolCallId: 'call_1', result: { ok: true }, ...correlation() },
      { type: 'message', role: 'assistant', content: { text: 'hi' }, ...correlation() },
      { type: 'message', role: 'tool', content: { text: 'result' }, ...correlation() },
      { type: 'turnEnded', status: 'completed', ...correlation() },
      { type: 'turnEnded', status: 'interrupted', ...correlation() },
      { type: 'turnEnded', status: 'failed', ...correlation() },
    ];

    for (const variant of variants) {
      expect(AgentRuntimeEventWireSchema.safeParse(variant).success).toBe(true);
    }
  });

  it('rejects an unknown discriminant, a missing correlation field, and an unknown status', () => {
    expect(
      AgentRuntimeEventWireSchema.safeParse({ type: 'notAThing', ...correlation() }).success,
    ).toBe(false);
    expect(
      AgentRuntimeEventWireSchema.safeParse({
        type: 'textDelta',
        delta: 'hi',
        chatId: randomUUID(),
        turnId: randomUUID(),
        principalId: randomUUID(),
        // workspaceId missing
      }).success,
    ).toBe(false);
    expect(
      AgentRuntimeEventWireSchema.safeParse({
        type: 'turnEnded',
        status: 'succeeded', // not one of completed/interrupted/failed
        ...correlation(),
      }).success,
    ).toBe(false);
  });

  it('rejects an extra unknown field (strict object)', () => {
    expect(
      AgentRuntimeEventWireSchema.safeParse({
        type: 'textDelta',
        delta: 'hi',
        ...correlation(),
        extra: 'nope',
      }).success,
    ).toBe(false);
  });
});

describe('AgentHostToKernelFrameSchema', () => {
  it('accepts hello, turnAccepted, turnRejected, and runtimeEvent frames', () => {
    expect(
      AgentHostToKernelFrameSchema.safeParse({ type: 'hello', instanceId: randomUUID() }).success,
    ).toBe(true);
    expect(
      AgentHostToKernelFrameSchema.safeParse({ type: 'turnAccepted', turnId: randomUUID() })
        .success,
    ).toBe(true);
    expect(
      AgentHostToKernelFrameSchema.safeParse({
        type: 'turnRejected',
        turnId: randomUUID(),
        reason: 'container failed to spawn',
      }).success,
    ).toBe(true);
    expect(
      AgentHostToKernelFrameSchema.safeParse({
        type: 'runtimeEvent',
        event: { type: 'textDelta', delta: 'hi', ...correlation() },
      }).success,
    ).toBe(true);
  });

  it('rejects a kernel->agent-host frame sent on the wrong channel', () => {
    const startTurn = {
      type: 'startTurn',
      ...correlation(),
      prompt: 'hello',
      handle: 'jwt-token',
      kernelLlmUrl: 'http://llm-proxy:8082',
    };
    expect(AgentHostToKernelFrameSchema.safeParse(startTurn).success).toBe(false);
    expect(KernelToAgentHostFrameSchema.safeParse(startTurn).success).toBe(true);
  });

  it('AgentHostHelloFrameSchema requires a non-empty instanceId', () => {
    expect(AgentHostHelloFrameSchema.safeParse({ type: 'hello' }).success).toBe(false);
  });
});

describe('KernelToAgentHostFrameSchema', () => {
  it('accepts startTurn and stopTurn commands', () => {
    const startTurn = {
      type: 'startTurn',
      ...correlation(),
      prompt: '<!--nexttime:turn_id=abc-->\nhello',
      handle: 'jwt-token',
      kernelLlmUrl: 'http://llm-proxy:8082',
    };
    expect(KernelStartTurnCommandSchema.safeParse(startTurn).success).toBe(true);
    expect(KernelToAgentHostFrameSchema.safeParse(startTurn).success).toBe(true);

    const stopTurn = { type: 'stopTurn', turnId: randomUUID(), principalId: randomUUID() };
    expect(KernelStopTurnCommandSchema.safeParse(stopTurn).success).toBe(true);
    expect(KernelToAgentHostFrameSchema.safeParse(stopTurn).success).toBe(true);
  });

  it('rejects an agent-host->kernel frame sent on the wrong channel', () => {
    expect(
      KernelToAgentHostFrameSchema.safeParse({ type: 'hello', instanceId: randomUUID() }).success,
    ).toBe(false);
  });
});
