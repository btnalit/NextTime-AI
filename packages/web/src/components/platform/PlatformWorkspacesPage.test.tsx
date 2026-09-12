// @vitest-environment jsdom
import type { PlatformWorkspaceWire, UserWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { WireMembership } from '../../lib/auth-api.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
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
  } = {},
) {
  return render(
    <PermissionsProvider>
      <PlatformWorkspacesPage
        http={http}
        memberships={options.memberships ?? []}
        onOpenWorkspaceConfig={options.onOpenWorkspaceConfig ?? vi.fn()}
      />
    </PermissionsProvider>,
  );
}

function workspace(overrides: Partial<PlatformWorkspaceWire> = {}): PlatformWorkspaceWire {
  return {
    id: 'ws-1',
    name: 'Acme',
    status: 'active',
    entryModel: null,
    allowedModels: [],
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

    expect(within(first).getByTestId('workspace-status').textContent).toBe('active');
    expect(within(second).getByTestId('workspace-status').textContent).toBe('disabled');

    // `entryModel: null` reads as the platform default; `allowedModels: []` as "all".
    expect(first.textContent).toContain('平台默认');
    expect(first.textContent).toContain('全部 All');
    expect(second.textContent).toContain('openai/gpt-4o');
    expect(second.textContent).toContain('2 个');

    expect(within(first).getByTestId('workspace-owner-chip').textContent).toBe('alice');
    expect(within(second).queryByTestId('workspace-owner-chip')).toBeNull();

    expect(http.calls.some((call) => call.name === 'list_workspaces')).toBe(true);
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
    expect(within(detail).getByTestId('workspace-detail-status').textContent).toBe('active');
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
      expect(within(detail).getByTestId('workspace-detail-status').textContent).toBe('disabled'),
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
});
