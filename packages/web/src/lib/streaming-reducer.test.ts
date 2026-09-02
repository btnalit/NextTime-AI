import { describe, expect, it } from 'vitest';
import { initialTurnState, streamReducer } from './streaming-reducer.js';

describe('streamReducer', () => {
  it('starts idle', () => {
    expect(initialTurnState).toEqual({
      turnId: null,
      status: 'idle',
      streamingText: '',
      toolCalls: [],
    });
  });

  it('turnStarted resets to a running Turn with empty text/tool calls', () => {
    const state = streamReducer(initialTurnState, { kind: 'turnStarted', turnId: 't1' });
    expect(state).toEqual({ turnId: 't1', status: 'running', streamingText: '', toolCalls: [] });
  });

  it('assembles textDelta chunks in order', () => {
    let state = streamReducer(initialTurnState, { kind: 'turnStarted', turnId: 't1' });
    state = streamReducer(state, {
      kind: 'stream',
      turnId: 't1',
      payload: { streamKind: 'textDelta', delta: 'echo: ' },
    });
    state = streamReducer(state, {
      kind: 'stream',
      turnId: 't1',
      payload: { streamKind: 'textDelta', delta: 'hello' },
    });
    expect(state.streamingText).toBe('echo: hello');
  });

  it('ignores stream events for a turnId other than the current one', () => {
    const started = streamReducer(initialTurnState, { kind: 'turnStarted', turnId: 't1' });
    const state = streamReducer(started, {
      kind: 'stream',
      turnId: 'stale-turn',
      payload: { streamKind: 'textDelta', delta: 'nope' },
    });
    expect(state).toBe(started);
  });

  it('adds a toolCallStarted row and updates it on toolCallEnded', () => {
    let state = streamReducer(initialTurnState, { kind: 'turnStarted', turnId: 't1' });
    state = streamReducer(state, {
      kind: 'stream',
      turnId: 't1',
      payload: { streamKind: 'toolCallStarted', toolCallId: 'c1', name: 'search', args: { q: 1 } },
    });
    expect(state.toolCalls).toEqual([
      { toolCallId: 'c1', name: 'search', args: { q: 1 }, status: 'started' },
    ]);

    state = streamReducer(state, {
      kind: 'stream',
      turnId: 't1',
      payload: { streamKind: 'toolCallEnded', toolCallId: 'c1', result: { ok: true } },
    });
    expect(state.toolCalls).toEqual([
      { toolCallId: 'c1', name: 'search', args: { q: 1 }, status: 'ended', result: { ok: true } },
    ]);
  });

  it('keeps multiple concurrent tool calls independent', () => {
    let state = streamReducer(initialTurnState, { kind: 'turnStarted', turnId: 't1' });
    state = streamReducer(state, {
      kind: 'stream',
      turnId: 't1',
      payload: { streamKind: 'toolCallStarted', toolCallId: 'c1', name: 'search' },
    });
    state = streamReducer(state, {
      kind: 'stream',
      turnId: 't1',
      payload: { streamKind: 'toolCallStarted', toolCallId: 'c2', name: 'fetch' },
    });
    state = streamReducer(state, {
      kind: 'stream',
      turnId: 't1',
      payload: { streamKind: 'toolCallEnded', toolCallId: 'c1', result: 'done' },
    });
    expect(state.toolCalls.map((row) => [row.toolCallId, row.status])).toEqual([
      ['c1', 'ended'],
      ['c2', 'started'],
    ]);
  });

  it('metadata for the current turnId updates status', () => {
    const started = streamReducer(initialTurnState, { kind: 'turnStarted', turnId: 't1' });
    const state = streamReducer(started, {
      kind: 'metadata',
      metadata: { turnId: 't1', turnStatus: 'completed' },
    });
    expect(state.status).toBe('completed');
  });

  it('ignores metadata for a different turnId', () => {
    const started = streamReducer(initialTurnState, { kind: 'turnStarted', turnId: 't1' });
    const state = streamReducer(started, {
      kind: 'metadata',
      metadata: { turnId: 'other-turn', turnStatus: 'completed' },
    });
    expect(state).toBe(started);
  });

  it('ignores metadata with an unrecognized turnStatus', () => {
    const started = streamReducer(initialTurnState, { kind: 'turnStarted', turnId: 't1' });
    const state = streamReducer(started, {
      kind: 'metadata',
      metadata: { turnId: 't1', turnStatus: 'not-a-real-status' },
    });
    expect(state).toBe(started);
  });

  it('handles interrupted and failed terminal statuses', () => {
    const started = streamReducer(initialTurnState, { kind: 'turnStarted', turnId: 't1' });
    expect(
      streamReducer(started, {
        kind: 'metadata',
        metadata: { turnId: 't1', turnStatus: 'interrupted' },
      }).status,
    ).toBe('interrupted');
    expect(
      streamReducer(started, {
        kind: 'metadata',
        metadata: { turnId: 't1', turnStatus: 'failed' },
      }).status,
    ).toBe('failed');
  });
});
