// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './dialog.js';
import { GuardedCancelButton } from './discard-guard.js';

afterEach(cleanup);

function renderDialog() {
  return render(
    <Dialog>
      <DialogTrigger>打开</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>清除工作区</DialogTitle>
          <DialogDescription>此操作不可逆。</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose>取消</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>,
  );
}

describe('kit/Dialog', () => {
  it('is closed until the trigger is clicked, then renders role="dialog" with the title', async () => {
    renderDialog();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '打开' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('清除工作区');
    expect(screen.getByText('此操作不可逆。')).toBeTruthy();
  });

  it('closes via DialogClose', async () => {
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: '打开' }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('asks before Escape or its 取消 drop an edited field, as a drawer does (legacy 497 rule)', async () => {
    function Editing() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <span data-testid="state">{open ? 'open' : 'closed'}</span>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent data-testid="dialog">
              <DialogTitle>编辑描述</DialogTitle>
              <textarea aria-label="desc" defaultValue="old" data-discard-guard />
              <GuardedCancelButton onCancel={() => setOpen(false)}>取消</GuardedCancelButton>
            </DialogContent>
          </Dialog>
        </>
      );
    }
    render(<Editing />);
    const box = screen.getByLabelText('desc');
    fireEvent.keyDown(box, { key: 'Escape' });
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('closed'));

    cleanup();
    render(<Editing />);
    fireEvent.change(screen.getByLabelText('desc'), { target: { value: 'new' } });
    fireEvent.keyDown(screen.getByLabelText('desc'), { key: 'Escape' });
    fireEvent.click(await screen.findByTestId('discard-confirm-keep'));
    await waitFor(() => expect(screen.queryByTestId('discard-confirm')).toBeNull());
    expect(screen.getByTestId('state').textContent).toBe('open');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    fireEvent.click(await screen.findByTestId('discard-confirm-discard'));
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('closed'));
  });
});
