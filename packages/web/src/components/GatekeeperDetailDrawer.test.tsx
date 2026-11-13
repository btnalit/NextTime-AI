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

  it('legacy 674: a self-connected gate the platform suspended says so, why, and who lifts it, and keeps its operations listed', async () => {
    const http = callerReturning({
      id: 'gk-1',
      name: 'notes',
      kind: 'http',
      status: 'active',
      operationCount: 2,
      createdAt: '2026-09-01T00:00:00.000Z',
      operations: [
        { name: 'notes.list', status: 'published', mode: 'observe' },
        { name: 'notes.archive', status: 'published', mode: 'execute' },
      ],
      health: 'ok',
      platformSuspension: { suspendedAt: '2026-11-07T09:00:00.000Z', reason: '安全审查中' },
    });
    renderDrawer(http);
    const notice = await screen.findByTestId('gatekeeper-platform-suspension');
    expect(notice.textContent).toContain('平台暂停了这个门');
    expect(notice.textContent).toContain('原因：安全审查中');
    expect(notice.textContent).toContain('请找平台管理员恢复它');
    expect(screen.getByText('notes.list')).toBeTruthy();
    expect(screen.getByText('notes.archive')).toBeTruthy();
    expect(screen.queryByText('这个门没有 Operation')).toBeNull();
  });

  it('legacy 674: a reason the kernel read out masked says what [redacted] stands for', async () => {
    const http = callerReturning({
      id: 'gk-1',
      name: 'notes',
      kind: 'http',
      status: 'active',
      operationCount: 0,
      createdAt: '2026-09-01T00:00:00.000Z',
      operations: [],
      health: 'ok',
      platformSuspension: {
        suspendedAt: '2026-11-07T09:00:00.000Z',
        reason: 'token [redacted] leaked',
      },
    });
    renderDrawer(http);
    const notice = await screen.findByTestId('gatekeeper-platform-suspension');
    expect(notice.textContent).toContain('token [redacted] leaked');
    expect(screen.getByTestId('gatekeeper-platform-suspension-redacted').textContent).toContain(
      '看起来像密码、令牌或密钥',
    );
  });

  it('legacy 674: a suspension with no reason says none was given', async () => {
    const http = callerReturning({
      id: 'gk-1',
      name: 'notes',
      kind: 'http',
      status: 'active',
      operationCount: 0,
      createdAt: '2026-09-01T00:00:00.000Z',
      operations: [],
      health: 'ok',
      platformSuspension: { suspendedAt: '2026-11-07T09:00:00.000Z' },
    });
    renderDrawer(http);
    const notice = await screen.findByTestId('gatekeeper-platform-suspension');
    expect(notice.textContent).toContain('平台管理员没有写原因');
  });

  it('shows no suspension note for a gate the platform has not suspended', async () => {
    const http = callerReturning({
      id: 'gk-1',
      name: 'notes',
      kind: 'http',
      status: 'active',
      operationCount: 0,
      createdAt: '2026-09-01T00:00:00.000Z',
      operations: [],
      health: 'ok',
    });
    renderDrawer(http);
    await screen.findByTestId('gatekeeper-health');
    expect(screen.queryByTestId('gatekeeper-platform-suspension')).toBeNull();
  });

  it('legacy 701: an owner sees the address the kernel calls the gate at, and an open move to withdraw', async () => {
    const pending = {
      id: 'gac-1',
      gatekeeperId: 'gk-1',
      fromEndpoint: 'http://gate-a:8090',
      toEndpoint: 'https://gate-b.example.com',
      status: 'proposed',
      impact: {
        publishedOperationCount: 0,
        grantCount: 0,
        autoApprovedOperations: [],
        workerDefinitionCount: 0,
        inFlightActionRequestCount: 0,
      },
      previewDigest: 'p'.repeat(64),
      proposedBy: 'p-owner',
      createdAt: '2026-11-13T00:00:00.000Z',
      expiresAt: '2026-11-14T00:00:00.000Z',
      decidedAt: null,
      rejectionReason: null,
    };
    const http = callerReturning({
      id: 'gk-1',
      name: 'notes',
      kind: 'http',
      status: 'active',
      operationCount: 0,
      createdAt: '2026-09-01T00:00:00.000Z',
      operations: [],
      health: 'ok',
      endpoint: 'http://gate-a:8090',
      pendingAddressChange: pending,
    });
    renderDrawer(http);
    expect((await screen.findByTestId('gatekeeper-endpoint')).textContent).toBe(
      'http://gate-a:8090',
    );
    const notice = screen.getByTestId('gate-address-change-pending');
    expect(notice.textContent).toContain('换地址的申请在等平台管理员审批');
    expect(notice.textContent).toContain('https://gate-b.example.com');
    expect(screen.getByTestId('gate-address-change-withdraw')).toBeTruthy();
  });

  // Legacy 715: how the last proposal to move ended, for the owner, while none is open.
  const gateWith = (extra: Record<string, unknown>) => ({
    id: 'gk-1',
    name: 'notes',
    kind: 'http',
    status: 'active',
    operationCount: 0,
    createdAt: '2026-09-01T00:00:00.000Z',
    operations: [],
    health: 'ok',
    endpoint: 'http://gate-a:8090',
    ...extra,
  });
  const outcome = (extra: Record<string, unknown>) => ({
    id: 'gac-1',
    gatekeeperId: 'gk-1',
    fromEndpoint: 'http://gate-a:8090',
    toEndpoint: 'https://gate-b.example.com',
    createdAt: '2026-11-12T00:00:00.000Z',
    endedAt: '2026-11-12T06:00:00.000Z',
    rejectionReason: null,
    accountCredentialsLeftOnOldHost: false,
    ...extra,
  });

  it('legacy 715: a rejected move says so, with the reason given and the way back', async () => {
    renderDrawer(
      callerReturning(
        gateWith({
          lastAddressChangeOutcome: outcome({
            status: 'rejected',
            rejectionReason: 'Use the TLS listener, token [redacted] was in the note',
          }),
        }),
      ),
    );
    const notice = await screen.findByTestId('gate-address-change-outcome');
    expect(notice.textContent).toContain('换地址的申请被平台管理员驳回了');
    expect(notice.textContent).toContain('https://gate-b.example.com');
    expect(screen.getByTestId('gate-address-change-outcome-reason').textContent).toMatch(
      /^原因：Use the TLS listener, token \[redacted\] was in the note$/,
    );
    expect(screen.getByTestId('gate-address-change-outcome-redacted')).toBeTruthy();
    expect(notice.textContent).toContain('「更换地址」重新申请');
    expect(notice.textContent).toContain('「重新签发连接密钥」');
  });

  it('legacy 715: a rejected move with no reason says none was given', async () => {
    renderDrawer(
      callerReturning(gateWith({ lastAddressChangeOutcome: outcome({ status: 'rejected' }) })),
    );
    expect((await screen.findByTestId('gate-address-change-outcome-reason')).textContent).toBe(
      '平台管理员没有写原因。',
    );
  });

  it('legacy 715: an expired move says nobody decided it, and the way back', async () => {
    renderDrawer(
      callerReturning(gateWith({ lastAddressChangeOutcome: outcome({ status: 'expired' }) })),
    );
    const notice = await screen.findByTestId('gate-address-change-outcome');
    expect(notice.textContent).toContain('换地址的申请过期了，没有生效');
    expect(notice.textContent).toContain('24 小时内没有平台管理员处理');
    expect(notice.textContent).toContain('「重新签发连接密钥」');
    expect(screen.queryByTestId('gate-address-change-outcome-reason')).toBeNull();
  });

  it('legacy 715: an applied move says where from and to, and reminds the owner what may stay at the old address', async () => {
    renderDrawer(
      callerReturning(
        gateWith({
          endpoint: 'https://gate-b.example.com',
          lastAddressChangeOutcome: outcome({
            status: 'applied',
            accountCredentialsLeftOnOldHost: true,
          }),
        }),
      ),
    );
    const notice = await screen.findByTestId('gate-address-change-outcome');
    expect(notice.textContent).toContain('门已换到新地址');
    expect(notice.textContent).toContain('http://gate-a:8090');
    expect(notice.textContent).toContain('https://gate-b.example.com');
    // A reminder, not an assertion: the flag is a fact of the moment the move was applied, and the
    // kernel does not know whether the owner cleared them since (review of #1166).
    expect(notice.textContent).toContain(
      '原来地址上的门如果还留着这些账号凭证，请到那台主机上清除',
    );
    expect(notice.textContent).not.toContain('重新申请');
  });

  it('legacy 715: a withdrawn move shows nothing, and no outcome shows while a move is open', async () => {
    renderDrawer(
      callerReturning(gateWith({ lastAddressChangeOutcome: outcome({ status: 'withdrawn' }) })),
    );
    await screen.findByTestId('gatekeeper-health');
    expect(screen.queryByTestId('gate-address-change-outcome')).toBeNull();
    cleanup();

    renderDrawer(
      callerReturning(
        gateWith({
          pendingAddressChange: {
            id: 'gac-2',
            gatekeeperId: 'gk-1',
            fromEndpoint: 'http://gate-a:8090',
            toEndpoint: 'https://gate-c.example.com',
            status: 'proposed',
            impact: {
              publishedOperationCount: 0,
              grantCount: 0,
              autoApprovedOperations: [],
              workerDefinitionCount: 0,
              inFlightActionRequestCount: 0,
            },
            previewDigest: 'p'.repeat(64),
            proposedBy: 'p-owner',
            createdAt: '2026-11-13T00:00:00.000Z',
            expiresAt: '2026-11-14T00:00:00.000Z',
            decidedAt: null,
            rejectionReason: null,
          },
          lastAddressChangeOutcome: outcome({ status: 'rejected', rejectionReason: 'No.' }),
        }),
      ),
    );
    await screen.findByTestId('gate-address-change-pending');
    expect(screen.queryByTestId('gate-address-change-outcome')).toBeNull();
  });

  it('legacy 701: without the address (not an owner, or a platform gate) no address row shows', async () => {
    const http = callerReturning({
      id: 'gk-1',
      name: 'notes',
      kind: 'http',
      status: 'active',
      operationCount: 0,
      createdAt: '2026-09-01T00:00:00.000Z',
      operations: [],
      health: 'ok',
    });
    renderDrawer(http);
    await screen.findByTestId('gatekeeper-health');
    expect(screen.queryByTestId('gatekeeper-endpoint')).toBeNull();
    expect(screen.queryByTestId('gate-address-change-pending')).toBeNull();
  });

  it('legacy 232: an old Operation name with a hidden character shows it as \\u{XXXX}', async () => {
    const http = callerReturning({
      id: 'gk-1',
      name: 'docker',
      kind: 'mcp',
      status: 'active',
      operationCount: 1,
      createdAt: '2026-09-01T00:00:00.000Z',
      operations: [{ name: 'docker.\u202Erestart', status: 'published', mode: 'execute' }],
      health: 'ok',
    });
    renderDrawer(http);
    expect(await screen.findByText('docker.\\u{202E}restart')).toBeTruthy();
    expect(screen.queryByText('docker.\u202Erestart')).toBeNull();
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
  it('review #501 on #577 ②: versions of one name listed side by side each say their version; a name listed once does not', async () => {
    const http = callerReturning({
      id: 'gk-1',
      name: 'orders',
      kind: 'http',
      status: 'active',
      manifestVersion: 4,
      operationCount: 3,
      createdAt: '2026-09-01T00:00:00.000Z',
      operations: [
        { name: 'stock.get', version: 1, status: 'published', mode: 'observe' },
        { name: 'orders.lookup', version: 3, status: 'published', mode: 'observe' },
        { name: 'orders.lookup', version: 2, status: 'deprecated', mode: 'observe' },
      ],
      health: 'ok',
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderDrawer(http);
    expect((await screen.findByTestId('gatekeeper-op-version-orders.lookup-3')).textContent).toBe(
      'v3',
    );
    expect(screen.getByTestId('gatekeeper-op-version-orders.lookup-2').textContent).toBe('v2');
    expect(screen.queryByTestId('gatekeeper-op-version-stock.get-1')).toBeNull();
    // Rows keyed by name alone would make React warn about two children with one key.
    expect(error.mock.calls.some((call) => String(call[0]).includes('same key'))).toBe(false);
    error.mockRestore();
  });
});
