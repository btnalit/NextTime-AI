import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from 'undici';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildTlsFetch, gateTlsOptionsFromEnv, insecureTlsEnvWarning } from './tls.js';

const dir = mkdtempSync(join(tmpdir(), 'gate-tls-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('gateTlsOptionsFromEnv', () => {
  it('is undefined when neither GATE_TLS_* var is set (no override, system trust store)', () => {
    expect(gateTlsOptionsFromEnv({})).toBeUndefined();
    expect(
      gateTlsOptionsFromEnv({ GATE_TLS_CA_FILE: '  ', GATE_TLS_SERVERNAME: '' }),
    ).toBeUndefined();
  });

  it('carries each var independently', () => {
    expect(gateTlsOptionsFromEnv({ GATE_TLS_CA_FILE: '/x/ca.pem' })).toEqual({
      caFile: '/x/ca.pem',
    });
    expect(gateTlsOptionsFromEnv({ GATE_TLS_SERVERNAME: 'ragflow-local' })).toEqual({
      servername: 'ragflow-local',
    });
  });
});

describe('insecureTlsEnvWarning', () => {
  it('warns only for the literal kill switch value', () => {
    expect(insecureTlsEnvWarning({})).toBeUndefined();
    expect(insecureTlsEnvWarning({ NODE_TLS_REJECT_UNAUTHORIZED: '1' })).toBeUndefined();
    expect(insecureTlsEnvWarning({ NODE_TLS_REJECT_UNAUTHORIZED: '0' })).toMatch(
      /GATE_TLS_CA_FILE/,
    );
  });
});

describe('buildTlsFetch', () => {
  it('reads the CA file and hands every request an undici Agent as dispatcher, preserving init', async () => {
    const caFile = join(dir, 'ca.pem');
    writeFileSync(caFile, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
    const baseFetch = vi.fn(
      async (_input: unknown, _init?: unknown) => new Response('ok', { status: 200 }),
    );

    const tlsFetch = buildTlsFetch(
      { caFile, servername: 'ragflow-local' },
      baseFetch as unknown as Parameters<typeof buildTlsFetch>[1],
    );
    const response = await tlsFetch('https://198.51.100.10/api', {
      method: 'POST',
      headers: { authorization: 'Bearer x' },
    });

    expect(response.status).toBe(200);
    expect(baseFetch).toHaveBeenCalledTimes(1);
    const init = baseFetch.mock.calls[0]?.[1] as {
      method: string;
      headers: unknown;
      dispatcher: unknown;
    };
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ authorization: 'Bearer x' });
    expect(init.dispatcher).toBeInstanceOf(Agent);
  });

  it('fails at construction when the CA file is unreadable (never silently falls back)', () => {
    expect(() => buildTlsFetch({ caFile: join(dir, 'missing.pem') })).toThrow(/ENOENT/);
  });
});
