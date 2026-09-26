// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, useToast } from './toast.js';

afterEach(cleanup);

function Pusher({ onReady }: { readonly onReady: (api: ReturnType<typeof useToast>) => void }) {
  const toast = useToast();
  onReady(toast);
  return null;
}

function renderWithProvider() {
  const holder: { api: ReturnType<typeof useToast> | null } = { api: null };
  render(
    <ToastProvider>
      <Pusher
        onReady={(toast) => {
          holder.api = toast;
        }}
      />
    </ToastProvider>,
  );
  return () => holder.api as ReturnType<typeof useToast>;
}

describe('kit/Toast', () => {
  it('useToast outside a provider is a harmless no-op', () => {
    const holder: { api: ReturnType<typeof useToast> | null } = { api: null };
    render(
      <Pusher
        onReady={(toast) => {
          holder.api = toast;
        }}
      />,
    );
    const api = holder.api as ReturnType<typeof useToast>;
    expect(() => api.push({ title: 'hi' })).not.toThrow();
    expect(api.dismiss(1)).toBeUndefined();
  });

  it('push renders a toast with title/description, and dismiss removes it', () => {
    const getApi = renderWithProvider();
    let id = 0;
    act(() => {
      id = getApi().push({ title: '已保存', description: '更改已生效。' });
    });
    expect(screen.getByText('已保存')).toBeTruthy();
    expect(screen.getByText('更改已生效。')).toBeTruthy();

    act(() => getApi().dismiss(id));
    expect(screen.queryByText('已保存')).toBeNull();
  });

  it('the dismiss (×) button removes its own toast', () => {
    const getApi = renderWithProvider();
    act(() => {
      getApi().push({ title: '出错了' });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('出错了')).toBeNull();
  });

  it('renders the action button and dismisses on click', () => {
    const onClick = vi.fn();
    const getApi = renderWithProvider();
    act(() => {
      getApi().push({ title: '已归档', action: { label: '撤销', onClick } });
    });
    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('已归档')).toBeNull();
  });

  it('auto-dismisses after durationMs, and 0 keeps it until dismissed', async () => {
    vi.useFakeTimers();
    try {
      const getApi = renderWithProvider();
      act(() => {
        getApi().push({ title: '短暂提示', durationMs: 1000 });
        getApi().push({ title: '常驻提示', durationMs: 0 });
      });
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.queryByText('短暂提示')).toBeNull();
      expect(screen.getByText('常驻提示')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a repeated key replaces the earlier toast instead of stacking a duplicate', () => {
    const getApi = renderWithProvider();
    act(() => {
      getApi().push({ title: '第一次', key: 'save' });
    });
    act(() => {
      getApi().push({ title: '第二次', key: 'save' });
    });
    expect(screen.queryByText('第一次')).toBeNull();
    expect(screen.getAllByTestId('toast')).toHaveLength(1);
    expect(screen.getByText('第二次')).toBeTruthy();
  });

  it('caps the stack at 5 toasts, dropping the oldest', () => {
    const getApi = renderWithProvider();
    act(() => {
      for (let i = 1; i <= 6; i += 1) getApi().push({ title: `toast-${i}` });
    });
    expect(screen.getAllByTestId('toast')).toHaveLength(5);
    expect(screen.queryByText('toast-1')).toBeNull();
    expect(screen.getByText('toast-6')).toBeTruthy();
  });
});
