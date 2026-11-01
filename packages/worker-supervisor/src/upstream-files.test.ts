import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_TASK_DIRS_KEEP_BATCH,
  TaskDirsKeepRequestSchema,
  TaskSpawnRequestSchema,
  loadConfig,
} from './config.js';
import { createEgressMapStore } from './egress-map.js';
import { createTaskService } from './task-service.js';
import { TASK_ID_LABEL } from './task-spawn-spec.js';
import { createFakeDockerClient } from './test-support/fake-docker-client.js';
import { memoryHandleBindings } from './test-support/memory-handle-bindings.js';
import { TaskAlreadySpawnedError, UpstreamFilesUnavailableError } from './upstream-files.js';

/**
 * S11 GO14 (`upstream-files.ts`): a goal step's handoff directory, its owner marker, the read-only
 * mount a later step of the same goal gets, every way that mount is refused, and the kernel's
 * lease on the directories (`keepTaskDirs`) against the retention sweep.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'worker-supervisor-upstream-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER_WS = '22222222-2222-4222-8222-222222222222';
const GOAL = '33333333-3333-4333-8333-333333333333';
const OTHER_GOAL = '44444444-4444-4444-8444-444444444444';
const UP_TASK = '55555555-5555-4555-8555-555555555555';
const DOWN_TASK = '66666666-6666-4666-8666-666666666666';
const UP_RUN = '77777777-7777-4777-8777-777777777777';
const DOWN_RUN = '88888888-8888-4888-8888-888888888888';

function setup(overrides: Record<string, string> = {}) {
  const config = loadConfig({
    NEXTTIME_DATA: '/host/data',
    LOCAL_DATA_DIR: dir,
    EGRESS_SOURCE_MAP_FILE: join(dir, 'egress-sources.json'),
    ...overrides,
  });
  const docker = createFakeDockerClient();
  const service = createTaskService({
    config,
    docker,
    handleBindings: memoryHandleBindings(),
    egressMap: createEgressMapStore(config.egressSourceMapFile),
  });
  return { config, docker, service };
}

const workspaceDir = (taskId: string) => join(dir, 'workspaces', 'tasks', taskId);
const platformDir = (taskId: string) => join(dir, 'workspaces', '.platform', 'tasks', taskId);

function spawnInput(
  taskId: string,
  workerRunId: string,
  extra: Record<string, unknown> = {},
): Parameters<ReturnType<typeof createTaskService>['spawn']>[0] {
  return {
    taskId,
    workerRunId,
    workspaceId: WS,
    onBehalfOf: 'alice',
    capabilityHandle: 'h',
    image: 'nexttime-ai-worker-runtime',
    ...extra,
  };
}

/** The upstream step's Task, spawned for the goal and finished: what a later step mounts. */
async function finishedUpstream(
  ctx: ReturnType<typeof setup>,
  owner: { workspaceId?: string; goalRunId?: string } = {},
): Promise<void> {
  await ctx.service.spawn(
    spawnInput(UP_TASK, UP_RUN, {
      workspaceId: owner.workspaceId ?? WS,
      goalRunId: owner.goalRunId ?? GOAL,
    }),
  );
  writeFileSync(join(workspaceDir(UP_TASK), 'out', 'report.txt'), 'from step a');
  await ctx.service.terminate(UP_RUN);
}

const downstream = (extra: Record<string, unknown> = {}) =>
  spawnInput(DOWN_TASK, DOWN_RUN, {
    goalRunId: GOAL,
    upstream: [{ stepKey: 'a', taskId: UP_TASK }],
    ...extra,
  });

async function refusal(promise: Promise<unknown>): Promise<UpstreamFilesUnavailableError> {
  const err = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(err).toBeInstanceOf(UpstreamFilesUnavailableError);
  return err as UpstreamFilesUnavailableError;
}

