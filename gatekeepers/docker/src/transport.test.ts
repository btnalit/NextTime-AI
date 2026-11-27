import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ApplyOutcomeUnknownError,
  GatekeeperBase,
  InMemoryIdempotencyStore,
  TransportInvokeError,
  createGatekeeperServer,
  operationDefinitionDigest,
} from '@nexttime/gatekeeper-base';
import type { Operation } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import { createDockerClient } from './docker-client.js';
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

/** Legacy K: what the kernel sends with a call — the digest of the manifest entry it published. */
function approvedDigest(name: string): string {
  return operationDefinitionDigest(MANIFEST.find((op) => op.name === name));
}

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
        { id: 'c1', name: 'web', image: 'nginx:latest', state: 'running', status: 'Up 1 minute' },
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
 * Legacy 966: every Operation but `container.inspect` returns each container as a list item — id,
 * name, image, state, status, and its compose project and service — never its labels; one
 * container's labels are what `container.inspect` is for. The facts the kernel writes from the
 * result (`result_mapping`) are the same as before.
 */
describe('docker gate: labels only in container.inspect (legacy 966)', () => {
  const LABELS = {
    'com.docker.compose.project': 'app',
    'com.docker.compose.service': 'web',
    'com.docker.compose.config-hash': 'f'.repeat(64),
    'com.docker.compose.project.working_dir': '/srv/app',
    'org.opencontainers.image.revision': 'a'.repeat(40),
  };
  const WEB: FakeContainerSeed = { id: 'c1', name: 'app-web-1', image: 'app:1', labels: LABELS };
  const DB: FakeContainerSeed = {
    id: 'c2',
    name: 'app-db-1',
    image: 'postgres:17',
    running: false,
    labels: { ...LABELS, 'com.docker.compose.service': 'db' },
  };
  const LOOSE: FakeContainerSeed = { id: 'c3', name: 'scratch', image: 'busybox', labels: {} };
  const ITEM_KEYS = ['id', 'image', 'name', 'project', 'service', 'state', 'status'];

  const webItem = {
    id: 'c1',
    name: 'app-web-1',
    image: 'app:1',
    state: 'running',
    status: 'Up 1 minute',
    project: 'app',
    service: 'web',
  };

  it('containers.list: the compose project and service, no labels; a container without them has neither key', async () => {
    const { gate } = buildGate([WEB, LOOSE]);
    const result = await gate.observe('containers.list', { all: true });
    expect(result.data).toEqual([
      webItem,
      { id: 'c3', name: 'scratch', image: 'busybox', state: 'running', status: 'Up 1 minute' },
    ]);
    expect(result.observedFacts.map((f) => f.properties)).toEqual([
      { name: 'app-web-1', image: 'app:1', state: 'running', status: 'Up 1 minute' },
      { name: 'scratch', image: 'busybox', state: 'running', status: 'Up 1 minute' },
    ]);
  });

  it("compose.ls: each project's containers as list items, without the project they are listed under", async () => {
    const { gate } = buildGate([WEB, DB, LOOSE]);
    const result = await gate.observe('compose.ls', {});
    const { project: _project, ...listedWeb } = webItem;
    expect(result.data).toEqual({
      projects: [
        {
          project: 'app',
          containerCount: 2,
          containers: [
            listedWeb,
            {
              ...listedWeb,
              id: 'c2',
              name: 'app-db-1',
              image: 'postgres:17',
              state: 'exited',
              status: 'Exited (0) 1 minute ago',
              service: 'db',
            },
          ],
        },
      ],
    });
  });

  it('container.restart, compose.up and compose.down: results and simulate details carry list items', async () => {
    const { gate } = buildGate([WEB, DB]);
    const carried: unknown[] = [];
    const restartSimulate = await gate.simulate('container.restart', { id: 'c1' });
    carried.push(...(restartSimulate.detail as { containers: unknown[] }).containers);
    carried.push((await gate.apply('container.restart', { id: 'c1' }, 'req-restart')).data);
    for (const name of ['compose.up', 'compose.down']) {
      const simulated = await gate.simulate(name, { project: 'app' });
      carried.push(...(simulated.detail as { containers: unknown[] }).containers);
      const applied = await gate.apply(name, { project: 'app' }, `req-${name}`);
      carried.push(...(applied.data as { containers: unknown[] }).containers);
    }
    // restart: its simulate and its result; up: one target (db), then both; down: both, then both.
    expect(carried).toHaveLength(9);
    for (const container of carried) {
      expect(Object.keys(container as object).sort()).toEqual(ITEM_KEYS);
    }
    expect(carried[1]).toEqual(webItem);
  });

  it('container.inspect returns every label', async () => {
    const { gate } = buildGate([WEB]);
    const result = await gate.observe('container.inspect', { id: 'app-web-1' });
    expect(result.data).toEqual({
      id: 'c1',
      name: 'app-web-1',
      image: 'app:1',
      state: 'running',
      status: 'Up 1 minute',
      labels: LABELS,
    });
  });
});

