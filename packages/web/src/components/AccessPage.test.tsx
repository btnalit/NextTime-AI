// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../hooks/usePermissions.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { HttpError } from '../lib/http-client.js';
import { AccessPage } from './AccessPage.js';

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
  it('shows "该能力尚未上线" when list_grants is not deployed yet', async () => {
    const http = scriptedHttp({
      list_principals: () =>
        Promise.reject(new HttpError('capability_error', 'no handler', 'not_found')),
      list_grants: () =>
        Promise.reject(new HttpError('capability_error', 'no handler', 'not_found')),
    });
    renderPage(http);
    await screen.findByTestId('grants-unavailable');
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

    fireEvent.click(within(row).getByRole('button', { name: 'Revoke' }));
    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'revoke_capability')).toBe(true),
    );
    await waitFor(() => expect(within(row).queryByRole('button', { name: 'Revoke' })).toBeNull());
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

    fireEvent.click(screen.getByRole('button', { name: 'Grant capability' }));
    const form = await screen.findByTestId('grant-capability-form');
    fireEvent.change(within(form).getByLabelText(/Principal/), { target: { value: 'p-2' } });
    fireEvent.change(within(form).getByLabelText(/Resource id/), { target: { value: 'gk-2' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Grant' }));

    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'grant_capability')).toBe(true),
    );
  });
});
