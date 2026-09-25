// @vitest-environment jsdom
import type { GateInstanceWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { GateInstanceDetailPanel } from './GateInstanceDetailPanel.js';

/**
 * GateInstanceDetailPanel.test.tsx (C22, docs/console-completion-plan.md §2b): the drawer body on
 * its own — B7's status button per machine state, the health chip, MCP-only trust, the hosted
 * definition + shared-credential entry, delete, test connection, and S6-C's "workspaces using
 * it" section with the current workspace's Gatekeeper link. `PlatformIntegrationsPage.test.tsx`
 * keeps the page-level flows (open from the row, splice after a write).
 */

afterEach(cleanup);

function scriptedHttp(
  handlers: Record<string, (params: unknown) => unknown | Promise<unknown>>,
): CapabilityCaller & { readonly calls: { readonly name: string; readonly params: unknown }[] } {
  const calls: { name: string; params: unknown }[] = [];
  const base: Record<string, (params: unknown) => unknown> = {
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

function renderPanel(http: CapabilityCaller, instance: GateInstanceWire) {
  const onChanged = vi.fn();
  const onDeleted = vi.fn();
  const view = render(
    <PermissionsProvider>
      <GateInstanceDetailPanel
        http={http}
        instance={instance}
        onChanged={onChanged}
        onDeleted={onDeleted}
      />
    </PermissionsProvider>,
  );
  return { ...view, onChanged, onDeleted };
}

describe('GateInstanceDetailPanel', () => {
  // B7 (§4 "接入三层"): 启用 only in `discovered`; the button's meaning follows the machine.
  it('B7: the status button reads 启用 for discovered and lost, 禁用 for enabled, 重新启用 for disabled, and a disabled 启用', () => {
    const http = scriptedHttp({});
    const cases: readonly [Partial<GateInstanceWire>, string, boolean][] = [
      [{ status: 'discovered' }, '启用', false],
      [{ status: 'enabled' }, '禁用', false],
      [{ status: 'disabled' }, '重新启用', false],
      [{ status: 'lost' }, '启用', false],
      [{ status: 'discovered', hosted: true, lastSeenAt: null }, '启用', true],
    ];
    for (const [overrides, label, disabled] of cases) {
      renderPanel(http, gateInstance(overrides));
      const toggle = screen.getByTestId('gate-instance-status-toggle');
      expect(toggle.textContent).toContain(label);
      expect(toggle.hasAttribute('disabled')).toBe(disabled);
      cleanup();
    }
  });

  it('enabling a discovered instance posts update_gate_instance{status:"enabled"} and hands back the row', async () => {
    const enabled = gateInstance({ status: 'enabled' });
    const http = scriptedHttp({
      update_gate_instance: (params) => {
        expect(params).toEqual({ gateId: 'gate-1', status: 'enabled' });
        return enabled;
      },
    });
    const { onChanged } = renderPanel(http, gateInstance());
    fireEvent.click(screen.getByTestId('gate-instance-status-toggle'));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(enabled));
  });

  it('renders health and status as chips, and the trust control only for an mcp instance', () => {
    const http = scriptedHttp({});
    renderPanel(http, gateInstance({ health: 'unreachable', status: 'enabled' }));
    expect(screen.getByTestId('gate-instance-detail-health').textContent).toContain('不可达');
    expect(screen.getByTestId('gate-instance-detail-status').textContent).toContain('已启用');
    expect(screen.getByTestId('gate-instance-trust-toggle')).toBeTruthy();
    cleanup();
    renderPanel(http, gateInstance({ transportKind: 'http', connector: 'http' }));
    expect(screen.queryByTestId('gate-instance-trust-toggle')).toBeNull();
  });

  it('marks an mcp instance vetted through update_gate_instance{trust}', async () => {
    const vetted = gateInstance({ trust: 'vetted' });
    const http = scriptedHttp({
      update_gate_instance: (params) => {
        expect(params).toEqual({ gateId: 'gate-1', trust: 'vetted' });
        return vetted;
      },
    });
    const { onChanged } = renderPanel(http, gateInstance());
    fireEvent.click(screen.getByTestId('gate-instance-trust-toggle'));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(vetted));
  });

  it('test connection posts test_gate_instance and shows the result; a failure shows inline', async () => {
    let attempt = 0;
    const http = scriptedHttp({
      test_gate_instance: () => {
        attempt += 1;
        if (attempt === 1) {
          return {
            gateId: 'gate-1',
            health: 'ok',
            describedOperationCount: 4,
            checkedAt: '2026-09-11T00:00:00.000Z',
          };
        }
        throw new HttpError('capability_error', 'no such gate', 'gate_not_found');
      },
    });
    renderPanel(http, gateInstance());
    fireEvent.click(screen.getByTestId('gate-instance-test'));
    const result = await screen.findByTestId('gate-instance-test-result');
    expect(result.textContent).toContain('4');
    fireEvent.click(screen.getByTestId('gate-instance-test'));
    await waitFor(() => expect(screen.getByText(/找不到该门实例/)).toBeTruthy());
  });

  it('hosted + shared: shows the definition, the 5-minute token button and delete; delete posts delete_gate_instance', async () => {
    const http = scriptedHttp({
      delete_gate_instance: (params) => {
        expect(params).toEqual({ gateId: 'gate-h' });
        return { gateId: 'gate-h', deleted: true };
      },
    });
    const { onDeleted } = renderPanel(
      http,
      gateInstance({
        gateId: 'gate-h',
        connector: 'http',
        transportKind: 'http',
        hosted: true,
        definition: {
          transportKind: 'http',
          target: 'https://billing.internal',
          credentialMode: 'shared',
          manifestSource: 'https://billing.internal/openapi.json',
        },
      }),
    );
    const definition = screen.getByTestId('gate-instance-hosted-definition');
    expect(definition.textContent).toContain('共享');
    expect(within(definition).getByTestId('gate-credential-token-button')).toBeTruthy();
    fireEvent.click(screen.getByTestId('gate-instance-delete'));
    fireEvent.click(screen.getByTestId('gate-instance-delete-confirm'));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('gate-h'));
  });

  it('renames through update_gate_instance{displayName} only when the name changed', async () => {
    const renamed = gateInstance({ displayName: 'Docker staging' });
    const http = scriptedHttp({
      update_gate_instance: (params) => {
        expect(params).toEqual({ gateId: 'gate-1', displayName: 'Docker staging' });
        return renamed;
      },
    });
    const { onChanged } = renderPanel(http, gateInstance());
    const save = screen.getByRole('button', { name: '保存' });
    expect(save.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText(/名称/), {
      target: { value: 'Docker staging' },
    });
    fireEvent.click(save);
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(renamed));
  });

  // S6-C §5.6 instance → connection link: the count from the wire, plus this session's own
  // workspace link when `list_available_gate_instances` says it enabled the instance.
  it('lists the workspaces using it with the current workspace’s Gatekeeper chip linking to 系统接入', async () => {
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
            operationCount: 1,
            gatekeeperId: 'gk-7',
          },
        ],
      }),
    });
    renderPanel(http, gateInstance({ status: 'enabled', enabledWorkspaceCount: 2 }));
    const section = screen.getByTestId('gate-instance-workspaces');
    expect(section.textContent).toContain('2 个工作区已启用');
    const chip = await within(section).findByTestId('gate-instance-own-gatekeeper');
    expect(chip.getAttribute('data-ref-id')).toBe('gk-7');
    expect(chip.querySelector('a')?.getAttribute('href')).toBe('#/govern/systems/gk-7');
    expect(within(section).getByTestId('gate-instance-systems-link').getAttribute('href')).toBe(
      '#/govern/systems',
    );
  });

  it('the workspace read failing (platform-only session, 403) leaves only the count and the link', async () => {
    const http = scriptedHttp({
      list_available_gate_instances: () => {
        throw new HttpError('capability_error', 'no workspace', 'forbidden');
      },
    });
    renderPanel(http, gateInstance({ enabledWorkspaceCount: 0 }));
    const section = screen.getByTestId('gate-instance-workspaces');
    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'list_available_gate_instances')).toBe(true),
    );
    expect(section.textContent).toContain('还没有工作区启用它');
    expect(within(section).queryByTestId('gate-instance-own-workspace')).toBeNull();
    expect(within(section).getByTestId('gate-instance-systems-link')).toBeTruthy();
  });

  it('S8 W4-C (ui-audit PI3): lists the enabling workspaces by name when the wire carries them, and notes any left out of a truncated list', () => {
    const http = scriptedHttp({});
    renderPanel(
      http,
      gateInstance({
        enabledWorkspaceCount: 4,
        enablingWorkspaces: [
          { id: 'ws-1', name: 'Acme' },
          { id: 'ws-2', name: 'Beta' },
        ],
      }),
    );
    const section = screen.getByTestId('gate-instance-workspaces');
    const list = within(section).getByTestId('gate-instance-enabling-workspaces');
    expect(list.textContent).toContain('Acme');
    expect(list.textContent).toContain('Beta');
    expect(section.textContent).toContain('另有 2 个未列出');
  });

  it('renders the transport kind and Operation table headers through the language switcher, never a raw enum or English-only header', () => {
    const http = scriptedHttp({});
    renderPanel(http, gateInstance({ transportKind: 'cli' }));
    const detail = screen.getByTestId('gate-instance-detail');
    expect(detail.textContent).toContain('CLI');
    const table = screen.getByTestId('gate-instance-operations-table');
    expect(table.textContent).toContain('影响级');
    expect(table.textContent).toContain('提示');
  });
});
