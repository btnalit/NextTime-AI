// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sheet, SheetContent, SheetTitle } from '../kit/sheet.js';
import { Drawer } from './Drawer.js';
import { ToastProvider, useToast } from './Toast.js';

function PushFailure() {
  const toast = useToast();
  useEffect(() => {
    toast.push({
      tone: 'danger',
      title: 'Could not publish',
      description: 'Refresh and try again.',
      details: { code: 'conflict', raw: 'operation docker.restart is not a draft' },
    });
  }, [toast]);
  return null;
}

function PushOnMount() {
  const toast = useToast();
  useEffect(() => {
    toast.push({ title: 'saved' });
  }, [toast]);
  return null;
}

describe('ToastProvider', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  // Legacy 652: the action is a secondary button, not a ghost one that reads as text; the close
  // button is named in the reader's language.
  it('draws the action as a secondary button and names the close button', () => {
    const onClick = vi.fn();
    function PushWithAction() {
      const toast = useToast();
      useEffect(() => {
        toast.push({ title: 'Draft deleted', action: { label: 'Undo', onClick } });
      }, [toast]);
      return null;
    }
    render(
      <ToastProvider>
        <PushWithAction />
      </ToastProvider>,
    );
    const action = screen.getByRole('button', { name: 'Undo' });
    expect(action.className).toContain('btn-secondary');
    expect(action.className).not.toContain('btn-ghost');
    fireEvent.click(action);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryAllByTestId('toast')).toHaveLength(0);
  });

  it('clears pending dismiss timers when it unmounts', () => {
    const { unmount, getAllByTestId } = render(
      <ToastProvider>
        <PushOnMount />
      </ToastProvider>,
    );
    expect(getAllByTestId('toast')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.runAllTimers());
  });

  it('legacy 212: a failure folds its technical details; opening them keeps the toast', () => {
    const view = render(
      <ToastProvider>
        <PushFailure />
      </ToastProvider>,
    );
    const details = view.getByText('技术细节').closest('details');
    expect(details?.open).toBe(false);
    expect(details?.querySelector('code')?.textContent).toBe('conflict');
    expect(view.getByTestId('toast-detail').textContent).toBe(
      'operation docker.restart is not a draft',
    );
    if (!details) throw new Error('no details');
    details.open = true;
    fireEvent(details, new Event('toggle'));
    act(() => vi.advanceTimersByTime(60_000));
    expect(view.getAllByTestId('toast')).toHaveLength(1);
  });

  it('legacy 212: a failure whose details stay closed is dismissed on time', () => {
    const view = render(
      <ToastProvider>
        <PushFailure />
      </ToastProvider>,
    );
    act(() => vi.advanceTimersByTime(5_000));
    expect(view.queryAllByTestId('toast')).toHaveLength(0);
  });

  it('#1398 UX P3: pointed at, a toast pauses; the rest of its time runs once the pointer leaves', () => {
    const view = render(
      <ToastProvider>
        <PushFailure />
      </ToastProvider>,
    );
    act(() => vi.advanceTimersByTime(3_000));
    const toast = view.getByTestId('toast');
    fireEvent.pointerEnter(toast);
    act(() => vi.advanceTimersByTime(60_000));
    expect(view.getAllByTestId('toast')).toHaveLength(1);
    fireEvent.pointerLeave(toast);
    act(() => vi.advanceTimersByTime(1_900));
    expect(view.getAllByTestId('toast')).toHaveLength(1);
    act(() => vi.advanceTimersByTime(200));
    expect(view.queryAllByTestId('toast')).toHaveLength(0);
  });

  it('#1398 UX P3: focused, a toast pauses until the focus leaves it', async () => {
    const view = render(
      <>
        <button type="button">elsewhere</button>
        <ToastProvider>
          <PushFailure />
        </ToastProvider>
      </>,
    );
    const close = view.getByRole('button', { name: '关闭提示' });
    act(() => close.focus());
    act(() => vi.advanceTimersByTime(60_000));
    expect(view.getAllByTestId('toast')).toHaveLength(1);
    await act(async () => view.getByRole('button', { name: 'elsewhere' }).focus());
    act(() => vi.advanceTimersByTime(5_000));
    expect(view.queryAllByTestId('toast')).toHaveLength(0);
  });
});

