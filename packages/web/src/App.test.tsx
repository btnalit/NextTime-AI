// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeResult, SessionResult, WireUser } from './lib/auth-api.js';

/**
 * App.test.tsx: the two account-page flows the login page advertises and C1
 * (docs/console-completion-plan.md §2b) found unreachable — an API-key session setting a password
 * on 我的账户, and a cookie session binding a pre-existing API key there. Both go through the real
 * `App` → `Routed` → `AccountPage` wiring with the three I/O modules stubbed at the module
 * boundary: `lib/auth-api` (the `/api/auth/*` calls), `lib/ws-client` (`WsClient`, whose
 * `connect`/`authenticate` succeed instantly) and `lib/http-client` (`HttpClient`, whose every
 * capability call fails — the shell's own reads degrade to their fallbacks and are not under
 * test here).
 */

const CAROL: WireUser = {
  id: 'u-carol',
  login: 'carol',
  displayName: 'Carol',
  platformRole: 'user',
  mustChangePassword: false,
};

const authApi = vi.hoisted(() => ({
  getMe: vi.fn<() => Promise<MeResult>>(),
  claimIdentity: vi.fn<(apiKey: string, input: unknown) => Promise<SessionResult>>(),
  bindApiKey: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(async () => ({ loggedOut: true as const })),
  patchMe: vi.fn(),
  changePassword: vi.fn(),
  setWorkspaceCookie: vi.fn(),
}));

vi.mock('./lib/auth-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/auth-api.js')>()),
  ...authApi,
}));

vi.mock('./lib/ws-client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./lib/ws-client.js')>();
  class StubWsClient {
    private status: 'connecting' | 'connected' | 'reconnecting' | 'closed' = 'closed';
    async connect(): Promise<void> {
      this.status = 'connected';
    }
    async authenticate(): Promise<void> {}
    close(): void {
      this.status = 'closed';
    }
    call(): Promise<never> {
      return Promise.reject(new Error('StubWsClient: no capability calls in this test'));
    }
    subscribeChat(): Promise<() => void> {
      return Promise.resolve(() => undefined);
    }
    sendChatMessage(): Promise<never> {
      return this.call();
    }
    stopAgent(): Promise<never> {
      return this.call();
    }
    onActionPending(): () => void {
      return () => undefined;
    }
    onActionUpdated(): () => void {
      return () => undefined;
    }
    onTaskUpdated(): () => void {
      return () => undefined;
    }
    getStatus(): string {
      return this.status;
    }
    onStatusChange(): () => void {
      return () => undefined;
    }
  }
  return { ...original, WsClient: StubWsClient };
});

vi.mock('./lib/http-client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./lib/http-client.js')>();
  class StubHttpClient {
    call(): Promise<never> {
      return Promise.reject(new original.HttpError('network', 'stubbed in App.test.tsx'));
    }
  }
  return { ...original, HttpClient: StubHttpClient };
});

// Imported after the mocks are registered (vitest hoists `vi.mock`, but keeping the import below
// makes the dependency on the stubs explicit to a reader).
const { App } = await import('./App.js');

function navigateTo(hash: string): void {
  window.location.hash = hash;
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

beforeEach(() => {
  sessionStorage.clear();
  window.location.hash = '';
  vi.clearAllMocks();
});

afterEach(cleanup);

async function signInWithApiKey(key: string): Promise<void> {
  fireEvent.click(await screen.findByText('用 API key 登录 Use an API key instead'));
  fireEvent.change(screen.getByPlaceholderText('sk-...'), { target: { value: key } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('App: 我的账户 wiring (C1)', () => {
  it('API-key session → account page: the claim form can submit and a successful claim swaps in the cookie session', async () => {
    authApi.getMe.mockRejectedValue(new Error('401'));
    authApi.claimIdentity.mockResolvedValue({
      user: CAROL,
      memberships: [],
      expiresAt: '2027-01-01T00:00:00.000Z',
    });
    render(<App />);

    await signInWithApiKey('sk-claim-me');
    // The shell (a published session) is up once the sidebar's nav renders.
    await screen.findByTestId('nav-agent');
    act(() => navigateTo('#/me/account'));

    const submit = (await screen.findByRole('button', {
      name: '设置密码 Set password',
    })) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/登录名 Login/), { target: { value: 'carol' } });
    fireEvent.change(screen.getByLabelText(/显示名 Display name/), { target: { value: 'Carol' } });
    fireEvent.change(screen.getByLabelText(/^密码 Password/), { target: { value: 'password123' } });
    fireEvent.change(screen.getByLabelText(/确认密码 Confirm password/), {
      target: { value: 'password123' },
    });
    // Before C1 `apiKey` was never passed down, so this button stayed disabled forever.
    await waitFor(() => expect(submit.disabled).toBe(false));

    fireEvent.click(submit);
    await waitFor(() => expect(authApi.claimIdentity).toHaveBeenCalledTimes(1));
    expect(authApi.claimIdentity.mock.calls[0]?.[0]).toBe('sk-claim-me');

    // The claim's cookie session replaces the key session: the account page now renders in cookie
    // mode for the claimed user (its header shows the login), and the stored key is gone so a
    // later cookie logout cannot silently re-sign in over the key channel.
    await screen.findByText('carol');
    expect(screen.queryByRole('button', { name: '设置密码 Set password' })).toBeNull();
    expect(sessionStorage.getItem('nexttime.apiKey')).toBeNull();
  });

  it('cookie session → account page: the bind-API-key card is offered', async () => {
    authApi.getMe.mockResolvedValue({
      user: CAROL,
      memberships: [
        { workspaceId: 'ws-1', workspaceName: 'Acme', principalId: 'p-1', role: 'member' },
      ],
    });
    render(<App />);

    // Boot lands a one-membership user in that workspace's shell.
    await screen.findByTestId('nav-agent');
    act(() => navigateTo('#/me/account'));

    await screen.findByText('carol');
    // `BindApiKeyForm` renders only when `onBound` is wired (AccountPage.tsx) — C1's second half.
    await screen.findByLabelText(/API key/);
  });

  it('cookie user with no workspace → account page: the bind-API-key card is offered there too', async () => {
    authApi.getMe.mockResolvedValue({ user: CAROL, memberships: [] });
    render(<App />);

    await screen.findByRole('button', { name: /我的账户|My Account/ });
    act(() => navigateTo('#/me/account'));

    await screen.findByText('carol');
    await screen.findByLabelText(/API key/);
  });
});
