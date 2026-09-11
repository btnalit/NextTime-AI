// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WireUser } from '../lib/auth-api.js';
import { ChangePasswordPage } from './ChangePasswordPage.js';

afterEach(cleanup);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const USER: WireUser = {
  id: 'u1',
  login: 'bob',
  displayName: 'Bob',
  platformRole: 'user',
  mustChangePassword: true,
};

describe('ChangePasswordPage', () => {
  it('submits current/new password and calls onChanged with the returned (no-longer-temp) user', async () => {
    const onChanged = vi.fn();
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        ok: true,
        result: { user: { ...USER, mustChangePassword: false } },
      }),
    );
    render(
      <ChangePasswordPage
        user={USER}
        onChanged={onChanged}
        onLogout={vi.fn()}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );

    fireEvent.change(screen.getByLabelText(/当前密码 Current password/), {
      target: { value: 'temp-pass' },
    });
    fireEvent.change(screen.getByLabelText(/新密码 New password/), {
      target: { value: 'new-password-1' },
    });
    fireEvent.change(screen.getByLabelText(/确认新密码 Confirm new password/), {
      target: { value: 'new-password-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Change password/ }));

    await waitFor(() =>
      expect(onChanged).toHaveBeenCalledWith({ ...USER, mustChangePassword: false }),
    );
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/auth/password');
    expect(JSON.parse(init.body as string)).toEqual({
      currentPassword: 'temp-pass',
      newPassword: 'new-password-1',
    });
  });

  it('shows an inline error when the current password is wrong', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(401, { ok: false, error: { code: 'bad_credentials', message: 'nope' } }),
    );
    render(
      <ChangePasswordPage
        user={USER}
        onChanged={vi.fn()}
        onLogout={vi.fn()}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );

    fireEvent.change(screen.getByLabelText(/当前密码 Current password/), {
      target: { value: 'wrong' },
    });
    fireEvent.change(screen.getByLabelText(/新密码 New password/), {
      target: { value: 'new-password-1' },
    });
    fireEvent.change(screen.getByLabelText(/确认新密码 Confirm new password/), {
      target: { value: 'new-password-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Change password/ }));

    expect(await screen.findByText(/Current password is incorrect/)).toBeTruthy();
  });

  it('offers only Change password and Sign out — calls onLogout', () => {
    const onLogout = vi.fn();
    render(<ChangePasswordPage user={USER} onChanged={vi.fn()} onLogout={onLogout} />);
    fireEvent.click(screen.getByRole('button', { name: /登出 Sign out/ }));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });
});
