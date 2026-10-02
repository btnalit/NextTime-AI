import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { createEgressMapStore } from './egress-map.js';
import { createSupervisorMetrics } from './metrics.js';
import { createResidentService } from './resident-service.js';
import { createServer } from './server.js';
import { createTaskService } from './task-service.js';
import { createFakeDockerClient } from './test-support/fake-docker-client.js';

// Resident ids must be UUIDs (config.ts IdClaimSchema): principalId becomes the per-user
// workspace bind-mount source segment and the container name. Fixed, readable stand-ins.
const WS_R = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ALICE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOBODY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

// Fixed test internal-plane token — POST /task/spawn and every /resident/* route require it
// (internal-auth.ts, lane-6 review P1-3: this supervisor is dual-homed on `control`+`workers`,
// so any agent container could otherwise reach these routes directly). AUTH is the header every
// test below sends for a guarded route; the dedicated "internal-plane auth" describe block below
// covers the missing/wrong-token rejection paths themselves. R-03: each caller has its own
// credential and each route admits only its callers — AUTH is the kernel's (task spawn, stop,
// reclaim, status, inventories, metrics), AGENT_HOST_AUTH agent-host's (resident spawn, stop,
// status, touch).
const TEST_INTERNAL_TOKEN = 'test-internal-token-0123456789abcdef';
const AUTH = { authorization: `Bearer ${TEST_INTERNAL_TOKEN}` };
const TEST_AGENT_HOST_TOKEN = 'test-agent-host-token-0123456789abcdef';
const AGENT_HOST_AUTH = { authorization: `Bearer ${TEST_AGENT_HOST_TOKEN}` };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'worker-supervisor-server-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function setup(
  overrides: Record<string, string> = {},
  // `'internalToken' in serverOptions` (not `serverOptions.internalToken !== undefined`) is what
  // lets the fail-closed test below pass `{ internalToken: undefined }` and actually get
  // `undefined` through to `createServer` — a plain `?: string` default couldn't otherwise
  // distinguish "no override passed" from "explicitly asked for no token".
  serverOptions: { internalToken?: string; agentHostToken?: string } = {},
) {
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
  const internalToken =
    'internalToken' in serverOptions ? serverOptions.internalToken : TEST_INTERNAL_TOKEN;
  const agentHostToken =
    'agentHostToken' in serverOptions ? serverOptions.agentHostToken : TEST_AGENT_HOST_TOKEN;
  const app = createServer({ residentService, taskService, config, internalToken, agentHostToken });
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

describe('internal-plane auth — POST /task/spawn and /resident/*', () => {
  it('401s POST /resident/spawn with no Authorization header', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/resident/spawn',
      payload: { workspaceId: WS_R, principalId: ALICE, handle: 'h' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
  });

  it('401s POST /resident/spawn with the wrong token', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/resident/spawn',
      headers: { authorization: 'Bearer wrong-token' },
      payload: { workspaceId: WS_R, principalId: ALICE, handle: 'h' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('401s POST /task/spawn with no Authorization header', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/task/spawn',
      payload: {
        taskId: '11111111-1111-1111-1111-111111111111',
        workerRunId: '22222222-2222-2222-2222-222222222222',
        workspaceId: '33333333-3333-3333-3333-333333333333',
        onBehalfOf: '44444444-4444-4444-4444-444444444444',
        capabilityHandle: 'h1',
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it('fails closed: with no credentials configured, every guarded route rejects even with a header', async () => {
    const { app } = setup({}, { internalToken: undefined, agentHostToken: undefined });
    for (const headers of [AUTH, AGENT_HOST_AUTH]) {
      const res = await app.inject({
        method: 'POST',
        url: '/resident/spawn',
        headers,
        payload: { workspaceId: WS_R, principalId: ALICE, handle: 'h' },
      });
      expect(res.statusCode).toBe(401);
      const stop = await app.inject({
        method: 'POST',
        url: '/resident/stop',
        headers,
        payload: { principalId: ALICE },
      });
      expect(stop.statusCode).toBe(401);
    }
  });

  it('R-03: admits each caller only on its own routes — agent-host cannot spawn tasks, reclaim or read inventories; the kernel cannot spawn or touch resident containers', async () => {
    const { app } = setup();
    const taskBody = {
      taskId: '11111111-1111-1111-1111-111111111111',
      workerRunId: '22222222-2222-2222-2222-222222222222',
      workspaceId: '33333333-3333-3333-3333-333333333333',
      onBehalfOf: '44444444-4444-4444-4444-444444444444',
      capabilityHandle: 'h1',
    };
    const kernelOnly = [
      { method: 'POST' as const, url: '/task/spawn', payload: taskBody },
      { method: 'POST' as const, url: '/resident/reclaim', payload: { principalId: ALICE } },
      { method: 'GET' as const, url: '/residents' },
      { method: 'GET' as const, url: '/images' },
      { method: 'GET' as const, url: '/internal/metrics' },
    ];
    for (const request of kernelOnly) {
      const res = await app.inject({ ...request, headers: AGENT_HOST_AUTH });
      expect(res.statusCode, `agent-host on ${request.url}`).toBe(401);
    }
    const agentHostOnly = [
      {
        method: 'POST' as const,
        url: '/resident/spawn',
        payload: { workspaceId: WS_R, principalId: ALICE, handle: 'h' },
      },
      { method: 'POST' as const, url: `/resident/${ALICE}/touch` },
    ];
    for (const request of agentHostOnly) {
      const res = await app.inject({ ...request, headers: AUTH });
      expect(res.statusCode, `kernel on ${request.url}`).toBe(401);
    }

    // Both may stop and read status: agent-host for its entry containers, the kernel (and the
    // scripts that run in a kernel container) for purge / acceptance clean-up.
    for (const headers of [AUTH, AGENT_HOST_AUTH]) {
      const stop = await app.inject({
        method: 'POST',
        url: '/resident/stop',
        headers,
        payload: { principalId: NOBODY },
      });
      expect(stop.statusCode).not.toBe(401);
      const status = await app.inject({ method: 'GET', url: `/resident/${NOBODY}`, headers });
      expect(status.statusCode).toBe(404);
    }
  });

  it('does not guard unrelated routes (GET /healthz, GET/POST /task/:workerRunId)', async () => {
    const { app } = setup();
    const healthz = await app.inject({ method: 'GET', url: '/healthz' });
    expect(healthz.statusCode).toBe(200);
    const taskStatus = await app.inject({ method: 'GET', url: '/task/nobody' });
    expect(taskStatus.statusCode).toBe(404); // not 401 — this route is not guarded
    const terminate = await app.inject({ method: 'POST', url: '/task/nobody/terminate' });
    expect(terminate.statusCode).toBe(404); // not 401 — this route is not guarded
  });
});

describe('POST /resident/spawn', () => {
  it('spawns and returns {containerId, ip, status, created, restarts}', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/resident/spawn',
      headers: AGENT_HOST_AUTH,
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
      headers: AGENT_HOST_AUTH,
      payload: { workspaceId: WS_R },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400s on an unknown field (strict schema)', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/resident/spawn',
      headers: AGENT_HOST_AUTH,
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
      headers: AGENT_HOST_AUTH,
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
      headers: AGENT_HOST_AUTH,
      payload: { workspaceId: WS_R, principalId: ALICE, handle: 'h' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/resident/spawn',
      headers: AGENT_HOST_AUTH,
      payload: { workspaceId: WS_R, principalId: ALICE, handle: 'h' },
    });
    expect(res.json()).toMatchObject({ created: false });
  });

  // S7-E (P-C §6.5 决定 E1): the optional `image` is checked against the exact same allowlist
  // `/task/spawn` already enforces above — one security boundary for both spawn APIs.
  it('403s a non-allowlisted image (same allowlist /task/spawn uses)', async () => {
    const { app, docker } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/resident/spawn',
      headers: AGENT_HOST_AUTH,
      payload: { workspaceId: WS_R, principalId: ALICE, handle: 'h', image: 'some-random-image' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('image_not_allowed');
    expect(docker.createCalls).toHaveLength(0);
  });

  it('200s an explicitly allowlisted image and spawns the container with it', async () => {
    const { app, docker } = setup({ WORKER_IMAGE_ALLOWLIST: 'some-approved-image' });
    const res = await app.inject({
      method: 'POST',
      url: '/resident/spawn',
      headers: AGENT_HOST_AUTH,
      payload: {
        workspaceId: WS_R,
        principalId: ALICE,
        handle: 'h',
        image: 'some-approved-image',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(docker.createCalls[0]?.image).toBe('some-approved-image');
  });

  it('200s and uses config.workerImage when image is omitted (unchanged pre-S7-E behavior)', async () => {
    const { app, docker, config } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/resident/spawn',
      headers: AGENT_HOST_AUTH,
      payload: { workspaceId: WS_R, principalId: ALICE, handle: 'h' },
    });
    expect(res.statusCode).toBe(200);
    expect(docker.createCalls[0]?.image).toBe(config.workerImage);
  });
});

describe('GET /residents (S7-E inventory)', () => {
  it('401s with no Authorization header', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/residents' });
    expect(res.statusCode).toBe(401);
  });

  it('lists every resident container', async () => {
    const { app } = setup();
    await app.inject({
      method: 'POST',
      url: '/resident/spawn',
      headers: AGENT_HOST_AUTH,
      payload: { workspaceId: WS_R, principalId: ALICE, handle: 'h' },
    });
    const res = await app.inject({ method: 'GET', url: '/residents', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ principalId: ALICE, workspaceId: WS_R, running: true });
  });
});

describe('GET /images (S7-E inventory)', () => {
  it('401s with no Authorization header', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/images' });
    expect(res.statusCode).toBe(401);
  });

  it('lists only images carrying the platform pi-version label, plus defaultImage (S7-E)', async () => {
    const { app, docker, config } = setup();
    docker.registerImage({
      id: 'sha256:abc',
      tags: ['nexttime-ai-worker-runtime:v1'],
      created: '2026-09-22T00:00:00.000Z',
      labels: { 'ai.nexttime.pi-version': '0.84.4' },
    });
    docker.registerImage({
      id: 'sha256:def',
      tags: ['unrelated:latest'],
      created: '2026-09-22T00:00:00.000Z',
      labels: {},
    });
    const res = await app.inject({ method: 'GET', url: '/images', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.defaultImage).toBe(config.workerImage);
    expect(body.images).toEqual([
      {
        id: 'sha256:abc',
        tags: ['nexttime-ai-worker-runtime:v1'],
        created: '2026-09-22T00:00:00.000Z',
        labels: { 'ai.nexttime.pi-version': '0.84.4' },
      },
    ]);
    // P1-a hotfix (post-v0.16.0 review): `GET /images` must also report the exact allowlist
    // `/task/spawn` and `/resident/spawn` enforce (`config.taskImageAllowlist`), so the kernel can
    // reject a non-allowlisted `set_active_runtime_image` target instead of only 403ing at spawn.
    expect(body.allowedImages).toEqual(config.taskImageAllowlist);
  });

  it('reports allowedImages additively from WORKER_IMAGE_ALLOWLIST (P1-a hotfix)', async () => {
    const { app, config } = setup({ WORKER_IMAGE_ALLOWLIST: 'nexttime-ai-worker-runtime:v2' });
    const res = await app.inject({ method: 'GET', url: '/images', headers: AUTH });
    expect(res.statusCode).toBe(200);
    // P1-a review follow-up (PR #233): config.workerImage stays raw — allowedImages is the
    // normalized form, Docker's own implicit :latest.
    expect(config.workerImage).toBe('nexttime-ai-worker-runtime');
    expect(res.json().allowedImages).toEqual([
      'nexttime-ai-worker-runtime:latest',
      'nexttime-ai-worker-runtime:v2',
    ]);
  });

  // v0.16.2 (fix/supervisor-images-proxy): verified on the production host — worker-supervisor's
  // GET /images 403'd because docker-socket-proxy (IMAGES=0) refused the call. The fix adds a
  // dedicated docker-socket-proxy-images instance the images client talks to instead, but this
  // route must still fail predictably (502, not a raw pass-through of Docker's 403 or an
  // unhandled-error 500) whenever the upstream call fails for any reason.
  it('502s with code docker_upstream_error and the upstream status when the images Docker client rejects (e.g. docker-socket-proxy-images 403ing the call)', async () => {
    const config = loadConfig({
      NEXTTIME_DATA: '/host/data',
      LOCAL_DATA_DIR: dir,
      EGRESS_SOURCE_MAP_FILE: join(dir, 'egress-sources.json'),
    });
    const docker = createFakeDockerClient();
    const imagesDocker = createFakeDockerClient();
    const upstreamError = Object.assign(
      new Error('(HTTP code 403) unexpected - Request forbidden by administrative rules'),
      { statusCode: 403 },
    );
    imagesDocker.listImages = async () => {
      throw upstreamError;
    };
    const egressMap = createEgressMapStore(config.egressSourceMapFile);
    const residentService = createResidentService({ config, docker, imagesDocker, egressMap });
    const taskService = createTaskService({ config, docker, egressMap });
    const app = createServer({
      residentService,
      taskService,
      config,
      internalToken: TEST_INTERNAL_TOKEN,
    });

    const res = await app.inject({ method: 'GET', url: '/images', headers: AUTH });

    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.error.code).toBe('docker_upstream_error');
    expect(body.error.status).toBe(403);
  });
});

describe('POST /resident/stop', () => {
  it('204s after stopping', async () => {
    const { app } = setup();
    await app.inject({
      method: 'POST',
      url: '/resident/spawn',
      headers: AGENT_HOST_AUTH,
      payload: { workspaceId: WS_R, principalId: ALICE, handle: 'h' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/resident/stop',
      headers: AUTH,
      payload: { principalId: ALICE },
    });
    expect(res.statusCode).toBe(204);
  });

  it('400s on an invalid body', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/resident/stop',
      headers: AUTH,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /resident/reclaim (S8 W5 leftover 77)', () => {
  it('204s and force-removes (not just stops) the container', async () => {
    const { app, docker } = setup();
    await app.inject({
      method: 'POST',
      url: '/resident/spawn',
      headers: AGENT_HOST_AUTH,
      payload: { workspaceId: WS_R, principalId: ALICE, handle: 'h' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/resident/reclaim',
      headers: AUTH,
      payload: { principalId: ALICE },
    });
    expect(res.statusCode).toBe(204);
    expect(docker.removeCalls).toEqual([`nexttime-entry-${ALICE}`]);
  });

  it('is a no-op 204 for a principal with no container', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/resident/reclaim',
      headers: AUTH,
      payload: { principalId: NOBODY },
    });
    expect(res.statusCode).toBe(204);
  });

  it('400s on an invalid body', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/resident/reclaim',
      headers: AUTH,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('401s without the internal-plane token', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/resident/reclaim',
      payload: { principalId: ALICE },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /resident/:principalId', () => {
  it('404s when nothing has been spawned', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'GET',
      url: `/resident/${NOBODY}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
  });

  it('400s a non-UUID principalId route param (IdClaimSchema), for GET and touch alike', async () => {
    const { app } = setup();
    const get = await app.inject({ method: 'GET', url: '/resident/not-a-uuid', headers: AUTH });
    expect(get.statusCode).toBe(400);
    expect(get.json().error.code).toBe('invalid_principal_id');
    const touch = await app.inject({
      method: 'POST',
      url: '/resident/not-a-uuid/touch',
      headers: AGENT_HOST_AUTH,
    });
    expect(touch.statusCode).toBe(400);
    expect(touch.json().error.code).toBe('invalid_principal_id');
  });

  it('200s with status after spawn', async () => {
    const { app } = setup();
    await app.inject({
      method: 'POST',
      url: '/resident/spawn',
      headers: AGENT_HOST_AUTH,
      payload: { workspaceId: WS_R, principalId: ALICE, handle: 'h' },
    });
    const res = await app.inject({ method: 'GET', url: `/resident/${ALICE}`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ principalId: ALICE, running: true, restarts: 0 });
  });
});

describe('POST /resident/:principalId/touch', () => {
  it('404s when nothing has been spawned', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: `/resident/${NOBODY}/touch`,
      headers: AGENT_HOST_AUTH,
    });
    expect(res.statusCode).toBe(404);
  });

  it('204s after spawn', async () => {
    const { app } = setup();
    await app.inject({
      method: 'POST',
      url: '/resident/spawn',
      headers: AGENT_HOST_AUTH,
      payload: { workspaceId: WS_R, principalId: ALICE, handle: 'h' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/resident/${ALICE}/touch`,
      headers: AGENT_HOST_AUTH,
    });
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
      headers: AUTH,
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
      headers: AUTH,
      payload: { taskId: TASK_ID },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400s on an unknown field (strict schema)', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/task/spawn',
      headers: AUTH,
      payload: { ...validTaskSpawnBody, extra: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400s a traversal-shaped taskId, and it never reaches the docker client', async () => {
    const { app, docker } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/task/spawn',
      headers: AUTH,
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
        headers: AUTH,
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
      headers: AUTH,
      payload: { ...validTaskSpawnBody, image: 'some-random-image' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('200s an explicitly allowlisted image', async () => {
    const { app } = setup({ WORKER_IMAGE_ALLOWLIST: 'some-approved-image' });
    const res = await app.inject({
      method: 'POST',
      url: '/task/spawn',
      headers: AUTH,
      payload: { ...validTaskSpawnBody, image: 'some-approved-image' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('400s the removed skills[] host-path field, and it never reaches the docker client (lane-6 review P1-3 — unknown field, strict schema)', async () => {
    const { app, docker } = setup(); // NEXTTIME_DATA=/host/data (see setup())
    const res = await app.inject({
      method: 'POST',
      url: '/task/spawn',
      headers: AUTH,
      payload: {
        ...validTaskSpawnBody,
        skills: [{ name: 'evil', hostPath: '/var/run/docker.sock' }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(docker.createCalls).toHaveLength(0);
  });

  it('200s a skillsInline entry (the surviving, content-based Skill mechanism)', async () => {
    const { app } = setup(); // NEXTTIME_DATA=/host/data
    const res = await app.inject({
      method: 'POST',
      url: '/task/spawn',
      headers: AUTH,
      payload: {
        ...validTaskSpawnBody,
        skillsInline: [{ name: 'ok-skill', files: { 'SKILL.md': '---\nname: x\n---\n\nbody\n' } }],
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it('round-trips systemPrompt into the Task workspace’s .nexttime/system-prompt.md (P-A2)', async () => {
    const { app } = setup(); // NEXTTIME_DATA=/host/data, LOCAL_DATA_DIR=dir
    const res = await app.inject({
      method: 'POST',
      url: '/task/spawn',
      headers: AUTH,
      payload: { ...validTaskSpawnBody, systemPrompt: 'Instance instructions.' },
    });
    expect(res.statusCode).toBe(200);
    expect(
      readFileSync(
        join(dir, 'workspaces', 'tasks', TASK_ID, '.nexttime', 'system-prompt.md'),
        'utf8',
      ),
    ).toBe('Instance instructions.');
  });

  it('501s when Task mode is not wired up', async () => {
    const config = loadConfig({ NEXTTIME_DATA: '/host/data', LOCAL_DATA_DIR: dir });
    const docker = createFakeDockerClient();
    const egressMap = createEgressMapStore(config.egressSourceMapFile);
    const residentService = createResidentService({ config, docker, egressMap });
    const app = createServer({ residentService, internalToken: TEST_INTERNAL_TOKEN }); // no taskService/config
    const res = await app.inject({
      method: 'POST',
      url: '/task/spawn',
      headers: AUTH,
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
    await app.inject({
      method: 'POST',
      url: '/task/spawn',
      headers: AUTH,
      payload: validTaskSpawnBody,
    });
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
    await app.inject({
      method: 'POST',
      url: '/task/spawn',
      headers: AUTH,
      payload: validTaskSpawnBody,
    });
    const res = await app.inject({ method: 'GET', url: `/task/${WORKER_RUN_ID}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ workerRunId: WORKER_RUN_ID, status: 'running' });
  });

  it('200s with status terminated after terminate', async () => {
    const { app } = setup();
    await app.inject({
      method: 'POST',
      url: '/task/spawn',
      headers: AUTH,
      payload: validTaskSpawnBody,
    });
    await app.inject({ method: 'POST', url: `/task/${WORKER_RUN_ID}/terminate` });
    const res = await app.inject({ method: 'GET', url: `/task/${WORKER_RUN_ID}` });
    expect(res.json()).toMatchObject({ status: 'terminated', reason: 'requested' });
  });
});

// Leftover 87: correlation id in, into the Worker container, into the egress map, and metrics.
describe('correlation id + /internal/metrics (leftover 87)', () => {
  function setupWithMetrics() {
    const config = loadConfig({
      NEXTTIME_DATA: '/host/data',
      LOCAL_DATA_DIR: dir,
      EGRESS_SOURCE_MAP_FILE: join(dir, 'egress-sources.json'),
    });
    const docker = createFakeDockerClient();
    const egressMap = createEgressMapStore(config.egressSourceMapFile);
    const metrics = createSupervisorMetrics();
    const residentService = createResidentService({ config, docker, egressMap });
    const taskService = createTaskService({
      config,
      docker,
      egressMap,
      onTaskFinished: (event) => metrics.recordTaskFinished(event),
    });
    const app = createServer({
      residentService,
      taskService,
      config,
      internalToken: TEST_INTERNAL_TOKEN,
      metrics,
    });
    return { app, docker, config };
  }

  it('POST /task/spawn hands the inbound id to the Worker container (env + label) and the egress map', async () => {
    const { app, docker, config } = setupWithMetrics();
    const turnId = '7f0c7c1e-8a44-4b6b-9f59-1b7bbcf0a3d2';
    const res = await app.inject({
      method: 'POST',
      url: '/task/spawn',
      headers: { ...AUTH, 'x-correlation-id': turnId },
      payload: validTaskSpawnBody,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-correlation-id']).toBe(turnId);
    const spec = docker.createCalls[0];
    expect(spec?.env).toContain(`NEXTTIME_CORRELATION_ID=${turnId}`);
    expect(spec?.labels['nexttime.correlation-id']).toBe(turnId);
    const egress = JSON.parse(readFileSync(config.egressSourceMapFile as string, 'utf8'));
    expect(Object.values(egress)).toEqual([
      expect.objectContaining({ correlationId: turnId, sourceId: expect.any(String) }),
    ]);
  });

  it('an invalid inbound id is replaced by a minted one — the container never sees the bad value', async () => {
    const { app, docker } = setupWithMetrics();
    const res = await app.inject({
      method: 'POST',
      url: '/task/spawn',
      headers: { ...AUTH, 'x-correlation-id': 'bad id; rm -rf' },
      payload: validTaskSpawnBody,
    });
    expect(res.statusCode).toBe(200);
    const minted = res.headers['x-correlation-id'] as string;
    expect(minted).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    const envLine = docker.createCalls[0]?.env.find((e) =>
      e.startsWith('NEXTTIME_CORRELATION_ID='),
    );
    expect(envLine).toBe(`NEXTTIME_CORRELATION_ID=${minted}`);
  });

  it('GET /internal/metrics is internal-token guarded', async () => {
    const { app } = setupWithMetrics();
    const res = await app.inject({ method: 'GET', url: '/internal/metrics' });
    expect(res.statusCode).toBe(401);
  });

  it('renders operation counters, latency and Worker exits after real calls', async () => {
    const { app, docker } = setupWithMetrics();
    await app.inject({
      method: 'POST',
      url: '/task/spawn',
      headers: AUTH,
      payload: validTaskSpawnBody,
    });
    await app.inject({
      method: 'POST',
      url: '/task/spawn',
      headers: AUTH,
      payload: { taskId: TASK_ID },
    });
    const name = docker.createCalls[0]?.name as string;
    docker.simulateExit(name, 1);
    await app.inject({ method: 'GET', url: `/task/${WORKER_RUN_ID}` });

    const res = await app.inject({ method: 'GET', url: '/internal/metrics', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    const text = res.body;
    expect(text).toContain(
      'nexttime_supervisor_operations_total{operation="task_spawn",outcome="ok"} 1',
    );
    expect(text).toContain(
      'nexttime_supervisor_operations_total{operation="task_spawn",outcome="rejected"} 1',
    );
    expect(text).toContain(
      'nexttime_supervisor_operation_duration_seconds_count{operation="task_spawn"} 2',
    );
    expect(text).toContain('nexttime_supervisor_task_exits_total{state="failed"} 1');
  });
});
