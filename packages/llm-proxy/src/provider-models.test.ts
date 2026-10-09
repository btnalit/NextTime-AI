import { describe, expect, it } from 'vitest';
import {
  MAX_DISCOVERED_MODELS,
  MAX_MODEL_LIST_BYTES,
  listUpstreamModels,
} from './provider-models.js';

/** provider-models.test: the fixed `GET /v1/models` request per api kind, the parsed list, and
 *  every failure shape — with the key scrubbed out of anything that comes back. */

function fakeFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return respond(url, init ?? {});
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('listUpstreamModels', () => {
  it('OpenAI kinds: Bearer auth, GET <base>/v1/models, ids in upstream order, deduplicated', async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      json(200, { data: [{ id: 'gpt-b' }, { id: 'gpt-a' }, { id: 'gpt-b' }, { nope: 1 }] }),
    );
    const result = await listUpstreamModels({
      api: 'openai-completions',
      upstreamBaseUrl: 'https://api.example.invalid/',
      authHeader: 'authorization',
      realKey: 'sk-real',
      timeoutMs: 1000,
      fetchImpl,
    });
    expect(result).toEqual({
      ok: true,
      models: [
        { id: 'gpt-b', displayName: null },
        { id: 'gpt-a', displayName: null },
      ],
      truncated: false,
    });
    expect(calls[0]?.url).toBe('https://api.example.invalid/v1/models');
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get('authorization')).toBe('Bearer sk-real');
    expect(calls[0]?.init.method).toBe('GET');
    expect(calls[0]?.init.redirect).toBe('error');
  });

  it('Anthropic: x-api-key + anthropic-version, display_name kept', async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      json(200, { data: [{ id: 'claude-x', display_name: 'Claude X' }], has_more: false }),
    );
    const result = await listUpstreamModels({
      api: 'anthropic-messages',
      upstreamBaseUrl: 'https://api.anthropic.example.invalid',
      authHeader: 'x-api-key',
      realKey: 'sk-ant-real',
      timeoutMs: 1000,
      fetchImpl,
    });
    expect(result).toEqual({
      ok: true,
      models: [{ id: 'claude-x', displayName: 'Claude X' }],
      truncated: false,
    });
    expect(calls[0]?.url).toBe('https://api.anthropic.example.invalid/v1/models?limit=1000');
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get('x-api-key')).toBe('sk-ant-real');
    expect(headers.get('anthropic-version')).toBe('2023-06-01');
    expect(headers.get('authorization')).toBeNull();
  });

  it('a non-2xx is upstream_status with the key scrubbed from the message', async () => {
    const { fetchImpl } = fakeFetch(() =>
      json(401, { error: { message: 'Incorrect API key provided: sk-real-secret-value' } }),
    );
    const result = await listUpstreamModels({
      api: 'openai-completions',
      upstreamBaseUrl: 'https://api.example.invalid',
      authHeader: 'authorization',
      realKey: 'sk-real-secret-value',
      timeoutMs: 1000,
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('upstream_status');
    expect(result.status).toBe(401);
    expect(result.message).toMatch(/^HTTP 401: Incorrect API key provided: \*\*\*/);
    expect(result.message).not.toContain('sk-real-secret-value');
  });

  it('a thrown fetch is unreachable; a 2xx without data is invalid_response', async () => {
    const thrown = await listUpstreamModels({
      api: 'openai-completions',
      upstreamBaseUrl: 'https://api.example.invalid',
      authHeader: 'authorization',
      realKey: 'sk-k',
      timeoutMs: 1000,
      fetchImpl: fakeFetch(() => {
        throw new Error('getaddrinfo ENOTFOUND api.example.invalid');
      }).fetchImpl,
    });
    expect(thrown).toMatchObject({ ok: false, reason: 'unreachable', status: null });

    const shapeless = await listUpstreamModels({
      api: 'openai-completions',
      upstreamBaseUrl: 'https://api.example.invalid',
      authHeader: 'authorization',
      realKey: 'sk-k',
      timeoutMs: 1000,
      fetchImpl: fakeFetch(() => json(200, { object: 'list' })).fetchImpl,
    });
    expect(shapeless).toMatchObject({ ok: false, reason: 'invalid_response', status: 200 });
  });

  it('caps the list', async () => {
    const data = Array.from({ length: MAX_DISCOVERED_MODELS + 5 }, (_, i) => ({ id: `m-${i}` }));
    const result = await listUpstreamModels({
      api: 'openai-completions',
      upstreamBaseUrl: 'https://api.example.invalid',
      authHeader: 'authorization',
      realKey: 'sk-k',
      timeoutMs: 1000,
      fetchImpl: fakeFetch(() => json(200, { data })).fetchImpl,
    });
    expect(result).toMatchObject({ ok: true, truncated: true });
    if (result.ok) expect(result.models).toHaveLength(MAX_DISCOVERED_MODELS);
  });

  it('stops reading a model list larger than the cap (STATUS leftover 138)', async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024 * 1024).fill(0x20));
      },
    });
    const result = await listUpstreamModels({
      api: 'openai-completions',
      upstreamBaseUrl: 'https://api.example.invalid',
      authHeader: 'authorization',
      realKey: 'sk-k',
      timeoutMs: 5000,
      fetchImpl: fakeFetch(() => new Response(endless, { status: 200 })).fetchImpl,
    });
    expect(result).toMatchObject({ ok: false, reason: 'invalid_response', status: 200 });
    expect(pulled).toBeLessThanOrEqual(MAX_MODEL_LIST_BYTES / (1024 * 1024) + 2);

    const declared = await listUpstreamModels({
      api: 'openai-completions',
      upstreamBaseUrl: 'https://api.example.invalid',
      authHeader: 'authorization',
      realKey: 'sk-k',
      timeoutMs: 1000,
      fetchImpl: fakeFetch(
        () =>
          new Response('{}', {
            status: 500,
            headers: { 'content-length': String(MAX_MODEL_LIST_BYTES + 1) },
          }),
      ).fetchImpl,
    });
    expect(declared).toMatchObject({ ok: false, reason: 'upstream_status', status: 500 });
  });

  it('a key an HTTP header cannot carry is a result, not a 500, and is never echoed', async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(200, { data: [] }));
    const result = await listUpstreamModels({
      api: 'openai-completions',
      upstreamBaseUrl: 'https://api.example.invalid',
      authHeader: 'authorization',
      realKey: 'sk-全角-key',
      timeoutMs: 1000,
      fetchImpl,
    });
    expect(result).toMatchObject({ ok: false, reason: 'unreachable', status: null });
    expect(JSON.stringify(result)).not.toContain('全角');
    expect(calls).toEqual([]);
  });
});
