// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WireMembership, WireUser } from '../lib/auth-api.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { AccountPage } from './AccountPage.js';

afterEach(cleanup);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function workspace(role: string) {
  return {
    id: 'ws-1',
    name: 'Acme',
    createdAt: '2026-01-01T00:00:00Z',
    principalCount: 2,
    gatekeeperCount: 1,
    caller: { id: 'p-owner', role, displayName: 'Owner', kind: 'human' },
  };
}

/** D3 (docs/console-redesign-plan-2026-09-25.md §7): a scripted `CapabilityCaller` for the
 *  "接 Claude Code / MCP" card (`HandleCard` in `AccountPage.tsx`) — same shape as `AccessPage.
 *  test.tsx`/`MembersPage.test.tsx`'s own `scriptedHttp`. `get_workspace` answers as an owner
 *  unless a test overrides it. */
function scriptedHttp(
  handlers: Record<string, (params: unknown) => unknown | Promise<unknown>>,
): CapabilityCaller & { readonly calls: { readonly name: string; readonly params: unknown }[] } {
  const calls: { name: string; params: unknown }[] = [];
  const base: Record<string, (params: unknown) => unknown | Promise<unknown>> = {
    get_workspace: () => workspace('owner'),
    list_gatekeepers: () => ({ items: [] }),
    ...handlers,
  };
  return {
    calls,
    call: vi.fn(async (name: string, params?: unknown) => {
      calls.push({ name, params });
      const handler = base[name];
      if (!handler) throw new Error(`unscripted capability ${name}`);
      return handler(params);
    }) as CapabilityCaller['call'],
  };
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

    fireEvent.change(screen.getByLabelText(/登录名/), { target: { value: 'carol' } });
    fireEvent.change(screen.getByLabelText(/显示名/), {
      target: { value: 'Carol' },
    });
    fireEvent.change(screen.getByLabelText(/^密码/), { target: { value: 'password123' } });
    fireEvent.change(screen.getByLabelText(/确认密码/), {
      target: { value: 'password123' },
    });
    fireEvent.click(screen.getByRole('button', { name: '设置密码' }));

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

    fireEvent.change(screen.getByLabelText(/登录名/), { target: { value: 'carol' } });
    fireEvent.change(screen.getByLabelText(/显示名/), {
      target: { value: 'Carol' },
    });
    fireEvent.change(screen.getByLabelText(/^密码/), { target: { value: 'password123' } });
    fireEvent.change(screen.getByLabelText(/确认密码/), {
      target: { value: 'password123' },
    });
    fireEvent.click(screen.getByRole('button', { name: '设置密码' }));

    await waitFor(() =>
      expect(screen.getByText(/该身份已经有密码了；请登出后用密码登录/)).toBeTruthy(),
    );
  });

  it('C4: rejects a login whose first character is not alphanumeric (shared LOGIN_PATTERN), and maps invalid_login', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(400, {
        ok: false,
        error: { code: 'invalid_login', message: 'login must match ...' },
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
    const submit = screen.getByRole('button', {
      name: '设置密码',
    }) as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText(/显示名/), { target: { value: 'Dot' } });
    fireEvent.change(screen.getByLabelText(/^密码/), { target: { value: 'password123' } });
    fireEvent.change(screen.getByLabelText(/确认密码/), {
      target: { value: 'password123' },
    });

    // `.dot` passed the page's old local pattern but the kernel's `normalizeLogin` refuses it.
    fireEvent.change(screen.getByLabelText(/登录名/), { target: { value: '.dot' } });
    expect(screen.getByText('登录名格式不正确')).toBeTruthy();
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/登录名/), { target: { value: 'dot' } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByText(/登录名格式不正确：3–64 位/)).toBeTruthy());
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

    fireEvent.change(screen.getByLabelText(/显示名/), {
      target: { value: 'New Name' },
    });
    fireEvent.click(screen.getByRole('button', { name: /保存/ }));

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

    fireEvent.change(screen.getByLabelText(/当前密码/), {
      target: { value: 'old' },
    });
    fireEvent.change(screen.getByLabelText(/^新密码/), {
      target: { value: 'newnewnew' },
    });
    fireEvent.change(screen.getByLabelText(/确认新密码/), {
      target: { value: 'newnewnew' },
    });
    fireEvent.click(screen.getByRole('button', { name: /更改密码/ }));

    await waitFor(() => expect(screen.getByText(/密码已更改/)).toBeTruthy());
    const [url] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/auth/password');
  });

  it('lists memberships read-only (workspace name + role)', () => {
    render(<AccountPage user={USER} memberships={MEMBERSHIPS} onUserChanged={vi.fn()} />);
    const list = screen.getByTestId('account-memberships');
    expect(list.textContent).toContain('Acme');
    // S8 W1-A10: the role tag is a bilingual label now (lib/labels.ts roleLabel); default zh-CN
    // renders '所有者'.
    expect(list.textContent).toContain('所有者');
  });

  // S8 W1-A11 (audit L2 "我的账户三个表单各一个"): display name / password / bind-API-key are
  // three independent forms on the same view — only the top-of-page display-name save stays ink
  // primary.
  it('L2: at most one ink primary button across the three independent forms', () => {
    render(
      <AccountPage
        user={USER}
        memberships={MEMBERSHIPS}
        onUserChanged={vi.fn()}
        onBound={vi.fn()}
      />,
    );
    const primaries = document.querySelectorAll('.btn-primary');
    expect(primaries).toHaveLength(1);
    expect(primaries[0]).toBe(screen.getByRole('button', { name: '保存' }));
    expect(screen.getByRole('button', { name: /更改密码/ }).className).not.toContain('btn-primary');
    expect(screen.getByRole('button', { name: '绑定' }).className).not.toContain('btn-primary');
  });
});

// D3 (docs/console-redesign-plan-2026-09-25.md §7): "接 Claude Code / MCP" moved here from 访问
// Access — `AccountPage`'s own `HandleCard`, gated exactly like the old inline card on Access.
describe('AccountPage: D3 Handle-issuance card', () => {
  it('renders for an owner once `http` is provided', async () => {
    const http = scriptedHttp({});
    render(
      <AccountPage user={USER} memberships={MEMBERSHIPS} onUserChanged={vi.fn()} http={http} />,
    );
    await screen.findByTestId('issue-own-handle-section');
    expect(screen.getByText('接 Claude Code / MCP')).toBeTruthy();
  });

  it('is absent for a non-owner (authoritative get_workspace.caller.role)', async () => {
    const http = scriptedHttp({ get_workspace: () => workspace('member') });
    render(
      <AccountPage user={USER} memberships={MEMBERSHIPS} onUserChanged={vi.fn()} http={http} />,
    );
    await waitFor(() => expect(http.calls.some((c) => c.name === 'get_workspace')).toBe(true));
    expect(screen.queryByTestId('issue-own-handle-section')).toBeNull();
  });

  it('is absent when no `http` is passed (no workspace in scope — platform-only admin, or the pre-session noWorkspace state)', () => {
    render(<AccountPage user={USER} memberships={MEMBERSHIPS} onUserChanged={vi.fn()} />);
    expect(screen.queryByTestId('issue-own-handle-section')).toBeNull();
    expect(screen.queryByText('接 Claude Code / MCP')).toBeNull();
  });
});
