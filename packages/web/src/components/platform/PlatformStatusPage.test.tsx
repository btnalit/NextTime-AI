// @vitest-environment jsdom
import type { PlatformStatusWire } from '@nexttime/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { PlatformStatusPage } from './PlatformStatusPage.js';
import { feedFreshness, platformUpdates } from './test-fixtures.js';

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
    backup: {
      status: 'fresh',
      lastSuccessAt: '2026-09-21T19:30:00.000Z',
      stale: false,
      maxAgeHours: 26,
      detail: 'last successful backup 2026-09-21T19:30:00Z (4h30m old, limit 26h)',
    },
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
  it('renders health chips for every probed service, the backup freshness and 30-day usage', async () => {
    const http = scriptedHttp({ platform_status: () => status() });
    renderPage(http);

    const health = await screen.findByTestId('status-health');
    expect(health.textContent).toContain('kernel');
    expect(health.textContent).toContain('worker-supervisor');
    expect(health.textContent).toContain('egress-proxy');

    const backup = screen.getByTestId('status-backup');
    expect(backup.textContent).toContain('正常');
    expect(backup.textContent).toContain('26 小时以内');
    expect(screen.getByTestId('status-backup-facts').textContent).toContain('09-2');
    const usage = screen.getByTestId('status-llm-usage');
    expect(usage.textContent).toContain('42');
    expect(usage.textContent).toContain('$12.50');
  });

  it('D-28: a stale backup is a danger chip that says what to check; unknown says why it cannot tell', async () => {
    const stale = scriptedHttp({
      platform_status: () =>
        status({
          backup: {
            status: 'stale',
            lastSuccessAt: '2026-09-19T19:30:00.000Z',
            stale: true,
            maxAgeHours: 26,
            detail: 'last successful backup 2026-09-19T19:30:00Z is 52h30m old (> 26h)',
          },
        }),
    });
    renderPage(stale);
    const backup = await screen.findByTestId('status-backup');
    expect(backup.textContent).toContain('已过期');
    expect(backup.textContent).toContain('backup 服务的日志');
    cleanup();

    const unknown = scriptedHttp({
      platform_status: () =>
        status({
          backup: {
            status: 'unknown',
            lastSuccessAt: null,
            stale: null,
            maxAgeHours: 26,
            detail: 'no backup marker at /data/backups/last-success',
          },
        }),
    });
    renderPage(unknown);
    const unknownBackup = await screen.findByTestId('status-backup');
    expect(unknownBackup.textContent).toContain('未知');
    // Never the old "not configured" placeholder.
    expect(unknownBackup.textContent).not.toContain('未配置');
    expect(screen.getByTestId('status-backup-facts').textContent).toContain('—');
    // The kernel's own reason stays behind the technical-details disclosure.
    expect(screen.getByTestId('status-backup-detail').textContent).toContain('no backup marker');
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
    // P1-14: named for what happened, never the interface name.
    expect(list.textContent).toContain('切换活动镜像');
    expect(list.textContent).not.toContain('set_active_runtime_image');
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

  describe('S10 U1: the update feed block', () => {
    it('fresh: a green chip, the times and the limit', async () => {
      const http = scriptedHttp({
        platform_status: () => status(),
        platform_updates: () => platformUpdates(),
      });
      renderPage(http);
      const block = await screen.findByTestId('status-update-feed');
      expect(block.textContent).toContain('正常');
      expect(block.textContent).toContain('48 小时以内');
      const chip = screen.getByTestId('status-update-feed-chip');
      expect(chip.getAttribute('data-status')).toBe('fresh');
      expect(chip.getAttribute('data-tone')).toBe('ok');
      const facts = screen.getByTestId('status-update-feed-facts').textContent ?? '';
      expect(facts).toContain('10-07');
      expect(facts).toContain('48 小时');
      expect(screen.getByTestId('status-update-feed-detail').textContent).toContain(
        'channel.json fetched',
      );
    });

    const cases = [
      {
        status: 'stale',
        cause: 'download',
        tone: 'warn',
        label: '已陈旧',
        text: 'update-feed 服务的日志',
      },
      { status: 'stale', cause: 'ci', tone: 'warn', label: '已陈旧', text: 'GitHub Actions' },
      {
        status: 'invalid',
        cause: null,
        tone: 'danger',
        label: '异常',
        text: '内核拒绝了下载到的版本记录',
      },
      {
        status: 'missing',
        cause: null,
        tone: 'neutral',
        label: '尚未取到',
        text: '还没有取到版本信息',
      },
    ] as const;
    for (const c of cases) {
      it(`${c.status}${c.cause ? ` (${c.cause})` : ''}: ${c.tone} chip "${c.label}" and what it means`, async () => {
        const missing = c.status === 'missing';
        const http = scriptedHttp({
          platform_status: () => status(),
          platform_updates: () =>
            platformUpdates({
              feedFreshness: feedFreshness({
                status: c.status,
                staleCause: c.cause,
                fetchedAt: missing || c.status === 'invalid' ? null : '2026-10-05T04:00:00.000Z',
                generatedAt: missing || c.status === 'invalid' ? null : '2026-10-05T03:00:00.000Z',
                detail: `detail for ${c.status}`,
              }),
            }),
        });
        renderPage(http);
        const block = await screen.findByTestId('status-update-feed');
        const chip = screen.getByTestId('status-update-feed-chip');
        expect(chip.getAttribute('data-status')).toBe(c.status);
        expect(chip.getAttribute('data-tone')).toBe(c.tone);
        expect(chip.textContent).toBe(c.label);
        expect(block.textContent).toContain(c.text);
        const facts = screen.getByTestId('status-update-feed-facts').textContent ?? '';
        if (missing || c.status === 'invalid') expect(facts).toContain('—');
        expect(screen.getByTestId('status-update-feed-detail').textContent).toBe(
          `detail for ${c.status}`,
        );
      });
    }

    it('a failing platform_updates read is contained to this block', async () => {
      const http = scriptedHttp({
        platform_status: () => status(),
        platform_updates: () => {
          throw new Error('boom');
        },
      });
      renderPage(http);
      expect(await screen.findByTestId('status-update-feed-error')).toBeTruthy();
      expect(screen.getByTestId('status-health')).toBeTruthy();
      expect(screen.getByTestId('status-backup')).toBeTruthy();
    });
  });
});
