// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Card } from './Card.js';

afterEach(cleanup);

describe('ui/Card', () => {
  it('legacy 436: a title beside actions is marked to keep its line', () => {
    render(
      <Card title="镜像清单" actions={<span>reason</span>}>
        body
      </Card>,
    );
    const header = screen.getByRole('heading', { name: '镜像清单' }).parentElement;
    expect(header?.classList.contains('card-header-actions')).toBe(true);
    expect(screen.getByText('reason').parentElement?.classList.contains('card-actions')).toBe(true);
  });

  it('a title alone keeps the plain header', () => {
    render(<Card title="备份">body</Card>);
    const header = screen.getByRole('heading', { name: '备份' }).parentElement;
    expect(header?.classList.contains('card-header-actions')).toBe(false);
  });
});
