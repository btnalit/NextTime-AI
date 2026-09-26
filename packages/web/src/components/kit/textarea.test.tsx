// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Textarea } from './textarea.js';

afterEach(() => {
  cleanup();
  // `clearMocks` (vitest.base.ts) resets call history but not a `mockImplementation` — restore
  // `window.getComputedStyle` explicitly so `stubMeasurements` never wraps a previous test's mock.
  vi.restoreAllMocks();
});

/** jsdom does not do real layout — `scrollHeight` is always 0, and (because the test setup does
 *  apply the app's real CSS, unlike a browser it does not turn `line-height`/`padding`/`border`
 *  into deterministic computed pixel values) `getComputedStyle` line-height/padding/border vary
 *  with whatever the cascade happens to resolve to. Stub both to fixed values, the same way this
 *  codebase already stubs `window.matchMedia` (`AppShell.test.tsx`) for the same "jsdom does not
 *  implement this" gap, so the resize math is deterministic regardless of the real stylesheet. */
function stubScrollHeight(el: HTMLElement, value: number): void {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value });
}

function stubMeasurements(el: HTMLElement): void {
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((target, pseudo) => {
    if (target !== el) return real(target, pseudo);
    return {
      lineHeight: '20px',
      paddingTop: '0px',
      paddingBottom: '0px',
      borderTopWidth: '0px',
      borderBottomWidth: '0px',
    } as CSSStyleDeclaration;
  });
}

describe('kit/Textarea', () => {
  it('gets its accessible name from aria-label', () => {
    render(<Textarea aria-label="备注" value="" onChange={() => undefined} />);
    expect(screen.getByRole('textbox', { name: '备注' }).tagName).toBe('TEXTAREA');
  });

  it('gets its accessible name from an associated label (id/htmlFor)', () => {
    render(<Textarea id="note" label="备注" value="" onChange={() => undefined} />);
    const textarea = screen.getByRole('textbox', { name: '备注' });
    expect(textarea.id).toBe('note');
  });

  it('sets rows to minRows and forwards arbitrary attributes', () => {
    render(
      <Textarea aria-label="备注" minRows={3} maxRows={6} data-testid="note" readOnly value="" />,
    );
    const textarea = screen.getByTestId('note') as HTMLTextAreaElement;
    expect(textarea.rows).toBe(3);
    expect(textarea.readOnly).toBe(true);
  });

  it('sets aria-invalid when invalid is true, and omits it otherwise', () => {
    const { rerender } = render(<Textarea aria-label="备注" invalid value="" onChange={vi.fn()} />);
    expect(screen.getByRole('textbox').getAttribute('aria-invalid')).toBe('true');
    rerender(<Textarea aria-label="备注" value="" onChange={vi.fn()} />);
    expect(screen.getByRole('textbox').getAttribute('aria-invalid')).toBeNull();
  });

  it('grows toward scrollHeight but caps at maxRows, and overflows once it does', () => {
    const ref = createRef<HTMLTextAreaElement>();
    render(
      <Textarea ref={ref} aria-label="备注" minRows={2} maxRows={4} value="" onChange={vi.fn()} />,
    );
    const el = ref.current as HTMLTextAreaElement;
    stubMeasurements(el);
    stubScrollHeight(el, 500);
    fireEvent.change(el, { target: { value: 'a\nb\nc\nd\ne\nf' } });
    // lineHeight 20px * 4 rows = 80px, well under the stubbed 500px scrollHeight — the cap, not
    // the content, must have won.
    expect(el.style.height).toBe('80px');
    expect(el.style.overflowY).toBe('auto');
  });

  it('shrinks back down and stops overflowing once content fits within minRows again', () => {
    const ref = createRef<HTMLTextAreaElement>();
    render(
      <Textarea ref={ref} aria-label="备注" minRows={2} maxRows={4} value="" onChange={vi.fn()} />,
    );
    const el = ref.current as HTMLTextAreaElement;
    stubMeasurements(el);
    stubScrollHeight(el, 10);
    fireEvent.change(el, { target: { value: 'a' } });
    // 2 rows * 20px = 40px is the floor, even though scrollHeight (10px) is smaller.
    expect(el.style.height).toBe('40px');
    expect(el.style.overflowY).toBe('hidden');
  });

  it('calls the caller-provided onChange in addition to resizing', () => {
    const onChange = vi.fn();
    render(<Textarea aria-label="备注" value="" onChange={onChange} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hi' } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
