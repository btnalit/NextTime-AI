// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { WireUser } from '../../lib/auth-api.js';
import { type CapabilityCaller, SILENT_PUSH_SOURCE } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { AppShell, type AppShellProps } from './AppShell.js';

afterEach(cleanup);

function scriptedHttp(
  handlers: Record<string, (params: unknown) => unknown | Promise<unknown>>,
): CapabilityCaller & { readonly calls: { readonly name: string; readonly params: unknown }[] } {
  const calls: { name: string; params: unknown }[] = [];
  return {
    calls,
    call: vi.fn(async (name: string, params?: unknown) => {
      calls.push({ name, params });
      const handler = handlers[name];
      if (!handler) throw new Error(`unscripted capability ${name}`);
      return handler(params);
    }) as CapabilityCaller['call'],
  };
}

function workspace(role: string) {
  return {
    id: 'ws-1',
    name: 'Acme',
    createdAt: '2026-01-01T00:00:00Z',
    principalCount: 2,
    gatekeeperCount: 1,
    caller: { id: 'p-1', role, displayName: 'Alice (principal)', kind: 'human' },
  };
}

const ADMIN: WireUser = {
  id: 'u-1',
  login: 'admin',
  displayName: 'Platform Admin',
  platformRole: 'admin',
  mustChangePassword: false,
};

/** The three reads the shell makes for every session, scripted to a plain owner. */
function baseHandlers(role = 'owner') {
  return {
    get_workspace: () => workspace(role),
    list_pending: () => ({ items: [{ id: 'ar-1' }, { id: 'ar-2' }] }),
    platform_overview: () => ({ version: { kernel: '0.13.2 (0fa5a1e)' } }),
  };
}

function renderShell(http: CapabilityCaller, overrides: Partial<AppShellProps> = {}) {
  return render(
    <PermissionsProvider>
      <AppShell
        active="chats"
        http={http}
        pushes={SILENT_PUSH_SOURCE}
        authMode="cookie"
        onLogout={vi.fn()}
        selectedWorkspaceId="ws-1"
        {...overrides}
      >
        <div data-testid="page-body">page</div>
      </AppShell>
    </PermissionsProvider>,
  );
}

/** C22 (docs/console-completion-plan.md §2b, §5.9 "壳与导航"): the shell wires the sidebar's
 *  three groups, the footer version / user, and the pending badge from its own reads. */
