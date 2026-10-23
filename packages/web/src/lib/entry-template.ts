/**
 * lib/entry-template (legacy 145): reading the difference between the entry definition a workspace
 * runs with and the entry template the platform ships (`get_entry_template_status`) — what the
 * notice on the catalog's entry definition shows before anyone asks for an upgrade draft.
 */

/** One line of a line-by-line comparison; `gap` stands for `count` unchanged lines left out. */
export type TextDiffLine =
  | { readonly change: 'same' | 'added' | 'removed'; readonly text: string }
  | { readonly change: 'gap'; readonly count: number };

/** Lines past which the comparison gives up on aligning them and shows the whole of both sides
 *  (an entry prompt is a few hundred lines; the table is `before × after` cells). */
const MAX_ALIGNED_LINES = 4000;

/**
 * `before` → `after`, line by line: a longest-common-subsequence alignment, so a paragraph added
 * in the middle reads as those lines added, not as everything after it changed. Unchanged runs
 * longer than `2 × context` keep `context` lines on each side of a change and fold the rest into
 * a `gap`.
 */
export function lineDiff(before: string, after: string, context = 2): TextDiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const lines: Exclude<TextDiffLine, { change: 'gap' }>[] = [];
  if (a.length > MAX_ALIGNED_LINES || b.length > MAX_ALIGNED_LINES) {
    for (const text of a) lines.push({ change: 'removed', text });
    for (const text of b) lines.push({ change: 'added', text });
    return lines;
  }
  // lcs[i][j]: the longest common subsequence of a[i..] and b[j..].
  const lcs: Uint32Array[] = Array.from(
    { length: a.length + 1 },
    () => new Uint32Array(b.length + 1),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    const row = lcs[i] as Uint32Array;
    const next = lcs[i + 1] as Uint32Array;
    for (let j = b.length - 1; j >= 0; j--) {
      row[j] =
        a[i] === b[j]
          ? (next[j + 1] as number) + 1
          : Math.max(next[j] as number, row[j + 1] as number);
    }
  }
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push({ change: 'same', text: a[i] as string });
      i++;
      j++;
    } else if (
      i < a.length &&
      (j >= b.length ||
        ((lcs[i + 1] as Uint32Array)[j] as number) >= ((lcs[i] as Uint32Array)[j + 1] as number))
    ) {
      // A line replaced reads as the old one out, then the new one in.
      lines.push({ change: 'removed', text: a[i] as string });
      i++;
    } else {
      lines.push({ change: 'added', text: b[j] as string });
      j++;
    }
  }
  return foldUnchanged(lines, context);
}

function foldUnchanged(
  lines: readonly Exclude<TextDiffLine, { change: 'gap' }>[],
  context: number,
): TextDiffLine[] {
  const changed = lines.map((line) => line.change !== 'same');
  const near = (index: number) => {
    for (
      let k = Math.max(0, index - context);
      k <= Math.min(lines.length - 1, index + context);
      k++
    ) {
      if (changed[k]) return true;
    }
    return false;
  };
  const out: TextDiffLine[] = [];
  let folded = 0;
  lines.forEach((line, index) => {
    if (line.change === 'same' && !near(index)) {
      folded++;
      return;
    }
    if (folded > 0) out.push({ change: 'gap', count: folded });
    folded = 0;
    out.push(line);
  });
  if (folded > 0) out.push({ change: 'gap', count: folded });
  return out;
}

/** The capability names the template adds to `current`'s, and the ones it takes out. */
export function capabilityChanges(
  current: readonly string[],
  template: readonly string[],
): { readonly added: string[]; readonly removed: string[] } {
  const now = new Set(current);
  const next = new Set(template);
  return {
    added: template.filter((name) => !now.has(name)),
    removed: current.filter((name) => !next.has(name)),
  };
}
