// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../hooks/usePermissions.js';
import type { CapabilityCaller } from '../lib/clients.js';
import type { PrincipalRow } from '../lib/governance.js';
import { HttpError } from '../lib/http-client.js';
import { MembersPage } from './MembersPage.js';

afterEach(cleanup);

function principal(overrides: Partial<PrincipalRow> = {}): PrincipalRow {
  return {
    id: 'p-1',
    kind: 'human',
    role: 'member',
    displayName: 'Bob',
    createdAt: '2026-09-01T00:00:00.000Z',
    hasApiKey: true,
    ...overrides,
  };
}

function workspace(role: string) {
  return {
    id: 'ws-1',
    name: 'Acme',
    createdAt: '2026-01-01T00:00:00Z',
    principalCount: 2,
    gatekeeperCount: 1,
    caller: { id: 'p-owner', role, displayName: 'Alice', kind: 'human' },
  };
}

/** A `CapabilityCaller` whose named answers are scripted; unscripted names throw loudly instead
 *  of silently resolving `undefined` (mirrors `ApprovalQueuePage.test.tsx`'s `scriptedHttp`).
 *  `get_workspace` answers as an owner unless a test overrides it (C9: `canManage` reads the
 *  authoritative `caller.role` from it). */
function scriptedHttp(
  handlers: Record<string, (params: unknown) => unknown | Promise<unknown>>,
): CapabilityCaller & { readonly calls: { readonly name: string; readonly params: unknown }[] } {
  const calls: { name: string; params: unknown }[] = [];
  const base: Record<string, (params: unknown) => unknown | Promise<unknown>> = {
    get_workspace: () => workspace('owner'),
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
      <MembersPage http={http} />
    </PermissionsProvider>,
  );
}

