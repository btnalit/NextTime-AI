// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeResult, WireMembership, WireUser } from '../lib/auth-api.js';
import type { HttpClientOptions } from '../lib/http-client.js';
import type { WsSessionEndReason } from '../lib/ws-client.js';

/**
 * useSessionMachine.test.tsx: R-16 (review 2026-10-02) — where the session machine goes when the
 * kernel ends a published session for good. `-32001` / HTTP `unauthorized` → login, with the
 * socket closed (the client itself no longer reconnects — lib/ws-client.test.ts); `-32002` →
 * re-read `/api/auth/me` and choose a workspace again, not login. R-15: a Sign out the kernel never
 * confirmed is still a sign-out on every later load. `lib/auth-api`, `lib/ws-client` and
 * `lib/http-client` are stubbed at the module boundary, as in App.test.tsx.
 */

const BOB: WireUser = {
  id: 'u-bob',
  login: 'bob',
  displayName: 'Bob',
  platformRole: 'user',
  mustChangePassword: false,
};

function membership(workspaceId: string): WireMembership {
  return {
    workspaceId,
    workspaceName: workspaceId,
    principalId: `p-${workspaceId}`,
    role: 'member',
  };
}

const stubs = vi.hoisted(() => ({
  getMe: vi.fn<() => Promise<MeResult>>(),
  logout: vi.fn(async () => ({ loggedOut: true as const })),
  setWorkspaceCookie: vi.fn(),
  sockets: [] as {
    closed: boolean;
    authenticatedWith: unknown;
    end: (reason: WsSessionEndReason) => void;
  }[],
  httpOptions: [] as HttpClientOptions[],
  /** R-64: workspaces whose WS `authenticate` the (stub) kernel refuses. */
  refusedWorkspaces: new Set<string>(),
}));

vi.mock('../lib/auth-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/auth-api.js')>()),
  getMe: stubs.getMe,
  logout: stubs.logout,
  setWorkspaceCookie: stubs.setWorkspaceCookie,
}));

vi.mock('../lib/ws-client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/ws-client.js')>();
  class StubWsClient {
    closed = false;
    authenticatedWith: unknown;
    private readonly endListeners = new Set<(reason: WsSessionEndReason) => void>();
    constructor() {
      stubs.sockets.push(this);
    }
    async connect(): Promise<void> {}
    async authenticate(credential: unknown): Promise<void> {
      const workspaceId = (credential as { workspaceId?: string }).workspaceId;
      if (workspaceId !== undefined && stubs.refusedWorkspaces.has(workspaceId)) {
        throw new Error('forbidden: no active membership in the requested workspace');
      }
      this.authenticatedWith = credential;
    }
    close(): void {
      this.closed = true;
    }
    onSessionEnded(handler: (reason: WsSessionEndReason) => void): () => void {
      this.endListeners.add(handler);
      return () => this.endListeners.delete(handler);
    }
    /** Test helper: the kernel ended this socket's session. */
    end(reason: WsSessionEndReason): void {
      for (const fn of this.endListeners) fn(reason);
    }
  }
  return { ...original, WsClient: StubWsClient };
});

vi.mock('../lib/http-client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/http-client.js')>();
  class StubHttpClient {
    constructor(options: HttpClientOptions) {
      stubs.httpOptions.push(options);
    }
  }
  return { ...original, HttpClient: StubHttpClient };
});

const { useSessionMachine } = await import('./useSessionMachine.js');

function lastSocket() {
  const socket = stubs.sockets[stubs.sockets.length - 1];
  if (!socket) throw new Error('expected a WsClient to have been created');
  return socket;
}

async function bootCookieSession(memberships: readonly WireMembership[]) {
  stubs.getMe.mockResolvedValueOnce({ user: BOB, memberships });
  const hook = renderHook(() => useSessionMachine({ syncRoute: () => undefined }));
  await waitFor(() => expect(hook.result.current.session).not.toBeNull());
  return hook;
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  window.location.hash = '';
  vi.clearAllMocks();
  stubs.sockets.length = 0;
  stubs.httpOptions.length = 0;
  stubs.refusedWorkspaces.clear();
});

afterEach(cleanup);

