import {
  ESCAPED_JSON_SECRET_PAIR,
  JSON_SECRET_PAIR,
  REDACTED,
  SECRET_VALUE_PATTERNS,
  type Scrubbed,
  endsAQuotedValue,
  namesASecretField,
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
 * `[redacted]` is emitted in its place, and that piece says it `paused` (legacy 162) — and nothing
 * more is streamed until the next flush: the stored message replaces the streamed text when it
 * arrives, so nothing is lost but liveness. A
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
/** What the `--flag` and env-line rules of `secret-values.ts` take for a name where the one above
 *  does not, with what they read as its separator: a flag after `.`, `_` or a quote
 *  (`say "hi".--password …`), and an env name of up to 128 characters, after `.` or `-` too
 *  (`"hi".API_TOKEN=…`). Each as the rule's own boundary has it — or the value it hides streamed
 *  out before it was whole (legacy 925). */
const FLAG_AND_SEPARATOR_AT_END =
  /(?<![A-Za-z0-9-])--([A-Za-z][A-Za-z0-9-]{0,63})(?:=|[ \t]{1,8})$/;
const ENV_NAME_AND_EQUALS_AT_END = /(?<![A-Za-z0-9_])([A-Z][A-Z0-9_]{0,127})=$/;
/** A quoted JSON key at the end of a short slice, with as much of its colon as has arrived:
 *  `"api key"`, `"api key" `, `"api key": `. */
const JSON_KEY_AND_COLON_AT_END = /"([^"\\\r\n]{1,128})"[ \t]{0,8}(?::[ \t]{0,8})?$/;
/** The same, of JSON text written inside one more string (`ESCAPED_JSON_SECRET_PAIR`), whose
 *  separator may be `=` as well: `\"api key\"`, `\"api key\": `, `\"Password\" = `. */
const ESCAPED_JSON_KEY_AND_COLON_AT_END = /\\"([^"\\\r\n]{1,128})\\"[ \t]{0,8}(?:[:=][ \t]{0,8})?$/;
/** The longest JSON key the JSON pattern matches (`[^"\\\r\n]{1,128}`). */
const JSON_KEY_MAX_CHARS = 128;

/** Where in `before` — the line up to a value that has not arrived or ended — a secret's name
 *  starts, or `undefined` when what precedes names no secret. A name whose separator has not
 *  arrived yet counts: `token ` may still become `token = value`. */
function secretNameStart(before: string): number | undefined {
  const slice = before.slice(-160);
  const offset = before.length - slice.length;
  const jsonKey =
    JSON_KEY_AND_COLON_AT_END.exec(slice) ?? ESCAPED_JSON_KEY_AND_COLON_AT_END.exec(slice);
  if (jsonKey?.[1] !== undefined && namesASecretField(jsonKey[1])) {
    return offset + jsonKey.index;
  }
  const named = NAME_AND_SEPARATOR_AT_END.exec(slice);
  const name = named?.[2];
  if (named !== null && name !== undefined) {
    const quotedKey = named[3] !== '';
    if (namesASecretValue(name) || (quotedKey && namesASecretField(name))) {
      return offset + named.index;
    }
  }
  for (const pattern of [FLAG_AND_SEPARATOR_AT_END, ENV_NAME_AND_EQUALS_AT_END]) {
    const at = pattern.exec(slice);
    if (at?.[1] !== undefined && namesASecretValue(at[1])) return offset + at.index;
  }
  return undefined;
}

/** Whether `text` — what follows the last `"` on the last line — can still turn out to be a JSON
 *  key (`"client secret": …` names a secret only once the key is closed, and its words may arrive
 *  in separate deltas). Any `"` can open one — quote parity is no guide in prose — except the `"`
 *  that closes a secret's JSON pair, which that pair has taken. No backslash in it, but at its
 *  end: the `\` of the `\"` that closes a key of JSON text written inside a string
 *  (`\"client secret\"`) may arrive before its quote. */
function couldBeJsonKey(text: string): boolean {
  return (
    text.length <= JSON_KEY_MAX_CHARS &&
    !/[\\\r]/.test(text.slice(0, text.length - backslashesBefore(text, text.length)))
  );
}

