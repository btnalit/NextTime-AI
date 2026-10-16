// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../hooks/usePermissions.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { HttpError } from '../lib/http-client.js';
import { GatekeeperDetailDrawer } from './GatekeeperDetailDrawer.js';

afterEach(cleanup);

function callerReturning(result: unknown | (() => unknown)): CapabilityCaller {
  return {
    call: vi.fn(async () =>
      typeof result === 'function' ? (result as () => unknown)() : result,
    ) as CapabilityCaller['call'],
  };
}

function renderDrawer(http: CapabilityCaller) {
  return render(
    <PermissionsProvider>
      <GatekeeperDetailDrawer http={http} gatekeeperId="gk-1" />
    </PermissionsProvider>,
  );
}

describe('GatekeeperDetailDrawer', () => {
  it('renders a healthy gate (wire health "ok") with its operations', async () => {
    const http = callerReturning({
      id: 'gk-1',
      name: 'docker',
      kind: 'mcp',
      status: 'active',
      manifestVersion: 3,
      operationCount: 2,
      createdAt: '2026-09-01T00:00:00.000Z',
      operations: [
        { name: 'docker.status', status: 'published', mode: 'observe' },
        { name: 'docker.restart', status: 'draft', mode: 'execute' },
      ],
      health: 'ok',
    });
    renderDrawer(http);
    const health = await screen.findByTestId('gatekeeper-health');
    expect(health.textContent).toBe('健康');
    expect(health.className).toContain('chip-ok');
    expect(screen.getByText('docker.status')).toBeTruthy();
    expect(screen.getByText('docker.restart')).toBeTruthy();
  });

  it('legacy 271: an unreachable gate reads 不可达, not 未知', async () => {
    const http = callerReturning({
      id: 'gk-1',
      name: 'docker',
      kind: 'mcp',
      status: 'active',
      operationCount: 0,
      createdAt: '2026-09-01T00:00:00.000Z',
      operations: [],
      health: 'unreachable',
    });
    renderDrawer(http);
    const health = await screen.findByTestId('gatekeeper-health');
    expect(health.textContent).toBe('不可达');
    expect(health.className).toContain('chip-danger');
    expect(screen.getByText('这个门没有 Operation')).toBeTruthy();
  });

  it('legacy 271: a gate whose credential is refused reads 未授权', async () => {
    const http = callerReturning({
      id: 'gk-1',
      name: 'docker',
      kind: 'mcp',
      status: 'active',
      operationCount: 0,
      createdAt: '2026-09-01T00:00:00.000Z',
      operations: [],
      health: 'unauthorized',
    });
    renderDrawer(http);
    const health = await screen.findByTestId('gatekeeper-health');
    expect(health.textContent).toBe('未授权');
    expect(health.getAttribute('data-status')).toBe('unauthorized');
    expect(health.className).toContain('chip-danger');
  });

  it('renders the error banner when get_gatekeeper answers not_found (B6: no "not live yet" placeholder)', async () => {
    const http = callerReturning(() =>
      Promise.reject(new HttpError('capability_error', 'no such gatekeeper', 'not_found')),
    );
    renderDrawer(http);
    await screen.findByTestId('gatekeeper-detail-error');
  });

  it('UX acceptance of #567 P3: a draft held back for a gate-owned param is marked, not shown as an ordinary draft', async () => {
    const http = callerReturning({
      id: 'gk-1',
      name: 'orders',
      kind: 'http',
      status: 'active',
      manifestVersion: 1,
      operationCount: 2,
      createdAt: '2026-09-01T00:00:00.000Z',
      operations: [
        { name: 'stock.get', status: 'published', mode: 'observe' },
        {
          name: 'orders.lookup',
          status: 'draft',
          mode: 'observe',
          gateOwnedParams: [{ param: 'Authorization', location: 'header' }],
        },
      ],
      health: 'ok',
    });
    renderDrawer(http);
    const chip = await screen.findByTestId('gatekeeper-op-held-orders.lookup');
    expect(chip.textContent).toBe('发布不了');
    expect(chip.getAttribute('title')).toContain('Authorization（请求头）');
    expect(screen.queryByTestId('gatekeeper-op-held-stock.get')).toBeNull();
  });
});
