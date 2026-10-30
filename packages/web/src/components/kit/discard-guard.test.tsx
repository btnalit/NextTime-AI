// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { useGuardedClose } from './discard-guard.js';
import { Sheet, SheetContent, SheetTitle } from './sheet.js';

afterEach(cleanup);

function Form({ onCancel }: { readonly onCancel: () => void }) {
  const guarded = useGuardedClose();
  const [value, setValue] = useState('');
  const [sent, setSent] = useState(false);
  if (sent) return <p data-testid="sent">sent</p>;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setSent(true);
      }}
    >
      <input aria-label="name" value={value} onChange={(event) => setValue(event.target.value)} />
      <div data-no-discard-guard>
        <input aria-label="filter" />
      </div>
      <button type="submit">save</button>
      <button type="button" onClick={() => guarded(onCancel)}>
        cancel
      </button>
    </form>
  );
}

function Harness() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <span data-testid="state">{open ? 'open' : 'closed'}</span>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent data-testid="sheet">
          <SheetTitle>Edit</SheetTitle>
          {/* Applies itself at once, outside any form: nothing unsaved to lose. */}
          <input type="checkbox" aria-label="instant" />
          <Form onCancel={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
    </>
  );
}

describe('kit/discard-guard in kit/sheet (legacy 497)', () => {
  it('closes on Escape as before when nothing was edited', async () => {
    render(<Harness />);
    fireEvent.keyDown(screen.getByTestId('sheet'), { key: 'Escape' });
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('closed'));
    expect(screen.queryByTestId('discard-confirm')).toBeNull();
  });

  it('asks before Escape drops an edit: 继续编辑 (focused first) keeps it, 放弃 closes', async () => {
    render(<Harness />);
    const input = screen.getByLabelText('name') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'half' } });
    input.focus();
    fireEvent.keyDown(input, { key: 'Escape' });
    const confirm = await screen.findByTestId('discard-confirm');
    expect(confirm.textContent).toMatch(/放弃未保存的内容/);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId('discard-confirm-keep')),
    );
    fireEvent.click(screen.getByTestId('discard-confirm-keep'));
    await waitFor(() => expect(screen.queryByTestId('discard-confirm')).toBeNull());
    expect(screen.getByTestId('state').textContent).toBe('open');
    expect(document.activeElement).toBe(input);
    expect((screen.getByLabelText('name') as HTMLInputElement).value).toBe('half');

    fireEvent.keyDown(screen.getByTestId('sheet'), { key: 'Escape' });
    fireEvent.click(await screen.findByTestId('discard-confirm-discard'));
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('closed'));
  });

  it('asks the same from the form’s own 取消', async () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'half' } });
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    fireEvent.click(await screen.findByTestId('discard-confirm-discard'));
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('closed'));
  });

  it('does not ask once the edited form was submitted and replaced by its result', async () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'done' } });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await screen.findByTestId('sent');
    fireEvent.keyDown(screen.getByTestId('sheet'), { key: 'Escape' });
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('closed'));
    expect(screen.queryByTestId('discard-confirm')).toBeNull();
  });

  it('does not count a control under data-no-discard-guard (a filter) as an edit', async () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('filter'), { target: { value: 'x' } });
    fireEvent.keyDown(screen.getByTestId('sheet'), { key: 'Escape' });
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('closed'));
    expect(screen.queryByTestId('discard-confirm')).toBeNull();
  });

  it('does not count a field typed into and cleared again, or a control outside any form', async () => {
    render(<Harness />);
    const input = screen.getByLabelText('name');
    fireEvent.change(input, { target: { value: 'oops' } });
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(screen.getByLabelText('instant'));
    fireEvent.keyDown(screen.getByTestId('sheet'), { key: 'Escape' });
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('closed'));
    expect(screen.queryByTestId('discard-confirm')).toBeNull();
  });
});
