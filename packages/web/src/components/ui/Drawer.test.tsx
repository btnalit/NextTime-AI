// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { GuardedCancelButton } from '../kit/discard-guard.js';
import { Drawer } from './Drawer.js';

afterEach(cleanup);

function Harness() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <span data-testid="state">{open ? 'open' : 'closed'}</span>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="Edit"
        testId="drawer"
        footer={<GuardedCancelButton onCancel={() => setOpen(false)}>cancel</GuardedCancelButton>}
      >
        <form>
          <input aria-label="name" />
        </form>
      </Drawer>
    </>
  );
}

describe('ui/Drawer discard guard (legacy 497)', () => {
  it('closes on Escape as before when nothing was edited', async () => {
    render(<Harness />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByTestId('state').textContent).toBe('closed');
  });

  it('asks before Escape, the overlay, × or the footer 取消 drop an edit', async () => {
    render(<Harness />);
    const input = screen.getByLabelText('name') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'half' } });

    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.click(await screen.findByTestId('discard-confirm-keep'));
    await waitFor(() => expect(screen.queryByTestId('discard-confirm')).toBeNull());
    expect(screen.getByTestId('state').textContent).toBe('open');

    // Escape inside the question answers it (继续编辑) and does not reach the drawer.
    fireEvent.click(screen.getByTestId('drawer-overlay'));
    fireEvent.keyDown(await screen.findByTestId('discard-confirm-keep'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('discard-confirm')).toBeNull());
    expect(screen.getByTestId('state').textContent).toBe('open');

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(await screen.findByTestId('discard-confirm-keep'));
    await waitFor(() => expect(screen.queryByTestId('discard-confirm')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    fireEvent.click(await screen.findByTestId('discard-confirm-discard'));
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('closed'));
  });

  it('继续编辑 after a click on the overlay hands focus back to the field edited last (#794 UX R-1)', async () => {
    render(<Harness />);
    const input = screen.getByLabelText('name') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'half' } });
    // A pointer press on the overlay leaves focus on <body>.
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.click(screen.getByTestId('drawer-overlay'));
    fireEvent.click(await screen.findByTestId('discard-confirm-keep'));
    await waitFor(() => expect(screen.queryByTestId('discard-confirm')).toBeNull());
    expect(document.activeElement).toBe(input);
  });
});
