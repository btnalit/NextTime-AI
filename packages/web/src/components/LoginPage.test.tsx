// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../lib/http-client.js';
import { LoginPage } from './LoginPage.js';

/**
 * LoginPage.test.tsx: the primary login+password form (self-contained — owns its own `fetch` via
 * an injected `fetchImpl`) and the collapsed API-key `<details>` (whose submit is owned by the
 * caller, mirroring the pre-S4.1 `App.tsx`-owned WS connect flow).
 */

afterEach(cleanup);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('LoginPage: password login', () => {
  it('submits {login,password} and calls onLoggedIn with the session result', async () => {
    const onLoggedIn = vi.fn();
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        ok: true,
        result: {
          user: {
            id: 'u1',
            login: 'owner',
            displayName: 'Owner',
            platformRole: 'user',
            mustChangePassword: false,
          },
          memberships: [],
          expiresAt: '2026-01-01T00:00:00.000Z',
        },
      }),
    );

    render(
      <LoginPage
        onApiKeyLogin={vi.fn()}
        apiKeyPending={false}
        apiKeyError={null}
        onLoggedIn={onLoggedIn}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );

    fireEvent.change(screen.getByLabelText(/登录名 Login/), { target: { value: 'owner' } });
    fireEvent.change(screen.getByLabelText(/密码 Password/), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

    await waitFor(() => expect(onLoggedIn).toHaveBeenCalledTimes(1));
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/auth/login');
    expect(JSON.parse(init.body as string)).toEqual({ login: 'owner', password: 'password123' });
  });

  it.each([
    ['bad_credentials', '登录名或密码不正确'],
    ['locked', '尝试次数过多，请几分钟后再试'],
    ['disabled', '此账户已停用'],
  ])('shows the %s message inline', async (code, expectedText) => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(code === 'locked' ? 423 : code === 'disabled' ? 403 : 401, {
        ok: false,
        error: { code, message: 'kernel message' },
      }),
    );

    render(
      <LoginPage
        onApiKeyLogin={vi.fn()}
        apiKeyPending={false}
        apiKeyError={null}
        onLoggedIn={vi.fn()}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );

    fireEvent.change(screen.getByLabelText(/登录名 Login/), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText(/密码 Password/), { target: { value: 'y' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

    expect(await screen.findByText(expectedText)).toBeTruthy();
  });

  it('shows the sessions_unavailable explanation', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(503, {
        ok: false,
        error: { code: 'sessions_unavailable', message: 'no signing key' },
      }),
    );
    render(
      <LoginPage
        onApiKeyLogin={vi.fn()}
        apiKeyPending={false}
        apiKeyError={null}
        onLoggedIn={vi.fn()}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );

    fireEvent.change(screen.getByLabelText(/登录名 Login/), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText(/密码 Password/), { target: { value: 'y' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

    expect(await screen.findByText(/no Handle signing key configured/)).toBeTruthy();
  });
});

describe('LoginPage: API-key details', () => {
  it('is collapsed by default and calls onApiKeyLogin with the trimmed key on submit', () => {
    const onApiKeyLogin = vi.fn();
    render(
      <LoginPage
        onApiKeyLogin={onApiKeyLogin}
        apiKeyPending={false}
        apiKeyError={null}
        onLoggedIn={vi.fn()}
      />,
    );

    const details = screen.getByText('用 API key 登录 Use an API key instead').closest('details');
    expect(details?.open ?? false).toBe(false);
    fireEvent.click(screen.getByText('用 API key 登录 Use an API key instead'));
    expect(screen.getByPlaceholderText('sk-...')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('sk-...'), { target: { value: '  sk-abc  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(onApiKeyLogin).toHaveBeenCalledWith('sk-abc');
  });

  it('shows the unauthorized inline error and disables the field while pending, from App-owned props', () => {
    const { rerender } = render(
      <LoginPage
        onApiKeyLogin={vi.fn()}
        apiKeyPending={false}
        apiKeyError={new HttpError('capability_error', 'unauthorized', 'unauthorized')}
        onLoggedIn={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('用 API key 登录 Use an API key instead'));
    expect(screen.getByText('This key was not accepted by the kernel.')).toBeTruthy();

    rerender(
      <LoginPage
        onApiKeyLogin={vi.fn()}
        apiKeyPending={true}
        apiKeyError={null}
        onLoggedIn={vi.fn()}
      />,
    );
    expect(screen.getByPlaceholderText('sk-...')).toHaveProperty('disabled', true);
  });
});
