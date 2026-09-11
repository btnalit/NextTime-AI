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
  it('claims the identity via POST /api/auth/claim and calls onClaimed on success', async () => {
    const onClaimed = vi.fn();
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        ok: true,
        result: {
          user: {
            id: 'u2',
            login: 'carol',
            displayName: 'Carol',
            platformRole: 'user',
            mustChangePassword: false,
          },
          memberships: [],
          expiresAt: '2026-01-01T00:00:00.000Z',
        },
      }),
    );

    render(
      <AccountPage
        user={null}
        memberships={[]}
        onUserChanged={vi.fn()}
        apiKey="sk-claim"
        onClaimed={onClaimed}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );

    fireEvent.change(screen.getByLabelText(/登录名 Login/), { target: { value: 'carol' } });
    fireEvent.change(screen.getByLabelText(/显示名 Display name/), {
      target: { value: 'Carol' },
    });
    fireEvent.change(screen.getByLabelText(/密码 Password/), { target: { value: 'password123' } });
    fireEvent.change(screen.getByLabelText(/确认密码 Confirm password/), {
      target: { value: 'password123' },
    });
    fireEvent.click(screen.getByRole('button', { name: '设置密码 Set password' }));

    await waitFor(() => expect(onClaimed).toHaveBeenCalledTimes(1));
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/auth/claim');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-claim');
    expect(JSON.parse(init.body as string)).toEqual({
      login: 'carol',
      displayName: 'Carol',
      password: 'password123',
    });
  });

  it('maps already_claimed to a friendly inline message', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(409, {
        ok: false,
        error: { code: 'already_claimed', message: 'that identity already has a password' },
      }),
    );

    render(
      <AccountPage
        user={null}
        memberships={[]}
        onUserChanged={vi.fn()}
        apiKey="sk-claim"
        onClaimed={vi.fn()}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );

    fireEvent.change(screen.getByLabelText(/登录名 Login/), { target: { value: 'carol' } });
    fireEvent.change(screen.getByLabelText(/显示名 Display name/), {
      target: { value: 'Carol' },
    });
    fireEvent.change(screen.getByLabelText(/密码 Password/), { target: { value: 'password123' } });
    fireEvent.change(screen.getByLabelText(/确认密码 Confirm password/), {
      target: { value: 'password123' },
    });
    fireEvent.click(screen.getByRole('button', { name: '设置密码 Set password' }));

    await waitFor(() =>
      expect(screen.getByText(/该身份已经有密码了；请登出后用密码登录/)).toBeTruthy(),
    );
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