describe('a goal step’s own directories', () => {
  it('a Task with a goal run gets an empty handoff directory and an owner marker the Worker cannot write', async () => {
    const { service, docker } = setup();
    await service.spawn(spawnInput(UP_TASK, UP_RUN, { goalRunId: GOAL }));
    expect(statSync(join(workspaceDir(UP_TASK), 'out')).isDirectory()).toBe(true);
    expect(JSON.parse(readFileSync(join(platformDir(UP_TASK), 'owner.json'), 'utf8'))).toEqual({
      workspaceId: WS,
      goalRunId: GOAL,
    });
    // The marker is in the platform directory, which the container mounts read-only.
    expect(docker.createCalls[0]?.binds).toContain(
      `/host/data/workspaces/.platform/tasks/${UP_TASK}:/opt/nexttime/platform:ro`,
    );
  });

  it('a Task outside a goal gets neither', async () => {
    const { service } = setup();
    await service.spawn(spawnInput(UP_TASK, UP_RUN));
    expect(existsSync(join(workspaceDir(UP_TASK), 'out'))).toBe(false);
    expect(existsSync(join(platformDir(UP_TASK), 'owner.json'))).toBe(false);
  });

  it('a goal step’s Task is spawned once: once it has run, another spawn of it is refused before anything is written, with or without its goal run', async () => {
    const ctx = setup();
    await finishedUpstream(ctx);
    const creates = ctx.docker.createCalls.length;
    const marker = readFileSync(join(platformDir(UP_TASK), 'owner.json'), 'utf8');
    for (const extra of [{ goalRunId: GOAL }, {}]) {
      const err = await ctx.service.spawn(spawnInput(UP_TASK, DOWN_RUN, extra)).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(err).toBeInstanceOf(TaskAlreadySpawnedError);
    }
    expect(ctx.docker.createCalls).toHaveLength(creates);
    // What the step left is as it was, and the downstream step still reads it.
    expect(readFileSync(join(workspaceDir(UP_TASK), 'out', 'report.txt'), 'utf8')).toBe(
      'from step a',
    );
    expect(readFileSync(join(platformDir(UP_TASK), 'owner.json'), 'utf8')).toBe(marker);
    await ctx.service.spawn(downstream());

    // A marker of any kind counts — a link is not followed to decide.
    const linked = '99999999-9999-4999-8999-999999999999';
    mkdirSync(platformDir(linked), { recursive: true });
    symlinkSync(join(dir, 'nowhere'), join(platformDir(linked), 'owner.json'));
    await expect(ctx.service.spawn(spawnInput(linked, UP_RUN))).rejects.toBeInstanceOf(
      TaskAlreadySpawnedError,
    );
  });

  it('a Task outside a goal is still requeued under the same Task', async () => {
    const { service, docker } = setup();
    await service.spawn(spawnInput(UP_TASK, UP_RUN));
    await service.terminate(UP_RUN);
    await service.spawn(spawnInput(UP_TASK, DOWN_RUN));
    expect(docker.createCalls).toHaveLength(2);
  });
});

