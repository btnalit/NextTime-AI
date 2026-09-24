// @vitest-environment jsdom
import type { PlatformWorkspaceWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { WorkspaceDetailPanel, WorkspaceLifecycle } from './WorkspaceDetailPanel.js';

afterEach(cleanup);

const DAY_MS = 24 * 60 * 60 * 1000;

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

function workspace(overrides: Partial<PlatformWorkspaceWire> = {}): PlatformWorkspaceWire {
  return {
    id: 'ws-2',
    name: 'Beta',
    status: 'active',
    entryModel: 'openai/gpt-4o',
    allowedModels: ['openai/gpt-4o'],
    ontologyEnforcement: 'reject',
    purpose: 'standard',
    expiresAt: null,
    disabledAt: null,
    purgeable: false,
    isDefault: false,
    memberCount: 2,
    owners: [{ userId: 'u-1', login: 'alice', displayName: 'Alice', principalId: 'p-1' }],
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

const MODELS = [
  { id: 'openai/gpt-4o', provider: 'openai', model: 'gpt-4o' },
  { id: 'anthropic/claude-3', provider: 'anthropic', model: 'claude-3' },
];

function renderPanel(
  http: CapabilityCaller,
  row: PlatformWorkspaceWire,
  overrides: Partial<Parameters<typeof WorkspaceDetailPanel>[0]> = {},
) {
  const onChanged = vi.fn();
  const onDelegated = vi.fn();
  const onPurge = vi.fn();
  const utils = render(
    <WorkspaceDetailPanel
      http={http}
      workspace={row}
      models={MODELS}
      modelsReady
      onChanged={onChanged}
      onDelegated={onDelegated}
      onPurge={onPurge}
      {...overrides}
    />,
  );
  return { ...utils, onChanged, onDelegated, onPurge };
}

/** C22 (docs/console-completion-plan.md §2b): the workspace drawer body on its own — the page
 *  tests cover the list ↔ drawer round trips, these cover the panel's own controls. */
describe('WorkspaceDetailPanel', () => {
  it('renders the summary: id, status/purpose chips, lifecycle, owners, and no purge entry when not purgeable', () => {
    const http = scriptedHttp({ list_users: () => ({ items: [] }) });
    renderPanel(http, workspace());
    const detail = screen.getByTestId('workspace-detail');
    expect(within(detail).getByTestId('workspace-detail-status').textContent).toBe('活跃');
    expect(within(detail).getByTestId('workspace-detail-purpose').textContent).toBe('常规');
    expect(within(detail).getByTestId('workspace-detail-lifecycle').textContent).toBe('—');
    expect(within(detail).getByTestId('workspace-owner-chip').textContent).toBe('alice');
    expect(within(detail).queryByTestId('workspace-purge')).toBeNull();
    expect(within(detail).queryByTestId('workspace-purge-retention')).toBeNull();
    // Not a member: the hint, no config switch.
    expect(within(detail).getByTestId('workspace-no-membership')).toBeTruthy();
    expect(within(detail).queryByTestId('open-workspace-config')).toBeNull();
  });

  it('rename: the save button enables on a real change and posts update_workspace{name}', async () => {
    const row = workspace();
    const http = scriptedHttp({
      list_users: () => ({ items: [] }),
      update_workspace: (params) => {
        expect(params).toEqual({ workspaceId: 'ws-2', name: 'Gamma' });
        return { ...row, name: 'Gamma' };
      },
    });
    const { onChanged } = renderPanel(http, row);
    const save = screen.getByRole('button', { name: '保存' });
    expect(save.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText(/名称/), { target: { value: '  Beta ' } });
    expect(save.hasAttribute('disabled')).toBe(true); // same name after trim
    fireEvent.change(screen.getByLabelText(/名称/), { target: { value: 'Gamma' } });
    expect(save.hasAttribute('disabled')).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith({ ...row, name: 'Gamma' }));
  });

  it('entry model: options come from the saved allow-list, saved on change; a failure shows inline', async () => {
    const row = workspace();
    const http = scriptedHttp({
      list_users: () => ({ items: [] }),
      update_workspace: () =>
        Promise.reject(new HttpError('capability_error', 'no such model', 'unknown_model')),
    });
    renderPanel(http, row);
    const select = screen.getByTestId('workspace-entry-model') as HTMLSelectElement;
    // Only the allowed model (plus the disabled "not set" placeholder) — not the whole catalog.
    expect(Array.from(select.options).map((option) => option.value)).toEqual([
      '__default__',
      'openai/gpt-4o',
    ]);
    fireEvent.change(select, { target: { value: 'openai/gpt-4o' } });
    await waitFor(() =>
      expect(http.calls.some((call) => call.name === 'update_workspace')).toBe(true),
    );
    expect((await screen.findByText(/模型不在目录里/)).closest('[data-error-code]')).toBeTruthy();
  });

  it('allowed models: dirty tracking, then set_allowed_models with the ticked ids', async () => {
    const row = workspace();
    const http = scriptedHttp({
      list_users: () => ({ items: [] }),
      set_allowed_models: (params) => {
        expect(params).toEqual({
          workspaceId: 'ws-2',
          allowedModels: ['openai/gpt-4o', 'anthropic/claude-3'],
        });
        return { ...row, allowedModels: ['openai/gpt-4o', 'anthropic/claude-3'] };
      },
    });
    const { onChanged } = renderPanel(http, row);
    const save = screen.getByRole('button', { name: '保存允许的模型' });
    expect(save.hasAttribute('disabled')).toBe(true);
    fireEvent.click(
      within(screen.getByTestId('workspace-allowed-models')).getByLabelText('anthropic/claude-3'),
    );
    expect(save.hasAttribute('disabled')).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('both model controls stay disabled until the catalog is known', () => {
    const http = scriptedHttp({ list_users: () => ({ items: [] }) });
    renderPanel(http, workspace(), { models: [], modelsReady: false });
    expect(screen.getByTestId('workspace-entry-model').hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: '保存允许的模型' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('a disabled workspace shows 启用', () => {
    const http = scriptedHttp({ list_users: () => ({ items: [] }) });
    const recent = workspace({
      status: 'disabled',
      disabledAt: new Date(Date.now() - 1 * DAY_MS).toISOString(),
    });
    const { unmount } = renderPanel(http, recent);
    expect(screen.getByTestId('workspace-status-toggle').textContent).toContain('启用');
    expect(screen.getByTestId('workspace-disabled-at').textContent).toContain('6 天后可清除');
    expect(screen.queryByTestId('workspace-purge')).toBeNull();
    expect(screen.getByTestId('workspace-purge-retention')).toBeTruthy();
    unmount();

    const { onPurge } = renderPanel(
      http,
      workspace({ status: 'disabled', disabledAt: null, purgeable: true }),
    );
    expect(screen.getByTestId('workspace-disabled-at').textContent).toContain('禁用于迁移前');
    expect(screen.getByTestId('workspace-purge-section')).toBeTruthy();
    fireEvent.click(screen.getByTestId('workspace-purge'));
    expect(onPurge).toHaveBeenCalledTimes(1);
  });

  it('the config switch renders only when the page hands one in', () => {
    const http = scriptedHttp({ list_users: () => ({ items: [] }) });
    const onOpenWorkspaceConfig = vi.fn();
    renderPanel(http, workspace(), { onOpenWorkspaceConfig });
    fireEvent.click(screen.getByTestId('open-workspace-config'));
    expect(onOpenWorkspaceConfig).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('workspace-no-membership')).toBeNull();
  });

  it('WorkspaceLifecycle: expiry for an ephemeral workspace, expired past it', () => {
    const { unmount } = render(
      <WorkspaceLifecycle
        workspace={workspace({
          purpose: 'ephemeral',
          expiresAt: new Date(Date.now() + 2 * DAY_MS).toISOString(),
        })}
      />,
    );
    expect(screen.getByTestId('workspace-expires').textContent).toContain('到期');
    expect(screen.getByTestId('workspace-expires').hasAttribute('data-expired')).toBe(false);
    unmount();
    render(
      <WorkspaceLifecycle
        workspace={workspace({
          purpose: 'ephemeral',
          expiresAt: new Date(Date.now() - 2 * DAY_MS).toISOString(),
        })}
      />,
    );
    expect(screen.getByTestId('workspace-expires').textContent).toContain('已到期');
    expect(screen.getByTestId('workspace-expires').getAttribute('data-expired')).toBe('true');
  });
});
