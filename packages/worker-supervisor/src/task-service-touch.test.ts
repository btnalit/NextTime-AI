import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import { createEgressMapStore } from './egress-map.js';
import { createTaskService } from './task-service.js';
import { createFakeDockerClient } from './test-support/fake-docker-client.js';
import { memoryHandleBindings } from './test-support/memory-handle-bindings.js';

/**
 * Legacy 435: a spawn marks its Task's two directories used (`utimesSync`) for the retention
 * sweep. That mark failing must not fail the spawn. `node:fs` is mocked in this file alone so the
 * call can be made to fail without depending on who owns a directory (tests may run as root).
 * `failingCall` makes only that call (1-based) fail; unset, every call does.
 */
const touch = vi.hoisted(() => ({
  failure: undefined as Error | undefined,
  failingCall: undefined as number | undefined,
  calls: 0,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    utimesSync: (...args: Parameters<typeof actual.utimesSync>) => {
      touch.calls += 1;
      if (
        touch.failure !== undefined &&
        (touch.failingCall === undefined || touch.failingCall === touch.calls)
      ) {
        throw touch.failure;
      }
      actual.utimesSync(...args);
    },
  };
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'worker-supervisor-touch-'));
  touch.failure = undefined;
  touch.failingCall = undefined;
  touch.calls = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const config = loadConfig({
    NEXTTIME_DATA: '/host/data',
    LOCAL_DATA_DIR: dir,
    EGRESS_SOURCE_MAP_FILE: join(dir, 'egress-sources.json'),
    TASK_MAX_RUNTIME_SEC: '3600',
  });
  const docker = createFakeDockerClient();
  const service = createTaskService({
    config,
    docker,
    handleBindings: memoryHandleBindings(),
    egressMap: createEgressMapStore(config.egressSourceMapFile),
    now: () => 0,
  });
  return { config, docker, service };
}

const eperm = () =>
  Object.assign(new Error('EPERM: operation not permitted, utime'), { code: 'EPERM' });

const spawnInput = {
  taskId: 'task-1',
  workerRunId: 'run-1',
  workspaceId: 'ws-1',
  onBehalfOf: 'alice',
  capabilityHandle: 'h',
  image: 'nexttime-ai-worker-runtime',
};

describe('task-service spawn: marking the Task directories used (legacy 435)', () => {
  it('a failed mark is logged and the spawn goes on', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    touch.failure = eperm();
    const { docker, service } = setup();

    const outcome = await service.spawn(spawnInput);

    expect(outcome.containerId).toBeDefined();
    expect(docker.createCalls).toHaveLength(1);
    expect(touch.calls).toBe(2);
    const lines = logged.mock.calls.map(([line]) => JSON.parse(String(line)));
    for (const dir of ['workspace', 'platform']) {
      expect(lines).toContainEqual({
        level: 'warn',
        msg: 'task dir touch failed at spawn',
        taskId: 'task-1',
        workerRunId: 'run-1',
        dir,
        error: 'Error: EPERM: operation not permitted, utime',
      });
    }
  });

  it('the workspace mark failing still marks the platform directory (legacy 791)', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    touch.failure = eperm();
    touch.failingCall = 1;
    const { config, service } = setup();

    await service.spawn(spawnInput);

    expect(touch.calls).toBe(2);
    // The clock reads 0, so a directory this spawn marked reads as used at the epoch.
    const tasks = join(config.localDataDir, 'workspaces');
    expect(statSync(join(tasks, '.platform', 'tasks', 'task-1')).mtimeMs).toBe(0);
    expect(statSync(join(tasks, 'tasks', 'task-1')).mtimeMs).not.toBe(0);
    const lines = logged.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(lines).toEqual([expect.objectContaining({ dir: 'workspace' })]);
  });

  it('marks both directories, and logs nothing, when the mark works', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { service } = setup();

    await service.spawn(spawnInput);

    expect(touch.calls).toBe(2);
    expect(logged).not.toHaveBeenCalled();
  });
});
