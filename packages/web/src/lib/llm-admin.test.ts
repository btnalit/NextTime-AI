import type { LlmAdminTokenWire, LlmProviderListWire } from '@nexttime/shared';
import { describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from './clients.js';
import type { Translate } from './i18n.js';
import { LlmAdminClient, LlmAdminError, llmAdminErrorMessage } from './llm-admin.js';

/** `llmAdminErrorMessage` is a pure helper (not a component) that takes `t` from its caller. */
const zhT: Translate = (zh) => zh;

/**
 * lib/llm-admin.test: the token burst cache (mint once, reuse until 60 s before expiry, re-mint
 * after), the exact headers every proxy call carries, the one-shot retry on 401, and the error
 * mapping — with a scripted `CapabilityCaller` and a scripted `fetch`; nothing real.
 */

function tokenWire(overrides: Partial<LlmAdminTokenWire> = {}): LlmAdminTokenWire {
  return {
    token: 'jwt-1',
    url: '/api/llm-admin',
    jti: '11111111-2222-4333-8444-555555555555',
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    ...overrides,
  };
}

function scriptedHttp(mint: () => LlmAdminTokenWire): CapabilityCaller & { mints: number } {
  const state = { mints: 0 };
  return {
    get mints() {
      return state.mints;
    },
    call: vi.fn(async (name: string) => {
      if (name !== 'issue_llm_admin_token') throw new Error(`unscripted ${name}`);
      const minted = mint();
      state.mints += 1;
      return minted;
    }) as CapabilityCaller['call'],
  };
}

function scriptedFetch(responses: Array<{ status: number; body?: unknown }>) {
  const seen: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
  }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    seen.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const next = responses.shift() ?? { status: 500, body: { error: { code: 'x', message: 'x' } } };
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, seen };
}

const LIST: LlmProviderListWire = {
  items: [],
  modelsJsonWrittenAt: null,
  modelsJsonError: null,
  storeWritable: true,
};

