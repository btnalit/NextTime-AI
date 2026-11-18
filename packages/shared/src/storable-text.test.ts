import { describe, expect, it } from 'vitest';
import {
  LONE_SURROGATE_STAND_IN,
  UNSTORABLE_CHAR_STAND_IN,
  UnstorableTextError,
  findUnstorableText,
  sliceKeepingPairs,
  storableText,
  storableValue,
} from './storable-text.js';

describe('findUnstorableText (legacy 320)', () => {
  it('finds nothing in ordinary text, including other control characters', () => {
    expect(findUnstorableText({ a: 'line\nbreak\ttab‮bidi', b: [1, true, null] })).toBe(undefined);
  });

  it('names the path of a value holding U+0000', () => {
    expect(findUnstorableText({ a: [{ b: 'x' }, { c: 'y\u0000' }] })).toEqual({
      path: ['a', 1, 'c'],
      in: 'value',
      character: 'nul',
    });
  });

  it('names a key holding U+0000', () => {
    expect(findUnstorableText({ props: { 'k\u0000': 1 } })).toEqual({
      path: ['props', 'k\u0000'],
      in: 'key',
      character: 'nul',
    });
  });

  it('a top-level string', () => {
    expect(findUnstorableText('\u0000')).toEqual({ path: [], in: 'value', character: 'nul' });
  });
});

describe('findUnstorableText — unpaired surrogates (legacy 837)', () => {
  const EMOJI = '\u{1F600}';
  const HIGH = EMOJI[0] as string;
  const LOW = EMOJI[1] as string;

  it('names the path of a value holding a high or a low surrogate on its own', () => {
    expect(findUnstorableText({ a: ['ok', `cut ${HIGH}`] })).toEqual({
      path: ['a', 1],
      in: 'value',
      character: 'lone_surrogate',
    });
    expect(findUnstorableText({ b: `${LOW} starts` })).toEqual({
      path: ['b'],
      in: 'value',
      character: 'lone_surrogate',
    });
    expect(findUnstorableText(`${LOW}${HIGH}`)).toEqual({
      path: [],
      in: 'value',
      character: 'lone_surrogate',
    });
  });

  it('names a key holding one', () => {
    expect(findUnstorableText({ props: { [`k${HIGH}`]: 'v' } })).toEqual({
      path: ['props', `k${HIGH}`],
      in: 'key',
      character: 'lone_surrogate',
    });
  });

  it('finds nothing in whole pairs, and says U+0000 when a string holds both', () => {
    expect(findUnstorableText({ [EMOJI]: `${EMOJI} ok ${EMOJI}` })).toBe(undefined);
    expect(findUnstorableText(`${HIGH}\u0000`)).toEqual({
      path: [],
      in: 'value',
      character: 'nul',
    });
  });

  it('finds nothing in what storableValue made of it, and keeps no state between calls', () => {
    const sent = { a: `x${HIGH}`, [`k${LOW}`]: 1 };
    expect(findUnstorableText(storableValue(sent).value)).toBe(undefined);
    // Not a `/g` regex reused across calls: a second look at the same text still finds it.
    expect(findUnstorableText(sent)?.path).toEqual(['a']);
    expect(findUnstorableText(sent)?.path).toEqual(['a']);
  });
});

describe('storableValue (legacy 320)', () => {
  it('replaces every U+0000 in values and keys with the visible stand-in and counts them', () => {
    const { value, escaped } = storableValue({
      summary: 'a\u0000b\u0000',
      list: ['ok', '\u0000'],
      props: { 'k\u0000': 'v' },
    });
    expect(value).toEqual({
      summary: `a${UNSTORABLE_CHAR_STAND_IN}b${UNSTORABLE_CHAR_STAND_IN}`,
      list: ['ok', UNSTORABLE_CHAR_STAND_IN],
      props: { [`k${UNSTORABLE_CHAR_STAND_IN}`]: 'v' },
    });
    expect(escaped).toBe(4);
    expect(findUnstorableText(value)).toBe(undefined);
  });

  it('returns the same object when nothing needs replacing', () => {
    const input = { a: 'x', b: [{ c: 1 }] };
    const { value, escaped } = storableValue(input);
    expect(value).toBe(input);
    expect(escaped).toBe(0);
  });

  it('keeps every other character, including line breaks', () => {
    expect(storableText('a\nb\u0000c')).toBe('a\nb\\u{0}c');
  });
});

