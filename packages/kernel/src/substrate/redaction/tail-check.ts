import { SECRET_FIELD_MASK, namesASecretField } from '@nexttime/shared';
import { namesASecretValue } from './secret-values.js';

/**
 * substrate/redaction/tail-check: the check that a value read after a secret's name closed
 * cleanly — `T` of the redaction boundary design (`docs/redaction-boundary-design-2026-11-27.md`
 * §4.2; class legacy 962). The value rules of secret-values.ts each decide where a value ends,
 * and every way of writing one they did not foresee showed the rest of it. This check decides
 * nothing of the kind: it reads the value in one of a few forms (a mask, a quoted value, a quoted
 * value written inside a string, a container, a JSON scalar, a bare run), and only when that form
 * closes within `TAIL_VALUE_MAX_CHARS`, holds no other pair, and is followed by a boundary its
 * table allows does it let the text after the value show. Otherwise the line is hidden from the
 * value on: a tail mask, one `[redacted]` to the end of the line, counted apart
 * (`redactedTails`, `redactedTailChars`) so that what it hid shows in the records.
 *
 * It only ever hides more: it is read on the text as it is, and its marks are taken out of what
 * the value rules kept (`TailMasker`, as `composeWithTailCheck` in secret-values.ts and the stream
 * scrubber compose them), never put back. A line is one line of the string read,
 * without its `\n` or `\r\n`.
 *
 * The same reading runs on a whole text and on a stream: `readLine` reads on from a point of a
 * line given the state the line left there (`TailState`, a few bits), and with `ended` false it
 * says where its marks stop being final, and from where to read again once more has come.
 */

const MASK = SECRET_FIELD_MASK;

/** How long a value the check reads before it hides the rest of the line: a bare run of up to
 *  this many characters; a quoted value or a container whose closing quote or bracket stands at
 *  most this many characters after its first. It keeps a name, its separator, this, and what the
 *  check looks at after it within `STREAM_HOLD_MAX_CHARS` (4,096), so a stream decides a long
 *  value as the whole text does. */
export const TAIL_VALUE_MAX_CHARS = 3_584;

/** The most masks read in a row right after a value (`"[redacted]"[redacted]`, as the value rules
 *  write one they read on past its quote) before the next text is taken for what follows it. */
const MASKS_AFTER_MAX = 4;

/** A name and its separator: a `--flag` and `=` or blanks; or a name, quoted on either side or
 *  not (`\"`, up to seven backslashes), up to eight blanks, `=>`, `:=`, `:` or `=`, up to eight
 *  blanks. Linear: a name starts only where no name character stands before it, and is matched
 *  as one run before what follows it is tried. */
