import { fireEvent, waitFor, within } from '@testing-library/react';

function listbox(input: HTMLElement): HTMLElement | null {
  const id = input.getAttribute('aria-controls');
  return id ? document.getElementById(id) : null;
}

/** Test helper for `kit/combobox`: the option rows `input`'s open list shows (label and secondary
 *  text). */
export function comboboxOptionTexts(input: HTMLElement): string[] {
  const list = listbox(input);
  if (!list) return [];
  return within(list)
    .queryAllByRole('option')
    .map((option) => option.textContent ?? '');
}

/** The values (`data-value`) of the option rows `input`'s open list shows. */
export function comboboxOptionValues(input: HTMLElement): string[] {
  const list = listbox(input);
  if (!list) return [];
  return within(list)
    .queryAllByRole('option')
    .map((option) => option.getAttribute('data-value') ?? '');
}

/** Opens `input`'s list if it is closed (ArrowDown, as a keyboard user would). */
export function openCombobox(input: HTMLElement): void {
  if (input.getAttribute('aria-expanded') !== 'true')
    fireEvent.keyDown(input, { key: 'ArrowDown' });
}

/** Opens `input`'s list (ArrowDown, as a keyboard user would) and waits until an option whose text
 *  contains `text` is there. Returns that option. */
export async function findComboboxOption(input: HTMLElement, text: string): Promise<HTMLElement> {
  openCombobox(input);
  return waitFor(() => {
    const list = listbox(input);
    const option = list
      ? within(list)
          .queryAllByRole('option')
          .find((candidate) => (candidate.textContent ?? '').includes(text))
      : undefined;
    if (!option) throw new Error(`no option containing "${text}"`);
    return option;
  });
}

/** Picks the option whose text contains `text` from `input`'s list. */
export async function pickComboboxOption(input: HTMLElement, text: string): Promise<void> {
  fireEvent.click(await findComboboxOption(input, text));
}
