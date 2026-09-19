// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from './clients.js';
import {
  gateInstanceAnnounced,
  gateInstanceReady,
  gatePathForKind,
  platformGateInstanceHref,
  useGateInstancePoll,
} from './gate-instances.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('gatePathForKind / gateInstanceReady', () => {
  it('routes http and mcp to the gate host, ssh and cli to a packaged gate', () => {
    expect(gatePathForKind('http')).toBe('hosted');
    expect(gatePathForKind('mcp')).toBe('hosted');
    expect(gatePathForKind('ssh')).toBe('packaged');
    expect(gatePathForKind('cli')).toBe('packaged');
  });

  it('mirrors the kernel requireAvailable rule: enabled + announced + has Operations', () => {
    expect(
      gateInstanceReady({
        status: 'enabled',
        lastSeenAt: '2026-09-19T00:00:00Z',
        operationCount: 2,
      }),
    ).toBe(true);
    expect(
      gateInstanceReady({
        status: 'discovered',
        lastSeenAt: '2026-09-19T00:00:00Z',
        operationCount: 2,
      }),
    ).toBe(false);
    expect(gateInstanceReady({ status: 'enabled', lastSeenAt: null, operationCount: 2 })).toBe(
      false,
    );
    expect(
      gateInstanceReady({
        status: 'enabled',
        lastSeenAt: '2026-09-19T00:00:00Z',
        operationCount: 0,
      }),
    ).toBe(false);
    expect(gateInstanceAnnounced({ lastSeenAt: null, operationCount: 0 })).toBe(false);
    expect(gateInstanceAnnounced({ lastSeenAt: '2026-09-19T00:00:00Z', operationCount: 1 })).toBe(
      true,
    );
  });

  it('spells the platform deep link once', () => {
    expect(platformGateInstanceHref('gate a')).toBe('#/platform/integrations/gate%20a');
  });
});

function Poller({
  http,
  active,
}: {
  readonly http: CapabilityCaller;
  readonly active: boolean;
}) {
  const poll = useGateInstancePoll<{ gateId: string }>(
    http,
    'list_gate_instances',
    {},
    {
      active,
      intervalMs: 1_000,
    },
  );
  return (
    <span data-testid="poll">
      {poll.state.status === 'ready'
        ? poll.state.data.map((row) => row.gateId).join(',') || 'empty'
        : poll.state.status}
    </span>
  );
}

describe('useGateInstancePoll', () => {
  it('reads once immediately, then every interval while active, and stops when inactive', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const http: CapabilityCaller = {
      call: vi.fn(async () => {
        calls += 1;
        return { items: calls >= 2 ? [{ gateId: 'gate-1' }] : [] };
      }) as CapabilityCaller['call'],
    };
    const view = render(<Poller http={http} active />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(calls).toBe(1);
    expect(screen.getByTestId('poll').textContent).toBe('empty');

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });
    expect(calls).toBe(2);
    expect(screen.getByTestId('poll').textContent).toBe('gate-1');

    view.rerender(<Poller http={http} active={false} />);
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(calls).toBe(2);
  });

  it('a failed first read is error; a failed later read keeps the rows', async () => {
    vi.useRealTimers();
    let calls = 0;
    const http: CapabilityCaller = {
      call: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error('boom');
        return { items: [{ gateId: 'gate-2' }] };
      }) as CapabilityCaller['call'],
    };
    render(<Poller http={http} active />);
    await waitFor(() => expect(screen.getByTestId('poll').textContent).toBe('error'));
  });
});
