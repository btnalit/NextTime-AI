// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { TOAST_REGION_CLASS, isInToasts, markToastPointerDown } from './toast-region.js';

/** lib/toast-region (#1398 UX P2): a press in the toasts is known as such even once its target
 *  left the document — a toast's close removes the toast before Radix's deferred outside event. */
describe('isInToasts', () => {
  function region(): { region: HTMLElement; button: HTMLButtonElement } {
    const element = document.body.appendChild(document.createElement('section'));
    element.className = TOAST_REGION_CLASS;
    return { region: element, button: element.appendChild(document.createElement('button')) };
  }

  it('knows a target that is still inside the region', () => {
    const { region: element, button } = region();
    expect(isInToasts({ target: button })).toBe(true);
    expect(isInToasts({ target: document.body })).toBe(false);
    element.remove();
  });

  it('knows a press the region recorded, after its target was removed', () => {
    const { region: element, button } = region();
    const press = new Event('pointerdown');
    markToastPointerDown(press);
    button.remove();
    expect(isInToasts({ target: button })).toBe(false);
    expect(isInToasts({ target: button, detail: { originalEvent: press } })).toBe(true);
    // Another press, not recorded, with a detached target is outside as before.
    expect(
      isInToasts({ target: button, detail: { originalEvent: new Event('pointerdown') } }),
    ).toBe(false);
    element.remove();
  });
});
