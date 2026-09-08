import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { InMemoryIdempotencyStore } from './idempotency-store.js';
import {
  GatekeeperBase,
  VERSION,
  createGatekeeperServer,
  loadSshPolicyTable,
  parseSshPort,
} from './index.js';
import type { Transport } from './kinds/index.js';

describe('@nexttime/gatekeeper-base', () => {
  it('exposes a semantic version', () => {
    expect(VERSION).toBe('0.1.0');
  });

  it('exports GatekeeperBase and createGatekeeperServer end-to-end for a trivial gate', async () => {
    const fakeTransport: Transport = {
      kind: 'http',
      async invoke() {
        return { data: { ok: true } };
      },
    };
    const gate = new GatekeeperBase({
      manifest: [
        {
          name: 'ping',
          binding: { kind: 'http', method: 'GET', path: '/ping' },
          params_schema: {},
          mode: 'observe',
          blast_radius: 'low',
          reversibility: false,
          auto_approvable: true,
          await_decision: false,
          reads: [],
          writes: [],
        },
      ],
      transport: fakeTransport,
      credentialResolver: { resolve: async () => ({}) },
      idempotencyStore: new InMemoryIdempotencyStore(),
    });

    const app = createGatekeeperServer({ gate, token: 'test-token-0123456789abcdef0123456789' });
    const response = await app.inject({
      method: 'GET',
      url: '/gate/describe_operations',
      headers: { authorization: 'Bearer test-token-0123456789abcdef0123456789' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.result.operations).toHaveLength(1);
    await app.close();
  });
});

describe('parseSshPort (review lane 5, P3 batch)', () => {
  it('returns undefined when unset or empty', () => {
    expect(parseSshPort(undefined)).toBeUndefined();
    expect(parseSshPort('')).toBeUndefined();
  });

  it('parses a valid port', () => {
    expect(parseSshPort('22')).toBe(22);
    expect(parseSshPort('65535')).toBe(65535);
  });

  it('throws for a non-numeric value instead of silently producing NaN', () => {
    expect(() => parseSshPort('not-a-port')).toThrow(/GATE_SSH_PORT/);
  });

  it('throws for an out-of-range or non-integer value', () => {
    expect(() => parseSshPort('0')).toThrow(/GATE_SSH_PORT/);
    expect(() => parseSshPort('70000')).toThrow(/GATE_SSH_PORT/);
    expect(() => parseSshPort('22.5')).toThrow(/GATE_SSH_PORT/);
  });
});

describe('loadSshPolicyTable (review lane 5, P3 batch)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-ssh-policy-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('returns [] when unset', async () => {
    expect(await loadSshPolicyTable(undefined)).toEqual([]);
  });

  it('parses inline JSON when the value starts with "[" (backward compat, e.g. accept-s2-ssh-gate)', async () => {
    expect(await loadSshPolicyTable('[]')).toEqual([]);
    const rule = [{ pattern: '^show', mode: 'observe', blastRadius: 'low', autoApprovable: true }];
    expect(await loadSshPolicyTable(JSON.stringify(rule))).toEqual(rule);
  });

  it('reads the policy table from a file path when the value is not inline JSON', async () => {
    const file = join(dir, 'policy.json');
    const rule = [{ pattern: '^show', mode: 'observe', blastRadius: 'low', autoApprovable: true }];
    writeFileSync(file, JSON.stringify(rule));
    expect(await loadSshPolicyTable(file)).toEqual(rule);
  });
});
