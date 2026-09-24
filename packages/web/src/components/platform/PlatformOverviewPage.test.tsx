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
    const http = scriptedHttp({
      platform_overview: () => overview(),
      list_workspaces: () => ({ items: [] }),
    });
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

  it('renders an unattributed-actor recent-audit row (遗留 54) with a clear label, never blank or "null"', async () => {
    const http = scriptedHttp({
      platform_overview: () =>
        overview({
          recentAudit: [
            {
              id: 'audit-unattributed',
              action: 'platform.workspace_purged',
              actorUserId: null,
              actorLogin: null,
              resourceType: 'workspace',
              resourceId: 'ws-1',
              payload: { attributedActor: false },
              createdAt: '2026-09-10T00:00:00.000Z',
            },
          ],
        }),
      list_workspaces: () => ({ items: [] }),
    });
    renderPage(http);

    const audit = await screen.findByTestId('platform-overview-audit');
    expect(audit.textContent).toContain('主机操作员（未署名）');
    expect(audit.textContent).not.toContain('null');
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
      list_workspaces: () => ({ items: [] }),
    });
    renderPage(http);

    await screen.findByText(/绑定已有/);

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
      fireEvent.click(screen.getByRole('button', { name: '绑定' }));
      await waitFor(() => expect(calls).toBeGreaterThanOrEqual(2));
      // The second `platform_overview` read has `pendingActivationUsers: 0` — the form is gone.
      await waitFor(() => expect(screen.queryByText(/绑定已有/)).toBeNull());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('shows an error banner with retry on failure', async () => {
    const http = scriptedHttp({
      platform_overview: () => Promise.reject(new HttpError('network', 'boom')),
      list_workspaces: () => ({ items: [] }),
    });
    renderPage(http);
    await screen.findByTestId('platform-overview-error');
  });

  it('A1 / A6: the 验收残留', async () => {
    const base = {
      entryModel: null,
      allowedModels: [],
      ontologyEnforcement: 'reject',
      purpose: 'standard',
      expiresAt: null,
      disabledAt: null,
      purgeable: false,
      isDefault: false,
      memberCount: 0,
      owners: [],
      createdAt: '2026-09-01T00:00:00.000Z',
    };
    const http = scriptedHttp({
      platform_overview: () => overview(),
      list_workspaces: (params) => {
        // The banner needs the unfiltered read — disabled ∪ expired is not one kernel filter.
        expect(params).toEqual({});
        return {
          items: [
            { ...base, id: 'ws-1', name: 'prod', status: 'active', isDefault: true },
            { ...base, id: 'ws-2', name: 'old', status: 'disabled', purgeable: true },
            {
              ...base,
              id: 'ws-3',
              name: 'accept-s3',
              status: 'active',
              purpose: 'ephemeral',
              expiresAt: '2020-01-01T00:00:00.000Z',
              purgeable: true,
            },
            {
              ...base,
              id: 'ws-4',
              name: 'demo-live',
              status: 'active',
              purpose: 'ephemeral',
              expiresAt: '2099-01-01T00:00:00.000Z',
            },
          ],
        };
      },
    });
    renderPage(http);
    const banner = await screen.findByTestId('platform-residue-banner');
    expect(banner.textContent).toContain('验收残留 2 个工作区待清除');
    expect(screen.getByTestId('platform-residue-link').getAttribute('href')).toBe(
      '#/platform/workspaces?residue=1',
    );
  });

  it('no banner without residue, and a failed list_workspaces read never blocks the page', async () => {
    const http = scriptedHttp({
      platform_overview: () => overview(),
      list_workspaces: () => Promise.reject(new HttpError('network', 'boom')),
    });
    renderPage(http);
    await screen.findByTestId('platform-checklist');
    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'list_workspaces')).toBe(true),
    );
    expect(screen.queryByTestId('platform-residue-banner')).toBeNull();
    expect(screen.queryByTestId('platform-overview-error')).toBeNull();
  });
});
