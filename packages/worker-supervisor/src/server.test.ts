import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { createEgressMapStore } from './egress-map.js';
import { createResidentService } from './resident-service.js';
import { createServer } from './server.js';
import { createFakeDockerClient } from './test-support/fake-docker-client.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'worker-supervisor-server-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const config = loadConfig({
    NEXTTIME_DATA: '/host/data',
    LOCAL_DATA_DIR: dir,
    EGRESS_SOURCE_MAP_FILE: join(dir, 'egress-sources.json'),
  });
  const docker = createFakeDockerClient();
  const egressMap = createEgressMapStore(config.egressSourceMapFile);
  const residentService = createResidentService({ config, docker, egressMap });
  const app = createServer({ residentService });
  return { app, residentService };
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
      payload: { workspaceId: 'ws-1', principalId: 'alice', handle: 'h' },
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
      payload: { workspaceId: 'ws-1' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400s on an unknown field (strict schema)', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/resident/spawn',
      payload: { workspaceId: 'ws-1', principalId: 'alice', handle: 'h', extra: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('spawning twice for the same principal is idempotent (created=false the second time)', async () => {
    const { app } = setup();
    await app.inject({
      method: 'POST',
      url: '/resident/spawn',
      payload: { workspaceId: 'ws-1', principalId: 'alice', handle: 'h' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/resident/spawn',
      payload: { workspaceId: 'ws-1', principalId: 'alice', handle: 'h' },
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
      payload: { workspaceId: 'ws-1', principalId: 'alice', handle: 'h' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/resident/stop',
      payload: { principalId: 'alice' },
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
    const res = await app.inject({ method: 'GET', url: '/resident/nobody' });
    expect(res.statusCode).toBe(404);
  });

  it('200s with status after spawn', async () => {
    const { app } = setup();
    await app.inject({
      method: 'POST',
      url: '/resident/spawn',
      payload: { workspaceId: 'ws-1', principalId: 'alice', handle: 'h' },
    });
    const res = await app.inject({ method: 'GET', url: '/resident/alice' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ principalId: 'alice', running: true, restarts: 0 });
  });
});

describe('POST /resident/:principalId/touch', () => {
  it('404s when nothing has been spawned', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'POST', url: '/resident/nobody/touch' });
    expect(res.statusCode).toBe(404);
  });

  it('204s after spawn', async () => {
    const { app } = setup();
    await app.inject({
      method: 'POST',
      url: '/resident/spawn',
      payload: { workspaceId: 'ws-1', principalId: 'alice', handle: 'h' },
    });
    const res = await app.inject({ method: 'POST', url: '/resident/alice/touch' });
    expect(res.statusCode).toBe(204);
  });
});
