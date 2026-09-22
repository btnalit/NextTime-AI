import type { Tone } from './status-tone.js';

/**
 * lib/graph-freshness: the graph page's freshness colouring (S6-D, docs/console-completion-plan.md
 * §5.7 "新鲜度（`last_observed_at`）着色"; semantics from docs/development-tasks.md §S5.2 and
 * design doc §5.5). Pure: every function takes `asOf` so tests are deterministic and the page's
 * "截至 As of" time travel (`state_at{at}`) colours a Fact relative to the instant being viewed,
 * not to the wall clock.
 *
 * Tones are the six semantic tones of §5.9 principle 2 — one colour, one meaning — and nothing
 * else: `ok` = observed inside the window, `warn` = active but older than the window, `neutral`
 * (grey) = superseded / invalidated / never observed, `danger` = in an open Conflict or
 * `contradicted`. No `info` / `observe` / `accent` here: freshness is never "clickable" or "system".
 *
 * The observation window is not exposed by any capability today (reported as a kernel gap — "expose
 * the observation window"): `OBSERVATION_WINDOW_MS` mirrors the kernel's own default for the
 * `ops.collector_silent` invariant (`DEFAULT_COLLECTOR_SILENCE_THRESHOLD_MS`, `packages/kernel/src/
 * substrate/audit/invariant-checks.ts`, 2 hours ≈ eight 15-minute collector rounds) — the web
 * package depends only on `@nexttime/shared`, so the value is restated here, and the page prints
 * it in its legend so a reader knows what "fresh" means on this deployment.
 */
export const OBSERVATION_WINDOW_MS = 2 * 60 * 60 * 1000;

export type FreshnessKind =
  /** `lastObservedAt` within the window of `asOf` (S5.2: a same-origin re-observation). */
  | 'fresh'
  /** Still active, but the last observation is older than the window — the Source may have
   *  stopped observing it (ops.collector_silent territory) or the Object simply left the view. */
  | 'aging'
  /** No observation clock at all: a human / agent `assert_fact` (or an Object never touched by a
   *  Source) — deliberately not a warning (S5.2: "有意的区别，不是缺口"). */
  | 'unobserved'
  /** Invalidated by an observation window (`invalidation_reason = 'not_reobserved'`). */
  | 'not_reobserved'
  /** Invalidated for any other reason (`invalidate_fact`, `resolve_conflict`). */
  | 'invalidated'
  /** Superseded by a newer same-origin Fact (I4 lifecycle). */
  | 'superseded'
  /** In an open Conflict, or `epistemicStatus === 'contradicted'`. */
  | 'conflict';

export interface FreshnessInput {
  /** `ObjectWire.lastObservedAt` / `FactWire.lastObservedAt`; `explain`'s
   *  `fact.lastObservation?.createdAt` maps here too. */
  readonly lastObservedAt: string | null | undefined;
  readonly supersededAt?: string | null;
  readonly invalidatedAt?: string | null;
  readonly invalidationReason?: string | null;
  readonly epistemicStatus?: string;
  /** The row is a side of an open Conflict (`list_conflicts{status:'open'}`, matched by
   *  `factAId` / `factBId` on the page — the capability has no per-Fact filter). */
  readonly inConflict?: boolean;
}

export interface Freshness {
  readonly kind: FreshnessKind;
  readonly tone: Tone;
  /** Bilingual chip text (B4). */
  readonly label: string;
  /** Milliseconds between the last observation and `asOf` — `null` without an observation clock. */
  readonly ageMs: number | null;
}

const LABELS: Readonly<Record<FreshnessKind, string>> = {
  fresh: '新鲜 Fresh',
  aging: '陈旧 Aging',
  unobserved: '无观测 No observation',
  not_reobserved: '未再观测 Not re-observed',
  invalidated: '已失效 Invalidated',
  superseded: '已替代 Superseded',
  conflict: '冲突 Conflict',
};

const TONES: Readonly<Record<FreshnessKind, Tone>> = {
  fresh: 'ok',
  aging: 'warn',
  unobserved: 'neutral',
  not_reobserved: 'neutral',
  invalidated: 'neutral',
  superseded: 'neutral',
  conflict: 'danger',
};

/** One row per kind, in display order — the page's legend and the tests both walk it. */
export const FRESHNESS_LEGEND: readonly {
  readonly kind: FreshnessKind;
  readonly tone: Tone;
  readonly label: string;
  readonly description: string;
}[] = [
  {
    kind: 'fresh',
    tone: 'ok',
    label: LABELS.fresh,
    description: '观测窗口内再次确认 Re-observed within the window',
  },
  {
    kind: 'aging',
    tone: 'warn',
    label: LABELS.aging,
    description: '仍有效，但最近观测早于窗口 Active, last observed before the window',
  },
  {
    kind: 'unobserved',
    tone: 'neutral',
    label: LABELS.unobserved,
    description: '人工或 agent 断言，没有观测时钟 Asserted, no observation clock',
  },
  {
    kind: 'not_reobserved',
    tone: 'neutral',
    label: LABELS.not_reobserved,
    description: '来源的完整视图里已不存在 Absent from the Source’s complete view',
  },
  {
    kind: 'invalidated',
    tone: 'neutral',
    label: LABELS.invalidated,
    description: '被显式失效 Explicitly invalidated',
  },
  {
    kind: 'superseded',
    tone: 'neutral',
    label: LABELS.superseded,
    description: '同源更新的事实替代了它 Replaced by a newer same-origin Fact',
  },
  {
    kind: 'conflict',
    tone: 'danger',
    label: LABELS.conflict,
    description: '在未解决的冲突中或已被反驳 In an open Conflict, or contradicted',
  },
];

function parseMs(iso: string | null | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Freshness of a Fact or Object as of `asOf` (default: now). Precedence, first match wins:
 * conflict → superseded → invalidated (`not_reobserved` when that is the reason) → unobserved →
 * fresh / aging by age against `windowMs`. A lifecycle end *after* `asOf` does not count — the
 * row was still active at the instant being viewed (`state_at` semantics: `superseded_at > at`).
 */
export function freshnessOf(
  input: FreshnessInput,
  asOf: number = Date.now(),
  windowMs: number = OBSERVATION_WINDOW_MS,
): Freshness {
  const observed = parseMs(input.lastObservedAt);
  const ageMs = observed === undefined ? null : Math.max(0, asOf - observed);
  const superseded = parseMs(input.supersededAt);
  const invalidated = parseMs(input.invalidatedAt);

  let kind: FreshnessKind;
  if (input.inConflict === true || input.epistemicStatus === 'contradicted') kind = 'conflict';
  else if (superseded !== undefined && superseded <= asOf) kind = 'superseded';
  else if (invalidated !== undefined && invalidated <= asOf)
    kind = input.invalidationReason === 'not_reobserved' ? 'not_reobserved' : 'invalidated';
  else if (ageMs === null) kind = 'unobserved';
  else if (ageMs <= windowMs) kind = 'fresh';
  else kind = 'aging';

  return { kind, tone: TONES[kind], label: LABELS[kind], ageMs };
}

/** "2 小时 2 h" — the window, for the legend. Whole hours when it divides evenly, else minutes. */
export function formatWindow(windowMs: number = OBSERVATION_WINDOW_MS): string {
  const minutes = Math.round(windowMs / 60_000);
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} 小时 ${hours} h`;
  }
  return `${minutes} 分钟 ${minutes} min`;
}
