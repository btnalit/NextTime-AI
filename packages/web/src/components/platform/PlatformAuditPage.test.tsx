// @vitest-environment jsdom
import type { PlatformAuditRecordWire, UserWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { PlatformAuditPage } from './PlatformAuditPage.js';

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

function renderPage(http: CapabilityCaller) {
  return render(
    <PermissionsProvider>
      <PlatformAuditPage http={http} />
    </PermissionsProvider>,
  );
}

function row(overrides: Partial<PlatformAuditRecordWire> = {}): PlatformAuditRecordWire {
  return {
    id: 'audit-1',
    action: 'create_user',
    actorUserId: 'u-admin',
    actorLogin: 'admin',
    resourceType: 'user',
    resourceId: 'u-2',
    payload: { login: 'bob' },
    createdAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  };
}

function user(overrides: Partial<UserWire> = {}): UserWire {
  return {
    id: 'u-admin',
    login: 'admin',
    displayName: 'Administrator',
    platformRole: 'admin',
    status: 'active',
    hasPassword: true,
    mustChangePassword: false,
    dailyCallLimit: null,
    monthlyTokenBudget: null,
    lastLoginAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    memberships: [],
    ...overrides,
  };
}

describe('PlatformAuditPage', () => {
  it('queries with a default limit of 50 and renders action/actor/resource rows', async () => {
    const http = scriptedHttp({
      platform_audit_query: (params) => {
        expect(params).toEqual({ limit: 50 });
        return { items: [row()] };
      },
    });
    renderPage(http);

    const list = await screen.findByTestId('platform-audit-list');
    expect(list.textContent).toContain('create_user');
    expect(list.textContent).toContain('admin');
    expect(list.textContent).toContain('user:u-2');
  });

  it('applying the action/actorUserId filters re-queries with only the non-empty ones', async () => {
    const http = scriptedHttp({
      platform_audit_query: () => ({ items: [] }),
    });
    renderPage(http);
    await screen.findByTestId('platform-audit-empty');

    const form = screen.getByTestId('platform-audit-filter-form');
    fireEvent.change(within(form).getByLabelText('动作'), {
      target: { value: 'update_platform_settings' },
    });
    fireEvent.click(within(form).getByRole('button', { name: '应用' }));

    await waitFor(() =>
      expect(http.calls.at(-1)).toEqual({
        name: 'platform_audit_query',
        params: { limit: 50, action: 'update_platform_settings' },
      }),
    );
  });

  it('shows a "加载更多" button when nextCursor is present, and appends the next page', async () => {
    const http = scriptedHttp({
      platform_audit_query: (params) =>
        (params as { cursor?: string })?.cursor
          ? { items: [row({ id: 'audit-2', action: 'set_user_status' })] }
          : { items: [row()], nextCursor: 'c-1' },
    });
    renderPage(http);
    await screen.findByTestId('platform-audit-list');

    const loadMore = screen.getByRole('button', { name: /加载更多/ });
    fireEvent.click(loadMore);

    await waitFor(() => expect(screen.getAllByTestId('platform-audit-row')).toHaveLength(2));
  });

  it('shows an error banner with retry on failure', async () => {
    const http = scriptedHttp({
      platform_audit_query: () => Promise.reject(new HttpError('network', 'boom')),
    });
    renderPage(http);
    await screen.findByTestId('platform-audit-error');
  });

  it('AU1: the actor filter is a <select> over list_users, and a row whose actor has no login resolves through the same directory (never a bare id)', async () => {
    const http = scriptedHttp({
      list_users: () => ({ items: [user()] }),
      platform_audit_query: () => ({
        items: [
          row({
            actorLogin: null,
            resourceId: '12345678-abcd-4321-8888-000000000000',
          }),
        ],
      }),
    });
    renderPage(http);

    const select = await screen.findByTestId('platform-audit-actor-select');
    expect(within(select).getByRole('option', { name: 'Administrator (admin)' })).toBeDefined();
    expect(screen.queryByTestId('platform-audit-actor-input')).toBeNull();

    const list = await screen.findByTestId('platform-audit-list');
    // The row's own actorUserId ('u-admin') resolves through list_users, not a truncated id.
    expect(list.textContent).toContain('Administrator (admin)');
    // resourceId is truncated (shortId), never the full UUID.
    expect(list.textContent).toContain('user:12345678');
    expect(list.textContent).not.toContain('12345678-abcd-4321-8888-000000000000');
  });

  it('PA1/S11: pure reads (mode:observe) are hidden by default; "Show reads" reveals them', async () => {
    const http = scriptedHttp({
      list_users: () => ({ items: [] }),
      platform_audit_query: () => ({
        items: [
          row({ id: 'audit-write', action: 'create_user' }),
          row({ id: 'audit-read', action: 'list_users' }),
        ],
      }),
    });
    renderPage(http);

    const list = await screen.findByTestId('platform-audit-list');
    expect(within(list).getAllByTestId('platform-audit-row')).toHaveLength(1);
    expect(list.textContent).toContain('create_user');
    expect(list.textContent).not.toContain('list_users');
    expect(screen.getByTestId('platform-audit-hidden-reads-note').textContent).toContain('1');

    fireEvent.click(
      screen
        .getByTestId('platform-audit-show-reads-toggle')
        .querySelector('input') as HTMLInputElement,
    );
    await waitFor(() =>
      expect(
        within(screen.getByTestId('platform-audit-list')).getAllByTestId('platform-audit-row'),
      ).toHaveLength(2),
    );
  });

  it('S11 fix (CI #288/#290): when every loaded row is a read, the empty state (not a blank page) shows and "Show reads" reveals it', async () => {
    const http = scriptedHttp({
      list_users: () => ({ items: [] }),
      platform_audit_query: () => ({ items: [row({ id: 'audit-read', action: 'list_users' })] }),
    });
    renderPage(http);

    const empty = await screen.findByTestId('platform-audit-empty');
    expect(empty.textContent).toContain('1');
    expect(screen.queryByTestId('platform-audit-list')).toBeNull();
    expect(screen.queryByTestId('platform-audit-row')).toBeNull();

    fireEvent.click(within(empty).getByRole('button', { name: /显示读操作|Show reads/ }));
    await waitFor(() => expect(screen.getAllByTestId('platform-audit-row')).toHaveLength(1));
    expect(screen.queryByTestId('platform-audit-empty')).toBeNull();
  });

  it('renders an unattributed-actor row (遗留 54: an operator-CLI purge with no resolvable administrator) with a clear label, never blank or "null"', async () => {
    const http = scriptedHttp({
      platform_audit_query: () => ({
        items: [
          row({
            id: 'audit-unattributed',
            action: 'platform.workspace_purged',
            actorUserId: null,
            actorLogin: null,
            resourceType: 'workspace',
            resourceId: 'ws-1',
            payload: { attributedActor: false },
          }),
        ],
      }),
    });
    renderPage(http);

    const list = await screen.findByTestId('platform-audit-list');
    expect(list.textContent).toContain('主机操作员（未署名）');
    expect(list.textContent).not.toContain('null');
  });
});
