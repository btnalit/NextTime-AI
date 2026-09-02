import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import platformExtension, { VERSION } from './index.js';

/**
 * Env-driven activation contract (S1.6 deliverable): `NEXTTIME_MODE` gates everything else. These
 * tests never construct a real pi session — a minimal fake `ExtensionAPI` is enough, since
 * `platformExtension()` either throws before touching `pi` at all (invalid/unimplemented mode, or
 * a missing required env var) or, for `entry` mode, only calls `pi.on(...)`/`pi.registerTool(...)`
 * (exercised more thoroughly in modes/entry.test.ts and the real-SDK test).
 */

const REQUIRED_ENTRY_ENV = {
  NEXTTIME_MODE: 'entry',
  KERNEL_URL: 'http://127.0.0.1:1',
  CAPABILITY_HANDLE: 'test-handle',
  WORKSPACE_ID: 'ws-1',
} as const;

const ENV_KEYS = [...Object.keys(REQUIRED_ENTRY_ENV), 'NEXTTIME_TURN_ID'] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function fakePi(): ExtensionAPI {
  return {
    on: vi.fn(),
    registerTool: vi.fn(),
    appendEntry: vi.fn(),
  } as unknown as ExtensionAPI;
}

describe('@nexttime/platform-extension', () => {
  it('exposes a semantic version', () => {
    expect(VERSION).toBe('0.1.0');
  });
});

describe('platformExtension() activation', () => {
  it('throws when NEXTTIME_MODE is unset', () => {
    expect(() => platformExtension(fakePi())).toThrow(/NEXTTIME_MODE/);
  });

  it('throws when NEXTTIME_MODE is not one of entry/worker/interactive', () => {
    process.env.NEXTTIME_MODE = 'bogus';
    expect(() => platformExtension(fakePi())).toThrow(/NEXTTIME_MODE/);
  });

  it('throws a clear "not implemented in S1" error for worker mode', () => {
    process.env.NEXTTIME_MODE = 'worker';
    expect(() => platformExtension(fakePi())).toThrow(/not implemented in S1/);
  });

  it('throws a clear "not implemented in S1" error for interactive mode', () => {
    process.env.NEXTTIME_MODE = 'interactive';
    expect(() => platformExtension(fakePi())).toThrow(/not implemented in S1/);
  });

  it('does not touch pi at all for an unimplemented or invalid mode', () => {
    const pi = fakePi();
    process.env.NEXTTIME_MODE = 'worker';
    expect(() => platformExtension(pi)).toThrow();
    expect(pi.on).not.toHaveBeenCalled();
    expect(pi.registerTool).not.toHaveBeenCalled();
  });

  for (const missing of ['KERNEL_URL', 'CAPABILITY_HANDLE', 'WORKSPACE_ID'] as const) {
    it(`throws a clear error when ${missing} is missing in entry mode`, () => {
      for (const [key, value] of Object.entries(REQUIRED_ENTRY_ENV)) {
        if (key !== missing) process.env[key] = value;
      }
      expect(() => platformExtension(fakePi())).toThrow(new RegExp(missing));
    });
  }

  it('registers the five observe tools and four event handlers for entry mode with all env vars set', () => {
    for (const [key, value] of Object.entries(REQUIRED_ENTRY_ENV)) process.env[key] = value;
    const pi = fakePi();

    expect(() => platformExtension(pi)).not.toThrow();

    expect(pi.registerTool).toHaveBeenCalledTimes(5);
    const registeredNames = vi.mocked(pi.registerTool).mock.calls.map(([tool]) => tool.name);
    expect(registeredNames).toEqual(['get_object', 'traverse', 'search', 'explain', 'get_task']);

    const subscribedEvents = vi.mocked(pi.on).mock.calls.map(([event]) => event);
    expect(subscribedEvents).toEqual(
      expect.arrayContaining(['input', 'context', 'agent_start', 'agent_end', 'agent_settled']),
    );
  });

  it('accepts an empty NEXTTIME_TURN_ID as "no seed" rather than throwing', () => {
    for (const [key, value] of Object.entries(REQUIRED_ENTRY_ENV)) process.env[key] = value;
    process.env.NEXTTIME_TURN_ID = '';
    expect(() => platformExtension(fakePi())).not.toThrow();
  });
});
