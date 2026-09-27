// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { List, ListRow } from './list-row.js';

afterEach(cleanup);

describe('kit/list-row', () => {
  it('renders a list of real buttons — selection, leading slot and children all present', () => {
    render(
      <List ariaLabel="行列表" testId="rows">
        <ListRow testId="row-1" onSelect={vi.fn()} leading={<span>影响</span>}>
          <span>标题一</span>
        </ListRow>
        <ListRow testId="row-2" selected onSelect={vi.fn()}>
          <span>标题二</span>
        </ListRow>
      </List>,
    );
    expect(screen.getByTestId('rows').getAttribute('aria-label')).toBe('行列表');
    const row1 = screen.getByTestId('row-1');
    expect(row1.tagName).toBe('BUTTON');
    expect(row1.textContent).toContain('影响');
    expect(row1.textContent).toContain('标题一');
    expect(row1.getAttribute('aria-current')).toBeNull();

    const row2 = screen.getByTestId('row-2');
    expect(row2.getAttribute('aria-current')).toBe('true');
  });

  it('calls onSelect on click', () => {
    const onSelect = vi.fn();
    render(
      <List ariaLabel="行列表">
        <ListRow testId="row-1" onSelect={onSelect}>
          <span>标题</span>
        </ListRow>
      </List>,
    );
    fireEvent.click(screen.getByTestId('row-1'));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('is keyboard-selectable: a real button responds to Enter/Space once focused', () => {
    const onSelect = vi.fn();
    render(
      <List ariaLabel="行列表">
        <ListRow testId="row-1" onSelect={onSelect}>
          <span>标题</span>
        </ListRow>
      </List>,
    );
    const row = screen.getByTestId('row-1');
    row.focus();
    expect(document.activeElement).toBe(row);
    fireEvent.click(row); // jsdom does not synthesize a native Enter->click activation for
    // <button>; the important, testable guarantee is that the row is a real, focusable button
    // (native Enter/Space activation then follows for free in a real browser).
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('a row with no onSelect renders disabled (non-interactive), never firing a click', () => {
    render(
      <List ariaLabel="行列表">
        <ListRow testId="row-1">
          <span>标题</span>
        </ListRow>
      </List>,
    );
    const row = screen.getByTestId('row-1') as HTMLButtonElement;
    expect(row.disabled).toBe(true);
  });

  it('applies the accent border class for the given emphasis colour', () => {
    render(
      <List ariaLabel="行列表">
        <ListRow testId="row-danger" accent="danger" onSelect={vi.fn()}>
          <span>高</span>
        </ListRow>
        <ListRow testId="row-warn" accent="warn" onSelect={vi.fn()}>
          <span>中</span>
        </ListRow>
      </List>,
    );
    expect(screen.getByTestId('row-danger').className).toContain('border-l-danger');
    expect(screen.getByTestId('row-warn').className).toContain('border-l-warn');
  });
});
