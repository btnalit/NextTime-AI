// @vitest-environment jsdom
import { cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RefChip, defaultRefName, useRefNames } from './RefChip.js';

afterEach(cleanup);

describe('RefChip', () => {
  it('renders name + type label + truncated id + copy, linking the name when href is given', () => {
    const { container } = render(
      <RefChip
        kind="principal"
        id="0f2c6e1a-9b3d-4c5e-8f7a-1234567890ab"
        name="Ada Lovelace"
        href="#/govern/members"
        testId="ref"
      />,
    );
    const chip = screen.getByTestId('ref');
    expect(chip.classList.contains('ref-chip-principal')).toBe(true);
    expect(chip.classList.contains('ref-chip-bare')).toBe(false);
    expect(chip.getAttribute('data-ref-id')).toBe('0f2c6e1a-9b3d-4c5e-8f7a-1234567890ab');
    expect(screen.getByRole('link', { name: 'Ada Lovelace' }).getAttribute('href')).toBe(
      '#/govern/members',
    );
    expect(container.querySelector('.ref-chip-kind')?.textContent).toBe('主体');
    // CopyId: the 8-character short form and a copy button naming the kind.
    expect(container.querySelector('.copy-id-text')?.textContent).toBe('0f2c6e1a');
    expect(screen.getByRole('button', { name: 'Copy Principal id' })).toBeTruthy();
  });

  it('falls back to the grey bare id when the name is unknown', () => {
    const { container } = render(<RefChip kind="gatekeeper" id="gk-1" testId="ref" />);
    const chip = screen.getByTestId('ref');
    expect(chip.classList.contains('ref-chip-bare')).toBe(true);
    expect(container.querySelector('.ref-chip-name')).toBeNull();
    expect(chip.textContent).toContain('门');
    expect(chip.textContent).toContain('gk-1');
    expect(chip.getAttribute('title')).toBe('Gatekeeper gk-1');
  });

  it('covers all five kinds with a label', () => {
    for (const kind of [
      'principal',
      'gatekeeper',
      'workerDefinition',
      'object',
      'actionRequest',
    ] as const) {
      const { container, unmount } = render(<RefChip kind={kind} id="x" name="n" />);
      expect(container.querySelector('.ref-chip-kind')?.textContent?.length).toBeGreaterThan(0);
      unmount();
    }
  });
});

describe('useRefNames', () => {
  it('maps ids to names from a list envelope or a plain array, across the three row shapes', () => {
    const principals = {
      items: [
        { id: 'p1', displayName: 'Ada' },
        { id: 'p2', displayName: '' },
      ],
    };
    const { result } = renderHook(() => useRefNames(principals));
    expect(result.current.get('p1')).toBe('Ada');
    expect(result.current.has('p2')).toBe(false);

    const gatekeepers = [{ id: 'g1', name: 'ragflow' }];
    expect(renderHook(() => useRefNames(gatekeepers)).result.current.get('g1')).toBe('ragflow');

    const definitions = [{ id: 'w1', version: 2, definition: { name: 'triage-worker' } }];
    expect(renderHook(() => useRefNames(definitions)).result.current.get('w1')).toBe(
      'triage-worker',
    );
    expect(renderHook(() => useRefNames(undefined)).result.current.size).toBe(0);
  });

  it('honours a custom picker', () => {
    const rows = [{ id: 'a', login: 'ada' }];
    const { result } = renderHook(() => useRefNames(rows, (row) => row.login));
    expect(result.current.get('a')).toBe('ada');
    expect(defaultRefName(rows[0])).toBeUndefined();
  });
});
