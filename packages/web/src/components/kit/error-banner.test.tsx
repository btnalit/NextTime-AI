// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../lib/http-client.js';
import { ErrorBanner } from './error-banner.js';

afterEach(cleanup);

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
});
