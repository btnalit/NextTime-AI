// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    const close = view.getByRole('button', { name: 'Dismiss' });
    act(() => close.focus());
    act(() => vi.advanceTimersByTime(60_000));
    expect(view.getAllByTestId('toast')).toHaveLength(1);
    await act(async () => view.getByRole('button', { name: 'elsewhere' }).focus());
    act(() => vi.advanceTimersByTime(5_000));
    expect(view.queryAllByTestId('toast')).toHaveLength(0);
  });
});
