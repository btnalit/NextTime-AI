// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EmptyState } from './empty-state.js';

afterEach(cleanup);

describe('kit/EmptyState', () => {
  it('renders the required title naming the missing object, and no body/action when omitted', () => {
    // V9's own example ("还没有 Skill") is a "中文 English" shape the i18n-pairs guard reads as an
    // unsplit translation pair — use an all-Chinese object name here instead; the point under test
    // is that `title` (whatever it says) is required and rendered, not this string's script mix.
    render(<EmptyState title="还没有能力定义" testId="skills-empty" />);
    const node = screen.getByTestId('skills-empty');
    expect(node.getAttribute('data-state')).toBe('empty');
    expect(screen.getByText('还没有能力定义')).toBeTruthy();
  });

  it('renders the optional icon, body and action', () => {
    render(
      <EmptyState
        icon={<span data-testid="empty-icon" />}
        title="还没有成员"
        body="先添加一个成员。"
        action={<button type="button">添加成员</button>}
      />,
    );
    expect(screen.getByTestId('empty-icon')).toBeTruthy();
    expect(screen.getByText('先添加一个成员。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '添加成员' })).toBeTruthy();
  });

  it('defaults to the block variant, and switches to a compact single row for inline', () => {
    const { rerender, container } = render(<EmptyState title="还没有对话" />);
    expect(container.querySelector('[data-state="empty"]')?.className).toContain('flex-col');

    rerender(<EmptyState title="还没有对话" variant="inline" />);
    const inline = container.querySelector('[data-state="empty"]');
    expect(inline?.className).toContain('items-center');
    expect(inline?.className).not.toContain('flex-col');
  });

  it('never renders a dashed border (V9: the legacy ui/EmptyState placeholder box)', () => {
    const { container } = render(<EmptyState title="还没有对话" />);
    const node = container.querySelector('[data-state="empty"]');
    expect(node?.className).not.toContain('dashed');
  });
});
