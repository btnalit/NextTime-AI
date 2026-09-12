// @vitest-environment jsdom
import type { ConnectorWire, ExternalRuntimeWire, GateInstanceWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { PlatformIntegrationsPage } from './PlatformIntegrationsPage.js';

afterEach(cleanup);

/** A `CapabilityCaller` whose named answers are scripted; unscripted names throw loudly instead
 *  of silently resolving `undefined` (the convention every page test in this package uses). */
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
      <PlatformIntegrationsPage http={http} />
    </PermissionsProvider>,
  );
}

function connector(overrides: Partial<ConnectorWire> = {}): ConnectorWire {
  return {
    name: 'docker',
    kind: 'http',
    packaged: true,
    mode: 'self_serve',
    disabledOperations: [],
    operationCount: 3,
    instanceCount: 2,
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function gateInstance(overrides: Partial<GateInstanceWire> = {}): GateInstanceWire {
  return {
    gateId: 'gate-1',
    connector: 'docker',
    displayName: 'Docker prod',
    transportKind: 'mcp',
    target: 'docker://prod',
    endpoint: 'http://docker-gate:8080',
    status: 'discovered',
    trust: 'byo',
    health: 'ok',
    lastSeenAt: '2026-09-10T00:00:00.000Z',
    lastCheckedAt: null,
    operationCount: 1,
    enabledWorkspaceCount: 0,
    hosted: false,
    definition: null,
    operations: [
      {
        name: 'container_restart',
        mode: 'execute',
        blastRadius: 'medium',
        autoApprovable: false,
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    ],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function hostedGateInstance(overrides: Partial<GateInstanceWire> = {}): GateInstanceWire {
  return gateInstance({
    gateId: 'gate-hosted-1',
    connector: 'http',
    displayName: 'Billing API',
    transportKind: 'http',
    target: 'https://billing.internal',
    endpoint: 'https://billing.internal',
    status: 'enabled',
    lastSeenAt: null,
    operationCount: 0,
    hosted: true,
    definition: {
      transportKind: 'http',
      target: 'https://billing.internal',
      credentialMode: 'shared',
      manifestSource: 'https://billing.internal/openapi.json',
    },
    ...overrides,
  });
}

function runtime(overrides: Partial<ExternalRuntimeWire> = {}): ExternalRuntimeWire {
  return {
    workspaceId: 'ws-1',
    workspaceName: 'Acme',
    principalId: 'p-1',
    displayName: 'Claude Code',
    sessionId: 'sess-1',
    sessionKind: 'claude_code',
    status: 'active',
    createdAt: '2026-09-01T00:00:00.000Z',
    expiresAt: '2027-09-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('PlatformIntegrationsPage', () => {
  it('lists connectors and changing the mode posts set_connector_mode', async () => {
    const updated = connector({ mode: 'platform_preset' });
    const http = scriptedHttp({
      list_connectors: () => ({ items: [connector()] }),
      set_connector_mode: (params) => {
        expect(params).toEqual({ name: 'docker', mode: 'platform_preset' });
        return updated;
      },
    });
    renderPage(http);

    const table = await screen.findByTestId('connectors-table');
    const row = within(table).getByTestId('connector-row-docker');
    fireEvent.change(within(row).getByTestId('connector-mode-docker'), {
      target: { value: 'platform_preset' },
    });

    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'set_connector_mode')).toBe(true),
    );
    await waitFor(() =>
      expect((within(row).getByTestId('connector-mode-docker') as HTMLSelectElement).value).toBe(
        'platform_preset',
      ),
    );
  });

  it('expanding a connector row and saving the deny-list posts disabledOperations only', async () => {
    const c = connector({ disabledOperations: ['old_op'] });
    const updated = connector({ disabledOperations: ['old_op', 'container_restart'] });
    const http = scriptedHttp({
      list_connectors: () => ({ items: [c] }),
      list_gate_instances: (params) => {
        expect(params).toEqual({ connector: 'docker' });
        return { items: [gateInstance()] };
      },
      set_connector_mode: (params) => {
        expect(params).toEqual({
          name: 'docker',
          disabledOperations: ['old_op', 'container_restart'],
        });
        return updated;
      },
    });
    renderPage(http);

    const table = await screen.findByTestId('connectors-table');
    const row = within(table).getByTestId('connector-row-docker');
    fireEvent.click(within(row).getByRole('button', { name: /展开 Expand/ }));

    const denyList = await screen.findByTestId('connector-disabled-ops-docker');
    // The union includes the live instance's own Operation plus the already-disabled name that no
    // live instance currently announces.
    expect(within(denyList).getByText('old_op')).toBeTruthy();
    const liveCheckbox = within(denyList).getByLabelText('container_restart');
    fireEvent.click(liveCheckbox);
    fireEvent.click(within(denyList).getByRole('button', { name: '保存 Save' }));

    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'set_connector_mode')).toBe(true),
    );
  });

  it('gate instance detail: status and trust toggles post update_gate_instance', async () => {
    const instance = gateInstance();
    const enabled = { ...instance, status: 'enabled' as const };
    const vetted = { ...enabled, trust: 'vetted' as const };
    const http = scriptedHttp({
      list_gate_instances: () => ({ items: [instance] }),
      update_gate_instance: (params) => {
        const body = params as { gateId: string; status?: string; trust?: string };
        expect(body.gateId).toBe('gate-1');
        if (body.status) return enabled;
        if (body.trust) return vetted;
        throw new Error('unexpected update_gate_instance params');
      },
    });
    renderPage(http);

    fireEvent.click(screen.getByTestId('integrations-tab-instances'));
    const table = await screen.findByTestId('gate-instances-table');
    fireEvent.click(within(table).getByTestId('gate-instance-row-gate-1'));

    const detail = await screen.findByTestId('gate-instance-detail');
    fireEvent.click(within(detail).getByTestId('gate-instance-status-toggle'));
    await waitFor(() =>
      expect(
        http.calls.some(
          (call) => call.name === 'update_gate_instance' && 'status' in (call.params as object),
        ),
      ).toBe(true),
    );

    fireEvent.click(await within(detail).findByTestId('gate-instance-trust-toggle'));
    await waitFor(() =>
      expect(
        http.calls.some(
          (call) => call.name === 'update_gate_instance' && 'trust' in (call.params as object),
        ),
      ).toBe(true),
    );
  });

  it('test connection posts test_gate_instance and shows the result', async () => {
    const instance = gateInstance();
    const http = scriptedHttp({
      list_gate_instances: () => ({ items: [instance] }),
      test_gate_instance: (params) => {
        expect(params).toEqual({ gateId: 'gate-1' });
        return {
          gateId: 'gate-1',
          health: 'ok',
          describedOperationCount: 4,
          checkedAt: '2026-09-11T00:00:00.000Z',
        };
      },
    });
    renderPage(http);

    fireEvent.click(screen.getByTestId('integrations-tab-instances'));
    const table = await screen.findByTestId('gate-instances-table');
    fireEvent.click(within(table).getByTestId('gate-instance-row-gate-1'));
    const detail = await screen.findByTestId('gate-instance-detail');

    fireEvent.click(within(detail).getByTestId('gate-instance-test'));
    const result = await within(detail).findByTestId('gate-instance-test-result');
    expect(result.textContent).toContain('4');
  });

  it('hosted instance with no heartbeat shows the hosted badge and waiting-for-host status', async () => {
    const http = scriptedHttp({
      list_gate_instances: () => ({ items: [hostedGateInstance()] }),
    });
    renderPage(http);

    fireEvent.click(screen.getByTestId('integrations-tab-instances'));
    const table = await screen.findByTestId('gate-instances-table');
    const row = within(table).getByTestId('gate-instance-row-gate-hosted-1');
    expect(within(row).getByTestId('gate-hosted-badge')).toBeTruthy();
    expect(within(row).getByTestId('gate-instance-status').textContent).toContain('等待宿主接管');
  });

  it('creating a hosted instance posts create_gate_instance (http omits manifestSource when blank) and opens its detail', async () => {
    const created = hostedGateInstance({ gateId: 'gate-new', displayName: 'gate-new' });
    const http = scriptedHttp({
      list_gate_instances: () => ({ items: [] }),
      create_gate_instance: (params) => {
        expect(params).toEqual({
          gateId: 'gate-new',
          transportKind: 'http',
          target: 'https://target.internal',
          credentialMode: 'shared',
        });
        return created;
      },
    });
    renderPage(http);

    fireEvent.click(screen.getByTestId('integrations-tab-instances'));
    fireEvent.click(await screen.findByTestId('new-gate-instance'));

    const form = await screen.findByTestId('create-gate-instance-form');
    fireEvent.change(within(form).getByLabelText(/Gate id/), {
      target: { value: 'gate-new' },
    });
    fireEvent.change(within(form).getByLabelText(/目标 Target/), {
      target: { value: 'https://target.internal' },
    });
    fireEvent.click(within(form).getByTestId('create-gate-instance-submit'));

    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'create_gate_instance')).toBe(true),
    );
    const detail = await screen.findByTestId('gate-instance-detail');
    expect(within(detail).getByTestId('gate-instance-hosted-tag')).toBeTruthy();
  });

  it('hosted instance detail: shared credential mode shows the token button, connected_account does not', async () => {
    const shared = hostedGateInstance();
    const perMember = hostedGateInstance({
      gateId: 'gate-hosted-2',
      definition: {
        transportKind: 'http',
        target: 'https://billing.internal',
        credentialMode: 'connected_account',
        manifestSource: null,
      },
    });
    const http = scriptedHttp({
      list_gate_instances: () => ({ items: [shared, perMember] }),
    });
    renderPage(http);

    fireEvent.click(screen.getByTestId('integrations-tab-instances'));
    const table = await screen.findByTestId('gate-instances-table');

    fireEvent.click(within(table).getByTestId(`gate-instance-row-${shared.gateId}`));
    const sharedDetail = await screen.findByTestId('gate-instance-detail');
    expect(within(sharedDetail).getByTestId('gate-credential-token-button')).toBeTruthy();

    fireEvent.click(within(table).getByTestId(`gate-instance-row-${perMember.gateId}`));
    const perMemberDetail = await screen.findByTestId('gate-instance-detail');
    expect(within(perMemberDetail).queryByTestId('gate-credential-token-button')).toBeNull();
  });

  it('hosted instance detail: delete posts delete_gate_instance and removes the row; gate_in_use shows inline', async () => {
    const instance = hostedGateInstance();
    let attempt = 0;
    const http = scriptedHttp({
      list_gate_instances: () => ({ items: [instance] }),
      delete_gate_instance: () => {
        attempt += 1;
        if (attempt === 1) {
          throw new HttpError(
            'capability_error',
            'a workspace still has it enabled',
            'gate_in_use',
          );
        }
        return { gateId: instance.gateId, deleted: true };
      },
    });
    renderPage(http);

    fireEvent.click(screen.getByTestId('integrations-tab-instances'));
    const table = await screen.findByTestId('gate-instances-table');
    fireEvent.click(within(table).getByTestId(`gate-instance-row-${instance.gateId}`));
    const detail = await screen.findByTestId('gate-instance-detail');

    fireEvent.click(within(detail).getByTestId('gate-instance-delete'));
    fireEvent.click(within(detail).getByTestId('gate-instance-delete-confirm'));
    await waitFor(() =>
      expect(http.calls.filter((call) => call.name === 'delete_gate_instance')).toHaveLength(1),
    );
    // The row is still there (delete failed with gate_in_use) — detail stays open, with the
    // mapped message shown inline.
    const deleteError = await screen.findByTestId('gate-instance-delete-error');
    expect(deleteError.textContent).toContain('还有工作区启用着这个实例');

    // Still in the confirm step (the failed attempt leaves it open) — confirm again.
    fireEvent.click(within(detail).getByTestId('gate-instance-delete-confirm'));
    await waitFor(() =>
      expect(http.calls.filter((call) => call.name === 'delete_gate_instance')).toHaveLength(2),
    );
    await waitFor(() =>
      expect(screen.queryByTestId(`gate-instance-row-${instance.gateId}`)).toBeNull(),
    );
  });

  it('revoking an external runtime posts revoke_external_runtime and removes the row', async () => {
    const http = scriptedHttp({
      list_external_runtimes: () => ({ items: [runtime()] }),
      revoke_external_runtime: (params) => {
        expect(params).toEqual({ workspaceId: 'ws-1', sessionId: 'sess-1' });
        return { workspaceId: 'ws-1', sessionId: 'sess-1', revoked: true };
      },
    });
    renderPage(http);

    fireEvent.click(screen.getByTestId('integrations-tab-runtimes'));
    const table = await screen.findByTestId('external-runtimes-table');
    fireEvent.click(within(table).getByTestId('external-runtime-revoke-sess-1'));
    fireEvent.click(within(table).getByRole('button', { name: '确认吊销 Confirm revoke' }));

    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'revoke_external_runtime')).toBe(true),
    );
    await waitFor(() => expect(screen.queryByTestId('external-runtime-row-sess-1')).toBeNull());
  });
});
