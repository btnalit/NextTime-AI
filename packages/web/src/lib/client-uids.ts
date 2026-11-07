/**
 * lib/client-uids (legacy 662): the counters behind the client-only keys editors give their rows
 * (`step-3`, `binding-2`, `pred-7`, …). Each counter is unique within a page load, which was all
 * they needed until a draft could outlive the load (`lib/drafts.ts`): a form restored after a
 * reload carries keys from the earlier load while the counters start again at 0, and the next
 * row added could take a key a restored row already has. `reserveClientUidsIn` moves every
 * counter past the highest number a restored value carries, so it cannot.
 */

const counters: { value: number }[] = [];

/** A counter for one kind of key; `next()` is 1, 2, 3, … as before, unless a restore moved it. */
export function createUidCounter(): { next(): number } {
  const counter = { value: 0 };
  counters.push(counter);
  return {
    next() {
      counter.value += 1;
      return counter.value;
    },
  };
}

const KEY_SHAPE = /^[a-z][a-z-]*-(\d+)$/;

/** Legacy 667: no counter is moved past this. A key this module handed out never comes near it
 *  (one per row added in one page load), so a larger number is text that only looks like a key —
 *  and taking it would leave a counter where `+ 1` no longer changes the number
 *  (`Number.MAX_SAFE_INTEGER` and up), handing out the same key again and again. */
export const MAX_RESERVED_UID = 2 ** 31 - 1;

function highestKeyNumber(value: unknown, seen = 0): number {
  if (typeof value === 'string') {
    const match = KEY_SHAPE.exec(value);
    const n = match ? Number(match[1]) : Number.NaN;
    return n <= MAX_RESERVED_UID ? Math.max(seen, n) : seen;
  }
  if (Array.isArray(value))
    return value.reduce<number>((n, item) => highestKeyNumber(item, n), seen);
  if (value && typeof value === 'object') {
    return Object.values(value).reduce<number>((n, item) => highestKeyNumber(item, n), seen);
  }
  return seen;
}

/** Every counter moves past the highest key-shaped number in `value` (a restored draft). */
export function reserveClientUidsIn(value: unknown): void {
  const highest = highestKeyNumber(value);
  for (const counter of counters) counter.value = Math.max(counter.value, highest);
}
