import { type Rng, int, mulberry32, rowSeed } from './rng.js';
import { type Row, secretPlaces } from './row.js';

/** What every reader here writes in place of what it hides. */
export const MASK = '[redacted]';

/**
 * Which characters of `input` `output` kept, when `output` is `input` with some of its stretches
 * replaced by `MASK`, the rest as written. `undefined` when it is not.
 *
 * A stretch may be empty: an empty quoted value is written `"[redacted]"`. The kept pieces between
 * masks are placed as early as they fit (as a subsequence is matched): if any placement exists,
 * that one does. A piece that occurs twice in reach can be placed at the earlier one; the
 * generators' secrets are long random words, so a piece holding part of one has one place to go.
 * A `MASK` already in `input` and kept reads as a mask: its characters are not anyone's secret.
 */
export function keptChars(input: string, output: string): Int32Array | undefined {
  // keptAt[i] = where input[i] is in output, or -1.
  const keptAt = new Int32Array(input.length).fill(-1);
  const pieces = output.split(MASK);
  if (pieces.length === 1) {
    if (output !== input) return undefined;
    for (let i = 0; i < input.length; i += 1) keptAt[i] = i;
    return keptAt;
  }
  let from = 0; // where the next piece may start in input
  let outAt = 0;
  for (let p = 0; p < pieces.length; p += 1) {
    const piece = pieces[p] as string;
    const first = p === 0;
    const last = p === pieces.length - 1;
    let at: number;
    if (first) {
      if (!input.startsWith(piece)) return undefined;
      at = 0;
    } else if (last) {
      at = input.length - piece.length;
      if (at < from || !input.endsWith(piece)) return undefined;
    } else {
      at = input.indexOf(piece, from);
      if (at < 0) return undefined;
    }
    for (let k = 0; k < piece.length; k += 1) keptAt[at + k] = outAt + k;
    outAt += piece.length + (last ? 0 : MASK.length);
    from = at + piece.length;
  }
  return keptAt;
}

/** Which secret characters of `row` an output shows: `places` (from `secretPlaces`) and kept. An
 *  output that is not `row.t` with stretches masked shows every one of them. */
export function shown(row: Row, places: Uint8Array, output: string): Uint8Array {
  const kept = keptChars(row.t, output);
  const out = new Uint8Array(row.t.length);
  for (let i = 0; i < out.length; i += 1) {
    if (places[i] && (kept === undefined || (kept[i] as number) >= 0)) out[i] = 1;
  }
  return out;
}

/** As `shown`, for an output written from an earlier output: what `row.t`'s secrets `first` kept
 *  and `second` (read from `first`) kept too. */
export function shownThrough(
  row: Row,
  places: Uint8Array,
  first: string,
  second: string,
): Uint8Array {
  const one = keptChars(row.t, first);
  const two = keptChars(first, second);
  const out = new Uint8Array(row.t.length);
  for (let i = 0; i < out.length; i += 1) {
    if (!places[i]) continue;
    if (one === undefined) {
      out[i] = 1;
      continue;
    }
    const at = one[i] as number;
    if (at >= 0 && (two === undefined || (two[at] as number) >= 0)) out[i] = 1;
  }
  return out;
}

/** The note pi put after a tool result it cut before legacy 967 (`truncateToolResult`), at the end
 *  of the text. */
const CUT_NOTE =
  /\n\n\[\.\.\. \d+ more characters omitted — the full result is not shown \.\.\.\]$/;

/** The shortest piece of a secret `shownInRuns` looks for. */
const RUN_CHARS = 8;

/** Which secret characters of `row` an output shows, read without lining it up: a character is
 *  shown where some `RUN_CHARS` of its secret's characters around it (all of a shorter secret) are
 *  in the output as written. For the stored rows (`Row.stored`), whose rewrite is not its input
 *  with stretches masked — the release's `repairSplitQuotedMasks` writes `\"[redacted]\"` where
 *  it read `[redacted]"…\"` — and which `shown` would count as showing every one. */
