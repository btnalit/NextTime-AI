// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
});
