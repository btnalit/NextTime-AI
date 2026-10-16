import { describe, expect, it } from 'vitest';
import {
  UNSTORABLE_CHAR_STAND_IN,
  UnstorableTextError,
  findUnstorableText,
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
    });
  });

  it('names a key holding U+0000', () => {
    expect(findUnstorableText({ props: { 'k\u0000': 1 } })).toEqual({
      path: ['props', 'k\u0000'],
      in: 'key',
    });
  });

  it('a top-level string', () => {
    expect(findUnstorableText('\u0000')).toEqual({ path: [], in: 'value' });
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

describe('UnstorableTextError (legacy 320)', () => {
  it('names whose input, where, and shows a key visibly', () => {
    const err = new UnstorableTextError('capability "x"', {
      path: ['props', 'k\u0000', 2],
      in: 'key',
    });
    expect(err.code).toBe('unstorable_text');
    expect(err.details).toEqual({ path: ['props', 'k\\u{0}', 2], in: 'key' });
    expect(err.message).toBe(
      'capability "x": the key at params "props.k\\u0000.2" holds U+0000 (NUL), which cannot be stored — nothing was written; send it again without that character',
    );
    expect(err.message).not.toContain('\u0000');
  });

  it('a top-level value', () => {
    expect(new UnstorableTextError('s', { path: [], in: 'value' }).message).toContain(
      'the text at the params holds',
    );
  });
});
