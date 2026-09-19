import type { AvailableGateInstanceWire } from '@nexttime/shared';
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../hooks/usePermissions.js';
import type { CapabilityCaller } from '../lib/clients.js';
import type { ConnectionRequestRow } from '../lib/connections.js';
import { HttpError } from '../lib/http-client.js';
import { ConnectionsPage } from './ConnectionsPage.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function scriptedHttp(
  handlers: Record<string, (params: unknown) => unknown | Promise<unknown>>,
): CapabilityCaller & { readonly calls: { readonly name: string; readonly params: unknown }[] } {
  const calls: { name: string; params: unknown }[] = [];
  const base: Record<string, (params: unknown) => unknown> = {
    list_connection_requests: () => ({ items: [] }),
    // The real `search` returns the W5 list envelope; the page must read `.items`.
    search: () => ({ items: [] }),
    list_available_gate_instances: () => ({ items: [] }),
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

function renderPage(
  http: CapabilityCaller,
  onSelectGatekeeper = vi.fn(),
  options: { readonly platformAdmin?: boolean } = {},
) {
  return {
    onSelectGatekeeper,
    ...render(
      <PermissionsProvider>
        <ConnectionsPage
          http={http}
          onSelectGatekeeper={onSelectGatekeeper}
          platformAdmin={options.platformAdmin}
        />
      </PermissionsProvider>,
    ),
  };
}

function requestRow(overrides: Partial<ConnectionRequestRow> = {}): ConnectionRequestRow {
  return {
    id: 'cr-1',
    status: 'requested',
    kind: 'http',
    target: 'billing.internal',
    requestedBy: 'principal-1',
    gatekeeperId: null,
    completedBy: null,
    requestedAt: '2026-09-18T00:00:00.000Z',
    completedAt: null,
    ...overrides,
  };
}

function availableRow(
  overrides: Partial<AvailableGateInstanceWire> = {},
): AvailableGateInstanceWire {
  return {
    gateId: 'gate-1',
    connector: 'docker',
    displayName: 'Docker prod',
    transportKind: 'mcp',
    target: 'docker://prod',
    status: 'enabled',
    trust: 'byo',
    health: 'ok',
    operationCount: 3,
    gatekeeperId: null,
    ...overrides,
  };
}

/** A `search{objectType:'Gatekeeper'}` row for one registered gate. */
function gatekeeperObject(id: string, name: string) {
  return {
    id,
    objectType: 'Gatekeeper',
    identityKey: { name },
    properties: {
      name,
      transportKind: 'mcp',
      target: 'docker://prod',
      endpoint: 'http://gate:8080',
    },
    createdAt: '2026-09-18T00:00:00.000Z',
    updatedAt: '2026-09-18T00:00:00.000Z',
  };
}

describe('ConnectionsPage', () => {
  it('opens the onboarding wizard from its own button, and finishing it opens the gate detail drawer', async () => {
    const http = scriptedHttp({
      create_connection: () => ({
        gatekeeperId: 'gk-9',
        importedOperationNames: ['accept_s2_mcp_echo'],
        connectionRequestId: null,
      }),
    });
    const onSelectGatekeeper = vi.fn();
    renderPage(http, onSelectGatekeeper);

    fireEvent.click(screen.getByRole('button', { name: /接入向导 Onboarding wizard/ }));
    const wizardDrawer = await screen.findByTestId('onboarding-wizard-drawer');
    expect(within(wizardDrawer).getByTestId('onboarding-wizard')).toBeTruthy();

    fireEvent.click(within(wizardDrawer).getByRole('button', { name: /下一步 Next/ }));
    const connectStep = await within(wizardDrawer).findByTestId('wizard-step-connect');
    fireEvent.change(within(connectStep).getByLabelText(/Target system/), {
      target: { value: 'accept_s2_mcp' },
    });
    fireEvent.change(within(connectStep).getByLabelText(/Gatekeeper endpoint/), {
      target: { value: 'http://accept-s2-mcp:8080' },
    });
    fireEvent.click(within(connectStep).getByRole('button', { name: 'Register Gatekeeper' }));

    const publishStep = await within(wizardDrawer).findByTestId('wizard-step-publish');
    fireEvent.click(
      within(publishStep).getByRole('button', { name: /暂不发布，稍后再说 Skip for now/ }),
    );

    fireEvent.click(within(wizardDrawer).getByRole('button', { name: /下一步 Next/ }));
    const doneStep = await within(wizardDrawer).findByTestId('wizard-step-done');
    fireEvent.click(within(doneStep).getByRole('button', { name: /查看门详情 View gate detail/ }));

    await waitFor(() => expect(onSelectGatekeeper).toHaveBeenCalledWith('gk-9'));
    expect(screen.queryByTestId('onboarding-wizard-drawer')).toBeNull();
  });

  it('the quick "直接注册门 Register a gate" path still opens CompleteConnectionForm directly', async () => {
    const http = scriptedHttp({});
    renderPage(http);
    fireEvent.click(screen.getByTestId('register-gate-button'));
    const drawer = await screen.findByTestId('complete-connection-drawer');
    expect(within(drawer).getByTestId('complete-connection-form')).toBeTruthy();
  });

  // S6-C (§5.6): the page's one primary action opens the shared launcher, mounted for the
  // workspace plane.
  it('"接入一个系统 Connect a system" is the primary action and opens the launcher on step 1', async () => {
    const http = scriptedHttp({});
    renderPage(http);
    const button = screen.getByTestId('connect-system-button');
    expect(button.className).toContain('btn-primary');
    // One ink button per page (§5.9 principle 1): the older 接入向导 is a secondary now.
    expect(screen.getByRole('button', { name: /接入向导 Onboarding wizard/ }).className).toContain(
      'btn-secondary',
    );
    fireEvent.click(button);
    const drawer = await screen.findByTestId('connect-system-drawer');
    const launcher = within(drawer).getByTestId('connect-system-launcher');
    expect(launcher.getAttribute('data-step')).toBe('0');
    expect(within(launcher).getByTestId('launcher-kind-ssh')).toBeTruthy();
  });

  // C26: cancel a `requested` row through the medium-tier confirm; the answer is spliced in place.
  it('cancels a requested connection request via cancel_connection_request and splices the row', async () => {
    const http = scriptedHttp({
      list_connection_requests: () => ({ items: [requestRow()] }),
      cancel_connection_request: (params) => {
        expect(params).toEqual({ connectionRequestId: 'cr-1' });
        return requestRow({ status: 'cancelled' });
      },
    });
    renderPage(http);
    const list = await screen.findByTestId('requests-list');
    fireEvent.click(within(list).getByTestId('cancel-request-cr-1'));
    const confirm = await screen.findByTestId('cancel-request-confirm');
    expect(confirm.getAttribute('data-tier')).toBe('medium');
    expect(within(confirm).getByTestId('confirm-target').textContent).toBe(
      'http · billing.internal',
    );
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() => expect(screen.queryByTestId('cancel-request-confirm')).toBeNull());
    // The default filter is "requested" — the cancelled row leaves it; "All" still lists it.
    await waitFor(() => expect(screen.queryByTestId('cancel-request-cr-1')).toBeNull());
    fireEvent.click(screen.getByRole('tab', { name: 'All' }));
    const row = await screen.findByTestId('request-row');
    expect(row.textContent).toContain('Cancelled');
    expect(within(row).queryByTestId('cancel-request-cr-1')).toBeNull();
    expect(http.calls.filter((call) => call.name === 'list_connection_requests')).toHaveLength(1);
  });

  it('maps a 403 / 409 on cancel_connection_request to bilingual copy inside the confirm card', async () => {
    let attempt = 0;
    const http = scriptedHttp({
      list_connection_requests: () => ({ items: [requestRow()] }),
      cancel_connection_request: () => {
        attempt += 1;
        if (attempt === 1)
          throw new HttpError('capability_error', 'not the requester', 'forbidden');
        throw new HttpError('capability_error', 'not requested', 'illegal_transition');
      },
    });
    renderPage(http);
    const list = await screen.findByTestId('requests-list');
    fireEvent.click(within(list).getByTestId('cancel-request-cr-1'));
    const confirm = await screen.findByTestId('cancel-request-confirm');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    const first = await within(confirm).findByTestId('confirm-error');
    expect(first.textContent).toContain('只能取消自己发起的申请');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() =>
      expect(within(confirm).getByTestId('confirm-error').textContent).toContain(
        '已不在「已申请」状态',
      ),
    );
    // A 409 means the row changed underneath — the list is re-read.
    await waitFor(() =>
      expect(http.calls.filter((call) => call.name === 'list_connection_requests').length).toBe(2),
    );
  });

  // B7 (§4 "接入三层"): the catalog row shows the platform status and health as chips; the button
  // is about this workspace and is absent once linked, and absent when the platform side is not
  // `enabled` (the kernel would refuse with gate_not_enabled).
  it('B7: an enabled · ok row already linked here shows the Gatekeeper link, not a 启用 button; a platform-disabled row shows neither', async () => {
    const http = scriptedHttp({
      list_available_gate_instances: () => ({
        items: [
          availableRow({ gateId: 'gate-linked', gatekeeperId: 'gk-1' }),
          availableRow({ gateId: 'gate-off', status: 'disabled', gatekeeperId: null }),
          availableRow({ gateId: 'gate-new', gatekeeperId: null }),
        ],
      }),
    });
    renderPage(http);
    const table = await screen.findByTestId('available-gates-table');
    const linked = within(table).getByTestId('available-gate-gate-linked');
    expect(within(linked).getByTestId('available-gate-status-gate-linked').textContent).toContain(
      '已启用 Enabled',
    );
    expect(within(linked).queryByTestId('enable-gate-gate-linked')).toBeNull();
    expect(within(linked).getByRole('link', { name: /已启用 Enabled/ })).toBeTruthy();

    const off = within(table).getByTestId('available-gate-gate-off');
    expect(within(off).queryByTestId('enable-gate-gate-off')).toBeNull();
    expect(within(off).getByTestId('available-gate-not-enableable-gate-off')).toBeTruthy();

    const fresh = within(table).getByTestId('available-gate-gate-new');
    expect(within(fresh).getByTestId('enable-gate-gate-new').textContent).toContain(
      '在本工作区启用 Enable here',
    );
  });

  // §5.6 instance ↔ connection links: a registered system enabled from the platform catalog shows
  // its platform instance; the link to the 集成 page is admin-only.
  it('a registered system links back to its platform instance for a platform admin, and only names it otherwise', async () => {
    const handlers = {
      list_available_gate_instances: () => ({
        items: [availableRow({ gateId: 'gate-1', gatekeeperId: 'gk-1' })],
      }),
      search: (params: unknown) =>
        (params as { objectType: string }).objectType === 'Gatekeeper'
          ? { items: [gatekeeperObject('gk-1', 'Docker prod'), gatekeeperObject('gk-2', 'Self')] }
          : { items: [] },
    };
    renderPage(scriptedHttp(handlers), vi.fn(), { platformAdmin: true });
    const cards = await screen.findAllByTestId('gatekeeper-card');
    const fromPlatform = cards.find((card) => card.getAttribute('data-gatekeeper-id') === 'gk-1');
    const selfConnected = cards.find((card) => card.getAttribute('data-gatekeeper-id') === 'gk-2');
    if (!fromPlatform || !selfConnected) throw new Error('cards missing');
    const link = within(fromPlatform).getByTestId('gatekeeper-platform-instance-link');
    // The bare 集成 href until lib/router.ts parses `#/platform/integrations/<gateId>`.
    expect(link.getAttribute('href')).toBe('#/platform/integrations');
    expect(link.textContent).toBe('gate-1');
    expect(within(selfConnected).queryByTestId('gatekeeper-platform-instance')).toBeNull();
    cleanup();

    renderPage(scriptedHttp(handlers));
    const memberCards = await screen.findAllByTestId('gatekeeper-card');
    const named = memberCards.find((card) => card.getAttribute('data-gatekeeper-id') === 'gk-1');
    if (!named) throw new Error('card missing');
    expect(within(named).getByTestId('gatekeeper-platform-instance').textContent).toContain(
      'gate-1',
    );
    expect(within(named).queryByTestId('gatekeeper-platform-instance-link')).toBeNull();
  });

  it('enabling a gate instance from the platform catalog posts enable_gate_instance and refreshes', async () => {
    let searchGatekeeperCalls = 0;
    const http = scriptedHttp({
      list_available_gate_instances: () => ({
        items: [
          {
            gateId: 'gate-1',
            connector: 'docker',
            displayName: 'Docker prod',
            transportKind: 'mcp',
            target: 'docker://prod',
            status: 'enabled',
            trust: 'byo',
            health: 'ok',
            operationCount: 3,
            gatekeeperId: null,
          },
        ],
      }),
      search: (params) => {
        if ((params as { objectType: string }).objectType === 'Gatekeeper') {
          searchGatekeeperCalls += 1;
        }
        return [];
      },
      enable_gate_instance: (params) => {
        expect(params).toEqual({ gateId: 'gate-1' });
        return {
          gateId: 'gate-1',
          gatekeeperId: 'gk-9',
          publishedOperationNames: ['container_restart'],
          skippedOperationNames: [],
        };
      },
    });
    renderPage(http);

    const table = await screen.findByTestId('available-gates-table');
    fireEvent.click(within(table).getByTestId('enable-gate-gate-1'));

    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'enable_gate_instance')).toBe(true),
    );
    // Registered systems is re-read (a new Gatekeeper was just registered underneath it).
    await waitFor(() => expect(searchGatekeeperCalls).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(within(table).getByText(/已发布 1 个 Operation/)).toBeTruthy());
  });

  it('a linked instance row offers "录入我的凭证" — issue_gate_credential_token then POSTs to the gate host', async () => {
    const fetchStub = vi.fn(async () => jsonResponse(200, { ok: true, result: { stored: true } }));
    vi.stubGlobal('fetch', fetchStub);

    const http = scriptedHttp({
      list_available_gate_instances: () => ({
        items: [
          {
            gateId: 'gate-1',
            connector: 'http',
            displayName: 'Billing API',
            transportKind: 'http',
            target: 'https://billing.internal',
            status: 'enabled',
            trust: 'byo',
            health: 'ok',
            operationCount: 3,
            gatekeeperId: 'gk-1',
          },
        ],
      }),
      issue_gate_credential_token: (params) => {
        expect(params).toEqual({ gateId: 'gate-1' });
        return {
          gateId: 'gate-1',
          token: 'jwt-token',
          url: '/gate-host/i/gate-1/gate/connected-accounts',
          onBehalfOf: 'principal-1',
          credentialMode: 'connected_account',
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        };
      },
    });
    renderPage(http);

    const table = await screen.findByTestId('available-gates-table');
    const row = within(table).getByTestId('available-gate-gate-1');
    fireEvent.click(within(row).getByTestId('gate-credential-token-button'));

    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'issue_gate_credential_token')).toBe(true),
    );
    const tokenInput = await within(row).findByTestId('gate-credential-token-input');
    fireEvent.change(tokenInput, { target: { value: 'sk-secret' } });
    fireEvent.click(within(row).getByTestId('gate-credential-submit'));

    await screen.findByTestId('gate-credential-stored');
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [url, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/gate-host/i/gate-1/gate/connected-accounts');
    expect(JSON.parse(init.body as string)).toEqual({
      onBehalfOf: 'principal-1',
      credential: { token: 'sk-secret' },
    });
  });

  it('a linked instance row shows credential_mode_mismatch inline when the instance is not per-member', async () => {
    const http = scriptedHttp({
      list_available_gate_instances: () => ({
        items: [
          {
            gateId: 'gate-1',
            connector: 'http',
            displayName: 'Billing API',
            transportKind: 'http',
            target: 'https://billing.internal',
            status: 'enabled',
            trust: 'byo',
            health: 'ok',
            operationCount: 3,
            gatekeeperId: 'gk-1',
          },
        ],
      }),
      issue_gate_credential_token: () => {
        throw new HttpError(
          'capability_error',
          'only connected_account instances take a per-member credential',
          'credential_mode_mismatch',
        );
      },
    });
    renderPage(http);

    const table = await screen.findByTestId('available-gates-table');
    const row = within(table).getByTestId('available-gate-gate-1');
    fireEvent.click(within(row).getByTestId('gate-credential-token-button'));

    const tokenError = await within(row).findByTestId('gate-credential-token-error');
    expect(tokenError.textContent).toContain('该实例不需要每人的凭证');
  });
});
