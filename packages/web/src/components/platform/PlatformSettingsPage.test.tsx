// @vitest-environment jsdom
import type { PlatformSettingsWire, PlatformWorkspaceWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { PlatformSettingsPage } from './PlatformSettingsPage.js';

afterEach(cleanup);

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
      <PlatformSettingsPage http={http} />
    </PermissionsProvider>,
  );
}

function settings(overrides: Partial<PlatformSettingsWire> = {}): PlatformSettingsWire {
  return {
    siteName: 'NextTime',
    announcement: 'hello',
    instanceInstructions: '',
    defaultWorkspaceId: 'ws-1',
    defaultEntryModel: null,
    defaultDailyCallLimit: 100,
    defaultMonthlyTokenBudget: null,
    defaultPlatformRole: 'user',
    passwordMinLength: 12,
    activeRuntimeImage: null,
    defaultModules: [],
    envAdmins: ['root'],
    version: 3,
    updatedAt: '2026-09-09T00:00:00.000Z',
    ...overrides,
  };
}

function workspace(overrides: Partial<PlatformWorkspaceWire> = {}): PlatformWorkspaceWire {
  return {
    id: 'ws-1',
    name: 'Acme',
    status: 'active',
    entryModel: null,
    allowedModels: [],
    ontologyEnforcement: 'reject',
    purpose: 'standard',
    expiresAt: null,
    disabledAt: null,
    purgeable: false,
    isDefault: true,
    memberCount: 1,
    owners: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('PlatformSettingsPage', () => {
  it('seeds the form, shows the read-only environment administrators and the version footer', async () => {
    const http = scriptedHttp({
      get_platform_settings: () => settings(),
      // S8 W1-A6: the default-workspace picker loads `list_workspaces`; these tests do not
      // assert on its options.
      list_workspaces: () => ({ items: [] }),
    });
    renderPage(http);

    const form = await screen.findByTestId('platform-settings-form');
    expect((within(form).getByLabelText(/站点名/) as HTMLInputElement).value).toBe('NextTime');
    expect((within(form).getByLabelText(/公告/) as HTMLTextAreaElement).value).toBe('hello');
    // The default entry model moved to the 模型与供应商 page (S7-E E5) — this page only points
    // there, it no longer has an editable field for it.
    expect(within(form).getByTestId('platform-settings-default-model-hint').textContent).toContain(
      '模型与供应商',
    );
    expect(screen.getByTestId('platform-settings-env-admins').textContent).toContain('root');
    expect(screen.getByTestId('platform-settings-footer').textContent).toContain('版本 3');
  });

  it('warns that the instance instructions reach every agent system prompt', async () => {
    const http = scriptedHttp({
      get_platform_settings: () => settings(),
      // S8 W1-A6: the default-workspace picker loads `list_workspaces`; these tests do not
      // assert on its options.
      list_workspaces: () => ({ items: [] }),
    });
    renderPage(http);
    await screen.findByTestId('platform-settings-form');
    expect(screen.getByText(/这会附加到所有 agent 的/)).toBeTruthy();
  });

  it('saves only the changed fields and shows a success banner', async () => {
    const http = scriptedHttp({
      get_platform_settings: () => settings(),
      list_workspaces: () => ({ items: [] }),
      update_platform_settings: (params) => {
        // Partial update: nothing the reader left alone is sent.
        expect(params).toEqual({ siteName: 'NextTime Ops' });
        return settings({ siteName: 'NextTime Ops', version: 4 });
      },
    });
    renderPage(http);

    const form = await screen.findByTestId('platform-settings-form');
    fireEvent.change(within(form).getByLabelText(/站点名/), {
      target: { value: 'NextTime Ops' },
    });
    fireEvent.click(within(form).getByRole('button', { name: '保存' }));

    const saved = await screen.findByTestId('platform-settings-saved');
    expect(saved.textContent).toContain('版本 4');
    expect(http.calls.filter((call) => call.name === 'update_platform_settings')).toHaveLength(1);
    // Re-seeded from the saved row, so a second save sends nothing at all.
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByTestId('platform-settings-unchanged');
    expect(http.calls.filter((call) => call.name === 'update_platform_settings')).toHaveLength(1);
  });

  it('clears a nullable field by emptying its box', async () => {
    const http = scriptedHttp({
      get_platform_settings: () => settings(),
      list_workspaces: () => ({ items: [] }),
      update_platform_settings: (params) => {
        expect(params).toEqual({ defaultWorkspaceId: null, defaultDailyCallLimit: null });
        return settings({ defaultWorkspaceId: null, defaultDailyCallLimit: null, version: 4 });
      },
    });
    renderPage(http);

    const form = await screen.findByTestId('platform-settings-form');
    fireEvent.change(within(form).getByLabelText(/默认工作区/), {
      target: { value: '' },
    });
    fireEvent.change(within(form).getByLabelText(/默认每日调用上限/), { target: { value: '' } });
    fireEvent.click(within(form).getByRole('button', { name: '保存' }));

    await screen.findByTestId('platform-settings-saved');
  });

  it('refuses to submit an out-of-range password minimum length', async () => {
    const http = scriptedHttp({
      get_platform_settings: () => settings(),
      // S8 W1-A6: the default-workspace picker loads `list_workspaces`; these tests do not
      // assert on its options.
      list_workspaces: () => ({ items: [] }),
    });
    renderPage(http);

    const form = await screen.findByTestId('platform-settings-form');
    fireEvent.change(within(form).getByLabelText(/密码最短长度/), { target: { value: '4' } });
    expect(within(form).getByText(/必须是 8–128 的整数/)).toBeTruthy();
    expect(within(form).getByRole('button', { name: '保存' }).hasAttribute('disabled')).toBe(true);
  });

  it('maps a kernel error code to its bilingual message', async () => {
    const http = scriptedHttp({
      get_platform_settings: () => settings(),
      list_workspaces: () => ({
        items: [workspace(), workspace({ id: 'ws-off', name: 'Old', status: 'disabled' })],
      }),
      update_platform_settings: () =>
        Promise.reject(
          new HttpError('capability_error', 'that workspace is disabled', 'workspace_disabled'),
        ),
    });
    renderPage(http);

    const form = await screen.findByTestId('platform-settings-form');
    const picker = within(form).getByLabelText(/默认工作区/) as HTMLSelectElement;
    await waitFor(() => expect(picker.options.length).toBe(3));
    fireEvent.change(picker, { target: { value: 'ws-off' } });
    fireEvent.click(within(form).getByRole('button', { name: '保存' }));

    const error = await screen.findByTestId('platform-settings-save-error');
    expect(error.textContent).toContain('该工作区已停用');
    await waitFor(() => expect(screen.queryByTestId('platform-settings-saved')).toBeNull());
  });

  it('default workspace: picked by name from list_workspaces, no typed-id field, a disabled one says so', async () => {
    const http = scriptedHttp({
      get_platform_settings: () => settings(),
      list_workspaces: () => ({
        items: [
          workspace(),
          workspace({ id: 'ws-2', name: 'Beta', isDefault: false }),
          workspace({ id: 'ws-off', name: 'Old', status: 'disabled', isDefault: false }),
        ],
      }),
      update_platform_settings: (params) => {
        expect(params).toEqual({ defaultWorkspaceId: 'ws-2' });
        return settings({ defaultWorkspaceId: 'ws-2', version: 4 });
      },
    });
    renderPage(http);
    const form = await screen.findByTestId('platform-settings-form');
    const picker = within(form).getByLabelText(/默认工作区/) as HTMLSelectElement;
    await waitFor(() =>
      expect([...picker.options].map((option) => option.textContent)).toEqual([
        '无',
        'Acme',
        'Beta',
        'Old（已停用）',
      ]),
    );
    expect(picker.value).toBe('ws-1');
    expect(within(form).queryByLabelText(/工作区 id/)).toBeNull();
    fireEvent.change(picker, { target: { value: 'ws-2' } });
    fireEvent.click(within(form).getByRole('button', { name: '保存' }));
    await screen.findByTestId('platform-settings-saved');
  });

  it('a default workspace id the list does not know (purged) is shown, kept, and not re-sent', async () => {
    const http = scriptedHttp({
      get_platform_settings: () => settings({ defaultWorkspaceId: 'ws-gone' }),
      list_workspaces: () => ({ items: [workspace()] }),
      update_platform_settings: (params) => {
        expect(params).toEqual({ siteName: 'Renamed' });
        return settings({ defaultWorkspaceId: 'ws-gone', siteName: 'Renamed', version: 4 });
      },
    });
    renderPage(http);
    const form = await screen.findByTestId('platform-settings-form');
    const picker = within(form).getByLabelText(/默认工作区/) as HTMLSelectElement;
    await waitFor(() =>
      expect(picker.selectedOptions[0]?.textContent).toBe('已不存在的工作区（ws-gone）'),
    );
    expect(picker.value).toBe('ws-gone');
    fireEvent.change(within(form).getByLabelText(/站点名/), { target: { value: 'Renamed' } });
    fireEvent.click(within(form).getByRole('button', { name: '保存' }));
    await screen.findByTestId('platform-settings-saved');
  });

  it('a failed workspace list read shows an error banner whose retry reloads it', async () => {
    let attempts = 0;
    const http = scriptedHttp({
      get_platform_settings: () => settings(),
      list_workspaces: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('network down');
        return { items: [workspace()] };
      },
    });
    renderPage(http);
    const banner = await screen.findByTestId('platform-settings-workspaces-error');
    fireEvent.click(within(banner).getByRole('button', { name: /重试/ }));
    const picker = screen.getByLabelText(/默认工作区/) as HTMLSelectElement;
    await waitFor(() => expect(picker.selectedOptions[0]?.textContent).toBe('Acme'));
    expect(screen.queryByTestId('platform-settings-workspaces-error')).toBeNull();
  });

  it('the default platform role options are words, not raw enum values', async () => {
    const http = scriptedHttp({
      get_platform_settings: () => settings(),
      list_workspaces: () => ({ items: [] }),
    });
    renderPage(http);
    const form = await screen.findByTestId('platform-settings-form');
    const role = within(form).getByLabelText(/新用户默认平台角色/) as HTMLSelectElement;
    expect([...role.options].map((option) => option.textContent)).toEqual(['用户', '管理员']);
  });
});