describe('useSessionMachine: the kernel ends the published session (R-16)', () => {
  it('-32001 (session_invalid) → login, the socket closed', async () => {
    const { result } = await bootCookieSession([membership('ws-1')]);
    const socket = lastSocket();

    act(() => socket.end('session_invalid'));

    await waitFor(() => expect(result.current.session).toBeNull());
    expect(result.current.preSession).toEqual({ kind: 'login' });
    expect(socket.closed).toBe(true);
    expect(stubs.sockets).toHaveLength(1); // nothing reopened
  });

  it('HTTP unauthorized takes the same transition as -32001', async () => {
    const { result } = await bootCookieSession([membership('ws-1')]);
    const socket = lastSocket();

    act(() => stubs.httpOptions[stubs.httpOptions.length - 1]?.onUnauthorized?.());

    await waitFor(() => expect(result.current.session).toBeNull());
    expect(result.current.preSession).toEqual({ kind: 'login' });
    expect(socket.closed).toBe(true);
  });

  it('-32002 (membership_gone) → /api/auth/me again, and the session reopens in a remaining workspace — not login', async () => {
    const { result } = await bootCookieSession([membership('ws-1'), membership('ws-2')]);
    expect(result.current.session?.selectedWorkspaceId).toBe('ws-1');
    const first = lastSocket();

    stubs.getMe.mockResolvedValueOnce({ user: BOB, memberships: [membership('ws-2')] });
    act(() => first.end('membership_gone'));

    await waitFor(() => expect(result.current.session?.selectedWorkspaceId).toBe('ws-2'));
    expect(stubs.getMe).toHaveBeenCalledTimes(2);
    expect(first.closed).toBe(true);
    expect(lastSocket().authenticatedWith).toEqual({ workspaceId: 'ws-2' });
    expect(result.current.preSession.kind).not.toBe('login');
  });

  it('-32002 with no membership left → the no-workspace page', async () => {
    const { result } = await bootCookieSession([membership('ws-1')]);
    const first = lastSocket();

    stubs.getMe.mockResolvedValueOnce({ user: BOB, memberships: [] });
    act(() => first.end('membership_gone'));

    await waitFor(() => expect(result.current.preSession.kind).toBe('noWorkspace'));
    expect(result.current.session).toBeNull();
    expect(first.closed).toBe(true);
  });

  it('-32002 when /api/auth/me itself is now refused → login', async () => {
    const { result } = await bootCookieSession([membership('ws-1')]);

    stubs.getMe.mockRejectedValueOnce(new Error('401'));
    act(() => lastSocket().end('membership_gone'));

    await waitFor(() => expect(result.current.preSession).toEqual({ kind: 'login' }));
    expect(result.current.session).toBeNull();
  });

  it('an API-key session that ends → login, and the dead key is forgotten', async () => {
    stubs.getMe.mockRejectedValueOnce(new Error('401'));
    const { result } = renderHook(() => useSessionMachine({ syncRoute: () => undefined }));
    await waitFor(() => expect(result.current.preSession).toEqual({ kind: 'login' }));

    await act(() => result.current.connectApiKey('sk-member'));
    expect(result.current.session?.authMode).toBe('apiKey');
    expect(sessionStorage.getItem('nexttime.apiKey')).toBe('sk-member');

    act(() => lastSocket().end('session_invalid'));

    await waitFor(() => expect(result.current.session).toBeNull());
    expect(result.current.preSession).toEqual({ kind: 'login' });
    expect(sessionStorage.getItem('nexttime.apiKey')).toBeNull();
  });

  it('a late event from a replaced session changes nothing', async () => {
    const { result } = await bootCookieSession([membership('ws-1'), membership('ws-2')]);
    const first = lastSocket();

    await act(() => result.current.switchWorkspace('ws-2'));
    expect(result.current.session?.selectedWorkspaceId).toBe('ws-2');

    act(() => first.end('session_invalid'));

    expect(result.current.session?.selectedWorkspaceId).toBe('ws-2');
    expect(lastSocket().closed).toBe(false);
  });
});

describe('useSessionMachine: a failed workspace switch keeps the session (R-64)', () => {
  it('the switch fails → still signed in to the current workspace, only the new socket closed, the failure reported, memberships re-read, no navigation', async () => {
    const { result } = await bootCookieSession([membership('ws-1'), membership('ws-2')]);
    const before = result.current.session;
    const current = lastSocket();
    window.location.hash = '#/work/tasks';

    stubs.refusedWorkspaces.add('ws-2');
    // The workspace the switch failed on is gone from the user's memberships.
    stubs.getMe.mockResolvedValueOnce({ user: BOB, memberships: [membership('ws-1')] });
    await act(() => result.current.switchWorkspace('ws-2'));

    expect(result.current.session?.generation).toBe(before?.generation);
    expect(result.current.session?.selectedWorkspaceId).toBe('ws-1');
    expect(result.current.session?.ws).toBe(before?.ws);
    expect(current.closed).toBe(false);
    expect(lastSocket()).not.toBe(current);
    expect(lastSocket().closed).toBe(true);
    expect(result.current.preSession.kind).not.toBe('login');
    expect(result.current.workspaceSwitchFailure).toMatchObject({
      workspaceId: 'ws-2',
      workspaceName: 'ws-2',
    });
    expect(String(result.current.workspaceSwitchFailure?.error)).toMatch(/no active membership/);
    await waitFor(() =>
      expect(result.current.session?.memberships?.map((m) => m.workspaceId)).toEqual(['ws-1']),
    );
    expect(window.location.hash).toBe('#/work/tasks');
  });

  it('a later successful switch clears the reported failure and lands on its destination', async () => {
    const { result } = await bootCookieSession([membership('ws-1'), membership('ws-2')]);
    stubs.refusedWorkspaces.add('ws-2');
    stubs.getMe.mockResolvedValueOnce({
      user: BOB,
      memberships: [membership('ws-1'), membership('ws-2')],
    });
    await act(() => result.current.switchWorkspace('ws-2'));
    expect(result.current.workspaceSwitchFailure).not.toBeNull();

    stubs.refusedWorkspaces.clear();
    await act(() => result.current.switchWorkspace('ws-2', '#/govern/members'));
    expect(result.current.session?.selectedWorkspaceId).toBe('ws-2');
    expect(result.current.workspaceSwitchFailure).toBeNull();
    expect(window.location.hash).toBe('#/govern/members');
  });

  it('refreshMemberships re-reads /api/auth/me into the same session — no new socket', async () => {
    const { result } = await bootCookieSession([membership('ws-1')]);
    const generation = result.current.session?.generation;
    const sockets = stubs.sockets.length;

    stubs.getMe.mockResolvedValueOnce({
      user: BOB,
      memberships: [membership('ws-1'), membership('ws-new')],
    });
    await act(() => result.current.refreshMemberships());

    expect(result.current.session?.memberships?.map((m) => m.workspaceId)).toEqual([
      'ws-1',
      'ws-new',
    ]);
    expect(result.current.session?.generation).toBe(generation);
    expect(stubs.sockets).toHaveLength(sockets);
  });
});

