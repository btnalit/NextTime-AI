// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../hooks/usePermissions.js';
import type { AgentPolicy } from '../lib/agent-profile.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { HttpError } from '../lib/http-client.js';
import { ModelsPage } from './ModelsPage.js';

afterEach(cleanup);

function workspace(role: string) {
  return {
    id: 'ws-1',
    name: 'Acme',
    createdAt: '2026-01-01T00:00:00Z',
    principalCount: 2,
    gatekeeperCount: 1,
    caller: { id: 'p-1', role, displayName: 'Alice', kind: 'human' },
  };
}

function agentPolicy(overrides: Partial<AgentPolicy> = {}): AgentPolicy {
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
    get_workspace: () => workspace('member'),
    list_skills: () => ({ items: [] }),
    list_gatekeepers: () => ({ items: [] }),
    get_agent_policy: () => agentPolicy(),
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
      <ModelsPage http={http} />
    </PermissionsProvider>,
  );
}

describe('ModelsPage', () => {
  it('renders the models table, quotas table, and policy dumps independently', async () => {
    const http = scriptedHttp({
      list_models: () => ({
        items: [{ id: 'anthropic/claude', provider: 'anthropic', model: 'claude-sonnet' }],
      }),
      list_quotas: () => ({ items: [{ key: 'invoke_worker.max_depth', value: 5 }] }),
      list_policies: () => ({
        items: [{ decision: 'require_approval', actionKindTag: 'docker.*' }],
      }),
    });
    renderPage(http);

    const modelsTable = await screen.findByTestId('models-table');
    expect(modelsTable.textContent).toContain('claude-sonnet');

    const quotasTable = await screen.findByTestId('quotas-table');
    expect(quotasTable.textContent).toContain('invoke_worker.max_depth');
    expect(quotasTable.textContent).toContain('5');

    const policies = await screen.findByTestId('policies-list');
    expect(policies.textContent).toContain('require_approval');
  });

  it('each section degrades to "该能力尚未上线" independently on 404 not_found', async () => {
    const http = scriptedHttp({
      list_models: () => ({ items: [] }),
      list_quotas: () =>
        Promise.reject(new HttpError('capability_error', 'no handler', 'not_found')),
      list_policies: () => ({ items: [] }),
      get_agent_policy: () =>
        Promise.reject(new HttpError('capability_error', 'no handler', 'not_found')),
    });
    renderPage(http);
    await screen.findByTestId('models-empty');
    await screen.findByTestId('quotas-unavailable');
    await screen.findByTestId('policies-empty');
    await screen.findByTestId('agent-policy-unavailable');
  });

  it('shows a role explanation on 403 for the owner-only quotas/policies sections', async () => {
    const http = scriptedHttp({
      list_models: () => ({ items: [] }),
      list_quotas: () => Promise.reject(new HttpError('capability_error', 'nope', 'forbidden')),
      list_policies: () => Promise.reject(new HttpError('capability_error', 'nope', 'forbidden')),
    });
    renderPage(http);
    await screen.findByTestId('quotas-forbidden');
    await screen.findByTestId('policies-forbidden');
  });

  it('a member sees a read-only AgentPolicy summary, not the editable form', async () => {
    const http = scriptedHttp({
      list_models: () => ({ items: [] }),
      list_quotas: () => ({ items: [] }),
      list_policies: () => ({ items: [] }),
      get_workspace: () => workspace('member'),
    });
    renderPage(http);
    await screen.findByTestId('agent-policy-readonly');
    expect(screen.queryByTestId('agent-policy-form')).toBeNull();
  });

  it('an owner sees the editable AgentPolicy form and can save it', async () => {
    const http = scriptedHttp({
      list_models: () => ({
        items: [{ id: 'anthropic/claude', provider: 'anthropic', model: 'claude' }],
      }),
      list_quotas: () => ({ items: [] }),
      list_policies: () => ({ items: [] }),
      get_workspace: () => workspace('owner'),
      set_agent_policy: (params) => {
        expect(params).toEqual({
          allowedModels: [],
          defaultModel: 'anthropic/claude',
          memberCanEditProfile: true,
          maxPromptAddendumChars: 500,
          allowedSkills: [],
          allowedGatekeepers: [],
          allowMemberAutoApproveLow: true,
        });
        return agentPolicy();
      },
    });
    renderPage(http);
    const form = await screen.findByTestId('agent-policy-form');
    fireEvent.click(within(form).getByRole('button', { name: /保存策略 Save policy/ }));
    await waitFor(() => expect(http.calls.some((c) => c.name === 'set_agent_policy')).toBe(true));
  });
});
