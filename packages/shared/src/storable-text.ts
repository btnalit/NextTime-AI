/**
 * Legacy 320: text Postgres cannot store. A `text` / `text[]` value holding U+0000 fails with
 * SQLSTATE 22021, a `jsonb` value whose JSON carries `\u0000` (a string or a key) fails with 22P05 —
 * and either fails the whole transaction it is in, whatever else that transaction wrote. Every other
 * code point stores as given (a lone surrogate is already replaced by the UTF-8 encoder), so U+0000
 * is the one character the kernel has to settle before a write.
 *
 * Two answers, chosen by what the string is (the kernel's boundaries pick, see `dispatch.ts`):
 *   - an identity, a reference, a name, a setting — something compared or acted on: the call is
 *     refused (`findUnstorableText` names where), because a stored stand-in would be a different
 *     name than the one asked for;
 *   - content already produced elsewhere (a model's report, a gate's output, observed data): the
 *     character is stored as the visible text `\u{0}` (`storableValue`), and the count is recorded,
 *     because refusing would lose work that cannot be asked for again. `\u{0}` is the form
 *     `echoed-text.ts` shows the same character in, so a reader sees one spelling everywhere.
 */

import { boundedEcho, quotedName } from './echoed-text.js';

/** The one character Postgres `text` / `jsonb` refuses. */
export const UNSTORABLE_CHAR = '\u0000';

/** What U+0000 is stored as where it is escaped — `echoed-text.ts`'s visible form of it. */
export const UNSTORABLE_CHAR_STAND_IN = '\\u{0}';

/** Where the first unstorable character sits: the path of keys / indices down to the string, and
 *  whether it is in a key or in a value. */
export interface UnstorableTextLocation {
  readonly path: readonly (string | number)[];
  readonly in: 'key' | 'value';
}

/** The first U+0000 in `value` — in a string, or in an object key — walking objects and arrays
 *  depth first in property order; `undefined` when there is none. */
export function findUnstorableText(
  value: unknown,
  path: readonly (string | number)[] = [],
): UnstorableTextLocation | undefined {
  if (typeof value === 'string') {
    return value.includes(UNSTORABLE_CHAR) ? { path, in: 'value' } : undefined;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findUnstorableText(item, [...path, index]);
      if (found) return found;
    }
    return undefined;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key.includes(UNSTORABLE_CHAR)) return { path: [...path, key], in: 'key' };
      const found = findUnstorableText(item, [...path, key]);
      if (found) return found;
    }
  }
  return undefined;
}

/** `text` with every U+0000 stored as `\u{0}`; nothing else changes. */
export function storableText(text: string): string {
  return text.includes(UNSTORABLE_CHAR)
    ? text.split(UNSTORABLE_CHAR).join(UNSTORABLE_CHAR_STAND_IN)
    : text;
}

/**
 * `value` with every U+0000 in its strings and object keys stored as `\u{0}`, and how many were
 * replaced. Objects and arrays are copied only along a path that changed; a value with nothing to
 * replace is returned as is. Two keys that differ only by U+0000 versus a literal `\u{0}` would
 * meet after escaping — the later one wins, as in `JSON.parse`, and the count still says that the
 * value was altered.
 */
export function storableValue<T>(value: T): { readonly value: T; readonly escaped: number } {
  let escaped = 0;
  const countIn = (text: string): number => text.split(UNSTORABLE_CHAR).length - 1;
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const n = countIn(node);
      if (n === 0) return node;
      escaped += n;
      return storableText(node);
    }
    if (Array.isArray(node)) {
      let changed = false;
      const out = node.map((item) => {
        const next = walk(item);
        if (next !== item) changed = true;
        return next;
      });
      return changed ? out : node;
    }
    if (node !== null && typeof node === 'object') {
      let changed = false;
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(node)) {
        const keyCount = countIn(key);
        const nextKey = keyCount === 0 ? key : storableText(key);
        escaped += keyCount;
        const next = walk(item);
        if (next !== item || nextKey !== key) changed = true;
        out[nextKey] = next;
      }
      return changed ? out : node;
    }
    return node;
  };
  const next = walk(value) as T;
  return { value: next, escaped };
}

/**
 * Legacy 320: input refused because a string or key that is compared or acted on holds U+0000.
 * Nothing was written. Code `unstorable_text` (HTTP 400); `details.path` is the keys and indices
 * down to the string, each key echoed visibly, `details.in` whether it sat in a key or a value.
 * `subject` says whose input it was, e.g. `capability "create_task"`.
 */
export class UnstorableTextError extends Error {
  readonly code = 'unstorable_text' as const;
  readonly details: {
    readonly path: readonly (string | number)[];
    readonly in: UnstorableTextLocation['in'];
  };
  constructor(subject: string, location: UnstorableTextLocation, noun = 'params') {
    const where =
      location.path.length === 0 ? `the ${noun}` : `${noun} ${quotedName(location.path.join('.'))}`;
    const path = location.path.map((step) => (typeof step === 'string' ? boundedEcho(step) : step));
    super(
      `${subject}: the ${location.in === 'key' ? 'key' : 'text'} at ${where} holds U+0000 (NUL), which cannot be stored — nothing was written; send it again without that character`,
    );
    this.name = 'UnstorableTextError';
    this.details = { path, in: location.in };
  }
}
