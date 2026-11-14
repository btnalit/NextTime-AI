// @vitest-environment jsdom
import type { PlatformGateAddressChangeWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../../lib/clients.js';
import { HttpError } from '../../../lib/http-client.js';
import { GateAddressChangeHistory } from './GateAddressChangeHistory.js';

afterEach(cleanup);

function ended(patch: Partial<PlatformGateAddressChangeWire> = {}): PlatformGateAddressChangeWire {
  return {
    id: 'gac-1',
    workspaceId: 'ws-1',
    workspaceName: 'Acme',
    gatekeeperId: 'gk-1',
    connector: 'mcp',
    target: 'https://notes.example.com',
    fromEndpoint: 'http://gate-a:8090',
    toEndpoint: 'https://gate-b.example.com',
    status: 'applied',
    impact: {
      publishedOperationCount: 3,
      grantCount: 2,
      autoApprovedOperations: [],
      workerDefinitionCount: 1,
      inFlightActionRequestCount: 0,
    },
    manifestDigest: 'm'.repeat(64),
    previewDigest: 'p'.repeat(64),
    proposedByName: 'Alice',
    createdAt: '2026-11-13T00:00:00.000Z',
    expiresAt: '2026-11-14T00:00:00.000Z',
    decidedAt: '2026-11-13T01:00:00.000Z',
    decidedByLogin: 'root-admin',
    rejectionReason: null,
    suspended: false,
    ...patch,
  };
}

type Page = { items: PlatformGateAddressChangeWire[]; nextCursor?: string };

function scriptedHttp(
  answer: (params: Record<string, unknown>) => Page | Promise<Page>,
): CapabilityCaller & { readonly calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    call: vi.fn(async (name: string, params?: unknown) => {
      if (name !== 'list_gate_address_changes') throw new Error(`unscripted capability ${name}`);
      const asked = (params ?? {}) as Record<string, unknown>;
      calls.push(asked);
      return answer(asked);
    }) as CapabilityCaller['call'],
  };
}

function open(): HTMLElement {
  const history = screen.getByTestId('gate-address-change-history');
  (history as HTMLDetailsElement).open = true;
  fireEvent(history, new Event('toggle'));
  return history;
}

describe('GateAddressChangeHistory (legacy 717)', () => {
  it('reads nothing until opened, then the ended moves, each with how it ended', async () => {
    const http = scriptedHttp(() => ({
      items: [
        ended(),
        ended({
          id: 'gac-2',
          status: 'rejected',
          rejectionReason: 'Use the TLS host',
          decidedByLogin: 'ops-admin',
        }),
        ended({ id: 'gac-3', status: 'rejected', rejectionReason: null }),
        ended({ id: 'gac-4', status: 'withdrawn', decidedByLogin: null }),
        ended({
          id: 'gac-5',
          status: 'expired',
          decidedByLogin: null,
          decidedAt: '2026-11-20T00:00:00.000Z',
        }),
      ],
    }));
    render(<GateAddressChangeHistory http={http} revision={0} />);
    const history = screen.getByTestId('gate-address-change-history');
    expect(history.textContent).toContain('已结束的换地址申请');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(http.calls).toHaveLength(0);

    open();
    const applied = await screen.findByTestId('gate-address-change-history-row-gac-1');
    expect(http.calls).toEqual([{ ended: true, limit: 20 }]);
    expect(applied.textContent).toContain('Acme · https://notes.example.com');
    expect(applied.textContent).toContain('http://gate-a:8090');
    expect(applied.textContent).toContain('https://gate-b.example.com');
    expect(applied.textContent).toContain('Alice');
    expect(applied.textContent).toContain('root-admin');
    const outcome = (id: string) =>
      screen.getByTestId(`gate-address-change-history-outcome-${id}`).textContent;
    expect(outcome('gac-1')).toBe('已换址');
    expect(outcome('gac-2')).toBe('已驳回');
    expect(outcome('gac-4')).toBe('已撤回');
    expect(outcome('gac-5')).toBe('已过期');
    const rejected = screen.getByTestId('gate-address-change-history-row-gac-2').textContent;
    expect(rejected).toContain('ops-admin');
    expect(rejected).toContain('Use the TLS host');
    expect(screen.getByTestId('gate-address-change-history-row-gac-3').textContent).toContain(
      '没有写原因',
    );
    const withdrawn = screen.getByTestId('gate-address-change-history-row-gac-4').textContent;
    expect(withdrawn).toContain('工作区所有者');
    // An expired one ended at its expiry, not when a later act recorded it.
    const expired = screen.getByTestId('gate-address-change-history-row-gac-5');
    expect(expired.textContent).toContain('过期于');
    expect(expired.querySelectorAll('time')[1]?.getAttribute('dateTime')).toBe(
      '2026-11-14T00:00:00.000Z',
    );
    expect(screen.queryByTestId('gate-address-change-history-more')).toBeNull();
  });

  it('says so when nothing has ended yet', async () => {
    const http = scriptedHttp(() => ({ items: [] }));
    render(<GateAddressChangeHistory http={http} revision={0} />);
    open();
    expect((await screen.findByTestId('gate-address-change-history-empty')).textContent).toBe(
      '还没有已结束的换地址申请。',
    );
  });

  it('pages with 加载更多 until the list ends', async () => {
    const http = scriptedHttp((params) =>
      params.cursor === 'c1'
        ? { items: [ended({ id: 'gac-2', status: 'withdrawn' })] }
        : { items: [ended()], nextCursor: 'c1' },
    );
    render(<GateAddressChangeHistory http={http} revision={0} />);
    open();
    fireEvent.click(await screen.findByTestId('gate-address-change-history-more'));
    await screen.findByTestId('gate-address-change-history-row-gac-2');
    expect(screen.getByTestId('gate-address-change-history-row-gac-1')).toBeTruthy();
    expect(http.calls).toEqual([
      { ended: true, limit: 20 },
      { ended: true, limit: 20, cursor: 'c1' },
    ]);
    expect(screen.queryByTestId('gate-address-change-history-more')).toBeNull();
  });

  it('reads again when a move above was decided — only once it was opened', async () => {
    let decided = false;
    const http = scriptedHttp(() => ({
      items: decided ? [ended({ id: 'gac-9', status: 'rejected' }), ended()] : [ended()],
    }));
    const { rerender } = render(<GateAddressChangeHistory http={http} revision={0} />);
    rerender(<GateAddressChangeHistory http={http} revision={1} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(http.calls).toHaveLength(0);

    open();
    await screen.findByTestId('gate-address-change-history-row-gac-1');
    expect(http.calls).toHaveLength(1);
    decided = true;
    rerender(<GateAddressChangeHistory http={http} revision={2} />);
    await screen.findByTestId('gate-address-change-history-row-gac-9');
    expect(http.calls).toHaveLength(2);
  });

  it('a failed read says so and can be retried', async () => {
    let fail = true;
    const http = scriptedHttp(() => {
      if (fail) throw new HttpError('network', 'boom');
      return { items: [ended()] };
    });
    render(<GateAddressChangeHistory http={http} revision={0} />);
    open();
    const banner = await screen.findByTestId('gate-address-change-history-error');
    expect(banner.textContent).toContain('无法读取已结束的换地址申请');
    fail = false;
    fireEvent.click(within(banner).getByRole('button', { name: /重试/ }));
    await screen.findByTestId('gate-address-change-history-row-gac-1');
  });
});
