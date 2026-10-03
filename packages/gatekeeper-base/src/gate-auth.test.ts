import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createGateAuthGuard,
  loadGateKernelToken,
  resolveGateKernelTokenFile,
} from './gate-auth.js';
import { GateTokenError } from './gate-token.js';
import { GatekeeperBase } from './gatekeeper-base.js';
import { InMemoryIdempotencyStore } from './idempotency-store.js';
import type { Transport } from './kinds/types.js';
import { createGatekeeperServer } from './server.js';

const dir = mkdtempSync(join(tmpdir(), 'gate-auth-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('resolveGateKernelTokenFile', () => {
  it('defaults to /run/secrets/gate_token', () => {
    expect(resolveGateKernelTokenFile({})).toBe('/run/secrets/gate_token');
  });

  it('honours GATE_KERNEL_TOKEN_FILE when set', () => {
    expect(resolveGateKernelTokenFile({ GATE_KERNEL_TOKEN_FILE: '/x/token' })).toBe('/x/token');
  });
});

describe('loadGateKernelToken', () => {
  it('reads, trims, and validates the token file', () => {
    const file = join(dir, 'good.token');
    writeFileSync(file, `${'a'.repeat(40)}\n`);
    expect(loadGateKernelToken({ GATE_KERNEL_TOKEN_FILE: file })).toBe('a'.repeat(40));
  });

  it('throws GateTokenError when the file is missing (this gate refuses to start)', () => {
    expect(() =>
      loadGateKernelToken({ GATE_KERNEL_TOKEN_FILE: join(dir, 'missing.token') }),
    ).toThrow(GateTokenError);
  });

  it('throws GateTokenError for a too-short token', () => {
    const file = join(dir, 'short.token');
    writeFileSync(file, 'too-short\n');
    expect(() => loadGateKernelToken({ GATE_KERNEL_TOKEN_FILE: file })).toThrow(GateTokenError);
  });
});

// R-01 / maintainer decision D-01 (2026-10-02 review): a self-connected gate built on this package
// is configured with its own per-connection secret (the kernel's `mint_connection_secret`, copied
// into GATE_KERNEL_TOKEN_FILE) — never the platform gate token. The gate accepts exactly that
// secret: the platform token, and any other connection's secret, are 401.
describe('a self-connected gate configured with its own connection secret', () => {
  const connectionSecret = `ntgc1_${'1'.repeat(32)}_${'2'.repeat(64)}`;
  const otherConnectionSecret = `ntgc1_${'3'.repeat(32)}_${'4'.repeat(64)}`;
  const platformToken = 'p'.repeat(64);

  async function gate() {
    const file = join(dir, 'connection.token');
    writeFileSync(file, `${connectionSecret}\n`);
    const token = loadGateKernelToken({ GATE_KERNEL_TOKEN_FILE: file });
    const gateBase = new GatekeeperBase({
      manifest: [],
      transport: {
        kind: 'http',
        invoke: async () => ({ data: null }),
        simulate: async () => ({ description: 'noop' }),
      } as unknown as Transport,
      credentialResolver: { resolve: async () => ({}) },
      idempotencyStore: new InMemoryIdempotencyStore(),
    });
    return createGatekeeperServer({ gate: gateBase, token });
  }

  async function health(app: Awaited<ReturnType<typeof gate>>, bearer: string) {
    return app.inject({
      method: 'GET',
      url: '/gate/health',
      headers: { authorization: `Bearer ${bearer}` },
    });
  }

  it('accepts its connection secret and refuses the platform token and other secrets', async () => {
    const app = await gate();
    try {
      expect((await health(app, connectionSecret)).statusCode).toBe(200);
      expect((await health(app, platformToken)).statusCode).toBe(401);
      expect((await health(app, otherConnectionSecret)).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe('createGateAuthGuard', () => {
  const guard = createGateAuthGuard('a'.repeat(40));

  function req(authorization: string | undefined) {
    return { headers: { authorization } } as unknown as Parameters<typeof guard.evaluate>[0];
  }

  it('allows the exact Bearer token', () => {
    expect(guard.evaluate(req(`Bearer ${'a'.repeat(40)}`))).toBe(true);
  });

  it('rejects a missing header', () => {
    expect(guard.evaluate(req(undefined))).toBe(false);
  });

  it('rejects a wrong token', () => {
    expect(guard.evaluate(req(`Bearer ${'b'.repeat(40)}`))).toBe(false);
  });

  it('rejects a non-Bearer scheme', () => {
    expect(guard.evaluate(req(`Basic ${'a'.repeat(40)}`))).toBe(false);
  });

  it('rejects a token of different length without throwing', () => {
    expect(guard.evaluate(req('Bearer short'))).toBe(false);
  });
});
