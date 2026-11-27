import type { Rng } from './rng.js';

/**
 * One generated line of text and what in it is a secret value (design doc
 * `docs/redaction-boundary-design-2026-11-27.md` §7 stage 1a, I-R5).
 *
 * - `t`: the text, as a tool result or a reply would carry it.
 * - `req`: secrets the text holds that a reader must hide — every place each one occurs counts.
 *   The generators the seats wrote mark secrets this way.
 * - `spans`: where in `t` the secret values are, `[start, end)`, when the generator knows (the
 *   real-format corpus writes each value and records where it put it).
 *
 * What counts as shown is the characters of these places a reader's output still holds.
 */
export interface Row {
  readonly t: string;
  readonly req?: readonly string[];
  readonly spans?: readonly (readonly [number, number])[];
}

/** `n` distinct rows from a seeded source. */
export type Generator = (rng: Rng, n: number) => Row[];

/** The places of `row`'s secrets in its text: its spans, then every occurrence of each `req`. */
export function secretPlaces(row: Row): Uint8Array {
  const places = new Uint8Array(row.t.length);
  for (const [start, end] of row.spans ?? []) places.fill(1, start, end);
  for (const secret of row.req ?? []) {
    if (secret.length === 0) continue;
    for (let at = row.t.indexOf(secret); at >= 0; at = row.t.indexOf(secret, at + 1)) {
      places.fill(1, at, at + secret.length);
    }
  }
  return places;
}

/** Up to `n` distinct rows from `line`, drawing at most `n * tries` times: some generators repeat
 *  themselves often, and a run reports how many distinct rows it read. */
export function distinctRows(
  r: Rng,
  n: number,
  line: (r: Rng) => Row | undefined,
  tries = 20,
): Row[] {
  const seen = new Set<string>();
  const rows: Row[] = [];
  for (let i = 0; i < n * tries && rows.length < n; i += 1) {
    const row = line(r);
    if (row === undefined || seen.has(row.t)) continue;
    seen.add(row.t);
    rows.push(row);
  }
  return rows;
}

/** A row whose secret is one marker, wherever it occurs. */
export const marked = (t: string, marker: string): Row => ({ t, req: [marker] });
