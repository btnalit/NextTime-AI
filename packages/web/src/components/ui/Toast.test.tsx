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
});
