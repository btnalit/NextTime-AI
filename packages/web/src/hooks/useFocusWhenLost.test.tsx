// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { useFocusWhenKeyLost, useFocusWhenLost } from './useFocusWhenLost.js';

afterEach(cleanup);

function Outcome({ outcome }: { readonly outcome: string | null }) {
  const ref = useFocusWhenLost<HTMLDivElement>(outcome);
  return (
    <>
      <input aria-label="elsewhere" />
      {outcome !== null ? (
        <div ref={ref} tabIndex={-1} data-testid="outcome">
          {outcome}
        </div>
      ) : null}
    </>
  );
}

describe('useFocusWhenLost', () => {
  it('moves focus to the outcome when focus fell to the body', () => {
    const { rerender } = render(<Outcome outcome={null} />);
    expect(document.activeElement).toBe(document.body);
    rerender(<Outcome outcome="failed" />);
    expect(document.activeElement).toBe(screen.getByTestId('outcome'));
  });

  it('leaves focus the person moved elsewhere', () => {
    const { rerender } = render(<Outcome outcome={null} />);
    const elsewhere = screen.getByRole('textbox', { name: 'elsewhere' });
    elsewhere.focus();
    rerender(<Outcome outcome="failed" />);
    expect(document.activeElement).toBe(elsewhere);
  });
});

function Keyed({ status }: { readonly status: string | null }) {
  const title = useRef<HTMLHeadingElement>(null);
  useFocusWhenKeyLost(status, () => title.current);
  return (
    <>
      <h2 ref={title} tabIndex={-1} data-testid="title">
        Title
      </h2>
      <input aria-label="elsewhere" />
      {status === 'draft' ? <button type="button">Publish</button> : null}
    </>
  );
}

describe('useFocusWhenKeyLost (legacy 488)', () => {
  it('does nothing on mount, and moves focus once the key changes with focus lost', () => {
    const { rerender } = render(<Keyed status="draft" />);
    expect(document.activeElement).toBe(document.body);
    screen.getByRole('button', { name: 'Publish' }).focus();
    rerender(<Keyed status="published" />);
    expect(document.activeElement).toBe(screen.getByTestId('title'));
  });

  it('waits out a settling (null) key, then judges the change', () => {
    const { rerender } = render(<Keyed status="draft" />);
    screen.getByRole('button', { name: 'Publish' }).focus();
    rerender(<Keyed status={null} />);
    expect(document.activeElement).toBe(document.body);
    rerender(<Keyed status="published" />);
    expect(document.activeElement).toBe(screen.getByTestId('title'));
  });

  it('leaves focus the person moved elsewhere', () => {
    const { rerender } = render(<Keyed status="draft" />);
    const elsewhere = screen.getByRole('textbox', { name: 'elsewhere' });
    elsewhere.focus();
    rerender(<Keyed status="published" />);
    expect(document.activeElement).toBe(elsewhere);
  });
});