describe('AppShell', () => {
  it('admin cookie session: 使用 / 治理 / 平台 groups, real kernel version and the user in the footer', async () => {
    const http = scriptedHttp(baseHandlers());
    renderShell(http, { platformRole: 'admin', user: ADMIN });

    expect(screen.getByTestId('page-body')).toBeTruthy();
    expect(screen.getByTestId('nav-section-use')).toBeTruthy();
    expect(screen.getByTestId('nav-section-govern')).toBeTruthy();
    expect(screen.getByTestId('nav-section-platform')).toBeTruthy();
    expect(screen.getByTestId('nav-platformWorkspaces')).toBeTruthy();

    const version = await screen.findByTestId('kernel-version');
    expect(version.textContent).toBe('0.13.2 (0fa5a1e)');
    expect(http.calls.some((call) => call.name === 'platform_overview')).toBe(true);

    // The cookie user wins over the principal's display name.
    const user = screen.getByTestId('current-user');
    expect(user.textContent).toContain('Platform Admin');
    expect(user.getAttribute('title')).toBe('Platform Admin (admin)');

    // The workspace name and the authoritative role badge come from get_workspace.
    await waitFor(() => expect(screen.getByText('Acme')).toBeTruthy());
    expect(screen.getByTestId('role-badge').textContent).toContain('Owner');
    // Pending badge from list_pending.
    await waitFor(() =>
      expect(within(screen.getByTestId('nav-approvals')).getByText('2')).toBeTruthy(),
    );
    expect(screen.getByRole('button', { name: /登出 Sign out/ })).toBeTruthy();
  });

  it('non-admin user: no 平台 group and platform_overview is never read', async () => {
    const http = scriptedHttp(baseHandlers('operator'));
    renderShell(http, {
      platformRole: 'user',
      user: { ...ADMIN, login: 'bob', displayName: 'Bob', platformRole: 'user' },
    });
    await waitFor(() => expect(screen.getByText('Acme')).toBeTruthy());
    expect(screen.queryByTestId('nav-section-platform')).toBeNull();
    expect(screen.getByTestId('nav-section-govern')).toBeTruthy();
    expect(screen.queryByTestId('kernel-version')).toBeNull();
    expect(http.calls.some((call) => call.name === 'platform_overview')).toBe(false);
    expect(screen.getByTestId('current-user').textContent).toContain('Bob');
  });

  it('proven member: the 治理 group is hidden', async () => {
    const http = scriptedHttp(baseHandlers('member'));
    renderShell(http, { platformRole: 'user' });
    await waitFor(() => expect(screen.getByText('Acme')).toBeTruthy());
    expect(screen.queryByTestId('nav-section-govern')).toBeNull();
    expect(screen.getByTestId('nav-section-use')).toBeTruthy();
  });

  it('apiKey session: the footer falls back to the caller principal name and offers Forget key', async () => {
    const http = scriptedHttp(baseHandlers());
    renderShell(http, { authMode: 'apiKey', selectedWorkspaceId: undefined });
    const user = await screen.findByTestId('current-user');
    expect(user.textContent).toContain('Alice (principal)');
    expect(user.getAttribute('title')).toBe('Alice (principal)');
    expect(screen.getByRole('button', { name: /Forget key/ })).toBeTruthy();
    // apiKey always has a workspace in scope: 治理 shows for an owner.
    expect(screen.getByTestId('nav-section-govern')).toBeTruthy();
  });

  it('a failed platform_overview read leaves the footer without a version line', async () => {
    const http = scriptedHttp({
      ...baseHandlers(),
      platform_overview: () =>
        Promise.reject(new HttpError('capability_error', 'not permitted', 'forbidden')),
    });
    renderShell(http, { platformRole: 'admin', user: ADMIN });
    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'platform_overview')).toBe(true),
    );
    await waitFor(() => expect(screen.getByText('Acme')).toBeTruthy());
    expect(screen.queryByTestId('kernel-version')).toBeNull();
  });

  /** S8 W1-A3 (audit S2): ≤960px `useNarrowViewport` reports `true` and `AppShell` swaps
   *  `Sidebar` for `MobileTopBar` + `NavDrawer`. `window.matchMedia` does not exist in jsdom by
   *  default (`useNarrowViewport`'s own doc comment) — stub it to force the narrow branch. */
  describe('narrow viewport (S8 W1-A3, audit S2)', () => {
    const originalMatchMedia = window.matchMedia;

    afterEach(() => {
      window.matchMedia = originalMatchMedia;
    });

    function stubNarrow(): void {
      window.matchMedia = ((query: string) => ({
        matches: query.includes('960'),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      })) as typeof window.matchMedia;
    }

    it('renders MobileTopBar (not the wide aside) and opens the drawer from nav-open', async () => {
      stubNarrow();
      const http = scriptedHttp(baseHandlers());
      renderShell(http);
      // MobileTopBar's identity line combines product/workspace/role into one text node
      // ("NextTime AI · Acme · owner") — a regex matches the substring where an exact string
      // wouldn't (the wide Sidebar's `.sidebar-workspace` span, by contrast, holds only the name).
      await waitFor(() => expect(screen.getByText(/Acme/)).toBeTruthy());

      expect(document.querySelector('aside.sidebar')).toBeNull();
      expect(screen.queryByTestId('nav-section-use')).toBeNull();
      const opener = screen.getByTestId('nav-open');
      expect(opener).toBeTruthy();
      expect(screen.getByText('对话')).toBeTruthy(); // pageTitle for active="chats"

      expect(screen.queryByRole('dialog')).toBeNull();
      fireEvent.click(opener);
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByTestId('nav-chats')).toBeTruthy();
      expect(within(dialog).getByTestId('nav-section-use')).toBeTruthy();
    });

    it('closes the drawer when `active` changes (a simulated navigation)', async () => {
      stubNarrow();
      const http = scriptedHttp(baseHandlers());
      const { rerender } = renderShell(http);
      await waitFor(() => expect(screen.getByText(/Acme/)).toBeTruthy());
      fireEvent.click(screen.getByTestId('nav-open'));
      await screen.findByRole('dialog');

      rerender(
        <PermissionsProvider>
          <AppShell
            active="tasks"
            http={http}
            pushes={SILENT_PUSH_SOURCE}
            authMode="cookie"
            onLogout={vi.fn()}
            selectedWorkspaceId="ws-1"
          >
            <div data-testid="page-body">page</div>
          </AppShell>
        </PermissionsProvider>,
      );
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });
  });
});
