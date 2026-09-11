// @vitest-environment jsdom
import type { PlatformOverviewWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { PlatformOverviewPage } from './PlatformOverviewPage.js';

afterEach(cleanup);

function scriptedHttp(
  handlers: Record<string, (params: unknown) => unknown | Promise<unknown>>,
): CapabilityCaller & { readonly calls: { readonly name: string; readonly params: unknown }[] } {
  const calls: { name: string; params: unknown }[] = [];
  return {
    calls,
    call: vi.fn(async (name: string, params?: unknown) => {
      calls.push({ name, params });
      const handler = handlers[name];
      if (!handler) throw new Error(`unscripted capability ${name}`);
      return handler(params);
    }) as CapabilityCaller['call'],
  };
}

function renderPage(http: CapabilityCaller) {
  return render(
    <PermissionsProvider>
      <PlatformOverviewPage http={http} />
    </PermissionsProvider>,
  );
}

function overview(overrides: Partial<PlatformOverviewWire> = {}): PlatformOverviewWire {
  return {
    version: { kernel: '0.6.0', migrationsApplied: 20, latestMigration: '0020_...' },
    counts: {
      users: 3,
      activeUsers: 3,
      pendingActivationUsers: 0,
      workspaces: 1,
      activeWorkspaces: 1,
      gatekeepers: 2,
      modelsAvailable: 5,
    },
    health: [
      { service: 'kernel', status: 'ok' },
      { service: 'llm-proxy', status: 'degraded', detail: 'slow' },
    ],
    checklist: [
      { key: 'providers', done: true, detail: 'anthropic configured' },
      { key: 'defaultWorkspace', done: true, detail: 'Acme' },
      { key: 'integrations', done: false, detail: 'no gatekeeper enabled yet' },
      { key: 'users', done: true, detail: '3 users' },
      { key: 'runtime', done: true, detail: 'pi 0.6.0' },
    ],
    recentAudit: [
      {
        id: 'audit-1',
        action: 'create_user',
        actorUserId: 'u-admin',
        actorLogin: 'admin',
        resourceType: 'user',
        resourceId: 'u-2',
        payload: {},
        createdAt: '2026-09-10T00:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

describe('PlatformOverviewPage', () => {
  it('renders version, the checklist with links, count tiles, health chips, and recent audit', async () => {
    const http = scriptedHttp({ platform_overview: () => overview() });
    renderPage(http);

    const checklist = await screen.findByTestId('platform-checklist');
    expect(checklist.textContent).toContain('anthropic configured');
    expect(checklist.textContent).toContain('当前经主机配置');

    const counts = screen.getByTestId('platform-counts');
    expect(counts.textContent).toContain('3');
    expect(counts.textContent).toContain('5');

    const health = screen.getByTestId('platform-health');
    expect(health.textContent).toContain('kernel');
    expect(health.textContent).toContain('degraded');

    const audit = screen.getByTestId('platform-overview-audit');
    expect(audit.textContent).toContain('create_user');
    expect(audit.textContent).toContain('admin');
  });

  it('shows BindApiKeyForm only when there are pending-activation users, and reloads on success', async () => {
    let calls = 0;
    const http = scriptedHttp({
      platform_overview: () => {
        calls += 1;
        return overview({
          counts: { ...overview().counts, pendingActivationUsers: calls === 1 ? 1 : 0 },
        });
      },
    });
    renderPage(http);

    await screen.findByText(/绑定已有 API key/);

    // The form itself posts to /api/auth/bind-api-key (a REST route, not a capability) — stub
    // the global `fetch` (`BindApiKeyForm`'s own `fetchImpl` default) so `onBound` fires and we
    // can assert the overview capability is re-fetched.
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, result: { user: {}, memberships: [] } }), {
          status: 200,
        }),
    );
    vi.stubGlobal('fetch', fetchImpl);
    try {
      fireEvent.change(screen.getByLabelText(/API key/), { target: { value: 'sk-test' } });
      fireEvent.click(screen.getByRole('button', { name: '绑定 Bind' }));
      await waitFor(() => expect(calls).toBeGreaterThanOrEqual(2));
      // The second `platform_overview` read has `pendingActivationUsers: 0` — the form is gone.
      await waitFor(() => expect(screen.queryByText(/绑定已有 API key/)).toBeNull());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('shows an error banner with retry on failure', async () => {
    const http = scriptedHttp({
      platform_overview: () => Promise.reject(new HttpError('network', 'boom')),
    });
    renderPage(http);
    await screen.findByTestId('platform-overview-error');
  });
});
