// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WireMembership } from '../../lib/auth-api.js';
import type { WorkspaceRole } from '../../lib/role.js';
import { Sidebar } from './Sidebar.js';

afterEach(cleanup);

const INFERRED_UNKNOWN: WorkspaceRole = { kind: 'inferred', role: 'unknown' };
const INFERRED_OWNER: WorkspaceRole = { kind: 'inferred', role: 'owner' };
const INFERRED_OPERATOR_PLUS: WorkspaceRole = { kind: 'inferred', role: 'operator+' };
const INFERRED_MEMBER: WorkspaceRole = { kind: 'inferred', role: 'member' };
const KNOWN_OWNER: WorkspaceRole = { kind: 'known', role: 'owner' };
const KNOWN_MEMBER: WorkspaceRole = { kind: 'known', role: 'member' };

describe('Sidebar', () => {
  it('shows 治理 Governance for an unknown or owner/operator role, hides it only for a proven member', () => {
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

  it('hides 治理 in cookie mode when no workspace is selected, even for a non-member role', () => {
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

  it('shows the 平台 group only for a platform admin, independent of workspace role', () => {
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
    expect(badge.textContent).toBe('Auditor');
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
    // `ws-status` keeps its exact text — e2e keys on it.
    expect(screen.getByTestId('ws-status').textContent).toBe('Connected');

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

    it('labels the sign-out button "Forget key" in apiKey mode and "登出 Sign out" in cookie mode', () => {
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
      expect(screen.getByRole('button', { name: 'Forget key' })).toBeTruthy();

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
      const signOut = screen.getByRole('button', { name: /登出 Sign out/ });
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
