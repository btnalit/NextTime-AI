/**
 * application/eval-seal/span-index: the pure half of the evaluation seal (S10 E3-1c) — how text is
 * normalized, and the set of every {@link SEAL_SPAN_CHARS}-character window of a holdout case's
 * text, kept as hashes. Nothing here reads the database or writes anywhere: an index lives in the
 * kernel process's memory only (`seal.ts` holds one per workspace) and is never logged, serialized
 * or put in an error.
 *
 * Normalized means: NFKC (full-width and compatibility forms fold to their plain ones), lower case,
 * every run of whitespace one space, trimmed — so re-spacing, re-wrapping or re-casing a holdout
 * text does not get it past the seal. Anything else (re-wording, translating, splitting it across
 * fields) does; the seal stops verbatim copies, the cheapest leak, not paraphrase.
 */

/** How long a run of normalized holdout text must be to count as a copy of it (E3-1 fork (a)). */
export const SEAL_SPAN_CHARS = 40;

/** A suite's canary as `eval_suites` stores it (`NTEVAL-` and 32 hex digits), normalized. */
const CANARY_PATTERN = /nteval-[0-9a-f]{32}/g;

/** `text` as the seal compares it. */
export function normalizeSealText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

/** Every string a JSON-shaped value holds — its string leaves and its object keys. */
export function sealStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) sealStrings(item, out);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      sealStrings(item, out);
    }
  }
  return out;
}

/** The canaries `normalized` holds (normalized text, so lower case). */
export function canariesIn(normalized: string): string[] {
  return normalized.match(CANARY_PATTERN) ?? [];
}

// Two polynomial rolling hashes over UTF-16 code units, each modulo a prime below 2^31, packed into
// one key below 2^53 (an exact double): 31 bits of the first, 22 of the second. Every product stays
// below 2^53 by splitting the multiplier into 16-bit halves.
const P1 = 2_147_483_647;
const P2 = 2_147_483_629;
const B1 = 911_382_323;
const B2 = 972_663_749;
const SECOND_BITS = 2 ** 22;

function mulMod(a: number, b: number, p: number): number {
  const high = ((a * Math.floor(b / 65_536)) % p) * 65_536;
  return (high + a * (b % 65_536)) % p;
}

function powMod(base: number, exponent: number, p: number): number {
  let result = 1;
  for (let i = 0; i < exponent; i++) result = mulMod(result, base, p);
  return result;
}

/** `B^(SEAL_SPAN_CHARS - 1)`, what the leaving character was multiplied by. */
const LEAD1 = powMod(B1, SEAL_SPAN_CHARS - 1, P1);
const LEAD2 = powMod(B2, SEAL_SPAN_CHARS - 1, P2);

/** Calls `visit` with the key of every {@link SEAL_SPAN_CHARS}-unit window of `normalized`, in
 *  order; stops early (and returns true) when `visit` does. */
function eachWindowKey(normalized: string, visit: (key: number) => boolean): boolean {
  if (normalized.length < SEAL_SPAN_CHARS) return false;
  let h1 = 0;
  let h2 = 0;
  for (let i = 0; i < normalized.length; i++) {
    const unit = normalized.charCodeAt(i);
    if (i >= SEAL_SPAN_CHARS) {
      const leaving = normalized.charCodeAt(i - SEAL_SPAN_CHARS);
      h1 = (h1 - mulMod(leaving, LEAD1, P1) + P1) % P1;
      h2 = (h2 - mulMod(leaving, LEAD2, P2) + P2) % P2;
    }
    h1 = (mulMod(h1, B1, P1) + unit) % P1;
    h2 = (mulMod(h2, B2, P2) + unit) % P2;
    if (i >= SEAL_SPAN_CHARS - 1 && visit(h1 * SECOND_BITS + (h2 % SECOND_BITS))) return true;
  }
  return false;
}

/**
 * The windows of a workspace's holdout text, as keys. Holds no text: a key cannot be turned back
 * into the window it came from, so even a dump of the process's memory shows only numbers.
 */
export class SealSpanIndex {
  readonly #keys = new Set<number>();

  /** Adds every window of `text` (any string; normalized here). */
  add(text: string): void {
    eachWindowKey(normalizeSealText(text), (key) => {
      this.#keys.add(key);
      return false;
    });
  }

  /** Whether some window of `normalized` (already {@link normalizeSealText}-ed) is in the index. */
  holdsWindowOf(normalized: string): boolean {
    if (this.#keys.size === 0) return false;
    return eachWindowKey(normalized, (key) => this.#keys.has(key));
  }

  /** Whether some window of `normalized` is in the index and not in `allowed` (S10 E3-2a: an
   *  evaluation Task's own input, which its Worker is meant to read). */
  holdsWindowOutside(normalized: string, allowed: SealSpanIndex): boolean {
    if (this.#keys.size === 0) return false;
    return eachWindowKey(normalized, (key) => this.#keys.has(key) && !allowed.#keys.has(key));
  }

  get size(): number {
    return this.#keys.size;
  }
}
