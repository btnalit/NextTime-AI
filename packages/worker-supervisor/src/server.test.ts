import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { createEgressMapStore } from './egress-map.js';
import { createResidentService } from './resident-service.js';
import { createServer } from './server.js';
import { createTaskService } from './task-service.js';
import { createFakeDockerClient } from './test-support/fake-docker-client.js';

// Resident ids must be UUIDs (config.ts IdClaimSchema): principalId becomes the per-user
// workspace bind-mount source segment and the container name. Fixed, readable stand-ins.
const WS_R = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ALICE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOBODY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
// Resident ids must be UUIDs (config.ts IdClaimSchema): principalId becomes the per-user// workspace bind-mount source segment and the container name. Fixed, readable stand-ins.const WS_R = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';const ALICE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';const NOBODY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'worker-supervisor-server-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function setup(overrides: Record<string, string> = {}) {
  const config = loadConfig({
    NEXTTIME_DATA: '/host/data',
    LOCAL_DATA_DIR: dir,
    EGRESS_SOURCE_MAP_FILE: join(dir, 'egress-sources.json'),
    ...overrides,
  });
  const docker = createFakeDockerClient();
  const egressMap = createEgressMapStore(config.egressSourceMapFile);
  const residentService = createResidentService({ config, docker, egressMap });
  const taskService = createTaskService({ config, docker, egressMap });
  const app = createServer({ residentService, taskService, config });
  return { app, residentService, taskService, config, docker };
}

