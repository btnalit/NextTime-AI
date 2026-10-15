// @vitest-environment jsdom
import type { AvailableGateInstanceWire } from '@nexttime/shared';
import { cleanup, render, screen } from '@testing-library/react';
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
});
