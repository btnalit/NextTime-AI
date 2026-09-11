import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearExplorerSession, createExplorerSession } from './explorer-session.js';

/**
 * explorer-session.test.ts: exercises `createExplorerSession`/`clearExplorerSession`
 * (lib/explorer-session.ts) against an injected `fetch` fake — deterministic, no kernel required.
 * Same style as `http-client.test.ts`.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

function response(status: number): Response {
  return new Response(null, { status });
}

describe('createExplorerSession', () => {
  it('POSTs to /api/explorer/session with Authorization: Bearer <apiKey> and same-origin credentials', async () => {
    const fetchImpl = vi.fn(async () => response(200));

    await createExplorerSession('sk-test', fetchImpl as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/explorer/session');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
    expect(init.credentials).toBe('same-origin');
  });

  it('resolves without throwing on a 200', async () => {
    const fetchImpl = vi.fn(async () => response(200));
    await expect(
      createExplorerSession('sk-test', fetchImpl as typeof fetch),
    ).resolves.toBeUndefined();
  });

  it('resolves without throwing on a 401 (bad key)', async () => {
    const fetchImpl = vi.fn(async () => response(401));
    await expect(
      createExplorerSession('sk-bad', fetchImpl as typeof fetch),
    ).resolves.toBeUndefined();
  });

  it('resolves without throwing on a 503 (kernel has no signing key)', async () => {
    const fetchImpl = vi.fn(async () => response(503));
    await expect(
      createExplorerSession('sk-test', fetchImpl as typeof fetch),
    ).resolves.toBeUndefined();
  });

  it('resolves without throwing when fetch itself rejects', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    await expect(
      createExplorerSession('sk-test', fetchImpl as typeof fetch),
    ).resolves.toBeUndefined();
  });
});

describe('ordering', () => {
  it('a DELETE issued while a POST is still in flight is sent only after that POST settled', async () => {
    const order: string[] = [];
    let resolvePost: (value: Response) => void = () => undefined;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      order.push(`${init?.method}:start`);
      if (init?.method === 'POST') {
        return new Promise<Response>((resolve) => {
          resolvePost = resolve;
        });
      }
      return response(204);
    });

    const created = createExplorerSession('sk-test', fetchImpl as unknown as typeof fetch);
    const cleared = clearExplorerSession(fetchImpl as unknown as typeof fetch);
    await Promise.resolve();
    expect(order).toEqual(['POST:start']);

    resolvePost(response(200));
    await created;
    await cleared;
    expect(order).toEqual(['POST:start', 'DELETE:start']);
  });

  it('a failed request never blocks the next one', async () => {
    const failing = vi.fn(async () => {
      throw new Error('network down');
    });
    await createExplorerSession('sk-test', failing as unknown as typeof fetch);
    const ok = vi.fn(async () => response(204));
    await clearExplorerSession(ok as unknown as typeof fetch);
    expect(ok).toHaveBeenCalledTimes(1);
  });
});

describe('clearExplorerSession', () => {
  it('DELETEs to /api/explorer/session with same-origin credentials and no authorization header', async () => {
    const fetchImpl = vi.fn(async () => response(204));

    await clearExplorerSession(fetchImpl as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/explorer/session');
    expect(init.method).toBe('DELETE');
    expect(init.credentials).toBe('same-origin');
    expect((init.headers as Record<string, string> | undefined)?.authorization).toBeUndefined();
  });

  it('resolves without throwing on a non-2xx status', async () => {
    const fetchImpl = vi.fn(async () => response(404));
    await expect(clearExplorerSession(fetchImpl as typeof fetch)).resolves.toBeUndefined();
  });

  it('resolves without throwing when fetch itself rejects', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    await expect(clearExplorerSession(fetchImpl as typeof fetch)).resolves.toBeUndefined();
  });
});
