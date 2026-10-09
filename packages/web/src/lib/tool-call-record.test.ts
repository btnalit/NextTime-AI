import { describe, expect, it } from 'vitest';
import {
  persistedToolCallIds,
  previewDisplayText,
  threadItems,
  toolCallRecordFromMessage,
} from './tool-call-record.js';
import type { ChatMessage } from './ws-client.js';

function message(
  sequence: number,
  role: ChatMessage['role'],
  content?: Record<string, unknown>,
  turnId: string | null = 'turn-1',
): ChatMessage {
  return {
    id: `m${sequence}`,
    role,
    text: '',
    createdAt: '2026-10-09T00:00:00.000Z',
    sequence,
    turnId,
    ...(content ? { kind: String(content.kind), content } : {}),
  };
}

function record(toolCallId: string, extra: Record<string, unknown> = {}) {
  return {
    kind: 'tool_call',
    text: 'bash',
    toolCallId,
    name: 'bash',
    outcome: 'done',
    redactedValues: 0,
    startedAt: null,
    endedAt: null,
    ...extra,
  };
}

describe('toolCallRecordFromMessage', () => {
  it('accepts a well-formed record, with or without previews', () => {
    expect(toolCallRecordFromMessage(message(1, 'tool', record('c1')))).toEqual({
      toolCallId: 'c1',
      name: 'bash',
      outcome: 'done',
      redactedValues: 0,
      startedAt: null,
      endedAt: null,
    });
    const withArgs = toolCallRecordFromMessage(
      message(
        1,
        'tool',
        record('c1', { name: null, args: { text: 'ls', totalChars: 2, truncated: false } }),
      ),
    );
    expect(withArgs).toMatchObject({ name: null, args: { text: 'ls' } });
  });

  it('rejects anything else, so the row falls back to a plain message', () => {
    expect(toolCallRecordFromMessage(message(1, 'assistant', record('c1')))).toBeNull();
    expect(toolCallRecordFromMessage(message(1, 'tool'))).toBeNull();
    for (const bad of [
      record('c1', { kind: 'other' }),
      record(''),
      record('c1', { outcome: 'weird' }),
      record('c1', { redactedValues: -1 }),
      record('c1', { args: { text: 'x' } }),
      record('c1', { startedAt: 5 }),
      record('c1', { name: 3 }),
    ]) {
      expect(toolCallRecordFromMessage(message(1, 'tool', bad))).toBeNull();
    }
  });
});

describe('threadItems', () => {
  it('folds consecutive records of one Turn into one group and keeps everything else in order', () => {
    const items = threadItems([
      message(1, 'user'),
      message(2, 'tool', record('a')),
      message(3, 'tool', record('b')),
      message(4, 'assistant'),
      message(5, 'tool', record('c'), 'turn-2'),
      message(6, 'tool', record('d', { outcome: 'nope' }), 'turn-2'),
    ]);
    expect(
      items.map((i) =>
        i.kind === 'tools' ? `tools:${i.key}:${i.records.length}` : `m${i.message.sequence}`,
      ),
    ).toEqual(['m1', 'tools:2:2', 'm4', 'tools:5:1', 'm6']);
  });

  it('starts a new group when the Turn changes', () => {
    const items = threadItems([
      message(1, 'tool', record('a'), 'turn-1'),
      message(2, 'tool', record('b'), 'turn-2'),
    ]);
    expect(items).toHaveLength(2);
  });

  it('collects the persisted call ids', () => {
    expect([
      ...persistedToolCallIds([message(1, 'tool', record('a')), message(2, 'user')]),
    ]).toEqual(['a']);
  });
});

describe('previewDisplayText', () => {
  it('indents whole JSON and leaves cut or plain text alone', () => {
    expect(previewDisplayText({ text: '{"a":1}', totalChars: 7, truncated: false })).toBe(
      '{\n  "a": 1\n}',
    );
    expect(previewDisplayText({ text: '{"a":', totalChars: 900, truncated: true })).toBe('{"a":');
    expect(previewDisplayText({ text: 'total 0', totalChars: 7, truncated: false })).toBe(
      'total 0',
    );
    expect(previewDisplayText({ text: '{not json', totalChars: 9, truncated: false })).toBe(
      '{not json',
    );
  });
});