const NAME =
  /(?<![A-Za-z0-9_.-])(?:(--)([A-Za-z][A-Za-z0-9-]{0,63})(=|[ \t]{1,8})|((?:\\{0,7}["'])?)([A-Za-z][A-Za-z0-9_.-]{0,127})((?:\\{0,7}["'])?)[ \t]{0,8}(=>|:=|[:=])[ \t]{0,8})/g;

/** How far after where a name starts the separator `NAME` needs can stand: a quote with seven
 *  backslashes, 128 name characters, another such quote, eight blanks. A name that starts this
 *  far before the end of what has come is settled; one nearer may still turn into one. */
const NAME_SEPARATOR_REACH = 8 + 128 + 8 + 8;

/** How far after the end of a bare value the separator of a name that starts in it can stand: a
 *  quote with seven backslashes and eight blanks (the name itself ends with the value: a bare
 *  value stops at no character a name holds). */
const NAME_AFTER_VALUE_REACH = 8 + 8 + 1;

/** Full-width punctuation: ends a quoted value's text as `.` does. */
const FULL_WIDTH = '，。、；：！？）」』】》';

/** What may follow a quoted value, a container or a mask: the end of the line, a blank, a few
 *  punctuation marks, a backtick, full-width punctuation. */
const AFTER_QUOTED = new Set([...',;&|)]}>.`', ...FULL_WIDTH]);
/** What may follow a bare value: the end of the line, a blank, `&`, a backtick. */
const AFTER_BARE = new Set(['&', '`']);

/** A value that starts with one of these is no value (a backtick, full-width punctuation, `…`). */
const NO_VALUE_START = new Set(['`', '…', ...FULL_WIDTH]);

/** Not in a bare value: whitespace, quotes, a backslash, a backtick, `&`. */
const BARE_STOP = /[\s"'\\`&]/;

/** Where a line's head stands, before a name, as far as `export NAME=value` and `- name: value`
 *  go: only blanks so far; `export`, letter by letter; `export` and blanks; `-`; `-` and blanks;
 *  anything else. */
const HEAD_BLANKS = 0;
const HEAD_EXPORT_BLANKS = 7;
const HEAD_DASH = 8;
const HEAD_DASH_BLANKS = 9;
const HEAD_OTHER = 10;
const EXPORT = 'export';

/** What a line left at a point, for reading on from there as the whole line reads. */
export interface TailState {
  /** For each quote — `"` or `'`, after exactly `k` backslashes, `k` up to 7 — whether it stood
   *  an odd number of times before the point, outside the values read: bit `2k` for `"`, `2k + 1`
   *  for `'`. An outer string is open where it did (`cleanAfter`). */
  readonly quotes: number;
  /** Backslashes right before the point, 8 for more than seven. */
  readonly slashes: number;
  /** `HEAD_*`: whether a name at the point starts its line's first pair. */
  readonly head: number;
}

export const LINE_START: TailState = { quotes: 0, slashes: 0, head: HEAD_BLANKS };

const isBlank = (char: string | undefined): boolean => char === ' ' || char === '\t';

function headAfter(head: number, char: string): number {
  if (head === HEAD_OTHER) return HEAD_OTHER;
  if (head === HEAD_BLANKS) {
    if (isBlank(char)) return HEAD_BLANKS;
    if (char === 'e') return 1;
    return char === '-' ? HEAD_DASH : HEAD_OTHER;
  }
  if (head < EXPORT.length) return char === EXPORT.charAt(head) ? head + 1 : HEAD_OTHER;
  if (head === EXPORT.length || head === HEAD_EXPORT_BLANKS) {
    return isBlank(char) ? HEAD_EXPORT_BLANKS : HEAD_OTHER;
  }
  return isBlank(char) ? HEAD_DASH_BLANKS : HEAD_OTHER;
}

/** Whether a line's first pair starts at a head in `head`: `name: value`, `NAME=value`,
 *  `export NAME=value`, `- name: value`, blanks before each. */
const startsTheLine = (head: number): boolean =>
  head === HEAD_BLANKS || head === HEAD_EXPORT_BLANKS || head === HEAD_DASH_BLANKS;

/** `state` read on over `line` from `from` to `to`, text no value was read in. */
function fold(state: TailState, line: string, from: number, to: number): TailState {
  if (from >= to) return state;
  let { quotes, slashes, head } = state;
  for (let at = from; at < to; at += 1) {
    const char = line.charAt(at);
    if (head !== HEAD_OTHER) head = headAfter(head, char);
    if (char === '\\') {
      slashes = Math.min(slashes + 1, 8);
      continue;
    }
    if ((char === '"' || char === "'") && slashes <= 7) {
      quotes ^= 1 << (2 * slashes + (char === '"' ? 0 : 1));
    }
    slashes = 0;
  }
  return { quotes, slashes, head };
}

/** After a value: a value never ends with a backslash, and a name came before it. */
const afterValue = (state: TailState): TailState => ({
  quotes: state.quotes,
  slashes: 0,
  head: HEAD_OTHER,
});

/** What `readValue` makes of a value. */
type Read =
  | { readonly kind: 'more' }
  | { readonly kind: 'tail' }
  /** Nothing of it to hide (none, a mask, a JSON scalar, an empty quoted value), to `end`. */
  | { readonly kind: 'skip'; readonly end: number }
  /** Closed cleanly: `start`–`end` hidden (its text, not its quotes), read to `next`. */
  | {
      readonly kind: 'hide';
      readonly start: number;
      readonly end: number;
      readonly next: number;
      readonly bare: boolean;
    };

const MORE: Read = { kind: 'more' };
const TAIL: Read = { kind: 'tail' };

/** One line being read, and whether it has ended or more of it may come. */
interface Line {
  readonly text: string;
  readonly ended: boolean;
}

/** Whether `name` takes a value with it: a `--flag` or a bare name the value rules read, a quoted
 *  one the field rule reads as well. */
function isSecretName(match: RegExpExecArray): boolean {
  if (match[1] !== undefined) return namesASecretValue(match[2] ?? '');
  const name = match[5] ?? '';
  const quoted = match[4] !== '' || match[6] !== '';
  return namesASecretValue(name) || (quoted && namesASecretField(name));
}

/** Whether a secret's name and separator start in `text` from `from` before `before`; `undefined`
 *  while the end of the line may still make one (`line`: whether more of it may come). */
function holdsAName(
  text: string,
  from: number,
  before: number,
  line: Line,
  reach: number,
): boolean | undefined {
  const names = new RegExp(NAME.source, 'g');
  names.lastIndex = from;
  for (let match = names.exec(text); match !== null; match = names.exec(text)) {
    if (match.index >= before) return false;
    if (isSecretName(match)) return true;
  }
  return !line.ended && text.length < before + reach ? undefined : false;
}

/** At `at`: up to eight blanks and a `:` or `=` — what follows a value is then the key of the next
 *  pair, not a boundary; `undefined` while the line may still make it so. */
function separatorAhead(line: Line, at: number): boolean | undefined {
  let blanks = 0;
  while (blanks <= 8 && isBlank(line.text.charAt(at + blanks))) blanks += 1;
  if (blanks > 8) return false;
  const next = at + blanks;
  if (next >= line.text.length) return line.ended ? false : undefined;
  const char = line.text.charAt(next);
  return char === ':' || char === '=';
}

/** Where the masks right after a value end (`[redacted]`, each with a quote on either side, up to
 *  `MASKS_AFTER_MAX`), or `at` itself for none; `undefined` while the line may still make one. */
function masksAfter(line: Line, at: number): number | undefined {
  const { text } = line;
  let end = at;
  for (let n = 0; n < MASKS_AFTER_MAX; n += 1) {
    let p = quoteAt(line, end);
    if (p === undefined) return undefined;
    if (p === -1) p = end;
    if (!text.startsWith(MASK, p)) {
      if (!line.ended && MASK.startsWith(text.slice(p))) return undefined;
      return end;
    }
    p += MASK.length;
    const after = quoteAt(line, p);
    if (after === undefined) return undefined;
    end = after === -1 ? p : after;
  }
  return end;
}

/** At `at`: up to seven backslashes and a quote — the index after it, `-1` for none; `undefined`
 *  while the line may still make one. */
function quoteAt(line: Line, at: number): number | undefined {
  const { text } = line;
  let p = at;
  while (p - at < 7 && text.charAt(p) === '\\') p += 1;
  if (p >= text.length) return line.ended || p === at ? -1 : undefined;
  const char = text.charAt(p);
  return char === '"' || char === "'" ? p + 1 : -1;
}

/** What stands after a value that closed at `at`: `true` when it is a boundary `table` allows
 *  (after masks, the quoted value's table; after the closing quote of a string the line opened
 *  before the name, that table too), and no `:` or `=` follows. `quotes` is the line's quote
 *  parity before the name (`TailState.quotes`). */
function cleanAfter(
  line: Line,
  at: number,
  table: ReadonlySet<string>,
  quotes: number,
): boolean | undefined {
  const { text } = line;
  let p = at;
  let allowed = table;
  const masked = masksAfter(line, p);
  if (masked === undefined) return undefined;
  if (masked > p) {
    p = masked;
    allowed = AFTER_QUOTED;
  }
  const boundary = (q: number, set: ReadonlySet<string>): boolean | undefined => {
    if (q >= text.length) return line.ended ? true : undefined;
    const char = text.charAt(q);
    return /\s/.test(char) || set.has(char);
  };
  const first = boundary(p, allowed);
  if (first === undefined) return undefined;
  if (!first) {
    // An outer string's closing quote, where the line opened that string before the name.
    let slashes = 0;
    while (slashes < 7 && text.charAt(p + slashes) === '\\') slashes += 1;
    if (p + slashes >= text.length) return line.ended ? false : undefined;
    const quote = text.charAt(p + slashes);
    if (quote !== '"' && quote !== "'") return false;
    const bit = 1 << (2 * slashes + (quote === '"' ? 0 : 1));
    if ((quotes & bit) === 0) return false;
    p += slashes + 1;
    const after = boundary(p, AFTER_QUOTED);
    if (after !== true) return after;
  }
  const key = separatorAhead(line, p);
  return key === undefined ? undefined : !key;
}

/** Where a close written as `slashes` backslashes and a quote may yet start, the text having
 *  come only as far as its end: at the run of backslashes it ends with when that run is no longer
 *  than the close's, as a whole text reads its bound at the close's first backslash; at its end
 *  otherwise. */
function closeMayStart(text: string, slashes: number): number {
  let run = 0;
  while (run <= slashes && text.charAt(text.length - 1 - run) === '\\') run += 1;
  return run > 0 && run <= slashes ? text.length - run : text.length;
}

/** Where the container that opens at `from` closes (the index after its last bracket); `-1` when
 *  it does not close on its line within the bound, or holds a backslash outside a string;
 *  `undefined` while the line may still close it. A string in it is delimited by `"` or `'`,
 *  written with `slashes` before it where the key was. */
function containerEnd(line: Line, from: number, slashes: string): number | undefined {
  const { text } = line;
  const stack: string[] = [];
  let i = from;
  while (i < text.length && i - from <= TAIL_VALUE_MAX_CHARS) {
    const char = text.charAt(i);
    if (char === '{' || char === '[') {
      stack.push(char === '{' ? '}' : ']');
      i += 1;
      continue;
    }
    if (char === '}' || char === ']') {
      if (stack.pop() !== char) return -1;
      i += 1;
      if (stack.length === 0) return i;
      continue;
    }
    const opens =
      slashes === ''
        ? char === '"' || char === "'"
        : text.startsWith(slashes, i) &&
          (text.charAt(i + slashes.length) === '"' || text.charAt(i + slashes.length) === "'");
    if (opens) {
      const quote = slashes === '' ? char : text.charAt(i + slashes.length);
      const token = slashes + quote;
      let j = i + token.length;
      let end = -1;
      while (j < text.length && j - from <= TAIL_VALUE_MAX_CHARS) {
        if (slashes === '') {
          if (text.charAt(j) === '\\') {
            j += 2;
            continue;
          }
          if (text.charAt(j) === quote) {
            end = j + 1;
            break;
          }
          j += 1;
        } else {
          if (text.startsWith(token, j) && text.charAt(j - 1) !== '\\') {
            end = j + token.length;
            break;
          }
          j += 1;
        }
      }
      if (end === -1) {
        if (line.ended) return -1;
        const at = slashes === '' ? j : closeMayStart(text, slashes.length);
        return at - from > TAIL_VALUE_MAX_CHARS ? -1 : undefined;
      }
      i = end;
      continue;
    }
    if (char === '\\') {
      // A backslash outside a string ends no container cleanly, unless it may yet begin the
      // quote of one written with backslashes before it.
      let run = i;
      while (run < text.length && text.charAt(run) === '\\') run += 1;
      return run >= text.length && slashes !== '' && !line.ended ? undefined : -1;
    }
    i += 1;
  }
  return line.ended || i - from > TAIL_VALUE_MAX_CHARS ? -1 : undefined;
}

const JSON_SCALAR = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)(?=[,}\]])/;

/** The value at `from`, after a name whose quote parity before it is `quotes` and whose key, quoted
 *  on both sides, was written with `keySlashes` before its quotes. */
function readValue(line: Line, from: number, quotes: number, keySlashes: string): Read {
  const { text } = line;
  if (from >= text.length) return line.ended ? { kind: 'skip', end: from } : MORE;
  const rest = text.slice(from, from + TAIL_VALUE_MAX_CHARS + 2);
  if (rest.startsWith(MASK)) {
    const clean = cleanAfter(line, from + MASK.length, AFTER_QUOTED, quotes);
    if (clean === undefined) return MORE;
    return clean ? { kind: 'skip', end: from + MASK.length } : TAIL;
  }
  if (!line.ended && MASK.startsWith(text.slice(from))) return MORE;

  // A quoted value: `"…"`, `'…'`, or `\"…\"` with up to seven backslashes.
  let slashes = 0;
  while (slashes < 7 && text.charAt(from + slashes) === '\\') slashes += 1;
  if (slashes > 0 && from + slashes >= text.length) return line.ended ? TAIL : MORE;
  const opening = text.charAt(from + slashes);
  if (opening === '"' || opening === "'") {
    const open = slashes + 1;
    const token = '\\'.repeat(slashes) + opening;
    let i = from + open;
    let closed = -1;
    while (i < text.length) {
      if (i - from > TAIL_VALUE_MAX_CHARS) {
        // Past the bound inside the backslashes the text ends with: a close that starts within the
        // bound may still come.
        const waits =
          !line.ended && slashes > 0 && closeMayStart(text, slashes) - from <= TAIL_VALUE_MAX_CHARS;
        return waits ? MORE : TAIL;
      }
      const char = text.charAt(i);
      if (slashes === 0) {
        if (char === '\\') {
          i += 2;
          continue;
        }
        if (char === opening) {
          closed = i + 1;
          break;
        }
        i += 1;
      } else {
        if (text.startsWith(token, i) && text.charAt(i - 1) !== '\\') {
          closed = i + token.length;
          break;
        }
        if (char === '"' || char === "'") return TAIL;
        i += 1;
      }
    }
    if (closed === -1) {
      if (line.ended) return TAIL;
      const at = slashes === 0 ? i : closeMayStart(text, slashes);
      return at - from > TAIL_VALUE_MAX_CHARS ? TAIL : MORE;
    }
    const content = text.slice(from + open, closed - open);
    if (content.includes(MASK) && content !== MASK) return TAIL;
    if (holdsAName(content, 0, content.length, { text: content, ended: true }, 0)) return TAIL;
    const clean = cleanAfter(line, closed, AFTER_QUOTED, quotes);
    if (clean === undefined) return MORE;
    if (!clean) return TAIL;
    if (content === MASK || content === '') return { kind: 'skip', end: closed };
    return { kind: 'hide', start: from + open, end: closed - open, next: closed, bare: false };
  }
  if (slashes > 0) return TAIL;

  const first = rest.charAt(0);
  if (NO_VALUE_START.has(first)) return { kind: 'skip', end: from };

  // A container, closed on its line with its brackets balanced, its strings read whole.
  if (first === '{' || first === '[') {
    let blanks = from + 1;
    while (isBlank(text.charAt(blanks))) blanks += 1;
    if (blanks >= text.length) {
      // Opened here and closed on a later line: its lines are read on their own.
      return line.ended ? { kind: 'skip', end: from + 1 } : MORE;
    }
    const closed = containerEnd(line, from, keySlashes);
    if (closed === undefined) return MORE;
    if (closed === -1) return TAIL;
    const clean = cleanAfter(line, closed, AFTER_QUOTED, quotes);
    if (clean === undefined) return MORE;
    if (!clean) return TAIL;
    if (closed - from === 2) return { kind: 'skip', end: closed };
    return { kind: 'hide', start: from, end: closed, next: closed, bare: false };
  }

  // A JSON scalar before `,` `}` `]`: nothing of it is this check's to hide.
  const scalar = JSON_SCALAR.exec(rest);
  if (scalar !== null) {
    const end = from + scalar[0].length;
    const key = separatorAhead(line, end + 1);
    if (key === undefined) return MORE;
    return key ? TAIL : { kind: 'skip', end };
  }

  // A bare value: a run with no whitespace, quote, backslash, backtick or `&`.
  let end = from;
  while (end < text.length && !BARE_STOP.test(text.charAt(end))) {
    end += 1;
    if (end - from > TAIL_VALUE_MAX_CHARS) return TAIL;
  }
  if (end === from) return TAIL;
  if (end >= text.length && !line.ended) return MORE;
  const value = text.slice(from, end);
  if (value.includes(MASK) && value !== MASK) return TAIL;
  const named = holdsAName(text, from, end, line, NAME_AFTER_VALUE_REACH);
  if (named === undefined) return MORE;
  if (named) return TAIL;
  const clean = cleanAfter(line, end, AFTER_BARE, quotes);
  if (clean === undefined) return MORE;
  if (!clean) return TAIL;
  return { kind: 'hide', start: from, end, next: end, bare: true };
}

/** `$NAME` or `${NAME}`: a bare value that names a variable, not one. */
const REFERENCE = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/;

/** What `readLine` read. */
export interface LineRead {
  /** Values that closed cleanly, to hide: `[start, end)` in the line, in order. */
  readonly hide: readonly (readonly [number, number])[];
  /** Where the line is hidden from to its end; `-1` for nowhere. */
  readonly tailAt: number;
  /** With more of the line to come: every mark before this is final. The end of the line read
   *  otherwise. */
  readonly safe: number;
  /** With more of the line to come: where to read on from, and the line's state there. */
  readonly resume: number;
  readonly state: TailState;
}

/** `line` read from `from`, a point `state` describes (the line's start, or where an earlier read
 *  said to `resume`); `ended`: the line ends where `line` does, else more of it may come. The
 *  character before `from`, where there is one, is in `line`. */
export function readLine(line: string, from: number, state: TailState, ended: boolean): LineRead {
  const reading: Line = { text: line, ended };
  const hide: [number, number][] = [];
  let scanned = from;
  let current = state;
  const names = new RegExp(NAME.source, 'g');
  names.lastIndex = from;
  let searchFrom = from;
  const pending = (at: number, safe: number): LineRead => ({
    hide,
    tailAt: -1,
    safe,
    resume: at,
    state: fold(current, line, scanned, at),
  });
  for (let match = names.exec(line); match !== null; match = names.exec(line)) {
    const matchEnd = match.index + match[0].length;
    if (!ended && matchEnd >= line.length) return pending(match.index, line.length);
    if (!isSecretName(match)) {
      searchFrom = matchEnd;
      continue;
    }
    const valueAt = matchEnd;
    const flag = match[1] !== undefined;
    const openingOnly = !flag && match[4] !== '' && match[6] === '';
    const keySlashes =
      !flag && match[4] !== '' && match[6] !== '' ? (match[4] ?? '').slice(0, -1) : '';
    current = fold(current, line, scanned, match.index);
    scanned = match.index;
    const atName = current;
    // A key with only its opening quote counts that quote as an outer string's (`"TOKEN=…`).
    const quotes = openingOnly
      ? fold(current, line, match.index, match.index + (match[4] ?? '').length).quotes
      : current.quotes;
    const read = readValue(reading, valueAt, quotes, keySlashes);
    if (read.kind === 'more') return pending(match.index, valueAt);
    if (read.kind === 'tail')
      return { hide, tailAt: valueAt, safe: line.length, resume: line.length, state: atName };
    if (read.kind === 'hide' && read.bare && !flag && startsTheLine(atName.head)) {
      // A line's first pair with a bare value (`.env`, YAML, INI): its value runs to the end of
      // the line, where more stands after it.
      let at = read.end;
      while (at < line.length && /\s/.test(line.charAt(at))) at += 1;
      if (at < line.length) {
        return { hide, tailAt: valueAt, safe: line.length, resume: line.length, state: atName };
      }
      if (!ended) return pending(match.index, valueAt);
    }
    const next = read.kind === 'hide' ? read.next : read.end;
    if (read.kind === 'hide' && !(read.bare && REFERENCE.test(line.slice(valueAt, next)))) {
      hide.push([read.start, read.end]);
    }
    current = afterValue(fold(current, line, match.index, valueAt));
    scanned = Math.max(next, valueAt);
    searchFrom = scanned;
    names.lastIndex = scanned;
  }
  if (ended) return { hide, tailAt: -1, safe: line.length, resume: line.length, state: current };
  const resume = Math.max(searchFrom, line.length - NAME_SEPARATOR_REACH, scanned);
  return {
    hide,
    tailAt: -1,
    safe: line.length,
    resume,
    state: fold(current, line, scanned, resume),
  };
}

/** A stretch the check hides, in the text it read: a value that closed cleanly, or (`tail`) the
 *  rest of a line from a value that did not, to the end of the line (`\n` or `\r\n` not in it). */
export interface TailMark {
  readonly start: number;
  readonly end: number;
  readonly tail: boolean;
}

/** What the check makes of a whole text. */
export interface TailMarks {
  readonly marks: readonly TailMark[];
  /** Tails, and the characters (UTF-16 code units) they hide, each from its start to the end of
   *  its line: what a record carries as `redactedTails` and `redactedTailChars`. */
  readonly tails: number;
  readonly tailChars: number;
}

const LINE_BREAK = /\r?\n/g;

/** The check over a whole text, line by line. */
export function tailMarks(text: string): TailMarks {
  const marks: TailMark[] = [];
  let tails = 0;
  let tailChars = 0;
  let lineAt = 0;
  const breaks = new RegExp(LINE_BREAK.source, 'g');
  for (let done = false; !done; ) {
    const lineBreak = breaks.exec(text);
    const lineEnd = lineBreak === null ? text.length : lineBreak.index;
    done = lineBreak === null;
    const read = readLine(text.slice(lineAt, lineEnd), 0, LINE_START, true);
    for (const [start, end] of read.hide) {
      marks.push({ start: lineAt + start, end: lineAt + end, tail: false });
    }
    if (read.tailAt !== -1) {
      marks.push({ start: lineAt + read.tailAt, end: lineEnd, tail: true });
      tails += 1;
      tailChars += lineEnd - lineAt - read.tailAt;
    }
    if (lineBreak !== null) lineAt = lineBreak.index + lineBreak[0].length;
  }
  return { marks, tails, tailChars };
}

/**
 * The check over a text that arrives in pieces (`secret-stream.ts`): its marks are the marks
 * `tailMarks` gives the whole text, whatever the pieces. Positions count from the start of the
 * stream. Before `safe` every mark is final — those that end there or before are not reported
 * again (`marksFrom`); from it on, what has come may still be read differently. It holds at most
 * one line's pending pair (a name, its separator, `TAIL_VALUE_MAX_CHARS`, and the few characters
 * after the value the check looks at), and a trailing `\r` until what follows it shows whether it
 * ends the line.
 */
export class TailReader {
  /** Where the current line starts. */
  private lineAt = 0;
  /** The current line, from `textAt` on, as far as it has come. */
  private text = '';
  private textAt = 0;
  /** Where to read on from, and the line's state there. */
  private resume = 0;
  private state: TailState = LINE_START;
  /** Where a tail on the current line starts, `-1` for none yet. */
  private tailAt = -1;
  private safeAt = 0;
  private readonly closed: TailMark[] = [];
  tails = 0;
  tailChars = 0;

  get safe(): number {
    return this.safeAt;
  }

  /** How many characters of the current line it keeps: at most a pending pair as above, and of
   *  an open tail nothing but a trailing `\r`. */
  get held(): number {
    return this.text.length;
  }

  push(piece: string): void {
    let from = 0;
    for (
      let lineBreak = piece.indexOf('\n');
      lineBreak !== -1;
      lineBreak = piece.indexOf('\n', from)
    ) {
      this.text += piece.slice(from, lineBreak);
      const breakAt = this.textAt + this.text.length;
      const content = this.text.endsWith('\r') ? this.text.slice(0, -1) : this.text;
      this.close(content);
      this.nextLine(breakAt + 1);
      from = lineBreak + 1;
    }
    this.text += piece.slice(from);
    this.readOn();
  }

  /** The text ended: its last line is read to its end. */
  end(): void {
    const endAt = this.textAt + this.text.length;
    this.close(this.text);
    this.nextLine(endAt);
  }

  /** The marks that end after `from`, in order — an open tail as far as `safe`. Those that end at
   *  `from` or before are let go. */
  marksFrom(from: number): readonly TailMark[] {
    let gone = 0;
    while (gone < this.closed.length && (this.closed[gone]?.end ?? 0) <= from) gone += 1;
    if (gone > 0) this.closed.splice(0, gone);
    if (this.tailAt === -1 || this.safeAt <= this.tailAt) return this.closed;
    return [...this.closed, { start: this.tailAt, end: this.safeAt, tail: true }];
  }

  private nextLine(at: number): void {
    this.lineAt = at;
    this.text = '';
    this.textAt = at;
    this.resume = at;
    this.state = LINE_START;
    this.tailAt = -1;
    this.safeAt = at;
  }

  /** The current line, ended: `content` is it from `textAt` on, without its line break. */
  private close(content: string): void {
    const endAt = this.textAt + content.length;
    if (this.tailAt === -1) {
      const read = readLine(content, this.resume - this.textAt, this.state, true);
      this.keep(read.hide);
      if (read.tailAt !== -1) this.openTail(this.textAt + read.tailAt);
    }
    if (this.tailAt !== -1) {
      this.closed.push({ start: this.tailAt, end: endAt, tail: true });
      this.tailChars += endAt - this.tailAt;
    }
  }

  /** What has come of the current line, read as far as it decides. */
  private readOn(): void {
    const shown = this.text.endsWith('\r') ? this.text.length - 1 : this.text.length;
    if (this.tailAt !== -1) {
      this.passTail(shown);
      return;
    }
    const read = readLine(this.text.slice(0, shown), this.resume - this.textAt, this.state, false);
    this.keep(read.hide);
    if (read.tailAt !== -1) {
      this.openTail(this.textAt + read.tailAt);
      this.passTail(shown);
      return;
    }
    this.safeAt = this.textAt + read.safe;
    this.resume = this.textAt + read.resume;
    this.state = read.state;
    // Keep the line from the character before `resume`: a name there looks back at it.
    const keepAt = Math.max(this.lineAt, this.resume - 1);
    this.text = this.text.slice(keepAt - this.textAt);
    this.textAt = keepAt;
  }

  /** The line's tail is open: all of it from `tailAt` on is hidden and nothing of it is read
   *  again, so of the text only a trailing `\r` is kept (whether it ends the line is not known
   *  yet). Kept whole, the line would grow with every piece and be copied each time it is read:
   *  a long line in short pieces took time growing with the square of its length. */
  private passTail(shown: number): void {
    this.safeAt = this.textAt + shown;
    this.text = this.text.slice(shown);
    this.textAt += shown;
  }

  private keep(hide: readonly (readonly [number, number])[]): void {
    for (const [start, end] of hide) {
      this.closed.push({ start: this.textAt + start, end: this.textAt + end, tail: false });
    }
  }

  private openTail(at: number): void {
    this.tailAt = at;
    this.tails += 1;
  }
}

/** A stretch of what the value rules made of a text, in order: characters of the text they kept
 *  (`at`, where `text` starts in it), or characters they wrote (`at` -1: a `[redacted]`, or other
 *  text a rule writes), which stand for text they replaced. */
export interface Segment {
  readonly at: number;
  readonly text: string;
}

/**
 * The composition (`docs/redaction-boundary-design-2026-11-27.md` §4.3): the value rules' reading
 * of a text, with what the check hides in that text hidden too. Every character it shows is one
 * the value rules kept, in their order. A stretch it hides, together with the masks the value
 * rules wrote right against it, is one `[redacted]`; a mask of theirs with nothing hidden against
 * it stays as they wrote it. One such stretch with no mask of theirs in it is a value they did not
 * count: `redactedValues` counts those.
 *
 * Fed in pieces, it composes as far as the check's marks are final (`limit`), and holds the rest,
 * and the masks of theirs that may yet be joined to a stretch to come.
 */
export class TailMasker {
  private queue: Segment[] = [];
  /** The first segment of `queue` not yet composed, and how far into it composing has got. */
  private next = 0;
  private head = 0;
  /** Characters of `queue` from `next` on. */
  private queued = 0;
  /** 0: no stretch open; 1: masks of the value rules held, nothing hidden against them yet;
   *  2: a hidden stretch, its `[redacted]` still to be written. */
  private group: 0 | 1 | 2 = 0;
  private heldText = '';
  private tookMasks = false;
  /** Where composing has got to, in the text read. */
  done = 0;
  redactedValues = 0;

  add(segments: readonly Segment[]): void {
    for (const segment of segments) {
      if (segment.text === '') continue;
      this.queue.push(segment);
      this.queued += segment.text.length;
    }
  }

  /** The characters held: queued, and masks of the value rules held for a stretch to come. */
  get held(): number {
    return this.queued - this.head + this.heldText.length;
  }

  /** Composes the segments as far as `limit`, with `marks` — the check's, in order, final before
   *  `limit`; those that end at `done` or before may be left out. */
  compose(limit: number, marks: readonly TailMark[]): string {
    let out = '';
    let mark = 0;
    while (this.next < this.queue.length) {
      const segment = this.queue[this.next] as Segment;
      if (segment.at < 0) {
        if (this.group === 2) {
          this.tookMasks = true;
        } else {
          this.heldText += segment.text;
          this.group = 1;
        }
        this.taken(segment);
        continue;
      }
      const end = segment.at + segment.text.length;
      const until = Math.min(end, limit);
      let at = segment.at + this.head;
      while (at < until) {
        while (mark < marks.length && (marks[mark]?.end ?? 0) <= at) mark += 1;
        const hidden = marks[mark];
        if (hidden !== undefined && hidden.start <= at) {
          this.hide();
          at = Math.min(hidden.end, until);
        } else {
          const to = Math.min(hidden?.start ?? until, until);
          out += this.show(segment.text.slice(at - segment.at, to - segment.at));
          at = to;
        }
      }
      this.done = Math.max(this.done, at);
      if (at < end) {
        this.head = at - segment.at;
        break;
      }
      this.taken(segment);
    }
    if (this.next > 1024 && this.next * 2 > this.queue.length) {
      this.queue = this.queue.slice(this.next);
      this.next = 0;
    }
    return out;
  }

  /** Everything composed, nothing more to come: what is held, written. */
  finish(): string {
    return this.show('');
  }

  private taken(segment: Segment): void {
    this.queued -= segment.text.length;
    this.head = 0;
    this.next += 1;
  }

  private hide(): void {
    if (this.group === 2) return;
    this.tookMasks = this.group === 1;
    this.heldText = '';
    this.group = 2;
  }

  private show(text: string): string {
    let out = '';
    if (this.group === 1) out = this.heldText;
    else if (this.group === 2) {
      out = MASK;
      if (!this.tookMasks) this.redactedValues += 1;
    }
    this.heldText = '';
    this.group = 0;
    this.tookMasks = false;
    return out + text;
  }
}

/** What the check makes of a text on its own, hidden as it says: the check alone (`T` of the
 *  design), and the second reading of the composition (`composeWithTailCheck` in
 *  secret-values.ts). */
export interface TailChecked {
  readonly value: string;
  readonly redactedValues: number;
  readonly tails: number;
  readonly tailChars: number;
}

export function tailChecked(text: string): TailChecked {
  const { marks, tails, tailChars } = tailMarks(text);
  if (marks.length === 0) return { value: text, redactedValues: 0, tails: 0, tailChars: 0 };
  const masker = new TailMasker();
  masker.add([{ at: 0, text }]);
  const value = masker.compose(text.length, marks) + masker.finish();
  return { value, redactedValues: masker.redactedValues, tails, tailChars };
}
