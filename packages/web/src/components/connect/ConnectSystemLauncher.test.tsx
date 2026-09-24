// @vitest-environment jsdom
import type { AvailableGateInstanceWire, ConnectorWire, GateInstanceWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { ConnectSystemLauncher, type ConnectSystemLauncherProps } from './ConnectSystemLauncher.js';

/**
 * ConnectSystemLauncher.test.tsx: the three paths of the "接入一个系统" launcher (S6-C, §5.6)
 * over scripted capabilities — hosted (http / mcp) from the platform page, hosted from the
 * workspace page as a non-admin, and packaged (ssh / cli) waiting for the announce — plus B7
 * (no 启用 for an already-enabled instance). Composed forms (`CreateGateInstanceForm`,
 * `OnboardingWizardReview`) keep their own tests; here they are driven only far enough to prove
 * the composition.
 */

afterEach(cleanup);

function scriptedHttp(
  handlers: Record<string, (params: unknown) => unknown | Promise<unknown>>,
): CapabilityCaller & { readonly calls: { readonly name: string; readonly params: unknown }[] } {
  const calls: { name: string; params: unknown }[] = [];
  const base: Record<string, (params: unknown) => unknown> = {
    list_gate_instances: () => ({ items: [] }),
    list_available_gate_instances: () => ({ items: [] }),
    list_connectors: () => ({ items: [] }),
    list_principals: () => ({ items: [] }),
    search: () => ({ items: [] }),
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

function gateInstance(overrides: Partial<GateInstanceWire> = {}): GateInstanceWire {
  return {
    gateId: 'billing',
    connector: 'http',
    displayName: 'Billing API',
    transportKind: 'http',
    target: 'https://billing.internal',
    endpoint: '',
    status: 'discovered',
    trust: 'byo',
    health: 'unknown',
    lastSeenAt: null,
    lastCheckedAt: null,
    operationCount: 0,
    enabledWorkspaceCount: 0,
    operations: [],
    hosted: true,
    definition: {
      transportKind: 'http',
      target: 'https://billing.internal',
      credentialMode: 'shared',
      manifestSource: 'https://billing.internal/openapi.json',
    },
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
    ...overrides,
  };
}

function announced(overrides: Partial<GateInstanceWire> = {}): GateInstanceWire {
  return gateInstance({
    endpoint: 'http://gate-host:8083/i/billing',
    health: 'ok',
    lastSeenAt: '2026-09-19T00:01:00.000Z',
    operationCount: 2,
    operations: [
      {
        name: 'invoices.list',
        mode: 'observe',
        blastRadius: 'low',
        autoApprovable: true,
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      {
        name: 'invoices.void',
        mode: 'execute',
        blastRadius: 'medium',
        autoApprovable: false,
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    ],
    updatedAt: '2026-09-19T00:01:00.000Z',
    ...overrides,
  });
}

function connector(overrides: Partial<ConnectorWire> = {}): ConnectorWire {
  return {
    name: 'http',
    kind: 'http',
    packaged: false,
    mode: 'self_serve',
    disabledOperations: [],
    operationCount: 2,
    instanceCount: 1,
    updatedAt: null,
    ...overrides,
  };
}

function availableRow(
  overrides: Partial<AvailableGateInstanceWire> = {},
): AvailableGateInstanceWire {
  return {
    gateId: 'docker-prod',
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

function renderLauncher(props: Partial<ConnectSystemLauncherProps> & { http: CapabilityCaller }) {
  const onFinished = vi.fn();
  const onCancel = vi.fn();
  const view = render(
    <PermissionsProvider>
      <ConnectSystemLauncher
        origin="platform"
        onCancel={onCancel}
        onFinished={onFinished}
        {...props}
      />
    </PermissionsProvider>,
  );
  return { ...view, onFinished, onCancel };
}

function launcher() {
  return screen.getByTestId('connect-system-launcher');
}

function next() {
  fireEvent.click(screen.getByTestId('launcher-next'));
}

describe('ConnectSystemLauncher — hosted path from the platform page', () => {
  it('creates the instance, waits for the gate host, enables it (B7: only while discovered), presets the connector, tests the connection and finishes with the gate id', async () => {
    let created = false;
    let takenOver = false;
    let enabledOnPlatform = false;
    let preset = false;
    const current = () =>
      !created
        ? []
        : [
            (takenOver ? announced : gateInstance)({
              status: enabledOnPlatform ? 'enabled' : 'discovered',
            }),
          ];
    const http = scriptedHttp({
      list_gate_instances: () => ({ items: current() }),
      list_connectors: () => ({
        items: [connector({ mode: preset ? 'platform_preset' : 'self_serve' })],
      }),
      create_gate_instance: (params) => {
        expect(params).toMatchObject({ gateId: 'billing', transportKind: 'http' });
        created = true;
        return gateInstance();
      },
      update_gate_instance: (params) => {
        expect(params).toEqual({ gateId: 'billing', status: 'enabled' });
        enabledOnPlatform = true;
        return announced({ status: 'enabled' });
      },
      set_connector_mode: (params) => {
        expect(params).toEqual({ name: 'http', mode: 'platform_preset' });
        preset = true;
        return connector({ mode: 'platform_preset' });
      },
      test_gate_instance: () => ({
        gateId: 'billing',
        health: 'ok',
        describedOperationCount: 2,
        checkedAt: '2026-09-19T00:02:00.000Z',
      }),
    });
    const onInstanceChanged = vi.fn();
    const { onFinished } = renderLauncher({ http, origin: 'platform', onInstanceChanged });

    // Step 1: kind + path copy.
    expect(screen.getByTestId('launcher-next').hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByTestId('launcher-kind-http'));
    expect(screen.getByTestId('launcher-path-copy').textContent).toContain('门宿主');
    next();

    // Step 2: the platform form is composed as-is.
    expect(launcher().getAttribute('data-step')).toBe('1');
    const form = await screen.findByTestId('create-gate-instance-form');
    fireEvent.change(within(form).getByLabelText(/Gate id/), { target: { value: 'billing' } });
    fireEvent.change(within(form).getByLabelText(/^目标/), {
      target: { value: 'https://billing.internal' },
    });
    fireEvent.change(within(form).getByLabelText(/Manifest source/), {
      target: { value: 'https://billing.internal/openapi.json' },
    });
    expect(screen.getByTestId('launcher-next').hasAttribute('disabled')).toBe(true);
    fireEvent.click(within(form).getByTestId('create-gate-instance-submit'));

    const summary = await screen.findByTestId('launcher-selected-gate');
    expect(onInstanceChanged).toHaveBeenCalledTimes(1);
    expect(within(summary).getByTestId('launcher-gate-status').textContent).toContain(
      '等待宿主接管',
    );
    expect(within(summary).getByTestId('launcher-awaiting-announce')).toBeTruthy();
    // Shared credential entry goes straight to the gate host (the token button is the entry).
    expect(within(summary).getByTestId('launcher-shared-credential')).toBeTruthy();
    expect(screen.getByTestId('launcher-next').hasAttribute('disabled')).toBe(false);

    // The gate host takes it over: the next poll replaces the created row.
    takenOver = true;
    next();
    expect(launcher().getAttribute('data-step')).toBe('2');
    const platformSide = await screen.findByTestId('launcher-platform-enable');
    const enableButton = await within(platformSide).findByTestId('launcher-platform-enable-button');
    await waitFor(() => expect(enableButton.hasAttribute('disabled')).toBe(false));
    expect(enableButton.textContent).toContain('启用');
    expect(screen.getByTestId('launcher-announced-operations').textContent).toContain(
      'invoices.void',
    );
    // The workspace half is a link from the platform page.
    expect(
      screen.getByTestId('launcher-policy-workspace-link').querySelector('a')?.getAttribute('href'),
    ).toBe('#/govern/systems');

    fireEvent.click(enableButton);
    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'update_gate_instance')).toBe(true),
    );
    // B7: enabled → no 启用 button any more.
    await waitFor(() =>
      expect(within(platformSide).queryByTestId('launcher-platform-enable-button')).toBeNull(),
    );
    expect(within(platformSide).getByTestId('launcher-platform-status').textContent).toContain(
      '已启用',
    );

    // Connector must be platform-preset before a workspace can enable from the catalog.
    const presetBlock = await screen.findByTestId('launcher-connector-preset');
    fireEvent.click(within(presetBlock).getByTestId('launcher-connector-preset-button'));
    await waitFor(() => expect(screen.queryByTestId('launcher-connector-preset')).toBeNull());
    expect(screen.getByTestId('launcher-connector-ok').textContent).toContain('平台预置');

    // Step 4: handshake.
    next();
    expect(launcher().getAttribute('data-step')).toBe('3');
    fireEvent.click(screen.getByTestId('launcher-test-connection'));
    const result = await screen.findByTestId('launcher-test-result');
    expect(result.textContent).toContain('2');
    expect(screen.getByTestId('launcher-handshake-health').textContent).toContain('健康');
    expect(screen.getByTestId('launcher-handshake-ok')).toBeTruthy();
    expect(screen.getByTestId('launcher-next').textContent).toBe('完成');
    next();
    expect(onFinished).toHaveBeenCalledWith({ gateId: 'billing', gatekeeperId: null });
  });

  it('B7: an already enabled · ok instance picked from the list shows no 启用 button; a disabled one offers 重新启用', async () => {
    const http = scriptedHttp({
      list_gate_instances: () => ({
        items: [
          announced({ gateId: 'on', displayName: 'On', status: 'enabled' }),
          announced({ gateId: 'off', displayName: 'Off', status: 'disabled' }),
        ],
      }),
      list_connectors: () => ({ items: [connector({ mode: 'platform_preset' })] }),
    });
    renderLauncher({ http, origin: 'platform' });
    fireEvent.click(screen.getByTestId('launcher-kind-http'));
    next();
    const picker = await screen.findByTestId('launcher-existing-gates');
    fireEvent.click(await within(picker).findByTestId('launcher-gate-on'));
    next();
    const platformSide = await screen.findByTestId('launcher-platform-enable');
    expect(within(platformSide).queryByTestId('launcher-platform-enable-button')).toBeNull();
    expect(within(platformSide).getByTestId('launcher-platform-status').textContent).toContain(
      '已启用',
    );
    await screen.findByTestId('launcher-connector-ok');

    fireEvent.click(screen.getByTestId('launcher-back'));
    fireEvent.click(
      within(screen.getByTestId('launcher-existing-gates')).getByTestId('launcher-gate-off'),
    );
    next();
    const reenable = await screen.findByTestId('launcher-platform-enable-button');
    expect(reenable.textContent).toContain('重新启用');
  });
});

describe('ConnectSystemLauncher — hosted path from the workspace page (non-admin owner)', () => {
  it('points at the platform 集成', async () => {
    const http = scriptedHttp({
      list_available_gate_instances: () => ({ items: [availableRow()] }),
      enable_gate_instance: (params) => {
        expect(params).toEqual({ gateId: 'docker-prod' });
        return {
          gateId: 'docker-prod',
          gatekeeperId: 'gk-9',
          publishedOperationNames: ['container_list', 'container_restart'],
          skippedOperationNames: [],
        };
      },
      list_principals: () => ({
        items: [
          {
            id: 'p-alice',
            kind: 'human',
            role: 'member',
            displayName: 'Alice',
            createdAt: '2026-09-01T00:00:00.000Z',
            hasApiKey: true,
          },
        ],
      }),
      connect_gatekeeper: (params) => {
        expect(params).toEqual({ gatekeeperId: 'gk-9', principalId: 'p-alice' });
        return { id: 'grant-1' };
      },
    });
    const onEnabled = vi.fn();
    const { onFinished } = renderLauncher({
      http,
      origin: 'workspace',
      platformAdmin: false,
      canEnable: true,
      available: [availableRow()],
      onEnabled,
    });
    fireEvent.click(screen.getByTestId('launcher-kind-mcp'));
    next();
    const notice = await screen.findByTestId('launcher-needs-admin');
    expect(notice.textContent).toContain('需要管理员');
    expect(notice.querySelector('a')?.getAttribute('href')).toBe('#/platform/integrations');
    expect(screen.queryByTestId('create-gate-instance-form')).toBeNull();
    // Reads the workspace catalog, never the platform list.
    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'list_available_gate_instances')).toBe(true),
    );
    expect(http.calls.some((call) => call.name === 'list_gate_instances')).toBe(false);
    fireEvent.click(await screen.findByTestId('launcher-gate-docker-prod'));
    next();

    expect(screen.getByTestId('launcher-policy-needs-admin')).toBeTruthy();
    const workspaceSide = screen.getByTestId('launcher-workspace-enable');
    fireEvent.click(within(workspaceSide).getByTestId('launcher-workspace-enable-button'));
    const linked = await within(workspaceSide).findByTestId('launcher-workspace-linked');
    expect(onEnabled).toHaveBeenCalledTimes(1);
    expect(linked.textContent).toContain('已发布 2 个');
    expect(within(linked).getByTestId('launcher-gatekeeper-chip').getAttribute('data-ref-id')).toBe(
      'gk-9',
    );
    // The composed review (search{objectType:'Operation'}) and the grant form appear.
    await screen.findByTestId('wizard-review');
    expect(http.calls.some((call) => call.name === 'search')).toBe(true);
    const grant = screen.getByTestId('launcher-grant');
    const select = await within(grant).findByLabelText(/成员/);
    fireEvent.change(select, { target: { value: 'p-alice' } });
    fireEvent.click(within(grant).getByTestId('launcher-grant-submit'));
    const granted = await within(grant).findByTestId('launcher-granted');
    expect(granted.textContent).toContain('Alice');

    next();
    expect(screen.getByTestId('launcher-handshake-gatekeeper').getAttribute('data-ref-id')).toBe(
      'gk-9',
    );
    expect(screen.queryByTestId('launcher-test-connection')).toBeNull();
    next();
    expect(onFinished).toHaveBeenCalledWith({ gateId: 'docker-prod', gatekeeperId: 'gk-9' });
  });

  it('a workspace member who is not an owner sees the owner-only notice instead of the enable button', async () => {
    const http = scriptedHttp({
      list_available_gate_instances: () => ({ items: [availableRow()] }),
    });
    renderLauncher({ http, origin: 'workspace', canEnable: false, available: [availableRow()] });
    fireEvent.click(screen.getByTestId('launcher-kind-mcp'));
    next();
    fireEvent.click(await screen.findByTestId('launcher-gate-docker-prod'));
    next();
    expect(screen.getByTestId('launcher-workspace-enable-owner-only')).toBeTruthy();
    expect(screen.queryByTestId('launcher-workspace-enable-button')).toBeNull();
  });

  it('shows the kernel refusal inline when enable_gate_instance rejects (connector_not_preset)', async () => {
    const http = scriptedHttp({
      list_available_gate_instances: () => ({ items: [availableRow()] }),
      enable_gate_instance: () => {
        throw new HttpError('capability_error', 'not preset', 'connector_not_preset');
      },
    });
    renderLauncher({ http, origin: 'workspace', canEnable: true, available: [availableRow()] });
    fireEvent.click(screen.getByTestId('launcher-kind-mcp'));
    next();
    fireEvent.click(await screen.findByTestId('launcher-gate-docker-prod'));
    next();
    fireEvent.click(screen.getByTestId('launcher-workspace-enable-button'));
    const error = await screen.findByTestId('launcher-workspace-enable-error');
    expect(error.textContent).toContain('不是平台预置模式');
  });
});

describe('ConnectSystemLauncher — packaged path (ssh / cli)', () => {
  it('shows the deployment checklist with the typed GATE_ID, polls until the gate announces, then auto-selects it', async () => {
    let announcedYet = false;
    const http = scriptedHttp({
      list_gate_instances: () => ({
        items: announcedYet
          ? [
              announced({
                gateId: 'gatekeeper-ops-host',
                connector: 'ops-host',
                displayName: 'Ops host',
                transportKind: 'ssh',
                hosted: false,
                definition: null,
              }),
            ]
          : [],
      }),
    });
    renderLauncher({ http, origin: 'platform', pollIntervalMs: 200 });
    fireEvent.click(screen.getByTestId('launcher-kind-ssh'));
    expect(screen.getByTestId('launcher-path-copy').textContent).toContain('打包门');
    next();

    const checklist = await screen.findByTestId('launcher-packaged-checklist');
    expect(screen.queryByTestId('create-gate-instance-form')).toBeNull();
    const compose = within(checklist).getByTestId('packaged-gate-compose');
    expect(compose.textContent).toContain('GATE_ID: <gate-id>');
    expect(compose.textContent).toContain('GATE_TRANSPORT_KIND: ssh');
    expect(compose.textContent).toContain('secrets: [gate_token, internal_token]');
    expect(compose.textContent).toContain('KERNEL_URL: http://kernel:8080');
    expect(compose.textContent).toContain('${NEXTTIME_DATA}/secrets/<system>:/data/secrets:ro');
    expect(within(checklist).getByTestId('packaged-gate-notice').textContent).toContain('未启用');
    expect(within(checklist).getByTestId('packaged-gate-steps').textContent).toContain(
      '不要用 ssh 这个通用名',
    );

    fireEvent.change(screen.getByLabelText(/它的/), {
      target: { value: 'gatekeeper-ops-host' },
    });
    expect(within(checklist).getByTestId('packaged-gate-compose').textContent).toContain(
      'GATE_ID: gatekeeper-ops-host',
    );
    expect(within(checklist).getByTestId('packaged-gate-compose').textContent).toContain(
      'GATE_CONNECTOR: ops-host',
    );
    expect(within(checklist).getByTestId('packaged-gate-compose').textContent).toContain(
      '  gatekeeper-ops-host:',
    );

    await screen.findByTestId('launcher-gates-empty');
    expect(screen.getByTestId('launcher-next').hasAttribute('disabled')).toBe(true);

    // The gate comes up and announces; the poll's next read finds it and the typed id selects it.
    announcedYet = true;
    await waitFor(() => {
      expect(screen.queryByTestId('launcher-gate-gatekeeper-ops-host')).not.toBeNull();
    });
    await waitFor(() =>
      expect(
        (screen.getByTestId('launcher-gate-gatekeeper-ops-host') as HTMLInputElement).checked,
      ).toBe(true),
    );
    expect(screen.getByTestId('launcher-next').hasAttribute('disabled')).toBe(false);
  });

  it('a non-admin on the workspace page is told the gate only appears after an administrator enables + presets it', async () => {
    const http = scriptedHttp({});
    renderLauncher({ http, origin: 'workspace', canEnable: true });
    fireEvent.click(screen.getByTestId('launcher-kind-cli'));
    next();
    await screen.findByTestId('launcher-packaged-checklist');
    const empty = await screen.findByTestId('launcher-gates-empty');
    expect(empty.textContent).toContain('由管理员启用、设为平台预置');
    expect(http.calls.some((call) => call.name === 'list_available_gate_instances')).toBe(true);
  });
});
