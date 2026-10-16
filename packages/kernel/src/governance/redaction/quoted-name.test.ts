import { describe, expect, it } from 'vitest';
import { QUOTED_NAME_MAX, quotedName } from './quoted-name.js';

describe('quotedName (legacy 232)', () => {
  it('quotes an ordinary name as before', () => {
    expect(quotedName('inventory.list_items')).toBe('"inventory.list_items"');
  });

  it('escapes quotes, backslashes and line breaks, so the name can neither end the quote nor add a line', () => {
    const quoted = quotedName('a"b\\c\nd\re');
    expect(quoted).toBe('"a\\"b\\\\c\\nd\\re"');
    expect(quoted).not.toMatch(/[\n\r]/);
  });

  it('clips a long name', () => {
    const quoted = quotedName('x'.repeat(5000));
    expect(quoted).toBe(`"${'x'.repeat(QUOTED_NAME_MAX)}…"`);
  });
});
