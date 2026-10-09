// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../lib/http-client.js';
import { LangProvider } from '../../lib/i18n.js';
import { ErrorBanner } from './error-banner.js';

afterEach(() => {
  cleanup();
  localStorage.removeItem('nexttime.lang');
});

describe('kit/ErrorBanner', () => {
  it('renders role="alert" with the kernel error code and message', () => {
    const error = new HttpError('capability_error', '门未启用', 'gate_not_enabled');
    render(<ErrorBanner error={error} testId="eb" />);
    const el = screen.getByRole('alert');
    expect(el.getAttribute('data-error-code')).toBe('gate_not_enabled');
    expect(el.textContent).toContain('gate_not_enabled');
    expect(el.textContent).toContain('门未启用');
  });

  it('uses the given title instead of the code-derived one', () => {
    const error = new HttpError('capability_error', '门未启用', 'gate_not_enabled');
    render(<ErrorBanner error={error} title="无法授予" />);
    expect(screen.getByText('无法授予')).toBeTruthy();
  });

  it('renders no retry button when onRetry is omitted, and calls it via kit/button when given', () => {
    const error = new HttpError('network', 'offline');
    const { rerender } = render(<ErrorBanner error={error} />);
    expect(screen.queryByRole('button')).toBeNull();

    const onRetry = vi.fn();
    rerender(<ErrorBanner error={error} onRetry={onRetry} retryLabel="重试" />);
    const retry = screen.getByRole('button', { name: '重试' });
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('disables the retry button while retrying', () => {
    const error = new HttpError('network', 'offline');
    render(<ErrorBanner error={error} onRetry={() => undefined} retrying retryLabel="重试" />);
    const button = screen.getByRole('button', { name: '重试' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('shows the mapped friendly copy first and keeps the kernel text as a muted second line', () => {
    const error = new HttpError('capability_error', 'password too short (min 12)', 'weak_password');
    render(<ErrorBanner error={error} testId="eb" />);
    const el = screen.getByRole('alert');
    expect(el.querySelector('.error-banner-message')?.textContent).toBe(
      '密码不满足平台的最短长度要求',
    );
    expect(screen.getByTestId('eb-detail').textContent).toBe('password too short (min 12)');
    expect(el.textContent).toContain('weak_password');
  });

  it('a browser fetch failure reads as a sentence, with the raw "Failed to fetch" kept muted', () => {
    const error = new HttpError('network', 'capability call "list_users" failed: Failed to fetch');
    render(<ErrorBanner error={error} testId="eb" />);
    const el = screen.getByRole('alert');
    expect(el.querySelector('.error-banner-message')?.textContent).toContain(
      '浏览器没有收到控制台服务的响应',
    );
    expect(screen.getByTestId('eb-detail').textContent).toContain('Failed to fetch');
    expect(el.textContent).toContain('网络错误');
  });

  it('a non-JSON body says a proxy or gateway likely answered', () => {
    const error = new HttpError('invalid_response', 'returned a non-JSON response (HTTP 502)');
    render(<ErrorBanner error={error} testId="eb" />);
    expect(screen.getByRole('alert').querySelector('.error-banner-message')?.textContent).toContain(
      '代理或网关',
    );
    expect(screen.getByTestId('eb-detail').textContent).toContain('HTTP 502');
  });

  it('translates the title and the default retry label (zh default, en on switch)', () => {
    const error = new HttpError('capability_error', 'nope', 'forbidden');
    const { unmount } = render(<ErrorBanner error={error} onRetry={() => undefined} />);
    expect(screen.getByText('没有权限')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
    unmount();

    localStorage.setItem('nexttime.lang', 'en');
    render(
      <LangProvider>
        <ErrorBanner error={error} onRetry={() => undefined} />
      </LangProvider>,
    );
    expect(screen.getByText('Not permitted')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});
