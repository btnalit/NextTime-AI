import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import platformExtension, { VERSION } from './index.js';
import { startFakeKernel } from './test-support/fake-kernel.js';

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

const REQUIRED_WORKER_ENV = {
  NEXTTIME_MODE: 'worker',
  KERNEL_URL: 'http://127.0.0.1:1',
  CAPABILITY_HANDLE: 'test-handle',
  WORKSPACE_ID: 'ws-1',
  TASK_ID: 'task-1',
} as const;

const REQUIRED_INTERACTIVE_ENV = {
  NEXTTIME_MODE: 'interactive',
  KERNEL_URL: 'http://127.0.0.1:1',
  CAPABILITY_HANDLE: 'test-handle',
} as const;

const ENV_KEYS = [
  ...new Set([
    ...Object.keys(REQUIRED_ENTRY_ENV),
    ...Object.keys(REQUIRED_WORKER_ENV),
    ...Object.keys(REQUIRED_INTERACTIVE_ENV),
    'NEXTTIME_TURN_ID',
    'NEXTTIME_CORRELATION_ID',
  ]),
] as const;

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

  it('does not touch pi at all for an invalid mode', () => {
    const pi = fakePi();
    process.env.NEXTTIME_MODE = 'bogus';
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

  it('registers the entry capability tools (five S1 observe + S2) and the event handlers for entry mode with all env vars set', () => {
    for (const [key, value] of Object.entries(REQUIRED_ENTRY_ENV)) process.env[key] = value;
    const pi = fakePi();

    expect(() => platformExtension(pi)).not.toThrow();

    expect(pi.registerTool).toHaveBeenCalledTimes(20);
    const registeredNames = vi.mocked(pi.registerTool).mock.calls.map(([tool]) => tool.name);
    expect(registeredNames.slice(0, 5)).toEqual([
      'get_object',
      'traverse',
      'search',
      'explain',
      'get_task',
    ]);
    expect(registeredNames).toEqual(
      expect.arrayContaining(['list_facts', 'find_workers', 'invoke_worker', 'request_connection']),
    );

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

  for (const missing of ['KERNEL_URL', 'CAPABILITY_HANDLE', 'WORKSPACE_ID', 'TASK_ID'] as const) {
    it(`throws a clear error when ${missing} is missing in worker mode`, () => {
      for (const [key, value] of Object.entries(REQUIRED_WORKER_ENV)) {
        if (key !== missing) process.env[key] = value;
      }
      expect(() => platformExtension(fakePi())).toThrow(new RegExp(missing));
    });
  }

  it('registers the report_result tool and the worker-mode event handlers with all env vars set', () => {
    for (const [key, value] of Object.entries(REQUIRED_WORKER_ENV)) process.env[key] = value;
    const pi = fakePi();

    expect(() => platformExtension(pi)).not.toThrow();

    // Gate tools (list_allowed_operations) register asynchronously inside session_start — only
    // report_result is registered synchronously by platformExtension() itself.
    expect(pi.registerTool).toHaveBeenCalledTimes(1);
    const [tool] = vi.mocked(pi.registerTool).mock.calls[0] ?? [];
    expect(tool?.name).toBe('report_result');

    const subscribedEvents = vi.mocked(pi.on).mock.calls.map(([event]) => event);
    expect(subscribedEvents).toEqual(
      expect.arrayContaining(['session_start', 'context', 'agent_end', 'agent_settled']),
    );
  });

  // Leftover 87: a Worker run's kernel calls carry the id it inherited from its delegating call.
  it('worker mode sends NEXTTIME_CORRELATION_ID as x-correlation-id on its kernel calls', async () => {
    const kernel = await startFakeKernel();
    try {
      kernel.setHandler('list_allowed_operations', () => ({ ok: true, result: { items: [] } }));
      for (const [key, value] of Object.entries(REQUIRED_WORKER_ENV)) process.env[key] = value;
      process.env.KERNEL_URL = kernel.url;
      process.env.NEXTTIME_CORRELATION_ID = '7f0c7c1e-8a44-4b6b-9f59-1b7bbcf0a3d2';
      const pi = { ...fakePi(), sendUserMessage: vi.fn() } as unknown as ExtensionAPI;
      platformExtension(pi);
      const sessionStart = vi
        .mocked(pi.on)
        .mock.calls.find(([event]) => (event as string) === 'session_start')?.[1] as
        | ((event: unknown, ctx: unknown) => Promise<void>)
        | undefined;
      await sessionStart?.({}, { hasUI: false, ui: { notify: vi.fn() } });
      expect(kernel.requests.map((r) => r.correlationId)).toEqual([
        '7f0c7c1e-8a44-4b6b-9f59-1b7bbcf0a3d2',
      ]);
    } finally {
      await kernel.close();
    }
  });

  // Leftover 87: the LLM hop — entry / worker model calls carry the correlation id to llm-proxy;
  // interactive mode (possibly a third-party provider) never adds it.
  it('entry mode adds the current Turn id to provider request headers; interactive mode does not subscribe', () => {
    for (const [key, value] of Object.entries(REQUIRED_ENTRY_ENV)) process.env[key] = value;
    process.env.NEXTTIME_TURN_ID = '7f0c7c1e-8a44-4b6b-9f59-1b7bbcf0a3d2';
    const pi = fakePi();
    platformExtension(pi);
    const handler = vi
      .mocked(pi.on)
      .mock.calls.find(([event]) => (event as string) === 'before_provider_headers')?.[1] as
      | ((event: { headers: Record<string, string | null> }) => void)
      | undefined;
    const headers: Record<string, string | null> = { authorization: 'Bearer x' };
    handler?.({ headers });
    expect(headers['x-correlation-id']).toBe('7f0c7c1e-8a44-4b6b-9f59-1b7bbcf0a3d2');

    for (const key of ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(REQUIRED_INTERACTIVE_ENV)) process.env[key] = value;
    const interactivePi = fakePi();
    platformExtension(interactivePi);
    const events = vi.mocked(interactivePi.on).mock.calls.map(([event]) => event as string);
    expect(events).not.toContain('before_provider_headers');
  });

  for (const missing of ['KERNEL_URL', 'CAPABILITY_HANDLE'] as const) {
    it(`throws a clear error when ${missing} is missing in interactive mode`, () => {
      for (const [key, value] of Object.entries(REQUIRED_INTERACTIVE_ENV)) {
        if (key !== missing) process.env[key] = value;
      }
      expect(() => platformExtension(fakePi())).toThrow(new RegExp(missing));
    });
  }

  it('interactive mode needs no WORKSPACE_ID (no Turn to correlate — modes/interactive.ts’s own "默认不回传")', () => {
    process.env.NEXTTIME_MODE = REQUIRED_INTERACTIVE_ENV.NEXTTIME_MODE;
    process.env.KERNEL_URL = REQUIRED_INTERACTIVE_ENV.KERNEL_URL;
    process.env.CAPABILITY_HANDLE = REQUIRED_INTERACTIVE_ENV.CAPABILITY_HANDLE;
    expect(() => platformExtension(fakePi())).not.toThrow();
  });

  it('registers the 18 capability tools (entry mode minus the two Turn-attribution tools), no turn-id/report_turn wiring, with all env vars set', () => {
    for (const [key, value] of Object.entries(REQUIRED_INTERACTIVE_ENV)) process.env[key] = value;
    const pi = fakePi();

    expect(() => platformExtension(pi)).not.toThrow();

    expect(pi.registerTool).toHaveBeenCalledTimes(18);
    const registeredNames = vi.mocked(pi.registerTool).mock.calls.map(([tool]) => tool.name);
    expect(registeredNames.slice(0, 5)).toEqual([
      'get_object',
      'traverse',
      'search',
      'explain',
      'get_task',
    ]);
    expect(registeredNames).toEqual(
      expect.arrayContaining(['list_facts', 'find_workers', 'invoke_worker', 'request_connection']),
    );

    const subscribedEvents = vi.mocked(pi.on).mock.calls.map(([event]) => event);
    expect(subscribedEvents).toEqual(expect.arrayContaining(['session_start', 'context']));
    expect(subscribedEvents).not.toEqual(
      expect.arrayContaining(['input', 'agent_start', 'agent_end', 'agent_settled']),
    );
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });
});
