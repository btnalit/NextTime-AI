// @vitest-environment jsdom
import type { UserWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { envAdminTitle } from '../../lib/platform-errors.js';
import { UserDetailPanel } from './UserDetailPanel.js';

afterEach(cleanup);

/** `UserDetailPanel` renders under the default `LangProvider` context (zh-CN) in this file's
 *  `renderPanel` — `envAdminTitle`'s zh half is what the DOM carries. */
const ENV_ADMIN_TITLE = envAdminTitle((zh) => zh);

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
    monthlyTokenBudget: 5000,
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

function renderPanel(
  http: CapabilityCaller,
  row: UserWire,
  overrides: Partial<Parameters<typeof UserDetailPanel>[0]> = {},
) {
  const onChanged = vi.fn();
  const onMerged = vi.fn();
  const onTemporaryPassword = vi.fn();
  const onOpenMemberships = vi.fn();
  const utils = render(
    <UserDetailPanel
      http={http}
      user={row}
      users={[row, user({ id: 'u-2', login: 'bob', displayName: 'Bob' })]}
      envAdmins={[]}
      onChanged={onChanged}
      onMerged={onMerged}
      onTemporaryPassword={onTemporaryPassword}
      onOpenMemberships={onOpenMemberships}
      {...overrides}
    />,
  );
  return { ...utils, onChanged, onMerged, onTemporaryPassword, onOpenMemberships };
}

/** C22 (docs/console-completion-plan.md §2b): the user drawer body on its own. */
describe('UserDetailPanel', () => {
  it('renders login, id, the derived status chip, budgets and the memberships entry', () => {
    const http = scriptedHttp({});
    const { onOpenMemberships } = renderPanel(http, user());
    const detail = screen.getByTestId('user-detail');
    expect(within(detail).getByText('alice')).toBeTruthy();
    expect(within(detail).getByTestId('user-detail-status').textContent).toBe('活跃');
    expect((screen.getByLabelText(/每日调用上限/) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(/每月 token 预算/) as HTMLInputElement).value).toBe('5000');
    fireEvent.click(screen.getByRole('button', { name: /管理成员资格 \(1\)/ }));
    expect(onOpenMemberships).toHaveBeenCalledTimes(1);
    // A user with a password has no merge section.
    expect(screen.queryByLabelText(/合并到/)).toBeNull();
  });

  it('profile: only the changed fields go to update_user', async () => {
    const row = user();
    const http = scriptedHttp({
      update_user: (params) => {
        expect(params).toEqual({ userId: 'u-1', platformRole: 'admin' });
        return { ...row, platformRole: 'admin' };
      },
    });
    const { onChanged } = renderPanel(http, row);
    const save = screen.getByRole('button', { name: '保存' });
    expect(save.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText(/平台角色/), {
      target: { value: 'admin' },
    });
    fireEvent.click(save);
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith({ ...row, platformRole: 'admin' }));
  });

  it('budget: validates non-negative integers, empty = inherit (null), then set_user_budget', async () => {
    const row = user();
    const http = scriptedHttp({
      set_user_budget: (params) => {
        expect(params).toEqual({ userId: 'u-1', dailyCallLimit: 20, monthlyTokenBudget: null });
        return { ...row, dailyCallLimit: 20, monthlyTokenBudget: null };
      },
    });
    const { onChanged } = renderPanel(http, row);
    const save = screen.getByRole('button', { name: '保存预算' });
    fireEvent.change(screen.getByLabelText(/每日调用上限/), { target: { value: '-1' } });
    expect(screen.getByText(/必须是非负整数/)).toBeTruthy();
    expect(save.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText(/每日调用上限/), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText(/每月 token 预算/), { target: { value: '' } });
    expect(save.hasAttribute('disabled')).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('reset password: posts reset_user_password (custom password only when typed) and hands the secret up', async () => {
    const http = scriptedHttp({
      reset_user_password: (params) => {
        expect(params).toEqual({ userId: 'u-1', password: 'chosen-by-admin-1' });
        return { userId: 'u-1', temporaryPassword: 'chosen-by-admin-1' };
      },
    });
    const { onTemporaryPassword } = renderPanel(http, user());
    fireEvent.change(screen.getByLabelText(/重置密码/), {
      target: { value: 'chosen-by-admin-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: '重置密码' }));
    await waitFor(() =>
      expect(onTemporaryPassword).toHaveBeenCalledWith('alice', 'chosen-by-admin-1'),
    );
    // Cleared after the reset so it is never re-submitted by accident.
    expect((screen.getByLabelText(/重置密码/) as HTMLInputElement).value).toBe('');
  });

  it('disable: a confirm step, then set_user_status; enable acts directly', async () => {
    const row = user();
    const http = scriptedHttp({
      set_user_status: (params) => ({
        ...row,
        status: (params as { status: 'active' | 'disabled' }).status,
      }),
    });
    const { onChanged, unmount } = renderPanel(http, row);
    fireEvent.click(screen.getByRole('button', { name: '停用' }));
    expect(screen.getByTestId('user-disable-confirm')).toBeTruthy();
    expect(http.calls).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByTestId('user-disable-confirm')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '停用' }));
    fireEvent.click(screen.getByRole('button', { name: '确认停用' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith({ ...row, status: 'disabled' }));
    unmount();

    const enabled = renderPanel(http, { ...row, status: 'disabled' });
    fireEvent.click(screen.getByRole('button', { name: '启用' }));
    await waitFor(() =>
      expect(enabled.onChanged).toHaveBeenCalledWith({ ...row, status: 'active' }),
    );
  });

  it('C10: self_disable renders the mapped copy with the kernel message as its detail line', async () => {
    const http = scriptedHttp({
      set_user_status: () =>
        Promise.reject(
          new HttpError('capability_error', 'you cannot disable your own account', 'self_disable'),
        ),
    });
    renderPanel(http, user());
    fireEvent.click(screen.getByRole('button', { name: '停用' }));
    fireEvent.click(screen.getByRole('button', { name: '确认停用' }));
    const error = await screen.findByText(/不能停用自己/);
    const box = error.closest('[data-error-code]');
    expect(box?.getAttribute('data-error-code')).toBe('self_disable');
    expect(box?.textContent).toContain('you cannot disable your own account');
  });

  it('an environment administrator: warning notice, role select and disable button locked', () => {
    const http = scriptedHttp({});
    renderPanel(http, user({ login: 'root', platformRole: 'admin' }), { envAdmins: ['root'] });
    expect(screen.getByTestId('user-detail-env-admin')).toBeTruthy();
    const role = screen.getByLabelText(/平台角色/);
    expect(role.hasAttribute('disabled')).toBe(true);
    expect(role.parentElement?.getAttribute('title')).toBe(ENV_ADMIN_TITLE);
    expect(screen.getByRole('button', { name: '停用' }).hasAttribute('disabled')).toBe(true);
  });

  it('a pending (password-less) user can be merged into another account after a confirm', async () => {
    const http = scriptedHttp({
      merge_user: (params) => {
        expect(params).toEqual({ sourceUserId: 'u-1', targetUserId: 'u-2' });
        return user({ id: 'u-2' });
      },
    });
    const { onMerged } = renderPanel(http, user({ hasPassword: false }));
    expect(screen.getByTestId('user-detail-status').textContent).toBe('待激活');
    const merge = screen.getByRole('button', { name: '合并' });
    expect(merge.hasAttribute('disabled')).toBe(true);
    const target = screen.getByLabelText(/合并到/) as HTMLSelectElement;
    // The source itself is never offered as a target.
    expect(Array.from(target.options).map((option) => option.value)).toEqual(['', 'u-2']);
    fireEvent.change(target, { target: { value: 'u-2' } });
    fireEvent.click(merge);
    expect(screen.getByTestId('user-merge-confirm')).toBeTruthy();
    expect(http.calls).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '确认合并' }));
    await waitFor(() => expect(onMerged).toHaveBeenCalledTimes(1));
  });
});
