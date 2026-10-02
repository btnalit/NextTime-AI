import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  INTERNAL_TOKEN_FILE_ENV,
  InternalTokenError,
  SUPERVISOR_TOKEN_FILE_ENV,
} from '@nexttime/shared';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  INTERNAL_PLANE_ROUTE_PREFIX,
  INTERNAL_ROUTE_CALLERS,
  type InternalCaller,
  deriveInternalCredential,
  loadInternalToken,
  loadSupervisorToken,
  registerInternalPlaneGuard,
} from './internal-auth.js';

/**
 * interfaces/internal-auth/internal-auth.test: the guard on a bare Fastify instance with internal
 * and non-internal routes (Fastify `inject`, no network, no database), plus the token loaders
 * against temp files. The composition-root wiring (`createServer`'s `internalAuth` option) is
 * covered by packages/kernel/src/index.test.ts, the WebSocket upgrade by
 * interfaces/ws/agent-host.test.ts.
 */

/** The root. Presented as-is it identifies the `kernel` caller, which the first describe's test
 *  routes admit — those tests are about the credential checks, not the allow-list. */
const TOKEN = randomBytes(32).toString('hex');
const UNAUTHORIZED = { ok: false, error: { code: 'unauthorized', message: 'unauthorized' } };
const TEST_ROUTE_CALLERS: Readonly<Record<string, readonly InternalCaller[]>> = {
  [`${INTERNAL_PLANE_ROUTE_PREFIX}ping`]: ['kernel'],
  [`${INTERNAL_PLANE_ROUTE_PREFIX}echo`]: ['kernel'],
};

interface LogLine {
  level?: number;
  msg?: string;
  reason?: string;
  route?: string;
  peer?: string;
  [key: string]: unknown;
}

