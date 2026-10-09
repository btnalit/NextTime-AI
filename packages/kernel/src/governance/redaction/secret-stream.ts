import {
  JSON_SECRET_PAIR,
  REDACTED,
  SECRET_FIELD_NAME,
  SECRET_VALUE_PATTERNS,
  type Scrubbed,
  namesASecretValue,
  scrubSecretValues,
  secretMatches,
} from './secret-values.js';

/**
 * governance/redaction/secret-stream: `scrubSecretValues` for text that arrives in pieces — a
 * Turn's live `textDelta`s. A secret split across two deltas matches in neither, so scrubbing each
 * delta on its own lets a Handle through. Instead the scrubber holds back the end of what it has
 * seen for as long as that end could still be, or become, part of a secret, and emits the rest
 * scrubbed.
 *
 * What is held back is everything from the earliest of:
 *   - the trailing run of characters a secret can be made of (anything but whitespace and CJK
 *     text — so Chinese prose, which has no spaces, is not held back sentence by sentence);
 *   - a `Bearer`/`Basic` scheme word just before that run (its value is the next token);
 *   - on the last line, a secret's name whose separator or value has not all arrived, spaces
 *     included (`token `, `password : `, `"api key" `, `--password `, `NAME="a b`,
 *     `"api_key": "x y`). The quote that opens such a value is found from the separator before
 *     it, never by pairing quotes up: a stray `"` or an apostrophe earlier on the line would
 *     pair them wrong;
 *   - the last `"` on the last line, while what follows it can still become a JSON key (128
 *     characters, no backslash) — unless it closes a secret's JSON pair;
 *   - a `-----BEGIN` with no `-----END` after it;
 *   - any match of a secret pattern that crosses that point or reaches the end of the text (it may
 *     still grow — a `NAME=value` whose value goes on in the next delta).
 * The text before that point holds only whole matches, so scrubbing it on its own gives what
 * scrubbing the whole text would: the concatenated output equals `scrubSecretValues` of the whole
 * text. The unit test checks this for every pattern, separator and quoting, split in two at every
 * offset, in three at every pair of offsets, and in random pieces. The exception is a secret with
 * CJK characters inside it, which is not held back across them.
 *
 * Bounded: at most `STREAM_HOLD_MAX_CHARS` are held. Past it the held text is dropped — one
 * `[redacted]` is emitted in its place — and nothing more is streamed until the next flush: the
 * stored message replaces the streamed text when it arrives, so nothing is lost but liveness. A
 * piece is taken in slices of at most `PIECE_SLICE_CHARS`, so the work per call stays linear in
 * the piece whatever its size. Each piece rescans what is held, so many tiny deltas cost the held
 * length each — 200 KB of adversarial text in 8-character deltas takes a few hundred ms.
 */

/** The most a stream holds back while waiting to see whether its end is a secret — above a PEM
 *  RSA-4096 private key (~3.3k characters) and a Handle. */
export const STREAM_HOLD_MAX_CHARS = 4_096;
const PIECE_SLICE_CHARS = 16_384;

/** Whitespace, or CJK text and full-width punctuation — characters no secret pattern needs to see
 *  across (a secret's characters are base64, hex and ASCII punctuation). */
