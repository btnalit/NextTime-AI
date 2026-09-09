import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { createEgressMapStore } from './egress-map.js';
import type { EgressMapStore } from './egress-map.js';
import { createResidentService } from './resident-service.js';
import { createFakeDockerClient } from './test-support/fake-docker-client.js';

/** A JWT-*shaped* (but unsigned/fake) Handle carrying only the `jti` claim `decodeHandleJtiUnsafe`
 *  reads — resident-service.ts never verifies the Handle's signature, only decodes `jti` for
 *  rotation detection (P2-5), so a real signed token isn't needed for these tests. */
function fakeHandle(jti: string): string {
  const encode = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${encode({ alg: 'EdDSA' })}.${encode({ jti })}.fake-signature`;
}

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

  it('writes systemPrompt to /workspace/.nexttime/system-prompt.md before spawning (S2.6)', async () => {
    const { service } = setup();
    await service.spawn({
      workspaceId: 'ws-1',
      principalId: 'alice',
      handle: 'h',
      systemPrompt: 'you are the entry agent',
    });

    const filePath = join(dir, 'workspaces', 'alice', '.nexttime', 'system-prompt.md');
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf8')).toBe('you are the entry agent');
  });

  it('overwrites system-prompt.md when the content differs, leaves it alone when unchanged', async () => {
    const { service } = setup();
    const filePath = join(dir, 'workspaces', 'alice', '.nexttime', 'system-prompt.md');

    await service.spawn({
      workspaceId: 'ws-1',
      principalId: 'alice',
      handle: 'h',
      systemPrompt: 'v1 prompt',
    });
    expect(readFileSync(filePath, 'utf8')).toBe('v1 prompt');

    await service.spawn({
      workspaceId: 'ws-1',
      principalId: 'alice',
      handle: 'h',
      systemPrompt: 'v2 prompt',
    });
    expect(readFileSync(filePath, 'utf8')).toBe('v2 prompt');
  });

  it('never writes system-prompt.md when systemPrompt is omitted — entrypoint.sh’s fallback applies', async () => {
    const { service } = setup();
    await service.spawn({ workspaceId: 'ws-1', principalId: 'alice', handle: 'h' });

    const filePath = join(dir, 'workspaces', 'alice', '.nexttime', 'system-prompt.md');
    expect(existsSync(filePath)).toBe(false);
  });

  it('passes model through to the container spec as CMD (S2.6)', async () => {
    const { service, docker } = setup();
    await service.spawn({
      workspaceId: 'ws-1',
      principalId: 'alice',
      handle: 'h',
      model: 'example-provider/example-model',
    });

    expect(docker.createCalls[0]?.cmd).toEqual(['--model', 'example-provider/example-model']);
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

  it('unregisters the crashed container’s last-known egress IP promptly, from the in-memory registry (P2-7)', async () => {
    const { service, docker, egressMap } = setup();
    const first = await service.spawn({ workspaceId: 'ws-1', principalId: 'alice', handle: 'h' });
    expect(first.ip).toBeDefined();
    expect(egressMap.read()[first.ip as string]).toBeDefined();

    docker.simulateExternalKill('nexttime-entry-alice');
    // Docker itself has already cleared the crashed container's `ip` (ContainerState's own
    // contract) — this only works if resident-service.ts falls back to its own in-memory registry
    // for the last-known ip, not the (now-undefined) inspect result.
    await service.spawn({ workspaceId: 'ws-1', principalId: 'alice', handle: 'h' });

    expect(egressMap.read()[first.ip as string]).toBeUndefined();
  });

  it('does not recreate when the same jti-bearing Handle is presented again (P2-5)', async () => {
    const { service, docker } = setup();
    const handle = fakeHandle('jti-alpha');
    const first = await service.spawn({ workspaceId: 'ws-1', principalId: 'alice', handle });
    const second = await service.spawn({ workspaceId: 'ws-1', principalId: 'alice', handle });
    expect(second.created).toBe(false);
    expect(second.containerId).toBe(first.containerId);
    expect(docker.createCalls).toHaveLength(1);
    expect(docker.stopCalls).toHaveLength(0);
  });

  it('recreates (does not reuse) a running container when the incoming Handle jti differs from the label (P2-5 rotation)', async () => {
    const { service, docker } = setup();
    const first = await service.spawn({
      workspaceId: 'ws-1',
      principalId: 'alice',
      handle: fakeHandle('jti-old'),
    });
    expect(first.created).toBe(true);
    expect(docker.createCalls[0]?.labels['nexttime.handle-jti']).toBe('jti-old');

    const second = await service.spawn({
      workspaceId: 'ws-1',
      principalId: 'alice',
      handle: fakeHandle('jti-new'),
    });
    expect(second.created).toBe(true);
    expect(second.containerId).not.toBe(first.containerId);
    expect(second.restarts).toBe(1);
    // Gracefully stopped (not force-killed) before being removed and recreated.
    expect(docker.stopCalls).toEqual([{ name: 'nexttime-entry-alice', timeoutSeconds: 10 }]);
    expect(docker.removeCalls).toEqual(['nexttime-entry-alice']);
    expect(docker.createCalls).toHaveLength(2);
    expect(docker.createCalls[1]?.labels['nexttime.handle-jti']).toBe('jti-new');
  });

  it('unregisters the old container’s egress IP when recreating due to rotation', async () => {
    const { service, egressMap } = setup();
    const first = await service.spawn({
      workspaceId: 'ws-1',
      principalId: 'alice',
      handle: fakeHandle('jti-old'),
    });
    expect(first.ip).toBeDefined();
    expect(egressMap.read()[first.ip as string]).toBeDefined();

    await service.spawn({
      workspaceId: 'ws-1',
      principalId: 'alice',
      handle: fakeHandle('jti-new'),
    });
    // The old IP must no longer be registered — it belonged to the now-removed container.
    expect(egressMap.read()[first.ip as string]).toBeUndefined();
  });

  it('does not force a recreation when the Handle is not a decodable JWT (plain string, e.g. "h")', async () => {
    const { service, docker } = setup();
    const first = await service.spawn({ workspaceId: 'ws-1', principalId: 'alice', handle: 'h' });
    const second = await service.spawn({ workspaceId: 'ws-1', principalId: 'alice', handle: 'h' });
    expect(second.created).toBe(false);
    expect(second.containerId).toBe(first.containerId);
    expect(docker.createCalls).toHaveLength(1);
  });

  it('does not force a recreation on first spawn (no existing label to compare against)', async () => {
    const { service, docker } = setup();
    const outcome = await service.spawn({
      workspaceId: 'ws-1',
      principalId: 'alice',
      handle: fakeHandle('jti-first'),
    });
    expect(outcome.created).toBe(true);
    expect(docker.stopCalls).toHaveLength(0);
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

  it('registers egressDeny alongside sourceId when the definition declares one (feat/egress-definition-lists)', async () => {
    const { service, docker, egressMap } = setup();
    const outcome = await service.spawn({
      workspaceId: 'ws-1',
      principalId: 'alice',
      handle: 'h',
      egressDeny: ['blocked.example.com'],
    });
    const map = egressMap.read();
    expect(map[outcome.ip as string]).toEqual({
      sourceId: 'entry:ws-1:alice',
      deny: ['blocked.example.com'],
    });
    expect(docker.createCalls[0]?.labels['nexttime.egress-deny']).toBe('blocked.example.com');
  });

  it('refreshes egressDeny on every reuse spawn, not just on (re)create', async () => {
    const { service, egressMap } = setup();
    const first = await service.spawn({
      workspaceId: 'ws-1',
      principalId: 'alice',
      handle: 'h',
      egressDeny: ['first.example.com'],
    });
    expect(egressMap.read()[first.ip as string]).toEqual({
      sourceId: 'entry:ws-1:alice',
      deny: ['first.example.com'],
    });

    // Same still-running container (reuse path) — a newly published definition version's list
    // must still take effect without a container restart.
    const second = await service.spawn({
      workspaceId: 'ws-1',
      principalId: 'alice',
      handle: 'h',
      egressDeny: ['second.example.com'],
    });
    expect(second.created).toBe(false);
    expect(egressMap.read()[first.ip as string]).toEqual({
      sourceId: 'entry:ws-1:alice',
      deny: ['second.example.com'],
    });
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

describe('resident-service spawn — S3.13 skillsInline', () => {
  const SKILL = { name: 'writing-tips', files: { 'SKILL.md': '# writing tips\n\nbody' } };

  it('writes skillsInline[] under <agentDir>/skills/<name>/ on first spawn', async () => {
    const { service } = setup();
    await service.spawn({
      workspaceId: 'ws-1',
      principalId: 'alice',
      handle: 'h',
      skillsInline: [SKILL],
    });

    const filePath = join(
      dir,
      'workspaces',
      'alice',
      '.pi',
      'agent',
      'skills',
      'writing-tips',
      'SKILL.md',
    );
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf8')).toBe('# writing tips\n\nbody');
  });

  it('stamps hashSkillsInline(skillsInline) onto the skills-hash label', async () => {
    const { docker } = setup();
    const service = createResidentService({
      config: loadConfig({
        NEXTTIME_DATA: '/host/data',
        LOCAL_DATA_DIR: dir,
        EGRESS_SOURCE_MAP_FILE: join(dir, 'egress-sources.json'),
      }),
      docker,
      egressMap: createEgressMapStore(join(dir, 'egress-sources.json')),
    });
    await service.spawn({
      workspaceId: 'ws-1',
      principalId: 'alice',
      handle: 'h',
      skillsInline: [SKILL],
    });
    const label = docker.createCalls[0]?.labels['nexttime.skills-hash'];
    expect(label).toBeDefined();
    expect(label).not.toBe('');
  });

  it('stamps the empty-string skills-hash label when no Skill is given', async () => {
    const { service, docker } = setup();
    await service.spawn({ workspaceId: 'ws-1', principalId: 'alice', handle: 'h' });
    expect(docker.createCalls[0]?.labels['nexttime.skills-hash']).toBe('');
  });

  it('reuses a running container when skillsInline is unchanged across spawns', async () => {
    const { service, docker } = setup();
    const first = await service.spawn({
      workspaceId: 'ws-1',
      principalId: 'alice',
      handle: 'h',
      skillsInline: [SKILL],
    });
    const second = await service.spawn({
      workspaceId: 'ws-1',
      principalId: 'alice',
      handle: 'h',
      skillsInline: [SKILL],
    });
    expect(second.created).toBe(false);
    expect(second.containerId).toBe(first.containerId);
    expect(docker.createCalls).toHaveLength(1);
  });

  it('recreates (does not reuse) a running container when skillsInline changes — the gate scope stays identical', async () => {
    const { service, docker } = setup();
    const first = await service.spawn({
      workspaceId: 'ws-1',
      principalId: 'alice',
      handle: 'h',
      skillsInline: [SKILL],
    });
    expect(first.created).toBe(true);

    const second = await service.spawn({
      workspaceId: 'ws-1',
      principalId: 'alice',
      handle: 'h',
      skillsInline: [SKILL, { name: 'other-skill', files: { 'SKILL.md': '# other' } }],
    });
    expect(second.created).toBe(true);
    expect(second.containerId).not.toBe(first.containerId);
    expect(second.restarts).toBe(1);
    expect(docker.createCalls).toHaveLength(2);
  });

  it('recreates when a Skill is removed (skillsInline becomes empty) — never leaves a stale Skill mounted', async () => {
    const { service, docker } = setup();
    await service.spawn({
      workspaceId: 'ws-1',
      principalId: 'alice',
      handle: 'h',
      skillsInline: [SKILL],
    });
    const filePath = join(
      dir,
      'workspaces',
      'alice',
      '.pi',
      'agent',
      'skills',
      'writing-tips',
      'SKILL.md',
    );
    expect(existsSync(filePath)).toBe(true);

    const second = await service.spawn({ workspaceId: 'ws-1', principalId: 'alice', handle: 'h' });
    expect(second.created).toBe(true); // recreated — the running container's Skill mount was stale
    expect(docker.createCalls).toHaveLength(2);
    // The stale Skill directory is gone — a removed Skill must never linger on disk.
    expect(existsSync(filePath)).toBe(false);
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

  it('restores egressDeny from the container label after a simulated supervisor restart (feat/egress-definition-lists)', async () => {
    const { config, docker, egressMap } = setup();
    const first = createResidentService({ config, docker, egressMap });
    const outcome = await first.spawn({
      workspaceId: 'ws-1',
      principalId: 'alice',
      handle: 'h',
      egressDeny: ['blocked.example.com'],
    });

    // Simulate a supervisor restart: fresh service instance, and pretend the source-map file
    // itself was also lost — reconcile() must restore the deny list from the container's own
    // label, not merely re-register a bare sourceId (which would silently widen egress).
    egressMap.unregister(outcome.ip as string);
    const second = createResidentService({ config, docker, egressMap });
    await second.reconcile();

    expect(egressMap.read()[outcome.ip as string]).toEqual({
      sourceId: 'entry:ws-1:alice',
      deny: ['blocked.example.com'],
    });
  });
});