/** Where on `line` a value whose closing quote has not arrived could start:
 *   - after the last `"` (a quoted value in `name="…"`, `--flag "…"`, which knows no escapes);
 *   - the last `"` no backslash escapes (a JSON string);
 *   - the last `'`;
 *   - the backslashes before the last `"` they escape: a quoted value written inside a string,
 *     `API_TOKEN=\"…\"` or `API_TOKEN=\\\"…\\\"`, which the same run closes;
 *   - the last `\"` that opens a string of JSON text written inside one more, `\"api_key\": \"…`
 *     (a quote of that string's own text is written `\\\"`; review #501 on #1575);
 *   - the backslashes that end the line, the quote of such a value still to come.
 *  No quote parity: which quote opens a value is up to the separator before it, so a stray quote
 *  in prose earlier on the line must not hide one. */
function openValueStarts(line: string): number[] {
  let unescaped = line.lastIndexOf('"');
  while (unescaped > 0 && backslashesBefore(line, unescaped) % 2 === 1)
    unescaped = line.lastIndexOf('"', unescaped - 1);
  let escapedString = line.lastIndexOf('"');
  while (escapedString > 0 && backslashesBefore(line, escapedString) % 4 !== 1)
    escapedString = line.lastIndexOf('"', escapedString - 1);
  const escaped = line.lastIndexOf('\\"') + 1;
  const trailing = backslashesBefore(line, line.length);
  return [
    line.lastIndexOf('"'),
    unescaped,
    line.lastIndexOf("'"),
    escaped > 0 ? escaped - backslashesBefore(line, escaped) : -1,
    escapedString > 0 ? escapedString - 1 : -1,
    trailing > 0 ? line.length - trailing : -1,
  ].filter((at) => at !== -1);
}

/** How many backslashes stand right before `index`. */
function backslashesBefore(text: string, index: number): number {
  let backslashes = 0;
  while (index - backslashes > 0 && text.charAt(index - backslashes - 1) === '\\') backslashes += 1;
  return backslashes;
}

/** A `"` and the blanks after it, as far as `NOT_A_KEYS_QUOTE` looks for a `:` or `=`. */
const BLANKS_AFTER_A_QUOTE = /"[ \t]{1,8}$/;

/** Where the text that is safe to emit ends — everything from here on is held back. `context` is
 *  the end of what was emitted before `raw`, which the patterns look back into (`CONTEXT_CHARS`). */
function safeCut(raw: string, context: string): number {
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
    ![JSON_SECRET_PAIR, ESCAPED_JSON_SECRET_PAIR].some((pair) =>
      secretMatches(pair, line).some(({ end }) => end === lastQuote + 1),
    )
  ) {
    cut = Math.min(cut, lineFrom + lastQuote);
  }

  const begin = raw.lastIndexOf('-----BEGIN');
  if (begin !== -1 && raw.indexOf('-----END', begin) === -1) cut = Math.min(cut, begin);

  for (let moved = true; moved; ) {
    moved = false;
    // Never right after a backslash: what it escapes would be read apart from it (`\\\\\"[redacted]`
    // cut after two of its backslashes reads as a bare value of two; review #501 on #1575).
    const backslashes = backslashesBefore(raw, cut);
    if (backslashes > 0) {
      cut -= backslashes;
      moved = true;
    }
    // Nor in the blanks right after a `"`: whether it closes a value may turn on a `:` or `=` after
    // them (`"api_key" : `, `"api_key" = `), which the text before the cut would not see, and which
    // may not have come yet (#493 on #1581, #501 on 05f9be71). The quote is held with them — only
    // while what comes right after the cut is that `:` or `=` or nothing yet (no cut falls inside
    // a run of blanks): once something else has come, the quote's reading is settled, and of a
    // run of `" " "` only the last is held, not each in turn back to the start (#493 on
    // e301108f).
    const blanks = BLANKS_AFTER_A_QUOTE.exec(raw.slice(Math.max(0, cut - 9), cut));
    const next = raw.charAt(cut);
    if (blanks !== null && (next === ':' || next === '=' || next === '')) {
      cut -= blanks[0].length;
      moved = true;
    }
    const read = context + raw;
    for (const valuePattern of SECRET_VALUE_PATTERNS) {
      for (const { start, end } of secretMatches(valuePattern, read, context.length)) {
        const at = start - context.length;
        if (at < cut && (end - context.length > cut || end === read.length)) {
          cut = at;
          moved = true;
        }
      }
    }
  }
  return cut;
}