/** #1398 UX P2: a modal drawer sets pointer-events: none on <body> and closes on any outside
 *  press; the toasts above it are not outside (`lib/toast-region`). Real timers: Radix attaches
 *  its outside listeners on the next tick. */
describe('ToastProvider from the keyboard', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('#1407 UX P3: while the keyboard is in the toasts none leaves; their time runs again after', () => {
    render(
      <ToastProvider>
        <PushOnMount />
        <PushOnMount />
        <button type="button">page</button>
      </ToastProvider>,
    );
    const page = screen.getByRole('button', { name: 'page' });
    act(() => page.focus());
    act(() => {
      fireEvent.keyDown(page, { key: 'F8' });
    });
    expect(document.activeElement?.closest('.toast-region')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(8000);
    });
    expect(screen.getAllByTestId('toast')).toHaveLength(2);
    act(() => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    });
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(document.activeElement).toBe(page);
    expect(screen.getAllByTestId('toast')).toHaveLength(2);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.queryAllByTestId('toast')).toHaveLength(0);
  });
});

describe('ToastProvider over a modal sheet', () => {
  afterEach(cleanup);

  function Page() {
    const [open, setOpen] = useState(true);
    return (
      <ToastProvider>
        <PushFailure />
        <span data-testid="state">{open ? 'open' : 'closed'}</span>
        <button type="button" data-testid="elsewhere">
          elsewhere
        </button>
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent data-testid="sheet">
            <SheetTitle>Edit</SheetTitle>
            <form>
              <input aria-label="name" />
            </form>
          </SheetContent>
        </Sheet>
      </ToastProvider>
    );
  }

  // jsdom's pointer has no type, which Radix handles on the click that follows. In a browser the
  // close has removed the toast by then (React flushes between listeners); here it is removed just
  // after, so the detached-target case itself is covered in lib/toast-region.test and
  // kit/confirm.test.
  function press(element: HTMLElement): void {
    fireEvent.pointerDown(element);
    fireEvent.pointerUp(element);
    fireEvent.click(element);
  }

  async function opened(): Promise<void> {
    await screen.findByTestId('sheet');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('opening the details or closing the toast keeps an untouched sheet open', async () => {
    render(<Page />);
    await opened();
    press(screen.getByText('技术细节'));
    expect(screen.getByTestId('state').textContent).toBe('open');
    press(screen.getByRole('button', { name: '关闭提示' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId('toast')).toBeNull();
    expect(screen.getByTestId('state').textContent).toBe('open');
  });

  it('closing the toast over an edited sheet neither closes it nor asks to discard', async () => {
    render(<Page />);
    await opened();
    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'half' } });
    press(screen.getByRole('button', { name: '关闭提示', hidden: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByTestId('state').textContent).toBe('open');
    expect(screen.queryByTestId('discard-confirm')).toBeNull();
    expect((screen.getByLabelText('name') as HTMLInputElement).value).toBe('half');
    // Control: anywhere else outside still asks before dropping the edit.
    press(screen.getByTestId('elsewhere'));
    expect(await screen.findByTestId('discard-confirm')).toBeTruthy();
  });

  // Legacy 820: Radix keeps the focus inside the modal; the toasts are reached by their hotkey.
  function Form({ pushes }: { readonly pushes: 0 | 1 | 2 }) {
    const [open, setOpen] = useState(true);
    return (
      <ToastProvider>
        {pushes > 0 ? <PushFailure /> : null}
        {pushes > 1 ? <PushFailure /> : null}
        <span data-testid="state">{open ? 'open' : 'closed'}</span>
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent data-testid="sheet">
            <SheetTitle>Edit</SheetTitle>
            <input aria-label="name" />
            <input aria-label="note" />
          </SheetContent>
        </Sheet>
      </ToastProvider>
    );
  }

  async function settle(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  function key(name: string): void {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: name });
  }

  function inToasts(): boolean {
    return document.activeElement?.closest('.toast-region') != null;
  }

  it('legacy 820: F8 takes the keyboard to the toasts over the sheet; Escape brings it back', async () => {
    render(<Form pushes={1} />);
    await opened();
    const name = screen.getByLabelText('name');
    act(() => name.focus());
    // Not hidden from assistive tech while the modal is open.
    expect(screen.getByRole('button', { name: '关闭提示' })).toBeTruthy();
    expect(screen.getByLabelText('Notifications').getAttribute('aria-keyshortcuts')).toBe('F8');
    // #1407 UX P3: the key is shown too, and the way back once there.
    expect(screen.getByTestId('toast-hint').textContent).toBe('F8 聚焦到提示');
    act(() => key('F8'));
    await settle();
    expect(inToasts()).toBe(true);
    expect(screen.getByTestId('toast-hint').textContent).toBe('Esc 返回');
    act(() => key('Escape'));
    await settle();
    expect(document.activeElement).toBe(name);
    // Escape in the toasts left the sheet open.
    expect(screen.getByTestId('state').textContent).toBe('open');
    // F8 again goes there and back the same way.
    act(() => key('F8'));
    await settle();
    expect(inToasts()).toBe(true);
    act(() => key('F8'));
    await settle();
    expect(document.activeElement).toBe(name);
  });

  it('legacy 820: dismissing the last toast from the keyboard gives the focus back to the sheet', async () => {
    render(<Form pushes={1} />);
    await opened();
    const name = screen.getByLabelText('name');
    act(() => name.focus());
    act(() => key('F8'));
    await settle();
    expect(inToasts()).toBe(true);
    act(() => screen.getByRole('button', { name: '关闭提示' }).click());
    await settle();
    expect(screen.queryByTestId('toast')).toBeNull();
    expect(document.activeElement).toBe(name);
    expect(screen.getByTestId('state').textContent).toBe('open');
  });

  it('legacy 820: dismissing one of two toasts moves the focus to the other', async () => {
    render(<Form pushes={2} />);
    await opened();
    act(() => screen.getByLabelText('name').focus());
    act(() => key('F8'));
    await settle();
    const [first, second] = screen.getAllByTestId('toast');
    expect(first?.contains(document.activeElement)).toBe(true);
    act(() =>
      within(first as HTMLElement)
        .getByRole('button', { name: '关闭提示' })
        .click(),
    );
    await settle();
    expect(screen.getAllByTestId('toast')).toHaveLength(1);
    expect(second?.contains(document.activeElement)).toBe(true);
  });

  it('legacy 820: focus moved on from the toasts stays where the reader put it', async () => {
    render(<Form pushes={1} />);
    await opened();
    act(() => screen.getByLabelText('name').focus());
    act(() => key('F8'));
    await settle();
    expect(inToasts()).toBe(true);
    const note = screen.getByLabelText('note');
    act(() => note.focus());
    await settle();
    expect(document.activeElement).toBe(note);
  });

  it('legacy 820: with no toast, F8 leaves the focus where it is', async () => {
    render(<Form pushes={0} />);
    await opened();
    const name = screen.getByLabelText('name');
    act(() => name.focus());
    act(() => key('F8'));
    await settle();
    expect(document.activeElement).toBe(name);
  });

  it('legacy 820: Escape in the toasts never reaches a legacy drawer around the page', async () => {
    const onClose = vi.fn();
    render(
      <ToastProvider>
        <PushFailure />
        <Drawer open title="Edit" onClose={onClose}>
          <input aria-label="field" />
        </Drawer>
      </ToastProvider>,
    );
    const field = screen.getByLabelText('field');
    act(() => field.focus());
    act(() => key('F8'));
    await settle();
    expect(inToasts()).toBe(true);
    act(() => key('Escape'));
    await settle();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(field);
  });
});
