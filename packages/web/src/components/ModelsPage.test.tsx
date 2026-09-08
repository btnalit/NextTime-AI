// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../hooks/usePermissions.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { HttpError } from '../lib/http-client.js';
import { ModelsPage } from './ModelsPage.js';

afterEach(cleanup);

function scriptedHttp(
  handlers: Record<string, () => unknown | Promise<unknown>>,
): CapabilityCaller {
  return {
    call: vi.fn(async (name: string) => {
      const handler = handlers[name];
      if (!handler) throw new Error(`unscripted capability ${name}`);
      return handler();
    }) as CapabilityCaller['call'],
  };
}

function renderPage(http: CapabilityCaller) {
  return render(
    <PermissionsProvider>
      <ModelsPage http={http} />
    </PermissionsProvider>,
  );
}

describe('ModelsPage', () => {
  it('renders the models table, quotas table, and policy dumps independently', async () => {
    const http = scriptedHttp({
      list_models: () => ({
        items: [{ id: 'anthropic/claude', provider: 'anthropic', model: 'claude-sonnet' }],
      }),
      list_quotas: () => ({ items: [{ key: 'invoke_worker.max_depth', value: 5 }] }),
      list_policies: () => ({
        items: [{ decision: 'require_approval', actionKindTag: 'docker.*' }],
      }),
    });
    renderPage(http);

    const modelsTable = await screen.findByTestId('models-table');
    expect(modelsTable.textContent).toContain('claude-sonnet');

    const quotasTable = await screen.findByTestId('quotas-table');
    expect(quotasTable.textContent).toContain('invoke_worker.max_depth');
    expect(quotasTable.textContent).toContain('5');

    const policies = await screen.findByTestId('policies-list');
    expect(policies.textContent).toContain('require_approval');
  });

  it('each section degrades to "该能力尚未上线" independently on 404 not_found', async () => {
    const http = scriptedHttp({
      list_models: () => ({ items: [] }),
      list_quotas: () =>
        Promise.reject(new HttpError('capability_error', 'no handler', 'not_found')),
      list_policies: () => ({ items: [] }),
    });
    renderPage(http);
    await screen.findByTestId('models-empty');
    await screen.findByTestId('quotas-unavailable');
    await screen.findByTestId('policies-empty');
  });

  it('shows a role explanation on 403 for the owner-only quotas/policies sections', async () => {
    const http = scriptedHttp({
      list_models: () => ({ items: [] }),
      list_quotas: () => Promise.reject(new HttpError('capability_error', 'nope', 'forbidden')),
      list_policies: () => Promise.reject(new HttpError('capability_error', 'nope', 'forbidden')),
    });
    renderPage(http);
    await screen.findByTestId('quotas-forbidden');
    await screen.findByTestId('policies-forbidden');
  });
});
