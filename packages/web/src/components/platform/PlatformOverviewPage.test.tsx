// @vitest-environment jsdom
import type {
  PlatformOverviewWire,
  PlatformStatusWire,
  PlatformWorkspaceWire,
} from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { PlatformOverviewPage } from './PlatformOverviewPage.js';

afterEach(cleanup);

/** S8 W2 U3a: every scripted client here answers `platform_status` with a healthy, zero-cost
 *  default unless a test overrides it — the page now reads it unconditionally for O1's "费用"
 *  card. Tests that care about the cost figure itself override the handler explicitly. */
function defaultStatus(): PlatformStatusWire {
  return {
    health: [],
    backup: { configured: false, detail: 'not configured' },
    llmUsage30d: {
      windowDays: 30,
      totalCostUsd: null,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      callCount: 0,
    },
    recentAudit: [],
    checkedAt: '2026-09-10T00:00:00.000Z',
  };
}

function scriptedHttp(
  handlers: Record<string, (params: unknown) => unknown | Promise<unknown>>,
): CapabilityCaller & { readonly calls: { readonly name: string; readonly params: unknown }[] } {
  const calls: { name: string; params: unknown }[] = [];
  const merged: Record<string, (params: unknown) => unknown | Promise<unknown>> = {
    platform_status: () => defaultStatus(),
    ...handlers,
  };
  return {
    calls,
    call: vi.fn(async (name: string, params?: unknown) => {
      calls.push({ name, params });
      const handler = merged[name];
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
      pendingActionRequests: 0,
      runningTasks: 0,
    },
    graphFreshness: { staleThresholdMs: 7_200_000, staleSourceCount: 0, affectedWorkspaceCount: 0 },
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

/** S8 W3 F1 (leftover 85): `defaultWorkspace`'s checklist meta line is now recomputed client-side
 *  from the `isDefault` row of `list_workspaces` (bilingual) rather than echoing the kernel's raw
 *  `detail` string — see `checklistDetail`'s own doc comment in the page. Matches `overview()`'s
 *  default `defaultWorkspace: { detail: 'Acme' }` fixture below. */
function defaultWorkspaceRow(
  overrides: Partial<PlatformWorkspaceWire> = {},
): PlatformWorkspaceWire {
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
    memberCount: 3,
    owners: [{ userId: 'u-1', login: 'alice', displayName: 'Alice', principalId: 'p-1' }],
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('PlatformOverviewPage', () => {
  it('renders version, the checklist with links, count tiles, health chips, and recent audit', async () => {
    const http = scriptedHttp({
      platform_overview: () => overview(),
      list_workspaces: () => ({ items: [defaultWorkspaceRow()] }),
    });
    renderPage(http);

    const checklist = await screen.findByTestId('platform-checklist');
    // S8 W1-A10 (audit S14): the checklist's meta line is computed client-side from `counts` now
    // (never the kernel's own English `detail` prose, which carried "(s)" plurals and, for
    // `runtime`, an internal design-doc section number). S8 W3 F1: `defaultWorkspace` now also
    // reads client-side, from `list_workspaces`'s `isDefault` row (`defaultWorkspaceRow` above)
    // instead of the kernel's own `detail` — see `checklistDetail`'s doc comment.
    expect(checklist.textContent).toContain('5 个可用模型');
    expect(checklist.textContent).toContain('Acme');
    // S8 W4-C (ui-audit O2 "过期文案"): `providers` now links to 模型与供应商 like every other
    // checklist item, since S7-A let the console write a provider's own key — the "当前经主机配置"
    // fallback text is gone.
    const providersRow = within(checklist).getByText('模型供应商').closest('li');
    expect(providersRow).not.toBeNull();
    expect(
      within(providersRow as HTMLElement)
        .getByRole('link', { name: '前往' })
        .getAttribute('href'),
    ).toBe('#/platform/models');

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

describe('PlatformOverviewPage O1 control tower (S8 W2 U3a)', () => {
  it('需要人处理: lists a degraded/down health entry and pending-activation users, each linking to its page', async () => {
    const http = scriptedHttp({
      platform_overview: () =>
        overview({
          counts: { ...overview().counts, pendingActivationUsers: 2 },
          health: [
            { service: 'kernel', status: 'ok' },
            { service: 'llm-proxy', status: 'degraded' },
            { service: 'worker-supervisor', status: 'down' },
          ],
        }),
      list_workspaces: () => ({ items: [] }),
    });
    renderPage(http);
    const list = await screen.findByTestId('platform-attention-items');
    const items = screen.getAllByTestId('platform-attention-item');
    expect(items).toHaveLength(3);
    expect(list.textContent).toContain('llm-proxy');
    expect(list.textContent).toContain('worker-supervisor');
    expect(list.textContent).toContain('2 位用户待激活');
    const links = list.querySelectorAll('a');
    expect(Array.from(links).map((a) => a.getAttribute('href'))).toEqual([
      '#/platform/status',
      '#/platform/status',
      '#/platform/users',
    ]);
  });

  it('需要人处理: empty state when every service is healthy and nothing is pending activation', async () => {
    const http = scriptedHttp({
      platform_overview: () =>
        overview({
          counts: { ...overview().counts, pendingActivationUsers: 0 },
          health: [{ service: 'kernel', status: 'ok' }],
        }),
      list_workspaces: () => ({ items: [] }),
    });
    renderPage(http);
    await screen.findByTestId('platform-attention-empty');
    expect(screen.queryByTestId('platform-attention-item')).toBeNull();
  });

  it('费用（近 30 天）: renders calls, tokens and cost from platform_status', async () => {
    const http = scriptedHttp({
      platform_overview: () => overview(),
      list_workspaces: () => ({ items: [] }),
      platform_status: () => ({
        ...defaultStatus(),
        llmUsage30d: {
          windowDays: 30,
          totalCostUsd: 12.5,
          totalInputTokens: 1000,
          totalOutputTokens: 200,
          callCount: 42,
        },
      }),
    });
    renderPage(http);
    const cost = await screen.findByTestId('platform-cost');
    expect(cost.textContent).toContain('42');
    expect(cost.textContent).toContain('1000');
    expect(cost.textContent).toContain('200');
    expect(screen.getByTestId('platform-cost-value').textContent).toBe('$12.50');
  });

  it('费用（近 30 天）: shows "no cost recorded" rather than a fake $0.00 when totalCostUsd is null', async () => {
    const http = scriptedHttp({
      platform_overview: () => overview(),
      list_workspaces: () => ({ items: [] }),
    });
    renderPage(http);
    await screen.findByTestId('platform-cost');
    expect(screen.getByTestId('platform-cost-value').textContent).toBe('无费用记录');
  });

  it('费用（近 30 天）: a platform_status failure shows its own error banner without blocking the rest of the page', async () => {
    const http = scriptedHttp({
      platform_overview: () => overview(),
      list_workspaces: () => ({ items: [] }),
      platform_status: () => Promise.reject(new HttpError('network', 'boom')),
    });
    renderPage(http);
    await screen.findByTestId('platform-cost-error');
    expect(screen.getByTestId('platform-checklist')).toBeTruthy();
  });

  it('S8 W4-C: 待处理 / 运行中 render the kernel’s cross-workspace counts', async () => {
    const http = scriptedHttp({
      platform_overview: () =>
        overview({
          counts: { ...overview().counts, pendingActionRequests: 4, runningTasks: 2 },
        }),
      list_workspaces: () => ({ items: [] }),
    });
    renderPage(http);
    expect(
      (await screen.findByTestId('platform-count-pending-action-requests')).textContent,
    ).toContain('4');
    expect(screen.getByTestId('platform-count-running-tasks').textContent).toContain('2');
  });

  it('S8 W4-C: 图谱新鲜度 reads "全部新鲜" at zero stale sources', async () => {
    const http = scriptedHttp({
      platform_overview: () => overview(),
      list_workspaces: () => ({ items: [] }),
    });
    renderPage(http);
    const tile = await screen.findByTestId('platform-count-graph-freshness');
    expect(tile.textContent).toContain('0');
    expect(screen.getByTestId('platform-graph-freshness-detail').textContent).toBe('全部新鲜');
  });

  it('S8 W4-C: 图谱新鲜度 shows the stale count and how many workspaces it spans', async () => {
    const http = scriptedHttp({
      platform_overview: () =>
        overview({
          graphFreshness: {
            staleThresholdMs: 7_200_000,
            staleSourceCount: 3,
            affectedWorkspaceCount: 2,
          },
        }),
      list_workspaces: () => ({ items: [] }),
    });
    renderPage(http);
    const tile = await screen.findByTestId('platform-count-graph-freshness');
    expect(tile.textContent).toContain('3');
    expect(screen.getByTestId('platform-graph-freshness-detail').textContent).toBe(
      '陈旧 · 2 个工作区',
    );
  });

  it('ui-audit O3: 工作区 tile excludes residue (disabled/expired-ephemeral), matching the workspaces page default view', async () => {
    const base = {
      entryModel: null,
      allowedModels: [],
      ontologyEnforcement: 'reject' as const,
      purpose: 'standard' as const,
      expiresAt: null,
      disabledAt: null,
      purgeable: false,
      isDefault: false,
      memberCount: 0,
      owners: [],
      createdAt: '2026-09-01T00:00:00.000Z',
    };
    const http = scriptedHttp({
      // Kernel-side counts.workspaces still counts every row (3) — the tile itself must not.
      platform_overview: () => overview({ counts: { ...overview().counts, workspaces: 3 } }),
      list_workspaces: () => ({
        items: [
          { ...base, id: 'ws-1', name: 'prod', status: 'active', isDefault: true },
          { ...base, id: 'ws-2', name: 'old', status: 'disabled' },
          {
            ...base,
            id: 'ws-3',
            name: 'accept-s3',
            status: 'active',
            purpose: 'ephemeral',
            expiresAt: '2020-01-01T00:00:00.000Z',
          },
        ],
      }),
    });
    renderPage(http);
    const tile = await screen.findByTestId('platform-count-workspaces');
    expect(tile.textContent).toContain('1');
    expect(tile.textContent).not.toContain('3');
  });

  it('最近平台审计 caps at 5 rows even when the kernel returns more', async () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      id: `audit-${i}`,
      action: `action_${i}`,
      actorUserId: 'u-admin',
      actorLogin: 'admin',
      resourceType: null,
      resourceId: null,
      payload: {},
      createdAt: '2026-09-10T00:00:00.000Z',
    }));
    const http = scriptedHttp({
      platform_overview: () => overview({ recentAudit: rows }),
      list_workspaces: () => ({ items: [] }),
    });
    renderPage(http);
    const audit = await screen.findByTestId('platform-overview-audit');
    expect(screen.getAllByTestId('platform-overview-audit-row')).toHaveLength(5);
    expect(audit.textContent).toContain('action_0');
    expect(audit.textContent).not.toContain('action_7');
  });
});
