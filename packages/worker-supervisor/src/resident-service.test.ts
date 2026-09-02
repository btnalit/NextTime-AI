import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { createEgressMapStore } from './egress-map.js';
import type { EgressMapStore } from './egress-map.js';
import { createResidentService } from './resident-service.js';
import { createFakeDockerClient } from './test-support/fake-docker-client.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'worker-supervisor-resident-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function setup(overrides: Record<string, string> = {}) {
  const config = loadConfig({
    NEXTTIME_DATA: '/host/data',
    LOCAL_DATA_DIR: dir,
    EGRESS_SOURCE_MAP_FILE: join(dir, 'egress-sources.json'),
    ENTRY_IDLE_TIMEOUT_MS: '1000',
    ...overrides,
  });
  const docker = createFakeDockerClient();
  const egressMap = createEgressMapStore(config.egressSourceMapFile);
  let clock = 0;
  const service = createResidentService({ config, docker, egressMap, now: () => clock });
  return {
    config,
    docker,
    egressMap,
    service,
    advanceClock(ms: number) {
      clock += ms;
    },
  };
}

describe('resident-service spawn', () => {
  it('creates a fresh container on first spawn, restarts=0', async () => {
    const { service, docker } = setup();
    const outcome = await service.spawn({ workspaceId: 'ws-1', principalId: 'alice', handle: 'h' });
    expect(outcome.created).toBe(true);
    expect(outcome.restarts).toBe(0);
    expect(outcome.status).toBe('running');
    expect(docker.createCalls).toHaveLength(1);
    expect(docker.createCalls[0]?.name).toBe('nexttime-entry-alice');
  });

  it('creates the per-user workspace directory (I15) before spawning', async () => {
    const { service } = setup();
    await service.spawn({ workspaceId: 'ws-1', principalId: 'alice', handle: 'h' });
    // mkdirSync inside spawn() must not throw and must create the dir; a second spawn (which
    // hits the "already exists" path since mkdir is `recursive: true`) must not throw either.
    await expect(
      service.spawn({ workspaceId: 'ws-1', principalId: 'alice', handle: 'h' }),
    ).resolves.toBeDefined();
  });

  it('reuses a running container on the next spawn (idempotent, created=false)', async () => {
    const { service, docker } = setup();
    const first = await service.spawn({ workspaceId: 'ws-1', principalId: 'alice', handle: 'h' });
    const second = await service.spawn({ workspaceId: 'ws-1', principalId: 'alice', handle: 'h' });
    expect(second.created).toBe(false);
    expect(second.containerId).toBe(first.containerId);
    expect(second.restarts).toBe(0);
    expect(docker.createCalls).toHaveLength(1);
  });

  it('recreates and increments restarts when the previous container was killed', async () => {
    const { service, docker } = setup();
    const first = await service.spawn({ workspaceId: 'ws-1', principalId: 'alice', handle: 'h' });
    docker.simulateExternalKill('nexttime-entry-alice');

    const second = await service.spawn({ workspaceId: 'ws-1', principalId: 'alice', handle: 'h' });
    expect(second.created).toBe(true);
    expect(second.restarts).toBe(1);
    expect(second.containerId).not.toBe(first.containerId);
    expect(docker.removeCalls).toEqual(['nexttime-entry-alice']);
    expect(docker.createCalls).toHaveLength(2);

    docker.simulateExternalKill('nexttime-entry-alice');
    const third = await service.spawn({ workspaceId: 'ws-1', principalId: 'alice', handle: 'h' });
    expect(third.restarts).toBe(2);
  });

  it('keeps separate containers and workspaces per principal', async () => {
    const { service, docker } = setup();
    const alice = await service.spawn({ workspaceId: 'ws-1', principalId: 'alice', handle: 'h' });
    const bob = await service.spawn({ workspaceId: 'ws-1', principalId: 'bob', handle: 'h' });
    expect(alice.containerId).not.toBe(bob.containerId);
    expect(docker.createCalls[0]?.binds[0]).toBe('/host/data/workspaces/alice:/workspace');
    expect(docker.createCalls[1]?.binds[0]).toBe('/host/data/workspaces/bob:/workspace');
  });

  it('registers the spawned container IP in the egress source map as entry:<ws>:<principal>', async () => {
    const { service, egressMap } = setup();
    const outcome = await service.spawn({ workspaceId: 'ws-1', principalId: 'alice', handle: 'h' });
    const map = egressMap.read();
    expect(outcome.ip).toBeDefined();
    expect(map[outcome.ip as string]).toEqual({ sourceId: 'entry:ws-1:alice' });
  });

  it('pre-creates .pi/agent under the local workspace dir before asking Docker to create the container', async () => {
    // Host verification (S1.5a) found Docker auto-creating .pi/agent as root (as the parent of
    // the models.json bind-mount target) blocks the non-root entry container from creating the
    // sibling .pi/sessions. This pre-creation (as this process's own uid, like localWorkspaceDir
    // itself) is the fix — assert the directory exists with the right shape before spawn returns.
    const { service, config } = setup();
    await service.spawn({ workspaceId: 'ws-1', principalId: 'alice', handle: 'h' });
    const stat = statSync(join(config.localDataDir, 'workspaces', 'alice', '.pi', 'agent'));
    expect(stat.isDirectory()).toBe(true);
  });

  it('spawn still succeeds when the egress map store throws (best-effort registration)', async () => {
    const { config, docker } = setup();
    const throwingEgressMap: EgressMapStore = {
      register: () => {
        throw new Error('EACCES: permission denied');
      },
      unregister: () => {
        throw new Error('EACCES: permission denied');
      },
      read: () => ({}),
    };
    const service = createResidentService({ config, docker, egressMap: throwingEgressMap });
    const outcome = await service.spawn({ workspaceId: 'ws-1', principalId: 'alice', handle: 'h' });
    expect(outcome.created).toBe(true);
    expect(outcome.status).toBe('running');
  });
});

