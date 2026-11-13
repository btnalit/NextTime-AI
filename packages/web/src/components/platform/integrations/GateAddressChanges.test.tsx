// @vitest-environment jsdom
import type { PlatformGateAddressChangeWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../../lib/clients.js';
import { HttpError } from '../../../lib/http-client.js';
import { GATE_ADDRESS_REJECTION_REASON_MAX, GateAddressChanges } from './GateAddressChanges.js';

afterEach(cleanup);

const TO = 'https://gate-b.example.com';

function proposal(
  patch: Partial<PlatformGateAddressChangeWire> = {},
): PlatformGateAddressChangeWire {
  return {
    id: 'gac-1',
    workspaceId: 'ws-1',
    workspaceName: 'Acme',
    gatekeeperId: 'gk-1',
    connector: 'mcp',
    target: 'https://notes.example.com',
    fromEndpoint: 'http://gate-a:8090',
    toEndpoint: TO,
    status: 'proposed',
    impact: {
      publishedOperationCount: 3,
      grantCount: 2,
      autoApprovedOperations: [],
      workerDefinitionCount: 1,
      inFlightActionRequestCount: 1,
    },
    manifestDigest: 'm'.repeat(64),
    previewDigest: 'p'.repeat(64),
    proposedByName: 'Alice',
    createdAt: '2026-11-13T00:00:00.000Z',
    expiresAt: '2026-11-14T00:00:00.000Z',
    decidedAt: null,
    decidedByLogin: null,
    rejectionReason: null,
    suspended: false,
    ...patch,
  };
}

function scriptedHttp(
  items: readonly PlatformGateAddressChangeWire[],
  decide: (name: string, params: unknown) => unknown = (_name, params) => params,
): CapabilityCaller & { readonly calls: { name: string; params: unknown }[] } {
  const calls: { name: string; params: unknown }[] = [];
  return {
    calls,
    call: vi.fn(async (name: string, params?: unknown) => {
      calls.push({ name, params });
      if (name === 'list_gate_address_changes') return { items: [...items] };
      if (name === 'approve_gate_address_change' || name === 'reject_gate_address_change') {
        return decide(name, params);
      }
      throw new Error(`unscripted capability ${name}`);
    }) as CapabilityCaller['call'],
  };
}

function callsOf(http: ReturnType<typeof scriptedHttp>, name: string) {
  return http.calls.filter((call) => call.name === name);
}

describe('GateAddressChanges (legacy 701)', () => {
  it('shows nothing while no move waits for a decision, and asks only for open ones', async () => {
    const http = scriptedHttp([]);
    const { container } = render(<GateAddressChanges http={http} onApplied={vi.fn()} />);
    await waitFor(() => expect(callsOf(http, 'list_gate_address_changes')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId('gate-address-changes-loading')).toBeNull());
    expect(container.textContent).toBe('');
    expect(callsOf(http, 'list_gate_address_changes')[0]?.params).toMatchObject({
      status: 'proposed',
    });
  });

  it('lists a move with where it goes and what follows the gate; approving sends the proposal as read', async () => {
    const onApplied = vi.fn();
    const http = scriptedHttp([proposal({ suspended: true })]);
    render(<GateAddressChanges http={http} onApplied={onApplied} />);

    const section = await screen.findByTestId('gate-address-changes');
    expect(section.textContent).toContain('等你审批的换地址申请（1）');
    const row = screen.getByTestId('gate-address-change-row-gac-1');
    expect(row.textContent).toContain('Acme');
    expect(row.textContent).toContain('http://gate-a:8090');
    expect(row.textContent).toContain(TO);
    expect(row.textContent).toContain('Alice');
    expect(screen.getByTestId('gate-address-change-suspended-gac-1').textContent).toBe('已暂停');
    const impact = screen.getByTestId('gate-address-change-impact-gac-1').textContent ?? '';
    expect(impact).toContain('3 个已发布的 Operation：新地址上的门必须原样提供');
    expect(impact).toMatch(/没有自动批准的 Operation/);
    expect(impact).toContain('1 个请求还没执行');

    fireEvent.click(within(row).getByTestId('gate-address-change-approve-gac-1'));
    const confirm = await screen.findByRole('dialog', { name: `批准换到 ${TO}` });
    expect(confirm.textContent).toContain('Acme · https://notes.example.com');
    fireEvent.click(within(confirm).getByRole('button', { name: '批准' }));

    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
    expect(callsOf(http, 'approve_gate_address_change')[0]?.params).toEqual({
      workspaceId: 'ws-1',
      id: 'gac-1',
      previewDigest: 'p'.repeat(64),
    });
    // Decided: the row goes, and with it the section.
    await waitFor(() => expect(screen.queryByTestId('gate-address-changes')).toBeNull());
  });

  it('rejecting sends the reason given, trimmed, and leaves the gate where it is', async () => {
    const onApplied = vi.fn();
    const http = scriptedHttp([proposal(), proposal({ id: 'gac-2', workspaceName: 'Beta' })]);
    render(<GateAddressChanges http={http} onApplied={onApplied} />);
    const row = await screen.findByTestId('gate-address-change-row-gac-1');

    fireEvent.click(within(row).getByTestId('gate-address-change-reject-gac-1'));
    const confirm = await screen.findByRole('dialog', { name: `驳回换到 ${TO}` });
    expect(confirm.textContent).toContain('门留在现在的地址，照常可用');
    const reason = within(confirm).getByLabelText(/原因（可选）/) as HTMLInputElement;
    expect(reason.maxLength).toBe(GATE_ADDRESS_REJECTION_REASON_MAX);
    fireEvent.change(reason, { target: { value: '  先确认新主机归谁管  ' } });
    fireEvent.click(within(confirm).getByRole('button', { name: '驳回' }));

    await waitFor(() => expect(screen.queryByTestId('gate-address-change-row-gac-1')).toBeNull());
    expect(callsOf(http, 'reject_gate_address_change')[0]?.params).toEqual({
      workspaceId: 'ws-1',
      id: 'gac-1',
      reason: '先确认新主机归谁管',
    });
    expect(onApplied).not.toHaveBeenCalled();
    expect(screen.getByTestId('gate-address-changes').textContent).toContain(
      '等你审批的换地址申请（1）',
    );
  });

  it('a rejection without a reason sends none', async () => {
    const http = scriptedHttp([proposal()]);
    render(<GateAddressChanges http={http} onApplied={vi.fn()} />);
    const row = await screen.findByTestId('gate-address-change-row-gac-1');
    fireEvent.click(within(row).getByTestId('gate-address-change-reject-gac-1'));
    const confirm = await screen.findByRole('dialog', { name: `驳回换到 ${TO}` });
    fireEvent.click(within(confirm).getByRole('button', { name: '驳回' }));
    await waitFor(() => expect(callsOf(http, 'reject_gate_address_change')).toHaveLength(1));
    expect(callsOf(http, 'reject_gate_address_change')[0]?.params).toEqual({
      workspaceId: 'ws-1',
      id: 'gac-1',
    });
  });

  it('a refused approval stays in the confirm with the reason, and the row stays', async () => {
    const onApplied = vi.fn();
    const http = scriptedHttp([proposal()], () => {
      throw new HttpError(
        'capability_error',
        'approve_gate_address_change: the gate at the new address describes other Operations than when the change was proposed — reject it; the workspace owner can propose it again',
        'gate_address_manifest_mismatch',
      );
    });
    render(<GateAddressChanges http={http} onApplied={onApplied} />);
    const row = await screen.findByTestId('gate-address-change-row-gac-1');
    fireEvent.click(within(row).getByTestId('gate-address-change-approve-gac-1'));
    const confirm = await screen.findByRole('dialog', { name: `批准换到 ${TO}` });
    fireEvent.click(within(confirm).getByRole('button', { name: '批准' }));

    const error = await within(confirm).findByTestId('confirm-error');
    expect(error.textContent).toContain('新地址上的门描述的 Operation 和申请时不一样了');
    expect(error.textContent).toContain('驳回这个申请；工作区所有者可以重新申请。');
    expect(error.getAttribute('data-error-code')).toBe('gate_address_manifest_mismatch');
    expect(onApplied).not.toHaveBeenCalled();
    expect(screen.getByTestId('gate-address-change-row-gac-1')).toBeTruthy();
  });

  // Review #501 of #1156: the new address checked again at approval answers with the codes the
  // workspace's own connect answers with; their usual next steps are the workspace's. Here the
  // administrator reads what they can do — reject it, the owner proposes again — and the refusal
  // names no other gate (the kernel sends no details).
  it.each([
    ['endpoint_already_connected', '这个工作区在申请之后已经在新地址接入了别的门', '驳回这个申请'],
    [
      'connection_secret_in_use',
      '申请里的新连接密钥现在属于这个工作区的另一个门',
      '用新生成的连接密钥重新申请',
    ],
    ['endpoint_is_platform_gate', '新地址现在是平台提供的门实例', '换一个地址重新申请'],
    ['connection_target_refused', '新地址现在不是平台允许连接的目标', '换一个地址重新申请'],
    ['manifest_fetch_failed', '新地址上的门没有回应', '可以稍后再批准'],
    ['gatekeeper_not_self_connected', '这个门已经不是工作区自己接入的了', '驳回这个申请'],
    [
      'gate_address_preview_changed',
      '这个申请或门的地址在你打开之后变了',
      '刷新列表再看一遍这个申请',
    ],
  ])(
    'an approval refused with %s tells the administrator what they can do',
    async (code, what, next) => {
      const http = scriptedHttp([proposal()], () => {
        throw new HttpError(
          'capability_error',
          `approve_gate_address_change: refused (${code})`,
          code,
        );
      });
      render(<GateAddressChanges http={http} onApplied={vi.fn()} />);
      const row = await screen.findByTestId('gate-address-change-row-gac-1');
      fireEvent.click(within(row).getByTestId('gate-address-change-approve-gac-1'));
      const confirm = await screen.findByRole('dialog', { name: `批准换到 ${TO}` });
      fireEvent.click(within(confirm).getByRole('button', { name: '批准' }));

      const error = await within(confirm).findByTestId('confirm-error');
      expect(error.textContent).toContain(what);
      expect(error.textContent).toContain('所以没有批准，什么也没改。');
      expect(error.textContent).toContain(next);
      // Not the workspace's next steps for the same codes.
      expect(error.textContent).not.toContain('系统与授权');
      expect(error.textContent).not.toContain('GATE_KERNEL_TOKEN_FILE');
    },
  );
});
