import { describe, expect, it, vi } from 'vitest';
import {
  bindApiKey,
  changePassword,
  claimIdentity,
  getMe,
  login,
  logout,
  patchMe,
} from './auth-api.js';
import { HttpError } from './http-client.js';

/**
 * auth-api.test.ts: exercises lib/auth-api.ts's fetch helpers against an injected `fetch` fake —
 * deterministic, no kernel required. Mirrors http-client.test.ts's coverage shape for the same
 * `{ok,result|error}` envelope (packages/kernel/src/interfaces/http/auth-routes.ts).
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('claimIdentity', () => {
  it('POSTs to /api/auth/claim with Authorization: Bearer <apiKey>, the CSRF header and the body', async () => {
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

    const result = await claimIdentity(
      'sk-claim',
      { login: 'carol', displayName: 'Carol', password: 'password123' },
      fetchImpl as typeof fetch,
    );

    expect(result.user.login).toBe('carol');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/auth/claim');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-claim');
    expect((init.headers as Record<string, string>)['x-requested-with']).toBe('nexttime');
    expect(JSON.parse(init.body as string)).toEqual({
      login: 'carol',
      displayName: 'Carol',
      password: 'password123',
    });
  });

  it('throws a capability_error HttpError carrying the wire code on {ok:false}', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(409, { ok: false, error: { code: 'already_claimed', message: 'nope' } }),
    );
    const err = await claimIdentity(
      'sk-claim',
      { login: 'carol', displayName: 'Carol', password: 'password123' },
      fetchImpl as typeof fetch,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe('already_claimed');
  });
});

describe('bindApiKey', () => {
  it('POSTs {apiKey} to /api/auth/bind-api-key with the CSRF header and credentials:same-origin', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        ok: true,
        result: {
          user: {
            id: 'u1',
            login: 'admin',
            displayName: 'Admin',
            platformRole: 'admin',
            mustChangePassword: false,
          },
          memberships: [{ workspaceId: 'ws-1', workspaceName: 'Acme', principalId: 'p1', role: 'owner' }],
        },
      }),
    );

    const result = await bindApiKey('sk-bind', fetchImpl as typeof fetch);

    expect(result.memberships).toHaveLength(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/auth/bind-api-key');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect((init.headers as Record<string, string>)['x-requested-with']).toBe('nexttime');
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(JSON.parse(init.body as string)).toEqual({ apiKey: 'sk-bind' });
  });

  it('throws a capability_error HttpError carrying the wire code on {ok:false}', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(409, { ok: false, error: { code: 'already_member', message: 'nope' } }),
    );
    const err = await bindApiKey('sk-bind', fetchImpl as typeof fetch).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe('already_member');
  });
});

describe('login', () => {
  it('POSTs {login,password} to /api/auth/login', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(401, { ok: false, error: { code: 'bad_credentials', message: 'nope' } }),
    );
    const err = await login({ login: 'a', password: 'b' }, fetchImpl as typeof fetch).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe('bad_credentials');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/auth/login');
    expect(JSON.parse(init.body as string)).toEqual({ login: 'a', password: 'b' });
  });
});

describe('logout', () => {
  it('POSTs to /api/auth/logout with no body other than {}', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { ok: true, result: { loggedOut: true } }),
    );
    const result = await logout(fetchImpl as typeof fetch);
    expect(result).toEqual({ loggedOut: true });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({});
  });
});

describe('getMe', () => {
  it('GETs /api/auth/me and throws unauthorized as a capability_error HttpError', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(401, { ok: false, error: { code: 'unauthorized', message: 'unauthorized' } }),
    );
    const err = await getMe(fetchImpl as typeof fetch).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe('unauthorized');
  });
});

describe('patchMe / changePassword', () => {
  it('PATCHes /api/auth/me with the new displayName', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        ok: true,
        result: {
          user: {
            id: 'u1',
            login: 'a',
            displayName: 'New Name',
            platformRole: 'user',
            mustChangePassword: false,
          },
        },
      }),
    );
    const result = await patchMe({ displayName: 'New Name' }, fetchImpl as typeof fetch);
    expect(result.user.displayName).toBe('New Name');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/auth/me');
    expect(init.method).toBe('PATCH');
  });

  it('POSTs /api/auth/password and surfaces bad_credentials on a wrong current password', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(401, { ok: false, error: { code: 'bad_credentials', message: 'nope' } }),
    );
    const err = await changePassword(
      { currentPassword: 'old', newPassword: 'newnewnew' },
      fetchImpl as typeof fetch,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe('bad_credentials');
  });
});
