import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { platformGateIdForEndpoint, resolveGateTarget } from './gate-target.js';

/** A `PoolClient` stand-in whose only query (`gate_instances`) answers with `catalog`. */
function catalogClient(catalog: readonly { gate_id: string; endpoint: string }[]): PoolClient {
  return {
    query: async () => ({ rows: catalog, rowCount: catalog.length }),
  } as unknown as PoolClient;
}

const WORKSPACE = '11111111-2222-4333-8444-555555555555';
const SALT = '0'.repeat(32);
const CATALOG = [
  { gate_id: 'docker', endpoint: 'http://gatekeeper-docker:8083' },
  { gate_id: 'hosted-a', endpoint: 'http://gate-host:8083/i/hosted-a' },
];

describe('gate-target (R-01 / D-01: which credential a registered Gatekeeper gets)', () => {
  it('gives the platform credential only to an endpoint whose host a catalog instance announced', async () => {
    const client = catalogClient(CATALOG);
    await expect(
      resolveGateTarget(client, WORKSPACE, { endpoint: 'http://gatekeeper-docker:8083/' }),
    ).resolves.toEqual({
      endpoint: 'http://gatekeeper-docker:8083/',
      credential: { kind: 'platform' },
    });
    // Every /i/* under an announced gate-host covers hosted ids not announced yet.
    await expect(
      platformGateIdForEndpoint(client, 'http://gate-host:8083/i/another'),
    ).resolves.toBe('hosted-a');
    // A salt on a catalog address changes nothing — the catalog decides, not the Object.
    await expect(
      resolveGateTarget(client, WORKSPACE, {
        endpoint: 'http://gatekeeper-docker:8083',
        connectionSecretSalt: SALT,
      }),
    ).resolves.toMatchObject({ credential: { kind: 'platform' } });
  });

  it('gives a self-connected gate its connection credential, and one with no salt nothing', async () => {
    const client = catalogClient(CATALOG);
    await expect(
      resolveGateTarget(client, WORKSPACE, {
        endpoint: 'https://gate.owner.example',
        connectionSecretSalt: SALT,
      }),
    ).resolves.toEqual({
      endpoint: 'https://gate.owner.example',
      credential: { kind: 'connection', workspaceId: WORKSPACE, salt: SALT },
    });
    await expect(
      resolveGateTarget(client, WORKSPACE, { endpoint: 'https://gate.owner.example' }),
    ).resolves.toMatchObject({ credential: { kind: 'none' } });
    // A malformed salt is no salt.
    await expect(
      resolveGateTarget(client, WORKSPACE, {
        endpoint: 'https://gate.owner.example',
        connectionSecretSalt: 'not-a-salt',
      }),
    ).resolves.toMatchObject({ credential: { kind: 'none' } });
  });

  it('never matches an endpoint that is not a URL', async () => {
    await expect(
      platformGateIdForEndpoint(catalogClient(CATALOG), 'gatekeeper-docker'),
    ).resolves.toBeNull();
  });
});
