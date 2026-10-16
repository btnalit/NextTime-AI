import { describe, expect, it } from 'vitest';
import { OPERATION_NAME_MAX } from './action-description.js';
import {
  ECHO_MAX,
  boundedEcho,
  clipCodePoints,
  quotedName,
  visibleJson,
  visibleText,
} from './echoed-text.js';

describe('quotedName (legacy 232)', () => {
  it('quotes an ordinary name as before', () => {
    expect(quotedName('inventory.list_items')).toBe('"inventory.list_items"');
  });

  it('escapes quotes, backslashes and line breaks, so the name can neither end the quote nor add a line', () => {
    const quoted = quotedName('a"b\\c\nd\re');
    expect(quoted).toBe('"a\\"b\\\\c\\nd\\re"');
    expect(quoted).not.toMatch(/[\n\r]/);
  });

  it('shows a bidi override or a zero-width character instead of letting it reorder or hide text', () => {
    expect(quotedName('delete\u202Etoor\u200B')).toBe('"delete\\u{202E}toor\\u{200B}"');
  });

  it('clips by code point, never splitting a surrogate pair', () => {
    const quoted = quotedName('😀'.repeat(ECHO_MAX + 5));
    expect(quoted).toBe(`"${'😀'.repeat(ECHO_MAX)}…"`);
  });

  it('clips a long name', () => {
    const quoted = quotedName('x'.repeat(5000));
    expect(quoted).toBe(`"${'x'.repeat(ECHO_MAX)}…"`);
  });
});

describe('boundedEcho / visibleText / clipCodePoints (legacy 232)', () => {
  it('leaves an ordinary value as is', () => {
    expect(boundedEcho('runs_on')).toBe('runs_on');
    expect(visibleText('a "b" c')).toBe('a "b" c');
  });

  it('shows control, format and separator characters and lone surrogates as \\u{XXXX}', () => {
    expect(visibleText('a\nb\u202Ec\u200Bd\u2028e\uD800')).toBe(
      'a\\u{A}b\\u{202E}c\\u{200B}d\\u{2028}e\\u{D800}',
    );
  });

  it('visibleJson shows what JSON.stringify left raw and keeps its own line breaks', () => {
    const json = JSON.stringify({ qty: 'wh-9 \u202Eqty: 0001\u202C', sep: 'a\u2028b' }, null, 2);
    const shown = visibleJson(json);
    expect(shown).not.toMatch(/[\u202E\u202C\u2028]/);
    expect(shown).toContain('wh-9 \\u{202E}qty: 0001\\u{202C}');
    expect(shown).toContain('a\\u{2028}b');
    expect(shown.split('\n')).toHaveLength(4);
  });

  it('never clips a legal Operation name (review #493 on #593)', () => {
    const longest = `a.${'b'.repeat(OPERATION_NAME_MAX - 2)}`;
    expect(boundedEcho(longest)).toBe(longest);
    expect(quotedName(longest)).toBe(`"${longest}"`);
  });

  it('clips before escaping, by code point', () => {
    expect(clipCodePoints('😀😀😀', 2)).toBe('😀😀…');
    expect(boundedEcho('x'.repeat(500))).toBe(`${'x'.repeat(ECHO_MAX)}…`);
    expect(boundedEcho('\u202E'.repeat(500))).toBe(`${'\\u{202E}'.repeat(ECHO_MAX)}…`);
  });
});
