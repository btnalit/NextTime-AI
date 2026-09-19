// @vitest-environment jsdom
import type { PlatformWorkspaceWire, UserWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { WireMembership } from '../../lib/auth-api.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { ToastProvider } from '../ui/Toast.js';
import { PlatformWorkspacesPage } from './PlatformWorkspacesPage.js';

afterEach(cleanup);

/** A `CapabilityCaller` whose named answers are scripted; unscripted names throw loudly instead
 *  of silently resolving `undefined` (the convention every page test in this package uses). */
function scriptedHttp(
  handlers: Record<string, (params: unknown) => unknown | Promise<unknown>>,
): CapabilityCaller & { readonly calls: { readonly name: string; readonly params: unknown }[] } {
  const calls: { name: string; params: unknown }[] = [];
  return {
    calls,
    call: vi.fn(async (name: string, params?: unknown) => {
      calls.push({ name, params });
      const handler = handlers[name];
      if (!handler) throw new Error(`unscripted capability ${name}`);
      return handler(params);
    }) as CapabilityCaller['call'],
  };
}

function renderPage(
  http: CapabilityCaller,
  options: {
    readonly memberships?: readonly WireMembership[];
    readonly onOpenWorkspaceConfig?: (workspaceId: string) => void;
    readonly initialHash?: string;
  } = {},
) {
  return render(
    <PermissionsProvider>
      <ToastProvider>
        <PlatformWorkspacesPage
          http={http}
          memberships={options.memberships ?? []}
          onOpenWorkspaceConfig={options.onOpenWorkspaceConfig ?? vi.fn()}
          initialHash={options.initialHash ?? '#/platform/workspaces'}
        />
      </ToastProvider>
    </PermissionsProvider>,
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

function workspace(overrides: Partial<PlatformWorkspaceWire> = {}): PlatformWorkspaceWire {
  return {
    id: 'ws-1',
    name: 'Acme',
    status: 'active',
    entryModel: null,
    allowedModels: [],
    ontologyEnforcement: 'reject',
    purpose: 'standard',
    expiresAt: null,
    disabledAt: null,
    purgeable: false,
    isDefault: true,
    memberCount: 3,
    owners: [{ userId: 'u-1', login: 'alice', displayName: 'Alice', principalId: 'p-1' }],
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

const MODELS = [
  { id: 'openai/gpt-4o', provider: 'openai', model: 'gpt-4o' },
  { id: 'anthropic/claude-3', provider: 'anthropic', model: 'claude-3' },
];

function user(overrides: Partial<UserWire> = {}): UserWire {
  return {
    id: 'u-2',
    login: 'bob',
    displayName: 'Bob',
    platformRole: 'user',
    status: 'active',
    hasPassword: true,
    mustChangePassword: false,
    dailyCallLimit: null,
    monthlyTokenBudget: null,
    lastLoginAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    memberships: [],
    ...overrides,
  };
}

/** The three reads every drawer-opening test needs: the list, the catalog, and the user directory
 *  the owner pickers mount against. */
function baseHandlers(workspaces: readonly PlatformWorkspaceWire[]) {
  return {
    list_workspaces: () => ({ items: workspaces }),
    list_platform_models: () => ({ items: MODELS }),
    list_users: () => ({ items: [user()] }),
  };
}

describe('PlatformWorkspacesPage', () => {
  it('lists workspaces with the default badge, entry-model fallback and owner logins', async () => {
    const http = scriptedHttp(
      baseHandlers([
        workspace(),
        workspace({
          id: 'ws-2',
          name: 'Beta',
          status: 'disabled',
          entryModel: 'openai/gpt-4o',
          allowedModels: ['openai/gpt-4o', 'anthropic/claude-3'],
          isDefault: false,
          memberCount: 1,
          owners: [],
        }),
      ]),
    );
    renderPage(http);

    const table = await screen.findByTestId('platform-workspaces-table');
    const first = within(table).getByTestId('workspace-row-ws-1');
    const second = within(table).getByTestId('workspace-row-ws-2');

    // The platform default workspace is badged; the other one is not.
    expect(within(first).getByTestId('workspace-default-badge')).toBeTruthy();
    expect(within(second).queryByTestId('workspace-default-badge')).toBeNull();

    // S6-A0 / C17: the row status is the shared workspaceStatus StatusChip (bilingual, raw value on
    // `data-status` for e2e); purpose is a column of its own.
    const firstStatus = within(first).getByTestId('workspace-status');
    expect(firstStatus.textContent).toBe('活跃 Active');
    expect(firstStatus.getAttribute('data-status')).toBe('active');
    expect(within(second).getByTestId('workspace-status').textContent).toBe('已停用 Disabled');
    expect(within(first).getByTestId('workspace-purpose').textContent).toBe('常规 standard');

    // `entryModel: null` reads as the platform default; `allowedModels: []` as "all".
    expect(first.textContent).toContain('平台默认');
    expect(first.textContent).toContain('全部 All');
    expect(second.textContent).toContain('openai/gpt-4o');
    expect(second.textContent).toContain('2 个');

    expect(within(first).getByTestId('workspace-owner-chip').textContent).toBe('alice');
    expect(within(second).queryByTestId('workspace-owner-chip')).toBeNull();

    // A1: the default view asks the kernel to hide disabled and expired ephemeral workspaces.
    expect(http.calls.find((call) => call.name === 'list_workspaces')?.params).toEqual({
      status: 'active',
      includeExpired: false,
    });
    expect(http.calls.some((call) => call.name === 'list_platform_models')).toBe(true);
    // The user directory is only read once a drawer that needs a user picker is open.
    expect(http.calls.some((call) => call.name === 'list_users')).toBe(false);
  });

  it('create workspace → posts name/owner/models, refreshes the list and opens the new row', async () => {
    let listCalls = 0;
    const created = workspace({
      id: 'ws-2',
      name: 'Beta',
      isDefault: false,
      entryModel: 'openai/gpt-4o',
      allowedModels: ['openai/gpt-4o'],
      memberCount: 1,
      owners: [{ userId: 'u-2', login: 'bob', displayName: 'Bob', principalId: 'p-2' }],
    });
    const http = scriptedHttp({
      ...baseHandlers([workspace()]),
      list_workspaces: () => {
        listCalls += 1;
        return { items: listCalls === 1 ? [workspace()] : [workspace(), created] };
      },
      create_workspace: (params) => {
        expect(params).toEqual({
          name: 'Beta',
          ownerUserId: 'u-2',
          entryModel: 'openai/gpt-4o',
          allowedModels: ['openai/gpt-4o'],
        });
        return created;
      },
    });
    renderPage(http);
    await screen.findByTestId('platform-workspaces-table');

    fireEvent.click(screen.getByTestId('new-workspace'));
    const form = await screen.findByTestId('create-workspace-form');
    fireEvent.change(within(form).getByLabelText(/名称 Name/), { target: { value: 'Beta' } });

    // The owner picker reads `list_users` on mount — i.e. only now, not with the page.
    await waitFor(() =>
      expect(
        (within(form).getByTestId('create-workspace-owner') as HTMLSelectElement).disabled,
      ).toBe(false),
    );
    fireEvent.change(within(form).getByTestId('create-workspace-owner'), {
      target: { value: 'u-2' },
    });

    // Ticking an allowed model narrows the entry-model options to it.
    fireEvent.click(within(form).getByLabelText('openai/gpt-4o'));
    fireEvent.change(within(form).getByTestId('workspace-entry-model'), {
      target: { value: 'openai/gpt-4o' },
    });

    fireEvent.click(within(form).getByRole('button', { name: '创建 Create' }));

    // The created row is on screen and its drawer opened on top of it.
    const detail = await screen.findByTestId('workspace-detail');
    // S6-A0 / C17: the detail panel renders status through the shared workspaceStatus StatusChip.
    expect(within(detail).getByTestId('workspace-detail-status').textContent).toBe('活跃 Active');
    await waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(2));
    expect(screen.getByTestId('workspace-row-ws-2')).toBeTruthy();
  });

  it('shows the mapped entry_model_not_allowed message when the allow-list drops the entry model', async () => {
    const acme = workspace({ entryModel: 'openai/gpt-4o', isDefault: false });
    const http = scriptedHttp({
      ...baseHandlers([acme]),
      set_allowed_models: (params) => {
        expect(params).toEqual({
          workspaceId: 'ws-1',
          allowedModels: ['anthropic/claude-3'],
        });
        return Promise.reject(
          new HttpError(
            'capability_error',
            'entry model is not allowed',
            'entry_model_not_allowed',
          ),
        );
      },
    });
    renderPage(http);
    await screen.findByTestId('platform-workspaces-table');

    fireEvent.click(screen.getByTestId('workspace-row-ws-1'));
    const detail = await screen.findByTestId('workspace-detail');

    const checklist = within(detail).getByTestId('workspace-allowed-models');
    fireEvent.click(within(checklist).getByLabelText('anthropic/claude-3'));
    fireEvent.click(
      within(detail).getByRole('button', { name: '保存允许的模型 Save allowed models' }),
    );

    const error = await within(detail).findByTestId('workspace-allowed-models-error');
    expect(error.textContent).toContain('允许的模型列表必须包含入口模型');
    expect(error.getAttribute('data-error-code')).toBe('entry_model_not_allowed');
  });

  it('shows the saved ontology enforcement and switching it posts update_workspace', async () => {
    const acme = workspace({ ontologyEnforcement: 'warn' });
    const http = scriptedHttp({
      ...baseHandlers([acme]),
      update_workspace: (params) => {
        expect(params).toEqual({ workspaceId: 'ws-1', ontologyEnforcement: 'reject' });
        return { ...acme, ontologyEnforcement: 'reject' };
      },
    });
    renderPage(http);
    await screen.findByTestId('platform-workspaces-table');

    fireEvent.click(screen.getByTestId('workspace-row-ws-1'));
    const detail = await screen.findByTestId('workspace-detail');

    const select = within(detail).getByTestId(
      'workspace-ontology-enforcement',
    ) as HTMLSelectElement;
    expect(select.value).toBe('warn');

    fireEvent.change(select, { target: { value: 'reject' } });

    await waitFor(() => expect(select.value).toBe('reject'));
    expect(http.calls.some((call) => call.name === 'update_workspace')).toBe(true);
  });

  it('S5.3: shows the purpose read-only, with the expiry for an ephemeral workspace', async () => {
    const demo = workspace({
      id: 'ws-2',
      name: 'demo',
      isDefault: false,
      purpose: 'ephemeral',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const http = scriptedHttp(baseHandlers([workspace(), demo]));
    renderPage(http);
    await screen.findByTestId('platform-workspaces-table');

    fireEvent.click(screen.getByTestId('workspace-row-ws-2'));
    const detail = await screen.findByTestId('workspace-detail');
    expect(within(detail).getByTestId('workspace-detail-purpose').textContent).toContain(
      'ephemeral',
    );
    expect(within(detail).getByTestId('workspace-expires').textContent).toContain('到期 expires');
    expect(within(detail).queryByTestId('workspace-purpose-select')).toBeNull();
    // Not purgeable (still live) — no purge entry anywhere.
    expect(within(detail).queryByTestId('workspace-purge')).toBeNull();
  });

  it('a failed ontology-enforcement switch rolls back to the saved value and shows the error', async () => {
    const http = scriptedHttp({
      ...baseHandlers([workspace()]),
      update_workspace: () =>
        Promise.reject(new HttpError('capability_error', 'workspace not found', 'not_found')),
    });
    renderPage(http);
    await screen.findByTestId('platform-workspaces-table');

    fireEvent.click(screen.getByTestId('workspace-row-ws-1'));
    const detail = await screen.findByTestId('workspace-detail');

    const select = within(detail).getByTestId(
      'workspace-ontology-enforcement',
    ) as HTMLSelectElement;
    expect(select.value).toBe('reject');

    fireEvent.change(select, { target: { value: 'warn' } });

    await within(detail).findByTestId('workspace-ontology-enforcement-error');
    // Not echoed through local state — the select is bound to the saved `workspace` prop, so a
    // failed write leaves it showing what is actually saved, no separate rollback step needed.
    expect(select.value).toBe('reject');
  });

  it('the platform default workspace cannot be disabled from the page at all', async () => {
    const http = scriptedHttp(baseHandlers([workspace()]));
    renderPage(http);
    await screen.findByTestId('platform-workspaces-table');

    fireEvent.click(screen.getByTestId('workspace-row-ws-1'));
    const detail = await screen.findByTestId('workspace-detail');

    const toggle = within(detail).getByTestId('workspace-status-toggle');
    expect(toggle.textContent).toContain('停用 Disable');
    expect(toggle.hasAttribute('disabled')).toBe(true);
    expect(within(detail).getByTestId('workspace-default-undisablable')).toBeTruthy();

    fireEvent.click(toggle);
    expect(within(detail).queryByTestId('workspace-disable-confirm')).toBeNull();
    expect(http.calls.some((call) => call.name === 'set_workspace_status')).toBe(false);
  });

  it('a non-default workspace takes a confirm step before set_workspace_status', async () => {
    const beta = workspace({ id: 'ws-2', name: 'Beta', isDefault: false });
    const http = scriptedHttp({
      ...baseHandlers([beta]),
      set_workspace_status: (params) => {
        expect(params).toEqual({ workspaceId: 'ws-2', status: 'disabled' });
        return { ...beta, status: 'disabled' };
      },
    });
    renderPage(http);
    await screen.findByTestId('platform-workspaces-table');

    fireEvent.click(screen.getByTestId('workspace-row-ws-2'));
    const detail = await screen.findByTestId('workspace-detail');

    fireEvent.click(within(detail).getByTestId('workspace-status-toggle'));
    const confirm = await within(detail).findByTestId('workspace-disable-confirm');
    expect(confirm.textContent).toContain('该工作区所有会话立即失效');
    expect(http.calls.some((call) => call.name === 'set_workspace_status')).toBe(false);

    fireEvent.click(within(detail).getByRole('button', { name: '确认停用 Confirm disable' }));
    await waitFor(() =>
      expect(within(detail).getByTestId('workspace-detail-status').textContent).toBe(
        '已停用 Disabled',
      ),
    );
  });

  it('delegating an owner posts add_membership with role owner and re-reads the list', async () => {
    let listCalls = 0;
    const beta = workspace({ id: 'ws-2', name: 'Beta', isDefault: false, owners: [] });
    const http = scriptedHttp({
      ...baseHandlers([beta]),
      list_workspaces: () => {
        listCalls += 1;
        return { items: [beta] };
      },
      add_membership: (params) => {
        expect(params).toEqual({ userId: 'u-2', workspaceId: 'ws-2', role: 'owner' });
        return {
          workspaceId: 'ws-2',
          workspaceName: 'Beta',
          workspaceStatus: 'active',
          principalId: 'p-9',
          role: 'owner',
          disabled: false,
        };
      },
    });
    renderPage(http);
    await screen.findByTestId('platform-workspaces-table');

    fireEvent.click(screen.getByTestId('workspace-row-ws-2'));
    const detail = await screen.findByTestId('workspace-detail');

    await waitFor(() =>
      expect((within(detail).getByTestId('delegate-owner') as HTMLSelectElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.change(within(detail).getByTestId('delegate-owner'), { target: { value: 'u-2' } });
    fireEvent.click(within(detail).getByRole('button', { name: '委托 Delegate' }));

    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'add_membership')).toBe(true),
    );
    await waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(2));
  });

  it('an already-a-member user is promoted in place: add_membership 409 → set_membership_role', async () => {
    const beta = workspace({ id: 'ws-2', name: 'Beta', isDefault: false, owners: [] });
    const http = scriptedHttp({
      ...baseHandlers([beta]),
      add_membership: () =>
        Promise.reject(new HttpError('capability_error', 'already a member', 'already_member')),
      set_membership_role: (params) => {
        expect(params).toEqual({ userId: 'u-2', workspaceId: 'ws-2', role: 'owner' });
        return {
          workspaceId: 'ws-2',
          workspaceName: 'Beta',
          workspaceStatus: 'active',
          principalId: 'p-9',
          role: 'owner',
          disabled: false,
        };
      },
    });
    renderPage(http);
    await screen.findByTestId('platform-workspaces-table');

    fireEvent.click(screen.getByTestId('workspace-row-ws-2'));
    const detail = await screen.findByTestId('workspace-detail');

    await waitFor(() =>
      expect((within(detail).getByTestId('delegate-owner') as HTMLSelectElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.change(within(detail).getByTestId('delegate-owner'), { target: { value: 'u-2' } });
    fireEvent.click(within(detail).getByRole('button', { name: '委托 Delegate' }));

    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'set_membership_role')).toBe(true),
    );
    // The 409 is handled, not shown — the administrator asked for an owner and got one.
    expect(within(detail).queryByText(/已经是该工作区的成员/)).toBeNull();
  });

  it('offers the workspace-config switch only for a workspace the administrator is in', async () => {
    const onOpenWorkspaceConfig = vi.fn();
    const http = scriptedHttp(
      baseHandlers([workspace(), workspace({ id: 'ws-2', name: 'Beta', isDefault: false })]),
    );
    renderPage(http, {
      memberships: [
        { workspaceId: 'ws-1', workspaceName: 'Acme', principalId: 'p-1', role: 'owner' },
      ],
      onOpenWorkspaceConfig,
    });
    await screen.findByTestId('platform-workspaces-table');

    // Not a member of Beta — the hint, no switch.
    fireEvent.click(screen.getByTestId('workspace-row-ws-2'));
    let detail = await screen.findByTestId('workspace-detail');
    expect(within(detail).getByTestId('workspace-no-membership').textContent).toContain(
      '把自己加为 owner 后即可进入该工作区的配置页',
    );
    expect(within(detail).queryByTestId('open-workspace-config')).toBeNull();
    // The close button is the Drawer's own header control, outside the panel body.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByTestId('workspace-detail')).toBeNull());

    // A member of Acme — the switch, which hands the workspace id back to App.
    fireEvent.click(screen.getByTestId('workspace-row-ws-1'));
    detail = await screen.findByTestId('workspace-detail');
    fireEvent.click(within(detail).getByTestId('open-workspace-config'));
    expect(onOpenWorkspaceConfig).toHaveBeenCalledWith('ws-1');
  });

  it('A1: the filter controls re-query list_workspaces; residue-only reads everything and narrows client-side', async () => {
    const now = Date.now();
    const live = workspace({ id: 'ws-1', name: 'Acme', isDefault: false });
    const disabled = workspace({
      id: 'ws-2',
      name: 'Old',
      status: 'disabled',
      isDefault: false,
      disabledAt: new Date(now - 10 * DAY_MS).toISOString(),
      purgeable: true,
    });
    const expired = workspace({
      id: 'ws-3',
      name: 'accept-s3',
      isDefault: false,
      purpose: 'ephemeral',
      expiresAt: new Date(now - DAY_MS).toISOString(),
      purgeable: true,
    });
    const http = scriptedHttp({
      ...baseHandlers([live]),
      // Mirrors the kernel's own semantics for the three filters over a fixed fixture.
      list_workspaces: (params) => {
        const p = params as Record<string, unknown>;
        return {
          items: [live, disabled, expired].filter(
            (row) =>
              (p.status === undefined || row.status === p.status) &&
              (p.purpose === undefined || row.purpose === p.purpose) &&
              (p.includeExpired !== false || row.id !== 'ws-3'),
          ),
        };
      },
    });
    renderPage(http);
    await screen.findByTestId('workspace-row-ws-1');
    expect(screen.queryByTestId('workspace-row-ws-2')).toBeNull();

    fireEvent.change(screen.getByLabelText(/状态 Status/), { target: { value: 'disabled' } });
    await screen.findByTestId('workspace-row-ws-2');
    expect(http.calls.at(-1)?.params).toEqual({ status: 'disabled', includeExpired: false });
    // 禁用于 … · 可清除: disabled 10 days ago, past the 7-day retention.
    expect(screen.getByTestId('workspace-disabled-at').textContent).toContain(
      '可清除 purgeable now',
    );

    fireEvent.change(screen.getByLabelText(/状态 Status/), { target: { value: 'all' } });
    fireEvent.change(screen.getByLabelText(/用途 Purpose/), { target: { value: 'ephemeral' } });
    fireEvent.click(screen.getByTestId('platform-workspaces-include-expired'));
    await screen.findByTestId('workspace-row-ws-3');
    expect(http.calls.at(-1)?.params).toEqual({ purpose: 'ephemeral' });
    expect(screen.getByTestId('workspace-expires').getAttribute('data-expired')).toBe('true');

    // Residue only: `{}` to the kernel, disabled ∪ expired on screen, the live row dropped.
    fireEvent.click(screen.getByTestId('platform-workspaces-residue-only'));
    await screen.findByTestId('workspace-row-ws-2');
    expect(http.calls.at(-1)?.params).toEqual({});
    expect(screen.getByTestId('workspace-row-ws-3')).toBeTruthy();
    expect(screen.queryByTestId('workspace-row-ws-1')).toBeNull();
  });

  it('A1: the overview banner hash (?residue=1) preselects the residue view', async () => {
    const disabled = workspace({
      id: 'ws-2',
      name: 'Old',
      status: 'disabled',
      isDefault: false,
      disabledAt: null,
      purgeable: true,
    });
    const http = scriptedHttp({
      ...baseHandlers([]),
      list_workspaces: (params) => {
        expect(params).toEqual({});
        return { items: [workspace(), disabled] };
      },
    });
    renderPage(http, { initialHash: '#/platform/workspaces?residue=1' });
    await screen.findByTestId('workspace-row-ws-2');
    expect(screen.queryByTestId('workspace-row-ws-1')).toBeNull();
    expect(
      (screen.getByTestId('platform-workspaces-residue-only') as HTMLInputElement).checked,
    ).toBe(true);
    // disabledAt null (pre-0030) reads as purgeable now.
    expect(screen.getByTestId('workspace-disabled-at').textContent).toContain(
      '可清除 purgeable now',
    );
  });

  it('A1: a disabled workspace inside retention shows the days left and no purge entry', async () => {
    const recent = workspace({
      id: 'ws-2',
      name: 'Recent',
      status: 'disabled',
      isDefault: false,
      disabledAt: new Date(Date.now() - 2 * DAY_MS).toISOString(),
      purgeable: false,
    });
    const http = scriptedHttp(baseHandlers([recent]));
    renderPage(http);
    const row = await screen.findByTestId('workspace-row-ws-2');
    expect(within(row).getByTestId('workspace-disabled-at').textContent).toContain(
      '5 天后可清除 purgeable in 5 d',
    );
    expect(within(row).queryByTestId('workspace-purge')).toBeNull();

    fireEvent.click(row);
    const detail = await screen.findByTestId('workspace-detail');
    expect(within(detail).queryByTestId('workspace-purge')).toBeNull();
    expect(within(detail).getByTestId('workspace-purge-retention')).toBeTruthy();
  });

  it('A1: the platform default workspace never offers purge, even if the kernel flags it purgeable', async () => {
    const http = scriptedHttp(baseHandlers([workspace({ purgeable: true })]));
    renderPage(http);
    const row = await screen.findByTestId('workspace-row-ws-1');
    expect(within(row).queryByTestId('workspace-purge')).toBeNull();
    fireEvent.click(row);
    const detail = await screen.findByTestId('workspace-detail');
    expect(within(detail).queryByTestId('workspace-purge')).toBeNull();
  });

  it('A1: purge — preview (dry run) with counts and the service-Handle warning, then the irreversible confirm executes and removes the row', async () => {
    const old = workspace({
      id: 'ws-2',
      name: 'accept-s3-old',
      status: 'disabled',
      isDefault: false,
      disabledAt: null,
      purgeable: true,
      owners: [],
    });
    const preview = {
      workspaceId: 'ws-2',
      name: 'accept-s3-old',
      purpose: 'standard',
      status: 'disabled',
      reason: 'disabled_retention_elapsed',
      executed: false,
      counts: { capabilityHandles: 2, facts: 40, principals: 3 },
      totalRows: 45,
      activeHandles: 1,
      warnings: [
        {
          kind: 'service_handle_in_use',
          principalId: 'p-collector',
          name: 'collector',
          activeHandles: 1,
        },
      ],
      purgedUsers: [{ id: 'u-9', login: 'alice-s3' }],
      principalIds: ['p-collector', 'p-a', 'p-b'],
      taskIds: ['t-1'],
    };
    const http = scriptedHttp({
      ...baseHandlers([workspace(), old]),
      purge_workspace: (params) => {
        const p = params as Record<string, unknown>;
        expect(p.workspaceId).toBe('ws-2');
        return p.confirm === true ? { ...preview, executed: true } : preview;
      },
    });
    renderPage(http);
    const row = await screen.findByTestId('workspace-row-ws-2');

    // The row's own purge button opens the purge drawer, not the detail drawer.
    fireEvent.click(within(row).getByTestId('workspace-purge'));
    const drawer = await screen.findByTestId('purge-workspace-drawer');
    expect(screen.queryByTestId('workspace-detail')).toBeNull();

    // Step 1: the dry run — sent without `confirm`.
    const previewCalls = () => http.calls.filter((call) => call.name === 'purge_workspace');
    await waitFor(() => expect(previewCalls()).toHaveLength(1));
    expect(previewCalls()[0]?.params).toEqual({ workspaceId: 'ws-2' });

    const warning = await within(drawer).findByTestId('purge-warning-service-handle');
    expect(warning.textContent).toContain('service Handle 仍在使用');
    expect(within(warning).getByTestId('purge-warning-principal').textContent).toContain(
      'collector',
    );
    expect(within(drawer).getByTestId('purge-preview-reason').textContent).toContain(
      '已停用满 7 天',
    );
    expect(within(drawer).getByTestId('purge-preview-total').textContent).toBe('45');
    const counts = within(drawer).getByTestId('purge-preview-counts');
    expect(counts.querySelector('[data-purge-table="facts"]')?.textContent).toContain('40');
    expect(within(drawer).getByTestId('purge-preview-users').textContent).toContain('alice-s3');
    expect(within(drawer).getByTestId('purge-preview-host-side').textContent).toContain('3');

    // Step 2: irreversible — type the name + acknowledge before the danger button enables.
    fireEvent.click(within(drawer).getByTestId('purge-workspace-continue'));
    const confirm = await screen.findByTestId('purge-workspace-confirm');
    expect(screen.queryByTestId('purge-workspace-drawer')).toBeNull();
    expect(within(confirm).getByTestId('confirm-target').textContent).toBe('accept-s3-old');
    expect(within(confirm).getByTestId('confirm-impact').textContent).toContain('45 行数据');
    expect(within(confirm).getByTestId('confirm-impact').textContent).toContain('collector');
    const button = within(confirm).getByTestId('confirm-button');
    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.change(within(confirm).getByTestId('confirm-typed-name'), {
      target: { value: 'accept-s3-old' },
    });
    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.click(within(confirm).getByTestId('confirm-acknowledge'));
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(previewCalls()).toHaveLength(1);

    fireEvent.click(button);
    await waitFor(() => expect(previewCalls()).toHaveLength(2));
    expect(previewCalls()[1]?.params).toEqual({ workspaceId: 'ws-2', confirm: true });

    // Executed: the row is gone (mutated, no re-read), every drawer closed, a toast with counts.
    await waitFor(() => expect(screen.queryByTestId('workspace-row-ws-2')).toBeNull());
    expect(screen.queryByTestId('purge-workspace-confirm')).toBeNull();
    expect(screen.queryByTestId('purge-workspace-drawer')).toBeNull();
    expect(screen.getByTestId('workspace-row-ws-1')).toBeTruthy();
    const toast = await screen.findByTestId('toast');
    expect(toast.textContent).toContain('accept-s3-old');
    expect(toast.textContent).toContain('45 行');
    expect(http.calls.filter((call) => call.name === 'list_workspaces')).toHaveLength(1);
  });

  it('A1: cancelling the irreversible step returns to the preview; the detail panel offers the same entry', async () => {
    const old = workspace({
      id: 'ws-2',
      name: 'Old',
      status: 'disabled',
      isDefault: false,
      disabledAt: null,
      purgeable: true,
    });
    const http = scriptedHttp({
      ...baseHandlers([old]),
      purge_workspace: () => ({
        workspaceId: 'ws-2',
        name: 'Old',
        purpose: 'standard',
        status: 'disabled',
        reason: 'disabled_retention_elapsed',
        executed: false,
        counts: {},
        totalRows: 0,
        activeHandles: 0,
        warnings: [],
        purgedUsers: [],
        principalIds: [],
        taskIds: [],
      }),
    });
    renderPage(http);
    fireEvent.click(await screen.findByTestId('workspace-row-ws-2'));
    const detail = await screen.findByTestId('workspace-detail');
    fireEvent.click(within(detail).getByTestId('workspace-purge'));
    const drawer = await screen.findByTestId('purge-workspace-drawer');
    await within(drawer).findByTestId('purge-preview-reason');
    expect(within(drawer).queryByTestId('purge-warning-service-handle')).toBeNull();

    fireEvent.click(within(drawer).getByTestId('purge-workspace-continue'));
    const confirm = await screen.findByTestId('purge-workspace-confirm');
    fireEvent.click(within(confirm).getByTestId('confirm-cancel'));
    await screen.findByTestId('purge-workspace-drawer');
    expect(screen.queryByTestId('purge-workspace-confirm')).toBeNull();

    // Cancelling the preview goes back to the detail drawer; nothing was deleted.
    fireEvent.click(screen.getByTestId('purge-workspace-cancel'));
    await screen.findByTestId('workspace-detail');
    expect(
      http.calls.filter(
        (call) => call.name === 'purge_workspace' && (call.params as { confirm?: boolean }).confirm,
      ),
    ).toHaveLength(0);
  });

  it('A1: the purge 409s render as the mapped bilingual copy — on the preview and on the confirm', async () => {
    const old = workspace({
      id: 'ws-2',
      name: 'Old',
      status: 'disabled',
      isDefault: false,
      purgeable: true,
      disabledAt: null,
    });
    let previewCalls = 0;
    const http = scriptedHttp({
      ...baseHandlers([old]),
      purge_workspace: (params) => {
        const p = params as Record<string, unknown>;
        if (p.confirm === true) {
          return Promise.reject(
            new HttpError('capability_error', 'the workspace is active', 'workspace_active'),
          );
        }
        previewCalls += 1;
        if (previewCalls === 1) {
          return Promise.reject(
            new HttpError(
              'capability_error',
              'the workspace was disabled on … and becomes purgeable on …',
              'retention_not_elapsed',
            ),
          );
        }
        return {
          workspaceId: 'ws-2',
          name: 'Old',
          purpose: 'standard',
          status: 'disabled',
          reason: 'disabled_retention_elapsed',
          executed: false,
          counts: {},
          totalRows: 0,
          activeHandles: 0,
          warnings: [],
          purgedUsers: [],
          principalIds: [],
          taskIds: [],
        };
      },
    });
    renderPage(http);
    const row = await screen.findByTestId('workspace-row-ws-2');
    fireEvent.click(within(row).getByTestId('workspace-purge'));
    const drawer = await screen.findByTestId('purge-workspace-drawer');
    const error = await within(drawer).findByTestId('purge-preview-error');
    expect(error.textContent).toContain('停用未满 7 天');
    expect(error.getAttribute('data-error-code')).toBe('retention_not_elapsed');
    expect(within(drawer).getByTestId('purge-workspace-continue').hasAttribute('disabled')).toBe(
      true,
    );

    // Reopen (the drawer remounts and previews again), then fail the execute step.
    fireEvent.click(within(drawer).getByTestId('purge-workspace-cancel'));
    const detail = await screen.findByTestId('workspace-detail');
    fireEvent.click(within(detail).getByTestId('workspace-purge'));
    const reopened = await screen.findByTestId('purge-workspace-drawer');
    await within(reopened).findByTestId('purge-preview-reason');
    fireEvent.click(within(reopened).getByTestId('purge-workspace-continue'));
    const confirm = await screen.findByTestId('purge-workspace-confirm');
    fireEvent.change(within(confirm).getByTestId('confirm-typed-name'), {
      target: { value: 'Old' },
    });
    fireEvent.click(within(confirm).getByTestId('confirm-acknowledge'));
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    const confirmError = await within(confirm).findByTestId('confirm-error');
    expect(confirmError.textContent).toContain('该工作区仍在启用中');
    expect(confirmError.getAttribute('data-error-code')).toBe('workspace_active');
    // Still on the confirm, nothing removed.
    expect(screen.getByTestId('workspace-row-ws-2')).toBeTruthy();
  });
});
