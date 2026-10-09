// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
  const call = vi.fn(async () => USERS);
  render(
    <CreateWorkspaceForm
      http={{ call } as unknown as CapabilityCaller}
      models={[]}
      defaultOwnerUserId={defaultOwnerUserId}
      onCreated={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
}

describe('CreateWorkspaceForm', () => {
  it('defaults the first owner to the given current admin', async () => {
    renderForm('u-1');
    await waitFor(() =>
      expect(
        screen.getByTestId('create-workspace-owner').querySelector('option[value="u-1"]'),
      ).not.toBeNull(),
    );
    expect((screen.getByTestId('create-workspace-owner') as HTMLSelectElement).value).toBe('u-1');
  });

  it('has no default owner when none is given, and the owner hint is single-language', () => {
    renderForm();
    expect((screen.getByTestId('create-workspace-owner') as HTMLSelectElement).value).toBe('');
    const hint = document.getElementById('cw-owner-hint');
    expect(hint?.textContent).toBe(
      '这个用户会成为该工作区的 owner，并在「管理 → 工作区配置」里看到它。',
    );
  });
});
