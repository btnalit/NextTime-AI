import { describe, expect, it } from 'vitest';
import { liveOutputPaused } from './live-stream.js';

describe('liveOutputPaused', () => {
  it('is true only while the live text ends at a redaction', () => {
    expect(liveOutputPaused('here is the output: [redacted]')).toBe(true);
    expect(liveOutputPaused('token [redacted] was used, then more text')).toBe(false);
    expect(liveOutputPaused('')).toBe(false);
  });

  it('is false after a value scrubbed mid-text, whose trailing space is released with it', () => {
    // The kernel scrubber releases `[redacted] ` while it still holds the next word: not a pause.
    expect(liveOutputPaused('the password: [redacted] ')).toBe(false);
    expect(liveOutputPaused('the password: [redacted]\n')).toBe(false);
  });
});
