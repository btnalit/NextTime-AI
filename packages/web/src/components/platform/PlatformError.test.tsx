// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpError } from '../../lib/http-client.js';
import { PlatformError } from './PlatformError.js';

afterEach(cleanup);

describe('PlatformError (C10 client half)', () => {
  it('maps self_disable to its own copy', () => {
    render(
      <PlatformError
        error={new HttpError('capability_error', 'cannot disable yourself', 'self_disable')}
        title="无法停用"
        testId="err"
      />,
    );
    const alert = screen.getByTestId('err');
    expect(alert.getAttribute('data-error-code')).toBe('self_disable');
    expect(alert.textContent).toContain('不能停用自己');
  });

  it('keeps the kernel message as a secondary line for a mapped code (a kernel predating the split still says which case it was)', () => {
    render(
      <PlatformError
        error={
          new HttpError(
            'capability_error',
            'an administrator cannot disable themselves',
            'last_admin',
          )
        }
        title="无法停用"
        testId="err"
      />,
    );
    expect(screen.getByTestId('err').textContent).toContain('最后一个活跃管理员');
    expect(screen.getByTestId('err-detail').textContent).toBe(
      'an administrator cannot disable themselves',
    );
  });

  it('omits the secondary line when the kernel message is empty or repeats the mapped copy', () => {
    render(
      <PlatformError
        error={new HttpError('capability_error', '', 'user_not_found')}
        title="t"
        testId="err"
      />,
    );
    expect(screen.queryByTestId('err-detail')).toBeNull();
  });

  it('falls back to ErrorBanner for an unmapped code', () => {
    render(
      <PlatformError
        error={new HttpError('capability_error', 'boom', 'something_else')}
        title="t"
        testId="err"
      />,
    );
    expect(screen.getByTestId('err').getAttribute('data-error-code')).toBe('something_else');
    expect(screen.queryByTestId('err-detail')).toBeNull();
  });
});
