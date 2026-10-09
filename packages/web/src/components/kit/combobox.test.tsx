// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Combobox, ComboboxChips, type ComboboxOption, filterComboboxOptions } from './combobox.js';

afterEach(cleanup);

const OPTIONS: readonly ComboboxOption[] = [
  { value: 'docker.restart', label: 'docker.restart', secondary: '中影响' },
  { value: 'docker.prune', label: 'docker.prune', secondary: '高影响' },
  { value: 'host.reboot', label: 'host.reboot', secondary: '高影响' },
  { value: 'restart_all', label: 'restart_all', disabled: true },
];

function Harness({
  initial = '',
  onChange = () => undefined,
  ...rest
}: {
  readonly initial?: string;
  readonly onChange?: (value: string) => void;
  readonly allowFreeEntry?: boolean;
  readonly loading?: boolean;
  readonly options?: readonly ComboboxOption[];
  readonly maxVisible?: number;
}) {
  const [value, setValue] = useState(initial);
  return (
    <form onSubmit={(event) => event.preventDefault()}>
      <label htmlFor="cb">动作</label>
      <Combobox
        id="cb"
        options={rest.options ?? OPTIONS}
        value={value}
        onChange={(next) => {
          setValue(next);
          onChange(next);
        }}
        allowFreeEntry={rest.allowFreeEntry}
        loading={rest.loading}
        maxVisible={rest.maxVisible}
        testId="cb"
      />
      <output data-testid="value">{value}</output>
    </form>
  );
}

function input(): HTMLInputElement {
  return screen.getByRole('combobox', { name: '动作' }) as HTMLInputElement;
}

function optionLabels(): string[] {
  return screen.getAllByRole('option').map((option) => option.textContent ?? '');
}

