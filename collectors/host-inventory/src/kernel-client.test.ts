import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KernelClientError, createKernelClient } from './kernel-client.js';

function fakeFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  return vi.fn(async (url: string, init: RequestInit) => {
    const { status, body } = handler(url, init);
    return {
      status,
      json: async () => body,
    } as Response;
  }) as unknown as typeof fetch;
}

describe('createKernelClient', () => {
  it('registerSource posts to /api/cap/register_source with a Bearer token from the token file', async () => {
    let capturedUrl = '';
    let capturedAuth = '';
    let capturedBody: unknown;
    const fetchImpl = fakeFetch((url, init) => {
      capturedUrl = url;
      capturedAuth = (init.headers as Record<string, string>).authorization ?? '';
      capturedBody = JSON.parse(init.body as string);
      return {
        status: 200,
        body: {
          ok: true,
          result: {
            id: 'src-1',
            kind: 'k',
            name: 'n',
            ownerPrincipalId: 'p1',
            visibility: 'workspace',
          },
        },
      };
    });

    const client = createKernelClient({
      kernelUrl: 'http://kernel:8080',
      handleTokenFile: '/does/not/matter',
      fetchImpl,
      readToken: async () => 'tok123',
    });

    const result = await client.registerSource({
      kind: 'k',
      name: 'n',
      visibility: 'workspace',
    });

    expect(capturedUrl).toBe('http://kernel:8080/api/cap/register_source');
    expect(capturedAuth).toBe('Bearer tok123');
    expect(capturedBody).toEqual({ kind: 'k', name: 'n', visibility: 'workspace' });
    expect(result.id).toBe('src-1');
  });

  describe('the default (file-backed) token reader', () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'nexttime-collector-token-test-'));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('trims whitespace/newlines from the token file contents', async () => {
      const tokenFile = path.join(dir, 'token');
      await writeFile(tokenFile, '  tok-with-newline\n\n', 'utf8');

      let capturedAuth = '';
      const fetchImpl = fakeFetch((_url, init) => {
        capturedAuth = (init.headers as Record<string, string>).authorization ?? '';
        return { status: 200, body: { ok: true, result: {} } };
      });
      const client = createKernelClient({
        kernelUrl: 'http://kernel:8080',
        handleTokenFile: tokenFile,
        fetchImpl,
      });
      await client.registerSource({ kind: 'k', name: 'n', visibility: 'workspace' });
      expect(capturedAuth).toBe('Bearer tok-with-newline');
    });

    it('reads the token fresh on every call (no in-memory caching across calls)', async () => {
      const tokenFile = path.join(dir, 'token');
      await writeFile(tokenFile, 'first-token', 'utf8');

      const capturedAuths: string[] = [];
      const fetchImpl = fakeFetch((_url, init) => {
        capturedAuths.push((init.headers as Record<string, string>).authorization ?? '');
        return { status: 200, body: { ok: true, result: {} } };
      });
      const client = createKernelClient({
        kernelUrl: 'http://kernel:8080',
        handleTokenFile: tokenFile,
        fetchImpl,
      });

      await client.registerSource({ kind: 'k', name: 'n', visibility: 'workspace' });
      await writeFile(tokenFile, 'rotated-token', 'utf8');
      await client.registerSource({ kind: 'k', name: 'n', visibility: 'workspace' });

      expect(capturedAuths).toEqual(['Bearer first-token', 'Bearer rotated-token']);
    });
  });

  it('submitObservations posts to /api/cap/submit_observations and returns the result', async () => {
    const fetchImpl = fakeFetch(() => ({
      status: 200,
      body: {
        ok: true,
        result: {
          activityId: 'act-1',
          objectsUpserted: 2,
          factsAsserted: 1,
          factsSuperseded: 0,
          objects: [],
        },
      },
    }));
    const client = createKernelClient({
      kernelUrl: 'http://kernel:8080',
      handleTokenFile: '/does/not/matter',
      fetchImpl,
      readToken: async () => 'tok',
    });

    const result = await client.submitObservations({
      sourceId: 'src-1',
      observations: [{ objectType: 'Host', identity: { hostname: 'h1' } }],
    });
    expect(result.activityId).toBe('act-1');
    expect(result.factsAsserted).toBe(1);
  });

  it('throws KernelClientError with the kernel-reported code/message on {ok:false}', async () => {
    const fetchImpl = fakeFetch(() => ({
      status: 400,
      body: { ok: false, error: { code: 'invalid_params', message: 'identity missing key field' } },
    }));
    const client = createKernelClient({
      kernelUrl: 'http://kernel:8080',
      handleTokenFile: '/does/not/matter',
      fetchImpl,
      readToken: async () => 'tok',
    });

    await expect(
      client.submitObservations({ sourceId: 'src-1', observations: [] }),
    ).rejects.toMatchObject({
      name: 'KernelClientError',
      code: 'invalid_params',
      status: 400,
    });
  });

  it('KernelClientError is an instance of Error with a descriptive message', async () => {
    const err = new KernelClientError('register_source', 404, 'not_found', 'no such thing');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('register_source');
    expect(err.message).toContain('404');
    expect(err.message).toContain('not_found');
  });
});
