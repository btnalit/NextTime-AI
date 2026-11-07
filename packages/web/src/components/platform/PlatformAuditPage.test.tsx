// @vitest-environment jsdom
import type { PlatformAuditRecordWire, UserWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import {
  comboboxOptionTexts,
  findComboboxOption,
  pickComboboxOption,
} from '../kit/combobox.test-helpers.js';
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
    actingThrough: null,
    actingSessionId: null,
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
        expect(params).toEqual({ limit: 50, excludeReads: true });
        return { items: [row()] };
      },
    });
    renderPage(http);

    const list = await screen.findByTestId('platform-audit-list');
    expect(list.textContent).toContain('create_user');
    expect(list.textContent).toContain('admin');
    // Legacy sweep (console batch, 2026-10-16): the resource type reads as a label.
    expect(list.textContent).toContain('用户:u-2');
    expect(list.textContent).not.toContain('user:u-2');
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
        params: { limit: 50, action: 'update_platform_settings', excludeReads: true },
      }),
    );
  });

  it('legacy 666: every row says what its act came through, and 经由 filters by it from a list', async () => {
    const http = scriptedHttp({
      platform_audit_query: () => ({
        items: [
          row({ id: 'a-person', actingThrough: 'person' }),
          row({ id: 'a-system', actingThrough: 'system' }),
          row({ id: 'a-agent', actingThrough: 'admin_agent_session', actingSessionId: 's-1' }),
        ],
      }),
    });
    renderPage(http);
    const rows = await screen.findAllByTestId('platform-audit-row');
    expect(within(rows[0] as HTMLElement).getByTestId('audit-acting-through').textContent).toBe(
      '经由 本人',
    );
    expect(within(rows[1] as HTMLElement).getByTestId('audit-acting-through').textContent).toBe(
      '经由 平台后台任务',
    );
    expect(within(rows[2] as HTMLElement).getByTestId('audit-admin-agent')).toBeTruthy();

    const form = screen.getByTestId('platform-audit-filter-form');
    const through = within(form).getByLabelText('经由') as HTMLSelectElement;
    expect(through.tagName).toBe('SELECT');
    fireEvent.change(through, { target: { value: 'admin_agent_session' } });
    fireEvent.click(within(form).getByRole('button', { name: '应用' }));
    await waitFor(() =>
      expect(http.calls.at(-1)).toEqual({
        name: 'platform_audit_query',
        params: { limit: 50, actingThrough: 'admin_agent_session', excludeReads: true },
      }),
    );
    // 管理员智能体 also keeps the older rows whose payload names the agent, and says so.
    expect(screen.getByTestId('platform-audit-acting-through-note').textContent).toContain(
      '负载里标明由管理员智能体代为',
    );
    // Back to 任意: the param goes.
    fireEvent.change(through, { target: { value: '' } });
    fireEvent.click(within(form).getByRole('button', { name: '应用' }));
    await waitFor(() =>
      expect(http.calls.at(-1)).toEqual({
        name: 'platform_audit_query',
        params: { limit: 50, excludeReads: true },
      }),
    );
    expect(screen.queryByTestId('platform-audit-acting-through-note')).toBeNull();
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

  it('AU1: the actor filter picks from list_users, and a row whose actor has no login resolves through the same directory (never a bare id)', async () => {
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
    await findComboboxOption(select, 'Administrator (admin)');
    expect(screen.queryByTestId('platform-audit-actor-input')).toBeNull();
    // Legacy 153 ①: one control — no separate search box.
    expect(screen.queryByTestId('platform-audit-actor-query')).toBeNull();

    const list = await screen.findByTestId('platform-audit-list');
    // The row's own actorUserId ('u-admin') resolves through list_users, not a truncated id.
    expect(list.textContent).toContain('Administrator (admin)');
    // resourceId is truncated (shortId), never the full UUID.
    expect(list.textContent).toContain('用户:12345678');
    expect(list.textContent).not.toContain('12345678-abcd-4321-8888-000000000000');
  });

  it('PA1/S11, legacy 669: pure reads are left out by the kernel by default; "Show reads" asks again with them', async () => {
    // The kernel's part: `excludeReads` leaves the read out.
    const http = scriptedHttp({
      list_users: () => ({ items: [] }),
      platform_audit_query: (params) => ({
        items: [
          row({ id: 'audit-write', action: 'create_user' }),
          ...((params as { excludeReads?: boolean }).excludeReads === true
            ? []
            : [row({ id: 'audit-read', action: 'list_users' })]),
        ],
      }),
    });
    renderPage(http);

    const list = await screen.findByTestId('platform-audit-list');
    expect(within(list).getAllByTestId('platform-audit-row')).toHaveLength(1);
    expect(list.textContent).toContain('create_user');
    expect(list.textContent).not.toContain('list_users');
    expect(screen.queryByTestId('platform-audit-hidden-reads-note')).toBeNull();

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
    expect(http.calls.filter((c) => c.name === 'platform_audit_query').at(-1)?.params).toEqual({
      limit: 50,
    });
  });

  it('legacy 628: a refused call says 被拦下 with its code; a refused read is shown as the kernel keeps it', async () => {
    // What the kernel answers `excludeReads` with (legacy 669): no plain read, the refused one kept.
    const http = scriptedHttp({
      list_users: () => ({ items: [] }),
      platform_audit_query: () => ({
        items: [
          row({ id: 'audit-ok', action: 'create_user' }),
          row({
            id: 'audit-refused-write',
            action: 'set_user_status',
            payload: { outcome: 'refused', refusal: { code: 'admin_agent_only', status: 403 } },
          }),
          row({
            id: 'audit-refused-read',
            action: 'list_users',
            payload: { outcome: 'refused', refusal: { code: 'forbidden', status: 403 } },
          }),
          row({
            id: 'audit-refused-nocode',
            action: 'platform.workspace_purged',
            payload: { outcome: 'refused' },
          }),
        ],
      }),
    });
    renderPage(http);

    const list = await screen.findByTestId('platform-audit-list');
    const rows = within(list).getAllByTestId('platform-audit-row');
    const rowOf = (action: string) => {
      const found = rows.find((r) =>
        Array.from(r.querySelectorAll('.mono')).some((el) => el.textContent === action),
      );
      if (!found) throw new Error(`no row for ${action}`);
      return found;
    };
    expect(rows).toHaveLength(4);
    // Nothing more is hidden in the browser: the page counts no reads of its own.
    expect(screen.queryByTestId('platform-audit-hidden-reads-note')).toBeNull();

    expect(within(rowOf('create_user')).queryByTestId('audit-refused')).toBeNull();
    const write = rowOf('set_user_status');
    expect(within(write).getByTestId('audit-refused').textContent).toBe('被拦下');
    expect(within(write).getByTestId('audit-refused-code').textContent).toBe('admin_agent_only');
    // UX P2-1 on #964: the chip and its code wrap as one group, in a title row that wraps.
    const group = within(write).getByTestId('audit-refused').parentElement;
    expect(group?.className).toBe('audit-refused');
    expect(group?.contains(within(write).getByTestId('audit-refused-code'))).toBe(true);
    expect(group?.parentElement?.classList.contains('audit-row-title')).toBe(true);
    expect(within(rowOf('list_users')).getByTestId('audit-refused-code').textContent).toBe(
      'forbidden',
    );
    const noCode = rowOf('platform.workspace_purged');
    expect(within(noCode).getByTestId('audit-refused')).toBeTruthy();
    expect(within(noCode).queryByTestId('audit-refused-code')).toBeNull();
  });

  it('legacy 669 (#501 P3-1): applying a read by name shows the reads', async () => {
    const http = scriptedHttp({
      list_users: () => ({ items: [] }),
      platform_audit_query: () => ({ items: [] }),
    });
    renderPage(http);
    await screen.findByTestId('platform-audit-empty');
    const toggle = screen
      .getByTestId('platform-audit-show-reads-toggle')
      .querySelector('input') as HTMLInputElement;
    const form = screen.getByTestId('platform-audit-filter-form');
    fireEvent.change(within(form).getByLabelText('动作'), { target: { value: 'list_users' } });
    fireEvent.click(within(form).getByRole('button', { name: '应用' }));
    await waitFor(() =>
      expect(http.calls.at(-1)).toEqual({
        name: 'platform_audit_query',
        params: { limit: 50, action: 'list_users' },
      }),
    );
    expect(toggle.checked).toBe(true);
  });

  it('legacy 669: with every row a read, the empty state offers the reads and "Show reads" asks again', async () => {
    const http = scriptedHttp({
      list_users: () => ({ items: [] }),
      platform_audit_query: (params) =>
        (params as { excludeReads?: boolean }).excludeReads === true
          ? { items: [] }
          : { items: [row({ id: 'audit-read', action: 'list_users' })] },
    });
    renderPage(http);

    const empty = await screen.findByTestId('platform-audit-empty');
    expect(empty.textContent).toMatch(/读操作默认不列出/);
    expect(screen.queryByTestId('platform-audit-list')).toBeNull();
    expect(screen.queryByTestId('platform-audit-row')).toBeNull();

    fireEvent.click(within(empty).getByRole('button', { name: /显示读操作|Show reads/ }));
    await waitFor(() => expect(screen.getAllByTestId('platform-audit-row')).toHaveLength(1));
    expect(screen.queryByTestId('platform-audit-empty')).toBeNull();
    // Legacy 479 (same class): the button went away; focus is on the toggle that now says so.
    const toggle = screen.getByTestId('platform-audit-show-reads-toggle').querySelector('input');
    expect(document.activeElement).toBe(toggle);
    expect(toggle?.checked).toBe(true);
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

  it('field-inventory §11: the action box suggests platform-scope capability names and platform lifecycle actions only', async () => {
    const http = scriptedHttp({
      list_users: () => ({ items: [] }),
      platform_audit_query: () => ({ items: [] }),
    });
    renderPage(http);
    await screen.findByTestId('platform-audit-empty');
    const input = screen.getByLabelText('动作') as HTMLInputElement;
    expect(input.getAttribute('list')).toBe('platform-audit-action-options');
    const values = Array.from(
      screen.getByTestId('platform-audit-action-options').querySelectorAll('option'),
    ).map((option) => option.getAttribute('value'));
    expect(values).toContain('create_user');
    expect(values).toContain('platform_audit_query');
    expect(values).toContain('platform.workspace_purged');
    expect(values).toContain('workspace.created');
    // A workspace-scope capability never lands in the platform stream.
    expect(values).not.toContain('audit_query');
  });

  it('field-inventory §11: typing in the actor search re-asks list_users{query}, so users past the first page are reachable; the picked actor keeps its name', async () => {
    const http = scriptedHttp({
      list_users: (params) =>
        (params as { query?: string }).query === 'bob'
          ? { items: [user({ id: 'u-bob', login: 'bob', displayName: 'Bob' })] }
          : { items: [user()] },
      platform_audit_query: () => ({ items: [] }),
    });
    renderPage(http);
    const select = await screen.findByTestId('platform-audit-actor-select');
    await findComboboxOption(select, 'Administrator (admin)');

    fireEvent.change(select, { target: { value: 'bob' } });
    await findComboboxOption(select, 'Bob (bob)');
    expect(
      http.calls.find((c) => c.name === 'list_users' && c.params && 'query' in (c.params as object))
        ?.params,
    ).toEqual({ query: 'bob', limit: 50 });

    await pickComboboxOption(select, 'Bob (bob)');
    // The search text is gone, the directory is back, and the picked actor keeps its name.
    expect((select as HTMLInputElement).value).toBe('Bob (bob)');
    fireEvent.blur(select);
    await findComboboxOption(select, 'Administrator (admin)');
    expect(comboboxOptionTexts(select)).toContain('Bob (bob)');
    expect((select as HTMLInputElement).value).toBe('Bob (bob)');

    fireEvent.click(
      within(screen.getByTestId('platform-audit-filter-form')).getByRole('button', {
        name: '应用',
      }),
    );
    await waitFor(() =>
      expect(http.calls.at(-1)).toEqual({
        name: 'platform_audit_query',
        params: { limit: 50, actorUserId: 'u-bob', excludeReads: true },
      }),
    );
  });

  it('a search with no match says so', async () => {
    const http = scriptedHttp({
      list_users: (params) =>
        (params as { query?: string }).query ? { items: [] } : { items: [user()] },
      platform_audit_query: () => ({ items: [] }),
    });
    renderPage(http);
    const select = await screen.findByTestId('platform-audit-actor-select');
    fireEvent.change(select, { target: { value: 'nobody' } });
    await screen.findByTestId('platform-audit-actor-empty');
  });

  it('list_users refused → the id box with a one-line note; any other failure → the id box plus a retryable banner', async () => {
    const refused = scriptedHttp({
      list_users: () => Promise.reject(new HttpError('capability_error', 'role', 'forbidden')),
      platform_audit_query: () => ({ items: [] }),
    });
    renderPage(refused);
    await screen.findByTestId('platform-audit-actor-input');
    expect(screen.getByText(/无权读取用户目录/)).toBeTruthy();
    expect(screen.queryByTestId('platform-audit-users-error')).toBeNull();
    cleanup();

    let fail = true;
    const flaky = scriptedHttp({
      list_users: () =>
        fail ? Promise.reject(new HttpError('network', 'boom')) : { items: [user()] },
      platform_audit_query: () => ({ items: [] }),
    });
    renderPage(flaky);
    const banner = await screen.findByTestId('platform-audit-users-error');
    expect(screen.getByTestId('platform-audit-actor-input')).toBeTruthy();
    fail = false;
    fireEvent.click(within(banner).getByRole('button', { name: '重试' }));
    await screen.findByTestId('platform-audit-actor-select');
  });
});