describe('useSessionMachine: Sign out when the kernel cannot be reached (R-15)', () => {
  function bootFresh() {
    return renderHook(() => useSessionMachine({ syncRoute: () => undefined }));
  }

  async function signOutWhileKernelUnreachable() {
    const hook = await bootCookieSession([membership('ws-1')]);
    const socket = lastSocket();
    stubs.logout.mockRejectedValueOnce(new Error('network down'));

    await act(() => hook.result.current.cookieLogout());

    // Signed out here at once, whatever the request did.
    expect(hook.result.current.session).toBeNull();
    expect(hook.result.current.preSession).toEqual({ kind: 'login' });
    expect(socket.closed).toBe(true);
    hook.unmount();
    vi.clearAllMocks();
  }

  it('the next load retries the revoke and never resumes the cookie, until a retry gets through', async () => {
    await signOutWhileKernelUnreachable();

    // Still unreachable: back to login, /api/auth/me never asked.
    stubs.logout.mockRejectedValueOnce(new Error('network down'));
    const second = bootFresh();
    await waitFor(() => expect(second.result.current.preSession).toEqual({ kind: 'login' }));
    expect(stubs.logout).toHaveBeenCalledTimes(1);
    expect(stubs.getMe).not.toHaveBeenCalled();
    expect(second.result.current.session).toBeNull();
    second.unmount();
    vi.clearAllMocks();

    // The kernel is back: the retry gets through, and it is still login, not the old session.
    const third = bootFresh();
    await waitFor(() => expect(third.result.current.preSession).toEqual({ kind: 'login' }));
    expect(stubs.logout).toHaveBeenCalledTimes(1);
    expect(stubs.getMe).not.toHaveBeenCalled();
    third.unmount();
    vi.clearAllMocks();

    // From then on, an ordinary boot.
    const fourth = await bootCookieSession([membership('ws-1')]);
    expect(stubs.logout).not.toHaveBeenCalled();
    expect(stubs.getMe).toHaveBeenCalledTimes(1);
    fourth.unmount();
  });

  it('signing in again after a failed sign-out replaces the cookie: the next load is an ordinary boot', async () => {
    await signOutWhileKernelUnreachable();

    stubs.logout.mockRejectedValueOnce(new Error('network down'));
    const second = bootFresh();
    await waitFor(() => expect(second.result.current.preSession).toEqual({ kind: 'login' }));
    // The login page's password form succeeded (a fresh cookie).
    await act(() => second.result.current.proceedAfterCookieAuth(BOB, [membership('ws-1')]));
    expect(second.result.current.session).not.toBeNull();
    second.unmount();
    vi.clearAllMocks();

    const third = await bootCookieSession([membership('ws-1')]);
    expect(stubs.logout).not.toHaveBeenCalled();
    third.unmount();
  });

  it('a sign-out the kernel confirms leaves nothing behind', async () => {
    const hook = await bootCookieSession([membership('ws-1')]);
    await act(() => hook.result.current.cookieLogout());
    expect(stubs.logout).toHaveBeenCalledTimes(1);
    hook.unmount();
    vi.clearAllMocks();

    stubs.getMe.mockRejectedValueOnce(new Error('401'));
    const next = bootFresh();
    await waitFor(() => expect(next.result.current.preSession).toEqual({ kind: 'login' }));
    expect(stubs.getMe).toHaveBeenCalledTimes(1);
    expect(stubs.logout).not.toHaveBeenCalled();
  });
});
