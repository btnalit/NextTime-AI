// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Combobox } from './combobox.js';
import { Field, describedBy } from './field.js';
import { Select } from './select.js';
import { Textarea } from './textarea.js';

afterEach(cleanup);

describe('kit/Field', () => {
  it('associates the label with the control via htmlFor/id (accessible name)', () => {
    render(
      <Field id="f1" label="姓名">
        <input id="f1" />
      </Field>,
    );
    const input = screen.getByRole('textbox', { name: '姓名' });
    expect(input.id).toBe('f1');
  });

  it('renders a required marker next to the label when required', () => {
    render(
      <Field id="f2" label="姓名" required>
        <input id="f2" />
      </Field>,
    );
    const label = screen.getByText('姓名').closest('label');
    expect(label?.querySelector('.field-required')).toBeTruthy();
    expect(label?.querySelector('.field-required')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps the hint visible alongside the error so the rule stays on screen', () => {
    const { rerender } = render(
      <Field id="f3" label="邮箱" hint="用于登录">
        <input id="f3" />
      </Field>,
    );
    expect(screen.getByText('用于登录')).toBeTruthy();

    rerender(
      <Field id="f3" label="邮箱" hint="用于登录" error="格式不对">
        <input id="f3" />
      </Field>,
    );
    const hint = screen.getByText('用于登录');
    expect(hint.id).toBe('f3-hint');
    const error = screen.getByRole('alert');
    expect(error.textContent).toBe('格式不对');
    expect(error.id).toBe('f3-error');
  });

  it('describedBy composes hint/error ids and omits itself when neither is present', () => {
    expect(describedBy('x', true, true)).toBe('x-hint x-error');
    expect(describedBy('x', true, false)).toBe('x-hint');
    expect(describedBy('x', false, true)).toBe('x-error');
    expect(describedBy('x', false, false)).toBeUndefined();
  });

  describe('legacy 498: a control inside a Field is described by its hint and error', () => {
    it('kit Select, Textarea and Combobox point at the hint and the error while shown', () => {
      render(
        <>
          <Field id="s1" label="门" hint="选一个门" error="必填">
            <Select id="s1">
              <option value="">-</option>
            </Select>
          </Field>
          <Field id="t1" label="参数" hint="JSON">
            <Textarea id="t1" aria-label="参数" value="" onChange={() => {}} />
          </Field>
          <Field id="c1" label="Operation" error="不存在">
            <Combobox id="c1" options={[]} value="" onChange={() => {}} />
          </Field>
        </>,
      );
      expect(document.getElementById('s1')?.getAttribute('aria-describedby')).toBe(
        's1-hint s1-error',
      );
      expect(document.getElementById('t1')?.getAttribute('aria-describedby')).toBe('t1-hint');
      expect(document.getElementById('c1')?.getAttribute('aria-describedby')).toBe('c1-error');
    });

    it('keeps a description the form gives itself, and leaves other controls in the Field alone', () => {
      render(
        <Field id="e1" label="定义" hint="Worker">
          <Select id="e1" aria-describedby="elsewhere">
            <option value="">-</option>
          </Select>
          <Select id="e1-version" aria-label="版本">
            <option value="">-</option>
          </Select>
        </Field>,
      );
      expect(document.getElementById('e1')?.getAttribute('aria-describedby')).toBe('elsewhere');
      expect(document.getElementById('e1-version')?.hasAttribute('aria-describedby')).toBe(false);
    });
  });
});
