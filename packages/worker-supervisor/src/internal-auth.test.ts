import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INTERNAL_TOKEN_FILE_ENV, InternalTokenError } from '@nexttime/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_HOST_TOKEN_FILE_ENV,
  DEFAULT_AGENT_HOST_TOKEN_FILE,
  loadAgentHostToken,
  loadInternalToken,
  requireInternalCaller,
} from './internal-auth.js';

describe('loadInternalToken', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  function tokenFile(contents: string): string {
    dir = mkdtempSync(join(tmpdir(), 'nexttime-worker-supervisor-internal-token-'));
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
      'nexttime-worker-supervisor-internal-token-does-not-exist',
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

describe('loadAgentHostToken', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it('reads agent-host’s credential from its own file, and names that file and env var when it is missing', () => {
    dir = mkdtempSync(join(tmpdir(), 'nexttime-worker-supervisor-agent-host-token-'));
    const file = join(dir, 'internal_token_agent_host');
    writeFileSync(file, `${'b'.repeat(64)}\n`, 'utf8');
    expect(loadAgentHostToken({ [AGENT_HOST_TOKEN_FILE_ENV]: file })).toBe('b'.repeat(64));

    const missing = join(dir, 'missing');
    expect(() => loadAgentHostToken({ [AGENT_HOST_TOKEN_FILE_ENV]: missing })).toThrow(
      new RegExp(`${AGENT_HOST_TOKEN_FILE_ENV}.*internal_agent_host_to_worker_supervisor`),
    );
  });

  it('defaults to the compose mount path', () => {
    expect(() => loadAgentHostToken({})).toThrow(DEFAULT_AGENT_HOST_TOKEN_FILE);
  });
});

// Minimal fake FastifyRequest/FastifyReply — requireInternalCaller only reads
// `request.headers.authorization` and calls `reply.code`/`reply.header`/`reply.send`.
function fakeRequest(authorization?: string) {
  return { headers: { authorization } } as Parameters<ReturnType<typeof requireInternalCaller>>[0];
}

function fakeReply() {
  const calls = { code: undefined as number | undefined, headers: {} as Record<string, string> };
  const reply = {
    code(code: number) {
      calls.code = code;
      return reply;
    },
    header(name: string, value: string) {
      calls.headers[name] = value;
      return reply;
    },
    async send(_body: unknown) {
      return reply;
    },
  };
  return {
    reply: reply as unknown as Parameters<ReturnType<typeof requireInternalCaller>>[1],
    calls,
  };
}

describe('requireInternalCaller', () => {
  const KERNEL = 'the-kernel-credential-for-worker-supervisor';
  const AGENT_HOST = 'the-agent-host-credential-for-worker-supervisor';
  const TOKENS = { kernel: KERNEL, 'agent-host': AGENT_HOST };

  it('passes through (no reply.code call) when the presented token is an allowed caller’s', async () => {
    for (const [allowed, token] of [
      [['kernel'], KERNEL],
      [['agent-host'], AGENT_HOST],
      [['agent-host', 'kernel'], KERNEL],
      [['agent-host', 'kernel'], AGENT_HOST],
    ] as const) {
      const guard = requireInternalCaller(TOKENS, allowed);
      const { reply, calls } = fakeReply();
      await guard(fakeRequest(`Bearer ${token}`), reply);
      expect(calls.code, `${token} on ${allowed.join(',')}`).toBeUndefined();
    }
  });

  it('401s a valid credential of a caller the route does not admit (R-03)', async () => {
    for (const [allowed, token] of [
      [['kernel'], AGENT_HOST],
      [['agent-host'], KERNEL],
    ] as const) {
      const guard = requireInternalCaller(TOKENS, allowed);
      const { reply, calls } = fakeReply();
      await guard(fakeRequest(`Bearer ${token}`), reply);
      expect(calls.code).toBe(401);
    }
  });

  it('401s when no Authorization header is presented', async () => {
    const guard = requireInternalCaller(TOKENS, ['kernel']);
    const { reply, calls } = fakeReply();
    await guard(fakeRequest(undefined), reply);
    expect(calls.code).toBe(401);
    expect(calls.headers['www-authenticate']).toBe('Bearer');
  });

  it('401s when the presented token does not match', async () => {
    const guard = requireInternalCaller(TOKENS, ['agent-host', 'kernel']);
    const { reply, calls } = fakeReply();
    await guard(fakeRequest('Bearer wrong-token'), reply);
    expect(calls.code).toBe(401);
  });

  it('401s a non-Bearer scheme', async () => {
    const guard = requireInternalCaller(TOKENS, ['kernel']);
    const { reply, calls } = fakeReply();
    await guard(fakeRequest(`Basic ${KERNEL}`), reply);
    expect(calls.code).toBe(401);
  });

  it('fails closed: a caller with no configured token matches nothing, even with a header', async () => {
    const guard = requireInternalCaller({}, ['agent-host', 'kernel']);
    const { reply, calls } = fakeReply();
    await guard(fakeRequest(`Bearer ${KERNEL}`), reply);
    expect(calls.code).toBe(401);
  });

  it('rejects a token of a different length without throwing (constant-time compare guard)', async () => {
    const guard = requireInternalCaller(TOKENS, ['kernel']);
    const { reply, calls } = fakeReply();
    await guard(fakeRequest('Bearer short'), reply);
    expect(calls.code).toBe(401);
  });
});
