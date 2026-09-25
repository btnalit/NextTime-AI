// @vitest-environment jsdom
import type { ModuleWire, PlatformSettingsWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../lib/clients.js';
import { ToastProvider } from '../ui/Toast.js';
import { PlatformModulesPage } from './PlatformModulesPage.js';

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
    <ToastProvider>
      <PlatformModulesPage http={http} />
    </ToastProvider>,
  );
}

function module(overrides: Partial<ModuleWire> = {}): ModuleWire {
  return {
    name: 'ops-assets',
    versions: [
      { version: 1, file: 'ops-assets-v1.yaml', breaking: false, notes: '' },
      { version: 2, file: 'ops-assets-v2.yaml', breaking: false, notes: 'adds foo' },
    ],
    installedWorkspaceCount: 3,
    newerAvailableCount: 1,
    ...overrides,
  };
}

function settings(overrides: Partial<PlatformSettingsWire> = {}): PlatformSettingsWire {
  return {
    siteName: 'NextTime',
    announcement: '',
    instanceInstructions: '',
    defaultWorkspaceId: 'ws-1',
    defaultEntryModel: null,
    defaultDailyCallLimit: null,
    defaultMonthlyTokenBudget: null,
    defaultPlatformRole: 'user',
    passwordMinLength: 8,
    activeRuntimeImage: null,
    defaultModules: [],
    envAdmins: [],
    version: 1,
    updatedAt: null,
    ...overrides,
  };
}

/** S8 W4-C (ui-audit PM1 "默认安装复选框行内立即写入，无标签"). */
describe('PlatformModulesPage default-modules toggle (PM1)', () => {
  it('has an accessible name that is not a raw zh+en concatenation, and toasts a confirmation with an Undo action', async () => {
    const http = scriptedHttp({
      list_modules: () => ({ items: [module()] }),
      get_platform_settings: () => settings({ defaultModules: [] }),
      set_default_modules: (params) => {
        expect(params).toEqual({ defaultModules: ['ops-assets'] });
        return settings({ defaultModules: ['ops-assets'] });
      },
    });
    renderPage(http);

    const checkbox = await screen.findByTestId('module-default-ops-assets');
    expect(checkbox.getAttribute('aria-label')).toBe('ops-assets：默认安装');
    fireEvent.click(checkbox);

    await screen.findByText('已加入默认模块：ops-assets');
    expect(screen.getByRole('button', { name: '撤销' })).toBeTruthy();
  });

  it('Undo reverts to the list captured before the toggle, not a re-derived toggle of the (by then stale) current state', async () => {
    let currentDefaults: string[] = [];
    const http = scriptedHttp({
      list_modules: () => ({ items: [module()] }),
      get_platform_settings: () => settings({ defaultModules: currentDefaults }),
      set_default_modules: (params) => {
        currentDefaults = [...(params as { defaultModules: readonly string[] }).defaultModules];
        return settings({ defaultModules: currentDefaults });
      },
    });
    renderPage(http);

    const checkbox = (await screen.findByTestId('module-default-ops-assets')) as HTMLInputElement;
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox.checked).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    await waitFor(() => expect(checkbox.checked).toBe(false));
    expect(currentDefaults).toEqual([]);

    // The undo write posted the exact pre-toggle list, not a re-toggle of whatever
    // `effectiveDefaults` happened to be when the button was clicked.
    const setCalls = http.calls.filter((call) => call.name === 'set_default_modules');
    expect(setCalls).toHaveLength(2);
    expect(setCalls[1]?.params).toEqual({ defaultModules: [] });
  });

  it('removing an already-default module shows the "removed" toast copy, not "added"', async () => {
    const http = scriptedHttp({
      list_modules: () => ({ items: [module()] }),
      get_platform_settings: () => settings({ defaultModules: ['ops-assets'] }),
      set_default_modules: (params) => {
        expect(params).toEqual({ defaultModules: [] });
        return settings({ defaultModules: [] });
      },
    });
    renderPage(http);

    const checkbox = (await screen.findByTestId('module-default-ops-assets')) as HTMLInputElement;
    await waitFor(() => expect(checkbox.checked).toBe(true));
    fireEvent.click(checkbox);

    await screen.findByText('已移出默认模块：ops-assets');
  });
});