describe('GET /healthz', () => {
  it('returns 200 {status:"ok"}', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

describe('POST /resident/spawn', () => {
  it('spawns and returns {containerId, ip, status, created, restarts}', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/resident/spawn',
      payload: { workspaceId: WS_R, principalId: ALICE, handle: 'h' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ created: true, status: 'running', restarts: 0 });
    expect(body.containerId).toBeDefined();
    expect(body.ip).toBeDefined();
  });

  it('400s on an invalid body', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/resident/spawn',
      payload: { workspaceId: WS_R },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400s on an unknown field (strict schema)', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/resident/spawn',
      payload: { workspaceId: WS_R, principalId: ALICE, handle: 'h', extra: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400s a traversal-shaped principalId before touching docker (IdClaimSchema)', async () => {
    // principalId becomes the per-user workspace bind-mount source segment and the container
    // name — a non-UUID value must never reach the docker client.
    const { app, docker } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/resident/spawn',
      payload: { workspaceId: WS_R, principalId: '../../pgdata', handle: 'h' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_body');
    expect(docker.createCalls).toHaveLength(0);
  });

  it('spawning twice for the same principal is idempotent (created=false the second time)', async () => {
    const { app } = setup();
    await app.inject({
      method: 'POST',
      url: '/resident/spawn',
      payload: { workspaceId: WS_R, principalId: ALICE, handle: 'h' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/resident/spawn',
      payload: { workspaceId: WS_R, principalId: ALICE, handle: 'h' },
    });
    expect(res.json()).toMatchObject({ created: false });
  });
});

describe('POST /resident/stop', () => {
  it('204s after stopping', async () => {
    const { app } = setup();
    await app.inject({
      method: 'POST',
      url: '/resident/spawn',
      payload: { workspaceId: WS_R, principalId: ALICE, handle: 'h' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/resident/stop',
      payload: { principalId: ALICE },
    });
    expect(res.statusCode).toBe(204);
  });

  it('400s on an invalid body', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'POST', url: '/resident/stop', payload: {} });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /resident/:principalId', () => {
  it('404s when nothing has been spawned', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: `/resident/${NOBODY}` });
    expect(res.statusCode).toBe(404);
  });

  it('400s a non-UUID principalId route param (IdClaimSchema), for GET and touch alike', async () => {
    const { app } = setup();
    const get = await app.inject({ method: 'GET', url: '/resident/not-a-uuid' });
    expect(get.statusCode).toBe(400);
    expect(get.json().error.code).toBe('invalid_principal_id');
    const touch = await app.inject({ method: 'POST', url: '/resident/not-a-uuid/touch' });
    expect(touch.statusCode).toBe(400);
    expect(touch.json().error.code).toBe('invalid_principal_id');
  });

  it('200s with status after spawn', async () => {
    const { app } = setup();
    await app.inject({
      method: 'POST',
      url: '/resident/spawn',
      payload: { workspaceId: WS_R, principalId: ALICE, handle: 'h' },
    });
    const res = await app.inject({ method: 'GET', url: `/resident/${ALICE}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ principalId: ALICE, running: true, restarts: 0 });
  });
});

describe('POST /resident/:principalId/touch', () => {
  it('404s when nothing has been spawned', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'POST', url: `/resident/${NOBODY}/touch` });
    expect(res.statusCode).toBe(404);
  });

  it('204s after spawn', async () => {
    const { app } = setup();
    await app.inject({
      method: 'POST',
      url: '/resident/spawn',
      payload: { workspaceId: WS_R, principalId: ALICE, handle: 'h' },
    });
    const res = await app.inject({ method: 'POST', url: `/resident/${ALICE}/touch` });
    expect(res.statusCode).toBe(204);
  });
});

// taskId/workerRunId/workspaceId/onBehalfOf must be UUIDs (TaskSpawnRequestSchema `idClaim`) —
// see config.test.ts for the schema-level coverage; these are just fixed, readable stand-ins.
const TASK_ID = '11111111-1111-1111-1111-111111111111';
const WORKER_RUN_ID = '22222222-2222-2222-2222-222222222222';
const WORKSPACE_ID = '33333333-3333-3333-3333-333333333333';
const ON_BEHALF_OF = '44444444-4444-4444-4444-444444444444';

const validTaskSpawnBody = {
  taskId: TASK_ID,
  workerRunId: WORKER_RUN_ID,
  workspaceId: WORKSPACE_ID,
  onBehalfOf: ON_BEHALF_OF,
  capabilityHandle: 'h1',
};

describe('POST /task/spawn', () => {
  it('spawns and returns exactly {containerId, ip}', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/task/spawn',
      payload: validTaskSpawnBody,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(['containerId', 'ip']);
    expect(body.containerId).toBeDefined();
    expect(body.ip).toBeDefined();
  });

  it('400s on an invalid body', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/task/spawn',
      payload: { taskId: TASK_ID },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400s on an unknown field (strict schema)', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/task/spawn',
      payload: { ...validTaskSpawnBody, extra: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400s a traversal-shaped taskId, and it never reaches the docker client', async () => {
    const { app, docker } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/task/spawn',
      payload: { ...validTaskSpawnBody, taskId: '../../pgdata' },
    });
    expect(res.statusCode).toBe(400);
    expect(docker.createCalls).toHaveLength(0);
  });

  it('400s a non-UUID workerRunId/workspaceId/onBehalfOf too', async () => {
    const { app } = setup();
    for (const field of ['workerRunId', 'workspaceId', 'onBehalfOf'] as const) {
      const res = await app.inject({
        method: 'POST',
        url: '/task/spawn',
        payload: { ...validTaskSpawnBody, [field]: 'not-a-uuid' },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('403s a non-allowlisted image', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/task/spawn',
      payload: { ...validTaskSpawnBody, image: 'some-random-image' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('200s an explicitly allowlisted image', async () => {
    const { app } = setup({ WORKER_IMAGE_ALLOWLIST: 'some-approved-image' });
    const res = await app.inject({
      method: 'POST',
      url: '/task/spawn',
      payload: { ...validTaskSpawnBody, image: 'some-approved-image' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('400s a skill hostPath outside NEXTTIME_DATA, and it never reaches the docker client', async () => {
    const { app, docker } = setup(); // NEXTTIME_DATA=/host/data (see setup())
    const res = await app.inject({
      method: 'POST',
      url: '/task/spawn',
      payload: {
        ...validTaskSpawnBody,
        skills: [{ name: 'evil', hostPath: '/var/run/docker.sock' }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(docker.createCalls).toHaveLength(0);
  });

  it('400s a skill hostPath that escapes NEXTTIME_DATA via ..', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/task/spawn',
      payload: {
        ...validTaskSpawnBody,
        skills: [{ name: 'evil', hostPath: '/host/data/../../etc' }],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('200s a skill hostPath that resolves under NEXTTIME_DATA', async () => {
    const { app } = setup(); // NEXTTIME_DATA=/host/data
    const res = await app.inject({
      method: 'POST',
      url: '/task/spawn',
      payload: {
        ...validTaskSpawnBody,
        skills: [{ name: 'ok-skill', hostPath: '/host/data/ontology/ops-assets/skills/inventory' }],
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it('501s when Task mode is not wired up', async () => {
    const config = loadConfig({ NEXTTIME_DATA: '/host/data', LOCAL_DATA_DIR: dir });
    const docker = createFakeDockerClient();
    const egressMap = createEgressMapStore(config.egressSourceMapFile);
    const residentService = createResidentService({ config, docker, egressMap });
    const app = createServer({ residentService }); // no taskService/config
    const res = await app.inject({
      method: 'POST',
      url: '/task/spawn',
      payload: validTaskSpawnBody,
    });
    expect(res.statusCode).toBe(501);
  });
});

describe('POST /task/:workerRunId/terminate', () => {
  it('404s for an unknown workerRunId', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'POST', url: '/task/nobody/terminate' });
    expect(res.statusCode).toBe(404);
  });

  it('204s after spawn', async () => {
    const { app } = setup();
    await app.inject({ method: 'POST', url: '/task/spawn', payload: validTaskSpawnBody });
    const res = await app.inject({ method: 'POST', url: `/task/${WORKER_RUN_ID}/terminate` });
    expect(res.statusCode).toBe(204);
  });
});

describe('GET /task/:workerRunId', () => {
  it('404s when nothing has been spawned', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/task/nobody' });
    expect(res.statusCode).toBe(404);
  });

  it('200s with status after spawn', async () => {
    const { app } = setup();
    await app.inject({ method: 'POST', url: '/task/spawn', payload: validTaskSpawnBody });
    const res = await app.inject({ method: 'GET', url: `/task/${WORKER_RUN_ID}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ workerRunId: WORKER_RUN_ID, status: 'running' });
  });

  it('200s with status terminated after terminate', async () => {
    const { app } = setup();
    await app.inject({ method: 'POST', url: '/task/spawn', payload: validTaskSpawnBody });
    await app.inject({ method: 'POST', url: `/task/${WORKER_RUN_ID}/terminate` });
    const res = await app.inject({ method: 'GET', url: `/task/${WORKER_RUN_ID}` });
    expect(res.json()).toMatchObject({ status: 'terminated', reason: 'requested' });
  });
});
