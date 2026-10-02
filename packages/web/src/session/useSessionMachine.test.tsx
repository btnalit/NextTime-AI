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
 * re-read `/api/auth/me` and choose a workspace again, not login. `lib/auth-api`, `lib/ws-client`
 * and `lib/http-client` are stubbed at the module boundary, as in App.test.tsx.
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
  window.location.hash = '';
  vi.clearAllMocks();
  stubs.sockets.length = 0;
  stubs.httpOptions.length = 0;
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