describe('kit/Combobox', () => {
  it('is a labelled WAI-ARIA combobox whose listbox opens on click', () => {
    render(<Harness />);
    const box = input();
    expect(box.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.click(box);
    expect(box.getAttribute('aria-expanded')).toBe('true');
    const listbox = screen.getByRole('listbox');
    expect(box.getAttribute('aria-controls')).toBe(listbox.id);
    expect(optionLabels()).toEqual([
      'docker.restart中影响',
      'docker.prune高影响',
      'host.reboot高影响',
      'restart_all',
    ]);
  });

  it('typing filters (label, value or secondary text) and Enter picks the highlighted match', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.change(input(), { target: { value: 'PRUNE' } });
    expect(optionLabels()).toEqual(['docker.prune高影响']);
    expect(input().getAttribute('aria-activedescendant')).toBe('cb-option-0');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('docker.prune');
    expect(input().value).toBe('docker.prune');
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.change(input(), { target: { value: '高影响' } });
    expect(optionLabels()).toEqual(['docker.prune高影响', 'host.reboot高影响']);
  });

  it('arrow keys move the active option, skipping disabled rows', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const box = input();
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(box.getAttribute('aria-activedescendant')).toBe('cb-option-0');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    // restart_all (index 3) is disabled: the highlight stays on host.reboot.
    expect(box.getAttribute('aria-activedescendant')).toBe('cb-option-2');
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    expect(box.getAttribute('aria-activedescendant')).toBe('cb-option-1');
    expect(screen.getByRole('option', { name: /docker.prune/ }).getAttribute('data-active')).toBe(
      'true',
    );
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('docker.prune');
  });

  it('clicking an option picks it; a disabled option cannot be picked', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(input());
    fireEvent.click(screen.getByRole('option', { name: /restart_all/ }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('option', { name: /host.reboot/ }));
    expect(onChange).toHaveBeenCalledWith('host.reboot');
    fireEvent.click(input());
    expect(screen.getByRole('option', { name: /host.reboot/ }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('Escape closes the list and reverts the typed text, without reaching a document listener', () => {
    const documentEscape = vi.fn();
    document.addEventListener('keydown', documentEscape, true);
    try {
      render(<Harness initial="docker.restart" />);
      fireEvent.change(input(), { target: { value: 'host' } });
      expect(screen.getByRole('listbox')).toBeTruthy();
      fireEvent.keyDown(input(), { key: 'Escape' });
      expect(screen.queryByRole('listbox')).toBeNull();
      expect(input().value).toBe('docker.restart');
      expect(documentEscape).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', documentEscape, true);
    }
  });

  it('strict mode: leaving the field with unpicked text puts the chosen label back', () => {
    render(<Harness initial="docker.restart" />);
    fireEvent.change(input(), { target: { value: 'nothing-like-this' } });
    expect(screen.getByTestId('cb-empty').textContent).toBe('没有匹配项。');
    fireEvent.blur(input());
    expect(input().value).toBe('docker.restart');
    expect(screen.getByTestId('value').textContent).toBe('docker.restart');
  });

  it('free entry keeps a typed value that is not on the list', () => {
    render(<Harness allowFreeEntry />);
    fireEvent.change(input(), { target: { value: 'custom.op' } });
    expect(screen.getByTestId('value').textContent).toBe('custom.op');
    expect(screen.getByTestId('cb-empty').textContent).toContain('将使用输入的值');
    // Enter with nothing highlighted keeps the typed value instead of picking a row.
    fireEvent.keyDown(input(), { key: 'Enter' });
    fireEvent.blur(input());
    expect(input().value).toBe('custom.op');
    expect(screen.getByTestId('value').textContent).toBe('custom.op');
  });

  it('the clear button empties the value', () => {
    const onChange = vi.fn();
    render(<Harness initial="host.reboot" onChange={onChange} />);
    fireEvent.click(screen.getByTestId('cb-clear'));
    expect(onChange).toHaveBeenCalledWith('');
    expect(input().value).toBe('');
    expect(screen.queryByTestId('cb-clear')).toBeNull();
  });

  it('shows a loading note while the list loads', () => {
    render(<Harness loading options={[]} />);
    fireEvent.click(input());
    // An <output> — a polite status region.
    expect(screen.getByText('正在加载…').tagName).toBe('OUTPUT');
    expect(input().getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByTestId('cb-empty')).toBeNull();
  });

  it('caps the rendered rows and says how many more typing would reach', () => {
    const many = Array.from({ length: 30 }, (_, index) => ({
      value: `op-${index}`,
      label: `op-${index}`,
    }));
    render(<Harness options={many} maxVisible={10} />);
    fireEvent.click(input());
    expect(screen.getAllByRole('option')).toHaveLength(10);
    expect(screen.getByText(/还有 20 项未显示/)).toBeTruthy();
  });

  it('Enter on an open list never submits the surrounding form', () => {
    const onSubmit = vi.fn((event: Event) => event.preventDefault());
    render(<Harness />);
    input().form?.addEventListener('submit', onSubmit);
    fireEvent.click(input());
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input().dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe('filterComboboxOptions', () => {
  it('ranks prefix matches before substring matches', () => {
    const ranked = filterComboboxOptions(
      [
        { value: 'a.restart', label: 'a.restart' },
        { value: 'restart', label: 'restart' },
      ],
      'rest',
    );
    expect(ranked.map((option) => option.value)).toEqual(['restart', 'a.restart']);
  });
});

describe('kit/ComboboxChips', () => {
  it('renders one removable chip per value and marks values outside the directory', () => {
    const onRemove = vi.fn();
    render(
      <ComboboxChips
        values={['Host', 'Legacy']}
        unknown={new Set(['Legacy'])}
        onRemove={onRemove}
        testId="chips"
      />,
    );
    const chips = screen.getByTestId('chips').querySelectorAll('li');
    expect(chips).toHaveLength(2);
    expect(chips[1]?.className).toContain('pick-chip-unknown');
    fireEvent.click(screen.getByRole('button', { name: /^移除 Host$/ }));
    expect(onRemove).toHaveBeenCalledWith('Host');
  });
});
