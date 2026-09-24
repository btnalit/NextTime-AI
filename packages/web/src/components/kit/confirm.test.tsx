// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Confirm, type ConfirmLevel, type ConfirmProps } from './confirm.js';

afterEach(cleanup);

/** A minimal, uncontrolled-from-the-outside harness: `open` lives here, the way every real
 *  caller owns it, and `anchor` is the actual clicked trigger — `Confirm` renders it in place. */
function Harness(props: Omit<ConfirmProps, 'open' | 'onOpenChange' | 'anchor'>) {
  const [open, setOpen] = useState(false);
  return (
    <Confirm
      {...props}
      open={open}
      onOpenChange={setOpen}
      anchor={
        <button type="button" onClick={() => setOpen(true)} data-testid="trigger">
          触发
        </button>
      }
    />
  );
}

function renderTier(tier: ConfirmLevel, overrides: Partial<ConfirmProps> = {}) {
  const onConfirm = overrides.onConfirm ?? vi.fn(async () => undefined);
  return {
    onConfirm,
    ...render(
      <Harness
        tier={tier}
        title="批准"
        target={tier === 'irreversible' ? 'acme-prod' : 'docker.container_stop'}
        confirmLabel="确认"
        testId="confirm"
        {...overrides}
        onConfirm={onConfirm}
      />,
    ),
  };
}

