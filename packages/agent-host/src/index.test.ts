import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INTERNAL_TOKEN_FILE_ENV, InternalTokenError } from '@nexttime/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { VERSION, kernelWsUrlFrom, loadInternalToken, main } from './index.js';

/** index.test: smoke tests for the process entrypoint — env validation and the kernel URL ->
 *  WebSocket URL derivation. The actual wiring (kernel-link <-> host <-> supervisor-client/
 *  container-io) is covered by each of those modules' own test files; this file does not start a
 *  real process. */

const ENV_KEYS = [
  'KERNEL_URL',
  'SUPERVISOR_URL',
  'KERNEL_LLM_URL',
  'DOCKER_SOCKET_PATH',
  'DOCKER_HOST',
  INTERNAL_TOKEN_FILE_ENV,
] as const;

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

  it('fails fast on the internal-plane token file once every required env var is set (fix/internal-plane-auth)', () => {
    process.env.KERNEL_URL = 'http://kernel:8080';
    process.env.SUPERVISOR_URL = 'http://worker-supervisor:8081';
    process.env.KERNEL_LLM_URL = 'http://llm-proxy:8082';
    process.env[INTERNAL_TOKEN_FILE_ENV] = join(
      tmpdir(),
      'nexttime-agent-host-index-test-does-not-exist',
      'internal.token',
    );
    expect(() => main()).toThrow(InternalTokenError);
  });
});

describe('loadInternalToken', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  function tokenFile(contents: string): string {
    dir = mkdtempSync(join(tmpdir(), 'nexttime-agent-host-internal-token-'));
    const file = join(dir, 'internal.token');
    writeFileSync(file, contents, 'utf8');
    return file;
  }

  const TOKEN = 'a'.repeat(64);

  it('reads and trims the token from the file named by the env var', () => {
    const file = tokenFile(`${TOKEN}\n`);
    expect(loadInternalToken({ [INTERNAL_TOKEN_FILE_ENV]: file })).toBe(TOKEN);
  });

  it('fails with InternalTokenError naming the path and env var when the file is missing', () => {
    const missing = join(
      tmpdir(),
      'nexttime-agent-host-internal-token-does-not-exist',
      'internal.token',
    );
    let caught: unknown;
    try {
      loadInternalToken({ [INTERNAL_TOKEN_FILE_ENV]: missing });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InternalTokenError);
    expect((caught as Error).message).toContain(missing);
    expect((caught as Error).message).toContain(INTERNAL_TOKEN_FILE_ENV);
  });

  it('fails when the file is empty or holds a too-short token', () => {
    expect(() => loadInternalToken({ [INTERNAL_TOKEN_FILE_ENV]: tokenFile('\n') })).toThrow(
      InternalTokenError,
    );
    rmSync(dir as string, { recursive: true, force: true });
    expect(() => loadInternalToken({ [INTERNAL_TOKEN_FILE_ENV]: tokenFile('changeme\n') })).toThrow(
      InternalTokenError,
    );
  });
});
