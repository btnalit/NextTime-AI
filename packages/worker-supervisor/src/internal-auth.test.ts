import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INTERNAL_TOKEN_FILE_ENV, InternalTokenError } from '@nexttime/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { loadInternalToken, requireInternalToken } from './internal-auth.js';

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

// Minimal fake FastifyRequest/FastifyReply — requireInternalToken only reads
// `request.headers.authorization` and calls `reply.code`/`reply.header`/`reply.send`.
function fakeRequest(authorization?: string) {
  return { headers: { authorization } } as Parameters<ReturnType<typeof requireInternalToken>>[0];
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
    reply: reply as unknown as Parameters<ReturnType<typeof requireInternalToken>>[1],
    calls,
  };
}

describe('requireInternalToken', () => {
  const TOKEN = 'the-configured-internal-token';

  it('passes through (no reply.code call) when the presented token matches', async () => {
    const guard = requireInternalToken(TOKEN);
    const { reply, calls } = fakeReply();
    await guard(fakeRequest(`Bearer ${TOKEN}`), reply);
    expect(calls.code).toBeUndefined();
  });

  it('401s when no Authorization header is presented', async () => {
    const guard = requireInternalToken(TOKEN);
    const { reply, calls } = fakeReply();
    await guard(fakeRequest(undefined), reply);
    expect(calls.code).toBe(401);
    expect(calls.headers['www-authenticate']).toBe('Bearer');
  });

  it('401s when the presented token does not match', async () => {
    const guard = requireInternalToken(TOKEN);
    const { reply, calls } = fakeReply();
    await guard(fakeRequest('Bearer wrong-token'), reply);
    expect(calls.code).toBe(401);
  });

  it('401s a non-Bearer scheme', async () => {
    const guard = requireInternalToken(TOKEN);
    const { reply, calls } = fakeReply();
    await guard(fakeRequest(`Basic ${TOKEN}`), reply);
    expect(calls.code).toBe(401);
  });

  it('fails closed: an undefined configured token rejects every request, even with a header', async () => {
    const guard = requireInternalToken(undefined);
    const { reply, calls } = fakeReply();
    await guard(fakeRequest(`Bearer ${TOKEN}`), reply);
    expect(calls.code).toBe(401);
  });

  it('rejects a token of a different length without throwing (constant-time compare guard)', async () => {
    const guard = requireInternalToken(TOKEN);
    const { reply, calls } = fakeReply();
    await guard(fakeRequest('Bearer short'), reply);
    expect(calls.code).toBe(401);
  });
});
