// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { ToastProvider } from '../ui/Toast.js';
import { ModelSwitcher } from './ModelSwitcher.js';

afterEach(cleanup);

/**
 * ModelSwitcher.test.tsx (S6-A W2): the edge cases ChatPage.test.tsx's happy path leaves out —
 * an empty policy allow-list (= unrestricted, the whole catalog), the catalog read failing (the
 * policy's own ids still make the options), a refused `set_agent_profile` (403 → disabled with
 * the policy hint), and a profile read failing (mode line only, no control).
 */

const PROFILE = {
  principalId: 'p-1',
  model: null,
  enabledSkills: null,
  enabledGatekeepers: null,
  enabledWorkerDefinitions: null,
  promptAddendum: null,
  autoApproveLow: null,
  updatedAt: null,
  updatedBy: null,
  effective: {
    model: 'openai/gpt-4o',
    enabledSkills: [],
    enabledGatekeepers: [],
    enabledWorkerDefinitions: [],
    promptAddendum: '',
    autoApproveLow: false,
  },
};

function policy(allowedModels: readonly string[]) {
  return {
    workspaceId: 'ws-1',
    allowedModels,
    defaultModel: 'openai/gpt-4o',
    memberCanEditProfile: true,
    maxPromptAddendumChars: 2000,
    allowedSkills: [],
    allowedGatekeepers: [],
    allowMemberAutoApproveLow: false,
    updatedAt: null,
    updatedBy: null,
  };
}

const MODELS = {
  items: [
    { id: 'openai/gpt-4o', provider: 'openai', model: 'gpt-4o' },
    { id: 'anthropic/claude-sonnet', provider: 'anthropic', model: 'claude-sonnet' },
  ],
};

function http(handlers: Record<string, (params: unknown) => unknown>): CapabilityCaller & {
  readonly calls: { readonly name: string; readonly params: unknown }[];
} {
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

function renderSwitcher(client: CapabilityCaller, turnRunning = false) {
  return render(
    <PermissionsProvider>
      <ToastProvider>
        <ModelSwitcher http={client} turnRunning={turnRunning} />
      </ToastProvider>
    </PermissionsProvider>,
  );
}

function optionValues(): string[] {
  const select = screen.getByTestId('chat-model-select') as HTMLSelectElement;
  return Array.from(select.options).map((option) => option.value);
}

describe('ModelSwitcher', () => {
  it('an empty policy allow-list means unrestricted: every catalog model is offered', async () => {
    renderSwitcher(
      http({
        get_agent_profile: () => PROFILE,
        get_agent_policy: () => policy([]),
        list_models: () => MODELS,
      }),
    );
    await screen.findByTestId('chat-model-select');
    await waitFor(() =>
      expect(optionValues()).toEqual(['', 'openai/gpt-4o', 'anthropic/claude-sonnet']),
    );
  });

  it('falls back to the policy allow-list ids when the catalog read fails', async () => {
    renderSwitcher(
      http({
        get_agent_profile: () => PROFILE,
        get_agent_policy: () => policy(['anthropic/claude-sonnet']),
      }),
    );
    await screen.findByTestId('chat-model-select');
    await waitFor(() => expect(optionValues()).toEqual(['', 'anthropic/claude-sonnet']));
  });

  it('a refused set_agent_profile (403) disables the control with the policy hint', async () => {
    const client = http({
      get_agent_profile: () => PROFILE,
      get_agent_policy: () => policy(['openai/gpt-4o', 'anthropic/claude-sonnet']),
      list_models: () => MODELS,
      set_agent_profile: () => {
        throw new HttpError(
          'capability_error',
          'AgentPolicy.memberCanEditProfile is false for this workspace',
          'forbidden',
        );
      },
    });
    renderSwitcher(client);
    const select = (await screen.findByTestId('chat-model-select')) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'anthropic/claude-sonnet' } });
    await screen.findByText('切换模型失败 Could not switch the model');
    await waitFor(() =>
      expect((screen.getByTestId('chat-model-select') as HTMLSelectElement).disabled).toBe(true),
    );
    expect(screen.getByTestId('chat-model-select').getAttribute('title')).toContain(
      '工作区策略不允许成员修改自己的模型',
    );
    // The override never changed: the profile is what the kernel last returned.
    expect(screen.getByTestId('chat-model-source').textContent).toContain('工作区默认');
  });

  it('renders the mode line without a control when the profile read fails', async () => {
    renderSwitcher(http({}));
    await waitFor(() =>
      expect(screen.getByTestId('chat-model-line').textContent).toContain('模型 Model：—'),
    );
    expect(screen.queryByTestId('chat-model-select')).toBeNull();
  });
});
