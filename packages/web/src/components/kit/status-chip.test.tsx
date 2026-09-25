// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { StatusChip } from './status-chip.js';

afterEach(cleanup);

describe('kit/StatusChip', () => {
  it('renders the resolved bilingual label text (zh default) and tone class', () => {
    render(<StatusChip machine="actionRequest" status="pending_approval" />);
    const chip = screen.getByText('待审批');
    expect(chip.className).toContain('chip-warn');
    expect(chip.className).toContain('chip-live');
    expect(chip.getAttribute('data-status')).toBe('pending_approval');
    expect(chip.getAttribute('data-tone')).toBe('warn');
  });

  it('applies the s size class', () => {
    render(<StatusChip machine="operationMode" status="observe" size="s" />);
    expect(screen.getByText('观察').className).toContain('chip-s');
  });

  it('renders an unknown value dashed with the raw string, never mis-styled', () => {
    render(<StatusChip machine="task" status="teleported" />);
    const chip = screen.getByText('teleported');
    expect(chip.className).toContain('chip-unknown');
    expect(chip.getAttribute('data-tone')).toBe('neutral');
    expect(chip.getAttribute('title')).toContain('Unknown task status');
  });

  it('forwards testId as data-testid', () => {
    render(<StatusChip machine="publishable" status="published" testId="pub-chip" />);
    expect(screen.getByTestId('pub-chip').textContent).toBe('已发布');
  });
});