export function shownInRuns(row: Row, places: Uint8Array, output: string): Uint8Array {
  const out = new Uint8Array(row.t.length);
  for (let start = 0; start < places.length; ) {
    if (!places[start]) {
      start += 1;
      continue;
    }
    let end = start;
    while (end < places.length && places[end]) end += 1;
    const width = Math.min(RUN_CHARS, end - start);
    for (let at = start; at + width <= end; at += 1) {
      if (output.includes(row.t.slice(at, at + width))) out.fill(1, at, at + width);
    }
    start = end;
  }
  return out;
}

/** Some secret character `now` shows that `before` did not: hidden before, shown now. */
export function showsMore(now: Uint8Array, before: Uint8Array): boolean {
  for (let i = 0; i < now.length; i += 1) if (now[i] && !before[i]) return true;
  return false;
}

const any = (a: Uint8Array): boolean => a.some((x) => x === 1);
const count = (a: Uint8Array): number => a.reduce((n, x) => n + x, 0);

/** The four ways a reader reads text (design doc §2 「读法」), as one version does. */
export interface Reader {
  /** The whole text at once (`scrubSecretValues`). */
  whole(text: string): { value: string; redactedValues: number };
  /** The text in pieces cut at `cuts`, as a Turn's live deltas (`createSecretStreamScrubber`). */
  stream(text: string, cuts: readonly number[]): string;
  /** A row an earlier release stored, rewritten on upgrade (the text rows of
   *  `application/platform/scrub-raw-secrets`: `turnReports`, `decisions`). */
  stored(text: string): { value: string; redactedValues: number };
  /** A tool result's text (pi's one text part) as a tool-call record stores it: the record's
   *  result preview (`buildToolCallRecord`). */
  record(text: string): string;
  /** A stored record's result preview rewritten on upgrade (`rescrubStoredToolCallResult`, the
   *  `toolCallRecords` of `scrub-raw-secrets`). */
  recordRewrite(text: string): { value: string; redactedValues: number };
  /** Whether `scrub-raw-secrets` counts a stored record's result preview as 收尾未证明
   *  (`storedToolCallResultTailUnproven`); `false` for a version without it. */
  recordUnproven(text: string): boolean;
}

/** The module shapes a `Reader` is built from — today's and a released tag's alike. */
export interface ValuesModule {
  scrubSecretValues(text: string, options?: unknown): { value: string; redactedValues: number };
  readonly STORED_REWRITE_SECRET_PATTERNS: unknown;
  /** v0.70.1's; gone since legacy 919 step 2. A reader without it stores as the rest. */
  readonly repairSplitQuotedMasks?: (text: string) => { value: string; redactedValues: number };
}
export interface RecordModule {
  buildToolCallRecord(input: {
    toolCallId: string;
    name: string | null;
    outcome: 'done';
    hasArgs: false;
    result: unknown;
    hasResult: true;
    startedAt: null;
    endedAt: null;
  }): { result?: { text: string } };
  rescrubStoredToolCallResult(content: Record<string, unknown>): {
    value: Record<string, unknown>;
    redactedValues: number;
  };
  readonly storedToolCallResultTailUnproven?: (content: Record<string, unknown>) => boolean;
}
export interface StreamModule {
  createSecretStreamScrubber(): {
    push(piece: string): { value: string };
    flush(): { value: string };
  };
}

/** The tool a record row's result came from: not one that declares its secret keys, so the
 *  record reads it with the key rule for any tool (a secret-naming key). */
const RECORD_TOOL = 'some_tool';

/** A stored record's result preview as `scrub-raw-secrets` reads it. */
const storedRecord = (text: string): Record<string, unknown> => ({
  kind: 'tool_call',
  name: RECORD_TOOL,
  result: { text, totalChars: text.length, truncated: false },
  redactedValues: 0,
});