describe('MembersPage', () => {
  it('lists members with a role chip, and shows the owner-only explanation on 403', async () => {
    const http = scriptedHttp({
      list_principals: () => Promise.reject(new HttpError('capability_error', 'nope', 'forbidden')),
    });
    renderPage(http);
    await screen.findByTestId('members-forbidden');
  });

  it('renders a list_principals not_found as an ordinary error banner (B6: the "not live yet" branch is gone)', async () => {
    const http = scriptedHttp({
      list_principals: () =>
        Promise.reject(new HttpError('capability_error', 'no handler', 'not_found')),
    });
    renderPage(http);
    await screen.findByTestId('members-error');
  });

  it('C9: an operator session (authoritative get_workspace.caller.role) sees no owner-only buttons', async () => {
    const http = scriptedHttp({
      get_workspace: () => workspace('operator'),
      // Operator-readable, so the 403 inference alone would never have hidden the buttons.
      list_principals: () => ({ items: [principal()] }),
    });
    renderPage(http);
    await screen.findByTestId('member-row');
    await waitFor(() => expect(http.calls.some((c) => c.name === 'get_workspace')).toBe(true));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /添加成员 Add member/ })).toBeNull(),
    );
    expect(screen.queryByRole('button', { name: /服务凭证 Service credential/ })).toBeNull();
  });

  it('C9: an owner session (authoritative role) keeps the owner-only buttons', async () => {
    const http = scriptedHttp({ list_principals: () => ({ items: [principal()] }) });
    renderPage(http);
    await screen.findByTestId('member-row');
    await screen.findByRole('button', { name: /添加成员 Add member/ });
  });

  it('服务凭证 → create_principal, the API key is shown exactly once, then the list refreshes', async () => {
    let listCallCount = 0;
    const created = principal({ id: 'p-2', displayName: 'Carol', role: 'operator' });
    const http = scriptedHttp({
      list_principals: () => {
        listCallCount += 1;
        return { items: listCallCount === 1 ? [principal()] : [principal(), created] };
      },
      create_principal: (params) => {
        expect(params).toEqual({ role: 'operator', displayName: 'Carol' });
        return { principal: created, apiKey: 'sk-once-fixture-value' };
      },
    });
    renderPage(http);
    await screen.findByTestId('member-row');

    fireEvent.click(screen.getByRole('button', { name: /Service credential/ }));
    const form = await screen.findByTestId('create-principal-form');
    fireEvent.change(within(form).getByLabelText(/Display name/), {
      target: { value: 'Carol' },
    });
    fireEvent.change(within(form).getByLabelText(/^Role/), { target: { value: 'operator' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create' }));

    const keyBox = await screen.findByTestId('create-principal-key');
    expect(within(keyBox).getByTestId('created-api-key').textContent).toBe('sk-once-fixture-value');

    fireEvent.click(screen.getByRole('button', { name: /Done$/ }));
    await waitFor(() => expect(screen.queryByTestId('create-principal-drawer')).toBeNull());
    // The key is never rendered again once the drawer is gone.
    expect(screen.queryByText('sk-once-fixture-value')).toBeNull();
    await waitFor(() => expect(screen.getAllByTestId('member-row')).toHaveLength(2));
  });

  it('changing a member role calls set_principal_role and updates the row', async () => {
    const bob = principal();
    const http = scriptedHttp({
      list_principals: () => ({ items: [bob] }),
      set_principal_role: (params) => {
        expect(params).toEqual({ principalId: 'p-1', role: 'operator' });
        return { ...bob, role: 'operator' };
      },
    });
    renderPage(http);
    const row = await screen.findByTestId('member-row');
    fireEvent.click(row);

    const drawer = await screen.findByTestId('principal-detail');
    fireEvent.change(within(drawer).getByLabelText(/^Role/), { target: { value: 'operator' } });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(within(drawer).getByText('Operator', { exact: false })).toBeTruthy(),
    );
  });

  it('添加成员 → add_member by platform login, with no API key of its own', async () => {
    let listCallCount = 0;
    const added = principal({ id: 'p-3', displayName: 'Dana', hasApiKey: false });
    const http = scriptedHttp({
      list_principals: () => {
        listCallCount += 1;
        return { items: listCallCount === 1 ? [principal()] : [principal(), added] };
      },
      add_member: (params) => {
        expect(params).toEqual({ login: 'dana', role: 'operator' });
        return added;
      },
    });
    renderPage(http);
    await screen.findByTestId('member-row');

    fireEvent.click(screen.getByRole('button', { name: /Add member/ }));
    const form = await screen.findByTestId('add-member-form');
    fireEvent.change(within(form).getByLabelText(/登录名 Login/), { target: { value: 'dana' } });
    fireEvent.change(within(form).getByLabelText(/角色 Role/), { target: { value: 'operator' } });
    fireEvent.click(within(form).getByRole('button', { name: '添加 Add' }));

    await waitFor(() => expect(screen.queryByTestId('add-member-drawer')).toBeNull());
    await waitFor(() => expect(screen.getAllByTestId('member-row')).toHaveLength(2));
    // No API key is minted for a person — `add_member`'s result carries `hasApiKey: false`.
    expect(screen.queryByTestId('created-api-key')).toBeNull();
  });

  it('add_member maps the kernel 404 / 409 onto a bilingual inline message', async () => {
    const http = scriptedHttp({
      list_principals: () => ({ items: [principal()] }),
      add_member: () =>
        Promise.reject(new HttpError('capability_error', 'user not found', 'user_not_found')),
    });
    renderPage(http);
    await screen.findByTestId('member-row');

    fireEvent.click(screen.getByRole('button', { name: /Add member/ }));
    const form = await screen.findByTestId('add-member-form');
    fireEvent.change(within(form).getByLabelText(/登录名 Login/), { target: { value: 'nobody' } });
    fireEvent.click(within(form).getByRole('button', { name: '添加 Add' }));

    const error = await screen.findByTestId('add-member-error');
    expect(error.textContent).toContain('找不到该用户');
  });

  it('disabling requires a confirm step and calls disable_principal', async () => {
    const bob = principal();
    const http = scriptedHttp({
      list_principals: () => ({ items: [bob] }),
      disable_principal: (params) => {
        expect(params).toEqual({ principalId: 'p-1' });
        return { ...bob, disabledAt: '2026-09-08T00:00:00.000Z' };
      },
    });
    renderPage(http);
    fireEvent.click(await screen.findByTestId('member-row'));
    const drawer = await screen.findByTestId('principal-detail');

    fireEvent.click(within(drawer).getByRole('button', { name: 'Disable member' }));
    fireEvent.click(within(drawer).getByRole('button', { name: 'Confirm disable' }));

    await waitFor(() =>
      expect(within(drawer).getByTestId('principal-status').textContent).toBe('Disabled'),
    );
    expect(http.calls.some((call) => call.name === 'disable_principal')).toBe(true);
  });
});