describe('mounting an earlier step’s files', () => {
  it('binds the upstream handoff directory read-only at /upstream/<stepKey>, and nothing else of that Task', async () => {
    const ctx = setup();
    await finishedUpstream(ctx);
    await ctx.service.spawn(downstream());
    const spec = ctx.docker.createCalls.at(-1);
    expect(spec?.binds).toContain(`/host/data/workspaces/tasks/${UP_TASK}/out:/upstream/a:ro`);
    const upstreamBinds = (spec?.binds ?? []).filter((bind) => bind.includes(UP_TASK));
    expect(upstreamBinds).toEqual([`/host/data/workspaces/tasks/${UP_TASK}/out:/upstream/a:ro`]);
  });

  it('refuses while a container of the upstream Task still runs — by the registry, and by Docker when the registry has not caught up', async () => {
    const ctx = setup();
    await ctx.service.spawn(spawnInput(UP_TASK, UP_RUN, { goalRunId: GOAL }));
    expect((await refusal(ctx.service.spawn(downstream()))).state).toBe('running');

    // A fresh supervisor (empty registry, before `reconcile()`) still sees the container.
    const fresh = createTaskService({
      config: ctx.config,
      docker: ctx.docker,
      handleBindings: memoryHandleBindings(),
      egressMap: createEgressMapStore(ctx.config.egressSourceMapFile),
    });
    expect(
      (await ctx.docker.listByLabel(TASK_ID_LABEL, UP_TASK)).some((state) => state.running),
    ).toBe(true);
    expect((await refusal(fresh.spawn(downstream()))).state).toBe('running');
  });

  it('refuses another goal’s files and another workspace’s', async () => {
    const ctx = setup();
    await finishedUpstream(ctx, { goalRunId: OTHER_GOAL });
    const err = await refusal(ctx.service.spawn(downstream()));
    expect(err.state).toBe('not_owned');
    expect(err.stepKey).toBe('a');

    rmSync(workspaceDir(UP_TASK), { recursive: true, force: true });
    rmSync(platformDir(UP_TASK), { recursive: true, force: true });
    await finishedUpstream(ctx, { workspaceId: OTHER_WS });
    expect((await refusal(ctx.service.spawn(downstream()))).state).toBe('not_owned');
  });

  it('refuses a directory without an owner marker (a Task from before this release, or one outside a goal)', async () => {
    const ctx = setup();
    await ctx.service.spawn(spawnInput(UP_TASK, UP_RUN));
    mkdirSync(join(workspaceDir(UP_TASK), 'out'));
    await ctx.service.terminate(UP_RUN);
    expect((await refusal(ctx.service.spawn(downstream()))).state).toBe('not_owned');
  });

  it('refuses an owner marker that is a link or a FIFO, without waiting on the FIFO', async () => {
    const ctx = setup();
    await finishedUpstream(ctx);
    const marker = join(platformDir(UP_TASK), 'owner.json');
    const copy = join(dir, 'owner-copy.json');
    writeFileSync(copy, readFileSync(marker, 'utf8'));
    rmSync(marker);
    symlinkSync(copy, marker);
    expect((await refusal(ctx.service.spawn(downstream()))).state).toBe('not_owned');

    rmSync(marker);
    execFileSync('mkfifo', [marker]);
    expect(statSync(marker).isFIFO()).toBe(true);
    expect((await refusal(ctx.service.spawn(downstream()))).state).toBe('not_owned');
  });

  it('refuses when the handoff directory or the whole Task directory is gone', async () => {
    const ctx = setup();
    await finishedUpstream(ctx);
    rmSync(join(workspaceDir(UP_TASK), 'out'), { recursive: true });
    expect((await refusal(ctx.service.spawn(downstream()))).state).toBe('missing');
    rmSync(workspaceDir(UP_TASK), { recursive: true });
    expect((await refusal(ctx.service.spawn(downstream()))).state).toBe('missing');
  });

  it('refuses an `out` the upstream Worker replaced with a link — to a directory elsewhere on the host, or to its own workspace', async () => {
    const ctx = setup();
    await finishedUpstream(ctx);
    const elsewhere = join(dir, 'host-secrets');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'handle.key'), 'not for a Worker');
    const out = join(workspaceDir(UP_TASK), 'out');
    rmSync(out, { recursive: true });
    symlinkSync(elsewhere, out);
    expect((await refusal(ctx.service.spawn(downstream()))).state).toBe('not_a_directory');

    rmSync(out);
    symlinkSync('.', out);
    expect((await refusal(ctx.service.spawn(downstream()))).state).toBe('not_a_directory');
  });

  it('refuses an `out` that is a FIFO or a plain file', async () => {
    const ctx = setup();
    await finishedUpstream(ctx);
    const out = join(workspaceDir(UP_TASK), 'out');
    rmSync(out, { recursive: true });
    writeFileSync(out, 'a file, not a directory');
    expect((await refusal(ctx.service.spawn(downstream()))).state).toBe('not_a_directory');

    rmSync(out);
    execFileSync('mkfifo', [out]);
    expect(statSync(out).isFIFO()).toBe(true);
    expect((await refusal(ctx.service.spawn(downstream()))).state).toBe('not_a_directory');
  });

  it('refuses a Task directory that is itself a link', async () => {
    const ctx = setup();
    await finishedUpstream(ctx);
    const moved = join(dir, 'moved-task');
    execFileSync('mv', [workspaceDir(UP_TASK), moved]);
    symlinkSync(moved, workspaceDir(UP_TASK));
    expect((await refusal(ctx.service.spawn(downstream()))).state).toBe('not_a_directory');
  });

  it('writes nothing and starts nothing for a refused spawn', async () => {
    const ctx = setup();
    await finishedUpstream(ctx, { goalRunId: OTHER_GOAL });
    const creates = ctx.docker.createCalls.length;
    await refusal(ctx.service.spawn(downstream()));
    expect(ctx.docker.createCalls).toHaveLength(creates);
    expect(existsSync(workspaceDir(DOWN_TASK))).toBe(false);
    expect(existsSync(platformDir(DOWN_TASK))).toBe(false);
  });

  it('a later step’s own handoff directory is made as for any goal step', async () => {
    const ctx = setup();
    await finishedUpstream(ctx);
    await ctx.service.spawn(downstream());
    expect(statSync(join(workspaceDir(DOWN_TASK), 'out')).isDirectory()).toBe(true);
  });
});

