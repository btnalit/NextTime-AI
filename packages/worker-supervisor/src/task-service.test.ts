import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { createEgressMapStore } from './egress-map.js';
import type { EgressMapStore } from './egress-map.js';
import { createTaskService } from './task-service.js';
import { createFakeDockerClient } from './test-support/fake-docker-client.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'worker-supervisor-task-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function setup(overrides: Record<string, string> = {}) {
  const config = loadConfig({
    NEXTTIME_DATA: '/host/data',
    LOCAL_DATA_DIR: dir,
    EGRESS_SOURCE_MAP_FILE: join(dir, 'egress-sources.json'),
    TASK_MAX_RUNTIME_SEC: '3600',
    ...overrides,
  });
  const docker = createFakeDockerClient();
  const egressMap = createEgressMapStore(config.egressSourceMapFile);
  let clock = 0;
  const service = createTaskService({ config, docker, egressMap, now: () => clock });
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

const spawnInput = {
  taskId: 'task-1',
  workerRunId: 'run-1',
  workspaceId: 'ws-1',
  onBehalfOf: 'alice',
  capabilityHandle: 'h',
  image: 'nexttime-ai-worker-runtime',
};

describe('task-service spawn', () => {
  it('creates a container and returns exactly {containerId, ip}', async () => {
    const { service, docker } = setup();
    const outcome = await service.spawn(spawnInput);
    expect(outcome.containerId).toBeDefined();
    expect(outcome.ip).toBeDefined();
    expect(Object.keys(outcome).sort()).toEqual(['containerId', 'ip']);
    expect(docker.createCalls).toHaveLength(1);
    expect(docker.createCalls[0]?.name).toBe('nexttime-task-run-1');
  });

  it('pre-creates .pi/agent under workspaces/tasks/<taskId> before asking Docker to create the container', async () => {
    const { service, config } = setup();
    await service.spawn(spawnInput);
    const stat = statSync(
      join(config.localDataDir, 'workspaces', 'tasks', 'task-1', '.pi', 'agent'),
    );
    expect(stat.isDirectory()).toBe(true);
  });

  it('writes skillsInline files under <agentDir>/skills/<name>/ before creating the container', async () => {
    const { service, config, docker } = setup();
    await service.spawn({
      ...spawnInput,
      skillsInline: [
        {
          name: 'diagnose-network',
          files: {
            'SKILL.md': '---\nname: diagnose-network\n---\n\nRun `ss -tnp`.\n',
            'references/notes.md': 'extra notes',
          },
        },
      ],
    });
    const skillDir = join(
      config.localDataDir,
      'workspaces',
      'tasks',
      'task-1',
      '.pi',
      'agent',
      'skills',
      'diagnose-network',
    );
    expect(readFileSync(join(skillDir, 'SKILL.md'), 'utf8')).toContain('diagnose-network');
    expect(readFileSync(join(skillDir, 'references', 'notes.md'), 'utf8')).toBe('extra notes');
    // The files are written *before* Docker is asked to create the container, not after.
    expect(docker.createCalls).toHaveLength(1);
  });

  it('spawns without any skillsInline entries just as before (no directory created)', async () => {
    const { service, config } = setup();
    await service.spawn(spawnInput);
    const skillsDir = join(
      config.localDataDir,
      'workspaces',
      'tasks',
      'task-1',
      '.pi',
      'agent',
      'skills',
    );
    expect(existsSync(skillsDir)).toBe(false);
  });

  it('registers the spawned container IP in the egress source map as worker:<ws>:<workerRunId>', async () => {
    const { service, egressMap } = setup();
    const outcome = await service.spawn(spawnInput);
    expect(egressMap.read()[outcome.ip as string]).toEqual({ sourceId: 'worker:ws-1:run-1' });
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
    const service = createTaskService({ config, docker, egressMap: throwingEgressMap });
    await expect(service.spawn(spawnInput)).resolves.toBeDefined();
  });

  it('keeps separate containers and workspaces per Task, even for the same workspace', async () => {
    const { service, docker } = setup();
    const first = await service.spawn(spawnInput);
    const second = await service.spawn({
      ...spawnInput,
      taskId: 'task-2',
      workerRunId: 'run-2',
    });
    expect(first.containerId).not.toBe(second.containerId);
    expect(docker.createCalls[0]?.binds[0]).toBe('/host/data/workspaces/tasks/task-1:/workspace');
    expect(docker.createCalls[1]?.binds[0]).toBe('/host/data/workspaces/tasks/task-2:/workspace');
  });

  it('arms the timeout deadline from timeoutSec when given, else config.taskMaxRuntimeSec', async () => {
    const { service, docker, advanceClock } = setup({ TASK_MAX_RUNTIME_SEC: '100' });
    await service.spawn({ ...spawnInput, timeoutSec: 10 });
    advanceClock(10_001);
    await service.reap();
    expect(docker.stopCalls.map((c) => c.name)).toEqual(['nexttime-task-run-1']);
  });
});

describe('task-service terminate', () => {
  it('returns false for an unknown workerRunId', async () => {
    const { service } = setup();
    expect(await service.terminate('nobody')).toBe(false);
  });

  it('stops the container, unregisters egress, and marks status terminated with reason requested', async () => {
    const { service, docker, egressMap } = setup();
    const outcome = await service.spawn(spawnInput);
    const terminated = await service.terminate('run-1');

    expect(terminated).toBe(true);
    expect(docker.stopCalls).toEqual([{ name: 'nexttime-task-run-1', timeoutSeconds: 5 }]);
    expect(egressMap.read()[outcome.ip as string]).toBeUndefined();

    const status = await service.status('run-1');
    expect(status).toMatchObject({ status: 'terminated', reason: 'requested' });
    expect(status?.finishedAt).toBeDefined();
  });

  it('removes the container after terminating', async () => {
    const { service, docker } = setup();
    await service.spawn(spawnInput);
    await service.terminate('run-1');
    expect(docker.removeCalls).toEqual(['nexttime-task-run-1']);
  });

  it('is idempotent: terminating an already-terminated Task is a no-op success', async () => {
    const { service, docker } = setup();
    await service.spawn(spawnInput);
    await service.terminate('run-1');
    const again = await service.terminate('run-1');
    expect(again).toBe(true);
    expect(docker.stopCalls).toHaveLength(1); // not called a second time
  });
});

describe('task-service status transitions', () => {
  it('returns undefined for an unknown workerRunId', async () => {
    const { service } = setup();
    expect(await service.status('nobody')).toBeUndefined();
  });

  it('reports running right after spawn', async () => {
    const { service } = setup();
    const outcome = await service.spawn(spawnInput);
    const status = await service.status('run-1');
    expect(status).toMatchObject({
      workerRunId: 'run-1',
      status: 'running',
      containerId: outcome.containerId,
      ip: outcome.ip,
    });
    expect(status?.exitCode).toBeUndefined();
    expect(status?.finishedAt).toBeUndefined();
  });

  it('transitions to exited (exit code 0) when the container exits on its own, noticed on status()', async () => {
    const { service, docker, egressMap } = setup();
    const outcome = await service.spawn(spawnInput);
    docker.simulateExit('nexttime-task-run-1', 0);

    const status = await service.status('run-1');
    expect(status).toMatchObject({ status: 'exited', exitCode: 0 });
    expect(status?.finishedAt).toBeDefined();
    expect(egressMap.read()[outcome.ip as string]).toBeUndefined();
    expect(docker.removeCalls).toEqual(['nexttime-task-run-1']);
  });

  it('transitions to failed (non-zero exit code) when the container exits on its own', async () => {
    const { service, docker } = setup();
    await service.spawn(spawnInput);
    docker.simulateExit('nexttime-task-run-1', 1);

    const status = await service.status('run-1');
    expect(status).toMatchObject({ status: 'failed', exitCode: 1 });
  });

  it('a SIGKILL-style non-zero exit after an explicit terminate is still classified terminated, not failed', async () => {
    const { service } = setup();
    await service.spawn(spawnInput);
    // fake docker's stop() sets exitCode 137 (SIGKILL) — terminate() must not read that as "failed".
    await service.terminate('run-1');
    const status = await service.status('run-1');
    expect(status).toMatchObject({ status: 'terminated', exitCode: 137 });
  });

  it('a terminal status is stable across repeated status() calls (no double-remove, no re-inspect churn)', async () => {
    const { service, docker } = setup();
    await service.spawn(spawnInput);
    docker.simulateExit('nexttime-task-run-1', 0);
    await service.status('run-1');
    const again = await service.status('run-1');
    expect(again).toMatchObject({ status: 'exited', exitCode: 0 });
    expect(docker.removeCalls).toHaveLength(1);
  });
});

describe('task-service reap', () => {
  it('terminates (with reason timeout) a Task past its deadline', async () => {
    const { service, docker, advanceClock } = setup({ TASK_MAX_RUNTIME_SEC: '10' });
    await service.spawn(spawnInput);
    advanceClock(10_001);
    await service.reap();

    expect(docker.stopCalls).toEqual([{ name: 'nexttime-task-run-1', timeoutSeconds: 5 }]);
    const status = await service.status('run-1');
    expect(status).toMatchObject({ status: 'terminated', reason: 'timeout' });
  });

  it('leaves a Task under its deadline running and untouched', async () => {
    const { service, docker, advanceClock } = setup({ TASK_MAX_RUNTIME_SEC: '10' });
    await service.spawn(spawnInput);
    advanceClock(5_000);
    await service.reap();

    expect(docker.stopCalls).toHaveLength(0);
    expect((await service.status('run-1'))?.status).toBe('running');
  });

  it('reaps a Task that exited on its own before its deadline, without status() being polled first', async () => {
    const { service, docker } = setup({ TASK_MAX_RUNTIME_SEC: '3600' });
    await service.spawn(spawnInput);
    docker.simulateExit('nexttime-task-run-1', 0);

    await service.reap();

    expect(docker.removeCalls).toEqual(['nexttime-task-run-1']);
    const status = await service.status('run-1');
    expect(status).toMatchObject({ status: 'exited', exitCode: 0 });
  });
});

describe('task-service reconcile', () => {
  it('re-registers a still-running container found by label after a simulated supervisor restart', async () => {
    const { config, docker, egressMap } = setup();
    const first = createTaskService({ config, docker, egressMap });
    const outcome = await first.spawn(spawnInput);

    egressMap.unregister(outcome.ip as string); // pretend the file was also reset/lost
    const second = createTaskService({ config, docker, egressMap });
    await second.reconcile();

    expect(egressMap.read()[outcome.ip as string]).toEqual({ sourceId: 'worker:ws-1:run-1' });
    const status = await second.status('run-1');
    expect(status).toMatchObject({ status: 'running', containerId: outcome.containerId });
  });

  it('reconciles an already-exited container into exited/failed by its recorded exit code', async () => {
    const { config, docker, egressMap } = setup();
    const first = createTaskService({ config, docker, egressMap });
    await first.spawn(spawnInput);
    docker.simulateExit('nexttime-task-run-1', 1);

    const second = createTaskService({ config, docker, egressMap });
    await second.reconcile();
    const status = await second.status('run-1');
    expect(status).toMatchObject({ status: 'failed', exitCode: 1 });
  });

  it('does not clobber a workerRunId this instance already knows about', async () => {
    const { service, docker } = setup();
    await service.spawn(spawnInput);
    await expect(service.reconcile()).resolves.toBeUndefined();
    expect(docker.createCalls).toHaveLength(1);
    expect((await service.status('run-1'))?.status).toBe('running');
  });
});

describe('task-service sweepRetention', () => {
  // Retention compares each directory's real filesystem mtime against `now()` — unlike the other
  // describe blocks here, this one deliberately does NOT inject the virtual `clock` (it would
  // never line up with a real mtime), so `now` falls back to createTaskService's own real
  // `Date.now`.
  function setupRealClock(overrides: Record<string, string> = {}) {
    const config = loadConfig({
      NEXTTIME_DATA: '/host/data',
      LOCAL_DATA_DIR: dir,
      EGRESS_SOURCE_MAP_FILE: join(dir, 'egress-sources.json'),
      ...overrides,
    });
    const docker = createFakeDockerClient();
    const egressMap = createEgressMapStore(config.egressSourceMapFile);
    const service = createTaskService({ config, docker, egressMap });
    return { config, docker, egressMap, service };
  }

  function taskDir(config: { localDataDir: string }, taskId: string): string {
    return join(config.localDataDir, 'workspaces', 'tasks', taskId);
  }

  it('does nothing (no throw) when workspaces/tasks does not exist yet', async () => {
    const { service } = setupRealClock();
    await expect(service.sweepRetention()).resolves.toBeUndefined();
  });

  it('deletes a finished Task directory older than the retention window', async () => {
    const { service, config } = setupRealClock({ TASK_WORKDIR_RETENTION_HOURS: '1' });
    const old = taskDir(config, 'old-task');
    mkdirSync(old, { recursive: true });
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(old, twoHoursAgo, twoHoursAgo);

    await service.sweepRetention();
    expect(existsSync(old)).toBe(false);
  });

  it('keeps a Task directory younger than the retention window', async () => {
    const { service, config } = setupRealClock({ TASK_WORKDIR_RETENTION_HOURS: '1' });
    const recent = taskDir(config, 'recent-task');
    mkdirSync(recent, { recursive: true });

    await service.sweepRetention();
    expect(existsSync(recent)).toBe(true);
  });

  it('never deletes the workdir of a Task the registry still marks running, even if old', async () => {
    const { service, config } = setupRealClock({ TASK_WORKDIR_RETENTION_HOURS: '1' });
    await service.spawn(spawnInput); // taskId: 'task-1', still running
    const dirPath = taskDir(config, 'task-1');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(dirPath, twoHoursAgo, twoHoursAgo);

    await service.sweepRetention();
    expect(existsSync(dirPath)).toBe(true);
  });
});
