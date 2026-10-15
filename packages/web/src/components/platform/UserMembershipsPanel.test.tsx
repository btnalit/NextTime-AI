// @vitest-environment jsdom
import type { PlatformWorkspaceWire, UserWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../lib/clients.js';
import { UserMembershipsPanel } from './UserMembershipsPanel.js';

afterEach(cleanup);

type Handlers = Record<string, (params: unknown) => unknown | Promise<unknown>>;

function scriptedHttp(
  handlers: Handlers,
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
    isDefault: false,
    memberCount: 1,
    owners: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
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
    monthlyTokenBudget: null,
    lastLoginAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    memberships: [
      {
        workspaceId: 'ws-1',
        workspaceName: 'Acme',
        workspaceStatus: 'active',
        principalId: 'p-1',
        role: 'operator',
        disabled: true,
      },
    ],
    ...overrides,
  };
}

function renderPanel(http: CapabilityCaller, row: UserWire = user()) {
  const onChanged = vi.fn();
  render(<UserMembershipsPanel http={http} user={row} onChanged={onChanged} onBack={vi.fn()} />);
  return { onChanged };
}

describe('UserMembershipsPanel', () => {
  it('offers every active workspace the user is not in yet, and adds the picked one', async () => {
    const http = scriptedHttp({
      list_workspaces: () => ({
        items: [
          workspace(),
          workspace({ id: 'ws-2', name: 'Beta' }),
          workspace({ id: 'ws-3', name: 'Gamma' }),
        ],
      }),
      add_membership: () => ({}),
    });
    const { onChanged } = renderPanel(http);
    const select = screen.getByLabelText(/加入工作区/) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(3));
    expect(http.calls[0]).toEqual({
      name: 'list_workspaces',
      params: { status: 'active', includeExpired: false },
    });
    // Acme is already held (even as a disabled membership) — not offered; no typed-id option.
    expect([...select.options].map((option) => option.textContent)).toEqual([
      '选择工作区',
      'Beta',
      'Gamma',
    ]);
    expect(screen.queryByLabelText(/工作区 ID/)).toBeNull();

    const add = screen.getByRole('button', { name: '加入' });
    expect(add.hasAttribute('disabled')).toBe(true);
    fireEvent.change(select, { target: { value: 'ws-3' } });
    fireEvent.change(screen.getByLabelText(/^角色/, { selector: '#um-role' }), {
      target: { value: 'builder' },
    });
    fireEvent.click(add);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(http.calls.find((call) => call.name === 'add_membership')?.params).toEqual({
      userId: 'u-1',
      workspaceId: 'ws-3',
      role: 'builder',
    });
  });

  it('says so when the user already belongs to every active workspace', async () => {
    const http = scriptedHttp({ list_workspaces: () => ({ items: [workspace()] }) });
    renderPanel(http);
    expect(await screen.findByTestId('user-memberships-workspace-empty')).toBeTruthy();
    expect(screen.getByText(/已加入所有可用的工作区/)).toBeTruthy();
  });

  it('a failed workspace read shows an error banner whose retry reloads the list', async () => {
    let attempts = 0;
    const http = scriptedHttp({
      list_workspaces: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('network down');
        return { items: [workspace({ id: 'ws-2', name: 'Beta' })] };
      },
    });
    renderPanel(http);
    const banner = await screen.findByTestId('user-memberships-workspace-error');
    fireEvent.click(within(banner).getByRole('button', { name: /重试/ }));
    const select = screen.getByLabelText(/加入工作区/) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(2));
    expect(screen.queryByTestId('user-memberships-workspace-error')).toBeNull();
  });

  it('labels roles and membership states in words, not raw enum values', async () => {
    const http = scriptedHttp({
      list_workspaces: () => ({ items: [] }),
    });
    renderPanel(
      http,
      user({
        memberships: [
          {
            workspaceId: 'ws-1',
            workspaceName: 'Acme',
            workspaceStatus: 'disabled',
            principalId: 'p-1',
            role: 'operator',
            disabled: true,
          },
        ],
      }),
    );
    const row = screen.getByTestId('user-membership-row');
    expect(within(row).getByText('已停用')).toBeTruthy();
    expect(within(row).getByText('工作区已停用')).toBeTruthy();
    const rowRole = within(row).getByLabelText(/角色/) as HTMLSelectElement;
    const addRole = screen.getByLabelText(/^角色/, { selector: '#um-role' }) as HTMLSelectElement;
    for (const select of [rowRole, addRole]) {
      const texts = [...select.options].map((option) => option.textContent);
      expect(texts).toContain('操作员');
      expect(texts).not.toContain('operator');
    }
    await screen.findByTestId('user-memberships-workspace-empty');
  });
});