/**
 * Legacy 287 (review of #586, #493 M3): a failed execute Operation is a plain failure only when
 * nothing changed — it failed before its first change call, or the daemon answered that call with
 * an error status, or the connection provably never opened. A change call without the daemon's
 * answer, or any failure after a change call succeeded, is "outcome unknown" (409
 * `apply_outcome_unknown` for its key), never a failure the kernel could record and run again.
 */
describe('docker gate: a failed execute Operation (legacy 287)', () => {
  const daemonError = (statusCode: number) =>
    Object.assign(new Error(`(HTTP code ${statusCode}) server error`), { statusCode });
  const networkError = (code: string, syscall?: string) =>
    Object.assign(new Error(`socket ${code}`), { code, ...(syscall ? { syscall } : {}) });

  async function applyFailure(
    gate: GatekeeperBase,
    name: string,
    params: Record<string, unknown>,
  ): Promise<Error> {
    const thrown = await gate
      .apply(name, params, 'req-1', { operationDigest: approvedDigest(name) })
      .then(
        () => undefined,
        (err: unknown) => err,
      );
    if (!(thrown instanceof Error)) throw new Error('expected the apply to fail');
    return thrown;
  }

  const web = { id: 'c1', name: 'web', image: 'nginx:latest', running: true };

  it('the daemon refusing the restart is a plain failure', async () => {
    const { gate, client } = buildGate([web]);
    client.restart = async () => {
      throw daemonError(500);
    };
    const err = await applyFailure(gate, 'container.restart', { id: 'c1' });
    expect(err).toBeInstanceOf(TransportInvokeError);
    expect(err.message).toBe(
      'docker transport: operation "container.restart" failed: the Docker daemon answered restart with status 500',
    );
  });

  it('a daemon that cannot be reached changed nothing: a plain failure', async () => {
    const { gate, client } = buildGate([web]);
    client.restart = async () => {
      throw networkError('ENOENT', 'connect');
    };
    const err = await applyFailure(gate, 'container.restart', { id: 'c1' });
    expect(err).toBeInstanceOf(TransportInvokeError);
    expect(err.message).toBe(
      'docker transport: operation "container.restart" not sent — could not connect to the Docker daemon (ENOENT); nothing changed',
    );
  });

  it('a container that does not exist fails before any change: a plain failure', async () => {
    const { gate, client } = buildGate([web]);
    const err = await applyFailure(gate, 'container.restart', { id: 'nope' });
    expect(err).toBeInstanceOf(TransportInvokeError);
    expect(err).not.toBeInstanceOf(ApplyOutcomeUnknownError);
    expect(client.restartCalls).toEqual([]);
  });

  it('a connection that broke during the restart is outcome unknown', async () => {
    const { gate, client } = buildGate([web]);
    client.restart = async () => {
      throw networkError('ECONNRESET');
    };
    const err = await applyFailure(gate, 'container.restart', { id: 'c1' });
    expect(err).toBeInstanceOf(ApplyOutcomeUnknownError);
    expect(err.message).toContain(
      'docker transport: operation "container.restart" failed while its restart call was in flight (ECONNRESET) — it may have run',
    );
  });

  it('a failure after the restart succeeded is outcome unknown, whatever the daemon answered', async () => {
    const { gate, client } = buildGate([web]);
    const inspect = client.inspectContainer.bind(client);
    let calls = 0;
    client.inspectContainer = async (id: string) => {
      calls += 1;
      if (calls > 1) throw daemonError(404);
      return inspect(id);
    };
    const err = await applyFailure(gate, 'container.restart', { id: 'c1' });
    expect(client.restartCalls).toHaveLength(1);
    expect(err).toBeInstanceOf(ApplyOutcomeUnknownError);
    expect(err.message).toContain(
      'failed after it had already changed the target (1 change call(s) succeeded)',
    );
  });

  it('compose.up failing part-way through its containers is outcome unknown', async () => {
    const { gate, client } = buildGate([
      {
        id: 'a1',
        name: 'a',
        image: 'x',
        running: false,
        labels: { 'com.docker.compose.project': 'p' },
      },
      {
        id: 'b1',
        name: 'b',
        image: 'x',
        running: false,
        labels: { 'com.docker.compose.project': 'p' },
      },
    ]);
    const start = client.start.bind(client);
    client.start = async (id: string) => {
      if (id === 'b1') throw daemonError(500);
      return start(id);
    };
    const err = await applyFailure(gate, 'compose.up', { project: 'p' });
    expect(err).toBeInstanceOf(ApplyOutcomeUnknownError);
    expect(err.message).toContain('1 change call(s) succeeded');
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
        payload: {
          operation: 'container.logs_tail',
          params: { id: ENTRY.name },
          operationDigest: approvedDigest('container.logs_tail'),
        },
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
          operationDigest: approvedDigest('container.restart'),
        },
      });
      expect(apply.statusCode).toBe(403);
      expect(apply.json()).toMatchObject({ ok: false, error: { code: 'operation_refused' } });
    } finally {
      await app.close();
    }
  });
});

