// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Button } from './Button.js';
import { PageHeader } from './PageHeader.js';

afterEach(cleanup);

describe('PageHeader', () => {
  it('keeps the pre-S6-A0 title / description / actions API', () => {
    render(
      <PageHeader
        title="Chats"
        description="Your conversations."
        actions={<button type="button">New</button>}
      />,
    );
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Chats');
    expect(screen.getByText('Your conversations.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull();
  });

  it('renders the breadcrumb trail with the last crumb current, and the primary action first', () => {
    render(
      <PageHeader
        title="成员与授权 Members"
        breadcrumb={[{ label: '治理', href: '#/govern/members' }, { label: '成员与授权' }]}
        primaryAction={<Button variant="primary">添加成员</Button>}
        actions={<Button>刷新</Button>}
      />,
    );
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    const link = screen.getByRole('link', { name: '治理' });
    expect(link.getAttribute('href')).toBe('#/govern/members');
    expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe('成员与授权');
    const buttons = screen.getAllByRole('button');
    expect(buttons[0]?.textContent).toBe('添加成员');
    expect(buttons[0]?.className).toContain('btn-primary');
    expect(buttons[1]?.textContent).toBe('刷新');
  });
});
