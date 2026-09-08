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
    enabledSkills: null,
    enabledGatekeepers: null,
    enabledWorkerDefinitions: null,
    promptAddendum: null,
    autoApproveLow: null,
    updatedAt: '2026-09-01T00:00:00Z',
    updatedBy: 'p-1',
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
  it('renders the effective panel and a form pre-filled from the profile', async () => {
    const http = scriptedHttp({
      get_agent_profile: () => profile({ model: 'anthropic/claude' }),
    });
    renderPage(http);

    const effective = await screen.findByTestId('agent-profile-effective');
    expect(within(effective).getByText('anthropic/claude')).toBeTruthy();

    const form = await screen.findByTestId('agent-profile-form');
    expect(within(form).getByLabelText(/模型 Model/)).toHaveProperty('value', 'anthropic/claude');
  });

  it('shows "该能力尚未上线" for the self view when get_agent_profile 404s', async () => {
    const http = scriptedHttp({
      get_agent_profile: () =>
        Promise.reject(new HttpError('capability_error', 'no handler', 'not_found')),
    });
    renderPage(http);
    await screen.findByTestId('agent-profile-unavailable');
  });

  it('save sends the full six-field state, using null for inherited/empty fields', async () => {
    const http = scriptedHttp({
      get_agent_profile: () => profile(),
      set_agent_profile: (params) => {
        expect(params).toEqual({
          principalId: 'p-1',
          model: null,
          enabledSkills: null,
          enabledGatekeepers: null,
          enabledWorkerDefinitions: null,
          promptAddendum: null,
          autoApproveLow: false,
        });
        return profile();
      },
    });
    renderPage(http);
    const form = await screen.findByTestId('agent-profile-form');
    fireEvent.click(within(form).getByRole('button', { name: /保存 Save/ }));
    await waitFor(() => expect(http.calls.some((c) => c.name === 'set_agent_profile')).toBe(true));
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
    fireEvent.click(within(form).getByRole('button', { name: /保存 Save/ }));
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
    const select = within(form).getByLabelText(/模型 Model/) as HTMLSelectElement;
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
      name: /保存 Save/,
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