/**
 * Legacy 196 (#532 review M): dockerode puts the caller's `id` into the request path as it is, and
 * over tcp docker-modem resolves that path as a URL — `x/../../info` would ask `GET /info/json`.
 * An `id` that could leave the container's path segment is refused before any call to the daemon.
 */
describe('docker gate refuses an id that is not a container reference (legacy 196)', () => {
  const WEB: FakeContainerSeed = { id: 'c1c1c1c1c1c1', name: 'web', image: 'nginx', running: true };
  const NOT_REFS = [
    'x/../../info',
    '../../images/json',
    'web/../db',
    'web#frag',
    'web?all=1',
    // Legacy 793: `?` and a backslash on their own, so a pattern that let either through fails
    // here — over tcp `x\..\..\info` is read as a URL and asks `GET /info/json`.
    'web?x',
    'x\\..\\..\\info',
    'a%2F..%2F..%2Finfo',
    '/web',
    '.web',
    '-web',
    ' web',
    'web\n',
    'wéb',
  ];

  for (const id of NOT_REFS) {
    it(`refuses ${JSON.stringify(id)} on every per-container Operation, with no call to the daemon`, async () => {
      const { gate, client } = buildGate([WEB]);
      const refused = {
        name: 'OperationRefusedError',
        message: expect.stringMatching(/nothing was sent to the Docker daemon/),
      };
      await expect(gate.observe('container.inspect', { id })).rejects.toMatchObject(refused);
      await expect(gate.observe('container.logs_tail', { id })).rejects.toMatchObject(refused);
      for (const op of ['container.inspect', 'container.logs_tail', 'container.restart']) {
        await expect(gate.simulate(op, { id })).rejects.toMatchObject(refused);
      }
      await expect(gate.apply('container.restart', { id }, 'req-1')).rejects.toMatchObject(refused);
      // A refusal ran nothing, so the key is free: the retry is refused again, not 409.
      await expect(gate.apply('container.restart', { id }, 'req-1')).rejects.toMatchObject(refused);
      expect(client.inspectCalls).toEqual([]);
      expect(client.logsTailCalls).toEqual([]);
      expect(client.restartCalls).toEqual([]);
    });
  }

  it('still takes every form Docker names a container by: full id, a one-character prefix, a name with "_", "." and "-"', async () => {
    const DOTTED: FakeContainerSeed = { id: 'd2d2d2d2d2d2', name: 'app_1.web-a', image: 'x' };
    const { gate, client } = buildGate([WEB, DOTTED]);
    for (const id of [WEB.id, 'c', DOTTED.name, 'a..b']) {
      await gate.simulate('container.inspect', { id }).catch(() => undefined);
    }
    expect(client.inspectCalls).toEqual([WEB.id, 'c', DOTTED.name, 'a..b']);
    await gate.apply('container.restart', { id: DOTTED.name }, 'req-1');
    expect(client.restartCalls).toEqual([{ id: DOTTED.id, timeoutSeconds: 10 }]);
  });

  it('with the real client over tcp, a refused id reaches no endpoint and a container name reaches its own', async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      if (req.url === '/containers/web/json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            Id: WEB.id,
            Name: '/web',
            State: { Running: true, Status: 'running', StartedAt: '2026-01-01T00:00:00Z' },
            Config: { Image: 'nginx', Labels: {} },
          }),
        );
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"message":"not found"}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const client = createDockerClient({ connection: { kind: 'tcp', host: '127.0.0.1', port } });
      const gate = new GatekeeperBase({
        manifest: MANIFEST,
        transport: createDockerTransport(client),
        credentialResolver: { resolve: async () => ({}) },
        idempotencyStore: new InMemoryIdempotencyStore(),
      });
      await expect(gate.observe('container.inspect', { id: 'x/../../info' })).rejects.toMatchObject(
        {
          name: 'OperationRefusedError',
        },
      );
      await expect(gate.observe('container.inspect', { id: 'web#frag' })).rejects.toMatchObject({
        name: 'OperationRefusedError',
      });
      await expect(
        gate.observe('container.inspect', { id: 'x\\..\\..\\info' }),
      ).rejects.toMatchObject({ name: 'OperationRefusedError' });
      expect(seen).toEqual([]);
      const inspected = await gate.observe('container.inspect', { id: 'web' });
      expect(inspected.observedFacts.map((f) => f.identity)).toEqual([{ id: WEB.id }]);
      expect(seen).toEqual(['GET /containers/web/json']);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('over the wire the refusal is 403 operation_refused', async () => {
    const { gate } = buildGate([WEB]);
    const token = 'legacy-196-test-token-'.padEnd(40, 'x');
    const app = createGatekeeperServer({ gate, token });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/gate/apply',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          operation: 'container.restart',
          params: { id: 'x/../../info' },
          actionRequestId: 'req-1',
          operationDigest: approvedDigest('container.restart'),
        },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ ok: false, error: { code: 'operation_refused' } });
    } finally {
      await app.close();
    }
  });
});