export function readerOf(
  values: ValuesModule,
  stream: StreamModule,
  records: RecordModule,
): Reader {
  return {
    whole: (text) => values.scrubSecretValues(text),
    stream(text, cuts) {
      const scrubber = stream.createSecretStreamScrubber();
      let out = '';
      let from = 0;
      for (const cut of cuts) {
        out += scrubber.push(text.slice(from, cut)).value;
        from = cut;
      }
      out += scrubber.push(text.slice(from)).value;
      return out + scrubber.flush().value;
    },
    stored(text) {
      const repaired = values.repairSplitQuotedMasks?.(text) ?? { value: text, redactedValues: 0 };
      const scrubbed = values.scrubSecretValues(repaired.value, {
        patterns: values.STORED_REWRITE_SECRET_PATTERNS,
      });
      return {
        value: scrubbed.value,
        redactedValues: repaired.redactedValues + scrubbed.redactedValues,
      };
    },
    record(text) {
      const record = records.buildToolCallRecord({
        toolCallId: 'call_1',
        name: RECORD_TOOL,
        outcome: 'done',
        hasArgs: false,
        result: { content: [{ type: 'text', text }] },
        hasResult: true,
        startedAt: null,
        endedAt: null,
      });
      return record.result?.text ?? '';
    },
    recordRewrite(text) {
      const { value, redactedValues } = records.rescrubStoredToolCallResult(storedRecord(text));
      const result = value.result as { text: string };
      return { value: result.text, redactedValues };
    },
    recordUnproven: (text) =>
      records.storedToolCallResultTailUnproven?.(storedRecord(text)) ?? false,
  };
}

/** The most characters between two cuts of a row's dense set. */
export const DENSE_STEP_MAX = 4;

/** Where a row is cut for the stream reading, from the row's own seed: `sets` sets of 1–6 cuts
 *  anywhere, then — `sets` above 0 — one dense set, a cut every 1–`DENSE_STEP_MAX` characters, as
 *  a Turn's `textDelta`s come (review #493 on #1619: with 1–6 cuts a row, what the stream holds
 *  back and the text it looks back into were barely read). */
export function cutsFor(seed: number, text: string, sets: number): number[][] {
  const r: Rng = mulberry32(rowSeed(seed, text));
  const out: number[][] = [];
  for (let s = 0; s < sets; s += 1) {
    const n = 1 + int(r, 6);
    out.push(Array.from({ length: n }, () => int(r, text.length + 1)).sort((a, b) => a - b));
  }
  if (sets > 0) {
    const dense: number[] = [];
    const step = () => 1 + int(r, DENSE_STEP_MAX);
    for (let at = step(); at < text.length; at += step()) dense.push(at);
    out.push(dense);
  }
  return out;
}

