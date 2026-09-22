// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmTier } from './ConfirmTier.js';
import { ToastProvider } from './Toast.js';

afterEach(cleanup);

describe('ConfirmTier', () => {
  it('low: executes immediately, toasts with an undo action, then closes', async () => {
    const onConfirm = vi.fn(async () => undefined);
    const onUndo = vi.fn();
    const onClose = vi.fn();
    render(
      <ToastProvider>
        <ConfirmTier
          tier="low"
          open
          title="已归档 Archived"
          onConfirm={onConfirm}
          onClose={onClose}
          undo={{ onUndo }}
        />
      </ToastProvider>,
    );
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    const toast = await screen.findByTestId('toast');
    expect(toast.textContent).toContain('已归档 Archived');
    fireEvent.click(screen.getByRole('button', { name: '撤销 Undo' }));
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('medium: inline card, focus on confirm, Escape cancels, confirm awaits and closes', async () => {
    let resolve: () => void = () => undefined;
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    const onClose = vi.fn();
    render(
      <ConfirmTier
        tier="medium"
        open
        title="批准 Approve"
        target="docker.container_stop"
        onConfirm={onConfirm}
        onClose={onClose}
        testId="confirm"
      />,
    );
    const card = screen.getByTestId('confirm');
    expect(card.getAttribute('data-tier')).toBe('medium');
    expect(screen.getByTestId('confirm-target').textContent).toBe('docker.container_stop');
    const confirm = screen.getByTestId('confirm-button');
    expect(document.activeElement).toBe(confirm);
    fireEvent.keyDown(card, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(confirm.getAttribute('aria-busy')).toBe('true');
    resolve();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
  });

  it('medium: a thrown error is shown inline and the card stays open', async () => {
    const onClose = vi.fn();
    render(
      <ConfirmTier
        tier="medium"
        open
        title="x"
        onConfirm={async () => {
          throw new Error('kernel said no');
        }}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByTestId('confirm-button'));
    const error = await screen.findByTestId('confirm-error');
    expect(error.textContent).toContain('kernel said no');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('high: opens the drawer dialog listing the impact; Escape closes and focus returns', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const onClose = vi.fn();
    render(
      <ConfirmTier
        tier="high"
        open
        title="批准高影响动作"
        impact={['3 containers', '1 volume']}
        onConfirm={vi.fn()}
        onClose={onClose}
        testId="confirm"
      />,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('data-testid')).toBe('confirm');
    const impact = screen.getByTestId('confirm-impact');
    expect(impact.querySelectorAll('li')).toHaveLength(2);
    expect(screen.getByTestId('confirm-button').hasAttribute('disabled')).toBe(false);
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    cleanup();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('irreversible: the danger button stays disabled until the name is retyped and acknowledged', async () => {
    const onConfirm = vi.fn(async () => undefined);
    const onClose = vi.fn();
    render(
      <ConfirmTier
        tier="irreversible"
        open
        title="清除工作区 Purge workspace"
        target="acme-prod"
        confirmLabel="清除 Purge"
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );
    const button = screen.getByTestId('confirm-button');
    expect(button.className).toContain('btn-danger');
    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByTestId('confirm-typed-name'), { target: { value: 'acme' } });
    fireEvent.click(screen.getByTestId('confirm-acknowledge'));
    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByTestId('confirm-typed-name'), { target: { value: 'acme-prod' } });
    expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('renders nothing while closed (medium / high / irreversible)', () => {
    for (const tier of ['medium', 'high', 'irreversible'] as const) {
      const { container, unmount } = render(
        <ConfirmTier tier={tier} open={false} title="t" onConfirm={vi.fn()} onClose={vi.fn()} />,
      );
      expect(container.innerHTML).toBe('');
      unmount();
    }
  });
});
