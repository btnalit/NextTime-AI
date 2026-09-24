// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../hooks/usePermissions.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { HttpError } from '../lib/http-client.js';
import { AccessPage } from './AccessPage.js';
import {
  handleScopeCapabilities,
  serviceHandleMaxTtlSeconds,
} from './IssueServiceHandleSection.js';

afterEach(cleanup);

function workspace(role: string) {
  return {
    id: 'ws-1',
    name: 'Acme',
    createdAt: '2026-01-01T00:00:00Z',
    principalCount: 2,
    gatekeeperCount: 1,
    caller: { id: 'p-owner', role, displayName: 'Alice', kind: 'human' },
  };
}

/** `get_workspace` answers as an owner unless a test overrides it (C9: `canManage` reads the
 *  authoritative `caller.role` from it). */
function scriptedHttp(
  handlers: Record<string, (params: unknown) => unknown | Promise<unknown>>,
): CapabilityCaller & { readonly calls: { readonly name: string; readonly params: unknown }[] } {
  const calls: { name: string; params: unknown }[] = [];
  const base: Record<string, (params: unknown) => unknown | Promise<unknown>> = {
    get_workspace: () => workspace('owner'),
    // B3: read for the gatekeeper RefChip names; a test that cares scripts its own.
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

function renderPage(http: CapabilityCaller) {
  return render(
    <PermissionsProvider>
      <AccessPage http={http} />
    </PermissionsProvider>,
  );
}

function grant(overrides: Record<string, unknown> = {}) {
  return {
    id: 'grant-1',
    principalId: 'p-1',
    resourceType: 'gatekeeper',
    resourceId: 'gk-1',
    status: 'active',
    grantedBy: 'p-owner',
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('AccessPage', () => {
  it('renders a list_grants not_found as an ordinary error banner (B6: the "not live yet" branch is gone)', async () => {
    const http = scriptedHttp({
      list_principals: () =>
        Promise.reject(new HttpError('capability_error', 'no handler', 'not_found')),
      list_grants: () =>
        Promise.reject(new HttpError('capability_error', 'no handler', 'not_found')),
    });
    renderPage(http);
    await screen.findByTestId('grants-error');
  });

  it('C9: an operator session (authoritative get_workspace.caller.role) sees no Grant / Revoke / issue-Handle affordances', async () => {
    const http = scriptedHttp({
      get_workspace: () => workspace('operator'),
      // Both operator-readable, so the 403 inference alone would never have hidden the buttons.
      list_principals: () => ({ items: [] }),
      list_grants: () => ({ items: [grant()] }),
    });
    renderPage(http);
    const row = await screen.findByTestId('grant-row');
    await waitFor(() => expect(http.calls.some((c) => c.name === 'get_workspace')).toBe(true));
    await waitFor(() => expect(screen.queryByRole('button', { name: '授予能力' })).toBeNull());
    expect(within(row).queryByRole('button', { name: '撤销' })).toBeNull();
    expect(screen.queryByTestId('issue-service-handle-form')).toBeNull();
  });

  it('lists grants with a status chip, and revoking calls revoke_capability then updates the row', async () => {
    const http = scriptedHttp({
      // `list_principals` is a real operator-minRole capability now (S3.11 kernel half); a 403
      // here would be read by `inferRole` as "member" and hide the governance page under test.
      list_principals: () => ({ items: [] }),
      list_grants: () => ({ items: [grant()] }),
      revoke_capability: (params) => {
        expect(params).toEqual({ grantId: 'grant-1' });
        return {};
      },
    });
    renderPage(http);
    const row = await screen.findByTestId('grant-row');
    expect(within(row).getByText('gatekeeper')).toBeTruthy();

    fireEvent.click(within(row).getByRole('button', { name: '撤销' }));
    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'revoke_capability')).toBe(true),
    );
    await waitFor(() => expect(within(row).queryByRole('button', { name: '撤销' })).toBeNull());
  });

  it('granting a capability calls grant_capability with the free-text fallback fields', async () => {
    const http = scriptedHttp({
      // `list_principals` is a real operator-minRole capability now (S3.11 kernel half); a 403
      // here would be read by `inferRole` as "member" and hide the governance page under test.
      list_principals: () => ({ items: [] }),
      list_grants: () => ({ items: [] }),
      grant_capability: (params) => {
        expect(params).toEqual({
          principalId: 'p-2',
          resourceType: 'gatekeeper',
          resourceId: 'gk-2',
        });
        return grant({ id: 'grant-2', principalId: 'p-2', resourceId: 'gk-2' });
      },
    });
    renderPage(http);
    await screen.findByTestId('grants-empty');

    fireEvent.click(screen.getByRole('button', { name: '授予能力' }));
    const form = await screen.findByTestId('grant-capability-form');
    fireEvent.change(within(form).getByLabelText(/主体/), { target: { value: 'p-2' } });
    fireEvent.change(within(form).getByLabelText(/资源 id/), { target: { value: 'gk-2' } });
    fireEvent.click(within(form).getByRole('button', { name: '授予' }));

    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'grant_capability')).toBe(true),
    );
  });

  it('C19: the grant form rejects scope JSON that is not an object, before any call', async () => {
    const http = scriptedHttp({
      list_principals: () => ({ items: [] }),
      list_grants: () => ({ items: [] }),
      grant_capability: () => grant(),
    });
    renderPage(http);
    await screen.findByTestId('grants-empty');
    fireEvent.click(screen.getByRole('button', { name: '授予能力' }));
    const form = await screen.findByTestId('grant-capability-form');
    fireEvent.change(within(form).getByLabelText(/主体/), { target: { value: 'p-2' } });

    for (const bad of ['"foo"', '42', 'null', '[1,2]']) {
      fireEvent.change(within(form).getByLabelText(/范围/), { target: { value: bad } });
      fireEvent.click(within(form).getByRole('button', { name: '授予' }));
      expect(await within(form).findByText(/Scope must be a JSON object/)).toBeTruthy();
    }
    expect(http.calls.some((call) => call.name === 'grant_capability')).toBe(false);

    fireEvent.change(within(form).getByLabelText(/范围/), {
      target: { value: '{"actionKindTag":"docker.container_restart"}' },
    });
    fireEvent.click(within(form).getByRole('button', { name: '授予' }));
    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'grant_capability')).toBe(true),
    );
  });

  it('C20: the principal filter keeps what was typed while list_principals is still loading, then offers suggestions; the query fires on commit, not per keystroke', async () => {
    let resolvePrincipals: (value: unknown) => void = () => undefined;
    const http = scriptedHttp({
      list_principals: () =>
        new Promise((resolve) => {
          resolvePrincipals = resolve;
        }),
      list_grants: () => ({ items: [] }),
    });
    renderPage(http);
    const filter = (await screen.findByLabelText(/按主体筛选/)) as HTMLInputElement;
    const grantsCalls = () => http.calls.filter((call) => call.name === 'list_grants');
    await waitFor(() => expect(grantsCalls()).toHaveLength(1));

    for (const partial of ['p', 'p-', 'p-ty', 'p-typed']) {
      fireEvent.change(filter, { target: { value: partial } });
    }
    expect(filter.value).toBe('p-typed');
    // Nothing committed yet — typing never queries.
    expect(grantsCalls()).toHaveLength(1);

    act(() => resolvePrincipals({ items: [{ id: 'p-1', displayName: 'Bob', role: 'member' }] }));
    await waitFor(() =>
      expect(document.querySelectorAll('#access-principal-suggestions option')).toHaveLength(1),
    );
    // Same element, same value — no control swap dropped the input.
    expect((screen.getByLabelText(/按主体筛选/) as HTMLInputElement).value).toBe('p-typed');
    expect(screen.getByLabelText(/按主体筛选/)).toBe(filter);

    fireEvent.keyDown(filter, { key: 'Enter' });
    await waitFor(() => expect(grantsCalls()).toHaveLength(2));
    expect(grantsCalls().at(-1)?.params).toEqual({ principalId: 'p-typed' });

    // A picked suggestion (the text equals a directory id) applies at once.
    fireEvent.change(filter, { target: { value: 'p-1' } });
    await waitFor(() => expect(grantsCalls().at(-1)?.params).toEqual({ principalId: 'p-1' }));
    expect(grantsCalls()).toHaveLength(3);

    // Blur commits too.
    fireEvent.change(filter, { target: { value: 'p-other' } });
    expect(grantsCalls()).toHaveLength(3);
    fireEvent.blur(filter);
    await waitFor(() => expect(grantsCalls().at(-1)?.params).toEqual({ principalId: 'p-other' }));
  });

  it('B7: issuing a service Handle — capabilities from the registry checklist / paste box, TTL default 30 days — shows the token once', async () => {
    const http = scriptedHttp({
      list_principals: () => ({
        items: [
          {
            id: 'p-svc',
            kind: 'service',
            role: 'member',
            displayName: 'CI runner',
            createdAt: '2026-09-01T00:00:00.000Z',
            hasApiKey: true,
          },
        ],
      }),
      list_grants: () => ({ items: [] }),
      issue_service_handle: (params) => {
        expect(params).toEqual({
          principalId: 'p-svc',
          scope: ['search', 'get_task'],
          ttlSeconds: 30 * 86400,
        });
        return {
          handle: 'svc_handle_abc123',
          principalId: 'p-svc',
          sessionId: 'sess-1',
          expiresAt: '2026-10-11T00:00:00.000Z',
          scope: ['search', 'get_task'],
        };
      },
    });
    renderPage(http);

    const form = await screen.findByTestId('issue-service-handle-form');
    fireEvent.change(within(form).getByLabelText(/服务主体/), {
      target: { value: 'p-svc' },
    });
    expect((within(form).getByLabelText(/TTL \(days\)/) as HTMLInputElement).value).toBe('30');

    // Only handle-channel names are offered: a member-management capability is not a checkbox
    // here, and pasting it is refused with the reason before any call.
    const checklist = within(form).getByTestId('ish-scope-checklist');
    expect(checklist.querySelector('input[data-capability="search"]')).toBeTruthy();
    expect(checklist.querySelector('input[data-capability="list_gatekeepers"]')).toBeNull();
    expect(checklist.querySelector('input[data-capability="list_users"]')).toBeNull();
    fireEvent.click(checklist.querySelector('input[data-capability="search"]') as HTMLElement);

    const paste = within(form).getByLabelText(/粘贴能力名/);
    fireEvent.change(paste, { target: { value: 'get_task list_gatekeepers' } });
    expect(within(form).getByText(/不是可签发的能力名/).textContent).toContain('list_gatekeepers');
    expect(within(form).getByRole('button', { name: '签发' }).hasAttribute('disabled')).toBe(true);
    fireEvent.change(paste, { target: { value: 'get_task' } });
    expect(within(form).getByTestId('ish-scope-summary').textContent).toContain('2');

    fireEvent.click(within(form).getByRole('button', { name: '签发' }));
    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'issue_service_handle')).toBe(true),
    );
    const dialog = await screen.findByTestId('issued-handle-dialog');
    expect(within(dialog).getByTestId('issued-handle-token').textContent).toBe('svc_handle_abc123');
  });

  it('B7: the TTL cap is read from the registry (one year) and enforced client-side', async () => {
    expect(serviceHandleMaxTtlSeconds()).toBe(365 * 86400);
    expect(handleScopeCapabilities().every((c) => c.channel === 'handle')).toBe(true);
    expect(handleScopeCapabilities().some((c) => c.name.includes('<'))).toBe(false);
    const http = scriptedHttp({
      list_principals: () => ({
        items: [
          {
            id: 'p-svc',
            kind: 'service',
            role: 'member',
            displayName: 'CI runner',
            createdAt: '2026-09-01T00:00:00.000Z',
            hasApiKey: true,
          },
        ],
      }),
      list_grants: () => ({ items: [] }),
    });
    renderPage(http);
    const form = await screen.findByTestId('issue-service-handle-form');
    fireEvent.change(within(form).getByLabelText(/TTL \(days\)/), { target: { value: '366' } });
    expect(within(form).getByText(/必须是 1 到 365 的整数/)).toBeTruthy();
  });

  it('B3: grant rows name their principal, grantor and gatekeeper through RefChips, bare when unknown', async () => {
    const http = scriptedHttp({
      list_principals: () => ({
        items: [
          {
            id: 'p-1',
            kind: 'human',
            role: 'member',
            displayName: 'Bob',
            createdAt: '2026-09-01T00:00:00.000Z',
            hasApiKey: false,
          },
          {
            id: 'p-owner',
            kind: 'human',
            role: 'owner',
            displayName: 'Alice',
            createdAt: '2026-09-01T00:00:00.000Z',
            hasApiKey: false,
          },
        ],
      }),
      list_gatekeepers: () => ({
        items: [
          {
            id: 'gk-1',
            name: 'docker-gate',
            kind: 'cli',
            status: 'active',
            operationCount: 3,
            createdAt: '2026-09-01T00:00:00.000Z',
          },
        ],
      }),
      list_grants: () => ({
        items: [grant(), grant({ id: 'grant-2', principalId: 'p-gone', resourceId: 'gk-9' })],
      }),
    });
    renderPage(http);
    const rows = await screen.findAllByTestId('grant-row');
    await waitFor(() =>
      expect(within(rows[0] as HTMLElement).getByTestId('grant-principal').textContent).toContain(
        'Bob',
      ),
    );
    const first = rows[0] as HTMLElement;
    expect(within(first).getByTestId('grant-granted-by').textContent).toContain('Alice');
    const resource = within(first).getByTestId('grant-resource');
    expect(resource.textContent).toContain('docker-gate');
    expect(resource.querySelector('a')?.getAttribute('href')).toBe('#/govern/systems/gk-1');

    // Unknown ids degrade to the bare chip (visible fallback), never a crash.
    const second = rows[1] as HTMLElement;
    expect(within(second).getByTestId('grant-principal').className).toContain('ref-chip-bare');
    expect(within(second).getByTestId('grant-resource').className).toContain('ref-chip-bare');
  });
});
