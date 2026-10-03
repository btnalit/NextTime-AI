// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../hooks/usePermissions.js';
import type { AgentPolicy, AgentProfile } from '../lib/agent-profile.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { HttpError } from '../lib/http-client.js';
import { AgentProfilePage } from './AgentProfilePage.js';

afterEach(cleanup);

const WORKSPACE = {
  id: 'ws-1',
  name: 'Acme',
  createdAt: '2026-01-01T00:00:00Z',
  principalCount: 2,
  gatekeeperCount: 1,
  caller: { id: 'p-1', role: 'member', displayName: 'Bob', kind: 'human' },
};

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    principalId: 'p-1',
    model: null,
    excludedSkills: [],
    excludedGatekeepers: [],
    excludedWorkerDefinitions: [],
    promptAddendum: null,
    autoApproveLow: null,
    updatedAt: '2026-09-01T00:00:00Z',
    updatedBy: 'p-1',
    availableGatekeepers: [],
    effective: {
      model: 'anthropic/claude',
      enabledSkills: [],
      enabledGatekeepers: [],
      enabledWorkerDefinitions: [],
      promptAddendum: '',
      autoApproveLow: false,
    },
    ...overrides,
  };
}

function policy(overrides: Partial<AgentPolicy> = {}): AgentPolicy {
  return {
    workspaceId: 'ws-1',
    allowedModels: [],
    defaultModel: 'anthropic/claude',
    memberCanEditProfile: true,
    maxPromptAddendumChars: 500,
    allowedSkills: [],
    allowedGatekeepers: [],
    allowMemberAutoApproveLow: true,
    updatedAt: '2026-09-01T00:00:00Z',
    updatedBy: 'owner-1',
    ...overrides,
  };
}

function scriptedHttp(
  handlers: Record<string, (params: unknown) => unknown | Promise<unknown>>,
): CapabilityCaller & { readonly calls: { readonly name: string; readonly params: unknown }[] } {
  const calls: { name: string; params: unknown }[] = [];
  const base: Record<string, (params: unknown) => unknown> = {
    get_workspace: () => WORKSPACE,
    list_models: () => ({
      items: [{ id: 'anthropic/claude', provider: 'anthropic', model: 'claude' }],
    }),
    list_skills: () => ({ items: [] }),
    list_gatekeepers: () => ({ items: [] }),
    list_worker_definitions: () => ({ items: [] }),
    list_principals: () => ({ items: [] }),
    get_agent_policy: () => policy(),
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
      <AgentProfilePage http={http} />
    </PermissionsProvider>,
  );
}

