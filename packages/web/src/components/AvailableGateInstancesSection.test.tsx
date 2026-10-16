// @vitest-environment jsdom
import type { AvailableGateInstanceWire } from '@nexttime/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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

  it('self-service visibility: a platform administrator is told which enabled instances the catalog leaves out, and why', async () => {
    const call = vi.fn(async (name: string) => {
      if (name === 'list_gate_instances') {
        return {
          items: [
            {
              gateId: 'ci-fixture-mcp',
              displayName: 'CI fixture MCP',
              connector: 'fixture-mcp',
              status: 'enabled',
            },
            {
              gateId: 'gate-2',
              displayName: 'Docker prod',
              connector: 'docker',
              status: 'enabled',
            },
            {
              gateId: 'gate-3',
              displayName: 'Docker lab',
              connector: 'docker',
              status: 'discovered',
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
    expect(hidden.textContent).toContain('平台上另有 1 个已启用的门实例这里看不到：');
    expect(hidden.textContent).toContain('Docker prod');
    expect(hidden.textContent).not.toContain('Docker lab');
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
});
