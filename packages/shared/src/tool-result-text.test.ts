import { describe, expect, it } from 'vitest';
import { splitToolResultNote, toolResultJsonValue } from './tool-result-text.js';

describe('tool result text (legacy 967)', () => {
  const note = '[The result was shortened to fit: data.items: 3 of 18 items.]';

  it('splits compact JSON from its note line', () => {
    expect(splitToolResultNote(`{"a":[1,2,3]}\n\n${note}`)).toEqual({
      json: '{"a":[1,2,3]}',
      note,
    });
    expect(splitToolResultNote('{"a":1}')).toEqual({ json: '{"a":1}', note: undefined });
    // A blank line that does not start a note is part of the text (a pending approval's sentence).
    expect(splitToolResultNote('{"a":1}\n\npending approval')).toEqual({
      json: '{"a":1}\n\npending approval',
      note: undefined,
    });
  });

  it('reads the JSON of the whole text, or of the part before its note', () => {
    expect(toolResultJsonValue('{"a":1}')).toEqual({ value: { a: 1 } });
    expect(toolResultJsonValue(JSON.stringify({ a: 1 }, null, 2))).toEqual({ value: { a: 1 } });
    expect(toolResultJsonValue(`{"a":[1,2,3]}\n\n${note}`)).toEqual({ value: { a: [1, 2, 3] } });
    expect(toolResultJsonValue(`{"a":[1,2\n\n${note}`)).toBeUndefined();
    expect(toolResultJsonValue('{"a":')).toBeUndefined();
    expect(toolResultJsonValue('total 0')).toBeUndefined();
  });
});
