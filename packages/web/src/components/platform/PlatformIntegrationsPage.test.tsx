// @vitest-environment jsdom
import type {
  ConnectorWire,
  ExternalRuntimeWire,
  GateInstanceWire,
  SelfConnectionWire,
} from '@nexttime/shared';
import { SECRET_FIELD_MASK } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { PlatformIntegrationsPage } from './PlatformIntegrationsPage.js';

afterEach(() => {
  cleanup();
  // Legacy 380: a tab change writes the URL; each test starts from the page's default.
  window.location.hash = '';
});

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

function renderPage(
  http: CapabilityCaller,
  props: {
    readonly selectedGateId?: string;
    readonly onSelectGate?: (id: string | null) => void;
  } = {},
) {
  return render(
    <PermissionsProvider>
      <PlatformIntegrationsPage http={http} {...props} />
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
    selfConnectionCount: 0,
    suspendedSelfConnectionCount: 0,
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

function selfConnection(overrides: Partial<SelfConnectionWire> = {}): SelfConnectionWire {
  return {
    workspaceId: 'ws-1',
    workspaceName: 'Acme',
    gatekeeperId: 'gk-self-1',
    connector: 'http',
    target: 'grafana',
    endpoint: 'https://grafana-gate.example',
    connectedByName: 'Alice',
    connectedAt: '2026-10-01T00:00:00.000Z',
    suspendedAt: null,
    suspendedByLogin: null,
    suspensionReason: null,
    catalogGateId: null,
    ...overrides,
  };
}

describe('PlatformIntegrationsPage', () => {
  // S6-C (§5.6): the page's one primary action opens the shared launcher for the platform plane;
  // the 门实例 tab keeps 新建门宿主实例 as the quick path.
  it('"接入一个系统', async () => {
    const instance = gateInstance({
      gateId: 'billing',
      displayName: 'Billing',
      transportKind: 'http',
      connector: 'http',
      status: 'enabled',
    });
    const http = scriptedHttp({
      list_connectors: () => ({
        items: [
          connector({ name: 'http', kind: 'http', packaged: false, mode: 'platform_preset' }),
        ],
      }),
      list_gate_instances: () => ({ items: [instance] }),
    });
    const onSelectGate = vi.fn();
    renderPage(http, { onSelectGate });
    const button = screen.getByTestId('connect-system-button');
    expect(button.className).toContain('btn-primary');
    fireEvent.click(button);
    const drawer = await screen.findByTestId('connect-system-drawer');
    const launcher = within(drawer).getByTestId('connect-system-launcher');
    fireEvent.click(within(launcher).getByTestId('launcher-kind-http'));
    fireEvent.click(within(launcher).getByTestId('launcher-next'));
    // S8 W2-U1 (audit J5): 选择已有实例 renders first now — the create form is opt-in, reached via
    // its own 新建实例 button (not exercised here; an existing instance is picked instead).
    expect(within(launcher).queryByTestId('create-gate-instance-form')).toBeNull();
    fireEvent.click(await within(launcher).findByTestId('launcher-gate-billing'));
    fireEvent.click(within(launcher).getByTestId('launcher-next'));
    expect(within(launcher).getByTestId('launcher-policy-workspace-link')).toBeTruthy();
    fireEvent.click(within(launcher).getByTestId('launcher-next'));
    fireEvent.click(within(launcher).getByTestId('launcher-next'));
    await waitFor(() => expect(screen.queryByTestId('connect-system-drawer')).toBeNull());
    expect(onSelectGate).toHaveBeenCalledWith('billing');
    // Lands on the 门实例 tab with that instance's drawer open.
    const detail = await screen.findByTestId('gate-instance-detail');
    expect(detail).toBeTruthy();
    expect(screen.getByTestId('new-gate-instance')).toBeTruthy();
  });

  it('a deep-linked selectedGateId opens the 门实例', async () => {
    const http = scriptedHttp({
      list_gate_instances: () => ({ items: [gateInstance()] }),
    });
    const onSelectGate = vi.fn();
    renderPage(http, { selectedGateId: 'gate-1', onSelectGate });
    const drawer = await screen.findByTestId('gate-instance-drawer');
    expect(within(drawer).getByTestId('gate-instance-detail')).toBeTruthy();
    expect(screen.getByTestId('gate-instances-table')).toBeTruthy();
    fireEvent.keyDown(drawer, { key: 'Escape' });
    await waitFor(() => expect(onSelectGate).toHaveBeenCalledWith(null));
  });

  // G4 (kernel-console-coverage-2026-09-26, closing wave C6): `list_gate_instances` has no
  // `autoLoadAll` — a deep link naming an instance outside the loaded page used to leave the
  // drawer silently closed forever. `useGateInstancesPanel` now falls back to `get_gate_instance`
  // once the list has finished loading and still does not have the row.
  it('a deep-linked selectedGateId outside the loaded list page falls back to get_gate_instance', async () => {
    const http = scriptedHttp({
      // The deep-linked instance is not in the (single, non-`autoLoadAll`) loaded page.
      list_gate_instances: () => ({ items: [gateInstance({ gateId: 'gate-elsewhere' })] }),
      get_gate_instance: (params) => {
        expect(params).toEqual({ gateId: 'gate-1' });
        return gateInstance({ gateId: 'gate-1', displayName: 'Docker prod (page 2)' });
      },
    });
    renderPage(http, { selectedGateId: 'gate-1' });
    const drawer = await screen.findByTestId('gate-instance-drawer');
    expect(within(drawer).getByTestId('gate-instance-detail')).toBeTruthy();
    expect(drawer.textContent).toContain('Docker prod (page 2)');
    expect(http.calls.some((call) => call.name === 'get_gate_instance')).toBe(true);
  });

  // B7 in the platform detail: an `enabled · ok` instance offers 禁用, never 启用.
  it('B7: an enabled instance’s detail shows 禁用 Disable and its health chip, not a 启用', async () => {
    const http = scriptedHttp({
      list_gate_instances: () => ({ items: [gateInstance({ status: 'enabled', health: 'ok' })] }),
    });
    renderPage(http);
    fireEvent.click(screen.getByTestId('integrations-tab-instances'));
    const table = await screen.findByTestId('gate-instances-table');
    fireEvent.click(within(table).getByTestId('gate-instance-open-gate-1'));
    const detail = await screen.findByTestId('gate-instance-detail');
    expect(within(detail).getByTestId('gate-instance-status-toggle').textContent).toBe('禁用');
    expect(within(detail).getByTestId('gate-instance-detail-health').textContent).toContain('健康');
    expect(within(detail).getByTestId('gate-instance-workspaces')).toBeTruthy();
  });

  // S8 W1-A11 (audit L2): the page header's "接入一个系统" and the 门实例 tab's own "新建门宿主
  // 实例" both render at once on this tab — only one may be the ink primary.
  it('L2: at most one ink primary button when the 门实例 tab is open', async () => {
    const http = scriptedHttp({
      list_gate_instances: () => ({ items: [gateInstance()] }),
    });
    renderPage(http);
    fireEvent.click(screen.getByTestId('integrations-tab-instances'));
    await screen.findByTestId('gate-instances-table');
    const primaries = document.querySelectorAll('.btn-primary');
    expect(primaries).toHaveLength(1);
    expect(primaries[0]).toBe(screen.getByTestId('connect-system-button'));
    expect(screen.getByTestId('new-gate-instance').className).not.toContain('btn-primary');
  });

  // S8 W1-A7 (audit S13/PI1): the select no longer applies on change — it opens a medium confirm
  // next to itself, and `set_connector_mode` only fires once that confirm is confirmed.
  it('changing the mode opens a medium confirm next to the select; set_connector_mode fires only on confirm', async () => {
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
    const select = within(row).getByTestId('connector-mode-docker') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'platform_preset' } });

    expect(http.calls.some((call) => call.name === 'set_connector_mode')).toBe(false);
    const confirm = await screen.findByTestId('connector-mode-confirm-docker');
    expect(confirm.getAttribute('data-tier')).toBe('medium');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));

    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'set_connector_mode')).toBe(true),
    );
    await waitFor(() => expect(select.value).toBe('platform_preset'));
  });

  // UX acceptance of #538 (out of scope there): an enabled instance of a connector that is not a
  // platform preset is invisible to every workspace — the connector row says how many, and the
  // switch away from preset says they will disappear before it happens.
  it('self-service visibility: the connector row counts enabled instances no workspace can see', async () => {
    const http = scriptedHttp({
      list_connectors: () => ({ items: [connector({ mode: 'self_serve' })] }),
      list_gate_instances: () => ({
        items: [
          gateInstance({ status: 'enabled' }),
          gateInstance({ gateId: 'gate-2', status: 'discovered' }),
        ],
      }),
    });
    renderPage(http);
    const hint = await screen.findByTestId('connector-hidden-instances-docker');
    expect(hint.textContent).toContain('1 个已启用的实例不会出现在工作区的「待启用的平台实例」里');
    // UX acceptance of #567 P2: workspaces that already enabled it keep using it.
    expect(hint.textContent).toContain('已经启用的工作区照常使用');
  });

  it('self-service visibility: switching a preset with enabled instances away says they will disappear from workspaces', async () => {
    const http = scriptedHttp({
      list_connectors: () => ({ items: [connector({ mode: 'platform_preset' })] }),
      list_gate_instances: () => ({
        items: [
          gateInstance({ status: 'enabled' }),
          gateInstance({ gateId: 'gate-2', status: 'enabled' }),
        ],
      }),
    });
    renderPage(http);
    const table = await screen.findByTestId('connectors-table');
    expect(screen.queryByTestId('connector-hidden-instances-docker')).toBeNull();
    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'list_gate_instances')).toBe(true),
    );
    const select = within(table).getByTestId('connector-mode-docker') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'self_serve' } });
    const confirm = await screen.findByTestId('connector-mode-confirm-docker');
    await waitFor(() =>
      expect(confirm.textContent).toContain(
        '这个接入包有 2 个已启用的实例，切换后它们会从各工作区',
      ),
    );
  });

  it('self-service visibility: the instance list flags an enabled instance no workspace can see, its drawer says why and leads to the connector', async () => {
    const http = scriptedHttp({
      list_connectors: () => ({ items: [connector({ mode: 'self_serve' })] }),
      list_gate_instances: () => ({
        items: [
          gateInstance({ status: 'enabled' }),
          gateInstance({ gateId: 'gate-2', displayName: 'Docker staging', status: 'discovered' }),
        ],
      }),
    });
    renderPage(http);
    fireEvent.click(screen.getByTestId('integrations-tab-instances'));
    const table = await screen.findByTestId('gate-instances-table');
    await waitFor(() =>
      expect(within(table).getAllByTestId('gate-hidden-from-workspaces-badge')).toHaveLength(1),
    );
    fireEvent.click(within(table).getByTestId('gate-instance-open-gate-1'));
    const detail = await screen.findByTestId('gate-instance-detail');
    const notice = within(detail).getByTestId('gate-instance-hidden-from-workspaces');
    expect(notice.textContent).toContain('工作区看不到这个实例。');
    expect(notice.textContent).toContain('到「接入包」把「docker」改成「平台预置」');
    fireEvent.click(within(notice).getByTestId('gate-instance-show-connectors'));
    expect(await screen.findByTestId('connectors-table')).toBeTruthy();
  });

  it('UX acceptance of #567 P2: an instance some workspace already enabled is flagged as hidden from the other workspaces, and its drawer says the enabled ones keep using it', async () => {
    const http = scriptedHttp({
      list_connectors: () => ({ items: [connector({ mode: 'self_serve' })] }),
      list_gate_instances: () => ({
        items: [gateInstance({ status: 'enabled', enabledWorkspaceCount: 1 })],
      }),
    });
    renderPage(http);
    fireEvent.click(screen.getByTestId('integrations-tab-instances'));
    const table = await screen.findByTestId('gate-instances-table');
    const badge = await within(table).findByTestId('gate-hidden-from-workspaces-badge');
    expect(badge.textContent).toBe('其他工作区看不到');
    fireEvent.click(within(table).getByTestId('gate-instance-open-gate-1'));
    const notice = await screen.findByTestId('gate-instance-hidden-from-workspaces');
    expect(notice.textContent).toContain('已在 1 个工作区启用，那里照常使用');
    expect(notice.textContent).not.toContain('工作区看不到这个实例。');
  });

  it('UX acceptance of #567 P3: the instance drawer marks an Operation in effect that no workspace can publish', async () => {
    const http = scriptedHttp({
      list_connectors: () => ({ items: [connector({ mode: 'platform_preset' })] }),
      list_gate_instances: () => ({
        items: [
          gateInstance({
            status: 'enabled',
            operations: [
              {
                name: 'orders.lookup',
                mode: 'observe',
                blastRadius: 'low',
                autoApprovable: true,
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                gateOwnedParams: [{ param: 'Authorization', location: 'header' }],
              },
            ],
          }),
        ],
      }),
    });
    renderPage(http);
    fireEvent.click(screen.getByTestId('integrations-tab-instances'));
    const table = await screen.findByTestId('gate-instances-table');
    fireEvent.click(within(table).getByTestId('gate-instance-open-gate-1'));
    const mark = await screen.findByTestId('gate-instance-operation-held-orders.lookup');
    expect(mark.textContent).toContain('发布不了');
    expect(mark.textContent).toContain('Authorization（请求头）');
  });

  // P1: a connector an administrator named for a system's gate-host instances is neither packaged
  // nor generic — its mode reaches the catalog alone, so nothing may claim it stops workspaces
  // connecting a kind of system themselves (only a generic connector's mode does, R-40).
  it('P1: a gate-host system connector is typed 门宿主, counts no self-connections, and no wording says presetting it stops self-connections', async () => {
    const http = scriptedHttp({
      list_connectors: () => ({
        items: [
          connector({ name: 'widgets', kind: 'mcp', packaged: false, mode: 'self_serve' }),
          connector({ name: 'mcp', kind: 'mcp', packaged: false, mode: 'self_serve' }),
        ],
      }),
      list_gate_instances: () => ({
        items: [gateInstance({ connector: 'widgets', status: 'enabled' })],
      }),
    });
    renderPage(http);
    const table = await screen.findByTestId('connectors-table');
    const system = within(table).getByTestId('connector-row-widgets');
    const generic = within(table).getByTestId('connector-row-mcp');
    expect(within(system).getByText('门宿主')).toBeTruthy();
    expect(within(generic).getByText('通用')).toBeTruthy();
    expect(within(system).getByText('—')).toBeTruthy();
    expect(within(generic).queryByText('—')).toBeNull();

    fireEvent.change(within(system).getByTestId('connector-mode-widgets'), {
      target: { value: 'platform_preset' },
    });
    const confirm = await screen.findByTestId('connector-mode-confirm-widgets');
    expect(confirm.textContent).not.toContain('不能再自己连这一类系统');
    fireEvent.change(within(generic).getByTestId('connector-mode-mcp'), {
      target: { value: 'platform_preset' },
    });
    expect((await screen.findByTestId('connector-mode-confirm-mcp')).textContent).toContain(
      '不能再自己连这一类系统',
    );

    fireEvent.click(screen.getByTestId('integrations-tab-instances'));
    const instances = await screen.findByTestId('gate-instances-table');
    fireEvent.click(await within(instances).findByTestId('gate-instance-open-gate-1'));
    const notice = await screen.findByTestId('gate-instance-hidden-from-workspaces');
    expect(notice.textContent).toContain('到「接入包」把「widgets」改成「平台预置」');
    expect(notice.textContent).not.toContain('不能再自己接入这一类系统');
  });

  it('self-service visibility: a cli instance is never offered the preset switch — the drawer says workspaces connect it themselves', async () => {
    const http = scriptedHttp({
      list_connectors: () => ({
        items: [connector({ name: 'cli', packaged: false, mode: 'self_serve' })],
      }),
      list_gate_instances: () => ({
        items: [gateInstance({ connector: 'cli', status: 'enabled' })],
      }),
    });
    renderPage(http);
    fireEvent.click(screen.getByTestId('integrations-tab-instances'));
    const table = await screen.findByTestId('gate-instances-table');
    await within(table).findByTestId('gate-hidden-from-workspaces-badge');
    fireEvent.click(within(table).getByTestId('gate-instance-open-gate-1'));
    const notice = await screen.findByTestId('gate-instance-hidden-from-workspaces');
    expect(notice.textContent).toContain('这一类接入包不能设为「平台预置」');
    expect(screen.queryByTestId('gate-instance-show-connectors')).toBeNull();
  });

  it('P3-6 V8 (390px overflow): the connectors table scrolls inside its own box, never the page', async () => {
    const http = scriptedHttp({
      list_connectors: () => ({ items: [connector()] }),
    });
    renderPage(http);

    const table = await screen.findByTestId('connectors-table');
    // `.table-scroll` (styles/pages.css) is the box with `overflow-x: auto` + `min-width: 0` — the
    // second is what actually lets the first take effect instead of the table's own
    // `min-width: 720px` growing every flex-column ancestor up to `.page` and scrolling the whole
    // viewport (the same chain `.code-block`'s own comment documents). jsdom does not compute real
    // layout, so this asserts the containment box is the table's immediate scroll ancestor rather
    // than measuring pixels.
    expect(table.parentElement?.className).toBe('table-scroll');
    expect(table.closest('.page')?.querySelector('.table-scroll')).toBe(table.parentElement);
  });

  it('cancelling the mode confirm restores the previous value without calling set_connector_mode', async () => {
    const http = scriptedHttp({
      list_connectors: () => ({ items: [connector({ mode: 'self_serve' })] }),
    });
    renderPage(http);

    const table = await screen.findByTestId('connectors-table');
    const row = within(table).getByTestId('connector-row-docker');
    const select = within(row).getByTestId('connector-mode-docker') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'platform_preset' } });
    expect(select.value).toBe('platform_preset');

    const confirm = await screen.findByTestId('connector-mode-confirm-docker');
    fireEvent.click(within(confirm).getByTestId('confirm-cancel'));

    await waitFor(() => expect(select.value).toBe('self_serve'));
    expect(http.calls.some((call) => call.name === 'set_connector_mode')).toBe(false);
  });

  it('R-41: disabling a connector in use says existing workspaces keep calling it; without the opt-in only the mode changes', async () => {
    const http = scriptedHttp({
      list_connectors: () => ({ items: [connector({ mode: 'self_serve', instanceCount: 3 })] }),
      set_connector_mode: (params) => {
        expect(params).toEqual({ name: 'docker', mode: 'disabled' });
        return connector({ mode: 'disabled', instanceCount: 3 });
      },
    });
    renderPage(http);

    const table = await screen.findByTestId('connectors-table');
    const row = within(table).getByTestId('connector-row-docker');
    fireEvent.change(within(row).getByTestId('connector-mode-docker'), {
      target: { value: 'disabled' },
    });

    const confirm = await screen.findByTestId('connector-mode-confirm-docker');
    expect(confirm.getAttribute('data-tier')).toBe('medium');
    // The corrected copy: the mode gates new use only; the deny list is the real cut-off.
    expect(confirm.textContent).toContain('已经启用它的工作区照常可以调用');
    expect(confirm.textContent).not.toContain('都拿不到');
    const denyAll = within(confirm).getByTestId(
      'connector-mode-deny-all-checkbox-docker',
    ) as HTMLInputElement;
    expect(denyAll.checked).toBe(false);
    fireEvent.click(within(confirm).getByTestId('confirm-button'));

    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'set_connector_mode')).toBe(true),
    );
    // The deny-list read (`list_gate_instances {connector}`) only runs with the opt-in; the tab's
    // own unfiltered read for the hidden-instance hint is not it.
    expect(
      http.calls.some(
        (call) =>
          call.name === 'list_gate_instances' &&
          (call.params as { connector?: string } | undefined)?.connector !== undefined,
      ),
    ).toBe(false);
  });

  it('R-41: ticking "also disable all operations" sends every announced and already-refused name with the mode, in one call', async () => {
    const http = scriptedHttp({
      list_connectors: () => ({
        items: [
          connector({ mode: 'self_serve', instanceCount: 2, disabledOperations: ['old_op'] }),
        ],
      }),
      list_gate_instances: (params) => {
        expect(params).toEqual({ connector: 'docker' });
        return {
          items: [
            gateInstance(),
            gateInstance({
              gateId: 'gate-2',
              operations: [
                {
                  name: 'container_list',
                  mode: 'observe',
                  blastRadius: 'low',
                  autoApprovable: true,
                  readOnlyHint: true,
                  destructiveHint: false,
                  idempotentHint: true,
                },
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
            }),
          ],
        };
      },
      set_connector_mode: (params) => {
        expect(params).toEqual({
          name: 'docker',
          mode: 'disabled',
          disabledOperations: ['container_list', 'container_restart', 'old_op'],
        });
        return connector({ mode: 'disabled', instanceCount: 2 });
      },
    });
    renderPage(http);

    const table = await screen.findByTestId('connectors-table');
    const row = within(table).getByTestId('connector-row-docker');
    fireEvent.change(within(row).getByTestId('connector-mode-docker'), {
      target: { value: 'disabled' },
    });
    const confirm = await screen.findByTestId('connector-mode-confirm-docker');
    fireEvent.click(within(confirm).getByTestId('connector-mode-deny-all-checkbox-docker'));
    fireEvent.click(within(confirm).getByTestId('confirm-button'));

    await waitFor(() =>
      expect(http.calls.filter((call) => call.name === 'set_connector_mode')).toHaveLength(1),
    );
  });

  it('switching disabled for a connector with no live instances stays a medium confirm (no retype)', async () => {
    const http = scriptedHttp({
      list_connectors: () => ({ items: [connector({ mode: 'self_serve', instanceCount: 0 })] }),
      set_connector_mode: () => connector({ mode: 'disabled', instanceCount: 0 }),
    });
    renderPage(http);

    const table = await screen.findByTestId('connectors-table');
    const row = within(table).getByTestId('connector-row-docker');
    fireEvent.change(within(row).getByTestId('connector-mode-docker'), {
      target: { value: 'disabled' },
    });

    const confirm = await screen.findByTestId('connector-mode-confirm-docker');
    expect(confirm.getAttribute('data-tier')).toBe('medium');
    // Nothing to cut off: no instance, so no deny-all opt-in either.
    expect(within(confirm).queryByTestId('connector-mode-deny-all-docker')).toBeNull();
  });

  it('expanding a connector row, unchecking an operation (allow-list UX) and confirming posts disabledOperations only', async () => {
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
    fireEvent.click(within(row).getByRole('button', { name: /展开/ }));

    const denyList = await screen.findByTestId('connector-disabled-ops-docker');
    // The union includes the live instance's own Operation plus the already-disabled name that no
    // live instance currently announces.
    expect(within(denyList).getByText('old_op')).toBeTruthy();
    const liveCheckbox = within(denyList).getByLabelText('container_restart') as HTMLInputElement;
    // Console redesign UX inversion (production incident 2026-09-26): checked = the agent may call
    // it, default checked — the opposite of the old "checked = disabled" checklist.
    expect(liveCheckbox.checked).toBe(true);
    fireEvent.click(liveCheckbox);
    expect(liveCheckbox.checked).toBe(false);
    fireEvent.click(within(denyList).getByRole('button', { name: '保存' }));

    // Newly disabling something (unchecking a previously-allowed Operation) needs a confirm naming
    // what would newly stop working — `set_connector_mode` has not fired yet.
    const confirm = await screen.findByTestId('connector-deny-list-confirm-docker');
    expect(http.calls.some((call) => call.name === 'set_connector_mode')).toBe(false);
    fireEvent.click(within(confirm).getByRole('button', { name: '停用' }));

    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'set_connector_mode')).toBe(true),
    );
  });

  it('field-inventory #10: the filter narrows the checklist and "停用筛出的" refuses only what it shows, behind the same confirm', async () => {
    const c = connector({ disabledOperations: ['old_op'] });
    const http = scriptedHttp({
      list_connectors: () => ({ items: [c] }),
      list_gate_instances: () => ({ items: [gateInstance()] }),
      set_connector_mode: (params) => {
        expect(params).toEqual({
          name: 'docker',
          disabledOperations: ['old_op', 'container_restart'],
        });
        return connector({ disabledOperations: ['old_op', 'container_restart'] });
      },
    });
    renderPage(http);

    const table = await screen.findByTestId('connectors-table');
    fireEvent.click(within(table).getByRole('button', { name: /展开/ }));
    const denyList = await screen.findByTestId('connector-disabled-ops-docker');
    expect(within(denyList).getByTestId('connector-ops-count-docker').textContent).toContain(
      '允许 1 / 2',
    );

    fireEvent.change(within(denyList).getByTestId('connector-ops-filter-docker'), {
      target: { value: 'RESTART' },
    });
    expect(within(denyList).queryByLabelText('old_op')).toBeNull();
    fireEvent.click(within(denyList).getByTestId('connector-ops-deny-all-docker'));
    expect((within(denyList).getByLabelText('container_restart') as HTMLInputElement).checked).toBe(
      false,
    );
    fireEvent.click(within(denyList).getByRole('button', { name: '保存' }));
    const confirm = await screen.findByTestId('connector-deny-list-confirm-docker');
    fireEvent.click(within(confirm).getByRole('button', { name: '停用' }));
    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'set_connector_mode')).toBe(true),
    );
  });

  it('re-checking an already-disabled operation (re-enabling it) saves directly, no confirm needed', async () => {
    const c = connector({ disabledOperations: ['container_restart'] });
    const updated = connector({ disabledOperations: [] });
    const http = scriptedHttp({
      list_connectors: () => ({ items: [c] }),
      list_gate_instances: (params) => {
        expect(params).toEqual({ connector: 'docker' });
        return { items: [gateInstance()] };
      },
      set_connector_mode: (params) => {
        expect(params).toEqual({ name: 'docker', disabledOperations: [] });
        return updated;
      },
    });
    renderPage(http);

    const table = await screen.findByTestId('connectors-table');
    const row = within(table).getByTestId('connector-row-docker');
    fireEvent.click(within(row).getByRole('button', { name: /展开/ }));

    const denyList = await screen.findByTestId('connector-disabled-ops-docker');
    const checkbox = within(denyList).getByLabelText('container_restart') as HTMLInputElement;
    expect(checkbox.checked).toBe(false); // already disabled
    fireEvent.click(checkbox); // re-enabling it — never a new restriction
    fireEvent.click(within(denyList).getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'set_connector_mode')).toBe(true),
    );
    expect(screen.queryByTestId('connector-deny-list-confirm-docker')).toBeNull();
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
    // Legacy sweep (console batch, 2026-10-16): the transport column reads MCP, not mcp.
    const instanceRow = within(table).getByTestId('gate-instance-row-gate-1');
    expect(within(instanceRow).getByText('MCP')).toBeTruthy();
    expect(within(instanceRow).queryByText('mcp')).toBeNull();
    fireEvent.click(instanceRow);

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

  // S6-A0 / C13 (docs/console-completion-plan.md §2b): a keyboard user reaches the detail through
  // the row's own 详情 button, not by clicking the <tr>.
  it('gate instance row exposes a Details button as the keyboard path to the detail panel (C13)', async () => {
    const instance = gateInstance();
    const http = scriptedHttp({
      list_gate_instances: () => ({ items: [instance] }),
    });
    renderPage(http);

    fireEvent.click(screen.getByTestId('integrations-tab-instances'));
    const table = await screen.findByTestId('gate-instances-table');
    const open = within(table).getByTestId('gate-instance-open-gate-1');
    expect(open.tagName).toBe('BUTTON');
    fireEvent.click(open);
    await screen.findByTestId('gate-instance-detail');
  });

  it('legacy K (UX acceptance of #538): a held manifest is flagged on its row — with 「调用被拒」 when the gate already refuses calls', async () => {
    const pending = {
      digest: 'd'.repeat(64),
      announcedAt: '2026-10-10T04:00:00.000Z',
      operationCount: 1,
      added: [],
      removed: [],
      changed: [],
    };
    const http = scriptedHttp({
      list_gate_instances: () => ({
        items: [
          gateInstance({
            gateId: 'gate-1',
            displayName: 'UX538 库存宿主',
            status: 'enabled',
            pendingManifest: { ...pending, refusedOperations: ['stock.get'] },
          }),
          gateInstance({
            gateId: 'gate-2',
            displayName: 'Docker prod',
            status: 'enabled',
            pendingManifest: { ...pending, refusedOperations: [] },
          }),
          gateInstance({ gateId: 'gate-3', displayName: 'Billing', status: 'enabled' }),
        ],
      }),
    });
    renderPage(http);
    fireEvent.click(screen.getByTestId('integrations-tab-instances'));
    const table = await screen.findByTestId('gate-instances-table');
    const badges = within(table).getAllByTestId('gate-pending-manifest-badge');
    expect(badges.map((badge) => badge.textContent)).toEqual([
      '新清单待采用 · 调用被拒',
      '新清单待采用',
    ]);
    // The name stays its own text, apart from the badge.
    expect(within(table).getByText('UX538 库存宿主')).toBeTruthy();
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

  // C12 (S6-A0): an http instance can no longer be submitted without a manifest source, so the
  // "omits manifestSource when blank" case is the mcp transport (mirrors CreateGateInstanceForm.test).
  it('creating a hosted instance posts create_gate_instance (mcp omits manifestSource) and opens its detail', async () => {
    const created = hostedGateInstance({ gateId: 'gate-new', displayName: 'gate-new' });
    let sent: unknown;
    const http = scriptedHttp({
      list_gate_instances: () => ({ items: [] }),
      create_gate_instance: (params) => {
        sent = params;
        return created;
      },
    });
    renderPage(http);

    fireEvent.click(screen.getByTestId('integrations-tab-instances'));
    fireEvent.click(await screen.findByTestId('new-gate-instance'));

    const form = await screen.findByTestId('create-gate-instance-form');
    fireEvent.change(within(form).getByLabelText(/门 ID/), {
      target: { value: 'gate-new' },
    });
    fireEvent.click(within(form).getByLabelText(/mcp/));
    fireEvent.change(within(form).getByLabelText(/^目标/), {
      target: { value: 'https://target.internal' },
    });
    fireEvent.click(within(form).getByTestId('create-gate-instance-submit'));

    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'create_gate_instance')).toBe(true),
    );
    // P1: filed under a connector of its own, named after the gate id.
    expect(sent).toEqual({
      gateId: 'gate-new',
      transportKind: 'mcp',
      target: 'https://target.internal',
      credentialMode: 'shared',
      connector: 'gate-new',
    });
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
    // R-46: the irreversible confirm — retype the gate id, acknowledge.
    const confirm = await screen.findByTestId('gate-instance-delete-confirm');
    fireEvent.change(within(confirm).getByTestId('confirm-typed-name'), {
      target: { value: instance.gateId },
    });
    fireEvent.click(within(confirm).getByTestId('confirm-acknowledge'));
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() =>
      expect(http.calls.filter((call) => call.name === 'delete_gate_instance')).toHaveLength(1),
    );
    // The row is still there (delete failed with gate_in_use — a workspace enabled it after the
    // drawer was read) — the confirm stays open with the mapped message inline.
    const deleteError = await within(confirm).findByTestId('confirm-error');
    expect(deleteError.textContent).toContain('还有工作区启用着这个实例');

    // Still in the confirm (the failed attempt leaves it open) — confirm again.
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() =>
      expect(http.calls.filter((call) => call.name === 'delete_gate_instance')).toHaveLength(2),
    );
    await waitFor(() =>
      expect(screen.queryByTestId(`gate-instance-row-${instance.gateId}`)).toBeNull(),
    );
  });

  // P0b (STATUS leftover 118 remainder ①): a gate a workspace connected itself had no platform
  // cut-off — the connector mode gates only new connections, the deny list only catalog links.
  it('P0b: a generic connector row counts its self-connected gates and opens them, filtered to it', async () => {
    const http = scriptedHttp({
      list_connectors: () => ({
        items: [
          connector(),
          connector({
            name: 'http',
            kind: 'http',
            packaged: false,
            selfConnectionCount: 2,
            suspendedSelfConnectionCount: 1,
          }),
        ],
      }),
      list_gate_instances: () => ({ items: [] }),
      list_self_connections: () => ({
        items: [
          selfConnection(),
          selfConnection({ gatekeeperId: 'gk-self-2', connector: 'mcp', target: 'notes' }),
        ],
      }),
    });
    renderPage(http);

    const table = await screen.findByTestId('connectors-table');
    // A packaged connector has none (`create_connection` takes only the generic kinds).
    expect(within(within(table).getByTestId('connector-row-docker')).getByText('—')).toBeTruthy();
    const count = within(table).getByTestId('connector-self-connections-http');
    expect(count.textContent).toBe('2 个（1 个已暂停）');
    fireEvent.click(count);

    const list = await screen.findByTestId('self-connections-table');
    expect(
      (screen.getByTestId('self-connections-connector-filter') as HTMLSelectElement).value,
    ).toBe('http');
    expect(within(list).getByTestId('self-connection-row-gk-self-1')).toBeTruthy();
    expect(within(list).queryByTestId('self-connection-row-gk-self-2')).toBeNull();
    // The filter is chosen from what the list holds, never typed.
    fireEvent.change(screen.getByTestId('self-connections-connector-filter'), {
      target: { value: '' },
    });
    expect(within(list).getByTestId('self-connection-row-gk-self-2')).toBeTruthy();
    expect(
      http.calls.filter((call) => call.name === 'list_self_connections').map((c) => c.params),
    ).toEqual([{}]);
  });

  it('legacy 412: an address the kernel masked whole reads as hidden in the row and its confirm', async () => {
    const http = scriptedHttp({
      list_self_connections: () => ({
        items: [selfConnection({ target: SECRET_FIELD_MASK, endpoint: SECRET_FIELD_MASK })],
      }),
    });
    renderPage(http);
    fireEvent.click(screen.getByTestId('integrations-tab-self'));
    const row = await screen.findByTestId('self-connection-row-gk-self-1');
    expect(row.textContent).toContain('地址带有凭据，已隐藏');
    expect(row.textContent).not.toContain(SECRET_FIELD_MASK);
    fireEvent.click(within(row).getByTestId('self-connection-suspend-gk-self-1'));
    const confirm = await screen.findByTestId('self-connection-confirm-gk-self-1');
    expect(confirm.textContent).toContain('暂停「地址带有凭据，已隐藏」');
    expect(confirm.textContent).not.toContain(SECRET_FIELD_MASK);
  });

  it('P0b: 暂停 is a medium confirm saying what stops and what stays; the reason is optional and trimmed; the row shows who suspended it and why', async () => {
    const http = scriptedHttp({
      list_self_connections: () => ({ items: [selfConnection()] }),
      suspend_self_connection: (params) => {
        expect(params).toEqual({
          workspaceId: 'ws-1',
          gatekeeperId: 'gk-self-1',
          reason: '它会外发客户数据',
        });
        return selfConnection({
          suspendedAt: '2026-10-16T00:00:00.000Z',
          suspendedByLogin: 'root-admin',
          suspensionReason: '它会外发客户数据',
        });
      },
    });
    renderPage(http);
    fireEvent.click(screen.getByTestId('integrations-tab-self'));

    const row = await screen.findByTestId('self-connection-row-gk-self-1');
    expect(within(row).getByText('使用中')).toBeTruthy();
    expect(within(row).getByText('Alice')).toBeTruthy();
    fireEvent.click(within(row).getByTestId('self-connection-suspend-gk-self-1'));
    expect(http.calls.some((call) => call.name === 'suspend_self_connection')).toBe(false);

    const confirm = await screen.findByTestId('self-connection-confirm-gk-self-1');
    expect(confirm.getAttribute('data-tier')).toBe('medium');
    expect(confirm.textContent).toContain('全部 Operation 都被拒绝');
    expect(confirm.textContent).toContain('连接、它的 Operation 和历史都保留');
    expect(confirm.textContent).toContain('https://grafana-gate.example');
    fireEvent.change(within(confirm).getByTestId('self-connection-reason-input-gk-self-1'), {
      target: { value: '  它会外发客户数据  ' },
    });
    fireEvent.click(within(confirm).getByTestId('confirm-button'));

    const suspension = await screen.findByTestId('self-connection-suspension-gk-self-1');
    expect(suspension.textContent).toContain('root-admin');
    expect(suspension.textContent).toContain('原因：它会外发客户数据');
    expect(within(row).getByText('已暂停')).toBeTruthy();
    expect(within(row).getByTestId('self-connection-resume-gk-self-1')).toBeTruthy();
  });

  it('P0b: 暂停 without a reason sends none; 恢复 posts resume_self_connection and the row is in use again', async () => {
    const suspended = selfConnection({
      suspendedAt: '2026-10-16T00:00:00.000Z',
      suspendedByLogin: 'root-admin',
    });
    const http = scriptedHttp({
      list_self_connections: () => ({
        items: [selfConnection(), { ...suspended, gatekeeperId: 'gk-self-2' }],
      }),
      suspend_self_connection: (params) => {
        expect(params).toEqual({ workspaceId: 'ws-1', gatekeeperId: 'gk-self-1' });
        return suspended;
      },
      resume_self_connection: (params) => {
        expect(params).toEqual({ workspaceId: 'ws-1', gatekeeperId: 'gk-self-2' });
        return selfConnection({ gatekeeperId: 'gk-self-2' });
      },
    });
    renderPage(http);
    fireEvent.click(screen.getByTestId('integrations-tab-self'));

    const resumable = await screen.findByTestId('self-connection-row-gk-self-2');
    fireEvent.click(within(resumable).getByTestId('self-connection-resume-gk-self-2'));
    const resumeConfirm = await screen.findByTestId('self-connection-confirm-gk-self-2');
    expect(resumeConfirm.textContent).toContain('恢复可调用');
    expect(
      within(resumeConfirm).queryByTestId('self-connection-reason-input-gk-self-2'),
    ).toBeNull();
    fireEvent.click(within(resumeConfirm).getByTestId('confirm-button'));
    await waitFor(() => expect(within(resumable).getByText('使用中')).toBeTruthy());

    const row = screen.getByTestId('self-connection-row-gk-self-1');
    fireEvent.click(within(row).getByTestId('self-connection-suspend-gk-self-1'));
    const confirm = await screen.findByTestId('self-connection-confirm-gk-self-1');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    await waitFor(() => expect(within(row).getByText('已暂停')).toBeTruthy());
  });

  it('P0b: a refused 暂停 stays in the confirm with its own copy; the row is unchanged', async () => {
    const http = scriptedHttp({
      list_self_connections: () => ({ items: [selfConnection()] }),
      suspend_self_connection: () => {
        throw new HttpError(
          'capability_error',
          'no gate that workspace connected itself has that id',
          'self_connection_not_found',
        );
      },
    });
    renderPage(http);
    fireEvent.click(screen.getByTestId('integrations-tab-self'));
    const row = await screen.findByTestId('self-connection-row-gk-self-1');
    fireEvent.click(within(row).getByTestId('self-connection-suspend-gk-self-1'));
    const confirm = await screen.findByTestId('self-connection-confirm-gk-self-1');
    fireEvent.click(within(confirm).getByTestId('confirm-button'));
    const error = await within(confirm).findByTestId('confirm-error');
    // Legacy 377: the likely reason leads — the workspace's catalog enable claimed it.
    expect(error.textContent).toContain('多半是工作区从目录启用了同地址的平台实例');
    expect(within(row).getByText('使用中')).toBeTruthy();
  });

  it('P0b: a self connection at a platform instance’s address says whose credential its calls use, and opens that instance', async () => {
    const http = scriptedHttp({
      list_self_connections: () => ({
        items: [selfConnection({ connectedByName: null, catalogGateId: 'gate-1' })],
      }),
      list_gate_instances: () => ({ items: [gateInstance()] }),
      list_connectors: () => ({ items: [connector()] }),
    });
    renderPage(http);
    fireEvent.click(screen.getByTestId('integrations-tab-self'));

    const note = await screen.findByTestId('self-connection-catalog-gk-self-1');
    expect(note.textContent).toContain('平台门实例「gate-1」');
    expect(note.textContent).toContain('调用会用平台给这个实例的凭证');
    // Recorded by core 0045's backfill: nobody to name.
    expect(screen.getByTestId('self-connection-row-gk-self-1').textContent).toContain(
      '升级前接入，未记录接入人',
    );
    fireEvent.click(screen.getByTestId('self-connection-show-instance-gk-self-1'));
    expect(await screen.findByTestId('gate-instances-table')).toBeTruthy();
  });

  // UX acceptance of #620 (P2-1): at phone width a self connection is one card — its system, its
  // status and its 暂停 in the same card, nothing scrolled off to the right.
  it('P0b: at ≤ 768px each self connection is a card with its system, status and 暂停 together', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query.includes('max-width: 768px'),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    try {
      const http = scriptedHttp({
        list_self_connections: () => ({
          items: [
            selfConnection({
              suspendedAt: '2026-10-16T00:00:00.000Z',
              suspendedByLogin: 'root-admin',
              suspensionReason: '门在维护',
            }),
          ],
        }),
      });
      renderPage(http);
      fireEvent.click(screen.getByTestId('integrations-tab-self'));

      const card = await screen.findByTestId('self-connection-row-gk-self-1');
      expect(card.tagName).toBe('LI');
      expect(card.textContent).toContain('grafana');
      expect(card.textContent).toContain('https://grafana-gate.example');
      expect(card.textContent).toContain('Acme');
      expect(within(card).getByText('已暂停')).toBeTruthy();
      expect(
        within(card).getByTestId('self-connection-suspension-gk-self-1').textContent,
      ).toContain('原因：门在维护');
      expect(within(card).getByTestId('self-connection-resume-gk-self-1')).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // UX acceptance of #620 (P2-2): the 暂停 confirm keeps to what happens next; what a suspension
  // covers is in the tab's introduction.
  it('P0b: what a suspension covers is said in the tab, not in the 暂停 confirm', async () => {
    const http = scriptedHttp({ list_self_connections: () => ({ items: [selfConnection()] }) });
    renderPage(http);
    fireEvent.click(screen.getByTestId('integrations-tab-self'));
    const tab = await screen.findByTestId('integrations-self-connections');
    expect(tab.textContent).toContain('暂停只管这一条连接');
    expect(tab.textContent).toContain('在「接入包」里改它的模式');

    fireEvent.click(await screen.findByTestId('self-connection-suspend-gk-self-1'));
    const confirm = await screen.findByTestId('self-connection-confirm-gk-self-1');
    expect(confirm.textContent).toContain('随时可以恢复');
    expect(confirm.textContent).not.toContain('只管这一条连接');
    expect(confirm.textContent).not.toContain('接入包');
  });

  it('P0b: an empty filtered list names the connector it is filtered to', async () => {
    const http = scriptedHttp({
      list_connectors: () => ({
        items: [connector({ name: 'ssh', kind: 'ssh', packaged: false, selfConnectionCount: 1 })],
      }),
      list_gate_instances: () => ({ items: [] }),
      list_self_connections: () => ({ items: [] }),
    });
    renderPage(http);
    fireEvent.click(await screen.findByTestId('connector-self-connections-ssh'));
    const empty = await screen.findByTestId('self-connections-empty');
    expect(empty.textContent).toContain('没有经「SSH」自己接入的门');
  });

  it('legacy 380: the tab is in the URL — a reload lands on it, and switching writes it', async () => {
    window.location.hash = '#/platform/integrations?tab=runtimes';
    const http = scriptedHttp({ list_external_runtimes: () => ({ items: [runtime()] }) });
    renderPage(http);
    expect(await screen.findByTestId('external-runtimes-table')).toBeTruthy();
    expect(screen.getByTestId('integrations-tab-runtimes').getAttribute('aria-selected')).toBe(
      'true',
    );
    fireEvent.click(screen.getByTestId('integrations-tab-self'));
    expect(window.location.hash).toBe('#/platform/integrations?tab=self');
    fireEvent.click(screen.getByTestId('integrations-tab-connectors'));
    expect(window.location.hash).toBe('#/platform/integrations');
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
    fireEvent.click(within(table).getByRole('button', { name: '确认吊销' }));

    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'revoke_external_runtime')).toBe(true),
    );
    await waitFor(() => expect(screen.queryByTestId('external-runtime-row-sess-1')).toBeNull());
  });
});
