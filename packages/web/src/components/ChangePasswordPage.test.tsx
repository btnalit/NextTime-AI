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

    fireEvent.change(screen.getByLabelText(/当前密码/), {
      target: { value: 'temp-pass' },
    });
    fireEvent.change(screen.getByLabelText(/^新密码/), {
      target: { value: 'new-password-1' },
    });
    fireEvent.change(screen.getByLabelText(/确认新密码/), {
      target: { value: 'new-password-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: /更改密码/ }));

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

    fireEvent.change(screen.getByLabelText(/当前密码/), {
      target: { value: 'wrong' },
    });
    fireEvent.change(screen.getByLabelText(/^新密码/), {
      target: { value: 'new-password-1' },
    });
    fireEvent.change(screen.getByLabelText(/确认新密码/), {
      target: { value: 'new-password-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: /更改密码/ }));

    expect(await screen.findByText(/当前密码不正确/)).toBeTruthy();
  });

  it('shows the mapped Chinese copy for weak_password and keeps the kernel text secondary', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(400, {
        ok: false,
        error: { code: 'weak_password', message: 'password must be at least 12 characters' },
      }),
    );
    render(
      <ChangePasswordPage
        user={USER}
        onChanged={vi.fn()}
        onLogout={vi.fn()}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    fireEvent.change(screen.getByLabelText(/当前密码/), { target: { value: 'temp-pass' } });
    // Past the client-side floor of 8, short of the platform's own minimum of 12.
    fireEvent.change(screen.getByLabelText(/^新密码/), { target: { value: 'nine-char' } });
    fireEvent.change(screen.getByLabelText(/确认新密码/), { target: { value: 'nine-char' } });
    fireEvent.click(screen.getByRole('button', { name: /更改密码/ }));

    expect(await screen.findByText('密码不满足平台的最短长度要求')).toBeTruthy();
    expect(screen.getByText('password must be at least 12 characters')).toBeTruthy();
  });

  it('P1-2: a new password under 8 characters is refused on the field before any request, and 还差 says what is left', () => {
    const fetchImpl = vi.fn();
    render(
      <ChangePasswordPage
        user={USER}
        onChanged={vi.fn()}
        onLogout={vi.fn()}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    expect(screen.getByTestId('change-password-missing').textContent).toBe(
      '还差：当前密码、新密码、确认新密码',
    );
    fireEvent.change(screen.getByLabelText(/当前密码/), { target: { value: 'temp-pass' } });
    fireEvent.change(screen.getByLabelText(/^新密码/), { target: { value: 'short' } });
    fireEvent.change(screen.getByLabelText(/确认新密码/), { target: { value: 'short' } });
    expect(screen.getByText('密码太短：当前 5 位，至少需要 8 位。')).toBeTruthy();
    expect(screen.queryByTestId('change-password-missing')).toBeNull();
    const submit = screen.getByTestId('change-password-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('offers only Change password and Sign out — calls onLogout', () => {
    const onLogout = vi.fn();
    render(<ChangePasswordPage user={USER} onChanged={vi.fn()} onLogout={onLogout} />);
    fireEvent.click(screen.getByRole('button', { name: /登出/ }));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });
});