/** The comparison of one version (`now`) against a release (`before`) on one set of rows. */
export interface Comparison {
  readonly rows: number;
  /** Rows where `now` shows a secret character `before` hid: the gate (design doc §4.4 item 1). */
  readonly showsMore: {
    readonly whole: number;
    /** The same cuts for both. */
    readonly stream: number;
    /** Rows `before` wrote (its whole reading), rewritten by each. */
    readonly stored: number;
    /** Each one's whole reading read again by itself. */
    readonly reread: number;
  };
  /** Record rows (`Row.record`) this checkout's rewrite on upgrade gets wrong (review #501 on
   *  #1629: what it changes is known, not only counted), gated at 0 by `acceptance.ts`:
   *  - `twice`: it changes the release's record a second time, or the record this checkout stores
   *    — the rewrite runs on every upgrade;
   *  - `needless`: it changes a record and hides no secret character the record showed, or drops
   *    the cut's note line the record had (design D3: a rewrite that hides past a secret);
   *  - `left`: the rewritten record still shows a secret — counted as 收尾未证明
   *    (`storedToolCallResultTailUnproven`) or not: a value an old cut kept is hidden by the
   *    rewrite, a quoted one the cut left open included (review #501 on #1629). */
  readonly records: {
    readonly twice: number;
    readonly needless: number;
    readonly left: number;
  };
  /** Rows where some stream reading's text is not the same one's whole text, for each (the design's
   *  I-R3 (b), §8): `now` gated by `acceptance.ts`. A stream that hides more than its whole reading
   *  counts here, and in no column above: those count only what shows (review #493 on #1619, the
   *  quote-blanks hold). */
  readonly streamDiffers: { readonly now: number; readonly before: number };
  /** Reported, not gated. */
  readonly info: {
    /** Rows where any secret character shows, for each, in its whole reading — a stored row's
     *  (`Row.stored`) in its stored reading, by `shownInRuns`. */
    readonly showing: { readonly now: number; readonly before: number };
    /** Secret characters shown in all, for each, in the same reading. */
    readonly shownChars: { readonly now: number; readonly before: number };
    /** Rows where `now` hides a secret character `before` showed. */
    readonly hidesMore: number;
    /** Rows whose whole output differs between the two. */
    readonly differs: number;
    /** Rows where some stream reading shows a secret character the same one's whole reading hid. */
    readonly streamShowsMoreThanWhole: { readonly now: number; readonly before: number };
    /** Rows whose whole output, read again by the same one, changes (I-R3). */
    readonly rereadChanges: { readonly now: number; readonly before: number };
    /** Rows of its own the same one's stored rewrite changes again. */
    readonly storedChangesOwn: { readonly now: number; readonly before: number };
    /** Rows the release stored that each one's rewrite on upgrade changes: the release's whole
     *  reading, a stored row itself, the release's record of a record row. */
    readonly rewrites: { readonly now: number; readonly before: number };
    /** Record rows whose record, once this checkout rewrote it, `scrub-raw-secrets` counts as
     *  收尾未证明. */
    readonly recordsUnproven: number;
    /** Rows where `now`'s count and text disagree: changed with 0 counted, or counted unchanged. */
    readonly countDisagrees: number;
    /** Rows an output of `now` could not be lined up with its input (counted as showing all). */
    readonly unaligned: number;
  };
  /** Up to `examples` rows for each gated reading, to read; `streamNotWhole`: rows whose stream
   *  `now` is not its whole text and `before`'s is — `now` the stream's text, `before` the whole's;
   *  `twice`, `needless`, `left` (`records`): `now` the rewritten record (or what rewriting it
   *  again wrote), `before` the release's. */
  readonly examples: Record<string, { t: string; now: string; before: string }[]>;
}

export interface CompareOptions {
  readonly seed: number;
  /** Stream cut sets per row (default 2), and the dense one (`cutsFor`). */
  readonly cutSets?: number;
  readonly examples?: number;
}

