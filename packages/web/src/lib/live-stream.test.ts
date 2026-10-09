import { describe, expect, it } from 'vitest';
import { liveOutputPaused } from './live-stream.js';

describe('liveOutputPaused', () => {
  it('is true only while the live text ends at a redaction', () => {
    expect(liveOutputPaused('here is the output: [redacted]')).toBe(true);
    expect(liveOutputPaused('here is the output: [redacted]\n')).toBe(true);
    expect(liveOutputPaused('token [redacted] was used, then more text')).toBe(false);
    expect(liveOutputPaused('')).toBe(false);
  });
});
