// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { StillNeeded } from './still-needed.js';

afterEach(cleanup);

describe('kit/still-needed', () => {
  it('lists what the button still waits for', () => {
    render(<StillNeeded items={['填写登录名', '选择角色']} testId="x-missing" />);
    const line = screen.getByTestId('x-missing');
    expect(line.textContent).toBe('还差：填写登录名、选择角色');
    expect(line.hasAttribute('data-still-needed')).toBe(true);
  });

  it('shows a plain reason, after the list when both are given', () => {
    render(<StillNeeded items={['选择镜像']} reason="没有可回滚的上一个镜像" testId="x" />);
    expect(screen.getByTestId('x').textContent).toBe('还差：选择镜像；没有可回滚的上一个镜像');
  });

  it('renders nothing when nothing is missing or the action is running', () => {
    const { container, rerender } = render(<StillNeeded items={[]} />);
    expect(container.innerHTML).toBe('');
    rerender(<StillNeeded items={['填写名称']} hidden />);
    expect(container.innerHTML).toBe('');
  });
});
