// @vitest-environment jsdom
import type {
  LlmProviderListWire,
  LlmProviderWire,
  PlatformSettingsWire,
  PlatformWorkspaceWire,
} from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../lib/clients.js';
import { PlatformModelsPage } from './PlatformModelsPage.js';

afterEach(cleanup);

/**
 * PlatformModelsPage.test: the S6-B page against a scripted kernel (`issue_llm_admin_token`
 * only) and a scripted llm-proxy (`fetchImpl`): the table with the honest credential state, the
 * create drawer producing exactly the wire input (no key field), the structured test result, the
 * tiered confirms for disable / delete, the store-unwritable notice, and the operator step for a
 * missing credential.
 */

function provider(overrides: Partial<LlmProviderWire> = {}): LlmProviderWire {
  return {
    id: 'openai',
    displayName: 'OpenAI',
    api: 'openai-completions',
    upstreamBaseUrl: 'https://api.openai.example',
    authHeader: 'authorization',
    authScheme: 'Bearer',
    apiKeyEnv: 'OPENAI_API_KEY',
    credentialPresent: true,
    credentialSource: 'env',
    enabled: true,
    source: 'file',
    overridesFile: false,
    models: [{ id: 'gpt-large', displayName: 'GPT Large', cost: null }],
    lastTest: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function listWire(
  items: LlmProviderWire[],
  overrides: Partial<LlmProviderListWire> = {},
): LlmProviderListWire {
  return {
    items,
    modelsJsonWrittenAt: null,
    modelsJsonError: null,
    storeWritable: true,
    ...overrides,
  };
}

function platformSettings(overrides: Partial<PlatformSettingsWire> = {}): PlatformSettingsWire {
  return {
    siteName: 'NextTime',
    announcement: '',
    instanceInstructions: '',
    defaultWorkspaceId: null,
    defaultEntryModel: null,
    defaultDailyCallLimit: null,
    defaultMonthlyTokenBudget: null,
    defaultPlatformRole: 'user',
    passwordMinLength: 8,
    activeRuntimeImage: null,
    defaultModules: [],
    envAdmins: [],
    version: 1,
    updatedAt: null,
    ...overrides,
  };
}

/** `DefaultModelControl` (S7-E E5) shares this page's `http` prop, so every render exercises
 *  `get_platform_settings` / `list_platform_models` too — scripted with sensible defaults here
 *  (an empty catalog, no default model set) so the six pre-existing provider-table cases below
 *  need no changes; `handlers` overrides one or more names for the tests that care about the
 *  control itself (below). */
function scriptedHttp(
  handlers: Partial<Record<string, (params: unknown) => unknown>> = {},
): CapabilityCaller & { readonly mints: () => number } {
  let mints = 0;
  return {
    mints: () => mints,
    call: vi.fn(async (name: string, params?: unknown) => {
      if (handlers[name]) return handlers[name]?.(params);
      if (name === 'issue_llm_admin_token') {
        mints += 1;
        return {
          token: 'jwt',
          url: '/api/llm-admin',
          jti: '11111111-2222-4333-8444-555555555555',
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        };
      }
      if (name === 'get_platform_settings') return platformSettings();
      if (name === 'list_platform_models') return { items: [] };
      throw new Error(`unscripted capability ${name}`);
    }) as CapabilityCaller['call'],
  };
}

type Route = (body: unknown) => { status: number; body?: unknown };

function scriptedProxy(routes: Record<string, Route>) {
  const calls: Array<{
    method: string;
    path: string;
    body: unknown;
    headers: Record<string, string>;
  }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const method = init?.method ?? 'GET';
    const path = String(input).replace('/api/llm-admin', '');
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body, headers });
    const route = routes[`${method} ${path}`];
    if (!route) throw new Error(`unscripted proxy route ${method} ${path}`);
    const out = route(body);
    return new Response(out.body === undefined ? null : JSON.stringify(out.body), {
      status: out.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

function renderPage(http: CapabilityCaller, fetchImpl: typeof fetch) {
  return render(<PlatformModelsPage http={http} fetchImpl={fetchImpl} />);
}

describe('PlatformModelsPage', () => {
  it('P0-3: arriving with ?new=provider opens 新增供应商 and drops the query', async () => {
    window.history.replaceState(null, '', '#/platform/models?new=provider');
    const http = scriptedHttp();
    const proxy = scriptedProxy({
      'GET /providers': () => ({ status: 200, body: listWire([]) }),
    });
    renderPage(http, proxy.fetchImpl);
    expect(await screen.findByTestId('provider-form')).toBeTruthy();
    expect(window.location.hash).toBe('#/platform/models');
    window.history.replaceState(null, '', '#/');
  });

  it('lists providers with enabled / credential / source facts and mints one token for the burst', async () => {
    const http = scriptedHttp();
    const proxy = scriptedProxy({
      'GET /providers': () => ({
        status: 200,
        body: listWire([
          provider(),
          provider({
            id: 'acme',
            displayName: 'Acme',
            source: 'store',
            credentialPresent: false,
            credentialSource: 'none',
            apiKeyEnv: 'ACME_KEY',
            enabled: false,
            lastTest: {
              providerId: 'acme',
              model: 'm',
              completion: 'ok',
              toolCall: 'error',
              latencyMs: 12,
              error: 'HTTP 400: no tools',
              testedAt: '2026-09-19T00:00:00.000Z',
            },
          }),
        ]),
      }),
    });
    renderPage(http, proxy.fetchImpl);

    const table = await screen.findByTestId('providers-table');
    const openai = within(table).getByTestId('provider-row-openai');
    expect(within(openai).getByTestId('provider-enabled-chip').dataset.status).toBe('active');
    expect(within(openai).getByTestId('provider-credential').dataset.status).toBe('present');
    expect(within(openai).getByTestId('provider-source').textContent).toBe('yaml');
    expect(within(openai).queryByTestId('provider-delete')).toBeNull(); // file rows are not deletable

    const acme = within(table).getByTestId('provider-row-acme');
    expect(within(acme).getByTestId('provider-enabled-chip').dataset.status).toBe('disabled');
    expect(within(acme).getByTestId('provider-credential').textContent).toContain('ACME_KEY');
    expect(within(acme).getByTestId('provider-credential').dataset.status).toBe('missing');
    expect(within(acme).getByTestId('provider-last-test-chip').dataset.status).toBe('degraded');
    expect(within(acme).getByTestId('provider-delete')).toBeDefined();

    expect(http.mints()).toBe(1);
    expect(proxy.calls[0]?.headers).toMatchObject({
      authorization: 'Bearer jwt',
      'x-requested-with': 'nexttime',
    });
    // No rewrite has happened in this proxy process yet — no "rewritten" hint.
    expect(screen.queryByTestId('providers-models-json-written')).toBeNull();
  });

  it('creates a provider from the drawer with exactly the wire input (no key), then shows it', async () => {
    const http = scriptedHttp();
    let items = [provider()];
    const proxy = scriptedProxy({
      'GET /providers': () => ({ status: 200, body: listWire(items) }),
      'POST /providers': (body) => {
        const input = body as {
          id: string;
          displayName?: string;
          apiKeyEnv: string;
          models: Array<{ id: string }>;
        };
        const created = provider({
          id: input.id,
          displayName: input.displayName ?? input.id,
          apiKeyEnv: input.apiKeyEnv,
          source: 'store',
          credentialPresent: false,
          credentialSource: 'none',
          createdAt: '2026-09-19T00:00:00.000Z',
          updatedAt: '2026-09-19T00:00:00.000Z',
          models: input.models.map((m) => ({ id: m.id, displayName: null, cost: null })),
        });
        items = [...items, created];
        return { status: 201, body: created };
      },
    });
    renderPage(http, proxy.fetchImpl);
    await screen.findByTestId('providers-table');

    fireEvent.click(screen.getByTestId('provider-create'));
    const form = await screen.findByTestId('provider-form');
    fireEvent.change(within(form).getByTestId('provider-id'), { target: { value: 'acme' } });
    fireEvent.change(within(form).getByTestId('provider-display-name'), {
      target: { value: 'Acme' },
    });
    fireEvent.change(within(form).getByTestId('provider-api'), {
      target: { value: 'anthropic-messages' },
    });
    fireEvent.change(within(form).getByTestId('provider-base-url'), {
      target: { value: 'https://acme.example/' },
    });
    fireEvent.change(within(form).getByTestId('provider-api-key-env'), {
      target: { value: 'acme_key' },
    });
    fireEvent.change(within(form).getAllByTestId('provider-model-id')[0] as HTMLElement, {
      target: { value: 'acme-1' },
    });
    fireEvent.click(within(form).getByTestId('provider-model-add'));
    fireEvent.change(within(form).getAllByTestId('provider-model-id')[1] as HTMLElement, {
      target: { value: 'acme-2' },
    });
    fireEvent.change(within(form).getAllByTestId('provider-model-display-name')[1] as HTMLElement, {
      target: { value: 'Acme Two' },
    });

    // Choosing the Anthropic kind followed its convention for the auth header.
    expect((within(form).getByTestId('provider-auth-header') as HTMLSelectElement).value).toBe(
      'x-api-key',
    );

    fireEvent.click(within(form).getByTestId('provider-submit'));

    await waitFor(() => expect(screen.queryByTestId('provider-create-drawer')).toBeNull());
    const post = proxy.calls.find((c) => c.method === 'POST');
    expect(post?.body).toEqual({
      id: 'acme',
      displayName: 'Acme',
      api: 'anthropic-messages',
      upstreamBaseUrl: 'https://acme.example',
      authHeader: 'x-api-key',
      authScheme: null,
      apiKeyEnv: 'ACME_KEY',
      models: [
        { id: 'acme-1', displayName: null, cost: null },
        { id: 'acme-2', displayName: 'Acme Two', cost: null },
      ],
      enabled: true,
    });
    expect(JSON.stringify(post?.body)).not.toMatch(/apiKey"|secret/);
    await screen.findByTestId('provider-row-acme');
  });

  it('preset + typed key: fetches the real model list, sets the key after the row exists, then tests and shows the verdict', async () => {
    const http = scriptedHttp();
    let items = [provider()];
    let created: LlmProviderWire | null = null;
    const proxy = scriptedProxy({
      'GET /providers': () => ({ status: 200, body: listWire(items) }),
      'POST /model-discovery': () => ({
        status: 200,
        body: {
          models: [
            { id: 'deepseek-chat', displayName: null },
            { id: 'deepseek-reasoner', displayName: null },
            { id: 'deepseek-coder', displayName: null },
            { id: 'deepseek-v4', displayName: null },
          ],
          credentialSource: 'inline',
          truncated: false,
          latencyMs: 120,
        },
      }),
      'POST /providers': (body) => {
        const input = body as { id: string; displayName: string; models: Array<{ id: string }> };
        created = provider({
          id: input.id,
          displayName: input.displayName,
          apiKeyEnv: null,
          source: 'store',
          credentialPresent: false,
          credentialSource: 'none',
          models: input.models.map((m) => ({ id: m.id, displayName: null, cost: null })),
        });
        items = [...items, created];
        return { status: 201, body: created };
      },
      'PUT /providers/deepseek/secret': () => {
        const withKey = {
          ...(created as LlmProviderWire),
          credentialPresent: true,
          credentialSource: 'console' as const,
        };
        items = items.map((row) => (row.id === 'deepseek' ? withKey : row));
        return { status: 200, body: withKey };
      },
      'POST /model-probe': (body) => ({
        status: 200,
        body: {
          credentialSource: 'inline',
          results: (body as { models: string[] }).models.map((model) => ({
            model,
            completion: 'ok',
            toolCall: 'ok',
            latencyMs: 800,
            error: null,
          })),
        },
      }),
      'POST /providers/deepseek/test': () => ({
        status: 200,
        body: {
          providerId: 'deepseek',
          model: 'deepseek-chat',
          completion: 'ok',
          toolCall: 'ok',
          latencyMs: 900,
          error: null,
          testedAt: '2026-10-09T00:00:00.000Z',
        },
      }),
    });
    renderPage(http, proxy.fetchImpl);
    await screen.findByTestId('providers-table');

    fireEvent.click(screen.getByTestId('provider-create'));
    const form = await screen.findByTestId('provider-form');
    fireEvent.click(within(form).getByTestId('provider-preset-deepseek'));
    expect((within(form).getByTestId('provider-id') as HTMLInputElement).value).toBe('deepseek');
    expect((within(form).getByTestId('provider-base-url') as HTMLInputElement).value).toBe(
      'https://api.deepseek.com',
    );
    expect(within(form).getByTestId('provider-base-url-preview').textContent).toContain(
      'https://api.deepseek.com/v1/chat/completions',
    );
    // Not ready yet, and the form says why.
    expect((within(form).getByTestId('provider-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(within(form).getByTestId('provider-form-missing').textContent).toContain('至少一个模型');

    const keyInput = within(form).getByTestId('provider-key');
    fireEvent.change(keyInput, { target: { value: ' sk-deepseek-typed-key ' } });
    fireEvent.blur(keyInput); // entering a key fetches the list once
    await within(form).findByTestId('provider-model-picker');
    const discovery = proxy.calls.find((c) => c.path === '/model-discovery');
    expect(discovery?.body).toEqual({
      id: 'deepseek',
      api: 'openai-completions',
      upstreamBaseUrl: 'https://api.deepseek.com',
      authHeader: 'authorization',
      key: 'sk-deepseek-typed-key',
    });

    fireEvent.click(within(form).getAllByTestId('provider-model-option')[0] as HTMLElement);
    // Ticking a listed model checks it right away, with the same upstream and typed key.
    await waitFor(() =>
      expect(within(form).getByTestId('provider-model-probe').dataset.state).toBe('ok'),
    );
    expect(proxy.calls.find((c) => c.path === '/model-probe')?.body).toEqual({
      id: 'deepseek',
      api: 'openai-completions',
      upstreamBaseUrl: 'https://api.deepseek.com',
      authHeader: 'authorization',
      key: 'sk-deepseek-typed-key',
      models: ['deepseek-chat'],
    });
    // A typed id the provider does not list is flagged, not refused.
    fireEvent.click(within(form).getByTestId('provider-model-add'));
    fireEvent.change(within(form).getAllByTestId('provider-model-id')[1] as HTMLElement, {
      target: { value: 'deepseek-chatt' },
    });
    expect(within(form).getAllByTestId('provider-model-unlisted')).toHaveLength(1);
    fireEvent.click(within(form).getAllByRole('button', { name: '移除模型 2' })[0] as HTMLElement);

    fireEvent.click(within(form).getByTestId('provider-submit'));

    const verdict = await screen.findByTestId('provider-test-verdict');
    expect(verdict.dataset.verdict).toBe('ok');
    expect(screen.getByTestId('provider-detail-drawer')).toBeDefined();

    const post = proxy.calls.find((c) => c.method === 'POST' && c.path === '/providers');
    expect(post?.body).toEqual({
      id: 'deepseek',
      displayName: 'DeepSeek',
      api: 'openai-completions',
      upstreamBaseUrl: 'https://api.deepseek.com',
      authHeader: 'authorization',
      authScheme: 'Bearer',
      models: [{ id: 'deepseek-chat', displayName: null, cost: null }],
      enabled: true,
    });
    // The key never rides on the provider row; it goes in the one secret call, after the row.
    expect(JSON.stringify(post?.body)).not.toContain('sk-deepseek');
    const order = proxy.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`);
    expect(order).toEqual([
      'POST /model-discovery',
      'POST /model-probe',
      'POST /providers',
      'PUT /providers/deepseek/secret',
      'POST /providers/deepseek/test',
    ]);
    expect(proxy.calls.find((c) => c.method === 'PUT')?.body).toEqual({
      key: 'sk-deepseek-typed-key',
    });
  });

  it('normalizes what is typed instead of refusing it: env var name, pasted key, pasted endpoint', async () => {
    const http = scriptedHttp();
    const proxy = scriptedProxy({
      'GET /providers': () => ({ status: 200, body: listWire([provider()]) }),
    });
    renderPage(http, proxy.fetchImpl);
    await screen.findByTestId('providers-table');
    fireEvent.click(screen.getByTestId('provider-create'));
    const form = await screen.findByTestId('provider-form');

    const base = within(form).getByTestId('provider-base-url');
    fireEvent.change(base, { target: { value: 'relay.example.com/v1/chat/completions/' } });
    fireEvent.blur(base);
    expect((base as HTMLInputElement).value).toBe('https://relay.example.com');
    // No name typed: the id follows the host.
    expect((within(form).getByTestId('provider-id') as HTMLInputElement).value).toBe('example');

    const env = within(form).getByTestId('provider-api-key-env');
    fireEvent.change(env, { target: { value: 'my-relay.api key' } });
    expect((env as HTMLInputElement).value).toBe('MY_RELAY_API_KEY');
    expect(within(form).queryByRole('alert')).toBeNull();

    fireEvent.change(env, { target: { value: 'export RELAY_KEY=abc' } });
    expect((env as HTMLInputElement).value).toBe('RELAY_KEY');

    fireEvent.change(env, { target: { value: 'sk-proj-AbCdEf0123456789xyz' } });
    expect((env as HTMLInputElement).value).toBe('');
    expect(within(form).getByTestId('provider-env-was-secret')).toBeDefined();
    expect((within(form).getByTestId('provider-key') as HTMLInputElement).value).toBe(
      'sk-proj-AbCdEf0123456789xyz',
    );
  });

  it('shows why model discovery failed, with the plain-language cause', async () => {
    const http = scriptedHttp();
    const proxy = scriptedProxy({
      'GET /providers': () => ({ status: 200, body: listWire([provider()]) }),
      'POST /model-discovery': () => ({
        status: 502,
        body: {
          error: {
            code: 'upstream_error',
            message: 'HTTP 401: invalid api key',
            details: { status: 401 },
          },
        },
      }),
    });
    renderPage(http, proxy.fetchImpl);
    await screen.findByTestId('providers-table');
    fireEvent.click(screen.getByTestId('provider-create'));
    const form = await screen.findByTestId('provider-form');
    fireEvent.click(within(form).getByTestId('provider-preset-openai'));
    fireEvent.change(within(form).getByTestId('provider-key'), {
      target: { value: 'sk-wrong-key-0123456789' },
    });
    fireEvent.click(within(form).getByTestId('provider-discover'));
    const error = await within(form).findByTestId('provider-discover-error');
    expect(error.textContent).toContain('供应商拒绝了请求');
    expect(error.textContent).toContain('密钥');
  });

  it('a relay without a model list: offers the preset’s suggestions and checks each one ticked', async () => {
    const http = scriptedHttp();
    const proxy = scriptedProxy({
      'GET /providers': () => ({ status: 200, body: listWire([provider()]) }),
      'POST /model-discovery': () => ({
        status: 502,
        body: {
          error: {
            code: 'upstream_error',
            message: 'HTTP 404: not found',
            details: { status: 404 },
          },
        },
      }),
      'POST /model-probe': (body) => ({
        status: 200,
        body: {
          credentialSource: 'inline',
          results: (body as { models: string[] }).models.map((model) => ({
            model,
            completion: 'ok',
            toolCall: model === 'deepseek-reasoner' ? 'error' : 'ok',
            latencyMs: 700,
            error:
              model === 'deepseek-reasoner' ? 'tool-call response carried no call of "ping"' : null,
          })),
        },
      }),
    });
    renderPage(http, proxy.fetchImpl);
    await screen.findByTestId('providers-table');
    fireEvent.click(screen.getByTestId('provider-create'));
    const form = await screen.findByTestId('provider-form');
    fireEvent.click(within(form).getByTestId('provider-preset-deepseek'));
    const keyInput = within(form).getByTestId('provider-key');
    fireEvent.change(keyInput, { target: { value: 'sk-deepseek-typed-key' } });
    fireEvent.blur(keyInput);
    const suggestions = await within(form).findByTestId('provider-model-suggestions');
    expect(suggestions.textContent).toContain('未用你的密钥核验');
    const options = within(suggestions).getAllByTestId('provider-model-suggestion');
    expect(options.map((o) => o.closest('label')?.textContent)).toEqual([
      'deepseek-chat',
      'deepseek-reasoner',
    ]);
    fireEvent.click(options[0] as HTMLElement);
    fireEvent.click(options[1] as HTMLElement);
    await waitFor(() =>
      expect(
        within(form)
          .getAllByTestId('provider-model-probe')
          .map((el) => el.dataset.state),
      ).toEqual(['ok', 'chat-only']),
    );
    expect(within(form).getAllByTestId('provider-model-probe')[1]?.textContent).toContain(
      '只能对话',
    );
    // 「验证所选模型」 re-checks every picked model in one call.
    fireEvent.click(within(form).getByTestId('provider-probe-selected'));
    await waitFor(() =>
      expect(proxy.calls.filter((c) => c.path === '/model-probe').at(-1)?.body).toMatchObject({
        models: ['deepseek-chat', 'deepseek-reasoner'],
      }),
    );
  });

  it('runs 测试调用', async () => {
    const http = scriptedHttp();
    const proxy = scriptedProxy({
      'GET /providers': () => ({
        status: 200,
        body: listWire([
          provider(),
          provider({
            id: 'acme',
            displayName: 'Acme',
            credentialPresent: false,
            credentialSource: 'none',
            apiKeyEnv: 'ACME_KEY',
            source: 'store',
          }),
        ]),
      }),
      'POST /providers/openai/test': () => ({
        status: 200,
        body: {
          providerId: 'openai',
          model: 'gpt-large',
          completion: 'ok',
          toolCall: 'ok',
          latencyMs: 812,
          error: null,
          testedAt: '2026-09-19T00:00:00.000Z',
        },
      }),
      'POST /providers/acme/test': () => ({
        status: 409,
        body: { error: { code: 'credential_missing', message: 'ACME_KEY is not set' } },
      }),
    });
    renderPage(http, proxy.fetchImpl);
    const table = await screen.findByTestId('providers-table');

    fireEvent.click(
      within(within(table).getByTestId('provider-row-openai')).getByTestId('provider-test'),
    );
    await waitFor(() =>
      expect(
        within(within(table).getByTestId('provider-row-openai')).getByTestId(
          'provider-last-test-chip',
        ).dataset.status,
      ).toBe('ok'),
    );
    expect(proxy.calls.find((c) => c.path === '/providers/openai/test')?.body).toEqual({});

    // The detail drawer shows the two round trips separately.
    fireEvent.click(
      within(within(table).getByTestId('provider-row-openai')).getByTestId('provider-open'),
    );
    const detail = await screen.findByTestId('provider-detail-test');
    expect(within(detail).getByTestId('provider-test-completion').dataset.status).toBe('ok');
    expect(within(detail).getByTestId('provider-test-tool-call').dataset.status).toBe('ok');
    expect(screen.getByTestId('provider-credential-instruction').textContent).toContain(
      'OPENAI_API_KEY',
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('provider-detail-drawer')).toBeNull());

    fireEvent.click(
      within(within(table).getByTestId('provider-row-acme')).getByTestId('provider-test'),
    );
    const rowError = await screen.findByTestId('provider-row-error');
    expect(rowError.textContent).toContain('secrets/llm-proxy.env');
  });

  it('disable goes through a medium-tier confirm and sends enabled:false; delete needs the retyped id', async () => {
    const http = scriptedHttp();
    let items = [provider({ id: 'acme', displayName: 'Acme', source: 'store' })];
    const proxy = scriptedProxy({
      'GET /providers': () => ({ status: 200, body: listWire(items) }),
      'PUT /providers/acme': (body) => {
        const input = body as { enabled: boolean };
        items = items.map((p) => (p.id === 'acme' ? { ...p, enabled: input.enabled } : p));
        return { status: 200, body: items[0] };
      },
      'DELETE /providers/acme': () => {
        items = [];
        return {
          status: 200,
          body: { id: 'acme', deleted: true, restoredFileEntry: false, secretCleared: false },
        };
      },
    });
    renderPage(http, proxy.fetchImpl);
    const table = await screen.findByTestId('providers-table');

    fireEvent.click(within(table).getByTestId('provider-disable'));
    const confirm = await screen.findByTestId('provider-disable-confirm');
    expect(within(confirm).getByTestId('confirm-target').textContent).toBe('Acme');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() =>
      expect(within(table).getByTestId('provider-enabled-chip').dataset.status).toBe('disabled'),
    );
    const put = proxy.calls.find((c) => c.method === 'PUT');
    expect(put?.body).toMatchObject({ id: 'acme', enabled: false, apiKeyEnv: 'OPENAI_API_KEY' });

    fireEvent.click(within(table).getByTestId('provider-delete'));
    const del = await screen.findByTestId('provider-delete-confirm');
    const button = within(del).getByTestId('confirm-button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(within(del).getByTestId('confirm-typed-name'), { target: { value: 'acme' } });
    fireEvent.click(within(del).getByTestId('confirm-acknowledge'));
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByTestId('provider-row-acme')).toBeNull());
    expect(proxy.calls.some((c) => c.method === 'DELETE' && c.path === '/providers/acme')).toBe(
      true,
    );
  });

  it('shows the operator notices for an unwritable store and a failed models.json rewrite, and blocks writes', async () => {
    const http = scriptedHttp();
    const proxy = scriptedProxy({
      'GET /providers': () => ({
        status: 200,
        body: listWire([provider()], { storeWritable: false, modelsJsonError: 'EACCES' }),
      }),
    });
    renderPage(http, proxy.fetchImpl);
    await screen.findByTestId('providers-table');
    expect(screen.getByTestId('providers-store-unwritable').textContent).toContain(
      'host-llm-proxy-init.sh',
    );
    expect(screen.getByTestId('providers-models-json-error').textContent).toContain('EACCES');
    expect((screen.getByTestId('provider-create') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('provider-edit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders the proxy error with the mapped copy when the list itself fails', async () => {
    const http = scriptedHttp();
    const proxy = scriptedProxy({
      'GET /providers': () => ({
        status: 503,
        body: { error: { code: 'store_unwritable', message: 'nope' } },
      }),
    });
    renderPage(http, proxy.fetchImpl);
    const error = await screen.findByTestId('providers-error');
    expect(error.dataset.errorCode).toBe('store_unwritable');
  });

  // S7-E E5: 平台默认入口模型 (`DefaultModelControl`, mounted on this page — design §6.2).
  describe('platform default entry model', () => {
    it('lists the catalog and shows the currently-set default', async () => {
      const http = scriptedHttp({
        get_platform_settings: () =>
          platformSettings({ defaultEntryModel: 'anthropic/claude-sonnet-5' }),
        list_platform_models: () => ({
          items: [
            { id: 'anthropic/claude-sonnet-5', provider: 'anthropic', model: 'claude-sonnet-5' },
            { id: 'anthropic/claude-haiku-5', provider: 'anthropic', model: 'claude-haiku-5' },
          ],
        }),
      });
      const proxy = scriptedProxy({
        'GET /providers': () => ({ status: 200, body: listWire([]) }),
      });
      renderPage(http, proxy.fetchImpl);

      const select = (await screen.findByTestId(
        'platform-default-model-select',
      )) as HTMLSelectElement;
      expect(select.value).toBe('anthropic/claude-sonnet-5');
      expect(
        within(select)
          .getAllByRole('option')
          .map((o) => (o as HTMLOptionElement).value),
      ).toEqual(['__pi_default__', 'anthropic/claude-sonnet-5', 'anthropic/claude-haiku-5']);
    });

    it('picking a model calls set_platform_default_model and shows Saved', async () => {
      const calls: unknown[] = [];
      const http = scriptedHttp({
        get_platform_settings: () => platformSettings(),
        list_platform_models: () => ({
          items: [
            { id: 'anthropic/claude-sonnet-5', provider: 'anthropic', model: 'claude-sonnet-5' },
          ],
        }),
        set_platform_default_model: (params) => {
          calls.push(params);
          return platformSettings({ defaultEntryModel: 'anthropic/claude-sonnet-5', version: 2 });
        },
      });
      const proxy = scriptedProxy({
        'GET /providers': () => ({ status: 200, body: listWire([]) }),
      });
      renderPage(http, proxy.fetchImpl);

      const select = (await screen.findByTestId(
        'platform-default-model-select',
      )) as HTMLSelectElement;
      fireEvent.change(select, { target: { value: 'anthropic/claude-sonnet-5' } });

      await screen.findByTestId('platform-default-model-saved');
      expect(calls).toEqual([{ model: 'anthropic/claude-sonnet-5' }]);
    });

    it('picking pi 自己的默认值', async () => {
      const calls: unknown[] = [];
      const http = scriptedHttp({
        get_platform_settings: () =>
          platformSettings({ defaultEntryModel: 'anthropic/claude-sonnet-5' }),
        list_platform_models: () => ({
          items: [
            { id: 'anthropic/claude-sonnet-5', provider: 'anthropic', model: 'claude-sonnet-5' },
          ],
        }),
        set_platform_default_model: (params) => {
          calls.push(params);
          return platformSettings({ defaultEntryModel: null, version: 2 });
        },
      });
      const proxy = scriptedProxy({
        'GET /providers': () => ({ status: 200, body: listWire([]) }),
      });
      renderPage(http, proxy.fetchImpl);

      const select = (await screen.findByTestId(
        'platform-default-model-select',
      )) as HTMLSelectElement;
      fireEvent.change(select, { target: { value: '__pi_default__' } });

      await screen.findByTestId('platform-default-model-saved');
      expect(calls).toEqual([{ model: null }]);
    });

    it('a kernel refusal (e.g. unknown_model) renders inline without crashing the page', async () => {
      const http = scriptedHttp({
        get_platform_settings: () => platformSettings(),
        list_platform_models: () => ({
          items: [
            { id: 'anthropic/claude-sonnet-5', provider: 'anthropic', model: 'claude-sonnet-5' },
          ],
        }),
        set_platform_default_model: () => {
          throw new Error('model not in the llm-proxy catalog');
        },
      });
      const proxy = scriptedProxy({
        'GET /providers': () => ({ status: 200, body: listWire([]) }),
      });
      renderPage(http, proxy.fetchImpl);

      const select = (await screen.findByTestId(
        'platform-default-model-select',
      )) as HTMLSelectElement;
      fireEvent.change(select, { target: { value: 'anthropic/claude-sonnet-5' } });

      const error = await screen.findByTestId('platform-default-model-error');
      expect(error.textContent).toContain('not in the llm-proxy catalog');
      expect(screen.queryByTestId('platform-default-model-saved')).toBeNull();
    });
  });
});

/** S8 W4-C (ui-audit PMo1 "缺基线的'工作区 × 模型矩阵'"). */
describe('PlatformModelsPage workspace × model matrix (PMo1)', () => {
  function workspace(overrides: Partial<PlatformWorkspaceWire> = {}): PlatformWorkspaceWire {
    return {
      id: 'ws-1',
      name: 'Acme',
      status: 'active',
      entryModel: null,
      allowedModels: [],
      ontologyEnforcement: 'reject',
      purpose: 'standard',
      expiresAt: null,
      disabledAt: null,
      purgeable: false,
      isDefault: true,
      memberCount: 1,
      owners: [],
      createdAt: '2026-09-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('shows a check for a model in the allow-list, none for one outside it, and "全部" for an unrestricted workspace', async () => {
    const http = scriptedHttp({
      get_platform_settings: () => platformSettings(),
      list_workspaces: (params) => {
        expect(params).toEqual({ status: 'active', includeExpired: false });
        return {
          items: [
            workspace({ id: 'ws-1', name: 'Acme', allowedModels: ['openai/gpt-4o'] }),
            workspace({ id: 'ws-2', name: 'Beta', isDefault: false, allowedModels: [] }),
          ],
        };
      },
      list_platform_models: () => ({
        items: [
          { id: 'openai/gpt-4o', provider: 'openai', model: 'gpt-4o' },
          { id: 'anthropic/claude-3', provider: 'anthropic', model: 'claude-3' },
        ],
      }),
    });
    const proxy = scriptedProxy({ 'GET /providers': () => ({ status: 200, body: listWire([]) }) });
    renderPage(http, proxy.fetchImpl);

    const table = await screen.findByTestId('workspace-model-matrix-table');
    const acmeRow = within(table).getByTestId('workspace-model-matrix-row-ws-1');
    const betaRow = within(table).getByTestId('workspace-model-matrix-row-ws-2');

    // Acme: only gpt-4o is allowed — its cell has the check icon, claude-3's does not.
    const acmeCells = acmeRow.querySelectorAll('td');
    expect(acmeCells[2]?.querySelector('svg')).toBeTruthy(); // gpt-4o column
    expect(acmeCells[3]?.textContent).toBe('—'); // claude-3 column

    // Beta: empty allow-list means every model — both columns show the check icon.
    expect(betaRow.textContent).toContain('全部');
    const betaCells = betaRow.querySelectorAll('td');
    expect(betaCells[2]?.querySelector('svg')).toBeTruthy();
    expect(betaCells[3]?.querySelector('svg')).toBeTruthy();
  });
});
