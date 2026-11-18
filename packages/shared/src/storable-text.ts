/**
 * Legacy 320: text Postgres cannot store. A `text` / `text[]` value holding U+0000 fails with
 * SQLSTATE 22021, a `jsonb` value whose JSON carries `\u0000` (a string or a key) fails with 22P05 —
 * and either fails the whole transaction it is in, whatever else that transaction wrote.
 *
 * Legacy 834: so does an unpaired surrogate (half of a pair, as a cut through an emoji leaves) in
 * `jsonb`. A `text` value is sent as UTF-8, whose encoder already stores such a half as U+FFFD; a
 * `jsonb` value is sent as `JSON.stringify` output, which writes it as `\udXXX`, and Postgres
 * refuses that escape (22P02). Every other code point stores as given.
 *
 * Two answers, chosen by what the string is (the kernel's boundaries pick, see `dispatch.ts`):
 *   - an identity, a reference, a name, a setting — something compared or acted on: the call is
 *     refused (`findUnstorableText` names where), because a stored stand-in would be a different
 *     name than the one asked for;
 *   - content already produced elsewhere (a model's report, a gate's output, observed data): the
 *     character is stored as a stand-in (`storableValue`), and the count is recorded, because
 *     refusing would lose work that cannot be asked for again. U+0000 is stored as the visible text
 *     `\u{0}` — the form `echoed-text.ts` shows the same character in, so a reader sees one spelling
 *     everywhere; an unpaired surrogate as U+FFFD, what the same text stores as in a `text` column.
 *
 * Legacy 837: `findUnstorableText` finds an unpaired surrogate as it finds U+0000, so a string that
 * is compared or acted on is refused for either. Before, only U+0000 was refused: on the dispatch
 * path a parameter that went only to a `text` column was stored as U+FFFD — a different name than
 * the one asked for, as above — and one a handler wrote to `jsonb` itself failed the call (22P02) as
 * a bare 500, its audit row with it. `UnstorableTextError` says which of the two it found
 * (`details.character`).
 */

import { boundedEcho, quotedName } from './echoed-text.js';

/** The one character Postgres `text` / `jsonb` refuses. */
export const UNSTORABLE_CHAR = '\u0000';

/** What U+0000 is stored as where it is escaped — `echoed-text.ts`'s visible form of it. */
export const UNSTORABLE_CHAR_STAND_IN = '\\u{0}';

/** What an unpaired surrogate is stored as where it is replaced (legacy 834): U+FFFD, as UTF-8
 *  stores it in a `text` column. */
export const LONE_SURROGATE_STAND_IN = '\ufffd';

/** A high surrogate not followed by a low one, or a low one not preceded by a high one. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** `LONE_SURROGATE` without the global flag, for a `test` that keeps no `lastIndex`. */
const HAS_LONE_SURROGATE = new RegExp(LONE_SURROGATE.source);

/** Which character Postgres cannot store a refusal found: U+0000, or half of a surrogate pair
 *  (legacy 837). */
export type UnstorableCharacter = 'nul' | 'lone_surrogate';

/** Where the first unstorable character sits: the path of keys / indices down to the string,
 *  whether it is in a key or in a value, and which character it is (U+0000 when a string holds
 *  both). */
export interface UnstorableTextLocation {
  readonly path: readonly (string | number)[];
  readonly in: 'key' | 'value';
  readonly character: UnstorableCharacter;
}

/** The character of `text` Postgres cannot store, U+0000 first; `undefined` when there is none. */
function unstorableCharacterIn(text: string): UnstorableCharacter | undefined {
  if (text.includes(UNSTORABLE_CHAR)) return 'nul';
  return HAS_LONE_SURROGATE.test(text) ? 'lone_surrogate' : undefined;
}

/** The first U+0000 or unpaired surrogate (legacy 837) in `value` — in a string, or in an object
 *  key — walking objects and arrays depth first in property order; `undefined` when there is
 *  none. */
