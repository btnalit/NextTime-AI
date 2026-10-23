// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useFocusWhenLost } from './useFocusWhenLost.js';

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
