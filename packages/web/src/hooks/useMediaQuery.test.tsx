// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMediaQuery } from './useMediaQuery.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A minimal `matchMedia` mock: `matches` reflects the given initial state, and `trigger(matches)`
 *  fires every registered `change` listener — the shape `data-table.test.tsx` also uses. */
function mockMatchMedia(initial: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const mql = {
    matches: initial,
    media: '',
    addEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    }),
    removeEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    }),
  };
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => mql as unknown as MediaQueryList),
  );
  return {
    trigger(matches: boolean) {
      mql.matches = matches;
      for (const listener of listeners) listener({ matches } as MediaQueryListEvent);
    },
  };
}

describe('hooks/useMediaQuery', () => {
  it('reads the initial match state', () => {
    mockMatchMedia(true);
    const { result } = renderHook(() => useMediaQuery('(max-width: 768px)'));
    expect(result.current).toBe(true);
  });

  it('updates on a change event', () => {
    const { trigger } = mockMatchMedia(false);
    const { result } = renderHook(() => useMediaQuery('(max-width: 768px)'));
    expect(result.current).toBe(false);
    act(() => trigger(true));
    expect(result.current).toBe(true);
  });

  it('degrades to false when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined);
    const { result } = renderHook(() => useMediaQuery('(max-width: 768px)'));
    expect(result.current).toBe(false);
  });
});
