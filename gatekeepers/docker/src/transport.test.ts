import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GatekeeperBase, InMemoryIdempotencyStore } from '@nexttime/gatekeeper-base';
import type { Operation } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import {
  type FakeContainerSeed,
  createFakeDockerClient,
} from './test-support/fake-docker-client.js';
import { createDockerTransport } from './transport.js';

/**
 * Exercises the docker gate end-to-end through `GatekeeperBase` (the same entry points the real
 * Fastify server calls) with `createDockerTransport` over a fake `DockerClient` — never a real
 * socket. Covers: manifest wiring, result-mapping → Container facts, `simulate` for
 * `container.restart` and `compose.up/down`, and idempotent `apply` (task brief: "repeat with the
 * same idempotency key must not restart twice").
 */

const MANIFEST_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'manifest.json',
);
const MANIFEST = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Operation[];

function buildGate(seeds: readonly FakeContainerSeed[] = []) {
  const client = createFakeDockerClient(seeds);
  const transport = createDockerTransport(client);
  const gate = new GatekeeperBase({
    manifest: MANIFEST,
    transport,
    credentialResolver: { resolve: async () => ({}) },
    idempotencyStore: new InMemoryIdempotencyStore(),
  });
  return { gate, client };
}

describe('docker gate transport (via GatekeeperBase, fake dockerode)', () => {
  it('containers.list observes and maps every entry to a Container fact', async () => {
    const { gate } = buildGate([
      { id: 'c1', name: 'web', image: 'nginx:latest', running: true },
      { id: 'c2', name: 'db', image: 'postgres:17', running: false },
    ]);
    const result = await gate.observe('containers.list', { all: true });
    expect(result.observedFacts).toEqual([
      {
        objectType: 'Container',
        identity: { id: 'c1' },
        properties: { name: 'web', image: 'nginx:latest', state: 'running', status: 'Up 1 minute' },
      },
      {
        objectType: 'Container',
        identity: { id: 'c2' },
        properties: {
          name: 'db',
          image: 'postgres:17',
          state: 'exited',
          status: 'Exited (0) 1 minute ago',
        },
      },
    ]);
  });

  it('container.inspect observes one container and maps it to a single Container fact', async () => {
    const { gate } = buildGate([{ id: 'c1', name: 'web', image: 'nginx:latest', running: true }]);
    const result = await gate.observe('container.inspect', { id: 'c1' });
    expect(result.observedFacts).toEqual([
      {
        objectType: 'Container',
        identity: { id: 'c1' },
        properties: { name: 'web', image: 'nginx:latest', state: 'running', status: 'Up 1 minute' },
      },
    ]);
  });

  it('container.logs_tail observes tailed log text', async () => {
    const { gate } = buildGate([{ id: 'c1', name: 'web', image: 'nginx:latest', running: true }]);
    const result = await gate.observe('container.logs_tail', { id: 'c1', tail: 50 });
    expect(result.data).toMatchObject({ id: 'c1', tail: 50 });
  });

  it('simulate container.restart describes and lists the container that would be affected', async () => {
    const { gate } = buildGate([{ id: 'c1', name: 'web', image: 'nginx:latest', running: true }]);
    const result = await gate.simulate('container.restart', { id: 'c1' });
    expect(result.description).toContain('restart container "web"');
    expect(result.detail).toEqual({
      containers: [
        {
          id: 'c1',
          name: 'web',
          image: 'nginx:latest',
          state: 'running',
          status: 'Up 1 minute',
          labels: {},
        },
      ],
    });
  });

  it('apply container.restart is idempotent: a repeat apply with the same key does not restart twice', async () => {
    const { gate, client } = buildGate([
      { id: 'c1', name: 'web', image: 'nginx:latest', running: true },
    ]);

    const first = await gate.apply('container.restart', { id: 'c1' }, 'req-1');
    const second = await gate.apply('container.restart', { id: 'c1' }, 'req-1');

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.data).toEqual(first.data);
    expect(client.restartCalls).toEqual([{ id: 'c1', timeoutSeconds: 10 }]);
  });

  it('a different idempotency key does restart again', async () => {
    const { gate, client } = buildGate([
      { id: 'c1', name: 'web', image: 'nginx:latest', running: true },
    ]);
    await gate.apply('container.restart', { id: 'c1' }, 'req-1');
    await gate.apply('container.restart', { id: 'c1' }, 'req-2');
    expect(client.restartCalls).toHaveLength(2);
  });

  it('simulate compose.up lists only the stopped containers in the project', async () => {
    const { gate } = buildGate([
      {
        id: 'c1',
        name: 'app-web-1',
        image: 'app:latest',
        running: false,
        labels: { 'com.docker.compose.project': 'app' },
      },
      {
        id: 'c2',
        name: 'app-worker-1',
        image: 'app:latest',
        running: true,
        labels: { 'com.docker.compose.project': 'app' },
      },
      {
        id: 'c3',
        name: 'other-web-1',
        image: 'other:latest',
        running: false,
        labels: { 'com.docker.compose.project': 'other' },
      },
    ]);
    const result = await gate.simulate('compose.up', { project: 'app' });
    const detail = result.detail as { containers: Array<{ id: string }> };
    expect(detail.containers.map((c) => c.id)).toEqual(['c1']);
  });

  it('apply compose.down stops only the running containers in the named project', async () => {
    const { gate, client } = buildGate([
      {
        id: 'c1',
        name: 'app-web-1',
        image: 'app:latest',
        running: true,
        labels: { 'com.docker.compose.project': 'app' },
      },
      {
        id: 'c2',
        name: 'app-worker-1',
        image: 'app:latest',
        running: false,
        labels: { 'com.docker.compose.project': 'app' },
      },
    ]);
    await gate.apply('compose.down', { project: 'app' }, 'req-1');
    expect(client.stopCalls).toEqual(['c1']);
  });

  it('apply compose.up starts only the stopped containers in the named project', async () => {
    const { gate, client } = buildGate([
      {
        id: 'c1',
        name: 'app-web-1',
        image: 'app:latest',
        running: false,
        labels: { 'com.docker.compose.project': 'app' },
      },
      {
        id: 'c2',
        name: 'app-worker-1',
        image: 'app:latest',
        running: true,
        labels: { 'com.docker.compose.project': 'app' },
      },
    ]);
    await gate.apply('compose.up', { project: 'app' }, 'req-1');
    expect(client.startCalls).toEqual(['c1']);
  });

  it('health() reports ok via a fake docker ping', async () => {
    const client = createFakeDockerClient();
    const transport = createDockerTransport(client);
    const health = await transport.health?.();
    expect(health).toEqual({ status: 'ok' });
    expect(client.pingCalls).toBe(1);
  });

  it('rejects an unknown operation name at the transport level', async () => {
    const client = createFakeDockerClient();
    const transport = createDockerTransport(client);
    const first = MANIFEST[0];
    if (!first) throw new Error('manifest.json is empty');
    const bogus: Operation = { ...first, name: 'nonexistent.op' };
    await expect(transport.invoke(bogus, {}, {})).rejects.toThrow(/unknown operation/);
  });
});