export function findUnstorableText(
  value: unknown,
  path: readonly (string | number)[] = [],
): UnstorableTextLocation | undefined {
  if (typeof value === 'string') {
    const character = unstorableCharacterIn(value);
    return character === undefined ? undefined : { path, in: 'value', character };
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
      const character = unstorableCharacterIn(key);
      if (character !== undefined) return { path: [...path, key], in: 'key', character };
      const found = findUnstorableText(item, [...path, key]);
      if (found) return found;
    }
  }
  return undefined;
}

/** How a refusal names `character` in running text: `UnstorableTextError`'s message, and a
 *  refused proposal's detail (`report_task_result`). The console finds the place it names by the
 *  words right after it (`holds U+0000`, `holds an unpaired surrogate`). */
export function unstorableCharacterName(character: UnstorableCharacter): string {
  return character === 'nul'
    ? 'U+0000 (NUL)'
    : 'an unpaired surrogate (half of a character such as an emoji)';
}

/** How many characters of `text` `storableText` replaces. */
function unstorableCount(text: string): number {
  const nul = text.includes(UNSTORABLE_CHAR) ? text.split(UNSTORABLE_CHAR).length - 1 : 0;
  return nul + (text.match(LONE_SURROGATE)?.length ?? 0);
}

/** `text` with every U+0000 stored as `\u{0}` and every unpaired surrogate as U+FFFD (legacy
 *  834); nothing else changes. */
export function storableText(text: string): string {
  const escaped = text.includes(UNSTORABLE_CHAR)
    ? text.split(UNSTORABLE_CHAR).join(UNSTORABLE_CHAR_STAND_IN)
    : text;
  return escaped.replace(LONE_SURROGATE, LONE_SURROGATE_STAND_IN);
}

/** `text.slice(0, end)`, or one character shorter where that would cut a surrogate pair in two —
 *  a cut that leaves no half of an emoji for `storableText` to replace (legacy 834). */
export function sliceKeepingPairs(text: string, end: number): string {
  const at = Math.max(0, Math.min(end, text.length));
  const high = text.charCodeAt(at - 1);
  const low = text.charCodeAt(at);
  const splitsPair = high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
  return text.slice(0, splitsPair ? at - 1 : at);
}

/**
 * `value` with every U+0000 in its strings and object keys stored as `\u{0}` and every unpaired
 * surrogate as U+FFFD (`storableText`), and how many characters were replaced. Objects and
 * arrays are copied only along a path that changed; a value with nothing to replace is returned
 * as is. Two keys that differ only by U+0000 versus a literal `\u{0}` (or an unpaired surrogate
 * versus U+FFFD) would meet after escaping — the later one wins, as in `JSON.parse`, and the count
 * still says that the value was altered.
 */
export function storableValue<T>(value: T): { readonly value: T; readonly escaped: number } {
  let escaped = 0;
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const n = unstorableCount(node);
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
        const keyCount = unstorableCount(key);
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
 * Legacy 320: input refused because a string or key that is compared or acted on holds U+0000 —
 * or, legacy 837, an unpaired surrogate. Nothing was written. Code `unstorable_text` (HTTP 400);
 * `details.path` is the keys and indices down to the string, each key echoed visibly,
 * `details.in` whether it sat in a key or a value, `details.character` which of the two it holds.
 * `subject` says whose input it was, e.g. `capability "create_task"`.
 */
export class UnstorableTextError extends Error {
  readonly code = 'unstorable_text' as const;
  readonly details: {
    readonly path: readonly (string | number)[];
    readonly in: UnstorableTextLocation['in'];
    readonly character: UnstorableCharacter;
  };
  constructor(subject: string, location: UnstorableTextLocation, noun = 'params') {
    const where =
      location.path.length === 0 ? `the ${noun}` : `${noun} ${quotedName(location.path.join('.'))}`;
    const path = location.path.map((step) => (typeof step === 'string' ? boundedEcho(step) : step));
    const fix =
      location.character === 'nul'
        ? 'send it again without that character'
        : 'send it again with the whole character, or without it';
    super(
      `${subject}: the ${location.in === 'key' ? 'key' : 'text'} at ${where} holds ${unstorableCharacterName(location.character)}, which cannot be stored — nothing was written; ${fix}`,
    );
    this.name = 'UnstorableTextError';
    this.details = { path, in: location.in, character: location.character };
  }
}
