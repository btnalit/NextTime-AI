import { describe, expect, it } from 'vitest';
import { buildAbortCommand, buildPromptCommand, translatePiEvent } from './bridge.js';

/**
 * bridge.test: pi 0.84.4 RPC event fixtures (hand-written per `docs/rpc.md`'s own documented
 * shapes — see bridge.ts's module doc comment for the exact pi source paths this was verified
 * against) -> platform `AgentRuntimeEvent` translation. Pure, no I/O.
 */

describe('translatePiEvent — message_update', () => {
  it('translates a text_delta into textDelta', () => {
    const result = translatePiEvent({
      type: 'message_update',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} },
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hello' },
    });
    expect(result).toEqual({ kind: 'event', fields: { type: 'textDelta', delta: 'Hello' } });
  });

  it('ignores every other assistantMessageEvent sub-type', () => {
    for (const sub of [
      { type: 'text_start', contentIndex: 0 },
      { type: 'text_end', contentIndex: 0, content: 'Hello' },
      { type: 'thinking_delta', contentIndex: 0, delta: 'hmm' },
      { type: 'toolcall_start', contentIndex: 1, id: 'call_1', toolName: 'search' },
      { type: 'toolcall_delta', contentIndex: 1, delta: '{"q":' },
    ]) {
      const result = translatePiEvent({
        type: 'message_update',
        usage: {},
        assistantMessageEvent: sub,
      });
      expect(result).toEqual({ kind: 'none' });
    }
  });

  it('ignores an empty text_delta', () => {
    const result = translatePiEvent({
      type: 'message_update',
      usage: {},
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '' },
    });
    expect(result).toEqual({ kind: 'none' });
  });
});

describe('translatePiEvent — tool_execution_start / tool_execution_end', () => {
  it('translates tool_execution_start into toolCallStarted', () => {
    const result = translatePiEvent({
      type: 'tool_execution_start',
      toolCallId: 'call_abc123',
      toolName: 'bash',
      args: { command: 'ls -la' },
    });
    expect(result).toEqual({
      kind: 'event',
      fields: {
        type: 'toolCallStarted',
        toolCallId: 'call_abc123',
        name: 'bash',
        args: { command: 'ls -la' },
      },
    });
  });

  it('translates tool_execution_end into toolCallEnded', () => {
    const result = translatePiEvent({
      type: 'tool_execution_end',
      toolCallId: 'call_abc123',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'total 48' }] },
      isError: false,
    });
    expect(result).toEqual({
      kind: 'event',
      fields: {
        type: 'toolCallEnded',
        toolCallId: 'call_abc123',
        result: { content: [{ type: 'text', text: 'total 48' }] },
      },
    });
  });

  it('ignores tool_execution_update (streaming progress) and a missing toolCallId', () => {
    expect(
      translatePiEvent({
        type: 'tool_execution_update',
        toolCallId: 'call_abc123',
        toolName: 'bash',
        partialResult: {},
      }),
    ).toEqual({ kind: 'none' });
    expect(translatePiEvent({ type: 'tool_execution_start', toolName: 'bash' })).toEqual({
      kind: 'none',
    });
  });
});

describe('translatePiEvent — message_end', () => {
  it('translates an assistant message with text content into a persisted message event', () => {
    const result = translatePiEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Hello! ' },
          { type: 'toolCall', id: 'call_1', name: 'bash', arguments: {} },
          { type: 'text', text: 'How can I help?' },
        ],
      },
    });
    expect(result).toEqual({
      kind: 'event',
      fields: { type: 'message', role: 'assistant', content: { text: 'Hello! \nHow can I help?' } },
    });
  });

  it('ignores an assistant message with only tool-call content (no text)', () => {
    const result = translatePiEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call_1', name: 'bash', arguments: {} }],
      },
    });
    expect(result).toEqual({ kind: 'none' });
  });

  it('ignores non-assistant roles (user, toolResult, bashExecution)', () => {
    for (const role of ['user', 'toolResult', 'bashExecution']) {
      const result = translatePiEvent({
        type: 'message_end',
        message: { role, content: 'some text' },
      });
      expect(result).toEqual({ kind: 'none' });
    }
  });

  it('handles a bare string content (UserMessage shape) defensively', () => {
    const result = translatePiEvent({
      type: 'message_end',
      message: { role: 'assistant', content: '  trimmed  ' },
    });
    expect(result).toEqual({
      kind: 'event',
      fields: { type: 'message', role: 'assistant', content: { text: 'trimmed' } },
    });
  });
});

describe('translatePiEvent — agent_settled and everything else', () => {
  it('translates agent_settled into turnSettled', () => {
    expect(translatePiEvent({ type: 'agent_settled' })).toEqual({ kind: 'turnSettled' });
  });

  it('ignores every event this module has no platform vocabulary slot for', () => {
    for (const event of [
      { type: 'agent_start' },
      { type: 'agent_end', messages: [], willRetry: false },
      { type: 'turn_start' },
      { type: 'turn_end', message: {}, toolResults: [] },
      { type: 'message_start', message: { role: 'assistant', content: [] } },
      { type: 'bash_execution_update', id: 'req-1', delta: 'hi' },
      { type: 'queue_update', steering: [], followUp: [] },
      { type: 'compaction_start', reason: 'threshold' },
      { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 100 },
      { type: 'extension_error', extensionPath: '/x.ts', event: 'tool_call', error: 'boom' },
      { type: 'response', command: 'prompt', success: true },
      { type: 'unknown_future_event_type', anything: 'goes' },
    ]) {
      expect(translatePiEvent(event)).toEqual({ kind: 'none' });
    }
  });

  it('degrades to none for malformed/non-object input rather than throwing', () => {
    for (const raw of [null, undefined, 'a string', 42, [], {}]) {
      expect(() => translatePiEvent(raw)).not.toThrow();
      expect(translatePiEvent(raw)).toEqual({ kind: 'none' });
    }
  });
});

describe('buildPromptCommand / buildAbortCommand', () => {
  it('builds a prompt command keyed by the platform turnId, carrying the marked message verbatim', () => {
    expect(buildPromptCommand('turn-1', '<!--nexttime:turn_id=turn-1-->\nhello')).toEqual({
      type: 'prompt',
      id: 'turn-1',
      message: '<!--nexttime:turn_id=turn-1-->\nhello',
    });
  });

  it('builds a bare abort command', () => {
    expect(buildAbortCommand()).toEqual({ type: 'abort' });
  });
});
