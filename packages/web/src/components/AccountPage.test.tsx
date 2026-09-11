// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WireMembership, WireUser } from '../lib/auth-api.js';
import { AccountPage } from './AccountPage.js';

afterEach(cleanup);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const USER: WireUser = {
  id: 'u1',
  login: 'owner',
  displayName: 'Owner',
  platformRole: 'user',
  mustChangePassword: false,
};

const MEMBERSHIPS: readonly WireMembership[] = [
  { workspaceId: 'ws-1', workspaceName: 'Acme', principalId: 'p-1', role: 'owner' },
];

describe('AccountPage: API-key mode (no user)', () => {
  it('renders without crashing and explains that account settings need a password login', () => {
    render(<AccountPage user={null} memberships={[]} onUserChanged={vi.fn()} />);
    expect(screen.getByText(/Account settings require a password login/)).toBeTruthy();
  });
});

describe('AccountPage: cookie mode', () => {
  it('saves a new display name via PATCH /api/auth/me', async () => {
    const onUserChanged = vi.fn();
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { ok: true, result: { user: { ...USER, displayName: 'New Name' } } }),
    );
    render(
      <AccountPage
        user={USER}
        memberships={MEMBERSHIPS}
        onUserChanged={onUserChanged}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );

    fireEvent.change(screen.getByLabelText(/显示名 Display name/), {
      target: { value: 'New Name' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));

    await waitFor(() =>
      expect(onUserChanged).toHaveBeenCalledWith({ ...USER, displayName: 'New Name' }),
    );
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/auth/me');
    expect(init.method).toBe('PATCH');
  });

  it('changes the password via POST /api/auth/password', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true, result: { user: USER } }));
    render(
      <AccountPage
        user={USER}
        memberships={MEMBERSHIPS}
        onUserChanged={vi.fn()}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );

    fireEvent.change(screen.getByLabelText(/当前密码 Current password/), {
      target: { value: 'old' },
    });
    fireEvent.change(screen.getByLabelText(/新密码 New password/), {
      target: { value: 'newnewnew' },
    });
    fireEvent.change(screen.getByLabelText(/确认新密码 Confirm new password/), {
      target: { value: 'newnewnew' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Change password/ }));

    await waitFor(() => expect(screen.getByText(/Password changed/)).toBeTruthy());
    const [url] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/auth/password');
  });

  it('lists memberships read-only (workspace name + role)', () => {
    render(<AccountPage user={USER} memberships={MEMBERSHIPS} onUserChanged={vi.fn()} />);
    const list = screen.getByTestId('account-memberships');
    expect(list.textContent).toContain('Acme');
    expect(list.textContent).toContain('owner');
  });
});
