// @vitest-environment jsdom
import type { ExecutionReadinessWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import type { GrantRow, PrincipalRow } from '../../lib/governance.js';
import { HttpError } from '../../lib/http-client.js';
import { SystemsPage } from './SystemsPage.js';

afterEach(cleanup);

function workspace(role: string, id = 'p-self') {
  return {
    id: 'ws-1',
    name: 'Acme',
    createdAt: '2026-01-01T00:00:00Z',
    principalCount: 2,
    gatekeeperCount: 1,
    caller: { id, role, displayName: 'Self', kind: 'human' },
  };
}

function readiness(overrides: Partial<ExecutionReadinessWire> = {}): ExecutionReadinessWire {
  return {
    principalId: 'p-self',
    ready: false,
    missing: [],
    gates: [],
    workers: [],
    ...overrides,
  };
}

function gate(overrides: Partial<ExecutionReadinessWire['gates'][number]> = {}) {
  return {
    gateId: 'gk-1',
    name: 'Docker prod',
    granted: true,
    publishedOperationCount: 3,
    observeOperationCount: 2,
    executeOperationCount: 1,
    disabledOperations: [],
    excludedByPolicy: false,
    excludedByProfile: false,
    inEntryScope: true,
    workerDefinitionIds: ['wd-1'],
    status: 'direct' as const,
    ...overrides,
  };
}

function principal(overrides: Partial<PrincipalRow> = {}): PrincipalRow {
  return {
    id: 'p-2',
    kind: 'human',
    role: 'member',
    displayName: 'Bob',
    createdAt: '2026-09-01T00:00:00.000Z',
    hasApiKey: false,
    ...overrides,
  };
}

function grant(overrides: Partial<GrantRow> = {}): GrantRow {
  return {
    id: 'grant-1',
    principalId: 'p-2',
    resourceType: 'gatekeeper',
    resourceId: 'gk-1',
    status: 'active',
    grantedBy: 'p-self',
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function scriptedHttp(
  handlers: Record<string, (params: unknown) => unknown | Promise<unknown>>,
): CapabilityCaller & { readonly calls: { readonly name: string; readonly params: unknown }[] } {
  const calls: { name: string; params: unknown }[] = [];
  const base: Record<string, (params: unknown) => unknown | Promise<unknown>> = {
    get_workspace: () => workspace('owner'),
    list_connection_requests: () => ({ items: [] }),
    list_available_gate_instances: () => ({ items: [] }),
    list_operations: (params) => {
      const gatekeeperId = (params as { gatekeeperId?: string }).gatekeeperId;
      return { items: gatekeeperId ? [] : [] };
    },
    list_principals: () => ({ items: [] }),
    list_grants: () => ({ items: [] }),
    execution_readiness: () => readiness({ principalId: 'p-self' }),
    resolve_refs: () => ({ items: [] }),
    ...handlers,
  };
  return {
    calls,
    call: vi.fn(async (name: string, params?: unknown) => {
      calls.push({ name, params });
      const handler = base[name];
      if (!handler) throw new Error(`unscripted capability ${name}`);
      return handler(params);
    }) as CapabilityCaller['call'],
  };
}

function renderPage(http: CapabilityCaller) {
  return render(
    <PermissionsProvider>
      <SystemsPage http={http} />
    </PermissionsProvider>,
  );
}

/** Radix `DropdownMenu`'s trigger opens on `onPointerDown` under jsdom — plain `fireEvent.click`
 *  leaves it closed (same as `ConnectionsPage.test.tsx`'s own note before this lane). */
function openConnectMoreMenu(): void {
  fireEvent.pointerDown(screen.getByTestId('connect-system-more'), { button: 0 });
}

describe('SystemsPage', () => {
  it('empty state: no system yet offers the one "接入一个系统" action', async () => {
    const http = scriptedHttp({
      execution_readiness: () =>
        readiness({ principalId: 'p-self', missing: [{ code: 'no_enabled_gate' }] }),
    });
    renderPage(http);
    const empty = await screen.findByTestId('systems-empty');
    fireEvent.click(within(empty).getByRole('button', { name: '接入一个系统' }));
    const drawer = await screen.findByTestId('connect-system-drawer');
    expect(within(drawer).getByTestId('connect-system-launcher')).toBeTruthy();
  });

  it('P0-4: an admin with a discovered but not enabled instance is told so and linked to enable it', async () => {
    const http = scriptedHttp({
      list_gate_instances: () => ({
        items: [
          {
            gateId: 'gate-mcp-1',
            connector: 'fixture-mcp',
            displayName: 'Fixture MCP',
            transportKind: 'mcp',
            target: 'http://mcp.example.invalid',
            endpoint: 'http://gate.example.invalid',
            status: 'discovered',
            trust: 'byo',
            health: 'ok',
            lastSeenAt: null,
            lastCheckedAt: null,
            operationCount: 2,
            enabledWorkspaces: [],
          },
        ],
      }),
    });
    render(
      <PermissionsProvider>
        <SystemsPage http={http} platformAdmin />
      </PermissionsProvider>,
    );
    const empty = await screen.findByTestId('available-gates-empty');
    await waitFor(() => expect(empty.textContent).toContain('1 个门实例还没启用'));
    expect(screen.getByTestId('available-gates-enable-link').getAttribute('href')).toBe(
      '#/platform/integrations/gate-mcp-1',
    );
  });

  it('P0-4: a non-admin is told who has to enable an instance', async () => {
    renderPage(scriptedHttp({}));
    const empty = await screen.findByTestId('available-gates-empty');
    expect(empty.textContent).toContain('请联系平台管理员');
  });

  it('bugfix (PR #324 review): the selected 连接申请 filter tab renders its visible label (kit/tabs, not an invisible primary-button pill)', async () => {
    const http = scriptedHttp({});
    renderPage(http);
    const tab = await screen.findByRole('tab', { name: '已申请' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(tab.textContent?.trim()).not.toBe('');
    expect(tab.textContent).toContain('已申请');
    const allTab = screen.getByRole('tab', { name: '全部' });
    expect(allTab.getAttribute('aria-selected')).toBe('false');
  });

  it('owner view: shows every grantee with a reachability chip and reason, and wires grant + revoke', async () => {
    const http = scriptedHttp({
      execution_readiness: (params) => {
        const principalId = (params as { principalId?: string }).principalId ?? 'p-self';
        if (principalId === 'p-2') {
          return readiness({
            principalId: 'p-2',
            gates: [
              gate({
                status: 'unreachable',
                reason: 'excluded_by_profile',
              }),
            ],
          });
        }
        return readiness({
          principalId: 'p-self',
          ready: true,
          gates: [gate()],
          workers: [
            {
              definitionId: 'wd-1',
              version: 1,
              name: 'ops-runner',
              delegable: true,
              reachableGateCount: 1,
              blockedBy: [],
            },
          ],
        });
      },
      list_principals: () => ({
        items: [principal(), principal({ id: 'p-self', displayName: 'Alice', role: 'owner' })],
      }),
      list_grants: () => ({ items: [grant()] }),
      grant_capability: (params) => {
        expect(params).toEqual({
          principalId: 'p-2',
          resourceType: 'gatekeeper',
          resourceId: 'gk-1',
        });
        return grant({ id: 'grant-2' });
      },
      revoke_capability: (params) => {
        expect(params).toEqual({ grantId: 'grant-1' });
        return grant({ status: 'revoked' });
      },
    });
    renderPage(http);

    const card = (await screen.findAllByTestId('gatekeeper-card')).find((el) =>
      el.textContent?.includes('Docker prod'),
    ) as HTMLElement;
    expect(card).toBeTruthy();

    // Ops summary from the baseline (self) readiness read.
    expect(within(card).getByTestId('gatekeeper-ops-summary').textContent).toContain(
      '2 个只读操作',
    );
    expect(within(card).getByTestId('gatekeeper-ops-summary').textContent).toContain('1 个写操作');

    // Reachability for me (the owner, self) renders inline on the row — no drawer needed.
    expect(within(card).getByTestId('gatekeeper-reachability').textContent).toContain('可直接调用');

    // 谁能用 / 哪些 Worker 覆盖 (console redesign P3-3 V5): behind the row's own summary button,
    // opened as a `kit/sheet` drawer instead of always expanded on the card.
    fireEvent.click(within(card).getByTestId('system-access-summary'));
    const drawer = await screen.findByTestId('system-access-drawer');

    // 谁能用: Bob's row shows the unreachable chip and the excluded-by-profile reason text.
    const list = within(drawer).getByTestId('system-access-list');
    await waitFor(() => expect(within(list).getByText('Bob')).toBeTruthy());
    const row = within(list).getByTestId('system-access-row');
    expect(row.textContent).toContain('用不了');
    expect(row.textContent).toContain('取消了勾选');

    // 哪些 Worker 覆盖.
    expect(within(drawer).getByTestId('system-worker-coverage').textContent).toContain(
      'ops-runner',
    );

    // Revoke: Bob's existing grant.
    fireEvent.click(within(row).getByTestId('gatekeeper-revoke-grant-1'));
    const confirm = await screen.findByTestId('gatekeeper-revoke-confirm-grant-1');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'revoke_capability')).toBe(true),
    );

    // Grant: opens the shared drawer locked to this gate.
    fireEvent.click(within(card).getByTestId('gatekeeper-grant-button'));
    const grantDrawer = await screen.findByTestId('grant-gate-drawer');
    const form = within(grantDrawer).getByTestId('grant-gate-form');
    expect(within(form).getByTestId('ggf-locked-gate-chip').textContent).toContain('Docker prod');
  });

  it('R-39: an operator grantee is marked as also an approver, and revoking says the approval right goes too', async () => {
    const http = scriptedHttp({
      execution_readiness: (params) =>
        readiness({
          principalId: (params as { principalId?: string }).principalId ?? 'p-self',
          ready: true,
          gates: [gate()],
        }),
      list_principals: () => ({
        items: [
          principal({ role: 'operator' }),
          principal({ id: 'p-self', displayName: 'Alice', role: 'owner' }),
        ],
      }),
      list_grants: () => ({ items: [grant()] }),
    });
    renderPage(http);

    const card = (await screen.findAllByTestId('gatekeeper-card')).find((el) =>
      el.textContent?.includes('Docker prod'),
    ) as HTMLElement;
    fireEvent.click(within(card).getByTestId('system-access-summary'));
    const drawer = await screen.findByTestId('system-access-drawer');
    expect(within(drawer).getByTestId('system-access-approver-hint').textContent).toContain(
      '所有动作的审批者',
    );

    const list = within(drawer).getByTestId('system-access-list');
    await waitFor(() => expect(within(list).getByText('Bob')).toBeTruthy());
    const row = within(list).getByTestId('system-access-row');
    expect(within(row).getByTestId('system-access-approver-tag').textContent).toContain(
      '也是审批者',
    );

    fireEvent.click(within(row).getByTestId('gatekeeper-revoke-grant-1'));
    const confirm = await screen.findByTestId('gatekeeper-revoke-confirm-grant-1');
    expect(confirm.textContent).toContain('也不再是这个门上动作的审批者');
  });

  it('member view: a 403 on list_grants/list_principals degrades to the caller’s own row, no grant/revoke actions', async () => {
    const http = scriptedHttp({
      get_workspace: () => workspace('member'),
      list_principals: () =>
        Promise.reject(new HttpError('capability_error', 'operator only', 'forbidden')),
      list_grants: () =>
        Promise.reject(new HttpError('capability_error', 'operator only', 'forbidden')),
      execution_readiness: () => readiness({ principalId: 'p-self', ready: true, gates: [gate()] }),
      resolve_refs: () => ({ items: [{ id: 'p-self', kind: 'principal', name: 'Self' }] }),
    });
    renderPage(http);

    const card = (await screen.findAllByTestId('gatekeeper-card')).find((el) =>
      el.textContent?.includes('Docker prod'),
    ) as HTMLElement;
    // Reachability for me renders inline on the row without opening the drawer.
    expect(within(card).getByTestId('gatekeeper-reachability').textContent).toContain('可直接调用');

    fireEvent.click(within(card).getByTestId('system-access-summary'));
    const drawer = await screen.findByTestId('system-access-drawer');
    const list = within(drawer).getByTestId('system-access-list');
    const rows = within(list).getAllByTestId('system-access-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('你');
    expect(rows[0]?.textContent).toContain('可直接调用');

    expect(within(card).queryByTestId('gatekeeper-grant-button')).toBeNull();
    expect(within(drawer).queryByTestId(/^gatekeeper-revoke-/)).toBeNull();
  });

  it('接入向导 opens from the overflow menu (S8 W2-U1 SY3 kept)', async () => {
    const http = scriptedHttp({});
    renderPage(http);
    await screen.findByTestId('systems-empty');
    openConnectMoreMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: /接入向导/ }));
    const drawer = await screen.findByTestId('onboarding-wizard-drawer');
    expect(within(drawer).getByTestId('wizard-step-kind')).toBeTruthy();
  });

  it('bugfix (PR #324 review): an unreachable row keeps the reason as a chip tooltip, not inline text, drops the same-page fix-it link, and the drawer still spells it out with a real (different-page) link', async () => {
    const http = scriptedHttp({
      execution_readiness: () =>
        readiness({
          principalId: 'p-self',
          gates: [
            gate({
              status: 'unreachable',
              reason: 'not_granted',
              excludedByProfile: false,
            }),
          ],
        }),
    });
    renderPage(http);

    const card = (await screen.findAllByTestId('gatekeeper-card')).find((el) =>
      el.textContent?.includes('Docker prod'),
    ) as HTMLElement;
    const chip = within(card).getByTestId('gatekeeper-reachability');
    // The row stays terse: the chip itself carries the reason as a tooltip (`title`), not as
    // visible inline text or a link — `not_granted`'s fix-it link would point back at this exact
    // page anyway (系统与授权 already has the fix — the "授权" button right on this row).
    expect(chip.textContent).toBe('用不了');
    expect(chip.getAttribute('title')).toContain('还没有授权给你');
    expect(within(card).queryByRole('link', { name: /系统与授权/ })).toBeNull();

    fireEvent.click(within(card).getByTestId('system-access-summary'));
    const drawer = await screen.findByTestId('system-access-drawer');
    const detail = within(drawer).getByTestId('system-access-my-reachability');
    expect(detail.textContent).toContain('还没有授权给你');
    // Still no self-page link inside the drawer either — `not_granted`'s only listed fix-it
    // destination is this same page.
    expect(within(detail).queryByRole('link')).toBeNull();
  });

  // R-01 (maintainer decision D-01): a gate the workspace connected itself (no catalog link) gets
  // its own connection secret; the owner issues a new one from the row's menu, shown once.
  it('lets the owner issue a new connection secret for a self-connected gate, and shows it once', async () => {
    const secret = `ntgc1_${'c'.repeat(32)}_${'d'.repeat(64)}`;
    const http = scriptedHttp({
      execution_readiness: () => readiness({ principalId: 'p-self', gates: [gate()] }),
      rotate_connection_secret: (params) => {
        expect(params).toEqual({ gatekeeperId: 'gk-1' });
        return { gatekeeperId: 'gk-1', connectionSecret: secret };
      },
    });
    renderPage(http);
    const card = (await screen.findAllByTestId('gatekeeper-card'))[0] as HTMLElement;
    fireEvent.pointerDown(within(card).getByTestId('gatekeeper-more'), { button: 0 });
    fireEvent.click(await screen.findByTestId('gatekeeper-rotate-secret'));
    const confirm = await screen.findByTestId('gatekeeper-rotate-secret-confirm');
    expect(confirm.textContent).toContain('旧密钥立即失效');
    expect(http.calls.some((c) => c.name === 'rotate_connection_secret')).toBe(false);
    fireEvent.click(within(confirm).getByRole('button', { name: '签发' }));
    const sheet = await screen.findByTestId('gatekeeper-rotated-secret');
    expect(within(sheet).getByTestId('connection-secret-value').textContent).toBe(secret);
    fireEvent.click(within(sheet).getByRole('button', { name: '我已复制' }));
    await waitFor(() => expect(screen.queryByTestId('connection-secret-value')).toBeNull());
  });

  it('offers no connection secret for a gate linked from the platform catalog', async () => {
    const http = scriptedHttp({
      execution_readiness: () => readiness({ principalId: 'p-self', gates: [gate()] }),
      list_available_gate_instances: () => ({
        items: [
          {
            gateId: 'docker',
            displayName: 'Docker',
            connector: 'docker',
            transportKind: 'cli',
            status: 'enabled',
            health: 'ok',
            operationCount: 3,
            gatekeeperId: 'gk-1',
          },
        ],
      }),
    });
    renderPage(http);
    const card = (await screen.findAllByTestId('gatekeeper-card'))[0] as HTMLElement;
    fireEvent.pointerDown(within(card).getByTestId('gatekeeper-more'), { button: 0 });
    expect(await screen.findByText('健康与操作')).toBeTruthy();
    expect(screen.queryByTestId('gatekeeper-rotate-secret')).toBeNull();
  });
});
