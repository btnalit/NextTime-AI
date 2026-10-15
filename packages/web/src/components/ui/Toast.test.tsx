// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, useToast } from './Toast.js';

function PushOnMount() {
  const toast = useToast();
  useEffect(() => {
    toast.push({ title: 'saved' });
  }, [toast]);
  return null;
}

describe('ToastProvider', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

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
});
