// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityCaller } from '../../lib/clients.js';
import { CreateWorkspaceForm } from './CreateWorkspaceForm.js';

afterEach(cleanup);

const USERS = {
  items: [
    {
      id: 'u-1',
      login: 'alice',
      displayName: 'Alice',
      platformRole: 'admin',
      status: 'active',
      hasPassword: true,
      memberships: [],
    },
    {
      id: 'u-2',
      login: 'bob',
      displayName: 'Bob',
      platformRole: 'user',
      status: 'active',
      hasPassword: true,
      memberships: [],
    },
  ],
};

function renderForm(defaultOwnerUserId?: string) {
  const call = vi.fn(async (_name: string, _params?: unknown): Promise<unknown> => USERS);
  render(
    <CreateWorkspaceForm
      http={{ call } as unknown as CapabilityCaller}
      models={[]}
      defaultOwnerUserId={defaultOwnerUserId}
      onCreated={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
  return call;
}

describe('CreateWorkspaceForm', () => {
  it('defaults the first owner to the given current admin', async () => {
    renderForm('u-1');
    // The picked admin's label fills the box once the directory has named them.
    await waitFor(() =>
      expect((screen.getByTestId('create-workspace-owner') as HTMLInputElement).value).toBe(
        'alice — Alice',
      ),
    );
  });

  it('has no default owner when none is given, and the owner hint is single-language', () => {
    renderForm();
    expect((screen.getByTestId('create-workspace-owner') as HTMLSelectElement).value).toBe('');
    const hint = document.getElementById('cw-owner-hint');
    expect(hint?.textContent).toBe(
      '这个用户会成为该工作区的所有者，并在「管理 → 工作区配置」里看到它。',
    );
  });

  // S11 AA3a: 用途 is 常规 or 试验, decided here for good; 常规 is omitted on the wire.
  it('sends purpose only for a trial workspace, and the hint says it is for good and never the default', async () => {
    const call = renderForm('u-1');
    const purpose = screen.getByTestId('create-workspace-purpose') as HTMLSelectElement;
    expect([...purpose.options].map((option) => option.value)).toEqual(['standard', 'admin_trial']);
    expect(purpose.value).toBe('standard');
    expect(document.getElementById('cw-purpose-hint')?.textContent).toContain('不能再改');

    fireEvent.change(purpose, { target: { value: 'admin_trial' } });
    const hint = document.getElementById('cw-purpose-hint')?.textContent ?? '';
    expect(hint).toContain('管理员智能体唯一能操作');
    expect(hint).toContain('不能设为默认工作区');
    // Who must be a member for the agent to work there (UX review on #914, P3-3).
    expect(hint).toContain('平台管理员要是它的成员');

    fireEvent.change(screen.getByLabelText(/名称/), { target: { value: 'Lab' } });
    await waitFor(() =>
      expect((screen.getByTestId('create-workspace-owner') as HTMLInputElement).value).toBe(
        'alice — Alice',
      ),
    );
    call.mockImplementationOnce(async () => ({ id: 'ws-new' }));
    fireEvent.click(screen.getByTestId('create-workspace-submit'));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('create_workspace', {
        name: 'Lab',
        ownerUserId: 'u-1',
        purpose: 'admin_trial',
      }),
    );
  });

  it('a standard workspace leaves purpose off the wire', async () => {
    const call = renderForm('u-1');
    fireEvent.change(screen.getByLabelText(/名称/), { target: { value: 'Acme' } });
    await waitFor(() =>
      expect((screen.getByTestId('create-workspace-owner') as HTMLInputElement).value).toBe(
        'alice — Alice',
      ),
    );
    call.mockImplementationOnce(async () => ({ id: 'ws-new' }));
    fireEvent.click(screen.getByTestId('create-workspace-submit'));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('create_workspace', { name: 'Acme', ownerUserId: 'u-1' }),
    );
  });
});
