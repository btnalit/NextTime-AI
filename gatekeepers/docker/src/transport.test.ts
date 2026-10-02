import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GatekeeperBase,
  InMemoryIdempotencyStore,
  createGatekeeperServer,
} from '@nexttime/gatekeeper-base';
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

/**
 * R-04 (decision D-04): the platform's agent containers — worker-supervisor's entry (`nexttime.role
 * =entry`) and Task (`nexttime.role=worker`) containers, whose stdout is pi RPC — are never listed
 * and every per-container Operation on one is refused. Service containers are unaffected.
 */
describe('docker gate never lists or touches the platform agent containers (R-04)', () => {
  const PROJECT = 'nexttime';
  const ENTRY: FakeContainerSeed = {
    id: 'e1e1e1e1e1e1',
    name: 'nexttime-entry-p1',
    image: 'nexttime-worker:latest',
    running: true,
    labels: { 'nexttime.role': 'entry', 'nexttime.principal': 'p1' },
  };
  const TASK: FakeContainerSeed = {
    id: 'f2f2f2f2f2f2',
    name: 'nexttime-task-t1',
    image: 'nexttime-worker:latest',
    running: true,
    labels: { 'nexttime.role': 'worker', 'nexttime.task-id': 't1' },
  };
  // Carries the compose project label too, so the compose Operations' own filtering is exercised.
  const STOPPED_AGENT: FakeContainerSeed = {
    id: 'a3a3a3a3a3a3',
    name: 'nexttime-entry-p2',
    image: 'nexttime-worker:latest',
    running: false,
    labels: { 'nexttime.role': 'entry', 'com.docker.compose.project': PROJECT },
  };
  const KERNEL: FakeContainerSeed = {
    id: 'c4c4c4c4c4c4',
    name: 'nexttime-kernel-1',
    image: 'nexttime-kernel:latest',
    running: true,
    labels: { 'com.docker.compose.project': PROJECT },
  };
  const SEEDS = [ENTRY, TASK, STOPPED_AGENT, KERNEL];

  it('containers.list leaves out entry and Task containers and keeps service containers', async () => {
    const { gate } = buildGate(SEEDS);
    const result = await gate.observe('containers.list', { all: true });
    expect((result.data as Array<{ id: string }>).map((c) => c.id)).toEqual([KERNEL.id]);
    expect(result.observedFacts.map((f) => f.identity)).toEqual([{ id: KERNEL.id }]);
  });

  it('compose.ls leaves out agent containers even when they carry the project label', async () => {
    const { gate } = buildGate(SEEDS);
    const result = await gate.observe('compose.ls', {});
    expect(result.data).toEqual({
      projects: [
        {
          project: PROJECT,
          containerCount: 1,
          containers: [expect.objectContaining({ id: KERNEL.id })],
        },
      ],
    });
  });

  it('compose.up/compose.down never start or stop an agent container', async () => {
    const { gate, client } = buildGate(SEEDS);
    const simulated = await gate.simulate('compose.up', { project: PROJECT });
    expect(simulated.detail).toEqual({ containers: [] });
    const up = await gate.apply('compose.up', { project: PROJECT }, 'req-up');
    expect(client.startCalls).toEqual([]);
    expect((up.data as { containers: Array<{ id: string }> }).containers.map((c) => c.id)).toEqual([
      KERNEL.id,
    ]);
    await gate.apply('compose.down', { project: PROJECT }, 'req-down');
    expect(client.stopCalls).toEqual([KERNEL.id]);
  });

  for (const agent of [ENTRY, TASK]) {
    const role = agent.labels?.['nexttime.role'];

    it(`refuses every per-container Operation on a ${role} container, observe and execute alike`, async () => {
      const { gate, client } = buildGate(SEEDS);
      const refused = { name: 'OperationRefusedError' };
      await expect(gate.observe('container.inspect', { id: agent.id })).rejects.toMatchObject(
        refused,
      );
      await expect(gate.observe('container.logs_tail', { id: agent.id })).rejects.toMatchObject(
        refused,
      );
      for (const op of ['container.inspect', 'container.logs_tail', 'container.restart']) {
        await expect(gate.simulate(op, { id: agent.id })).rejects.toMatchObject(refused);
      }
      await expect(
        gate.apply('container.restart', { id: agent.id }, 'req-1'),
      ).rejects.toMatchObject(refused);
      expect(client.logsTailCalls).toEqual([]);
      expect(client.restartCalls).toEqual([]);
    });

    it(`refuses a ${role} container named by its name or an id prefix, judged by its labels`, async () => {
      const { gate, client } = buildGate(SEEDS);
      for (const id of [agent.name, agent.id.slice(0, 4)]) {
        await expect(gate.observe('container.logs_tail', { id })).rejects.toThrow(
          /platform agent container/,
        );
        await expect(gate.apply('container.restart', { id }, `req-${id}`)).rejects.toMatchObject({
          name: 'OperationRefusedError',
        });
      }
      expect(client.logsTailCalls).toEqual([]);
      expect(client.restartCalls).toEqual([]);
    });
  }

  it('a refused apply does not pin its idempotency reservation: a retry is refused again, not 409', async () => {
    const { gate } = buildGate(SEEDS);
    const refused = { name: 'OperationRefusedError' };
    await expect(gate.apply('container.restart', { id: ENTRY.id }, 'req-1')).rejects.toMatchObject(
      refused,
    );
    await expect(gate.apply('container.restart', { id: ENTRY.id }, 'req-1')).rejects.toMatchObject(
      refused,
    );
  });

  it('a service container stays visible and operable — by id, name or id prefix', async () => {
    const { gate, client } = buildGate(SEEDS);
    const inspected = await gate.observe('container.inspect', { id: KERNEL.name });
    expect(inspected.observedFacts.map((f) => f.identity)).toEqual([{ id: KERNEL.id }]);
    const logs = await gate.observe('container.logs_tail', { id: KERNEL.id, tail: 5 });
    expect(logs.data).toMatchObject({ id: KERNEL.id, tail: 5 });
    const simulated = await gate.simulate('container.restart', { id: KERNEL.id.slice(0, 4) });
    expect(simulated.description).toContain(`restart container "${KERNEL.name}"`);
    await gate.apply('container.restart', { id: KERNEL.id.slice(0, 4) }, 'req-1');
    // Acts on the resolved full id, never the caller's prefix.
    expect(client.restartCalls).toEqual([{ id: KERNEL.id, timeoutSeconds: 10 }]);
    expect(client.logsTailCalls).toEqual([KERNEL.id]);
  });

  it('over the wire a refusal is 403 operation_refused, on observe and apply', async () => {
    const { gate } = buildGate(SEEDS);
    const token = 'r04-test-token-'.padEnd(40, 'x');
    const app = createGatekeeperServer({ gate, token });
    try {
      const headers = { authorization: `Bearer ${token}` };
      const observe = await app.inject({
        method: 'POST',
        url: '/gate/observe',
        headers,
        payload: { operation: 'container.logs_tail', params: { id: ENTRY.name } },
      });
      expect(observe.statusCode).toBe(403);
      expect(observe.json()).toMatchObject({ ok: false, error: { code: 'operation_refused' } });
      const apply = await app.inject({
        method: 'POST',
        url: '/gate/apply',
        headers,
        payload: {
          operation: 'container.restart',
          params: { id: TASK.id },
          actionRequestId: 'req-1',
        },
      });
      expect(apply.statusCode).toBe(403);
      expect(apply.json()).toMatchObject({ ok: false, error: { code: 'operation_refused' } });
    } finally {
      await app.close();
    }
  });
});
