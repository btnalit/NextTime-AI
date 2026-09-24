// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DashboardCard, FormCard, FormCardSection } from './section.js';

afterEach(cleanup);

describe('kit/DashboardCard', () => {
  it('renders a header only when title or actions are given', () => {
    const { rerender } = render(<DashboardCard>plain body</DashboardCard>);
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();

    rerender(
      <DashboardCard title="服务健康" actions={<button type="button">查看全部</button>}>
        body
      </DashboardCard>,
    );
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('服务健康');
    expect(screen.getByRole('button', { name: '查看全部' })).toBeTruthy();
  });

  it('skips the padded body wrapper when padded={false}, for a list that sets its own edges', () => {
    render(
      <DashboardCard title="最近平台审计" padded={false}>
        <ul data-testid="dashboard-card-list">
          <li>row</li>
        </ul>
      </DashboardCard>,
    );
    const list = screen.getByTestId('dashboard-card-list');
    // No intermediate padded wrapper div between the section and the list's own root.
    expect(list.parentElement?.tagName).toBe('SECTION');
  });
});

describe('kit/FormCard + FormCardSection', () => {
  it('renders each section titled, in document order, inside the one card', () => {
    render(
      <FormCard data-testid="form-card">
        <FormCardSection title="站点">
          <p>site fields</p>
        </FormCardSection>
        <FormCardSection title="默认值" description="新建用户默认加入的工作区。">
          <p>defaults fields</p>
        </FormCardSection>
      </FormCard>,
    );
    const headings = screen.getAllByRole('heading', { level: 3 });
    expect(headings.map((h) => h.textContent)).toEqual(['站点', '默认值']);
    expect(screen.getByText('新建用户默认加入的工作区。')).toBeTruthy();
  });

  it('renders a section with no title at all when title is omitted', () => {
    render(
      <FormCard>
        <FormCardSection>
          <p>untitled</p>
        </FormCardSection>
      </FormCard>,
    );
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.getByText('untitled')).toBeTruthy();
  });
});
