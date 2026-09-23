// @vitest-environment jsdom
import type { LlmProviderListWire, LlmProviderWire, PlatformSettingsWire } from '@nexttime/shared';
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

  it('runs 测试调用 and renders the structured result; a missing credential shows the operator step', async () => {
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

  it('disable goes through a high-tier confirm and sends enabled:false; delete needs the retyped id', async () => {
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

    it('picking pi 自己的默认值 clears it with model: null', async () => {
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
