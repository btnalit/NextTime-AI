// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../hooks/usePermissions.js';
import type { CapabilityCaller } from '../lib/clients.js';
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

function renderPage(http: CapabilityCaller, onSelectGatekeeper = vi.fn()) {
  return {
    onSelectGatekeeper,
    ...render(
      <PermissionsProvider>
        <ConnectionsPage http={http} onSelectGatekeeper={onSelectGatekeeper} />
      </PermissionsProvider>,
    ),
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

  it('the existing "Connect a system" quick path still opens CompleteConnectionForm directly', async () => {
    const http = scriptedHttp({});
    renderPage(http);
    fireEvent.click(screen.getByRole('button', { name: 'Connect a system' }));
    const drawer = await screen.findByTestId('complete-connection-drawer');
    expect(within(drawer).getByTestId('complete-connection-form')).toBeTruthy();
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
