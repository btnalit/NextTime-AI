import { afterEach, describe, expect, it } from 'vitest';
import { VERSION, kernelWsUrlFrom, main } from './index.js';

/** index.test: smoke tests for the process entrypoint — env validation and the kernel URL ->
 *  WebSocket URL derivation. The actual wiring (kernel-link <-> host <-> supervisor-client/
 *  container-io) is covered by each of those modules' own test files; this file does not start a
 *  real process. */

const ENV_KEYS = ['KERNEL_URL', 'SUPERVISOR_URL', 'KERNEL_LLM_URL', 'DOCKER_SOCKET_PATH'] as const;

function clearAgentHostEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

describe('@nexttime/agent-host', () => {
  it('exposes a semantic version', () => {
    expect(VERSION).toBe('0.1.0');
  });
});

describe('kernelWsUrlFrom', () => {
  it('derives the /internal/agent-host WebSocket URL from an http(s) KERNEL_URL', () => {
    expect(kernelWsUrlFrom('http://kernel:8080')).toBe('ws://kernel:8080/internal/agent-host');
    expect(kernelWsUrlFrom('https://kernel:8443')).toBe('wss://kernel:8443/internal/agent-host');
    expect(kernelWsUrlFrom('http://kernel:8080/')).toBe('ws://kernel:8080/internal/agent-host');
  });
});

describe('main()', () => {
  afterEach(() => {
    clearAgentHostEnv();
  });

  it('throws when a required env var is missing, before doing anything else', () => {
    clearAgentHostEnv();
    expect(() => main()).toThrow(/KERNEL_URL/);

    process.env.KERNEL_URL = 'http://kernel:8080';
    expect(() => main()).toThrow(/SUPERVISOR_URL/);

    process.env.SUPERVISOR_URL = 'http://worker-supervisor:8081';
    expect(() => main()).toThrow(/KERNEL_LLM_URL/);
  });
});
