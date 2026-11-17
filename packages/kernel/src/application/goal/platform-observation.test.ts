import { describe, expect, it } from 'vitest';
import {
  PLATFORM_OBSERVATION_RESULT_MAX_CHARS,
  keptObservationResult,
} from './platform-observation.js';

describe('keptObservationResult (legacy 834)', () => {
  const MAX = PLATFORM_OBSERVATION_RESULT_MAX_CHARS;
  const EMOJI = '\u{1F600}';

  it('keeps a result that fits whole', () => {
    const result = { status: 'live', note: EMOJI };
    expect(keptObservationResult(result)).toEqual({ result, truncated: false });
  });

  it('cuts a result where an emoji falls before it, never in half of it, and says how much it left out', () => {
    // `"` + filler puts the emoji's first half last before the cut.
    const result = `${'x'.repeat(MAX - 2)}${EMOJI}${'y'.repeat(100)}`;
    const serialized = JSON.stringify(result);
    expect(serialized.charCodeAt(MAX - 1)).toBe(0xd83d);

    expect(keptObservationResult(result)).toEqual({
      result: `"${'x'.repeat(MAX - 2)}… [${serialized.length - (MAX - 1)} more characters omitted]`,
      truncated: true,
    });
  });
});
