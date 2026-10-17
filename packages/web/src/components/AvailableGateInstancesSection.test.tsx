// @vitest-environment jsdom
import type { AvailableGateInstanceWire } from '@nexttime/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityListResult } from '../hooks/useCapability.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { AvailableGateInstancesSection } from './AvailableGateInstancesSection.js';

afterEach(cleanup);

const ROW: AvailableGateInstanceWire = {
  gateId: 'ci-fixture-mcp',
  connector: 'fixture-mcp',
  displayName: 'CI fixture MCP',
  transportKind: 'mcp',
  target: 'http://fixture-mcp.invalid:9000',
  status: 'enabled',
  trust: 'vetted',
  health: 'ok',
  operationCount: 2,
  gatekeeperId: null,
};

function ready(items: readonly AvailableGateInstanceWire[]) {
  return {
    state: { status: 'ready', data: { items }, refreshing: false, refreshError: null },
    reload: vi.fn(),
    mutate: vi.fn(),
    loadMore: vi.fn(),
    loadingMore: false,
    loadMoreError: null,
  } as unknown as CapabilityListResult<AvailableGateInstanceWire>;
}

describe('AvailableGateInstancesSection — a platform instance this workspace has not enabled', () => {
  it('an instance that has announced no Operations yet is not offered 启用 — the row says why (409 gate_not_ready)', () => {
    render(
      <AvailableGateInstancesSection
        http={{ call: vi.fn() } as unknown as CapabilityCaller}
        available={ready([{ ...ROW, operationCount: 0 }])}
        onEnabled={vi.fn()}
        canEnable
      />,
    );
    expect(screen.queryByTestId('enable-gate-ci-fixture-mcp')).toBeNull();
    expect(screen.getByTestId('available-gate-not-ready-ci-fixture-mcp').textContent).toMatch(
      /还没有声明任何 Operation/,
    );
  });

  it('an instance with announced Operations still offers 启用 to an owner', () => {
    render(
      <AvailableGateInstancesSection
        http={{ call: vi.fn() } as unknown as CapabilityCaller}
        available={ready([ROW])}
        onEnabled={vi.fn()}
        canEnable
      />,
    );
    expect(screen.getByTestId('enable-gate-ci-fixture-mcp')).toBeTruthy();
    expect(screen.queryByTestId('available-gate-not-ready-ci-fixture-mcp')).toBeNull();
  });

  it('a reader who may not enable it gets the request to send the owner, not a bare "owner enables" (242① class)', () => {
    render(
      <AvailableGateInstancesSection
        http={{ call: vi.fn() } as unknown as CapabilityCaller}
        available={ready([ROW])}
        onEnabled={vi.fn()}
        canEnable={false}
      />,
    );
    const ask = screen.getByTestId('available-gate-ask-owner-ci-fixture-mcp');
    expect(ask.textContent).toContain('由工作区所有者启用');
    expect(ask.querySelector('button')).not.toBeNull();
    expect(screen.queryByTestId('enable-gate-ci-fixture-mcp')).toBeNull();
  });

  it('self-service visibility: a platform administrator is told which enabled instances the catalog leaves out — not the ones this workspace already enabled (UX acceptance of #567 P2)', async () => {
    const call = vi.fn(async (name: string) => {
      if (name === 'get_workspace') {
        return {
          id: 'ws-1',
          name: 'Acme',
          createdAt: '2026-09-01T00:00:00.000Z',
          principalCount: 1,
          gatekeeperCount: 1,
          caller: { id: 'p-1', role: 'owner' },
        };
      }
      if (name === 'list_gate_instances') {
        return {
          items: [
            {
              gateId: 'ci-fixture-mcp',
              displayName: 'CI fixture MCP',
              connector: 'fixture-mcp',
              status: 'enabled',
              enabledWorkspaceCount: 0,
            },
            {
              gateId: 'gate-2',
              displayName: 'Docker prod',
              connector: 'docker',
              status: 'enabled',
              enabledWorkspaceCount: 1,
              enablingWorkspaces: [{ id: 'ws-other', name: 'Other' }],
            },
            {
              gateId: 'gate-3',
              displayName: 'Docker lab',
              connector: 'docker',
              status: 'discovered',
              enabledWorkspaceCount: 0,
            },
            {
              gateId: 'gate-4',
              displayName: 'Docker here',
              connector: 'docker',
              status: 'enabled',
              enabledWorkspaceCount: 1,
              enablingWorkspaces: [{ id: 'ws-1', name: 'Acme' }],
            },
          ],
        };
      }
      if (name === 'list_connectors') {
        return {
          items: [
            { name: 'fixture-mcp', mode: 'platform_preset' },
            { name: 'docker', mode: 'self_serve' },
          ],
        };
      }
      throw new Error(`unscripted capability ${name}`);
    });
    render(
      <AvailableGateInstancesSection
        http={{ call } as unknown as CapabilityCaller}
        available={ready([ROW])}
        onEnabled={vi.fn()}
        canEnable
        platformAdmin
      />,
    );
    const hidden = await screen.findByTestId('available-gates-hidden');
    expect(hidden.textContent).toContain(
      '平台上另有 1 个已启用、但本工作区还没启用的门实例这里看不到：',
    );
    expect(hidden.textContent).toContain('Docker prod');
    expect(hidden.textContent).not.toContain('Docker lab');
    // Enabled here: it is a system card above, and keeps working.
    expect(hidden.textContent).not.toContain('Docker here');
  });

  it('self-service visibility: a workspace reader who is not a platform administrator reads nothing on the platform', async () => {
    const call = vi.fn();
    render(
      <AvailableGateInstancesSection
        http={{ call } as unknown as CapabilityCaller}
        available={ready([ROW])}
        onEnabled={vi.fn()}
        canEnable
      />,
    );
    await waitFor(() => expect(screen.getByTestId('available-gates-table')).toBeTruthy());
    expect(call.mock.calls.map(([name]) => name)).not.toContain('list_gate_instances');
    expect(screen.queryByTestId('available-gates-hidden')).toBeNull();
  });

  it('legacy 388: at phone width each instance is a card — what this workspace can do with it sits in the card header, the rest under it', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: true,
        media: '',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    try {
      render(
        <AvailableGateInstancesSection
          http={{ call: vi.fn() } as unknown as CapabilityCaller}
          available={ready([
            ROW,
            { ...ROW, gateId: 'docker-prod', displayName: 'Docker prod', gatekeeperId: 'gk-1' },
          ])}
          onEnabled={vi.fn()}
          canEnable
        />,
      );
      expect(screen.getByTestId('available-gates-table').tagName).toBe('UL');
      const row = screen.getByTestId('available-gate-ci-fixture-mcp');
      expect(row.tagName).toBe('LI');
      expect(within(row).getByTestId('enable-gate-ci-fixture-mcp')).toBeTruthy();
      expect(within(row).getByText('平台状态')).toBeTruthy();
      // No 本工作区 header over it on a card, and 平台状态 also reads 已启用: the link says whose.
      const linked = screen.getByTestId('available-gate-docker-prod');
      expect(within(linked).getByRole('link', { name: '本工作区已启用' })).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