function captureLogs(): { lines: LogLine[]; stream: { write(chunk: string): void } } {
  const lines: LogLine[] = [];
  return {
    lines,
    stream: {
      write(chunk: string): void {
        for (const raw of chunk.split('\n')) {
          if (raw.trim().length > 0) lines.push(JSON.parse(raw) as LogLine);
        }
      },
    },
  };
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function buildApp(
  config: Parameters<typeof registerInternalPlaneGuard>[1],
  logStream?: { write(chunk: string): void },
): Promise<FastifyInstance> {
  const instance = Fastify(logStream ? { logger: { level: 'warn', stream: logStream } } : {});
  registerInternalPlaneGuard(instance, config, TEST_ROUTE_CALLERS);
  instance.get(`${INTERNAL_PLANE_ROUTE_PREFIX}ping`, async () => ({ ok: true, result: 'pong' }));
  instance.post(`${INTERNAL_PLANE_ROUTE_PREFIX}echo`, async (request) => ({
    ok: true,
    result: request.body,
  }));
  instance.get('/api/health', async () => ({ status: 'ok' }));
  await instance.ready();
  return instance;
}

describe('registerInternalPlaneGuard', () => {
  it('401s an internal route with no Authorization header', async () => {
    app = await buildApp({ token: TOKEN });
    const res = await app.inject({ method: 'GET', url: '/internal/ping' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual(UNAUTHORIZED);
    expect(res.headers['www-authenticate']).toBe('Bearer');
  });

  it('401s a wrong token, a wrong scheme, and an empty bearer value', async () => {
    app = await buildApp({ token: TOKEN });
    for (const authorization of [
      `Bearer ${randomBytes(32).toString('hex')}`, // same length, different value
      `Bearer ${TOKEN.slice(0, -1)}`, // shorter
      `Bearer ${TOKEN}x`, // longer
      `Basic ${TOKEN}`,
      'Bearer ',
      TOKEN,
    ]) {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/ping',
        headers: { authorization },
      });
      expect(res.statusCode, authorization).toBe(401);
      expect(res.json()).toEqual(UNAUTHORIZED);
    }
  });

  it('never echoes the presented or expected token in the response or the log', async () => {
    const logs = captureLogs();
    app = await buildApp({ token: TOKEN }, logs.stream);
    const presented = `${TOKEN.slice(0, -1)}Z`;
    const res = await app.inject({
      method: 'GET',
      url: '/internal/ping',
      headers: { authorization: `Bearer ${presented}` },
    });
    expect(res.statusCode).toBe(401);
    const everything = `${res.body}\n${JSON.stringify(logs.lines)}`;
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain(presented);
    const rejected = logs.lines.find((line) => line.msg === 'internal plane: request rejected');
    expect(rejected).toMatchObject({ reason: 'invalid_token', route: '/internal/ping' });
  });

  it('200s with the right token (scheme case-insensitive) and does not touch non-internal routes', async () => {
    app = await buildApp({ token: TOKEN });
    const ok = await app.inject({
      method: 'GET',
      url: '/internal/ping',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true, result: 'pong' });

    const lowercaseScheme = await app.inject({
      method: 'GET',
      url: '/internal/ping',
      headers: { authorization: `bearer ${TOKEN}` },
    });
    expect(lowercaseScheme.statusCode).toBe(200);

    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok' });
  });

  it('rejects before the body is parsed (an unauthenticated POST with a malformed body is 401, not 400)', async () => {
    app = await buildApp({ token: TOKEN });
    const res = await app.inject({
      method: 'POST',
      url: '/internal/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a peer inside the workers subnet even with the right token', async () => {
    const logs = captureLogs();
    app = await buildApp({ token: TOKEN, workersSubnet: '203.0.113.0/24' }, logs.stream);

    const fromWorker = await app.inject({
      method: 'GET',
      url: '/internal/ping',
      headers: { authorization: `Bearer ${TOKEN}` },
      remoteAddress: '203.0.113.42',
    });
    expect(fromWorker.statusCode).toBe(401);
    expect(fromWorker.json()).toEqual(UNAUTHORIZED);
    expect(logs.lines.find((l) => l.msg === 'internal plane: request rejected')).toMatchObject({
      reason: 'workers_subnet_peer',
      peer: '203.0.113.42',
    });

    const fromControl = await app.inject({
      method: 'GET',
      url: '/internal/ping',
      headers: { authorization: `Bearer ${TOKEN}` },
      remoteAddress: '198.51.100.5',
    });
    expect(fromControl.statusCode).toBe(200);
  });

  it('a workers-subnet peer without the token is reported as missing_token, not as a subnet leak', async () => {
    const logs = captureLogs();
    app = await buildApp({ token: TOKEN, workersSubnet: '203.0.113.0/24' }, logs.stream);
    const res = await app.inject({
      method: 'GET',
      url: '/internal/ping',
      remoteAddress: '203.0.113.42',
    });
    expect(res.statusCode).toBe(401);
    expect(logs.lines.at(-1)).toMatchObject({ reason: 'missing_token' });
  });

  it('is fail-closed when no config is given: every internal request is 401 and a startup warn is logged', async () => {
    const logs = captureLogs();
    app = await buildApp(undefined, logs.stream);
    const res = await app.inject({
      method: 'GET',
      url: '/internal/ping',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual(UNAUTHORIZED);
    expect(logs.lines.some((l) => String(l.msg).includes('no root token configured'))).toBe(true);
    expect(logs.lines.at(-1)).toMatchObject({ reason: 'no_token_configured' });

    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
  });

  it('throws at registration for a malformed workers subnet instead of running without the rule', () => {
    const instance = Fastify();
    expect(() =>
      registerInternalPlaneGuard(instance, { token: TOKEN, workersSubnet: 'not-a-cidr' }),
    ).toThrow(/invalid CIDR/);
  });
});

/** Every caller whose credential the host derives from the root (scripts/derive-internal-tokens.sh). */
const DERIVED: readonly Exclude<InternalCaller, 'kernel'>[] = [
  'agent-host',
  'llm-proxy',
  'egress-proxy',
  'gate',
  'gate-host',
];

/** The production allow-list on a bare instance: one stub handler per listed route pattern (the
 *  WebSocket one included — the guard decides on the upgrade request before any handler runs). */
async function buildProductionTableApp(logStream?: {
  write(chunk: string): void;
}): Promise<FastifyInstance> {
  const instance = Fastify(logStream ? { logger: { level: 'warn', stream: logStream } } : {});
  registerInternalPlaneGuard(instance, { token: TOKEN });
  for (const route of Object.keys(INTERNAL_ROUTE_CALLERS)) {
    instance.post(route, async () => ({ ok: true, result: route }));
  }
  await instance.ready();
  return instance;
}

function credentialOf(caller: InternalCaller): string {
  return caller === 'kernel' ? TOKEN : deriveInternalCredential(TOKEN, caller);
}

describe('per-caller credentials and the per-route allow-list (R-03)', () => {
  it('derives the same credential scripts/derive-internal-tokens.sh does (openssl dgst -sha256 -hmac <label> over the root)', () => {
    // Known answer, computed with: printf %s <64 zeros> | openssl dgst -sha256 -hmac 'nexttime-internal:gate-host->kernel'
    expect(deriveInternalCredential('0'.repeat(64), 'gate-host')).toBe(
      'dd562c30dcc116bbd7034a083920be13b6be96a2ccb810382a236934561617dc',
    );
    const all = DERIVED.map((caller) => deriveInternalCredential(TOKEN, caller));
    expect(new Set([...all, TOKEN]).size).toBe(DERIVED.length + 1);
    expect(deriveInternalCredential(randomBytes(32).toString('hex'), 'agent-host')).not.toBe(
      deriveInternalCredential(TOKEN, 'agent-host'),
    );
  });

  it('admits each caller exactly on the routes listed for it, and refuses it everywhere else', async () => {
    app = await buildProductionTableApp();
    for (const caller of ['kernel', ...DERIVED] as const) {
      for (const [route, allowed] of Object.entries(INTERNAL_ROUTE_CALLERS)) {
        const res = await app.inject({
          method: 'POST',
          url: route,
          headers: { authorization: `Bearer ${credentialOf(caller)}` },
        });
        expect(res.statusCode, `${caller} on ${route}`).toBe(allowed.includes(caller) ? 200 : 401);
      }
    }
  });

  it('pins the allow-list itself: who may call what', () => {
    expect(INTERNAL_ROUTE_CALLERS).toEqual({
      '/internal/agent-host': ['agent-host'],
      '/internal/llm-usage': ['llm-proxy'],
      '/internal/llm-budget-exhausted': ['llm-proxy'],
      '/internal/handle-revocations': ['llm-proxy'],
      '/internal/llm-admin-audit': ['llm-proxy'],
      '/internal/egress': ['egress-proxy'],
      '/internal/gates/announce': ['gate', 'gate-host'],
      '/internal/gate-host/instances': ['gate-host'],
      '/internal/metrics': ['kernel'],
    });
  });

  it('refuses a gate credential on the agent-host link, llm-usage and llm-admin-audit, logging route_not_allowed with the caller and no token', async () => {
    const logs = captureLogs();
    app = await buildProductionTableApp(logs.stream);
    for (const gate of ['gate', 'gate-host'] as const) {
      for (const route of [
        '/internal/agent-host',
        '/internal/llm-usage',
        '/internal/llm-admin-audit',
        '/internal/egress',
      ]) {
        const res = await app.inject({
          method: 'POST',
          url: route,
          headers: { authorization: `Bearer ${credentialOf(gate)}` },
        });
        expect(res.statusCode, `${gate} on ${route}`).toBe(401);
        expect(res.json()).toEqual(UNAUTHORIZED);
      }
    }
    const rejected = logs.lines.filter((l) => l.msg === 'internal plane: request rejected');
    expect(rejected[0]).toMatchObject({
      reason: 'route_not_allowed',
      caller: 'gate',
      route: '/internal/agent-host',
    });
    const everything = JSON.stringify(logs.lines);
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain(credentialOf('gate'));
  });

  it('refuses the root (the old shared token) on every service route — it identifies only the kernel, for /internal/metrics', async () => {
    app = await buildProductionTableApp();
    for (const route of Object.keys(INTERNAL_ROUTE_CALLERS)) {
      const res = await app.inject({
        method: 'POST',
        url: route,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode, route).toBe(route === '/internal/metrics' ? 200 : 401);
    }
  });

  it('refuses a credential derived from a different root as invalid_token', async () => {
    const logs = captureLogs();
    app = await buildProductionTableApp(logs.stream);
    const res = await app.inject({
      method: 'POST',
      url: '/internal/llm-usage',
      headers: {
        authorization: `Bearer ${deriveInternalCredential(randomBytes(32).toString('hex'), 'llm-proxy')}`,
      },
    });
    expect(res.statusCode).toBe(401);
    expect(logs.lines.at(-1)).toMatchObject({ reason: 'invalid_token' });
    expect(logs.lines.at(-1)?.caller).toBeUndefined();
  });

  it('still applies the workers-subnet rule to a valid derived credential', async () => {
    app = Fastify();
    registerInternalPlaneGuard(app, { token: TOKEN, workersSubnet: '203.0.113.0/24' });
    app.post('/internal/llm-usage', async () => ({ ok: true }));
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/internal/llm-usage',
      headers: { authorization: `Bearer ${credentialOf('llm-proxy')}` },
      remoteAddress: '203.0.113.9',
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses to register an /internal/ route that has no allow-list entry', async () => {
    const instance = Fastify();
    registerInternalPlaneGuard(instance, { token: TOKEN });
    expect(() => instance.get('/internal/unlisted', async () => ({ ok: true }))).toThrow(
      /no caller allow-list entry/,
    );
    instance.get('/api/elsewhere', async () => ({ ok: true })); // outside the plane: untouched
    await instance.close();
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
    dir = mkdtempSync(join(tmpdir(), 'nexttime-internal-token-'));
    const file = join(dir, 'internal.token');
    writeFileSync(file, contents, 'utf8');
    return file;
  }

  it('reads and trims the token from the file named by the env var', () => {
    const file = tokenFile(`${TOKEN}\n`);
    expect(loadInternalToken({ [INTERNAL_TOKEN_FILE_ENV]: file })).toBe(TOKEN);
  });

  it('fails with InternalTokenError naming the path and env var when the file is missing', () => {
    const missing = join(tmpdir(), 'nexttime-internal-token-does-not-exist', 'internal.token');
    let caught: unknown;
    try {
      loadInternalToken({ [INTERNAL_TOKEN_FILE_ENV]: missing });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InternalTokenError);
    expect((caught as Error).message).toContain(missing);
    expect((caught as Error).message).toContain(INTERNAL_TOKEN_FILE_ENV);
    expect((caught as Error).message).toContain('gen-handle-keys.sh');
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

  it('loadSupervisorToken reads the kernel credential for worker-supervisor from its own file, naming that file when it is missing', () => {
    const supervisorToken = randomBytes(32).toString('hex');
    const file = tokenFile(`${supervisorToken}\n`);
    expect(loadSupervisorToken({ [SUPERVISOR_TOKEN_FILE_ENV]: file })).toBe(supervisorToken);
    let caught: unknown;
    try {
      loadSupervisorToken({ [SUPERVISOR_TOKEN_FILE_ENV]: join(tmpdir(), 'nexttime-no-such', 'f') });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InternalTokenError);
    expect((caught as Error).message).toContain(SUPERVISOR_TOKEN_FILE_ENV);
    expect((caught as Error).message).toContain('internal_kernel_to_worker_supervisor');
  });
});
