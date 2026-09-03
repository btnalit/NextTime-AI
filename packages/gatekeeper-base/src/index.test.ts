import { describe, expect, it } from 'vitest';
import { InMemoryIdempotencyStore } from './idempotency-store.js';
import { GatekeeperBase, VERSION, createGatekeeperServer } from './index.js';
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

    const app = createGatekeeperServer({ gate });
    const response = await app.inject({ method: 'GET', url: '/gate/describe_operations' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.result.operations).toHaveLength(1);
    await app.close();
  });
});