describe('LlmAdminClient', () => {
  it('mints one token for a burst and sends it as Bearer with the CSRF header to tokenResult.url', async () => {
    const http = scriptedHttp(() => tokenWire());
    const fetch = scriptedFetch([
      { status: 200, body: LIST },
      { status: 200, body: LIST },
    ]);
    const client = new LlmAdminClient(http, { fetchImpl: fetch.fetchImpl });
    client.forgetToken();

    await client.listProviders();
    await client.listProviders();
    expect(http.mints).toBe(1);
    expect(fetch.seen[0]).toMatchObject({
      url: '/api/llm-admin/providers',
      method: 'GET',
      headers: { authorization: 'Bearer jwt-1', 'x-requested-with': 'nexttime' },
    });
  });

  it('re-mints once the cached token is within 60 s of expiry', async () => {
    let now = Date.parse('2026-09-19T10:00:00.000Z');
    const http = scriptedHttp(() =>
      tokenWire({
        expiresAt: new Date(now + 300_000).toISOString(),
        token: `jwt-${http.mints + 1}`,
      }),
    );
    const fetch = scriptedFetch([
      { status: 200, body: LIST },
      { status: 200, body: LIST },
      { status: 200, body: LIST },
    ]);
    const client = new LlmAdminClient(http, { fetchImpl: fetch.fetchImpl, now: () => now });
    client.forgetToken();

    await client.listProviders();
    now += 200_000; // 100 s left — still fine
    await client.listProviders();
    expect(http.mints).toBe(1);
    now += 50_000; // 50 s left — under the margin
    await client.listProviders();
    expect(http.mints).toBe(2);
    expect(fetch.seen[2]?.headers.authorization).toBe('Bearer jwt-2');
  });

  it('retries exactly once with a fresh token on 401, then surfaces the proxy error', async () => {
    const http = scriptedHttp(() => tokenWire({ token: `jwt-${http.mints + 1}` }));
    const fetch = scriptedFetch([
      { status: 401, body: { error: { code: 'token_expired', message: 'expired' } } },
      { status: 401, body: { error: { code: 'unauthorized', message: 'nope' } } },
    ]);
    const client = new LlmAdminClient(http, { fetchImpl: fetch.fetchImpl });
    client.forgetToken();

    const thrown = await client.listProviders().catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(LlmAdminError);
    expect(thrown as LlmAdminError).toMatchObject({ status: 401, code: 'unauthorized' });
    expect(http.mints).toBe(2);
    expect(fetch.seen.map((s) => s.headers.authorization)).toEqual([
      'Bearer jwt-1',
      'Bearer jwt-2',
    ]);
  });

  it('sends create / update / delete / test with the right method, path and body', async () => {
    const http = scriptedHttp(() => tokenWire());
    const fetch = scriptedFetch([
      { status: 201, body: { id: 'acme' } },
      { status: 200, body: { id: 'acme' } },
      {
        status: 200,
        body: { id: 'acme', deleted: true, restoredFileEntry: false, secretCleared: false },
      },
      { status: 200, body: { providerId: 'acme', completion: 'ok', toolCall: 'ok' } },
    ]);
    const client = new LlmAdminClient(http, { fetchImpl: fetch.fetchImpl });
    client.forgetToken();
    const input = {
      id: 'acme',
      api: 'openai-completions' as const,
      upstreamBaseUrl: 'https://acme.example.invalid',
      authHeader: 'authorization' as const,
      apiKeyEnv: 'ACME_KEY',
      models: [{ id: 'm', displayName: null, cost: null }],
    };
    await client.createProvider(input);
    await client.updateProvider(input);
    await client.deleteProvider('acme');
    await client.testProvider('acme', { model: 'm' });
    expect(fetch.seen.map((s) => [s.method, s.url])).toEqual([
      ['POST', '/api/llm-admin/providers'],
      ['PUT', '/api/llm-admin/providers/acme'],
      ['DELETE', '/api/llm-admin/providers/acme'],
      ['POST', '/api/llm-admin/providers/acme/test'],
    ]);
    expect(fetch.seen[0]?.body).toEqual(input);
    expect(fetch.seen[3]?.body).toEqual({ model: 'm' });
    expect(JSON.stringify(fetch.seen)).not.toContain('apiKey"');
  });

  it('sends setProviderSecret / clearProviderSecret with the right method, path and body — never leaks the key into the request log', async () => {
    const http = scriptedHttp(() => tokenWire());
    const fetch = scriptedFetch([
      { status: 200, body: { id: 'acme', credentialSource: 'console' } },
      { status: 200, body: { id: 'acme', credentialSource: 'none' } },
    ]);
    const client = new LlmAdminClient(http, { fetchImpl: fetch.fetchImpl });
    client.forgetToken();

    await client.setProviderSecret('acme', 'sk-test-key');
    await client.clearProviderSecret('acme');

    expect(fetch.seen.map((s) => [s.method, s.url])).toEqual([
      ['PUT', '/api/llm-admin/providers/acme/secret'],
      ['DELETE', '/api/llm-admin/providers/acme/secret'],
    ]);
    expect(fetch.seen[0]?.body).toEqual({ key: 'sk-test-key' });
    expect(fetch.seen[1]?.body).toBeUndefined();
  });

  it('maps the proxy error envelope to LlmAdminError and the known codes to bilingual copy', async () => {
    const http = scriptedHttp(() => tokenWire());
    const fetch = scriptedFetch([
      { status: 503, body: { error: { code: 'store_unwritable', message: 'not writable' } } },
      { status: 409, body: { error: { code: 'credential_missing', message: 'no key' } } },
      { status: 502, body: undefined },
    ]);
    const client = new LlmAdminClient(http, { fetchImpl: fetch.fetchImpl });
    client.forgetToken();

    const unwritable = await client.listProviders().catch((err: unknown) => err);
    expect(unwritable).toMatchObject({ status: 503, code: 'store_unwritable' });
    expect(llmAdminErrorMessage(unwritable, zhT)).toContain('host-llm-proxy-init.sh');

    const missing = await client.listProviders().catch((err: unknown) => err);
    expect(llmAdminErrorMessage(missing, zhT)).toContain('secrets/llm-proxy.env');

    const opaque = await client.listProviders().catch((err: unknown) => err);
    expect(opaque).toMatchObject({ status: 502, code: 'http_error' });
    expect(llmAdminErrorMessage(opaque, zhT)).toBeNull();
    expect(llmAdminErrorMessage(new Error('x'), zhT)).toBeNull();
  });
});
