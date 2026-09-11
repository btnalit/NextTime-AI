// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SetupPage } from './SetupPage.js';

afterEach(cleanup);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fillForm(): void {
  fireEvent.change(screen.getByLabelText(/一次性令牌 Setup token/), {
    target: { value: 'tok-1' },
  });
  fireEvent.change(screen.getByLabelText(/登录名 Login/), { target: { value: 'e2e-admin' } });
  fireEvent.change(screen.getByLabelText(/显示名 Display name/), {
    target: { value: 'E2E Admin' },
  });
  fireEvent.change(screen.getByLabelText(/密码 Password/), { target: { value: 'password123' } });
  fireEvent.change(screen.getByLabelText(/确认密码 Confirm password/), {
    target: { value: 'password123' },
  });
}

describe('SetupPage', () => {
  it('submits {token,login,displayName,password} and calls onSetupComplete on success', async () => {
    const onSetupComplete = vi.fn();
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        ok: true,
        result: {
          user: {
            id: 'u1',
            login: 'e2e-admin',
            displayName: 'E2E Admin',
            platformRole: 'admin',
            mustChangePassword: false,
          },
          memberships: [],
          expiresAt: '2026-01-01T00:00:00.000Z',
        },
      }),
    );

    render(
      <SetupPage
        tokenAvailable
        onSetupComplete={onSetupComplete}
        onLoginInstead={vi.fn()}
        onApiKeyLogin={vi.fn()}
        apiKeyPending={false}
        apiKeyError={null}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );

    fillForm();
    fireEvent.click(screen.getByRole('button', { name: /Create administrator/ }));

    await waitFor(() => expect(onSetupComplete).toHaveBeenCalledTimes(1));
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/platform/setup');
    expect(JSON.parse(init.body as string)).toEqual({
      token: 'tok-1',
      login: 'e2e-admin',
      displayName: 'E2E Admin',
      password: 'password123',
    });
  });

  it('refuses to submit when the passwords do not match', () => {
    render(
      <SetupPage
        tokenAvailable
        onSetupComplete={vi.fn()}
        onLoginInstead={vi.fn()}
        onApiKeyLogin={vi.fn()}
        apiKeyPending={false}
        apiKeyError={null}
      />,
    );
    fillForm();
    fireEvent.change(screen.getByLabelText(/确认密码 Confirm password/), {
      target: { value: 'different' },
    });
    expect(screen.getByText(/Passwords do not match/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Create administrator/ })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('disables the form and shows a notice when tokenAvailable is false', () => {
    render(
      <SetupPage
        tokenAvailable={false}
        onSetupComplete={vi.fn()}
        onLoginInstead={vi.fn()}
        onApiKeyLogin={vi.fn()}
        apiKeyPending={false}
        apiKeyError={null}
      />,
    );
    expect(screen.getByText(/No usable setup token/)).toBeTruthy();
    expect(screen.queryByLabelText(/一次性令牌 Setup token/)).toBeNull();
    expect(screen.getByRole('button', { name: /Create administrator/ })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('calls onLoginInstead from the "already have an account" link', () => {
    const onLoginInstead = vi.fn();
    render(
      <SetupPage
        tokenAvailable
        onSetupComplete={vi.fn()}
        onLoginInstead={onLoginInstead}
        onApiKeyLogin={vi.fn()}
        apiKeyPending={false}
        apiKeyError={null}
      />,
    );
    fireEvent.click(screen.getByText(/Already have an account\? Log in/));
    expect(onLoginInstead).toHaveBeenCalledTimes(1);
  });

  it('offers the same collapsed API-key details as LoginPage', () => {
    const onApiKeyLogin = vi.fn();
    render(
      <SetupPage
        tokenAvailable
        onSetupComplete={vi.fn()}
        onLoginInstead={vi.fn()}
        onApiKeyLogin={onApiKeyLogin}
        apiKeyPending={false}
        apiKeyError={null}
      />,
    );
    fireEvent.click(screen.getByText('用 API key 登录 Use an API key instead'));
    fireEvent.change(screen.getByPlaceholderText('sk-...'), { target: { value: 'sk-abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(onApiKeyLogin).toHaveBeenCalledWith('sk-abc');
  });
});
