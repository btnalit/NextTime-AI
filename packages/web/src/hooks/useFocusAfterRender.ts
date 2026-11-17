import { useCallback, useEffect, useRef } from 'react';

type Find = () => HTMLElement | null | undefined;

/**
 * hooks/useFocusAfterRender: a control the change it makes takes away (a button no longer needed,
 * a row removed, Remove turning into Restore) drops focus to `<body>` (UX P3-5 on #738, the class
 * of #705's P3-1). `focusAfterRender(find)` runs `find` once that change has rendered and moves
 * focus to what it returns: the control the change made, or the one now standing where it was.
 */
export function useFocusAfterRender(): (find: Find) => void {
  const pending = useRef<Find | null>(null);
  useEffect(() => {
    const find = pending.current;
    if (find === null) return;
    pending.current = null;
    find()?.focus();
  });
  return useCallback((find: Find) => {
    pending.current = find;
  }, []);
}

/** The first element under `root` whose `data-<name>` is `value` (no selector escaping needed). */
export function byData(
  root: ParentNode | null | undefined,
  selector: string,
  name: string,
  value: string,
): HTMLElement | undefined {
  if (!root) return undefined;
  return [...root.querySelectorAll<HTMLElement>(selector)].find((el) => el.dataset[name] === value);
}

/**
 * The first problem a refused form says under `root`, in reading order (legacy 776): the control
 * an error is said on (`<id>-error` names it), or, when no control is found, the error itself —
 * made focusable, so focus moving there brings it into view and has it read out.
 */
export function firstProblem(root: ParentNode | null | undefined): HTMLElement | undefined {
  const said = root?.querySelector<HTMLElement>('.field-error[role="alert"]');
  if (!said) return undefined;
  const control = said.id.endsWith('-error')
    ? document.getElementById(said.id.slice(0, -'-error'.length))
    : null;
  if (control !== null && root?.contains(control) && !control.hasAttribute('disabled')) {
    return control;
  }
  if (!said.hasAttribute('tabindex')) said.setAttribute('tabindex', '-1');
  return said;
}
