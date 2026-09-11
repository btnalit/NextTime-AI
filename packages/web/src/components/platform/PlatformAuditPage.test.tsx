// @vitest-environment jsdom
import type { PlatformAuditRecordWire } from '@nexttime/shared';
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
    fireEvent.change(within(form).getByLabelText('Action'), {
      target: { value: 'update_platform_settings' },
    });
    fireEvent.click(within(form).getByRole('button', { name: '应用 Apply' }));

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

    const loadMore = screen.getByRole('button', { name: /加载更多 Load more/ });
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
});
