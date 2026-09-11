// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WireUser } from '../lib/auth-api.js';
import { NoWorkspacePage } from './NoWorkspacePage.js';

afterEach(cleanup);

const USER: WireUser = {
  id: 'u1',
  login: 'e2e-admin',
  displayName: 'E2E Admin',
  platformRole: 'admin',
  mustChangePassword: false,
};

describe('NoWorkspacePage', () => {
  it('shows the user identity and offers My Account / Sign out', () => {
    const onOpenAccount = vi.fn();
    const onLogout = vi.fn();
    render(<NoWorkspacePage user={USER} onOpenAccount={onOpenAccount} onLogout={onLogout} />);

    expect(screen.getByText('You are not a member of any workspace yet')).toBeTruthy();
    expect(screen.getByText('E2E Admin')).toBeTruthy();
    expect(screen.getByText('e2e-admin')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /我的账户 My Account/ }));
    expect(onOpenAccount).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /登出 Sign out/ }));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });
});
