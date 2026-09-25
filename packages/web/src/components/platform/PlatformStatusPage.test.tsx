// @vitest-environment jsdom
import type { PlatformStatusWire } from '@nexttime/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { PlatformStatusPage } from './PlatformStatusPage.js';

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
      <PlatformStatusPage http={http} />
    </PermissionsProvider>,
  );
}

function status(overrides: Partial<PlatformStatusWire> = {}): PlatformStatusWire {
  return {
    health: [
      { service: 'kernel', status: 'ok' },
      { service: 'postgres', status: 'ok' },
      { service: 'llm-proxy', status: 'ok' },
      { service: 'worker-supervisor', status: 'down', detail: 'connect ECONNREFUSED' },
      { service: 'egress-proxy', status: 'unknown', detail: 'loopback-only by design' },
    ],
    backup: { configured: false, detail: '未配置' },
    llmUsage30d: {
      windowDays: 30,
      totalCostUsd: 12.5,
      totalInputTokens: 1000,
      totalOutputTokens: 2000,
      callCount: 42,
    },
    recentAudit: [],
    checkedAt: '2026-09-22T00:00:00.000Z',
    ...overrides,
  };
}

describe('PlatformStatusPage', () => {
  it('renders health chips for every probed service, the honest backup state and 30-day usage', async () => {
    const http = scriptedHttp({ platform_status: () => status() });
    renderPage(http);

    const health = await screen.findByTestId('status-health');
    expect(health.textContent).toContain('kernel');
    expect(health.textContent).toContain('worker-supervisor');
    expect(health.textContent).toContain('egress-proxy');

    expect(screen.getByTestId('status-backup').textContent).toContain('未配置');
    const usage = screen.getByTestId('status-llm-usage');
    expect(usage.textContent).toContain('42');
    expect(usage.textContent).toContain('$12.50');
  });

  it('ui-audit ST2: each health row shows the service name before the chip, and the egress-proxy unknown status carries a visible explanation', async () => {
    const http = scriptedHttp({ platform_status: () => status() });
    renderPage(http);

    const entries = await screen.findAllByTestId('status-health-entry');
    const egress = entries.find((entry) => entry.textContent?.includes('egress-proxy'));
    expect(egress).toBeTruthy();
    // Name renders before the chip's own text in DOM order (default zh-CN: chip reads "未知").
    const nameIndex = egress?.textContent?.indexOf('egress-proxy') ?? -1;
    const chipIndex = egress?.textContent?.indexOf('未知') ?? -1;
    expect(nameIndex).toBeGreaterThanOrEqual(0);
    expect(nameIndex).toBeLessThan(chipIndex);

    const note = screen.getByTestId('status-egress-proxy-unknown-note');
    expect(note.textContent).toContain('按设计不对外暴露');
    // The kernel's own internal-path-bearing detail never renders as visible text.
    expect(egress?.textContent).not.toContain('packages/egress-proxy');

    // A different service does not get the egress-only note.
    const kernelEntry = entries.find((entry) => entry.textContent?.includes('kernel'));
    expect(kernelEntry?.querySelector('[data-testid="status-egress-proxy-unknown-note"]')).toBe(
      null,
    );
  });

  it('ui-audit ST2: 30-day usage numbers render with thousands separators', async () => {
    const http = scriptedHttp({
      platform_status: () =>
        status({
          llmUsage30d: {
            windowDays: 30,
            totalCostUsd: 1234.5,
            totalInputTokens: 1234567,
            totalOutputTokens: 89012,
            callCount: 3456,
          },
        }),
    });
    renderPage(http);
    const usage = await screen.findByTestId('status-llm-usage');
    expect(usage.textContent).toContain((3456).toLocaleString());
    expect(usage.textContent).toContain((1234567).toLocaleString());
    expect(usage.textContent).toContain((89012).toLocaleString());
  });

  it('shows an empty state with zero platform audit rows', async () => {
    const http = scriptedHttp({ platform_status: () => status({ recentAudit: [] }) });
    renderPage(http);
    expect(await screen.findByTestId('status-audit-empty')).toBeTruthy();
  });

  it('renders the recent platform audit rows via formatAuditActor', async () => {
    const http = scriptedHttp({
      platform_status: () =>
        status({
          recentAudit: [
            {
              id: 'a-1',
              action: 'set_active_runtime_image',
              actorUserId: 'u-1',
              actorLogin: 'admin',
              resourceType: 'platform_settings',
              resourceId: null,
              payload: {},
              createdAt: '2026-09-22T00:00:00.000Z',
            },
          ],
        }),
    });
    renderPage(http);
    const list = await screen.findByTestId('status-audit-list');
    expect(list.textContent).toContain('set_active_runtime_image');
    expect(list.textContent).toContain('admin');
  });

  it('a load error shows ErrorBanner with retry', async () => {
    const http = scriptedHttp({
      platform_status: () => Promise.reject(new Error('kernel unreachable')),
    });
    renderPage(http);
    const error = await screen.findByTestId('status-error');
    expect(error.textContent).toContain('kernel unreachable');
  });

  it('刷新', async () => {
    const http = scriptedHttp({ platform_status: () => status() });
    renderPage(http);
    await screen.findByTestId('status-health');
    const before = http.calls.filter((c) => c.name === 'platform_status').length;

    screen.getByTestId('status-refresh').click();

    await waitFor(() =>
      expect(http.calls.filter((c) => c.name === 'platform_status').length).toBeGreaterThan(before),
    );
  });
});
