import { describe, expect, it } from 'vitest';
import { storableText } from './storable-text.js';

describe('storableText', () => {
  it('returns text with nothing to replace unchanged', () => {
    for (const text of [
      '',
      'model-a',
      'tab\there, \u0001 and \u001f are stored as they are',
      '\u{1f600}',
      // The code units on each side of the surrogate ranges.
      '\ud7ff',
      '\ue000',
      '\ufffd',
      // The first and the last pair.
      '\ud800\udc00',
      '\udbff\udfff',
    ]) {
      expect(storableText(text), JSON.stringify(text)).toBe(text);
    }
  });

  it('replaces U+0000 and every unpaired surrogate with U+FFFD, and keeps every pair', () => {
    const cases: Array<[string, string]> = [
      ['nul\u0000id', 'nul\ufffdid'],
      ['\u0000\u0000', '\ufffd\ufffd'],
      // A high surrogate at the end, or before anything that is not a low one.
      ['end\ud800', 'end\ufffd'],
      ['\udbffx', '\ufffdx'],
      ['\ud800\ud800\u{1f600}', '\ufffd\ufffd\u{1f600}'],
      // Not a low surrogate on either side of that range (#493, #501 on #1417).
      ['\ud800\udbff', '\ufffd\ufffd'],
      ['\ud800\ue000', '\ufffd\ue000'],
      ['\ud800\uff0c', '\ufffd\uff0c'],
      // A low surrogate with no high one before it.
      ['x\udc00y', 'x\ufffdy'],
      ['\udfff', '\ufffd'],
      ['\u{1f600}\udc00', '\u{1f600}\ufffd'],
    ];
    for (const [text, stored] of cases) {
      expect(storableText(text), JSON.stringify(text)).toBe(stored);
    }
  });
});