describe('kit/Confirm — low', () => {
  it('fires onConfirm the moment it opens, notifies success with the undo action, then closes', async () => {
    const onConfirm = vi.fn(async () => undefined);
    const onUndo = vi.fn();
    const notify = vi.fn();
    function LowHarness() {
      const [open, setOpen] = useState(false);
      return (
        <Confirm
          tier="low"
          open={open}
          onOpenChange={setOpen}
          anchor={
            <button type="button" onClick={() => setOpen(true)} data-testid="trigger">
              归档
            </button>
          }
          title="已归档"
          onConfirm={onConfirm}
          notify={notify}
          undo={{ onUndo }}
        />
      );
    }
    render(<LowHarness />);
    fireEvent.click(screen.getByTestId('trigger'));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    const call = notify.mock.calls[0]?.[0];
    expect(call.tone).toBe('ok');
    expect(call.title).toBe('已归档');
    call.action.onClick();
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it('notifies a failure and still closes', async () => {
    const notify = vi.fn();
    function LowHarness() {
      const [open, setOpen] = useState(false);
      return (
        <Confirm
          tier="low"
          open={open}
          onOpenChange={setOpen}
          anchor={
            <button type="button" onClick={() => setOpen(true)} data-testid="trigger">
              归档
            </button>
          }
          title="已归档"
          onConfirm={async () => {
            throw new Error('kernel said no');
          }}
          notify={notify}
        />
      );
    }
    render(<LowHarness />);
    fireEvent.click(screen.getByTestId('trigger'));
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify.mock.calls[0]?.[0].tone).toBe('danger');
    expect(notify.mock.calls[0]?.[0].description).toContain('kernel said no');
  });
});

describe('kit/Confirm — medium', () => {
  it('is closed until the anchor opens it, then renders next to it with the target/impact and focus on confirm', async () => {
    renderTier('medium', { impact: ['3 个门实例'] });
    expect(screen.queryByTestId('confirm')).toBeNull();
    fireEvent.click(screen.getByTestId('trigger'));
    const popover = await screen.findByTestId('confirm');
    expect(popover.getAttribute('role')).toBe('dialog');
    expect(screen.getByTestId('confirm-target').textContent).toBe('docker.container_stop');
    expect(screen.getByTestId('confirm-impact').textContent).toContain('3 个门实例');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('confirm-button')));
  });

  it('confirms, calls onConfirm, and closes; the trigger regains focus', async () => {
    let resolve: () => void = () => undefined;
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    renderTier('medium', { onConfirm });
    const trigger = screen.getByTestId('trigger');
    // jsdom's `fireEvent.click` does not move focus the way a real click does — focus explicitly
    // first so `document.activeElement` is the trigger when the popover opens, the same as a real
    // click in a browser.
    trigger.focus();
    fireEvent.click(trigger);
    await screen.findByTestId('confirm');
    const confirmButton = screen.getByTestId('confirm-button');
    fireEvent.click(confirmButton);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(confirmButton.getAttribute('aria-busy')).toBe('true');
    resolve();
    await waitFor(() => expect(screen.queryByTestId('confirm')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('cancel closes without calling onConfirm', async () => {
    const onConfirm = vi.fn(async () => undefined);
    renderTier('medium', { onConfirm });
    fireEvent.click(screen.getByTestId('trigger'));
    await screen.findByTestId('confirm');
    fireEvent.click(screen.getByTestId('confirm-cancel'));
    await waitFor(() => expect(screen.queryByTestId('confirm')).toBeNull());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('Escape cancels without calling onConfirm', async () => {
    const onConfirm = vi.fn(async () => undefined);
    renderTier('medium', { onConfirm });
    fireEvent.click(screen.getByTestId('trigger'));
    const popover = await screen.findByTestId('confirm');
    fireEvent.keyDown(popover, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('confirm')).toBeNull());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('a thrown error renders inline and the popover stays open', async () => {
    renderTier('medium', {
      onConfirm: async () => {
        throw new Error('kernel said no');
      },
    });
    fireEvent.click(screen.getByTestId('trigger'));
    await screen.findByTestId('confirm');
    fireEvent.click(screen.getByTestId('confirm-button'));
    const error = await screen.findByTestId('confirm-error');
    expect(error.textContent).toContain('kernel said no');
    expect(screen.getByTestId('confirm')).toBeTruthy();
  });
});

describe('kit/Confirm — irreversible', () => {
  it('opens a centred alert dialog; the danger button stays disabled until the name is retyped and acknowledged', async () => {
    const onConfirm = vi.fn(async () => undefined);
    renderTier('irreversible', {
      onConfirm,
      confirmLabel: '清除',
      target: 'acme-prod',
    });
    fireEvent.click(screen.getByTestId('trigger'));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.getAttribute('data-testid')).toBe('confirm');
    const button = screen.getByTestId('confirm-button');
    expect(button.hasAttribute('disabled')).toBe(true);

    fireEvent.change(screen.getByTestId('confirm-typed-name'), { target: { value: 'acme' } });
    fireEvent.click(screen.getByTestId('confirm-acknowledge'));
    expect(button.hasAttribute('disabled')).toBe(true);

    fireEvent.change(screen.getByTestId('confirm-typed-name'), { target: { value: 'acme-prod' } });
    expect(button.hasAttribute('disabled')).toBe(false);

    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByTestId('confirm')).toBeNull());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('with no target, only the acknowledgement gates the danger button (a batch with no single name)', async () => {
    renderTier('irreversible', { target: undefined });
    fireEvent.click(screen.getByTestId('trigger'));
    await screen.findByRole('alertdialog');
    expect(screen.queryByTestId('confirm-typed-name')).toBeNull();
    const button = screen.getByTestId('confirm-button');
    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByTestId('confirm-acknowledge'));
    expect(button.hasAttribute('disabled')).toBe(false);
  });

  it('Escape cancels; focus returns to the trigger', async () => {
    renderTier('irreversible');
    const trigger = screen.getByTestId('trigger');
    // See the same note in the medium-tier test above.
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('confirm')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('renders nothing while closed', () => {
    for (const tier of ['medium', 'irreversible'] as const) {
      const { container, unmount } = render(
        <Confirm
          tier={tier}
          open={false}
          onOpenChange={vi.fn()}
          anchor={<button type="button">t</button>}
          title="t"
          onConfirm={vi.fn()}
        />,
      );
      // Only the anchor renders while closed — no popover/dialog content.
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.queryByRole('alertdialog')).toBeNull();
      unmount();
      cleanup();
      container.remove();
    }
  });
});
