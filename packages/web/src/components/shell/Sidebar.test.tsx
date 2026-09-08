// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
          onForgetKey={vi.fn()}
        />,
      );
      expect(screen.getByTestId('nav-members')).toBeTruthy();
      expect(screen.getByTestId('nav-audit')).toBeTruthy();
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
          onForgetKey={vi.fn()}
        />,
      );
      expect(screen.queryByTestId('nav-members')).toBeNull();
      expect(screen.queryByTestId('nav-audit')).toBeNull();
      // 工作 Work (including 我的智能体, S3.13's placeholder) is always visible.
      expect(screen.getByTestId('nav-chats')).toBeTruthy();
      expect(screen.getByTestId('nav-agent')).toBeTruthy();
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
        onForgetKey={vi.fn()}
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
        onForgetKey={vi.fn()}
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
        onForgetKey={vi.fn()}
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
        onForgetKey={vi.fn()}
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
        onForgetKey={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('3 pending approvals').textContent).toBe('3');
  });
});