describe('storableValue — unpaired surrogates (legacy 834)', () => {
  const EMOJI = '\u{1F600}';
  const HIGH = EMOJI[0] as string;
  const LOW = EMOJI[1] as string;
  /** `JSON.stringify` writes an unpaired surrogate as this escape, which `jsonb` refuses. */
  const JSON_SURROGATE_ESCAPE = /\\ud[89a-f][0-9a-f]{2}/i;

  it('replaces a high or a low surrogate on its own, in values and keys, with U+FFFD and counts them', () => {
    const { value, escaped } = storableValue({
      cut: `ends in half an emoji ${HIGH}`,
      start: `${LOW} starts with the other half`,
      both: [`${LOW}${HIGH}`, `a${HIGH}b${LOW}c`],
      props: { [`k${HIGH}`]: 'v' },
    });
    const S = LONE_SURROGATE_STAND_IN;
    expect(value).toEqual({
      cut: `ends in half an emoji ${S}`,
      start: `${S} starts with the other half`,
      both: [`${S}${S}`, `a${S}b${S}c`],
      props: { [`k${S}`]: 'v' },
    });
    expect(escaped).toBe(7);
    expect(JSON.stringify(value)).not.toMatch(JSON_SURROGATE_ESCAPE);
  });

  it('keeps every whole pair as it is, and returns the same object when that is all there is', () => {
    const input = { text: `${EMOJI}${EMOJI} ok ${EMOJI}`, list: [EMOJI] };
    const { value, escaped } = storableValue(input);
    expect(value).toBe(input);
    expect(escaped).toBe(0);
    expect(storableText(`${EMOJI}${HIGH}${EMOJI}`)).toBe(
      `${EMOJI}${LONE_SURROGATE_STAND_IN}${EMOJI}`,
    );
  });

  it('U+0000 and an unpaired surrogate side by side are both replaced and both counted', () => {
    const { value, escaped } = storableValue(`\u0000${HIGH}\u0000`);
    expect(value).toBe(
      `${UNSTORABLE_CHAR_STAND_IN}${LONE_SURROGATE_STAND_IN}${UNSTORABLE_CHAR_STAND_IN}`,
    );
    expect(escaped).toBe(3);
  });
});

describe('sliceKeepingPairs (legacy 834)', () => {
  const EMOJI = '\u{1F600}';
  const text = `ab${EMOJI}cd`;

  it('cuts where asked, one character shorter where that would cut a pair in two', () => {
    expect(sliceKeepingPairs(text, 2)).toBe('ab');
    expect(sliceKeepingPairs(text, 3)).toBe('ab');
    expect(sliceKeepingPairs(text, 4)).toBe(`ab${EMOJI}`);
    expect(sliceKeepingPairs(text, 5)).toBe(`ab${EMOJI}c`);
  });

  it('past either end it is the whole text, or nothing', () => {
    expect(sliceKeepingPairs(text, 100)).toBe(text);
    expect(sliceKeepingPairs(text, 0)).toBe('');
    expect(sliceKeepingPairs(text, -3)).toBe('');
    expect(sliceKeepingPairs(EMOJI, 1)).toBe('');
  });

  it('a half that was already alone is cut as any other character', () => {
    const lone = `a${EMOJI[0]}b`;
    expect(sliceKeepingPairs(lone, 2)).toBe(`a${EMOJI[0]}`);
  });
});

describe('UnstorableTextError (legacy 320)', () => {
  it('names whose input, where, and shows a key visibly', () => {
    const err = new UnstorableTextError('capability "x"', {
      path: ['props', 'k\u0000', 2],
      in: 'key',
      character: 'nul',
    });
    expect(err.code).toBe('unstorable_text');
    expect(err.details).toEqual({ path: ['props', 'k\\u{0}', 2], in: 'key', character: 'nul' });
    expect(err.message).toBe(
      'capability "x": the key at params "props.k\\u0000.2" holds U+0000 (NUL), which cannot be stored — nothing was written; send it again without that character',
    );
    expect(err.message).not.toContain('\u0000');
  });

  it('a top-level value', () => {
    expect(
      new UnstorableTextError('s', { path: [], in: 'value', character: 'nul' }).message,
    ).toContain('the text at the params holds');
  });

  it('names an unpaired surrogate (legacy 837): which character, where, and the key shown visibly', () => {
    const err = new UnstorableTextError('capability "x"', {
      path: ['props', 'k\uD800'],
      in: 'key',
      character: 'lone_surrogate',
    });
    expect(err.details).toEqual({
      path: ['props', 'k\\u{D800}'],
      in: 'key',
      character: 'lone_surrogate',
    });
    expect(err.message).toBe(
      'capability "x": the key at params "props.k\\ud800" holds an unpaired surrogate (half of a character such as an emoji), which cannot be stored — nothing was written; send it again with the whole character, or without it',
    );
    expect(err.message).not.toMatch(/[\uD800-\uDFFF]/);
    expect(err.message).not.toContain('U+0000');
  });
});
