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
}

/** The module shapes a `Reader` is built from — today's and a released tag's alike. */
export interface ValuesModule {
  scrubSecretValues(text: string, options?: unknown): { value: string; redactedValues: number };
  readonly STORED_REWRITE_SECRET_PATTERNS: unknown;
  /** Gone once legacy 919 step 2 lands; a reader without it stores as the rest. */
  readonly repairSplitQuotedMasks?: (text: string) => { value: string; redactedValues: number };
}
export interface StreamModule {
  createSecretStreamScrubber(): {
    push(piece: string): { value: string };
    flush(): { value: string };
  };
}

export function readerOf(values: ValuesModule, stream: StreamModule): Reader {
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
  };
}

/** Where a row is cut for the stream reading: `sets` sets of 1–6 cuts, from the row's own seed. */
export function cutsFor(seed: number, text: string, sets: number): number[][] {
  const r: Rng = mulberry32(rowSeed(seed, text));
  const out: number[][] = [];
  for (let s = 0; s < sets; s += 1) {
    const n = 1 + int(r, 6);
    out.push(Array.from({ length: n }, () => int(r, text.length + 1)).sort((a, b) => a - b));
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
  /** Reported, not gated. */
  readonly info: {
    /** Rows where any secret character shows, for each, in its whole reading. */
    readonly showing: { readonly now: number; readonly before: number };
    /** Secret characters shown in all, for each, in its whole reading. */
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
    /** Rows where `now`'s count and text disagree: changed with 0 counted, or counted unchanged. */
    readonly countDisagrees: number;
    /** Rows an output of `now` could not be lined up with its input (counted as showing all). */
    readonly unaligned: number;
  };
  /** Up to `examples` rows for each gated reading, to read. */
  readonly examples: Record<string, { t: string; now: string; before: string }[]>;
}

export interface CompareOptions {
  readonly seed: number;
  /** Stream cut sets per row (default 2). */
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
    countDisagrees: 0,
    unaligned: 0,
  };
  const examples: Comparison['examples'] = { whole: [], stream: [], stored: [], reread: [] };
  const keep = options.examples ?? 3;
  const note = (kind: keyof typeof gate, t: string, a: string, b: string) => {
    gate[kind] += 1;
    const list = examples[kind] as { t: string; now: string; before: string }[];
    if (list.length < keep) list.push({ t, now: a, before: b });
  };

  for (const row of rows) {
    const places = secretPlaces(row);
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
    for (const cuts of cutsFor(options.seed, row.t, options.cutSets ?? 2)) {
      const a = now.stream(row.t, cuts);
      const b = before.stream(row.t, cuts);
      const shownA = shown(row, places, a);
      const shownB = shown(row, places, b);
      if (!streamMore && showsMore(shownA, shownB)) {
        streamMore = true;
        note('stream', `${row.t}  (cuts ${cuts.join(',')})`, a, b);
      }
      if (showsMore(shownA, sNow)) nowOverWhole = true;
      if (showsMore(shownB, sBefore)) beforeOverWhole = true;
    }
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
  return { rows: rows.length, showsMore: gate, info, examples };
}
