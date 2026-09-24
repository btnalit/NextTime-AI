// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../lib/clients.js';
import type { GrantRow } from '../lib/governance.js';
import { HttpError } from '../lib/http-client.js';
import { RpcError } from '../lib/ws-client.js';
import { GatekeeperCard } from './RegisteredSystemsSection.js';

afterEach(cleanup);

const GATEKEEPER = {
  id: 'gk-1',
  name: 'Billing API',
  transportKind: 'http',
  target: 'https://billing.internal',
  endpoint: 'http://gate:8080',
  updatedAt: '2026-09-03T00:00:00.000Z',
};

const DRAFT_OPERATION = {
  objectId: 'op-1',
  gatekeeperId: 'gk-1',
  name: 'billing.refund',
  status: 'draft',
  mode: 'execute',
  blastRadius: 'medium',
};

function scriptedHttp(
  handlers: Record<string, (params: unknown) => unknown | Promise<unknown>> = {},
): CapabilityCaller & { readonly calls: { readonly name: string; readonly params: unknown }[] } {
  const calls: { name: string; params: unknown }[] = [];
  const base: Record<string, (params: unknown) => unknown> = {
    list_principals: () => ({ items: [] }),
    list_gatekeepers: () => ({ items: [] }),
    resolve_refs: () => ({ items: [] }),
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

function renderCard(
  http: CapabilityCaller,
  onForbidden = vi.fn(),
  overrides: Partial<Parameters<typeof GatekeeperCard>[0]> = {},
) {
  render(
    <GatekeeperCard
      http={http}
      gatekeeper={GATEKEEPER}
      operations={[DRAFT_OPERATION]}
      canPublish
      canGrant
      onChanged={vi.fn()}
      onForbidden={onForbidden}
      {...overrides}
    />,
  );
  return onForbidden;
}

/** C18 (console-completion-plan §2b): the card's 403 detection goes through `lib/errors.ts`
 *  `isForbiddenError`, which normalizes both transports — the former local helper only matched
 *  an HTTP-shaped `{code: 'forbidden'}` and would have missed a WS `RpcError` (numeric -32002). */
describe('GatekeeperCard forbidden detection (C18)', () => {
  it('reports publish_manifest as forbidden for an HTTP 403', async () => {
    const http: CapabilityCaller = {
      call: vi.fn(async () => {
        throw new HttpError('capability_error', 'owner only', 'forbidden');
      }) as CapabilityCaller['call'],
    };
    const onForbidden = renderCard(http);
    fireEvent.click(screen.getByRole('button', { name: /发布清单/ }));
    await waitFor(() => expect(onForbidden).toHaveBeenCalledWith('publish_manifest'));
  });

  it('reports publish_manifest as forbidden for a JSON-RPC -32002 too', async () => {
    const http: CapabilityCaller = {
      call: vi.fn(async () => {
        throw new RpcError(-32002, 'forbidden');
      }) as CapabilityCaller['call'],
    };
    const onForbidden = renderCard(http);
    fireEvent.click(screen.getByRole('button', { name: /发布清单/ }));
    await waitFor(() => expect(onForbidden).toHaveBeenCalledWith('publish_manifest'));
  });

  it('does not report a non-403 failure as forbidden', async () => {
    const http: CapabilityCaller = {
      call: vi.fn(async () => {
        throw new HttpError('capability_error', 'gate down', 'gatekeeper_timeout');
      }) as CapabilityCaller['call'],
    };
    const onForbidden = renderCard(http);
    fireEvent.click(screen.getByRole('button', { name: /发布清单/ }));
    await screen.findByText(/gate down/);
    expect(onForbidden).not.toHaveBeenCalled();
  });
});

/** S8 W2-U1 (audit SY1 "两套接入机制并存"): a card with no platform instance is marked legacy. */
describe('GatekeeperCard legacy badge (SY1)', () => {
  it('marks a card with no platformInstance as a legacy registration', () => {
    const http = scriptedHttp();
    renderCard(http, vi.fn(), { platformInstance: null });
    expect(screen.getByTestId('gatekeeper-legacy-badge')).toBeTruthy();
  });

  it('does not mark a card linked to a platform instance', () => {
    const http = scriptedHttp();
    renderCard(http, vi.fn(), {
      platformInstance: {
        gateId: 'gate-1',
        connector: 'docker',
        displayName: 'Docker prod',
        transportKind: 'mcp',
        target: 'docker://prod',
        status: 'enabled',
        trust: 'byo',
        health: 'ok',
        operationCount: 3,
        gatekeeperId: 'gk-1',
      },
    });
    expect(screen.queryByTestId('gatekeeper-legacy-badge')).toBeNull();
  });
});

/** S8 W2-U1 (audit R5/U2 "卡片上看不到谁已获授权"): the card's own access list, scoped to its
 *  `resourceId`, with a revoke action per grant. */
describe('GatekeeperCard access list (R5/U2)', () => {
  function grant(overrides: Partial<GrantRow> = {}): GrantRow {
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

  it('hides while grants is undefined (still loading / 403)', () => {
    const http = scriptedHttp();
    renderCard(http, vi.fn(), { grants: undefined });
    expect(screen.queryByTestId('gatekeeper-access-list')).toBeNull();
  });

  it('shows only grants scoped to this gate, and revoking calls revoke_capability', async () => {
    const http = scriptedHttp({
      resolve_refs: () => ({ items: [{ id: 'p-1', kind: 'principal', name: 'Bob' }] }),
      revoke_capability: (params) => {
        expect(params).toEqual({ grantId: 'grant-1' });
        return grant({ status: 'revoked' });
      },
    });
    const onGrantsChanged = vi.fn();
    renderCard(http, vi.fn(), {
      grants: [grant(), grant({ id: 'grant-2', resourceId: 'gk-other' })],
      onGrantsChanged,
    });
    const list = await screen.findByTestId('gatekeeper-access-list');
    // Only the row scoped to gk-1 is here — gk-other's grant is not this card's business.
    await waitFor(() =>
      expect(within(list).getByTestId('gatekeeper-access-chip-grant-1').textContent).toContain(
        'Bob',
      ),
    );
    expect(within(list).queryByTestId('gatekeeper-access-chip-grant-2')).toBeNull();

    fireEvent.click(within(list).getByTestId('gatekeeper-revoke-grant-1'));
    const confirm = await screen.findByTestId('gatekeeper-revoke-confirm-grant-1');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'revoke_capability')).toBe(true),
    );
    await waitFor(() => expect(onGrantsChanged).toHaveBeenCalled());
  });
});

