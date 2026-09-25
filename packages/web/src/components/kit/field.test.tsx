// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Field, describedBy } from './field.js';

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

  it('shows the hint when there is no error, and hides it once there is one', () => {
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
    expect(screen.queryByText('用于登录')).toBeNull();
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
});
