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
  it('renders the models table and the structured quota / policy rows (C29) independently', async () => {
    const http = scriptedHttp({
      list_models: () => ({
        items: [{ id: 'anthropic/claude', provider: 'anthropic', model: 'claude-sonnet' }],
      }),
      list_quotas: () => ({
        items: [
          {
            key: 'task.max_depth',
            value: 2,
            isDefault: false,
            updatedBy: 'owner-1',
            updatedAt: '2026-09-01T00:00:00.000Z',
          },
          {
            key: 'task.daily_cost_budget_usd',
            value: null,
            isDefault: true,
            updatedBy: null,
            updatedAt: null,
          },
        ],
      }),
      list_policies: () => ({
        items: [
          {
            id: 'pol-1',
            actionKindTag: 'docker.restart_container',
            blastRadius: 'high',
            autoApprove: false,
            requesterCanApprove: false,
            setBy: 'owner-1',
            createdAt: '2026-09-01T00:00:00.000Z',
            updatedAt: '2026-09-02T00:00:00.000Z',
          },
        ],
      }),
    });
    renderPage(http);

    const modelsTable = await screen.findByTestId('models-table');
    expect(modelsTable.textContent).toContain('claude-sonnet');

    const quotasTable = await screen.findByTestId('quotas-table');
    const depth = within(quotasTable).getByTestId('quota-row-task.max_depth');
    expect(within(depth).getByTestId('quota-value').textContent).toBe('2');
    expect(within(depth).getByTestId('quota-source').textContent).toContain('override');
    const cost = within(quotasTable).getByTestId('quota-row-task.daily_cost_budget_usd');
    expect(within(cost).getByTestId('quota-value').textContent).toContain('unlimited');
    expect(within(cost).getByTestId('quota-source').textContent).toContain('default');

    const policies = await screen.findByTestId('policies-table');
    const row = within(policies).getByTestId('policy-row-pol-1');
    expect(within(row).getByTestId('policy-action-kind').textContent).toBe(
      'docker.restart_container',
    );
    expect(within(row).getByTestId('policy-auto-approve').textContent).toContain(
      'requires approval',
    );
    expect(row.textContent).toContain('高影响');
  });

  it('each section degrades to its own error banner independently on 404 not_found (B6: no "not live yet" branch)', async () => {
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
    await screen.findByTestId('quotas-error');
    await screen.findByTestId('policies-empty');
    await screen.findByTestId('agent-policy-error');
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
    fireEvent.click(within(form).getByRole('button', { name: /保存策略/ }));
    await waitFor(() => expect(http.calls.some((c) => c.name === 'set_agent_policy')).toBe(true));
  });

  it('C11: un-ticking the current default model moves the default to the first remaining allowed model, on screen and on submit', async () => {
    const http = scriptedHttp({
      list_models: () => ({
        items: [
          { id: 'anthropic/claude', provider: 'anthropic', model: 'claude' },
          { id: 'openai/gpt', provider: 'openai', model: 'gpt' },
        ],
      }),
      list_quotas: () => ({ items: [] }),
      list_policies: () => ({ items: [] }),
      get_workspace: () => workspace('owner'),
      get_agent_policy: () => agentPolicy({ allowedModels: ['anthropic/claude', 'openai/gpt'] }),
      set_agent_policy: (params) => {
        expect(params).toMatchObject({ allowedModels: ['openai/gpt'], defaultModel: 'openai/gpt' });
        return agentPolicy({ allowedModels: ['openai/gpt'], defaultModel: 'openai/gpt' });
      },
    });
    renderPage(http);
    const form = await screen.findByTestId('agent-policy-form');
    const select = within(form).getByLabelText(/默认模型/) as HTMLSelectElement;
    expect(select.value).toBe('anthropic/claude');

    const checklist = within(form).getByTestId('agent-policy-allowed-models');
    fireEvent.click(within(checklist).getByLabelText('anthropic/claude'));
    expect(select.value).toBe('openai/gpt');

    fireEvent.click(within(form).getByRole('button', { name: /保存策略/ }));
    await waitFor(() => expect(http.calls.some((c) => c.name === 'set_agent_policy')).toBe(true));
  });
});
