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
