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
      // 工作 Work (including 我的智能体/我的账户) is always visible.
      expect(screen.getByTestId('nav-chats')).toBeTruthy();
      expect(screen.getByTestId('nav-agent')).toBeTruthy();
      expect(screen.getByTestId('nav-account')).toBeTruthy();
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
