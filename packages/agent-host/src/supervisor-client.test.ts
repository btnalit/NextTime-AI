import { describe, expect, it, vi } from 'vitest';
import { SupervisorClient, SupervisorError } from './supervisor-client.js';

/** supervisor-client.test: an injectable fake `fetch`, no real worker-supervisor involved —
 *  matches `platform-extension/src/kernel-client.test.ts`'s own style for the sibling client this
 *  module mirrors. */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

describe('SupervisorClient.spawn', () => {
  it('POSTs the full spawn body and returns the parsed result on 200', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe('http://worker-supervisor:8081/resident/spawn');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        workspaceId: 'ws-1',
        principalId: 'p-1',
        handle: 'jwt-token',
        kernelUrl: 'http://kernel:8080',
        llmUrl: 'http://llm-proxy:8082',
      });
      return jsonResponse(200, {
        containerId: 'c1',
        ip: '100.64.0.2',
        status: 'running',
        created: true,
        restarts: 0,
      });
    });
    const client = new SupervisorClient({
      supervisorUrl: 'http://worker-supervisor:8081',
      fetchImpl,
    });

    const result = await client.spawn({
      workspaceId: 'ws-1',
      principalId: 'p-1',
      handle: 'jwt-token',
      kernelUrl: 'http://kernel:8080',
      llmUrl: 'http://llm-proxy:8082',
    });

    expect(result).toEqual({
      containerId: 'c1',
      ip: '100.64.0.2',
      status: 'running',
      created: true,
      restarts: 0,
    });
  });

  it('strips a trailing slash from supervisorUrl', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(url).toBe('http://worker-supervisor:8081/resident/spawn');
      return jsonResponse(200, {
        containerId: 'c1',
        ip: undefined,
        status: 'running',
        created: false,
        restarts: 0,
      });
    });
    const client = new SupervisorClient({
      supervisorUrl: 'http://worker-supervisor:8081/',
      fetchImpl,
    });
    await client.spawn({ workspaceId: 'ws-1', principalId: 'p-1', handle: 't' });
  });

  it('throws SupervisorError(http_error) on a non-200 response', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, { error: 'boom' }));
    const client = new SupervisorClient({
      supervisorUrl: 'http://worker-supervisor:8081',
      fetchImpl,
    });

    await expect(
      client.spawn({ workspaceId: 'ws-1', principalId: 'p-1', handle: 't' }),
    ).rejects.toThrow(SupervisorError);
  });

  it('throws SupervisorError(network) when fetch itself rejects', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const client = new SupervisorClient({
      supervisorUrl: 'http://worker-supervisor:8081',
      fetchImpl,
    });

    const err = await client
      .spawn({ workspaceId: 'ws-1', principalId: 'p-1', handle: 't' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SupervisorError);
    expect((err as SupervisorError).kind).toBe('network');
  });

  it('throws SupervisorError(timeout) when the request exceeds timeoutMs', async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });
    const client = new SupervisorClient({
      supervisorUrl: 'http://worker-supervisor:8081',
      fetchImpl,
      timeoutMs: 10,
    });

    const err = await client
      .spawn({ workspaceId: 'ws-1', principalId: 'p-1', handle: 't' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SupervisorError);
    expect((err as SupervisorError).kind).toBe('timeout');
  });
});

describe('SupervisorClient.stop', () => {
  it('POSTs {principalId} and resolves on 204', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe('http://worker-supervisor:8081/resident/stop');
      expect(JSON.parse(String(init?.body))).toEqual({ principalId: 'p-1' });
      return emptyResponse(204);
    });
    const client = new SupervisorClient({
      supervisorUrl: 'http://worker-supervisor:8081',
      fetchImpl,
    });
    await expect(client.stop('p-1')).resolves.toBeUndefined();
  });
});

describe('SupervisorClient.status', () => {
  it('returns undefined on 404', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe('http://worker-supervisor:8081/resident/p-1');
      expect(init?.method).toBe('GET');
      return emptyResponse(404);
    });
    const client = new SupervisorClient({
      supervisorUrl: 'http://worker-supervisor:8081',
      fetchImpl,
    });
    await expect(client.status('p-1')).resolves.toBeUndefined();
  });

  it('URL-encodes the principalId', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(url).toBe('http://worker-supervisor:8081/resident/p%201');
      return emptyResponse(404);
    });
    const client = new SupervisorClient({
      supervisorUrl: 'http://worker-supervisor:8081',
      fetchImpl,
    });
    await client.status('p 1');
  });

  it('returns the parsed status on 200', async () => {
    const status = {
      principalId: 'p-1',
      containerId: 'c1',
      ip: '100.64.0.2',
      running: true,
      status: 'running',
      startedAt: '2026-01-01T00:00:00.000Z',
      restarts: 1,
      lastTouchedAt: '2026-01-01T00:00:01.000Z',
    };
    const fetchImpl = vi.fn(async () => jsonResponse(200, status));
    const client = new SupervisorClient({
      supervisorUrl: 'http://worker-supervisor:8081',
      fetchImpl,
    });
    await expect(client.status('p-1')).resolves.toEqual(status);
  });
});

describe('SupervisorClient.touch', () => {
  it('returns false on 404 (recovery case, not an error)', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe('http://worker-supervisor:8081/resident/p-1/touch');
      expect(init?.method).toBe('POST');
      return emptyResponse(404);
    });
    const client = new SupervisorClient({
      supervisorUrl: 'http://worker-supervisor:8081',
      fetchImpl,
    });
    await expect(client.touch('p-1')).resolves.toBe(false);
  });

  it('returns true on 204', async () => {
    const fetchImpl = vi.fn(async () => emptyResponse(204));
    const client = new SupervisorClient({
      supervisorUrl: 'http://worker-supervisor:8081',
      fetchImpl,
    });
    await expect(client.touch('p-1')).resolves.toBe(true);
  });
});