/** S8 W2-U1 (audit J6 "两处入口打开同一个抽屉"): the card's own grant action opens the shared
 *  drawer, locked to this gate — no gate picker, no free-text principal id. */
describe('GatekeeperCard grant drawer (J6)', () => {
  it('授权给成员 opens the drawer locked to this gate; submitting calls grant_capability', async () => {
    const http = scriptedHttp({
      list_principals: () => ({
        items: [
          {
            id: 'p-2',
            kind: 'human',
            role: 'member',
            displayName: 'Carol',
            createdAt: '2026-09-01T00:00:00.000Z',
            hasApiKey: false,
          },
        ],
      }),
      list_operations: () => ({ items: [] }),
      grant_capability: (params) => {
        expect(params).toEqual({
          principalId: 'p-2',
          resourceType: 'gatekeeper',
          resourceId: 'gk-1',
        });
        return {
          id: 'grant-9',
          principalId: 'p-2',
          resourceType: 'gatekeeper',
          resourceId: 'gk-1',
        };
      },
    });
    const onGrantsChanged = vi.fn();
    renderCard(http, vi.fn(), { onGrantsChanged });

    fireEvent.click(screen.getByTestId('gatekeeper-grant-button'));
    const drawer = await screen.findByTestId('grant-gate-drawer');
    // Locked to this gate — no gate picker, just the fixed RefChip.
    expect(within(drawer).getByTestId('ggf-locked-gate-chip').textContent).toContain(
      GATEKEEPER.name,
    );
    expect(within(drawer).queryByTestId('ggf-gate-picker')).toBeNull();

    const form = within(drawer).getByTestId('grant-gate-form');
    // `list_principals` resolves asynchronously — the `<option value="p-2">` may not exist yet.
    const select = within(form).getByTestId('ggf-member-select');
    await waitFor(() => expect(select.querySelector('option[value="p-2"]')).not.toBeNull());
    fireEvent.change(select, { target: { value: 'p-2' } });
    fireEvent.click(within(form).getByTestId('ggf-submit'));

    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'grant_capability')).toBe(true),
    );
    await waitFor(() => expect(onGrantsChanged).toHaveBeenCalled());
  });
});
