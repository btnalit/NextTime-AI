// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Tabs } from './tabs.js';

afterEach(cleanup);

type Filter = 'pending' | 'all';

const OPTIONS = [
  { value: 'pending' as const, label: '进行中', testId: 'tab-pending' },
  { value: 'all' as const, label: '已归档', count: 12, testId: 'tab-all' },
];

describe('kit/Tabs', () => {
  it('renders a tablist with the selected tab aria-selected and raised (surface chip)', () => {
    render(<Tabs ariaLabel="对话过滤" value="pending" options={OPTIONS} onChange={vi.fn()} />);
    expect(screen.getByRole('tablist', { name: '对话过滤' })).toBeTruthy();
    const pending = screen.getByTestId('tab-pending');
    const all = screen.getByTestId('tab-all');
    expect(pending.getAttribute('aria-selected')).toBe('true');
    expect(pending.className).toContain('bg-surface-1');
    expect(all.getAttribute('aria-selected')).toBe('false');
    expect(all.className).not.toContain('bg-surface-1');
  });

  it('shows the optional count', () => {
    render(<Tabs ariaLabel="对话过滤" value="pending" options={OPTIONS} onChange={vi.fn()} />);
    expect(screen.getByTestId('tab-all').textContent).toContain('12');
    expect(screen.getByTestId('tab-pending').textContent).not.toMatch(/\d/);
  });

  it('calls onChange on click', () => {
    const onChange = vi.fn();
    render(<Tabs ariaLabel="对话过滤" value="pending" options={OPTIONS} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('tab-all'));
    expect(onChange).toHaveBeenCalledWith('all');
  });

  it('moves selection with ArrowRight/ArrowLeft, wrapping at the ends, and follows focus', () => {
    function Controlled() {
      const [value, setValue] = useState<Filter>('pending');
      return <Tabs ariaLabel="对话过滤" value={value} options={OPTIONS} onChange={setValue} />;
    }
    render(<Controlled />);
    const pending = screen.getByTestId('tab-pending');
    pending.focus();
    fireEvent.keyDown(pending, { key: 'ArrowRight' });
    expect(screen.getByTestId('tab-all').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(screen.getByTestId('tab-all'));

    fireEvent.keyDown(screen.getByTestId('tab-all'), { key: 'ArrowRight' });
    expect(screen.getByTestId('tab-pending').getAttribute('aria-selected')).toBe('true');
  });

  it('Home/End jump to the first/last option', () => {
    function Controlled() {
      const [value, setValue] = useState<Filter>('pending');
      return <Tabs ariaLabel="对话过滤" value={value} options={OPTIONS} onChange={setValue} />;
    }
    render(<Controlled />);
    fireEvent.keyDown(screen.getByTestId('tab-pending'), { key: 'End' });
    expect(screen.getByTestId('tab-all').getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(screen.getByTestId('tab-all'), { key: 'Home' });
    expect(screen.getByTestId('tab-pending').getAttribute('aria-selected')).toBe('true');
  });
});