describe('the kernel’s lease on goal step directories (keepTaskDirs)', () => {
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000);

  it('marks a kept Task’s two directories used, so the retention sweep leaves them; an unkept one goes', async () => {
    const ctx = setup({ TASK_WORKDIR_RETENTION_HOURS: '2' });
    await finishedUpstream(ctx);
    for (const path of [workspaceDir(UP_TASK), platformDir(UP_TASK)]) {
      utimesSync(path, hoursAgo(3), hoursAgo(3));
    }
    const result = await ctx.service.keepTaskDirs([
      { taskId: UP_TASK, workspaceId: WS, goalRunId: GOAL },
    ]);
    expect(result).toEqual([{ taskId: UP_TASK, state: 'kept' }]);
    await ctx.service.sweepRetention();
    expect(existsSync(workspaceDir(UP_TASK))).toBe(true);
    expect(existsSync(platformDir(UP_TASK))).toBe(true);

    // The goal has ended: no more renewals, and the directories go after the retention period.
    for (const path of [workspaceDir(UP_TASK), platformDir(UP_TASK)]) {
      utimesSync(path, hoursAgo(3), hoursAgo(3));
    }
    await ctx.service.sweepRetention();
    expect(existsSync(workspaceDir(UP_TASK))).toBe(false);
    expect(existsSync(platformDir(UP_TASK))).toBe(false);
  });

  it('reports each Task’s state and renews only the kept ones', async () => {
    const ctx = setup();
    await finishedUpstream(ctx);
    utimesSync(workspaceDir(UP_TASK), hoursAgo(3), hoursAgo(3));
    const result = await ctx.service.keepTaskDirs([
      { taskId: UP_TASK, workspaceId: WS, goalRunId: OTHER_GOAL },
      { taskId: DOWN_TASK, workspaceId: WS, goalRunId: GOAL },
    ]);
    expect(result).toEqual([
      { taskId: UP_TASK, state: 'not_owned' },
      { taskId: DOWN_TASK, state: 'missing' },
    ]);
    expect(statSync(workspaceDir(UP_TASK)).mtimeMs).toBeLessThan(hoursAgo(2).getTime());
  });

  it('reports a running Task as running', async () => {
    const ctx = setup();
    await ctx.service.spawn(spawnInput(UP_TASK, UP_RUN, { goalRunId: GOAL }));
    expect(
      await ctx.service.keepTaskDirs([{ taskId: UP_TASK, workspaceId: WS, goalRunId: GOAL }]),
    ).toEqual([{ taskId: UP_TASK, state: 'running' }]);
  });
});

