// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from './Sidebar.js';

afterEach(cleanup);

describe('Sidebar', () => {
  it('shows 治理 Governance for an unknown or owner/operator role, hides it only for a proven member', () => {
    for (const role of ['unknown', 'owner', 'operator+'] as const) {
      const { unmount } = render(
        <Sidebar
          active="chats"
          pendingCount={null}
          wsStatus="connected"
          workspaceName="Acme"
          inferredRole={role}
          onForgetKey={vi.fn()}
        />,
      );
      expect(screen.getByTestId('nav-members')).toBeTruthy();
      expect(screen.getByTestId('nav-audit')).toBeTruthy();
      unmount();
    }

    render(
      <Sidebar
        active="chats"
        pendingCount={null}
        wsStatus="connected"
        workspaceName="Acme"
        inferredRole="member"
        onForgetKey={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('nav-members')).toBeNull();
    expect(screen.queryByTestId('nav-audit')).toBeNull();
    // 工作 Work (including 我的智能体, S3.13's placeholder) is always visible.
    expect(screen.getByTestId('nav-chats')).toBeTruthy();
    expect(screen.getByTestId('nav-agent')).toBeTruthy();
  });

  it('shows the workspace name and a role badge naming the inferred role', () => {
    render(
      <Sidebar
        active="chats"
        pendingCount={null}
        wsStatus="connected"
        workspaceName="Acme Workspace"
        inferredRole="owner"
        onForgetKey={vi.fn()}
      />,
    );
    expect(screen.getByText('Acme Workspace')).toBeTruthy();
    const badge = screen.getByTestId('role-badge');
    expect(badge.textContent).toBe('Owner');
  });

  it('marks the active section current for a11y/highlight', () => {
    render(
      <Sidebar
        active="catalog"
        pendingCount={null}
        wsStatus="connected"
        workspaceName="Acme"
        inferredRole="owner"
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
        inferredRole="owner"
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
        inferredRole="owner"
        onForgetKey={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('3 pending approvals').textContent).toBe('3');
  });
});
