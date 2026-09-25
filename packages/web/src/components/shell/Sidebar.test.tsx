// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WireMembership } from '../../lib/auth-api.js';
import type { WorkspaceRole } from '../../lib/role.js';
import { MobileTopBar, NavDrawer, Sidebar } from './Sidebar.js';

afterEach(cleanup);

const INFERRED_UNKNOWN: WorkspaceRole = { kind: 'inferred', role: 'unknown' };
const INFERRED_OWNER: WorkspaceRole = { kind: 'inferred', role: 'owner' };
const INFERRED_OPERATOR_PLUS: WorkspaceRole = { kind: 'inferred', role: 'operator+' };
const INFERRED_MEMBER: WorkspaceRole = { kind: 'inferred', role: 'member' };
const KNOWN_OWNER: WorkspaceRole = { kind: 'known', role: 'owner' };
const KNOWN_MEMBER: WorkspaceRole = { kind: 'known', role: 'member' };

describe('Sidebar', () => {
  it('shows 治理', () => {
    for (const role of [INFERRED_UNKNOWN, INFERRED_OWNER, INFERRED_OPERATOR_PLUS, KNOWN_OWNER]) {
      const { unmount } = render(
        <Sidebar
          active="chats"
          pendingCount={null}
          wsStatus="connected"
          workspaceName="Acme"
          role={role}
          authMode="apiKey"
          onLogout={vi.fn()}
        />,
      );
      expect(screen.getByTestId('nav-members')).toBeTruthy();
      expect(screen.getByTestId('nav-audit')).toBeTruthy();
      const explorerLink = screen.getByTestId('nav-explorer');
      expect(explorerLink.getAttribute('href')).toBe('/explorer/');
      expect(explorerLink.getAttribute('target')).toBe('_blank');
      unmount();
    }

    for (const role of [INFERRED_MEMBER, KNOWN_MEMBER]) {
      const { unmount } = render(
        <Sidebar
          active="chats"
          pendingCount={null}
          wsStatus="connected"
          workspaceName="Acme"
          role={role}
          authMode="apiKey"
          onLogout={vi.fn()}
        />,
      );
      expect(screen.queryByTestId('nav-members')).toBeNull();
      expect(screen.queryByTestId('nav-audit')).toBeNull();
      expect(screen.queryByTestId('nav-explorer')).toBeNull();
      // 使用 Use (including 我的智能体/我的账户) is always visible.
      expect(screen.getByTestId('nav-chats')).toBeTruthy();
      expect(screen.getByTestId('nav-agent')).toBeTruthy();
      expect(screen.getByTestId('nav-account')).toBeTruthy();
      unmount();
    }
  });

  it('S6-C / S6-D: 图谱 is always in 使用; the third-party Explorer link hides once the probe says the bundle is not built', () => {
    const { unmount } = render(
      <Sidebar
        active="chats"
        pendingCount={null}
        wsStatus="connected"
        workspaceName="Acme"
        role={KNOWN_OWNER}
        authMode="apiKey"
        onLogout={vi.fn()}
        explorerAvailable={false}
      />,
    );
    expect(screen.getByTestId('nav-graph').getAttribute('href')).toBe('#/work/graph');
    expect(screen.queryByTestId('nav-explorer')).toBeNull();
    unmount();
    render(
      <Sidebar
        active="chats"
        pendingCount={null}
        wsStatus="connected"
        workspaceName="Acme"
        role={KNOWN_OWNER}
        authMode="apiKey"
        onLogout={vi.fn()}
        explorerAvailable={null}
      />,
    );
    // Still probing → shown (fail open, same as `true`).
    expect(screen.getByTestId('nav-explorer').getAttribute('href')).toBe('/explorer/');
  });

  it('hides 治理', () => {
    render(
      <Sidebar
        active="chats"
        pendingCount={null}
        wsStatus="connected"
        workspaceName="Acme"
        role={KNOWN_OWNER}
        authMode="cookie"
        onLogout={vi.fn()}
        selectedWorkspaceId={undefined}
      />,
    );
    expect(screen.queryByTestId('nav-members')).toBeNull();
    expect(screen.queryByTestId('nav-audit')).toBeNull();
    expect(screen.queryByTestId('nav-explorer')).toBeNull();
    // Neither the 治理 nor the 平台 group renders when nothing under them applies (S6-A0 §5.9:
    // three labelled groups 使用 / 治理 / 平台).
    expect(screen.queryByTestId('nav-section-govern')).toBeNull();
    expect(screen.queryByTestId('nav-section-platform')).toBeNull();
    expect(screen.queryByTestId('nav-platformWorkspaces')).toBeNull();
    expect(screen.getByTestId('nav-section-use')).toBeTruthy();
  });

  it('shows the 平台', () => {
    render(
      <Sidebar
        active="chats"
        pendingCount={null}
        wsStatus="connected"
        workspaceName="Acme"
        role={KNOWN_MEMBER}
        authMode="cookie"
        onLogout={vi.fn()}
        selectedWorkspaceId={undefined}
        platformRole="admin"
      />,
    );
    // A proven member with no workspace selected still gets none of the per-workspace pages...
    expect(screen.queryByTestId('nav-members')).toBeNull();
    expect(screen.queryByTestId('nav-explorer')).toBeNull();
    expect(screen.queryByTestId('nav-section-govern')).toBeNull();
    // ...but the whole 平台 group renders, overview first, carrying P-A2's platform 工作区 list:
    // an administrator configures workspaces they are not a member of.
    const platform = screen.getByTestId('nav-section-platform');
    expect(platform.querySelector('a')?.getAttribute('data-testid')).toBe('nav-platformOverview');
    expect(screen.getByTestId('nav-platformWorkspaces').getAttribute('href')).toBe(
      '#/platform/workspaces',
    );
    // ...and the rest of the platform-admin items.
    expect(screen.getByTestId('nav-platformUsers')).toBeTruthy();
    expect(screen.getByTestId('nav-platformIntegrations').getAttribute('href')).toBe(
      '#/platform/integrations',
    );
    expect(screen.getByTestId('nav-platformSettings')).toBeTruthy();
    expect(screen.getByTestId('nav-platformOverview')).toBeTruthy();
    expect(screen.getByTestId('nav-platformAudit')).toBeTruthy();
    // S8 W4 (audit U1 "两组的作用范围从未说明"): 平台 carries a "全平台" scope note.
    expect(screen.getByTestId('nav-section-platform-scope').textContent).toContain('全平台');
  });

  it('shows no platform-admin items for a non-admin platformRole, or an apiKey session (no platform user)', () => {
    for (const platformRole of ['user', undefined] as const) {
      const { unmount } = render(
        <Sidebar
          active="chats"
          pendingCount={null}
          wsStatus="connected"
          workspaceName="Acme"
          role={KNOWN_OWNER}
          authMode="apiKey"
          onLogout={vi.fn()}
          platformRole={platformRole}
        />,
      );
      expect(screen.queryByTestId('nav-platformUsers')).toBeNull();
      expect(screen.queryByTestId('nav-platformIntegrations')).toBeNull();
      expect(screen.queryByTestId('nav-platformSettings')).toBeNull();
      expect(screen.queryByTestId('nav-section-platform')).toBeNull();
      // P-A2's platform 工作区 list is admin-only too — the owner pages are not.
      expect(screen.queryByTestId('nav-platformWorkspaces')).toBeNull();
      // 治理 still shows — an apiKey session always has an implicit workspace.
      expect(screen.getByTestId('nav-section-govern')).toBeTruthy();
      expect(screen.getByTestId('nav-members')).toBeTruthy();
      // S8 W4 (audit U1 "两组的作用范围从未说明"): 治理 carries a "本工作区" scope note.
      expect(screen.getByTestId('nav-section-govern-scope').textContent).toContain('本工作区');
      unmount();
    }
  });

  it('shows the workspace name and an inferred-role bucket badge while the role is not yet known', () => {
    render(
      <Sidebar
        active="chats"
        pendingCount={null}
        wsStatus="connected"
        workspaceName="Acme Workspace"
        role={INFERRED_OWNER}
        authMode="apiKey"
        onLogout={vi.fn()}
      />,
    );
    expect(screen.getByText('Acme Workspace')).toBeTruthy();
    const badge = screen.getByTestId('role-badge');
    expect(badge.textContent).toBe('Owner');
  });

  it('shows the exact role from get_workspace.caller once it is known, via the shared role StatusChip', () => {
    render(
      <Sidebar
        active="chats"
        pendingCount={null}
        wsStatus="connected"
        workspaceName="Acme Workspace"
        role={{ kind: 'known', role: 'auditor' }}
        authMode="apiKey"
        onLogout={vi.fn()}
      />,
    );
    const badge = screen.getByTestId('role-badge');
    // S8 W1-A10: the role StatusChip is bilingual now; default zh-CN renders '审计员'.
    expect(badge.textContent).toBe('审计员');
  });

  it('renders the kernel version and current user in the footer only when known (S6-A0)', () => {
    const { rerender } = render(
      <Sidebar
        active="chats"
        pendingCount={null}
        wsStatus="connected"
        workspaceName="Acme"
        role={KNOWN_OWNER}
        authMode="cookie"
        onLogout={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('kernel-version')).toBeNull();
    expect(screen.queryByTestId('current-user')).toBeNull();
    // `ws-status` keeps its exact `data-status` (S8 W3 F1: the visible text is now bilingual via
    // `t()`, no longer a stable selector) — e2e keys on the attribute instead.
    expect(screen.getByTestId('ws-status').getAttribute('data-status')).toBe('connected');

    rerender(
      <Sidebar
        active="chats"
        pendingCount={null}
        wsStatus="connected"
        workspaceName="Acme"
        role={KNOWN_OWNER}
        authMode="cookie"
        onLogout={vi.fn()}
        kernelVersion="0.13.2"
        currentUser={{ displayName: 'Ada', login: 'ada' }}
      />,
    );
    expect(screen.getByTestId('kernel-version').textContent).toBe('0.13.2');
    expect(screen.getByTestId('current-user').textContent).toBe('Ada');
    expect(screen.getByTestId('current-user').getAttribute('title')).toBe('Ada (ada)');
  });

  it('marks the active section current for a11y/highlight', () => {
    render(
      <Sidebar
        active="catalog"
        pendingCount={null}
        wsStatus="connected"
        workspaceName="Acme"
        role={KNOWN_OWNER}
        authMode="apiKey"
        onLogout={vi.fn()}
      />,
    );
    expect(screen.getByTestId('nav-catalog').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('nav-chats').getAttribute('aria-current')).toBeNull();
  });

  it('shows the pending-approvals badge only on the Approvals item, and only when > 0', () => {
    const { rerender } = render(
      <Sidebar
        active="chats"
        pendingCount={0}
        wsStatus="connected"
        workspaceName="Acme"
        role={KNOWN_OWNER}
        authMode="apiKey"
        onLogout={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText(/pending approvals/)).toBeNull();

    rerender(
      <Sidebar
        active="chats"
        pendingCount={3}
        wsStatus="connected"
        workspaceName="Acme"
        role={KNOWN_OWNER}
        authMode="apiKey"
        onLogout={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('3 pending approvals').textContent).toBe('3');
  });

  describe('S4.1: sign-out label + workspace switcher', () => {
    const MEMBERSHIPS: readonly WireMembership[] = [
      { workspaceId: 'ws-1', workspaceName: 'Acme', principalId: 'p-1', role: 'owner' },
      { workspaceId: 'ws-2', workspaceName: 'Beta', principalId: 'p-2', role: 'member' },
    ];

    it('labels the sign-out button "清除密钥" in apiKey mode and "登出" in cookie mode', () => {
      const onLogout = vi.fn();
      const { rerender } = render(
        <Sidebar
          active="chats"
          pendingCount={null}
          wsStatus="connected"
          workspaceName="Acme"
          role={KNOWN_OWNER}
          authMode="apiKey"
          onLogout={onLogout}
        />,
      );
      expect(screen.getByRole('button', { name: '清除密钥' })).toBeTruthy();

      rerender(
        <Sidebar
          active="chats"
          pendingCount={null}
          wsStatus="connected"
          workspaceName="Acme"
          role={KNOWN_OWNER}
          authMode="cookie"
          onLogout={onLogout}
        />,
      );
      const signOut = screen.getByRole('button', { name: /登出/ });
      fireEvent.click(signOut);
      expect(onLogout).toHaveBeenCalledTimes(1);
    });

    it('renders no workspace switcher for apiKey mode or a single membership', () => {
      const { rerender } = render(
        <Sidebar
          active="chats"
          pendingCount={null}
          wsStatus="connected"
          workspaceName="Acme"
          role={KNOWN_OWNER}
          authMode="cookie"
          onLogout={vi.fn()}
          memberships={[MEMBERSHIPS[0] as WireMembership]}
          selectedWorkspaceId="ws-1"
        />,
      );
      expect(screen.queryByTestId('workspace-switcher')).toBeNull();

      rerender(
        <Sidebar
          active="chats"
          pendingCount={null}
          wsStatus="connected"
          workspaceName="Acme"
          role={KNOWN_OWNER}
          authMode="apiKey"
          onLogout={vi.fn()}
          memberships={MEMBERSHIPS}
          selectedWorkspaceId="ws-1"
        />,
      );
      expect(screen.queryByTestId('workspace-switcher')).toBeNull();
    });

    it('renders a switcher listing every membership when there is more than one, in cookie mode', () => {
      const onSwitchWorkspace = vi.fn();
      render(
        <Sidebar
          active="chats"
          pendingCount={null}
          wsStatus="connected"
          workspaceName="Acme"
          role={KNOWN_OWNER}
          authMode="cookie"
          onLogout={vi.fn()}
          memberships={MEMBERSHIPS}
          selectedWorkspaceId="ws-1"
          onSwitchWorkspace={onSwitchWorkspace}
        />,
      );
      const select = screen.getByTestId('workspace-switcher') as HTMLSelectElement;
      expect(select.value).toBe('ws-1');
      fireEvent.change(select, { target: { value: 'ws-2' } });
      expect(onSwitchWorkspace).toHaveBeenCalledWith('ws-2');
    });
  });
});

/** S8 W1-A3 (audit S2): the ≤960px replacement for the icon rail — `MobileTopBar` (the sticky row
 *  with the menu button) and `NavDrawer` (the `kit/sheet` holding `SidebarContent`, the same body
 *  `Sidebar` wraps in `<aside>`). */
describe('MobileTopBar', () => {
  it('renders the menu button (nav-open), the page title and workspace + role, and opens the drawer on click', () => {
    const onOpenMenu = vi.fn();
    render(
      <MobileTopBar
        pageTitle="对话"
        workspaceName="Acme"
        role={{ kind: 'known', role: 'owner' }}
        wsStatus="connected"
        onOpenMenu={onOpenMenu}
      />,
    );
    expect(screen.getByText('对话')).toBeTruthy();
    // S8 W1-A10: a known role is bilingual via roleLabel() now; default zh-CN renders '所有者'.
    expect(screen.getByText(/NextTime AI · Acme · 所有者/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('nav-open'));
    expect(onOpenMenu).toHaveBeenCalledTimes(1);
  });

  it('falls back to the inferred-role label when the role is not yet known', () => {
    render(
      <MobileTopBar
        pageTitle="对话"
        workspaceName="Acme"
        role={{ kind: 'inferred', role: 'operator+' }}
        wsStatus="connected"
        onOpenMenu={vi.fn()}
      />,
    );
    expect(screen.getByText(/NextTime AI · Acme · Operator\+/)).toBeTruthy();
  });

  // S8 W1-A3 follow-up (audit S2, journey ③ narrow-screen fix): ws-status is invisible at ≤960px
  // unless MobileTopBar carries its own copy — every spec's login helper and this suite's own
  // AppShell.test.tsx both wait on it.
  it('carries the sole ws-status testid at this width, reflecting the live connection state', () => {
    const { rerender } = render(
      <MobileTopBar
        pageTitle="对话"
        workspaceName="Acme"
        role={KNOWN_OWNER}
        wsStatus="connected"
        onOpenMenu={vi.fn()}
      />,
    );
    expect(screen.getByTestId('ws-status').getAttribute('data-status')).toBe('connected');

    rerender(
      <MobileTopBar
        pageTitle="对话"
        workspaceName="Acme"
        role={KNOWN_OWNER}
        wsStatus="reconnecting"
        onOpenMenu={vi.fn()}
      />,
    );
    expect(screen.getByTestId('ws-status').getAttribute('data-status')).toBe('reconnecting');
  });
});

const NAV_DRAWER_BASE = {
  active: 'chats' as const,
  pendingCount: null,
  wsStatus: 'connected' as const,
  workspaceName: 'Acme',
  role: KNOWN_OWNER,
  authMode: 'cookie' as const,
  selectedWorkspaceId: 'ws-1',
  onLogout: vi.fn(),
  kernelVersion: '0.16.2',
  currentUser: { displayName: 'Ada', login: 'ada' },
};

describe('NavDrawer', () => {
  it('renders nothing until open, then the full labelled nav — groups, workspace, current user, sign-out', () => {
    const { rerender } = render(
      <NavDrawer open={false} onOpenChange={vi.fn()} {...NAV_DRAWER_BASE} />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByTestId('nav-chats')).toBeNull();

    rerender(<NavDrawer open onOpenChange={vi.fn()} {...NAV_DRAWER_BASE} />);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByTestId('nav-section-use')).toBeTruthy();
    expect(screen.getByTestId('nav-section-govern')).toBeTruthy();
    expect(screen.getByTestId('nav-chats')).toBeTruthy();
    expect(screen.getByText('Acme')).toBeTruthy();
    expect(screen.getByTestId('current-user').textContent).toContain('Ada');
    expect(screen.getByRole('button', { name: /登出/ })).toBeTruthy();
  });

  /** The real ≤960px pairing — `MobileTopBar` always mounted, `NavDrawer` toggled by its own
   *  `nav-open` button — the way `AppShell` actually renders them. */
  function TopBarPlusDrawer() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <MobileTopBar
          pageTitle="对话"
          workspaceName="Acme"
          role={KNOWN_OWNER}
          wsStatus="connected"
          onOpenMenu={() => setOpen(true)}
        />
        <NavDrawer open={open} onOpenChange={setOpen} {...NAV_DRAWER_BASE} />
      </>
    );
  }

  // Focus-return-to-trigger on close is Radix Dialog's own built-in behavior (NavDrawer doesn't
  // hand-roll any focus management — `kit/sheet`'s doc comment); it is not asserted here by
  // `document.activeElement` equality because it depends on `document.hasFocus()`, which jsdom
  // always reports `false` (verified: `new JSDOM(...).window.document.hasFocus()` → `false`,
  // independent of this component), so Radix's own restoration never fires under vitest/jsdom
  // regardless of correct usage — real-browser behavior is unaffected. What *is* testable here:
  // Escape closes the drawer.
  it('closes on Escape', async () => {
    render(<TopBarPlusDrawer />);
    fireEvent.click(screen.getByTestId('nav-open'));
    await screen.findByRole('dialog');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('closes when the caller flips `open` to false (AppShell does this on navigation)', async () => {
    const { rerender } = render(<NavDrawer open onOpenChange={vi.fn()} {...NAV_DRAWER_BASE} />);
    await screen.findByRole('dialog');
    rerender(<NavDrawer open={false} onOpenChange={vi.fn()} {...NAV_DRAWER_BASE} />);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  // S8 W1-A3 follow-up (audit S2): the coordinator's own success criterion — a duplicate
  // `ws-status` would make `getByTestId('ws-status')` ambiguous for every journey/login helper
  // that waits on it, at exactly the width (≤960px) that drawer opens.
  it('never duplicates the ws-status testid — MobileTopBar keeps the sole one, open or closed', async () => {
    render(<TopBarPlusDrawer />);
    expect(screen.getAllByTestId('ws-status')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('nav-open'));
    await screen.findByRole('dialog');
    // Open: MobileTopBar's copy is still the only *testid*-carrying one — the drawer's own
    // connection line (SidebarContent's footer) still renders visually (`wsStatusTestId={false}`
    // drops only the attribute), so this also proves it didn't just vanish.
    expect(screen.getAllByTestId('ws-status')).toHaveLength(1);
    const dialog = screen.getByRole('dialog');
    expect(dialog.querySelector('.conn-status-label')?.getAttribute('data-status')).toBe(
      'connected',
    );
  });
});