describe('resident-service stop', () => {
  it('stops the container and unregisters its egress IP', async () => {
    const { service, docker, egressMap } = setup();
    const outcome = await service.spawn({ workspaceId: 'ws-1', principalId: 'alice', handle: 'h' });
    await service.stop('alice');

    expect(docker.stopCalls).toEqual([{ name: 'nexttime-entry-alice', timeoutSeconds: 10 }]);
    expect(egressMap.read()[outcome.ip as string]).toBeUndefined();
  });

  it('is a no-op when nothing is running for that principal', async () => {
    const { service, docker } = setup();
    await expect(service.stop('nobody')).resolves.toBeUndefined();
    expect(docker.stopCalls).toEqual([{ name: 'nexttime-entry-nobody', timeoutSeconds: 10 }]);
  });

  it('stop still succeeds when the egress map store throws (best-effort unregistration)', async () => {
    const { config, docker } = setup();
    const throwingEgressMap: EgressMapStore = {
      register: () => {},
      unregister: () => {
        throw new Error('EACCES: permission denied');
      },
      read: () => ({}),
    };
    const service = createResidentService({ config, docker, egressMap: throwingEgressMap });
    await service.spawn({ workspaceId: 'ws-1', principalId: 'alice', handle: 'h' });
    await expect(service.stop('alice')).resolves.toBeUndefined();
    expect(docker.stopCalls).toEqual([{ name: 'nexttime-entry-alice', timeoutSeconds: 10 }]);
  });
});

describe('resident-service status', () => {
  it('returns undefined when nothing has been spawned', async () => {
    const { service } = setup();
    expect(await service.status('nobody')).toBeUndefined();
  });

  it('reports running/status/restarts/ip after spawn', async () => {
    const { service } = setup();
    const outcome = await service.spawn({ workspaceId: 'ws-1', principalId: 'alice', handle: 'h' });
    const status = await service.status('alice');
    expect(status).toMatchObject({
      principalId: 'alice',
      containerId: outcome.containerId,
      ip: outcome.ip,
      running: true,
      status: 'running',
      restarts: 0,
    });
  });
});