describe('request schemas', () => {
  const base = {
    taskId: DOWN_TASK,
    workerRunId: DOWN_RUN,
    workspaceId: WS,
    onBehalfOf: WS,
    capabilityHandle: 'h',
  };

  it('takes upstream files only with a goal run, distinct, never the Task itself, at most eight', () => {
    expect(
      TaskSpawnRequestSchema.safeParse({
        ...base,
        goalRunId: GOAL,
        upstream: [{ stepKey: 'a', taskId: UP_TASK }],
      }).success,
    ).toBe(true);
    expect(
      TaskSpawnRequestSchema.safeParse({ ...base, upstream: [{ stepKey: 'a', taskId: UP_TASK }] })
        .success,
    ).toBe(false);
    expect(
      TaskSpawnRequestSchema.safeParse({
        ...base,
        goalRunId: GOAL,
        upstream: [
          { stepKey: 'a', taskId: UP_TASK },
          { stepKey: 'a', taskId: OTHER_GOAL },
        ],
      }).success,
    ).toBe(false);
    expect(
      TaskSpawnRequestSchema.safeParse({
        ...base,
        goalRunId: GOAL,
        upstream: [
          { stepKey: 'a', taskId: UP_TASK },
          { stepKey: 'b', taskId: UP_TASK },
        ],
      }).success,
    ).toBe(false);
    expect(
      TaskSpawnRequestSchema.safeParse({
        ...base,
        goalRunId: GOAL,
        upstream: [{ stepKey: 'a', taskId: DOWN_TASK }],
      }).success,
    ).toBe(false);
    const nine = Array.from({ length: 9 }, (_, i) => ({
      stepKey: `s${i}`,
      taskId: `${'9'.repeat(8)}-9999-4999-8999-${String(i).padStart(12, '0')}`,
    }));
    expect(
      TaskSpawnRequestSchema.safeParse({ ...base, goalRunId: GOAL, upstream: nine }).success,
    ).toBe(false);
  });

  it('never takes a step key that is not one path segment, or a Task id that is not a UUID', () => {
    for (const stepKey of ['../a', 'a/b', '.', '..', '.pi', '']) {
      expect(
        TaskSpawnRequestSchema.safeParse({
          ...base,
          goalRunId: GOAL,
          upstream: [{ stepKey, taskId: UP_TASK }],
        }).success,
        stepKey,
      ).toBe(false);
    }
    expect(
      TaskSpawnRequestSchema.safeParse({
        ...base,
        goalRunId: GOAL,
        upstream: [{ stepKey: 'a', taskId: '../../secrets' }],
      }).success,
    ).toBe(false);
  });

  it('a keep names UUIDs only, at most one batch', () => {
    expect(
      TaskDirsKeepRequestSchema.safeParse({
        tasks: [{ taskId: UP_TASK, workspaceId: WS, goalRunId: GOAL }],
      }).success,
    ).toBe(true);
    expect(
      TaskDirsKeepRequestSchema.safeParse({
        tasks: [{ taskId: '../x', workspaceId: WS, goalRunId: GOAL }],
      }).success,
    ).toBe(false);
    expect(
      TaskDirsKeepRequestSchema.safeParse({
        tasks: Array.from({ length: MAX_TASK_DIRS_KEEP_BATCH + 1 }, () => ({
          taskId: UP_TASK,
          workspaceId: WS,
          goalRunId: GOAL,
        })),
      }).success,
    ).toBe(false);
  });

  it('a retention shorter than two hours does not start', () => {
    expect(() => setup({ TASK_WORKDIR_RETENTION_HOURS: '1' })).toThrow(
      /TASK_WORKDIR_RETENTION_HOURS must be at least 2/,
    );
  });
});
