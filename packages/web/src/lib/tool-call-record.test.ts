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

  it('shows a bidi override as \\u{XXXX} whether the text is JSON, cut or plain (review of #593)', () => {
    expect(
      previewDisplayText({
        text: '{"op":"restart\u202Egnp.exe"}',
        totalChars: 26,
        truncated: false,
      }),
    ).toBe('{\n  "op": "restart\\u{202E}gnp.exe"\n}');
    expect(previewDisplayText({ text: '{"op":"a\u202E', totalChars: 900, truncated: true })).toBe(
      '{"op":"a\\u{202E}',
    );
    expect(previewDisplayText({ text: 'line 1\nb\u2066c', totalChars: 10, truncated: false })).toBe(
      'line 1\nb\\u{2066}c',
    );
  });

  // Review #493 on #605: plain output is shown as it is — a real `\\u{0}` keeps both backslashes,
  // and a control character is shown, not left raw — whether whole, cut or JSON-looking but not JSON.
  it('shows plain text as it holds it: backslashes kept, control characters shown', () => {
    const plain = 'C:\\\\u{0}\tok\r\nbell\u0007 esc\u001b[0m';
    const shown = 'C:\\\\u{0}\tok\r\nbell\\u{7} esc\\u{1B}[0m';
    expect(previewDisplayText({ text: plain, totalChars: plain.length, truncated: false })).toBe(
      shown,
    );
    expect(previewDisplayText({ text: plain, totalChars: 900, truncated: true })).toBe(shown);
    expect(
      previewDisplayText({ text: `{${plain}`, totalChars: plain.length + 1, truncated: false }),
    ).toBe(`{${shown}`);
    // Whole JSON still reads its stored stand-in with one backslash.
    expect(
      previewDisplayText({ text: '{"name":"media\\\\u{0}-1"}', totalChars: 25, truncated: false }),
    ).toBe('{\n  "name": "media\\u{0}-1"\n}');
  });
});
