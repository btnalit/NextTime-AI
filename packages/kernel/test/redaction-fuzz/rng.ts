/** Seeded randomness for the generators: mulberry32, as every generator here has used. */
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A whole number in `[0, n)`. */
export const int = (r: Rng, n: number): number => Math.floor(r() * n);

/** A number in `[from, to]`, both included (Python's `randint`). */
export const between = (r: Rng, from: number, to: number): number => from + int(r, to - from + 1);

export function pick<T>(r: Rng, items: readonly T[]): T {
  return items[int(r, items.length)] as T;
}

/** A seed for one row's own choices (its stream cuts), from the run's seed and the row's text, so
 *  that every version under comparison reads the row at the same cuts. */
export function rowSeed(seed: number, text: string): number {
  let h = (seed ^ 0x9e3779b9) | 0;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h | 0;
}
