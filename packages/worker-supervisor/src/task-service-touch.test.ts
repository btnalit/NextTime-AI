import { mkdtempSync, rmSync } from 'node:fs';
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
 */
const touch = vi.hoisted(() => ({ failure: undefined as Error | undefined, calls: 0 }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    utimesSync: (...args: Parameters<typeof actual.utimesSync>) => {
      touch.calls += 1;
      if (touch.failure !== undefined) throw touch.failure;
      actual.utimesSync(...args);
    },
  };
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'worker-supervisor-touch-'));
  touch.failure = undefined;
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
  return { docker, service };
}

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
    touch.failure = Object.assign(new Error('EPERM: operation not permitted, utime'), {
      code: 'EPERM',
    });
    const { docker, service } = setup();

    const outcome = await service.spawn(spawnInput);

    expect(outcome.containerId).toBeDefined();
    expect(docker.createCalls).toHaveLength(1);
    expect(touch.calls).toBeGreaterThan(0);
    const lines = logged.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(lines).toContainEqual({
      level: 'warn',
      msg: 'task dirs touch failed at spawn',
      taskId: 'task-1',
      workerRunId: 'run-1',
      error: 'Error: EPERM: operation not permitted, utime',
    });
  });

  it('marks both directories, and logs nothing, when the mark works', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { service } = setup();

    await service.spawn(spawnInput);

    expect(touch.calls).toBe(2);
    expect(logged).not.toHaveBeenCalled();
  });
});
