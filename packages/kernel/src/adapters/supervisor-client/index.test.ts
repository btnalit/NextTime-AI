import { describe, expect, it, vi } from 'vitest';
import { TaskSupervisorClient, TaskSupervisorError } from './index.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

describe('TaskSupervisorClient', () => {
  it('spawn: posts to /task/spawn and returns {containerId, ip}', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { containerId: 'c1', ip: '198.51.100.3' }));
    const client = new TaskSupervisorClient({
      supervisorUrl: 'http://worker-supervisor:8081',
      fetchImpl,
    });

    const result = await client.spawn({
      taskId: 't1',
      workerRunId: 'wr1',
      workspaceId: 'ws1',
      onBehalfOf: 'p1',
      capabilityHandle: 'secret-handle',
    });

    expect(result).toEqual({ containerId: 'c1', ip: '198.51.100.3' });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://worker-supervisor:8081/task/spawn');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string).capabilityHandle).toBe('secret-handle');
  });

  it('strips a trailing slash from supervisorUrl', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { containerId: 'c1', ip: undefined }));
    const client = new TaskSupervisorClient({
      supervisorUrl: 'http://worker-supervisor:8081/',
      fetchImpl,
    });
    await client.spawn({
      taskId: 't1',
      workerRunId: 'wr1',
      workspaceId: 'ws1',
      onBehalfOf: 'p1',
      capabilityHandle: 'h',
    });
    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toBe('http://worker-supervisor:8081/task/spawn');
  });

  it('spawn: 403 maps to TaskSupervisorError kind image_not_allowed', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(403, { error: { code: 'image_not_allowed', message: 'nope' } }),
      );
    const client = new TaskSupervisorClient({ supervisorUrl: 'http://x', fetchImpl });

    await expect(
      client.spawn({
        taskId: 't1',
        workerRunId: 'wr1',
        workspaceId: 'ws1',
        onBehalfOf: 'p1',
        capabilityHandle: 'h',
        image: 'not-allowed',
      }),
    ).rejects.toMatchObject({ kind: 'image_not_allowed' });
  });

  it('spawn: 400 maps to invalid_request', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(400, { error: { code: 'invalid_body', message: 'bad' } }));
    const client = new TaskSupervisorClient({ supervisorUrl: 'http://x', fetchImpl });

    await expect(
      client.spawn({
        taskId: 't1',
        workerRunId: 'wr1',
        workspaceId: 'ws1',
        onBehalfOf: 'p1',
        capabilityHandle: 'h',
      }),
    ).rejects.toMatchObject({ kind: 'invalid_request' });
  });

  it('spawn: unexpected status maps to http_error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(emptyResponse(500));
    const client = new TaskSupervisorClient({ supervisorUrl: 'http://x', fetchImpl });

    await expect(
      client.spawn({
        taskId: 't1',
        workerRunId: 'wr1',
        workspaceId: 'ws1',
        onBehalfOf: 'p1',
        capabilityHandle: 'h',
      }),
    ).rejects.toMatchObject({ kind: 'http_error', status: 500 });
  });

  it('terminate: 204 returns true', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(emptyResponse(204));
    const client = new TaskSupervisorClient({ supervisorUrl: 'http://x', fetchImpl });
    await expect(client.terminate('wr1')).resolves.toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://x/task/wr1/terminate');
    expect(init.method).toBe('POST');
  });

  it('terminate: 404 returns false', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(emptyResponse(404));
    const client = new TaskSupervisorClient({ supervisorUrl: 'http://x', fetchImpl });
    await expect(client.terminate('wr1')).resolves.toBe(false);
  });

  it('status: 200 returns the parsed TaskStatus', async () => {
    const statusBody = {
      workerRunId: 'wr1',
      status: 'running',
      exitCode: undefined,
      containerId: 'c1',
      ip: '198.51.100.3',
      startedAt: '2026-09-01T00:00:00Z',
      finishedAt: undefined,
      reason: undefined,
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, statusBody));
    const client = new TaskSupervisorClient({ supervisorUrl: 'http://x', fetchImpl });
    const result = await client.status('wr1');
    expect(result?.status).toBe('running');
    expect(result?.containerId).toBe('c1');
  });

  it('status: 404 returns undefined', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(emptyResponse(404));
    const client = new TaskSupervisorClient({ supervisorUrl: 'http://x', fetchImpl });
    await expect(client.status('wr1')).resolves.toBeUndefined();
  });

  it('network failure maps to TaskSupervisorError kind network', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const client = new TaskSupervisorClient({ supervisorUrl: 'http://x', fetchImpl });
    await expect(client.status('wr1')).rejects.toBeInstanceOf(TaskSupervisorError);
    await expect(client.status('wr1')).rejects.toMatchObject({ kind: 'network' });
  });

  it('non-JSON body maps to invalid_response', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('not json', { status: 200, headers: {} }));
    const client = new TaskSupervisorClient({ supervisorUrl: 'http://x', fetchImpl });
    await expect(client.status('wr1')).rejects.toMatchObject({ kind: 'invalid_response' });
  });
});