describe('AgentProfilePage', () => {
  it('B3: the effective panel renders gatekeeper / worker-definition ids as named RefChips from the lists it already loads', async () => {
    const http = scriptedHttp({
      get_agent_profile: () =>
        profile({
          availableGatekeepers: [{ gatekeeperId: 'gk-1', granted: true, inUse: true }],
          effective: {
            model: 'anthropic/claude',
            enabledSkills: [],
            enabledGatekeepers: ['gk-1'],
            enabledWorkerDefinitions: ['wd-1'],
            promptAddendum: '',
            autoApproveLow: false,
          },
        }),
      list_gatekeepers: () => ({
        items: [{ id: 'gk-1', name: 'docker-prod', kind: 'http', status: 'active' }],
      }),
      list_worker_definitions: () => ({
        items: [
          {
            id: 'wd-1',
            version: 1,
            kind: 'worker',
            status: 'published',
            definition: { name: 'Fixer' },
          },
        ],
      }),
    });
    renderPage(http);
    const effective = await screen.findByTestId('agent-profile-effective');
    const gate = effective.querySelector('[data-ref-kind="gatekeeper"]');
    expect(gate?.getAttribute('data-ref-id')).toBe('gk-1');
    await waitFor(() => expect(gate?.textContent).toContain('docker-prod'));
    await waitFor(() =>
      expect(effective.querySelector('[data-ref-kind="workerDefinition"]')?.textContent).toContain(
        'Fixer',
      ),
    );
  });

  it('renders the effective panel and a form pre-filled from the profile', async () => {
    const http = scriptedHttp({
      get_agent_profile: () => profile({ model: 'anthropic/claude' }),
    });
    renderPage(http);

    const effective = await screen.findByTestId('agent-profile-effective');
    expect(within(effective).getByText('anthropic/claude')).toBeTruthy();

    const form = await screen.findByTestId('agent-profile-form');
    expect(within(form).getByRole('combobox', { name: /模型/ })).toHaveProperty(
      'value',
      'anthropic/claude',
    );
  });

  it('bugfix (PR #324 review): 模型 row says "继承工作区默认 · <model>" when the profile has no override', async () => {
    const http = scriptedHttp({
      get_agent_profile: () =>
        profile({
          model: null,
          effective: {
            model: 'anthropic/claude',
            enabledSkills: [],
            enabledGatekeepers: [],
            enabledWorkerDefinitions: [],
            promptAddendum: '',
            autoApproveLow: false,
          },
        }),
    });
    renderPage(http);
    const effective = await screen.findByTestId('agent-profile-effective');
    expect(within(effective).getByText(/继承工作区默认/)).toBeTruthy();
    expect(within(effective).getByText(/anthropic\/claude/)).toBeTruthy();
  });

  it('bugfix (PR #324 review): 模型 row never renders blank, even when the workspace has no resolved default model', async () => {
    const http = scriptedHttp({
      get_agent_profile: () =>
        profile({
          model: null,
          effective: {
            model: '',
            enabledSkills: [],
            enabledGatekeepers: [],
            enabledWorkerDefinitions: [],
            promptAddendum: '',
            autoApproveLow: false,
          },
        }),
    });
    renderPage(http);
    const effective = await screen.findByTestId('agent-profile-effective');
    expect(
      within(effective)
        .getByText(/继承工作区默认/)
        .textContent?.trim(),
    ).not.toBe('');
  });

  it('renders a get_agent_profile not_found as an ordinary error banner (B6: the "not live yet" branch is gone)', async () => {
    const http = scriptedHttp({
      get_agent_profile: () =>
        Promise.reject(new HttpError('capability_error', 'no handler', 'not_found')),
    });
    renderPage(http);
    await screen.findByTestId('agent-profile-error');
  });

  it('save sends the full state: null for inherited scalars, [] for "exclude nothing" — and leaves an untouched autoApproveLow out (R-21: inherit never becomes explicit)', async () => {
    const http = scriptedHttp({
      get_agent_profile: () => profile(),
      set_agent_profile: () => profile(),
    });
    renderPage(http);
    const form = await screen.findByTestId('agent-profile-form');
    fireEvent.click(within(form).getByRole('button', { name: /保存/ }));
    await waitFor(() => expect(http.calls.some((c) => c.name === 'set_agent_profile')).toBe(true));
    expect(http.calls.find((c) => c.name === 'set_agent_profile')?.params).toEqual({
      principalId: 'p-1',
      model: null,
      excludedSkills: [],
      excludedGatekeepers: [],
      excludedWorkerDefinitions: [],
      promptAddendum: null,
    });
  });

  it('R-21 / D-16: unticking auto-approve sends false; ticking a stored false sends null (follow the workspace), never true', async () => {
    const savedParams = () =>
      http.calls.filter((c) => c.name === 'set_agent_profile').map((c) => c.params);
    let current = profile({
      effective: { ...profile().effective, autoApproveLow: true },
    });
    const http = scriptedHttp({
      get_agent_profile: () => current,
      set_agent_profile: (params) => {
        const next = (params as { autoApproveLow?: boolean | null }).autoApproveLow;
        current = profile({
          autoApproveLow: next ?? null,
          effective: { ...profile().effective, autoApproveLow: next !== false },
        });
        return current;
      },
    });
    renderPage(http);
    const form = await screen.findByTestId('agent-profile-form');
    const checkbox = within(screen.getByTestId('agent-profile-auto-approve-low')).getByRole(
      'checkbox',
    ) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(false);

    fireEvent.click(checkbox);
    fireEvent.click(within(form).getByRole('button', { name: /保存/ }));
    await waitFor(() => expect(savedParams()).toHaveLength(1));
    expect(savedParams()[0]).toMatchObject({ autoApproveLow: false });

    fireEvent.click(checkbox);
    fireEvent.click(within(form).getByRole('button', { name: /保存/ }));
    await waitFor(() => expect(savedParams()).toHaveLength(2));
    expect(savedParams()[1]).toMatchObject({ autoApproveLow: null });
  });

  it('R-21 / D-16: a policy that forbids it shows the enforced off value, disabled, and a save never sends it — no lock-out on a stored true', async () => {
    const http = scriptedHttp({
      get_agent_policy: () => policy({ allowMemberAutoApproveLow: false }),
      get_agent_profile: () => profile({ autoApproveLow: true }),
      set_agent_profile: () => profile({ autoApproveLow: true }),
    });
    renderPage(http);
    const form = await screen.findByTestId('agent-profile-form');
    const option = await screen.findByTestId('agent-profile-auto-approve-low');
    await waitFor(() => expect(option.textContent).toContain('强制'));
    const checkbox = within(option).getByRole('checkbox') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(true);
    fireEvent.click(within(form).getByRole('button', { name: /保存/ }));
    await waitFor(() => expect(http.calls.some((c) => c.name === 'set_agent_profile')).toBe(true));
    expect(http.calls.find((c) => c.name === 'set_agent_profile')?.params).not.toHaveProperty(
      'autoApproveLow',
    );
  });

  it('console redesign D1: granted systems are listed ticked; unticking one saves it as an exclusion', async () => {
    const http = scriptedHttp({
      get_agent_profile: () =>
        profile({
          availableGatekeepers: [
            { gatekeeperId: 'gk-docker', granted: true, inUse: true },
            { gatekeeperId: 'gk-ragflow', granted: true, inUse: true },
          ],
          effective: {
            model: 'anthropic/claude',
            enabledSkills: [],
            enabledGatekeepers: ['gk-docker', 'gk-ragflow'],
            enabledWorkerDefinitions: [],
            promptAddendum: '',
            autoApproveLow: false,
          },
        }),
      list_gatekeepers: () => ({
        items: [
          { id: 'gk-docker', name: 'docker', kind: 'http', status: 'active' },
          { id: 'gk-ragflow', name: 'ragflow', kind: 'http', status: 'active' },
          { id: 'gk-not-granted', name: 'not-granted', kind: 'http', status: 'active' },
        ],
      }),
      set_agent_profile: (params) => {
        expect((params as { excludedGatekeepers: string[] }).excludedGatekeepers).toEqual([
          'gk-docker',
        ]);
        return profile();
      },
    });
    renderPage(http);
    const gates = await screen.findByTestId('agent-profile-gatekeepers');
    const ragflow = await within(gates).findByRole('checkbox', { name: /^ragflow/ });
    const docker = within(gates).getByRole('checkbox', { name: /^docker/ });
    expect(ragflow).toHaveProperty('checked', true);
    expect(docker).toHaveProperty('checked', true);
    // Only what the kernel offers (`availableGatekeepers`) is listed — a workspace system that is
    // neither granted nor readable (e.g. every Operation platform-disabled) is not.
    expect(within(gates).queryByRole('checkbox', { name: /^not-granted/ })).toBeNull();

    fireEvent.click(docker);
    const form = screen.getByTestId('agent-profile-form');
    fireEvent.click(within(form).getByRole('button', { name: /保存/ }));
    await waitFor(() => expect(http.calls.some((c) => c.name === 'set_agent_profile')).toBe(true));
  });

  it('leftover 98: a system readable without a Grant is listed as 只读（未授权）, a granted one as 读写（已授权）; unticking the ungranted one excludes it', async () => {
    const http = scriptedHttp({
      get_agent_profile: () =>
        profile({
          availableGatekeepers: [
            { gatekeeperId: 'gk-docker', granted: true, inUse: true },
            { gatekeeperId: 'gk-ragflow', granted: false, inUse: true },
          ],
          effective: {
            model: 'anthropic/claude',
            enabledSkills: [],
            enabledGatekeepers: ['gk-docker'],
            enabledWorkerDefinitions: [],
            promptAddendum: '',
            autoApproveLow: false,
          },
        }),
      list_gatekeepers: () => ({
        items: [
          { id: 'gk-docker', name: 'docker', kind: 'http', status: 'active' },
          { id: 'gk-ragflow', name: 'ragflow', kind: 'http', status: 'active' },
        ],
      }),
      set_agent_profile: () => profile(),
    });
    renderPage(http);
    const gates = await screen.findByTestId('agent-profile-gatekeepers');
    const ragflow = await within(gates).findByRole('checkbox', { name: /^ragflow/ });
    const docker = within(gates).getByRole('checkbox', { name: /^docker/ });
    expect(ragflow.closest('label')?.textContent).toContain('只读（未授权）');
    expect(docker.closest('label')?.textContent).toContain('读写（已授权）');
    expect(ragflow).toHaveProperty('checked', true);

    // The effective panel lists both systems in use, the ungranted one tagged 只读.
    const effective = screen.getByTestId('agent-profile-effective');
    const chips = effective.querySelectorAll('[data-ref-kind="gatekeeper"]');
    expect([...chips].map((chip) => chip.getAttribute('data-ref-id'))).toEqual([
      'gk-docker',
      'gk-ragflow',
    ]);
    expect(within(effective).getAllByText('只读')).toHaveLength(1);

    fireEvent.click(ragflow);
    const form = screen.getByTestId('agent-profile-form');
    fireEvent.click(within(form).getByRole('button', { name: /保存/ }));
    await waitFor(() => expect(http.calls.some((c) => c.name === 'set_agent_profile')).toBe(true));
    const saved = http.calls.find((c) => c.name === 'set_agent_profile')?.params as {
      excludedGatekeepers: string[];
    };
    expect(saved.excludedGatekeepers).toEqual(['gk-ragflow']);
  });

  it('with no system granted, the systems field says who has to grant one instead of an empty checklist', async () => {
    const http = scriptedHttp({ get_agent_profile: () => profile() });
    renderPage(http);
    const empty = await screen.findByTestId('agent-profile-gatekeepers-empty');
    expect(empty.textContent).toContain('所有者授权');
  });

  it('a 400 invalid_params on save shows an inline field error', async () => {
    const http = scriptedHttp({
      get_agent_profile: () => profile(),
      set_agent_profile: () =>
        Promise.reject(
          new HttpError('capability_error', 'model not in allow-list', 'invalid_params'),
        ),
    });
    renderPage(http);
    const form = await screen.findByTestId('agent-profile-form');
    fireEvent.click(within(form).getByRole('button', { name: /保存/ }));
    await waitFor(() => expect(screen.getByText('model not in allow-list')).toBeTruthy());
  });

  it('narrows the model select to policy.allowedModels when non-empty', async () => {
    const http = scriptedHttp({
      list_models: () => ({
        items: [
          { id: 'anthropic/claude', provider: 'anthropic', model: 'claude' },
          { id: 'openai/gpt', provider: 'openai', model: 'gpt' },
        ],
      }),
      get_agent_policy: () => policy({ allowedModels: ['anthropic/claude'] }),
      get_agent_profile: () => profile(),
    });
    renderPage(http);
    const form = await screen.findByTestId('agent-profile-form');
    const select = within(form).getByRole('combobox', { name: /模型/ }) as HTMLSelectElement;
    await waitFor(() => {
      const values = Array.from(select.options).map((o) => o.value);
      expect(values).toContain('anthropic/claude');
      expect(values).not.toContain('openai/gpt');
    });
  });

  it('disables the form when workspace policy forbids members from editing their own profile', async () => {
    const http = scriptedHttp({
      get_agent_policy: () => policy({ memberCanEditProfile: false }),
      get_agent_profile: () => profile(),
    });
    renderPage(http);
    await screen.findByTestId('agent-profile-edit-forbidden');
    const form = await screen.findByTestId('agent-profile-form');
    const saveButton = within(form).getByRole('button', {
      name: /保存/,
    }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
  });

  it('an owner sees a principal picker and can switch to another principal’s profile', async () => {
    const http = scriptedHttp({
      list_principals: () => ({
        items: [
          {
            id: 'p-1',
            kind: 'human',
            role: 'owner',
            displayName: 'Alice',
            createdAt: '',
            hasApiKey: true,
          },
          {
            id: 'p-2',
            kind: 'human',
            role: 'member',
            displayName: 'Bob',
            createdAt: '',
            hasApiKey: true,
          },
        ],
      }),
      get_agent_profile: (params) => {
        const principalId = (params as { principalId?: string } | undefined)?.principalId;
        return profile({ principalId: principalId ?? 'p-1' });
      },
    });
    renderPage(http);
    const select = await screen.findByLabelText(/查看\/编辑/);
    fireEvent.change(select, { target: { value: 'p-2' } });

    await waitFor(() =>
      expect(
        http.calls.some(
          (c) =>
            c.name === 'get_agent_profile' &&
            (c.params as { principalId?: string })?.principalId === 'p-2',
        ),
      ).toBe(true),
    );
  });
});
