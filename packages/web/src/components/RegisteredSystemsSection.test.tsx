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
      canRefreshGovernance
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

/** S8 W3-K1 (leftover 79, audit CO2): "按公告刷新治理字段" — preview, per-Operation selection
 *  (default: every differing one), and a Confirm whose tier depends on whether any selected
 *  change loosens governance. */
describe('GatekeeperCard refresh governance fields (leftover 79)', () => {
  const PLATFORM_INSTANCE = {
    gateId: 'gate-1',
    connector: 'docker',
    displayName: 'Docker prod',
    transportKind: 'mcp' as const,
    target: 'docker://prod',
    status: 'enabled' as const,
    trust: 'byo' as const,
    health: 'ok' as const,
    operationCount: 1,
    gatekeeperId: 'gk-1',
  };

  function previewResult(
    operationsAlreadyPresent: readonly {
      name: string;
      existing: { mode: string; blastRadius: string; autoApprovable: boolean; status: string };
      announced: { mode: string; blastRadius: string; autoApprovable: boolean };
      differs: boolean;
    }[],
  ) {
    return {
      gateId: 'gate-1',
      wouldLink: null,
      ambiguousCandidates: [],
      operationsToImport: [],
      operationsAlreadyPresent,
    };
  }

  it('the action is hidden without a platformInstance, and hidden when denied', () => {
    const http = scriptedHttp();
    renderCard(http, vi.fn(), { platformInstance: null });
    expect(screen.queryByTestId('gatekeeper-refresh-governance-button')).toBeNull();

    cleanup();
    renderCard(http, vi.fn(), {
      platformInstance: PLATFORM_INSTANCE,
      canRefreshGovernance: false,
    });
    expect(screen.queryByTestId('gatekeeper-refresh-governance-button')).toBeNull();
  });

  it('loads the preview, defaults the selection to every differing Operation, and a non-loosening refresh uses the medium tier', async () => {
    const http = scriptedHttp({
      preview_gate_instance_enable: (params) => {
        expect(params).toEqual({ gateId: 'gate-1' });
        return previewResult([
          {
            name: 'container.restart',
            existing: {
              mode: 'execute',
              blastRadius: 'medium',
              autoApprovable: false,
              status: 'published',
            },
            announced: { mode: 'execute', blastRadius: 'high', autoApprovable: false },
            differs: true,
          },
          {
            name: 'container.list',
            existing: {
              mode: 'observe',
              blastRadius: 'low',
              autoApprovable: true,
              status: 'published',
            },
            announced: { mode: 'observe', blastRadius: 'low', autoApprovable: true },
            differs: false,
          },
        ]);
      },
      refresh_operation_governance: (params) => {
        expect(params).toEqual({
          gatekeeperId: 'gk-1',
          operationNames: ['container.restart'],
        });
        return {
          gatekeeperId: 'gk-1',
          refreshed: [
            {
              name: 'container.restart',
              before: { mode: 'execute', blastRadius: 'medium', autoApprovable: false },
              after: { mode: 'execute', blastRadius: 'high', autoApprovable: false },
              direction: 'tightened',
            },
          ],
          unchanged: [],
        };
      },
    });
    const onChanged = vi.fn();
    renderCard(http, vi.fn(), { platformInstance: PLATFORM_INSTANCE, onChanged });

    fireEvent.click(screen.getByTestId('gatekeeper-refresh-governance-button'));
    const drawer = await screen.findByTestId('gatekeeper-refresh-governance-drawer');
    // Only the differing Operation is listed — the matching one is not "already present to refresh".
    const row = await within(drawer).findByTestId(
      'gatekeeper-refresh-governance-row-container.restart',
    );
    expect(
      within(drawer).queryByTestId('gatekeeper-refresh-governance-row-container.list'),
    ).toBeNull();
    // Selected by default.
    expect((within(row).getByRole('checkbox') as HTMLInputElement).checked).toBe(true);

    fireEvent.click(within(drawer).getByTestId('gatekeeper-refresh-governance-apply'));
    const confirm = await screen.findByTestId('gatekeeper-refresh-governance-confirm');
    expect(confirm.getAttribute('data-tier')).toBe('medium');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));

    await waitFor(() =>
      expect(http.calls.some((c) => c.name === 'refresh_operation_governance')).toBe(true),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('a loosening change uses the irreversible tier, retyping the gate name to confirm', async () => {
    const http = scriptedHttp({
      preview_gate_instance_enable: () =>
        previewResult([
          {
            name: 'compose.up',
            existing: {
              mode: 'execute',
              blastRadius: 'high',
              autoApprovable: false,
              status: 'published',
            },
            announced: { mode: 'execute', blastRadius: 'high', autoApprovable: true },
            differs: true,
          },
        ]),
      refresh_operation_governance: (params) => {
        expect(params).toEqual({ gatekeeperId: 'gk-1', operationNames: ['compose.up'] });
        return { gatekeeperId: 'gk-1', refreshed: [], unchanged: [] };
      },
    });
    renderCard(http, vi.fn(), { platformInstance: PLATFORM_INSTANCE });

    fireEvent.click(screen.getByTestId('gatekeeper-refresh-governance-button'));
    await screen.findByTestId('gatekeeper-refresh-governance-row-compose.up');
    fireEvent.click(screen.getByTestId('gatekeeper-refresh-governance-apply'));
    const confirm = await screen.findByTestId('gatekeeper-refresh-governance-confirm');
    expect(confirm.getAttribute('data-tier')).toBe('irreversible');

    // The irreversible tier's confirm button stays disabled until the gate name is retyped and
    // the acknowledgement is checked (components/kit/confirm.tsx's own contract).
    const confirmButton = within(confirm).getByTestId('confirm-button') as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);
    fireEvent.change(within(confirm).getByTestId('confirm-typed-name'), {
      target: { value: GATEKEEPER.name },
    });
    fireEvent.click(within(confirm).getByTestId('confirm-acknowledge'));
    expect(confirmButton.disabled).toBe(false);

    fireEvent.click(confirmButton);
    await waitFor(() =>
      expect(http.calls.some((c) => c.name === 'refresh_operation_governance')).toBe(true),
    );
  });

  it('deselecting an Operation excludes it from operationNames; no differing Operations shows a "nothing to refresh" message with no confirm trigger', async () => {
    const http = scriptedHttp({
      preview_gate_instance_enable: () =>
        previewResult([
          {
            name: 'op.a',
            existing: {
              mode: 'execute',
              blastRadius: 'high',
              autoApprovable: false,
              status: 'published',
            },
            announced: { mode: 'observe', blastRadius: 'high', autoApprovable: false },
            differs: true,
          },
          {
            name: 'op.b',
            existing: {
              mode: 'execute',
              blastRadius: 'high',
              autoApprovable: false,
              status: 'published',
            },
            announced: { mode: 'observe', blastRadius: 'high', autoApprovable: false },
            differs: true,
          },
        ]),
      refresh_operation_governance: (params) => {
        expect(params).toEqual({ gatekeeperId: 'gk-1', operationNames: ['op.b'] });
        return { gatekeeperId: 'gk-1', refreshed: [], unchanged: [] };
      },
    });
    renderCard(http, vi.fn(), { platformInstance: PLATFORM_INSTANCE });

    fireEvent.click(screen.getByTestId('gatekeeper-refresh-governance-button'));
    const rowA = await screen.findByTestId('gatekeeper-refresh-governance-row-op.a');
    fireEvent.click(within(rowA).getByRole('checkbox'));

    fireEvent.click(screen.getByTestId('gatekeeper-refresh-governance-apply'));
    const confirm = await screen.findByTestId('gatekeeper-refresh-governance-confirm');
    // Both are loosening (execute -> observe) — still irreversible even with only op.b selected.
    expect(confirm.getAttribute('data-tier')).toBe('irreversible');
    fireEvent.change(within(confirm).getByTestId('confirm-typed-name'), {
      target: { value: GATEKEEPER.name },
    });
    fireEvent.click(within(confirm).getByTestId('confirm-acknowledge'));
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() =>
      expect(http.calls.some((c) => c.name === 'refresh_operation_governance')).toBe(true),
    );
  });

  it('nothing differs: shows a message, no per-row list, and no refresh trigger', async () => {
    const http = scriptedHttp({
      preview_gate_instance_enable: () =>
        previewResult([
          {
            name: 'op.matching',
            existing: {
              mode: 'observe',
              blastRadius: 'low',
              autoApprovable: true,
              status: 'published',
            },
            announced: { mode: 'observe', blastRadius: 'low', autoApprovable: true },
            differs: false,
          },
        ]),
    });
    renderCard(http, vi.fn(), { platformInstance: PLATFORM_INSTANCE });

    fireEvent.click(screen.getByTestId('gatekeeper-refresh-governance-button'));
    const drawer = await screen.findByTestId('gatekeeper-refresh-governance-drawer');
    await waitFor(() => expect(drawer.textContent).toContain('没有可刷新的差异'));
    expect(within(drawer).queryByTestId('gatekeeper-refresh-governance-apply')).toBeNull();
  });
});
