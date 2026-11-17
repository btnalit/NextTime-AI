/**
 * lib/toast-region (#1398 UX P2): the toast region (`components/ui/Toast`) sits outside every
 * drawer, dialog and popover; a click or focus there (a toast's 「技术细节」, its close) is not an
 * outside interaction that closes one or asks to discard it.
 *
 * The element alone does not tell: Radix defers a mouse press's `pointerDownOutside` to the click
 * that follows, and a toast's close has already removed the toast by then, so its target is out
 * of the document. The region records each pointerdown it sees; the outside event carries that
 * pointerdown as `detail.originalEvent`.
 */
const pressedInToasts = new WeakSet<Event>();

export const TOAST_REGION_CLASS = 'toast-region';

/** The region's capture-phase pointerdown: remembered so the outside event it becomes is known. */
export function markToastPointerDown(event: Event): void {
  pressedInToasts.add(event);
}

/** A Radix outside event (`onInteractOutside`, `onPointerDownOutside`, `onFocusOutside`). */
export interface OutsideEventLike {
  readonly target: EventTarget | null;
  readonly detail?: { readonly originalEvent?: Event } | null;
}

export function isInToasts(event: OutsideEventLike): boolean {
  const original = event.detail?.originalEvent;
  if (original !== undefined && pressedInToasts.has(original)) return true;
  return event.target instanceof Element && event.target.closest(`.${TOAST_REGION_CLASS}`) !== null;
}
