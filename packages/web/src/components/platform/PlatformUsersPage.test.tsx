// @vitest-environment jsdom
import type { PlatformSettingsWire, UserWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { ENV_ADMIN_TITLE } from '../../lib/platform-errors.js';
import { PlatformUsersPage } from './PlatformUsersPage.js';

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

function renderPage(http: CapabilityCaller) {
  return render(
    <PermissionsProvider>
      <PlatformUsersPage http={http} />
    </PermissionsProvider>,
  );
}

function user(overrides: Partial<UserWire> = {}): UserWire {
  return {
    id: 'u-1',
    login: 'alice',
    displayName: 'Alice',
    platformRole: 'user',
    status: 'active',
    hasPassword: true,
    mustChangePassword: false,
    dailyCallLimit: null,
    monthlyTokenBudget: null,
    lastLoginAt: '2026-09-10T00:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
    memberships: [
      {
        workspaceId: 'ws-1',
        workspaceName: 'Acme',
        workspaceStatus: 'active',
        principalId: 'p-1',
        role: 'member',
        disabled: false,
      },
    ],
    ...overrides,
  };
}

function settings(overrides: Partial<PlatformSettingsWire> = {}): PlatformSettingsWire {
  return {
    siteName: 'NextTime',
    announcement: '',
    instanceInstructions: '',
    defaultWorkspaceId: 'ws-1',
    defaultEntryModel: null,
    defaultDailyCallLimit: 100,
    defaultMonthlyTokenBudget: null,
    defaultPlatformRole: 'user',
    passwordMinLength: 12,
    envAdmins: [],
    version: 3,
    updatedAt: '2026-09-09T00:00:00.000Z',
    ...overrides,
  };
}

describe('PlatformUsersPage', () => {
  it('lists users with a derived 待激活 status, workspace chips and the budget default', async () => {
    const http = scriptedHttp({
      list_users: () => ({
        items: [
          user(),
          user({
            id: 'u-2',
            login: 'legacy',
            displayName: 'Legacy key',
            hasPassword: false,
            lastLoginAt: null,
            dailyCallLimit: 20,
            memberships: [
              {
                workspaceId: 'ws-2',
                workspaceName: 'Beta',
                workspaceStatus: 'active',
                principalId: 'p-2',
                role: 'operator',
                disabled: true,
              },
            ],
          }),
        ],
      }),
      get_platform_settings: () => settings(),
    });
    renderPage(http);

    const table = await screen.findByTestId('platform-users-table');
    const rows = within(table).getAllByTestId('platform-user-row');
    expect(rows).toHaveLength(2);

    const statuses = within(table).getAllByTestId('platform-user-status');
    expect(statuses[0]?.textContent).toBe('active');
    expect(statuses[1]?.textContent).toBe('待激活 Pending activation');

    const chips = within(table).getAllByTestId('platform-user-workspace-chip');
    expect(chips[0]?.textContent).toBe('Acme@member');
    expect(chips[1]?.textContent).toBe('Beta@operator');
    // A disabled membership is greyed rather than hidden.
    expect(chips[1]?.className).toContain('chip-neutral');

    // `null` budgets fall back to the platform default, a set one shows the number.
    expect(rows[0]?.textContent).toContain('默认 default');
    expect(rows[1]?.textContent).toContain('20');
    expect(rows[1]?.textContent).toContain('从未 Never');

    expect(http.calls[0]).toEqual({ name: 'list_users', params: { limit: 50 } });
  });

  it('re-queries list_users when the status filter and the search box change', async () => {
    const http = scriptedHttp({
      list_users: () => ({ items: [user()] }),
      get_platform_settings: () => settings(),
    });
    renderPage(http);
    await screen.findByTestId('platform-users-table');

    fireEvent.change(screen.getByLabelText(/状态 Status/), { target: { value: 'disabled' } });
    await waitFor(() =>
      expect(
        http.calls.some(
          (call) =>
            call.name === 'list_users' &&
            (call.params as Record<string, unknown>).status === 'disabled',
        ),
      ).toBe(true),
    );

    fireEvent.change(screen.getByLabelText(/搜索 Search/), { target: { value: ' ali ' } });
    fireEvent.click(screen.getByRole('button', { name: '应用 Apply' }));
    await waitFor(() =>
      expect(
        http.calls.some(
          (call) =>
            call.name === 'list_users' && (call.params as Record<string, unknown>).query === 'ali',
        ),
      ).toBe(true),
    );
  });

  it('create user → the temporary password is shown exactly once, then the list refreshes', async () => {
    let listCalls = 0;
    const created = user({ id: 'u-3', login: 'carol', displayName: 'Carol' });
    const http = scriptedHttp({
      list_users: () => {
        listCalls += 1;
        return { items: listCalls === 1 ? [user()] : [user(), created] };
      },
      get_platform_settings: () => settings(),
      create_user: (params) => {
        expect(params).toEqual({
          login: 'carol',
          displayName: 'Carol',
          platformRole: 'user',
          role: 'member',
        });
        return { user: created, temporaryPassword: 'tmp-once-fixture' };
      },
    });
    renderPage(http);
    await screen.findByTestId('platform-users-table');

    fireEvent.click(screen.getByRole('button', { name: /新建用户 Create user/ }));
    const form = await screen.findByTestId('create-user-form');
    fireEvent.change(within(form).getByLabelText(/登录名 Login/), { target: { value: 'carol' } });
    fireEvent.change(within(form).getByLabelText(/显示名 Display name/), {
      target: { value: 'Carol' },
    });
    fireEvent.click(within(form).getByRole('button', { name: '创建 Create' }));

    const dialog = await screen.findByTestId('temporary-password-dialog');
    expect(within(dialog).getByTestId('temporary-password-value').textContent).toBe(
      'tmp-once-fixture',
    );

    fireEvent.click(within(dialog).getByRole('button', { name: '我已保存 I have saved it' }));
    await waitFor(() => expect(screen.queryByTestId('temporary-password-dialog')).toBeNull());
    // Shown once: the password is nowhere in the DOM after the dialog is acknowledged.
    expect(screen.queryByText('tmp-once-fixture')).toBeNull();
    await waitFor(() => expect(screen.getAllByTestId('platform-user-row')).toHaveLength(2));
  });

  it('rejects a login that does not match the kernel pattern before calling create_user', async () => {
    const http = scriptedHttp({
      list_users: () => ({ items: [user()] }),
      get_platform_settings: () => settings(),
    });
    renderPage(http);
    await screen.findByTestId('platform-users-table');

    fireEvent.click(screen.getByRole('button', { name: /新建用户 Create user/ }));
    const form = await screen.findByTestId('create-user-form');
    fireEvent.change(within(form).getByLabelText(/登录名 Login/), { target: { value: 'Ab' } });
    expect(within(form).getByText(/Invalid login/)).toBeTruthy();
    expect(within(form).getByRole('button', { name: '创建 Create' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(http.calls.some((call) => call.name === 'create_user')).toBe(false);
  });

  it('disabling a user takes a confirm step and calls set_user_status', async () => {
    const alice = user();
    const http = scriptedHttp({
      list_users: () => ({ items: [alice] }),
      get_platform_settings: () => settings(),
      set_user_status: (params) => {
        expect(params).toEqual({ userId: 'u-1', status: 'disabled' });
        return { ...alice, status: 'disabled' };
      },
    });
    renderPage(http);
    await screen.findByTestId('platform-users-table');

    fireEvent.click(screen.getByRole('button', { name: '管理 Manage' }));
    const drawer = await screen.findByTestId('user-detail');

    fireEvent.click(within(drawer).getByRole('button', { name: '停用 Disable' }));
    await within(drawer).findByTestId('user-disable-confirm');
    expect(http.calls.some((call) => call.name === 'set_user_status')).toBe(false);

    fireEvent.click(within(drawer).getByRole('button', { name: '确认停用 Confirm disable' }));
    await waitFor(() =>
      expect(within(drawer).getByTestId('user-detail-status').textContent).toBe('disabled'),
    );
  });

  it('maps a kernel error code to its bilingual message', async () => {
    const admin = user({ platformRole: 'admin' });
    const http = scriptedHttp({
      list_users: () => ({ items: [admin] }),
      get_platform_settings: () => settings(),
      update_user: () =>
        Promise.reject(new HttpError('capability_error', 'last active admin', 'last_admin')),
    });
    renderPage(http);
    await screen.findByTestId('platform-users-table');

    fireEvent.click(screen.getByRole('button', { name: '管理 Manage' }));
    const drawer = await screen.findByTestId('user-detail');
    fireEvent.change(within(drawer).getByLabelText(/平台角色 Platform role/), {
      target: { value: 'user' },
    });
    fireEvent.click(within(drawer).getByRole('button', { name: '保存 Save' }));

    await within(drawer).findByText(/最后一个活跃管理员/);
  });

  it('an environment administrator cannot be disabled or demoted', async () => {
    const root = user({ id: 'u-root', login: 'root', displayName: 'Root', platformRole: 'admin' });
    const http = scriptedHttp({
      list_users: () => ({ items: [root] }),
      get_platform_settings: () => settings({ envAdmins: ['root'] }),
    });
    renderPage(http);
    await screen.findByTestId('platform-users-table');
    expect(screen.getByTestId('platform-user-env-admin').getAttribute('title')).toBe(
      ENV_ADMIN_TITLE,
    );

    fireEvent.click(screen.getByRole('button', { name: '管理 Manage' }));
    const drawer = await screen.findByTestId('user-detail');
    await within(drawer).findByTestId('user-detail-env-admin');

    const disable = within(drawer).getByRole('button', { name: '停用 Disable' });
    expect(disable.hasAttribute('disabled')).toBe(true);
    expect(disable.parentElement?.getAttribute('title')).toBe(ENV_ADMIN_TITLE);

    const roleSelect = within(drawer).getByLabelText(/平台角色 Platform role/);
    expect(roleSelect.hasAttribute('disabled')).toBe(true);
    expect(roleSelect.parentElement?.getAttribute('title')).toBe(ENV_ADMIN_TITLE);
  });

  it('the memberships drawer adds a membership and re-reads the directory', async () => {
    const alice = user();
    const bob = user({
      id: 'u-2',
      login: 'bob',
      displayName: 'Bob',
      memberships: [
        {
          workspaceId: 'ws-2',
          workspaceName: 'Beta',
          workspaceStatus: 'active',
          principalId: 'p-2',
          role: 'member',
          disabled: false,
        },
      ],
    });
    let listCalls = 0;
    const http = scriptedHttp({
      list_users: () => {
        listCalls += 1;
        return { items: [alice, bob] };
      },
      get_platform_settings: () => settings(),
      add_membership: (params) => {
        expect(params).toEqual({ userId: 'u-2', workspaceId: 'ws-1', role: 'operator' });
        return {
          workspaceId: 'ws-1',
          workspaceName: 'Acme',
          workspaceStatus: 'active',
          principalId: 'p-3',
          role: 'operator',
          disabled: false,
        };
      },
    });
    renderPage(http);
    await screen.findByTestId('platform-users-table');

    fireEvent.click(screen.getAllByRole('button', { name: '管理 Manage' })[1] as HTMLElement);
    const detail = await screen.findByTestId('user-detail');
    fireEvent.click(within(detail).getByRole('button', { name: /管理成员资格/ }));

    const memberships = await screen.findByTestId('user-memberships');
    fireEvent.change(within(memberships).getByLabelText(/加入工作区/), {
      target: { value: 'ws-1' },
    });
    // Two "角色 Role" labels are on screen (the existing membership's own role select and the
    // add form's) — name the add form's control by id.
    fireEvent.change(within(memberships).getByLabelText(/^角色 Role/, { selector: '#um-role' }), {
      target: { value: 'operator' },
    });
    fireEvent.click(within(memberships).getByRole('button', { name: '加入 Add' }));

    await waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(2));
    // The drawer survives the re-read: the row is re-derived from the refreshed list, never from
    // a snapshot, and the re-read keeps the cached page on screen while it is in flight.
    expect(screen.getByTestId('user-memberships')).toBeTruthy();
  });
});
