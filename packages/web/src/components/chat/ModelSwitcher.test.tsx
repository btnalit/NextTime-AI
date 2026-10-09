// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsProvider } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { HttpError } from '../../lib/http-client.js';
import { describeProviderHealth } from '../../lib/provider-status.js';
import { ToastProvider } from '../ui/Toast.js';
import { ChatModelHealthNotice, ModelSwitcher, type RunningModelHealth } from './ModelSwitcher.js';

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
  excludedSkills: [],
  excludedGatekeepers: [],
  excludedWorkerDefinitions: [],
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

  it('audit P0-2: a model whose provider fails is offered disabled with its status, and the running model’s provider status shows next to the select', async () => {
    renderSwitcher(
      http({
        get_agent_profile: () => PROFILE,
        get_agent_policy: () => policy([]),
        list_models: () => ({
          items: [
            {
              ...MODELS.items[0],
              health: { status: 'untested', testedAt: null },
            },
            {
              ...MODELS.items[1],
              health: { status: 'key_rejected', testedAt: '2026-10-09T00:00:00.000Z' },
            },
          ],
        }),
      }),
    );
    const select = (await screen.findByTestId('chat-model-select')) as HTMLSelectElement;
    await waitFor(() => expect(select.options).toHaveLength(3));
    const rejected = select.options[2] as HTMLOptionElement;
    expect(rejected.disabled).toBe(true);
    expect(rejected.textContent).toContain('密钥被拒');
    // The workspace default (openai/gpt-4o) runs; its provider was never tested.
    expect(screen.getByTestId('chat-model-health').textContent).toBe('未测试');
  });

  // #530 必修 3: the running model fails — the composer line says why and what this member can do,
  // and the header does not show the status twice for an override (#530 P2).
  it('a failing override: no second chip in the header; the composer notice says to switch away', async () => {
    let running: RunningModelHealth | null = null;
    const onRunningModel = (next: RunningModelHealth | null) => {
      running = next;
    };
    render(
      <PermissionsProvider>
        <ToastProvider>
          <ModelSwitcher
            http={http({
              get_agent_profile: () => ({
                ...PROFILE,
                model: 'anthropic/claude-sonnet',
                effective: { ...PROFILE.effective, model: 'anthropic/claude-sonnet' },
              }),
              get_agent_policy: () => policy([]),
              list_models: () => ({
                items: [
                  MODELS.items[0],
                  {
                    ...MODELS.items[1],
                    health: { status: 'key_rejected', testedAt: '2026-10-09T00:00:00.000Z' },
                  },
                ],
              }),
            })}
            turnRunning={false}
            onRunningModel={onRunningModel}
          />
        </ToastProvider>
      </PermissionsProvider>,
    );
    await waitFor(() => expect(running).not.toBeNull());
    expect(screen.queryByTestId('chat-model-health')).toBeNull();
    const { getByTestId } = render(<ChatModelHealthNotice running={running} />);
    const notice = getByTestId('chat-model-health-notice');
    expect(notice.textContent).toContain('密钥被拒');
    expect(notice.textContent).toContain('上次测试：供应商拒绝了密钥');
    expect(notice.textContent).toContain('发送会失败');
    expect(notice.textContent).toContain('换一个模型');
  });

  it('a failing workspace default: the composer notice names who can fix it; a working model shows nothing', () => {
    const { getByTestId, rerender, queryByTestId } = render(
      <ChatModelHealthNotice
        running={{
          modelId: 'deepseek/chat',
          provider: 'deepseek',
          health: describeProviderHealth('test_failed'),
          source: 'workspace_default',
        }}
      />,
    );
    expect(getByTestId('chat-model-health-notice').textContent).toContain(
      '请工作区管理员换默认模型',
    );
    rerender(
      <ChatModelHealthNotice
        running={{
          modelId: 'deepseek/chat',
          provider: 'deepseek',
          health: describeProviderHealth('ok'),
          source: 'workspace_default',
        }}
      />,
    );
    expect(queryByTestId('chat-model-health-notice')).toBeNull();
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
    await screen.findByText('切换模型失败');
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
      expect(screen.getByTestId('chat-model-line').textContent).toContain('模型：—'),
    );
    expect(screen.queryByTestId('chat-model-select')).toBeNull();
  });
});