const BREAKS_A_SECRET_RUN = /[\s\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/;

const SCHEME_WORD_BEFORE = /(?:^|[^A-Za-z0-9_])(bearer|basic)$/i;

/** A name at the end of a short slice, with as much of a separator as has arrived: `password`
 *  followed by `: `, `=`, ` ` (a `--flag`'s separator, or the space before a `:` or `=` still to
 *  come), or ` = `. */
const NAME_AND_SEPARATOR_AT_END =
  /(?<![A-Za-z0-9_.-])(--)?([A-Za-z][A-Za-z0-9_.-]{0,63})(["']?)([ \t]{0,8}[:=][ \t]{0,8}|[ \t]{1,8})$/;
/** A quoted JSON key at the end of a short slice, with as much of its colon as has arrived:
 *  `"api key"`, `"api key" `, `"api key": `. */
const JSON_KEY_AND_COLON_AT_END = /"([^"\\\r\n]{1,128})"[ \t]{0,8}(?::[ \t]{0,8})?$/;
/** The longest JSON key the JSON pattern matches (`[^"\\\r\n]{1,128}`). */
const JSON_KEY_MAX_CHARS = 128;

/** Where in `before` — the line up to a value that has not arrived or ended — a secret's name
 *  starts, or `undefined` when what precedes names no secret. A name whose separator has not
 *  arrived yet counts: `token ` may still become `token = value`. */
function secretNameStart(before: string): number | undefined {
  const slice = before.slice(-160);
  const offset = before.length - slice.length;
  const jsonKey = JSON_KEY_AND_COLON_AT_END.exec(slice);
  if (jsonKey?.[1] !== undefined && SECRET_FIELD_NAME.test(jsonKey[1])) {
    return offset + jsonKey.index;
  }
  const named = NAME_AND_SEPARATOR_AT_END.exec(slice);
  const name = named?.[2];
  if (named === null || name === undefined) return undefined;
  const quotedKey = named[3] !== '';
  return namesASecretValue(name) || (quotedKey && SECRET_FIELD_NAME.test(name))
    ? offset + named.index
    : undefined;
}

/** Whether `text` — what follows the last `"` on the last line — can still turn out to be a JSON
 *  key (`"client secret": …` names a secret only once the key is closed, and its words may arrive
 *  in separate deltas). Any `"` can open one — quote parity is no guide in prose — except the `"`
 *  that closes a secret's JSON pair, which that pair has taken. */
function couldBeJsonKey(text: string): boolean {
  return text.length <= JSON_KEY_MAX_CHARS && !/[\\\r]/.test(text);
}

/** Where on `line` a value whose closing quote has not arrived could start: after the last `"`
 *  (a quoted value in `name="…"`, `--flag "…"`, which knows no escapes), the last `"` no backslash
 *  escapes (a JSON string), or the last `'`. No quote parity: which quote opens a value is up to the
 *  separator before it, so a stray quote in prose earlier on the line must not hide one. */
function openValueStarts(line: string): number[] {
  let unescaped = line.lastIndexOf('"');
  while (unescaped > 0 && escapedAt(line, unescaped))
    unescaped = line.lastIndexOf('"', unescaped - 1);
  return [line.lastIndexOf('"'), unescaped, line.lastIndexOf("'")].filter((at) => at !== -1);
}

/** Whether the character at `index` follows an odd run of backslashes. */
function escapedAt(text: string, index: number): boolean {
  let backslashes = 0;
  while (index - backslashes > 0 && text.charAt(index - backslashes - 1) === '\\') backslashes += 1;
  return backslashes % 2 === 1;
}

/** Where the text that is safe to emit ends — everything from here on is held back. */
function safeCut(raw: string): number {
  let cut = raw.length;
  while (cut > 0 && !BREAKS_A_SECRET_RUN.test(raw.charAt(cut - 1))) cut -= 1;

  let beforeSpace = cut;
  while (beforeSpace > 0 && /\s/.test(raw.charAt(beforeSpace - 1))) beforeSpace -= 1;
  if (beforeSpace < cut) {
    const scheme = SCHEME_WORD_BEFORE.exec(raw.slice(Math.max(0, beforeSpace - 7), beforeSpace));
    if (scheme?.[1] !== undefined) cut = beforeSpace - scheme[1].length;
  }

  // On the last line: a secret's name whose separator or value has not arrived, or whose quoted
  // value has not been closed; and a quoted string that may still turn out to be a JSON key.
  const lineFrom = raw.lastIndexOf('\n') + 1;
  const line = raw.slice(lineFrom);
  for (const valueAt of [...openValueStarts(line), line.length]) {
    const nameAt = secretNameStart(line.slice(0, valueAt));
    if (nameAt !== undefined) cut = Math.min(cut, lineFrom + nameAt);
  }
  const lastQuote = line.lastIndexOf('"');
  if (
    lastQuote !== -1 &&
    couldBeJsonKey(line.slice(lastQuote + 1)) &&
    !secretMatches(JSON_SECRET_PAIR, line).some(({ end }) => end === lastQuote + 1)
  ) {
    cut = Math.min(cut, lineFrom + lastQuote);
  }

  const begin = raw.lastIndexOf('-----BEGIN');
  if (begin !== -1 && raw.indexOf('-----END', begin) === -1) cut = Math.min(cut, begin);

  for (let moved = true; moved; ) {
    moved = false;
    for (const valuePattern of SECRET_VALUE_PATTERNS) {
      for (const { start, end } of secretMatches(valuePattern, raw)) {
        if (start < cut && (end > cut || end === raw.length)) {
          cut = start;
          moved = true;
        }
      }
    }
  }
  return cut;
}

export interface SecretStreamScrubber {
  /** Takes the next piece of text; returns the scrubbed text now safe to emit — often `''`. */
  push(piece: string): Scrubbed<string>;
  /** The text ended: returns what was held back, scrubbed. The scrubber starts over afterwards. */
  flush(): Scrubbed<string>;
}

export function createSecretStreamScrubber(): SecretStreamScrubber {
  let held = '';
  let dropping = false;

  function take(slice: string): Scrubbed<string> {
    held += slice;
    const cut = safeCut(held);
    if (held.length - cut > STREAM_HOLD_MAX_CHARS) {
      const before = scrubSecretValues(held.slice(0, cut));
      held = '';
      dropping = true;
      return { value: before.value + REDACTED, redactedValues: before.redactedValues + 1 };
    }
    if (cut === 0) return { value: '', redactedValues: 0 };
    const out = scrubSecretValues(held.slice(0, cut));
    held = held.slice(cut);
    return out;
  }

  return {
    push(piece) {
      let value = '';
      let redactedValues = 0;
      for (let at = 0; at < piece.length && !dropping; at += PIECE_SLICE_CHARS) {
        const out = take(piece.slice(at, at + PIECE_SLICE_CHARS));
        value += out.value;
        redactedValues += out.redactedValues;
      }
      return { value, redactedValues };
    },
    flush() {
      const out = dropping ? { value: '', redactedValues: 0 } : scrubSecretValues(held);
      held = '';
      dropping = false;
      return out;
    },
  };
}
