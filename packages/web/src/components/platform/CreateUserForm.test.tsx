// @vitest-environment jsdom
import type { PlatformWorkspaceWire } from '@nexttime/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../lib/clients.js';
import { CreateUserForm } from './CreateUserForm.js';

afterEach(cleanup);

function workspace(overrides: Partial<PlatformWorkspaceWire> = {}): PlatformWorkspaceWire {
  return {
    id: 'ws-uuid-1',
    name: 'Acme 团队',
    status: 'active',
    entryModel: null,
    allowedModels: [],
    ontologyEnforcement: 'reject',
    purpose: 'standard',
    expiresAt: null,
    disabledAt: null,
    purgeable: false,
    isDefault: true,
    memberCount: 3,
    owners: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

type Handlers = Record<string, (params: unknown) => unknown | Promise<unknown>>;

/** Scripted answers; an unscripted capability throws loudly (the package convention). */
function scriptedHttp(
  handlers: Handlers,
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

function renderForm(handlers: Handlers = {}, defaultWorkspaceId: string | null = 'ws-uuid-1') {
  const http = scriptedHttp({
    list_workspaces: () => ({ items: [workspace()] }),
    create_user: () => ({ user: {}, temporaryPassword: 'x' }),
    ...handlers,
  });
  const onCreated = vi.fn();
  render(
    <CreateUserForm
      http={http}
      defaultWorkspaceId={defaultWorkspaceId}
      defaultPlatformRole="user"
      onCreated={onCreated}
      onCancel={vi.fn()}
    />,
  );
  return { http, onCreated };
}

function createParams(http: ReturnType<typeof scriptedHttp>): Record<string, unknown> {
  const call = http.calls.find((entry) => entry.name === 'create_user');
  return (call?.params ?? {}) as Record<string, unknown>;
}

describe('CreateUserForm', () => {
  it('accepts an upper-case login, says what will be saved, and submits it normalized', async () => {
    const { http, onCreated } = renderForm();
    const login = screen.getByLabelText(/登录名/) as HTMLInputElement;
    fireEvent.change(login, { target: { value: ' Alice ' } });
    expect(screen.getByText(/将保存为 alice/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.blur(login);
    expect(login.value).toBe('alice');
    fireEvent.change(screen.getByLabelText(/显示名/), { target: { value: 'Alice' } });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(createParams(http).login).toBe('alice');
  });

  it('keeps the rule visible and names the problem when the login is invalid', () => {
    renderForm();
    fireEvent.change(screen.getByLabelText(/登录名/), { target: { value: 'a b' } });
    expect(screen.getByText(/3–64 位，由小写字母、数字/)).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/不能包含「 」/);
    expect(screen.getByRole('button', { name: '创建' }).hasAttribute('disabled')).toBe(true);
  });

  it('shows the default workspace by name (not its id) and role options with labels', async () => {
    renderForm();
    expect(await screen.findByText('默认工作区：Acme 团队')).toBeTruthy();
    expect(screen.queryByText(/ws-uuid-1/)).toBeNull();
    const roles = screen.getByLabelText(/工作区角色/) as HTMLSelectElement;
    const texts = [...roles.options].map((option) => option.textContent);
    expect(texts).not.toContain('owner');
    expect(texts.length).toBe(5);
  });

  it('a custom password shorter than 8 says how long it is and keeps Create disabled', () => {
    renderForm();
    fireEvent.change(screen.getByLabelText(/登录名/), { target: { value: 'carol' } });
    fireEvent.change(screen.getByLabelText(/显示名/), { target: { value: 'Carol' } });
    fireEvent.change(screen.getByLabelText(/^密码/), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText(/临时密码/), { target: { value: 'abc' } });
    expect(screen.getByText(/密码太短：当前 3 位，至少需要 8 位/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '创建' }).hasAttribute('disabled')).toBe(true);
  });

  it('lists every active workspace from list_workspaces — no typed-id field — and submits the picked one', async () => {
    const { http, onCreated } = renderForm({
      list_workspaces: () => ({
        items: [
          workspace(),
          workspace({ id: 'ws-new', name: 'Fresh', isDefault: false, memberCount: 0 }),
          workspace({ id: 'ws-tmp', name: 'Trial', purpose: 'ephemeral', isDefault: false }),
        ],
      }),
    });
    const select = screen.getByLabelText(/^工作区$/) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(5));
    expect(http.calls.find((call) => call.name === 'list_workspaces')?.params).toEqual({
      status: 'active',
      includeExpired: false,
    });
    const texts = [...select.options].map((option) => option.textContent);
    // A workspace nobody belongs to yet is offered too; an ephemeral one says so.
    expect(texts).toEqual(['默认工作区', '无', 'Acme 团队', 'Fresh', 'Trial（临时）']);
    expect(texts.some((text) => text?.includes('其他'))).toBe(false);
    expect(screen.queryByLabelText(/工作区 id/)).toBeNull();

    fireEvent.change(screen.getByLabelText(/登录名/), { target: { value: 'dana' } });
    fireEvent.change(screen.getByLabelText(/显示名/), { target: { value: 'Dana' } });
    fireEvent.change(select, { target: { value: 'ws-new' } });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(createParams(http)).toMatchObject({ workspaceId: 'ws-new', role: 'member' });
  });

  it('a long workspace list gets a filter box that narrows the options by name', async () => {
    const many = Array.from({ length: 10 }, (_, index) =>
      workspace({ id: `ws-${index}`, name: index === 7 ? 'Zeta 研发' : `Team ${index}` }),
    );
    renderForm({ list_workspaces: () => ({ items: many }) });
    const filter = await screen.findByTestId('create-user-workspace-filter');
    fireEvent.change(filter, { target: { value: 'zeta' } });
    const select = screen.getByLabelText(/^工作区$/) as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      '默认工作区',
      '无',
      'Zeta 研发',
    ]);
    fireEvent.change(filter, { target: { value: 'nothing-like-this' } });
    expect(screen.getByText(/没有名称或 id 含“nothing-like-this”的工作区/)).toBeTruthy();
  });

  it('a short list has no filter box', async () => {
    renderForm();
    await screen.findByText('默认工作区：Acme 团队');
    expect(screen.queryByTestId('create-user-workspace-filter')).toBeNull();
  });

  it('says so when the platform default workspace is not among the active ones', async () => {
    renderForm({
      list_workspaces: () => ({ items: [workspace({ id: 'ws-other', name: 'Other' })] }),
    });
    expect(await screen.findByText(/平台默认工作区已停用或已过期/)).toBeTruthy();
  });

  it('a failed workspace read shows an error with retry; the default choice still works', async () => {
    let attempts = 0;
    const { http, onCreated } = renderForm({
      list_workspaces: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('network down');
        return { items: [workspace()] };
      },
    });
    const banner = await screen.findByTestId('create-user-workspace-error');
    fireEvent.click(within(banner).getByRole('button', { name: /重试/ }));
    expect(await screen.findByText('默认工作区：Acme 团队')).toBeTruthy();
    expect(screen.queryByTestId('create-user-workspace-error')).toBeNull();

    fireEvent.change(screen.getByLabelText(/登录名/), { target: { value: 'erin' } });
    fireEvent.change(screen.getByLabelText(/显示名/), { target: { value: 'Erin' } });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalled());
    // "默认工作区" omits workspaceId (= the platform default) but still sends the role.
    expect(createParams(http)).not.toHaveProperty('workspaceId');
    expect(createParams(http).role).toBe('member');
  });

  it('an empty workspace directory says there is nothing to join', async () => {
    renderForm({ list_workspaces: () => ({ items: [] }) }, null);
    expect(await screen.findByTestId('create-user-workspace-empty')).toBeTruthy();
  });
});