export function compare(
  rows: readonly Row[],
  now: Reader,
  before: Reader,
  options: CompareOptions,
): Comparison {
  const gate = { whole: 0, stream: 0, stored: 0, reread: 0 };
  const info = {
    showing: { now: 0, before: 0 },
    shownChars: { now: 0, before: 0 },
    hidesMore: 0,
    differs: 0,
    streamShowsMoreThanWhole: { now: 0, before: 0 },
    rereadChanges: { now: 0, before: 0 },
    storedChangesOwn: { now: 0, before: 0 },
    rewrites: { now: 0, before: 0 },
    recordsUnproven: 0,
    countDisagrees: 0,
    unaligned: 0,
  };
  const streamDiffers = { now: 0, before: 0 };
  const examples: Comparison['examples'] = {
    whole: [],
    stream: [],
    stored: [],
    reread: [],
    streamNotWhole: [],
    twice: [],
    needless: [],
    left: [],
  };
  const keep = options.examples ?? 3;
  const note = (kind: keyof typeof gate, t: string, a: string, b: string) => {
    gate[kind] += 1;
    const list = examples[kind] as { t: string; now: string; before: string }[];
    if (list.length < keep) list.push({ t, now: a, before: b });
  };

  const records = { twice: 0, needless: 0, left: 0 };
  /** A record row the rewrite gets wrong: `now` the rewritten record, `before` the release's. */
  const wrong = (kind: keyof typeof records, t: string, a: string, b: string) => {
    records[kind] += 1;
    const list = examples[kind] as { t: string; now: string; before: string }[];
    if (list.length < keep) list.push({ t, now: a, before: b });
  };
  for (const row of rows) {
    const places = secretPlaces(row);
    if (row.record === true) {
      // A tool result: stored as a record by each (the whole gate), and the record the release
      // stored rewritten on upgrade by each (the stored gate). A record is not its result with
      // stretches masked (a value it hides inside a JSON string is written escaped), so both are
      // read by `shownInRuns`.
      const kept = before.record(row.t);
      const live = now.record(row.t);
      if (showsMore(shownInRuns(row, places, live), shownInRuns(row, places, kept))) {
        note('whole', row.t, live, kept);
      }
      const stNow = now.recordRewrite(kept);
      const stBefore = before.recordRewrite(kept);
      const sNow = shownInRuns(row, places, stNow.value);
      const sBefore = shownInRuns(row, places, stBefore.value);
      if (any(sNow)) info.showing.now += 1;
      if (any(sBefore)) info.showing.before += 1;
      info.shownChars.now += count(sNow);
      info.shownChars.before += count(sBefore);
      if (stNow.value !== stBefore.value) info.differs += 1;
      if (showsMore(sNow, sBefore)) note('stored', row.t, stNow.value, stBefore.value);
      if (showsMore(sBefore, sNow)) info.hidesMore += 1;
      if ((stNow.value !== kept) !== stNow.redactedValues > 0) info.countDisagrees += 1;
      if (stNow.value !== kept) info.rewrites.now += 1;
      if (stBefore.value !== kept) info.rewrites.before += 1;
      const again = now.recordRewrite(stNow.value);
      const own = now.recordRewrite(live);
      if (
        again.value !== stNow.value ||
        again.redactedValues > 0 ||
        own.value !== live ||
        own.redactedValues > 0
      ) {
        wrong('twice', row.t, again.value === stNow.value ? own.value : again.value, stNow.value);
        info.storedChangesOwn.now += 1;
      }
      const sKept = shownInRuns(row, places, kept);
      const noteLost = CUT_NOTE.test(kept) && !CUT_NOTE.test(stNow.value);
      if (stNow.value !== kept && (!showsMore(sKept, sNow) || noteLost)) {
        wrong('needless', row.t, stNow.value, kept);
      }
      if (now.recordUnproven(stNow.value)) info.recordsUnproven += 1;
      if (any(sNow)) wrong('left', row.t, stNow.value, kept);
      if (before.recordRewrite(stBefore.value).value !== stBefore.value) {
        info.storedChangesOwn.before += 1;
      }
      continue;
    }
    if (row.stored === true) {
      // A row an earlier release stored: rewritten on upgrade by each, and nothing else.
      const stNow = now.stored(row.t).value;
      const stBefore = before.stored(row.t).value;
      const sNow = shownInRuns(row, places, stNow);
      const sBefore = shownInRuns(row, places, stBefore);
      if (any(sNow)) info.showing.now += 1;
      if (any(sBefore)) info.showing.before += 1;
      info.shownChars.now += count(sNow);
      info.shownChars.before += count(sBefore);
      if (stNow !== stBefore) info.differs += 1;
      if (showsMore(sNow, sBefore)) note('stored', row.t, stNow, stBefore);
      if (showsMore(sBefore, sNow)) info.hidesMore += 1;
      if (stNow !== row.t) info.rewrites.now += 1;
      if (stBefore !== row.t) info.rewrites.before += 1;
      if (now.stored(stNow).value !== stNow) info.storedChangesOwn.now += 1;
      if (before.stored(stBefore).value !== stBefore) info.storedChangesOwn.before += 1;
      continue;
    }
    const wNow = now.whole(row.t);
    const wBefore = before.whole(row.t);
    if (keptChars(row.t, wNow.value) === undefined) info.unaligned += 1;
    if ((wNow.value !== row.t) !== wNow.redactedValues > 0) info.countDisagrees += 1;
    if (wNow.value !== wBefore.value) info.differs += 1;
    const sNow = shown(row, places, wNow.value);
    const sBefore = shown(row, places, wBefore.value);
    if (any(sNow)) info.showing.now += 1;
    if (any(sBefore)) info.showing.before += 1;
    info.shownChars.now += count(sNow);
    info.shownChars.before += count(sBefore);
    if (showsMore(sNow, sBefore)) note('whole', row.t, wNow.value, wBefore.value);
    if (showsMore(sBefore, sNow)) info.hidesMore += 1;

    let streamMore = false;
    let nowOverWhole = false;
    let beforeOverWhole = false;
    let nowNotWhole = false;
    let beforeNotWhole = false;
    for (const cuts of cutsFor(options.seed, row.t, options.cutSets ?? 2)) {
      const a = now.stream(row.t, cuts);
      const b = before.stream(row.t, cuts);
      if (a !== wNow.value && !nowNotWhole) {
        nowNotWhole = true;
        const list = examples.streamNotWhole as { t: string; now: string; before: string }[];
        if (b === wBefore.value && list.length < keep) {
          list.push({ t: `${row.t}  (cuts ${cuts.join(',')})`, now: a, before: wNow.value });
        }
      }
      if (b !== wBefore.value) beforeNotWhole = true;
      const shownA = shown(row, places, a);
      const shownB = shown(row, places, b);
      if (!streamMore && showsMore(shownA, shownB)) {
        streamMore = true;
        note('stream', `${row.t}  (cuts ${cuts.join(',')})`, a, b);
      }
      if (showsMore(shownA, sNow)) nowOverWhole = true;
      if (showsMore(shownB, sBefore)) beforeOverWhole = true;
    }
    if (nowNotWhole) streamDiffers.now += 1;
    if (beforeNotWhole) streamDiffers.before += 1;
    if (nowOverWhole) info.streamShowsMoreThanWhole.now += 1;
    if (beforeOverWhole) info.streamShowsMoreThanWhole.before += 1;

    // Rows the release wrote, rewritten on upgrade by each.
    const stNow = now.stored(wBefore.value).value;
    const stBefore = before.stored(wBefore.value).value;
    if (
      showsMore(
        shownThrough(row, places, wBefore.value, stNow),
        shownThrough(row, places, wBefore.value, stBefore),
      )
    ) {
      note('stored', row.t, stNow, stBefore);
    }
    if (stNow !== wBefore.value) info.rewrites.now += 1;
    if (stBefore !== wBefore.value) info.rewrites.before += 1;
    if (now.stored(wNow.value).value !== wNow.value) info.storedChangesOwn.now += 1;
    if (stBefore !== wBefore.value) info.storedChangesOwn.before += 1;

    const rNow = now.whole(wNow.value).value;
    const rBefore = before.whole(wBefore.value).value;
    if (rNow !== wNow.value) info.rereadChanges.now += 1;
    if (rBefore !== wBefore.value) info.rereadChanges.before += 1;
    if (
      showsMore(
        shownThrough(row, places, wNow.value, rNow),
        shownThrough(row, places, wBefore.value, rBefore),
      )
    ) {
      note('reread', row.t, rNow, rBefore);
    }
  }
  return { rows: rows.length, showsMore: gate, records, streamDiffers, info, examples };
}
