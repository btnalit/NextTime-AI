// @vitest-environment jsdom
import type { ExecutionReadinessWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import type { GrantRow, PrincipalRow } from '../../lib/governance.js';
import { HttpError } from '../../lib/http-client.js';
import { SystemsPage } from './SystemsPage.js';

afterEach(cleanup);

function workspace(role: string, id = 'p-self') {
  return {
    id: 'ws-1',
    name: 'Acme',
    createdAt: '2026-01-01T00:00:00Z',
    principalCount: 2,
    gatekeeperCount: 1,
    caller: { id, role, displayName: 'Self', kind: 'human' },
  };
}

function readiness(overrides: Partial<ExecutionReadinessWire> = {}): ExecutionReadinessWire {
  return {
    principalId: 'p-self',
    ready: false,
    missing: [],
    gates: [],
    workers: [],
    ...overrides,
  };
}

function gate(overrides: Partial<ExecutionReadinessWire['gates'][number]> = {}) {
  return {
    gateId: 'gk-1',
    name: 'Docker prod',
    granted: true,
    publishedOperationCount: 3,
    observeOperationCount: 2,
    executeOperationCount: 1,
    excludedByPolicy: false,
    excludedByProfile: false,
    inEntryScope: true,
    workerDefinitionIds: ['wd-1'],
    status: 'direct' as const,
    ...overrides,
  };
}

function principal(overrides: Partial<PrincipalRow> = {}): PrincipalRow {
  return {
    id: 'p-2',
    kind: 'human',
    role: 'member',
    displayName: 'Bob',
    createdAt: '2026-09-01T00:00:00.000Z',
    hasApiKey: false,
    ...overrides,
  };
}

function grant(overrides: Partial<GrantRow> = {}): GrantRow {
  return {
    id: 'grant-1',
    principalId: 'p-2',
    resourceType: 'gatekeeper',
    resourceId: 'gk-1',
    status: 'active',
    grantedBy: 'p-self',
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function scriptedHttp(
  handlers: Record<string, (params: unknown) => unknown | Promise<unknown>>,
): CapabilityCaller & { readonly calls: { readonly name: string; readonly params: unknown }[] } {
  const calls: { name: string; params: unknown }[] = [];
  const base: Record<string, (params: unknown) => unknown | Promise<unknown>> = {
    get_workspace: () => workspace('owner'),
    list_connection_requests: () => ({ items: [] }),
    list_available_gate_instances: () => ({ items: [] }),
    list_operations: (params) => {
      const gatekeeperId = (params as { gatekeeperId?: string }).gatekeeperId;
      return { items: gatekeeperId ? [] : [] };
    },
    list_principals: () => ({ items: [] }),
    list_grants: () => ({ items: [] }),
    execution_readiness: () => readiness({ principalId: 'p-self' }),
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

function renderPage(http: CapabilityCaller) {
  return render(
    <PermissionsProvider>
      <SystemsPage http={http} />
    </PermissionsProvider>,
  );
}

/** Radix `DropdownMenu`'s trigger opens on `onPointerDown` under jsdom — plain `fireEvent.click`
 *  leaves it closed (same as `ConnectionsPage.test.tsx`'s own note before this lane). */
function openConnectMoreMenu(): void {
  fireEvent.pointerDown(screen.getByTestId('connect-system-more'), { button: 0 });
}

describe('SystemsPage', () => {
  it('empty state: no system yet offers the one "接入一个系统" action', async () => {
    const http = scriptedHttp({
      execution_readiness: () =>
        readiness({ principalId: 'p-self', missing: [{ code: 'no_enabled_gate' }] }),
    });
    renderPage(http);
    const empty = await screen.findByTestId('systems-empty');
    fireEvent.click(within(empty).getByRole('button', { name: '接入一个系统' }));
    const drawer = await screen.findByTestId('connect-system-drawer');
    expect(within(drawer).getByTestId('connect-system-launcher')).toBeTruthy();
  });

  it('owner view: shows every grantee with a reachability chip and reason, and wires grant + revoke', async () => {
    const http = scriptedHttp({
      execution_readiness: (params) => {
        const principalId = (params as { principalId?: string }).principalId ?? 'p-self';
        if (principalId === 'p-2') {
          return readiness({
            principalId: 'p-2',
            gates: [
              gate({
                status: 'unreachable',
                reason: 'excluded_by_profile',
              }),
            ],
          });
        }
        return readiness({
          principalId: 'p-self',
          ready: true,
          gates: [gate()],
          workers: [
            {
              definitionId: 'wd-1',
              version: 1,
              name: 'ops-runner',
              delegable: true,
              reachableGateCount: 1,
              blockedBy: [],
            },
          ],
        });
      },
      list_principals: () => ({
        items: [principal(), principal({ id: 'p-self', displayName: 'Alice', role: 'owner' })],
      }),
      list_grants: () => ({ items: [grant()] }),
      grant_capability: (params) => {
        expect(params).toEqual({
          principalId: 'p-2',
          resourceType: 'gatekeeper',
          resourceId: 'gk-1',
        });
        return grant({ id: 'grant-2' });
      },
      revoke_capability: (params) => {
        expect(params).toEqual({ grantId: 'grant-1' });
        return grant({ status: 'revoked' });
      },
    });
    renderPage(http);

    const card = (await screen.findAllByTestId('gatekeeper-card')).find((el) =>
      el.textContent?.includes('Docker prod'),
    ) as HTMLElement;
    expect(card).toBeTruthy();

    // Ops summary from the baseline (self) readiness read.
    expect(within(card).getByTestId('gatekeeper-ops-summary').textContent).toContain(
      '2 个只读操作',
    );
    expect(within(card).getByTestId('gatekeeper-ops-summary').textContent).toContain('1 个写操作');

    // 谁能用: Bob's row shows the unreachable chip and the excluded-by-profile reason text.
    const list = within(card).getByTestId('system-access-list');
    await waitFor(() => expect(within(list).getByText('Bob')).toBeTruthy());
    const row = within(list).getByTestId('system-access-row');
    expect(row.textContent).toContain('用不了');
    expect(row.textContent).toContain('取消了勾选');

    // 哪些 Worker 覆盖.
    expect(within(card).getByTestId('system-worker-coverage').textContent).toContain('ops-runner');

    // Grant: opens the shared drawer locked to this gate.
    fireEvent.click(within(card).getByTestId('gatekeeper-grant-button'));
    const grantDrawer = await screen.findByTestId('grant-gate-drawer');
    const form = within(grantDrawer).getByTestId('grant-gate-form');
    expect(within(form).getByTestId('ggf-locked-gate-chip').textContent).toContain('Docker prod');

    // Revoke: Bob's existing grant.
    fireEvent.click(within(row).getByTestId('gatekeeper-revoke-grant-1'));
    const confirm = await screen.findByTestId('gatekeeper-revoke-confirm-grant-1');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'revoke_capability')).toBe(true),
    );
  });

  it('member view: a 403 on list_grants/list_principals degrades to the caller’s own row, no grant/revoke actions', async () => {
    const http = scriptedHttp({
      get_workspace: () => workspace('member'),
      list_principals: () =>
        Promise.reject(new HttpError('capability_error', 'operator only', 'forbidden')),
      list_grants: () =>
        Promise.reject(new HttpError('capability_error', 'operator only', 'forbidden')),
      execution_readiness: () => readiness({ principalId: 'p-self', ready: true, gates: [gate()] }),
      resolve_refs: () => ({ items: [{ id: 'p-self', kind: 'principal', name: 'Self' }] }),
    });
    renderPage(http);

    const card = (await screen.findAllByTestId('gatekeeper-card')).find((el) =>
      el.textContent?.includes('Docker prod'),
    ) as HTMLElement;
    const list = within(card).getByTestId('system-access-list');
    const rows = within(list).getAllByTestId('system-access-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('你');
    expect(rows[0]?.textContent).toContain('可直接调用');

    expect(within(card).queryByTestId('gatekeeper-grant-button')).toBeNull();
    expect(within(card).queryByTestId(/^gatekeeper-revoke-/)).toBeNull();
  });

  it('接入向导 opens from the overflow menu (S8 W2-U1 SY3 kept)', async () => {
    const http = scriptedHttp({});
    renderPage(http);
    await screen.findByTestId('systems-empty');
    openConnectMoreMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: /接入向导/ }));
    const drawer = await screen.findByTestId('onboarding-wizard-drawer');
    expect(within(drawer).getByTestId('wizard-step-kind')).toBeTruthy();
  });
});
