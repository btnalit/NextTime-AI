/**
 * kit/focus-origin: the element a closing drawer, dialog or confirm hands focus back to — what had
 * focus as it opened. A menu item that opened it unmounts with its menu, so an item inside a
 * `role="menu"` resolves to that menu's trigger (Radix labels the menu content with its trigger's
 * id); otherwise focus would land on <body> (#798 UX P3).
 */
export function focusOrigin(): HTMLElement | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body) return null;
  const triggerId = active.closest('[role="menu"]')?.getAttribute('aria-labelledby');
  const trigger = triggerId ? document.getElementById(triggerId) : null;
  return trigger ?? active;
}
