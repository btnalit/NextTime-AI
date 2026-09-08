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
  it('renders a healthy gate (boolean health) with its operations', async () => {
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
      health: true,
    });
    renderDrawer(http);
    const health = await screen.findByTestId('gatekeeper-health');
    expect(health.textContent).toBe('Healthy');
    expect(health.className).toContain('chip-ok');
    expect(screen.getByText('docker.status')).toBeTruthy();
    expect(screen.getByText('docker.restart')).toBeTruthy();
  });

  it('renders an unhealthy gate ({ok:false} health)', async () => {
    const http = callerReturning({
      id: 'gk-1',
      name: 'docker',
      kind: 'mcp',
      status: 'active',
      operationCount: 0,
      createdAt: '2026-09-01T00:00:00.000Z',
      operations: [],
      health: { ok: false, message: 'timeout' },
    });
    renderDrawer(http);
    const health = await screen.findByTestId('gatekeeper-health');
    expect(health.textContent).toBe('Unhealthy');
    expect(health.className).toContain('chip-danger');
    expect(screen.getByText('No operations on this gate')).toBeTruthy();
  });

  it('renders an unrecognized health shape as neutral "Unknown" rather than guessing', async () => {
    const http = callerReturning({
      id: 'gk-1',
      name: 'docker',
      kind: 'mcp',
      status: 'active',
      operationCount: 0,
      createdAt: '2026-09-01T00:00:00.000Z',
      operations: [],
      health: 'this-is-not-a-documented-shape',
    });
    renderDrawer(http);
    const health = await screen.findByTestId('gatekeeper-health');
    expect(health.textContent).toBe('Unknown');
    expect(health.className).toContain('chip-neutral');
  });

  it('shows "该能力尚未上线" when get_gatekeeper is not yet deployed (404 not_found)', async () => {
    const http = callerReturning(() =>
      Promise.reject(new HttpError('capability_error', 'no handler', 'not_found')),
    );
    renderDrawer(http);
    await screen.findByTestId('gatekeeper-detail-unavailable');
  });
});
