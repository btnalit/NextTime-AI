// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Select } from './select.js';

afterEach(cleanup);

describe('kit/Select', () => {
  it('gets its accessible name from aria-label', () => {
    render(
      <Select aria-label="选择模式" value="self_serve" onChange={() => undefined}>
        <option value="self_serve">自助</option>
      </Select>,
    );
    const select = screen.getByRole('combobox', { name: '选择模式' });
    expect(select.tagName).toBe('SELECT');
    expect(select.className).toBe('select');
  });

  it('gets its accessible name from an associated label (id/htmlFor)', () => {
    render(
      <Select id="mode" label="模式" value="self_serve" onChange={() => undefined}>
        <option value="self_serve">自助</option>
      </Select>,
    );
    const select = screen.getByRole('combobox', { name: '模式' });
    expect(select.id).toBe('mode');
  });

  it('fires onChange and reflects the selected value', () => {
    const onChange = vi.fn();
    render(
      <Select aria-label="模式" value="self_serve" onChange={onChange}>
        <option value="self_serve">自助</option>
        <option value="disabled">已禁用</option>
      </Select>,
    );
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'disabled' } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('sets aria-invalid when invalid is true, and omits it otherwise', () => {
    const { rerender } = render(
      <Select aria-label="模式" invalid onChange={() => undefined}>
        <option value="a">a</option>
      </Select>,
    );
    expect(screen.getByRole('combobox').getAttribute('aria-invalid')).toBe('true');

    rerender(
      <Select aria-label="模式" onChange={() => undefined}>
        <option value="a">a</option>
      </Select>,
    );
    expect(screen.getByRole('combobox').getAttribute('aria-invalid')).toBeNull();
  });

  it('forwards arbitrary select attributes (style, data-testid, disabled)', () => {
    render(
      <Select
        aria-label="模式"
        style={{ minWidth: '11rem' }}
        data-testid="mode-select"
        disabled
        onChange={() => undefined}
      >
        <option value="a">a</option>
      </Select>,
    );
    const select = screen.getByTestId('mode-select') as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(select.style.minWidth).toBe('11rem');
  });
});
