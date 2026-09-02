import { describe, expect, it } from 'vitest';
import { VERSION, main } from './index.js';

describe('@nexttime/agent-host', () => {
  it('exposes a semantic version', () => {
    expect(VERSION).toBe('0.1.0');
  });

  it('main() runs without throwing', () => {
    expect(() => main()).not.toThrow();
  });
});
