import { type RefObject, useEffect, useRef } from 'react';

/**
 * hooks/useFocusWhenLost: a form whose controls are disabled while it runs drops focus to `<body>`
 * (UX P3 on #724, the class of legacy 424). When `outcome` arrives (an error or a result, non-null)
 * and focus is nowhere, it moves to the element `ref` is on — give it `tabIndex={-1}`. Focus the
 * person moved elsewhere meanwhile is left where it is.
 */
export function useFocusWhenLost<T extends HTMLElement>(outcome: unknown): RefObject<T> {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (outcome === null || outcome === undefined) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    ref.current?.focus();
  }, [outcome]);
  return ref;
}

/**
 * Legacy 488: the same for a control that a change of `key` takes away (Publish once published,
 * Deprecate once deprecated, a closed detail's own buttons): when `key` changes — not on mount —
 * and focus is nowhere, it moves to what `find` returns. Focus the person moved elsewhere is left
 * where it is. A `null` key is a state still settling (a list reloading): it is skipped, so the
 * change is judged once what replaces the control has rendered.
 */
export function useFocusWhenKeyLost(
  key: string | null,
  find: () => HTMLElement | null | undefined,
): void {
  const last = useRef(key);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new `key` moves focus.
  useEffect(() => {
    if (key === null) return;
    if (last.current === null) {
      last.current = key;
      return;
    }
    if (last.current === key) return;
    last.current = key;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    find()?.focus();
  }, [key]);
}
