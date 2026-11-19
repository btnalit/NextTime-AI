// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../hooks/usePermissions.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { HttpError } from '../lib/http-client.js';
import { LangProvider } from '../lib/i18n.js';
import { type GatekeeperCardCounts, GatekeeperDetailDrawer } from './GatekeeperDetailDrawer.js';

afterEach(cleanup);

function callerReturning(result: unknown | (() => unknown)): CapabilityCaller {
  return {
    call: vi.fn(async () =>
      typeof result === 'function' ? (result as () => unknown)() : result,
    ) as CapabilityCaller['call'],
  };
}

function renderDrawer(http: CapabilityCaller, cardGate?: GatekeeperCardCounts) {
  return render(
    <PermissionsProvider>
      <GatekeeperDetailDrawer http={http} gatekeeperId="gk-1" cardGate={cardGate} />
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

  describe('legacy 215: whether the gate checks the definition the platform approved', () => {
    function gateWith(operationDigestCheck?: 'declared' | 'undeclared') {
      return callerReturning({
        id: 'gk-1',
        name: 'notes',
        kind: 'http',
        status: 'active',
        operationCount: 0,
        createdAt: '2026-09-01T00:00:00.000Z',
        operations: [],
        health: 'ok',
        ...(operationDigestCheck ? { operationDigestCheck } : {}),
      });
    }

    it('a gate that does not say it checks is marked 未声明校验摘要 as a warning, with the two kinds it can be and who changes it', async () => {
      renderDrawer(gateWith('undeclared'));
      const row = await screen.findByTestId('gatekeeper-digest-check');
      expect(row.querySelector('.tag.text-warn')?.textContent).toBe('未声明校验摘要');
      expect(row.querySelector('.text-danger')).toBeNull();
      // Not "does not check": a gate on gatekeeper-base from v0.46.0 checks without declaring it.
      expect(row.textContent).not.toContain('不校验摘要');
      expect(row.textContent).toContain('v0.46.0 起');
      expect(row.textContent).toContain('会校验，只是不声明');
      expect(row.textContent).toContain('平台照常调用它');
      expect(row.textContent).toContain('重建后');
    });

    it('a gate that says it checks reads as its own word, unmarked', async () => {
      renderDrawer(gateWith('declared'));
      const row = await screen.findByTestId('gatekeeper-digest-check');
      expect(row.textContent).toBe('门声明会校验摘要：调用带来的定义和门运行的不一致时拒绝执行');
      expect(row.querySelector('.tag')).toBeNull();
    });

    it('no row when the gate gave no answer', async () => {
      renderDrawer(gateWith());
      await screen.findByTestId('gatekeeper-health');
      expect(screen.queryByTestId('gatekeeper-digest-check')).toBeNull();
    });
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

  it('legacy 271: a gate whose credential is refused reads 凭据被拒 (#1394 UX P2)', async () => {
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
    expect(health.textContent).toBe('凭据被拒');
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
  describe('legacy 383: the Operation count reads like the system card', () => {
    const gate = (operations: unknown[]) =>
      callerReturning({
        id: 'gk-1',
        name: 'stock',
        kind: 'http',
        status: 'active',
        operationCount: operations.length,
        createdAt: '2026-09-01T00:00:00.000Z',
        operations,
        health: 'ok',
      });

    it('splits published read and write, then drafts and deprecated versions', async () => {
      renderDrawer(
        gate([
          { name: 'stock.list', status: 'published', mode: 'observe' },
          { name: 'stock.get', status: 'published', mode: 'observe' },
          { name: 'stock.sell', status: 'published', mode: 'execute' },
          { name: 'stock.sell', status: 'deprecated', version: 1, mode: 'execute' },
          { name: 'stock.buy', status: 'draft', mode: 'execute' },
        ]),
      );
      const counts = await screen.findByTestId('gatekeeper-op-counts');
      expect(counts.textContent).toBe('已发布 2 个只读 · 1 个写 · 1 个草稿 · 1 个已弃用的旧版本');
      expect(screen.queryByTestId('gatekeeper-platform-disabled')).toBeNull();
    });

    const card = (read: number, write: number, disabled: string[] = []) => ({
      observeOperationCount: read,
      executeOperationCount: write,
      disabledOperations: disabled,
    });

    it('repeats the card’s published counts, says how many of them the platform disabled, and names those', async () => {
      // The card counts 2 read and 1 write; get_gatekeeper lists only stock.list.
      renderDrawer(
        gate([{ name: 'stock.list', status: 'published', mode: 'observe' }]),
        card(2, 1, ['stock.get', 'stock.sell']),
      );
      const counts = await screen.findByTestId('gatekeeper-op-counts');
      expect(counts.textContent).toBe(
        '已发布 2 个只读 · 1 个写；其中 2 个被平台停用，下面没有列出',
      );
      const notice = screen.getByTestId('gatekeeper-platform-disabled');
      expect(notice.textContent).toContain('平台停用了这个门上已发布的 2 个');
      expect(notice.textContent).toContain('stock.get、stock.sell。它们不在下面列出');
      expect(notice.textContent).toContain('系统卡片上的已发布数包括它们');
      expect(notice.textContent).toContain('请找平台管理员');
    });

    it('says 「它」 for one, and the list is disabled rather than 「这个门没有 Operation」 when every published one is', async () => {
      renderDrawer(gate([]), card(1, 0, ['stock.list']));
      const counts = await screen.findByTestId('gatekeeper-op-counts');
      expect(counts.textContent).toBe(
        '已发布 1 个只读 · 0 个写；其中 1 个被平台停用，下面没有列出',
      );
      const notice = screen.getByTestId('gatekeeper-platform-disabled').textContent ?? '';
      expect(notice).toContain('平台停用了这个门上已发布的 1 个');
      expect(notice).toContain('stock.list。它不在下面列出');
      expect(notice).toContain('已发布数包括它。要再用它，');
      expect(notice).not.toContain('它们');
      expect(screen.getByText('没有可列出的 Operation：已发布的都被平台停用了')).toBeTruthy();
      expect(screen.queryByText('这个门没有 Operation')).toBeNull();
    });

    it('does not repeat a disabled name the list still shows (a suspended gate keeps its Operations listed)', async () => {
      renderDrawer(
        gate([{ name: 'stock.list', status: 'published', mode: 'observe' }]),
        card(1, 0, ['stock.list']),
      );
      await screen.findByTestId('gatekeeper-op-counts');
      expect(screen.getByTestId('gatekeeper-op-counts').textContent).toBe(
        '已发布 1 个只读 · 0 个写',
      );
      expect(screen.queryByTestId('gatekeeper-platform-disabled')).toBeNull();
    });

    it('reads in English, singular for one', async () => {
      localStorage.setItem('nexttime.lang', 'en');
      try {
        render(
          <LangProvider>
            <PermissionsProvider>
              <GatekeeperDetailDrawer
                http={gate([
                  { name: 'stock.list', status: 'published', mode: 'observe' },
                  { name: 'stock.buy', status: 'draft', mode: 'execute' },
                ])}
                gatekeeperId="gk-1"
                cardGate={card(1, 1, ['stock.sell'])}
              />
            </PermissionsProvider>
          </LangProvider>,
        );
        const counts = await screen.findByTestId('gatekeeper-op-counts');
        expect(counts.textContent).toBe(
          'Published: 1 read · 1 write; 1 of them disabled by the platform, not listed below · 1 draft',
        );
        expect(screen.getByTestId('gatekeeper-platform-disabled').textContent).toContain(
          'The platform disabled a published Operation on this gate: stock.sell. It is not listed below',
        );
      } finally {
        localStorage.removeItem('nexttime.lang');
      }
    });
  });
});