/** `text` up to `cut`, scrubbed as the whole text scrubs it. Cut right after a `"`, the text
 *  before reads as if it ended at that quote, where any `"` closes a `"…"` value with escaped
 *  quotes in it; in the whole text what follows may keep it from closing one (`password="a\"b"` of
 *  `password="a\"b"c`, of `… "api_key" : …`; #493, #501 on #1579). So it is read with a character
 *  that keeps the quote from closing one, as what follows does, and the character is taken off
 *  again — unless a value took it in (one opened by that quote, or a bare one that ends with an
 *  escaped quote), when the text is read on its own. */
function scrubbedBefore(text: string, cut: number, context: string): Scrubbed<string> {
  const options = { readAfter: context };
  if (text.charAt(cut - 1) !== '"' || endsAQuotedValue(text.slice(cut, cut + 10))) {
    return scrubSecretValues(text.slice(0, cut), options);
  }
  const read = scrubSecretValues(`${text.slice(0, cut)}${KEEPS_A_QUOTE_OPEN}`, options);
  return read.value.endsWith(KEEPS_A_QUOTE_OPEN)
    ? { value: read.value.slice(0, -1), redactedValues: read.redactedValues }
    : scrubSecretValues(text.slice(0, cut), options);
}
/** A character no value ends with once hidden, and that `endsAQuotedValue` refuses. */
const KEEPS_A_QUOTE_OPEN = 'x';

/** What `push` emits: scrubbed text, and whether the stream paused with it. */
export interface StreamPiece extends Scrubbed<string> {
  /** Legacy 162: this piece took the scrubber past its bound — it ends with the one `[redacted]`
   *  that stands for what was held and dropped, and nothing more is emitted until `flush`. Absent
   *  on every other piece, a value scrubbed at the end of one included. */
  readonly paused?: true;
}

export interface SecretStreamScrubber {
  /** Takes the next piece of text; returns the scrubbed text now safe to emit — often `''`. */
  push(piece: string): StreamPiece;
  /** The text ended: returns what was held back, scrubbed. The scrubber starts over afterwards. */
  flush(): Scrubbed<string>;
}

/** How much of the text already emitted the patterns look back into before what is held — as far
 *  as one looks behind where a match starts (`\u4e2d` before a key, `.` before a name) — so that
 *  the held text reads as the whole text reads it there. No match starts in it: it was read. */
const CONTEXT_CHARS = 8;

export function createSecretStreamScrubber(): SecretStreamScrubber {
  let context = '';
  let held = '';
  let dropping = false;

  function take(slice: string): Scrubbed<string> {
    held += slice;
    const cut = safeCut(held, context);
    if (held.length - cut > STREAM_HOLD_MAX_CHARS) {
      const before = scrubbedBefore(held, cut, context);
      context = '';
      held = '';
      dropping = true;
      return { value: before.value + REDACTED, redactedValues: before.redactedValues + 1 };
    }
    if (cut === 0) return { value: '', redactedValues: 0 };
    const out = scrubbedBefore(held, cut, context);
    context = (context + held.slice(0, cut)).slice(-CONTEXT_CHARS);
    held = held.slice(cut);
    return out;
  }

  return {
    push(piece) {
      const wasDropping = dropping;
      let value = '';
      let redactedValues = 0;
      for (let at = 0; at < piece.length && !dropping; at += PIECE_SLICE_CHARS) {
        const out = take(piece.slice(at, at + PIECE_SLICE_CHARS));
        value += out.value;
        redactedValues += out.redactedValues;
      }
      return dropping && !wasDropping
        ? { value, redactedValues, paused: true }
        : { value, redactedValues };
    },
    flush() {
      const out = dropping
        ? { value: '', redactedValues: 0 }
        : scrubSecretValues(held, { readAfter: context });
      context = '';
      held = '';
      dropping = false;
      return out;
    },
  };
}
