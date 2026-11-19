// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../lib/http-client.js';
import { BootUnreachablePage } from './BootUnreachablePage.js';

afterEach(cleanup);

// Legacy 868: opening the console without reaching the platform is not being signed out.
describe('BootUnreachablePage (legacy 868)', () => {
  const NETWORK = new HttpError('network', '/api/auth/me failed: net::ERR_NETWORK_CHANGED');

  it('says the platform was not reached, not that you were signed out, and offers to try again', () => {
    const onRetry = vi.fn();
    const onSignIn = vi.fn();
    render(
      <BootUnreachablePage
        error={NETWORK}
        retrying={false}
        onRetry={onRetry}
        onSignIn={onSignIn}
      />,
    );
    const page = screen.getByTestId('boot-unreachable');
    expect(page.getAttribute('role')).toBe('alert');
    expect(page.textContent).toContain('连不上平台');
    expect(page.textContent).toContain('这不代表你被登出了');
    expect(screen.queryByLabelText(/密码/)).toBeNull();
    fireEvent.click(screen.getByTestId('boot-unreachable-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '去登录' }));
    expect(onSignIn).toHaveBeenCalledTimes(1);
  });

  it('while trying again, both buttons wait', () => {
    render(<BootUnreachablePage error={NETWORK} retrying onRetry={vi.fn()} onSignIn={vi.fn()} />);
    const retry = screen.getByTestId('boot-unreachable-retry');
    expect(retry.textContent).toBe('正在重试…');
    expect((retry as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '去登录' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
