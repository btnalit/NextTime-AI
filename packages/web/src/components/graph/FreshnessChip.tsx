import { type Freshness, type FreshnessInput, freshnessOf } from '../../lib/graph-freshness.js';

export interface FreshnessChipProps {
  /** Either an already-computed `Freshness` or the wire fields to compute one from. */
  readonly freshness?: Freshness;
  readonly input?: FreshnessInput;
  /** The instant freshness is judged against (ms) — the page's frozen `at`. */
  readonly asOf?: number;
  readonly size?: 's' | 'm';
  readonly testId?: string;
}

/**
 * components/graph/FreshnessChip: the freshness tone of a Fact or Object (`lib/graph-freshness.ts`)
 * as a chip. Composes the `chip chip-<tone>` classes `ui/StatusChip` also uses rather than going
 * through it: `StatusChip` takes a `StatusMachine` from `lib/status-tone.ts`, and freshness is a
 * derived state, not a wire enum — adding a machine there is outside this lane (reported: a free
 * `tone + label` variant of `StatusChip` would let this file go). Same guarantees: the label is
 * always text (§5.9 principle 2 — colour never the only carrier), `data-tone` / `data-freshness`
 * for tests, the full meaning in `title`.
 */
export function FreshnessChip({ freshness, input, asOf, size = 'm', testId }: FreshnessChipProps) {
  const resolved =
    freshness ?? (input ? freshnessOf(input, asOf) : freshnessOf({ lastObservedAt: null }, asOf));
  const classes = ['chip', `chip-${resolved.tone}`, size === 's' ? 'chip-s' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <span
      className={classes}
      data-tone={resolved.tone}
      data-freshness={resolved.kind}
      data-testid={testId}
      title={resolved.label}
    >
      {resolved.label}
    </span>
  );
}