describe('resident-service touch / idle sweep', () => {
  it('touch refreshes the idle clock and returns true; false for an unknown principal', async () => {
    const { service } = setup();
    await service.spawn({ workspaceId: 'ws-1', principalId: 'alice', handle: 'h' });
    expect(await service.touch('alice')).toBe(true);
    expect(await service.touch('nobody')).toBe(false);
  });

  it('sweepIdle stops containers untouched past ENTRY_IDLE_TIMEOUT_MS and leaves recent ones', async () => {
    const { service, docker, advanceClock } = setup({ ENTRY_IDLE_TIMEOUT_MS: '1000' });
    await service.spawn({ workspaceId: 'ws-1', principalId: 'alice', handle: 'h' });
    advanceClock(500);
    await service.spawn({ workspaceId: 'ws-1', principalId: 'bob', handle: 'h' }); // touches bob at t=500

    advanceClock(600); // t=1100: alice idle 1100ms (>1000), bob idle 600ms (<1000)
    await service.sweepIdle();

    expect(docker.stopCalls.map((c) => c.name)).toEqual(['nexttime-entry-alice']);
    expect((await service.status('alice'))?.running).toBe(false);
    expect((await service.status('bob'))?.running).toBe(true);
  });

  it('touch after a sweepIdle stop re-registers the principal via the recovery path is not needed — spawn recreates it', async () => {
    const { service, docker, advanceClock } = setup({ ENTRY_IDLE_TIMEOUT_MS: '1000' });
    await service.spawn({ workspaceId: 'ws-1', principalId: 'alice', handle: 'h' });
    advanceClock(1100);
    await service.sweepIdle();
    expect(docker.stopCalls).toHaveLength(1);

    const respawned = await service.spawn({
      workspaceId: 'ws-1',
      principalId: 'alice',
      handle: 'h',
    });
    expect(respawned.created).toBe(true);
    expect(respawned.restarts).toBe(1);
  });
});

describe('resident-service reconcile', () => {
  it('re-registers running containers found by label after a simulated supervisor restart', async () => {
    const { config, docker, egressMap } = setup();
    const first = createResidentService({ config, docker, egressMap });
    const outcome = await first.spawn({ workspaceId: 'ws-1', principalId: 'alice', handle: 'h' });

    // Simulate this supervisor process restarting: a brand new service instance, same docker +
    // egress-map backends, empty in-memory registry.
    egressMap.unregister(outcome.ip as string); // pretend the file was also reset/lost
    const second = createResidentService({ config, docker, egressMap });
    await second.reconcile();

    expect(egressMap.read()[outcome.ip as string]).toEqual({ sourceId: 'entry:ws-1:alice' });
    // reconcile() also seeds the idle-timeout registry for every running container it finds, not
    // just the egress map — so touch() finds it directly, no recovery-path inspectByName needed.
    expect(await second.touch('alice')).toBe(true);
  });

  it('touch recovers a principal via inspectByName even without calling reconcile first', async () => {
    const { config, docker, egressMap } = setup();
    const first = createResidentService({ config, docker, egressMap });
    await first.spawn({ workspaceId: 'ws-1', principalId: 'alice', handle: 'h' });

    const second = createResidentService({ config, docker, egressMap });
    expect(await second.touch('alice')).toBe(true);
  });

  it('does not register anything for a stopped container', async () => {
    const { config, docker, egressMap } = setup();
    const first = createResidentService({ config, docker, egressMap });
    await first.spawn({ workspaceId: 'ws-1', principalId: 'alice', handle: 'h' });
    await first.stop('alice');

    const second = createResidentService({ config, docker, egressMap });
    await expect(second.reconcile()).resolves.toBeUndefined();
    expect(await second.touch('alice')).toBe(false);
  });
});
