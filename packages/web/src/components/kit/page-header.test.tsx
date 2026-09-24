// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PageHeader } from './page-header.js';

afterEach(cleanup);

describe('kit/PageHeader', () => {
  it('renders the title as a single h1, the description, and no breadcrumb nav when none is given', () => {
    render(<PageHeader title="对话" description="Your conversations." />);
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.textContent).toBe('对话');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByText('Your conversations.')).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull();
  });

  it('renders no breadcrumb nav for an empty breadcrumb array', () => {
    render(<PageHeader title="对话" breadcrumb={[]} />);
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull();
  });

  it('renders the breadcrumb trail with the last crumb aria-current, earlier crumbs as links when they have an href, and group names as plain text when they do not', () => {
    render(
      <PageHeader title="成员与授权" breadcrumb={[{ label: '治理' }, { label: '成员与授权' }]} />,
    );
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(screen.queryByRole('link', { name: '治理' })).toBeNull();
    const current = nav.querySelector('[aria-current="page"]');
    expect(current?.textContent).toBe('成员与授权');
  });

  it('renders a linked breadcrumb crumb when it has an href', () => {
    render(
      <PageHeader
        title="任务"
        breadcrumb={[{ label: '使用', href: '#/work/chats' }, { label: '任务' }]}
      />,
    );
    const link = screen.getByRole('link', { name: '使用' });
    expect(link.getAttribute('href')).toBe('#/work/chats');
  });

  it('renders primaryAction before actions, and neither wrapper when both are omitted', () => {
    const { rerender } = render(
      <PageHeader
        title="访问"
        primaryAction={<button type="button">主操作</button>}
        actions={<button type="button">次操作</button>}
      />,
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['主操作', '次操作']);

    rerender(<PageHeader title="访问" />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('keeps the title column from collapsing: it carries an explicit min-width utility class', () => {
    render(<PageHeader title="系统接入" />);
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.parentElement?.className).toContain('min-w-56');
  });
});
