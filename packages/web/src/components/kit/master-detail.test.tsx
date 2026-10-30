import * as PopoverPrimitive from '@radix-ui/react-popover';
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dialog, DialogContent, DialogTitle } from './dialog.js';
import { MasterDetail } from './master-detail.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A minimal `matchMedia` mock fixed at one match state — mirrors `kit/data-table.test.tsx`'s own
 *  helper; `useMediaQuery` only reads `.matches` and subscribes via `addEventListener`. */
function mockMatchMedia(matches: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches,
      media: '',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

describe('kit/MasterDetail', () => {
  it('renders a wide two-pane layout — the detail pane is always mounted, even with nothing open', () => {
    mockMatchMedia(false);
    render(
      <MasterDetail
        list={<div data-testid="the-list">list</div>}
        detail={<div data-testid="the-detail">detail</div>}
        open={false}
        onClose={vi.fn()}
        sheetTitle="Detail"
        detailTestId="md-detail"
      />,
    );
    expect(screen.getByTestId('the-list')).toBeTruthy();
    const pane = screen.getByTestId('md-detail');
    expect(pane.className).toContain('md-detail-pane');
    expect(screen.getByTestId('the-detail')).toBeTruthy();
    // No sheet at all at wide widths.
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the list card alone on wide when there is nothing to pick (detail === null)', () => {
    mockMatchMedia(false);
    render(
      <MasterDetail
        list={<div data-testid="the-list">list</div>}
        detail={null}
        open={false}
        onClose={vi.fn()}
        sheetTitle="Detail"
        detailTestId="md-detail"
      />,
    );
    expect(screen.getByTestId('the-list')).toBeTruthy();
    expect(screen.queryByTestId('md-detail')).toBeNull();
  });

  it('renders the list only at narrow widths, with the detail in a kit/sheet that opens with `open`', () => {
    mockMatchMedia(true);
    const onClose = vi.fn();
    render(
      <MasterDetail
        list={<div data-testid="the-list">list</div>}
        detail={<div data-testid="the-detail">detail</div>}
        open={true}
        onClose={onClose}
        sheetTitle="Detail title"
        detailTestId="md-detail"
      />,
    );
    expect(screen.getByTestId('the-list')).toBeTruthy();
    // The wide pane never mounts at a narrow width.
    expect(screen.queryByTestId('md-detail')).not.toBeNull();
    const sheet = screen.getByTestId('md-detail');
    expect(sheet.getAttribute('role')).toBe('dialog');
    expect(screen.getByText('Detail title')).toBeTruthy();
    expect(screen.getByTestId('the-detail')).toBeTruthy();

    fireEvent.keyDown(sheet, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  describe('closeFocusFallback (UX acceptance of #782, R-1)', () => {
    function Harness({ keepRow }: { readonly keepRow: boolean }) {
      const [open, setOpen] = useState(false);
      const [listed, setListed] = useState(true);
      return (
        <>
          <button type="button" data-testid="fallback">
            tab
          </button>
          <MasterDetail
            list={
              listed ? (
                <button type="button" data-testid="row" onClick={() => setOpen(true)}>
                  row
                </button>
              ) : null
            }
            detail={
              <button
                type="button"
                data-testid="retire"
                onClick={() => {
                  if (!keepRow) setListed(false);
                  setOpen(false);
                }}
              >
                retire
              </button>
            }
            open={open}
            onClose={() => setOpen(false)}
            sheetTitle="Detail"
            detailTestId="md-detail"
            closeFocusFallback={() => screen.queryByTestId('fallback')}
          />
        </>
      );
    }

    it('takes focus when the row the sheet was opened from left the list', async () => {
      mockMatchMedia(true);
      render(<Harness keepRow={false} />);
      const row = screen.getByTestId('row');
      row.focus();
      fireEvent.click(row);
      fireEvent.click(await screen.findByTestId('retire'));
      await waitFor(() => expect(screen.queryByTestId('md-detail')).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('fallback')));
    });

    it('leaves focus to the row the sheet was opened from while it is still listed', async () => {
      mockMatchMedia(true);
      render(<Harness keepRow />);
      const row = screen.getByTestId('row');
      row.focus();
      fireEvent.click(row);
      fireEvent.click(await screen.findByTestId('retire'));
      await waitFor(() => expect(screen.queryByTestId('md-detail')).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(row));
    });
  });

  it('holdOpen keeps the narrow sheet open on Escape and an outside click (legacy 497)', () => {
    mockMatchMedia(true);
    const onClose = vi.fn();
    const { rerender } = render(
      <MasterDetail
        list={<div>list</div>}
        detail={<input aria-label="name" />}
        open={true}
        onClose={onClose}
        sheetTitle="Detail"
        detailTestId="md-detail"
        holdOpen
      />,
    );
    const sheet = screen.getByTestId('md-detail');
    fireEvent.keyDown(sheet, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('md-detail')).toBeTruthy();

    rerender(
      <MasterDetail
        list={<div>list</div>}
        detail={<input aria-label="name" />}
        open={true}
        onClose={onClose}
        sheetTitle="Detail"
        detailTestId="md-detail"
      />,
    );
    fireEvent.keyDown(screen.getByTestId('md-detail'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('closed at a narrow width mounts no sheet at all', () => {
    mockMatchMedia(true);
    render(
      <MasterDetail
        list={<div data-testid="the-list">list</div>}
        detail={<div data-testid="the-detail">detail</div>}
        open={false}
        onClose={vi.fn()}
        sheetTitle="Detail"
        detailTestId="md-detail"
      />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByTestId('the-detail')).toBeNull();
  });

  it('keeps the detail as it is when the width crosses the breakpoint (legacy 480)', () => {
    // A matchMedia whose state the test flips, telling the subscribed listener.
    let narrow = false;
    const listeners = new Set<(event: { matches: boolean }) => void>();
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        get matches() {
          return narrow;
        },
        media: '',
        addEventListener: (_: string, listener: (event: { matches: boolean }) => void) =>
          listeners.add(listener),
        removeEventListener: (_: string, listener: (event: { matches: boolean }) => void) =>
          listeners.delete(listener),
      })),
    );
    const setNarrow = (next: boolean) =>
      act(() => {
        narrow = next;
        for (const listener of listeners) listener({ matches: next });
      });
    function Counter() {
      const [count, setCount] = useState(0);
      return (
        <div>
          <button type="button" onClick={() => setCount((value) => value + 1)}>
            more
          </button>
          <span data-testid="count">{count}</span>
          <details data-testid="disclosure">
            <summary>open</summary>
            body
          </details>
        </div>
      );
    }
    render(
      <MasterDetail
        list={<div>list</div>}
        detail={<Counter />}
        open={true}
        onClose={vi.fn()}
        sheetTitle="Detail"
        detailTestId="md-detail"
      />,
    );
    fireEvent.click(screen.getByText('more'));
    (screen.getByTestId('disclosure') as HTMLDetailsElement).open = true;
    expect(screen.getByTestId('md-detail').className).toContain('md-detail-pane');

    setNarrow(true);
    expect(screen.getByTestId('md-detail').getAttribute('role')).toBe('dialog');
    expect(screen.getByTestId('count').textContent).toBe('1');
    expect((screen.getByTestId('disclosure') as HTMLDetailsElement).open).toBe(true);

    setNarrow(false);
    expect(screen.getByTestId('md-detail').className).toContain('md-detail-pane');
    expect(screen.getByTestId('count').textContent).toBe('1');
    expect((screen.getByTestId('disclosure') as HTMLDetailsElement).open).toBe(true);
  });

  it('stays wide while a dialog open at the crossing is still open (legacy 483)', async () => {
    let narrow = false;
    const listeners = new Set<(event: { matches: boolean }) => void>();
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        get matches() {
          return narrow;
        },
        media: '',
        addEventListener: (_: string, listener: (event: { matches: boolean }) => void) =>
          listeners.add(listener),
        removeEventListener: (_: string, listener: (event: { matches: boolean }) => void) =>
          listeners.delete(listener),
      })),
    );
    function Page() {
      const [editing, setEditing] = useState(true);
      return (
        <>
          <MasterDetail
            list={<div>list</div>}
            detail={<div data-testid="the-detail">detail</div>}
            open={true}
            onClose={vi.fn()}
            sheetTitle="Detail"
            detailTestId="md-detail"
          />
          <Dialog open={editing} onOpenChange={setEditing}>
            <DialogContent data-testid="edit-dialog">
              <DialogTitle>Edit</DialogTitle>
              <input data-testid="edit-input" />
            </DialogContent>
          </Dialog>
        </>
      );
    }
    render(<Page />);
    const input = await screen.findByTestId('edit-input');
    input.focus();
    act(() => {
      narrow = true;
      for (const listener of listeners) listener({ matches: true });
    });
    // No sheet over the dialog: the layout stays wide, and the dialog keeps its focus.
    expect(screen.getByTestId('md-detail').className).toContain('md-detail-pane');
    expect(screen.queryAllByRole('dialog')).toHaveLength(1);
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(screen.getByTestId('edit-dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('edit-dialog')).toBeNull());
    // Once the dialog is gone the detail opens in the sheet.
    const sheet = await screen.findByTestId('md-detail');
    expect(sheet.getAttribute('role')).toBe('dialog');
    expect(screen.getByTestId('the-detail')).toBeTruthy();
  });

  it('closes an anchored confirmation open at the crossing, then opens the sheet (legacy 483)', async () => {
    let narrow = false;
    const listeners = new Set<(event: { matches: boolean }) => void>();
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        get matches() {
          return narrow;
        },
        media: '',
        addEventListener: (_: string, listener: (event: { matches: boolean }) => void) =>
          listeners.add(listener),
        removeEventListener: (_: string, listener: (event: { matches: boolean }) => void) =>
          listeners.delete(listener),
      })),
    );
    function Detail() {
      const [confirming, setConfirming] = useState(true);
      return (
        <PopoverPrimitive.Root open={confirming} onOpenChange={setConfirming}>
          <PopoverPrimitive.Anchor asChild>
            <button type="button">Discard</button>
          </PopoverPrimitive.Anchor>
          <PopoverPrimitive.Portal>
            <PopoverPrimitive.Content data-testid="confirm">
              <input data-testid="reason" />
            </PopoverPrimitive.Content>
          </PopoverPrimitive.Portal>
        </PopoverPrimitive.Root>
      );
    }
    render(
      <MasterDetail
        list={<div>list</div>}
        detail={<Detail />}
        open={true}
        onClose={vi.fn()}
        sheetTitle="Detail"
        detailTestId="md-detail"
      />,
    );
    const reason = (await screen.findByTestId('reason')) as HTMLInputElement;
    reason.focus();
    fireEvent.change(reason, { target: { value: 'half a reason' } });
    act(() => {
      narrow = true;
      for (const listener of listeners) listener({ matches: true });
    });
    // The layout change moves its anchor and it is not placed again (#767 P3-3): it closes, and
    // the detail opens in the sheet rather than over it.
    await waitFor(() => expect(screen.queryByTestId('confirm')).toBeNull());
    const sheet = await screen.findByTestId('md-detail');
    await waitFor(() => expect(sheet.getAttribute('role')).toBe('dialog'));
  });

  it('on a window too narrow for the wide layout, closes an anchored confirmation and opens the sheet (#767 P3-2)', async () => {
    vi.stubGlobal('innerWidth', 390);
    let narrow = false;
    const listeners = new Set<(event: { matches: boolean }) => void>();
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        get matches() {
          return narrow;
        },
        media: '',
        addEventListener: (_: string, listener: (event: { matches: boolean }) => void) =>
          listeners.add(listener),
        removeEventListener: (_: string, listener: (event: { matches: boolean }) => void) =>
          listeners.delete(listener),
      })),
    );
    function Detail() {
      const [confirming, setConfirming] = useState(true);
      return (
        <PopoverPrimitive.Root open={confirming} onOpenChange={setConfirming}>
          <PopoverPrimitive.Anchor asChild>
            <button type="button">Discard</button>
          </PopoverPrimitive.Anchor>
          <PopoverPrimitive.Portal>
            <PopoverPrimitive.Content data-testid="confirm">
              <input data-testid="reason" />
            </PopoverPrimitive.Content>
          </PopoverPrimitive.Portal>
        </PopoverPrimitive.Root>
      );
    }
    render(
      <MasterDetail
        list={<div>list</div>}
        detail={<Detail />}
        open={true}
        onClose={vi.fn()}
        sheetTitle="Detail"
        detailTestId="md-detail"
      />,
    );
    (await screen.findByTestId('reason')).focus();
    act(() => {
      narrow = true;
      for (const listener of listeners) listener({ matches: true });
    });
    // No 2px-wide detail pane holding an anchor off the screen: the confirmation closes, and the
    // detail opens in the sheet.
    await waitFor(() => expect(screen.queryByTestId('confirm')).toBeNull());
    const sheet = await screen.findByTestId('md-detail');
    await waitFor(() => expect(sheet.getAttribute('role')).toBe('dialog'));
  });
});
