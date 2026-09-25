// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Notice } from './notice.js';

afterEach(cleanup);

describe('kit/Notice', () => {
  it('renders info tone (default) with no notice-warn class', () => {
    render(<Notice testId="n">好的</Notice>);
    const el = screen.getByTestId('n');
    expect(el.className).toBe('notice');
    expect(el.textContent).toContain('好的');
  });

  it('renders warn tone with the notice-warn class', () => {
    render(
      <Notice tone="warn" testId="n">
        小心
      </Notice>,
    );
    const el = screen.getByTestId('n');
    expect(el.className).toBe('notice notice-warn');
  });

  it('renders an optional leading icon when given, and nothing extra when omitted', () => {
    const { container: withIcon } = render(
      <Notice icon={<svg data-testid="notice-icon" />}>带图标</Notice>,
    );
    expect(withIcon.querySelector('[data-testid="notice-icon"]')).toBeTruthy();

    const { container: withoutIcon } = render(<Notice>无图标</Notice>);
    expect(withoutIcon.querySelector('svg')).toBeNull();
  });

  it('children render inside a .grow wrapper so text content is always reachable', () => {
    render(<Notice testId="n">纯文本内容</Notice>);
    expect(screen.getByTestId('n').querySelector('.grow')?.textContent).toBe('纯文本内容');
  });
});
