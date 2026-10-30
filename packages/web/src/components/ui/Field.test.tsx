// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Field, Input } from './Field.js';

afterEach(cleanup);

describe('ui/Field (legacy 498)', () => {
  it('Input points at the hint while shown, and says nothing when neither is shown', () => {
    const { rerender } = render(
      <Field id="u1" label="名称" hint="小写">
        <Input id="u1" />
      </Field>,
    );
    expect(document.getElementById('u1')?.getAttribute('aria-describedby')).toBe('u1-hint');
    rerender(
      <Field id="u1" label="名称">
        <Input id="u1" />
      </Field>,
    );
    expect(document.getElementById('u1')?.hasAttribute('aria-describedby')).toBe(false);
  });
});
