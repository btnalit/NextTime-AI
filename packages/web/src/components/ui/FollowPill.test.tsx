// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FollowPill } from './FollowPill.js';

afterEach(cleanup);

describe('FollowPill', () => {
  it('shows the count and calls onClick', () => {
    const onClick = vi.fn();
    render(<FollowPill count={3} onClick={onClick} testId="pill" />);
    const pill = screen.getByTestId('pill');
    expect(pill.textContent).toBe('跟随最新输出 · 3 条新消息');
    expect(pill.getAttribute('aria-label')).toBe('Follow latest output — 3 new messages');
    fireEvent.click(pill);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders the bare form at zero and caps the count at 99+', () => {
    const { rerender } = render(<FollowPill count={0} onClick={vi.fn()} testId="pill" />);
    expect(screen.getByTestId('pill').textContent).toBe('跟随最新输出 Follow latest');
    rerender(<FollowPill count={250} onClick={vi.fn()} testId="pill" />);
    expect(screen.getByTestId('pill').textContent).toBe('跟随最新输出 · 99+ 条新消息');
  });
});
