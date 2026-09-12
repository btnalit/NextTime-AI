import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Operation } from '@nexttime/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { buildAnnounceBody, createAnnouncer } from './announce.js';

const dir = mkdtempSync(join(tmpdir(), 'gate-announce-'));
const tokenFile = join(dir, 'internal_token');
const TOKEN = 'announce-test-internal-token-0123456789abcdef0123456789';
writeFileSync(tokenFile, `${TOKEN}\n`);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const manifest: Operation[] = [
  {
    name: 'ping',
    binding: { kind: 'http', method: 'GET', path: '/ping' },
    params_schema: { type: 'object', properties: {} },
    mode: 'observe',
    blast_radius: 'low',
    reversibility: false,
    auto_approvable: true,
    await_decision: false,
    reads: [],
    writes: [],
  },
];

const baseEnv: NodeJS.ProcessEnv = {
  GATE_ID: 'gate-a',
  GATE_CONNECTOR: 'docker',
  KERNEL_URL: 'http://kernel:8080/',
  GATE_INTERNAL_TOKEN_FILE: tokenFile,
  GATE_PORT: '8083',
  GATE_SERVICE_NAME: 'gatekeeper-docker',
  DOCKER_HOST: 'tcp://docker-socket-proxy-gate:2375',
};

function fakeFetch(responses: Array<{ status: number; body?: unknown } | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift() ?? { status: 200, body: { ok: true } };
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('gatekeeper-base announce (P-B1 self-registration)', () => {
  it('is a no-op when GATE_ID / GATE_CONNECTOR are absent', async () => {
    const logs: string[] = [];
    const announcer = createAnnouncer({ env: {}, manifest, log: (l) => logs.push(l) });
    expect(await announcer.announceOnce()).toBe(false);
    expect(logs.join('\n')).toContain('self-registration off');
  });

  it('refuses a half-configured or malformed identity at startup', () => {
    expect(() => buildAnnounceBody({ GATE_ID: 'gate-a' }, manifest)).toThrow(/KERNEL_URL/);
    expect(() => buildAnnounceBody({ ...baseEnv, GATE_ID: 'Bad Id' }, manifest)).toThrow(/GATE_ID/);
    expect(() => buildAnnounceBody({ ...baseEnv, GATE_CONNECTOR: 'Docker!' }, manifest)).toThrow(
      /GATE_CONNECTOR/,
    );
  });

  it('builds the body from env: endpoint from service name + port, target from DOCKER_HOST', () => {
    const body = buildAnnounceBody(baseEnv, manifest);
    expect(body).toMatchObject({
      gateId: 'gate-a',
      connector: 'docker',
      transportKind: 'http',
      target: 'tcp://docker-socket-proxy-gate:2375',
      endpoint: 'http://gatekeeper-docker:8083',
      healthEndpoint: 'http://gatekeeper-docker:8083/gate/health',
      displayName: 'gate-a',
    });
    expect(body?.operations).toEqual(manifest);
    const ragflow = buildAnnounceBody(
      { ...baseEnv, DOCKER_HOST: undefined, RAGFLOW_BASE_URL: 'https://ragflow.local' },
      manifest,
    );
    expect(ragflow?.target).toBe('https://ragflow.local');
  });

  it('posts to /internal/gates/announce with the bearer token and never logs it', async () => {
    const logs: string[] = [];
    const { impl, calls } = fakeFetch([{ status: 200, body: { ok: true } }]);
    const announcer = createAnnouncer({
      env: baseEnv,
      manifest,
      fetchImpl: impl,
      log: (l) => logs.push(l),
    });
    expect(await announcer.announceOnce()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://kernel:8080/internal/gates/announce');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ gateId: 'gate-a' });
    expect(logs.join('\n')).not.toContain(TOKEN);
  });

  it('backs off until the first success, then heartbeats at the interval', async () => {
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    const setTimeoutImpl = ((fn: () => void, ms: number) => {
      scheduled.push({ fn, ms });
      return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    const clearTimeoutImpl = (() => {}) as unknown as typeof clearTimeout;
    const { impl, calls } = fakeFetch([
      new Error('ECONNREFUSED'),
      { status: 503, body: { ok: false, error: { code: 'unavailable' } } },
      { status: 200, body: { ok: true } },
      { status: 200, body: { ok: true } },
    ]);
    const logs: string[] = [];
    const announcer = createAnnouncer({
      env: { ...baseEnv, GATE_ANNOUNCE_INTERVAL_SEC: '60' },
      manifest,
      fetchImpl: impl,
      setTimeoutImpl,
      clearTimeoutImpl,
      log: (l) => logs.push(l),
    });
    async function runNext(): Promise<void> {
      // the request timeout timer is scheduled too — pick the announce timer (not 5000 ms)
      const idx = scheduled.findIndex((s) => s.ms !== 5_000);
      const [next] = scheduled.splice(idx, 1);
      next?.fn();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    }
    announcer.start();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(calls).toHaveLength(1); // failed: ECONNREFUSED → backoff 1 s
    expect(scheduled.filter((s) => s.ms !== 5_000).map((s) => s.ms)).toEqual([1_000]);
    await runNext(); // 503 → backoff 2 s
    expect(calls).toHaveLength(2);
    expect(scheduled.filter((s) => s.ms !== 5_000).map((s) => s.ms)).toEqual([2_000]);
    await runNext(); // 200 → registered, heartbeat 60 s
    expect(calls).toHaveLength(3);
    expect(scheduled.filter((s) => s.ms !== 5_000).map((s) => s.ms)).toEqual([60_000]);
    expect(logs.join('\n')).toContain('registered with the kernel');
    await runNext(); // heartbeat
    expect(calls).toHaveLength(4);
    expect(scheduled.filter((s) => s.ms !== 5_000).map((s) => s.ms)).toEqual([60_000]);
    announcer.stop();
  });

  it('a 400 after registration is logged and keeps the heartbeat interval (no tight loop)', async () => {
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    const setTimeoutImpl = ((fn: () => void, ms: number) => {
      scheduled.push({ fn, ms });
      return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    const { impl } = fakeFetch([
      { status: 200, body: { ok: true } },
      { status: 400, body: { ok: false, error: { code: 'invalid_params' } } },
    ]);
    const logs: string[] = [];
    const announcer = createAnnouncer({
      env: baseEnv,
      manifest,
      fetchImpl: impl,
      setTimeoutImpl,
      clearTimeoutImpl: (() => {}) as unknown as typeof clearTimeout,
      log: (l) => logs.push(l),
    });
    announcer.start();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const heartbeat = scheduled.find((s) => s.ms === 60_000);
    heartbeat?.fn();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(logs.join('\n')).toContain('invalid_params');
    expect(scheduled.filter((s) => s.ms === 60_000)).toHaveLength(2);
    announcer.stop();
  });
});
