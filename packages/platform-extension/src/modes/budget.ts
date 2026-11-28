/**
 * Legacy 967 stage 1 (`docs/tool-result-and-budget-design-2026-11-27.md` §4.2): a Worker is told
 * to wrap up before its Task's token budget runs out, so a run that would have hit the kernel's
 * hard stop (`failed: budget_exhausted`, no result) reports what it has instead.
 *
 * The extension keeps its own running count of what the kernel will charge this Task, so it never
 * asks the kernel again before a model call:
 * - the starting point is `get_task`'s `tokensUsed` (a Task re-run carries the earlier runs' count);
 * - every model call adds its usage, read from the assistant message pi finishes;
 * - a compaction call goes through `llm-proxy` and is charged too, but pi only reports its usage
 *   on `session_compact`, and not always: without it, the call is counted as the whole context
 *   before compaction plus the summary's output cap, per summarizing call;
 * - a cache-warming refresh (pi replays the last request while a long tool call runs) is charged
 *   as a read of the last request's prompt plus one output token.
 * Over-counting only moves the notice earlier; under-counting is what this avoids.
 *
 * What the kernel charges for one call is, today, the four counts in full
 * (`recordWorkerRunUsage`, `application/task/service.ts`; `llm-proxy` reports input net of the
 * cached part, as pi does). Stage 2 moves that sum into `packages/shared` with the weight for
 * cache reads, and this count calls it.
 *
 * The notice goes in once the budget left is less than `HINT_CALLS` times the last call's charge
 * (each call re-reads the whole conversation, so later calls cost more; a fixed percentage left
 * too little room on a long run), and stays on every later call with the same text, so the
 * request up to it repeats byte for byte and stays cached.
 */

/** The notice goes in when the budget left is less than this many times the last call's charge. */
export const HINT_CALLS = 3;

/** One fixed text: anything that changed from call to call (a number left) would change the
 *  prompt the next call has to repeat. */
export const BUDGET_HINT_TEXT =
  '## NextTime budget notice\n' +
  'This Task’s token budget is nearly used up. Call report_result now with the conclusions you ' +
  'already have, and put what you did not get to check in findings.';

/** pi's default compaction `reserveTokens` (`DEFAULT_COMPACTION_SETTINGS`, pi 1.1.0); the summary
 *  call's output is capped at 80% of it. */
const DEFAULT_RESERVE_TOKENS = 16_384;

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** What the kernel charges a Task for one model call's usage (pi's `Usage` shape). */
export function chargedTokens(usage: unknown): number {
  const fields = recordOf(usage);
  if (!fields) return 0;
  return (
    count(fields.input) + count(fields.output) + count(fields.cacheRead) + count(fields.cacheWrite)
  );
}

/** The prompt part of one call's usage: what replaying that request reads again. */
function promptTokens(usage: unknown): number {
  const fields = recordOf(usage);
  if (!fields) return 0;
  return count(fields.input) + count(fields.cacheRead) + count(fields.cacheWrite);
}

/** The charge assumed for a compaction pi gives no usage for (`CompactionPreparation`). */
export function compactionEstimate(preparation: unknown): number {
  const fields = recordOf(preparation);
  if (!fields) return 0;
  const before = count(fields.tokensBefore);
  const reserve = count(recordOf(fields.settings)?.reserveTokens) || DEFAULT_RESERVE_TOKENS;
  const lengthOf = (value: unknown) => (Array.isArray(value) ? value.length : 0);
  // A split turn summarizes the history and the turn's prefix in two calls (pi's `compact`).
  const calls =
    fields.isSplitTurn === true &&
    lengthOf(fields.turnPrefixMessages) > 0 &&
    lengthOf(fields.messagesToSummarize) > 0
      ? 2
      : 1;
  return calls * (before + Math.floor(0.8 * reserve));
}

export class BudgetTracker {
  /** The Task's budget, once `get_task` gave one; `undefined` means no notice is ever given. */
  private budget: number | undefined;
  /** What the kernel had charged when `get_task` was read. */
  private startingCharge = 0;
  /** What this run's own calls are charged, counted here. */
  private runCharge = 0;
  private lastCall: unknown;
  private lastCallCharge = 0;
  private pendingCompaction: number | undefined;
  private hinting = false;

  /** Reads `get_task`'s `tokenBudget` and `tokensUsed`; a budget of `null`, or either number
   *  unreadable, leaves the notice off for the run. Calls this run made before the read are kept
   *  on top of the kernel's count, which may hold some of them already: an earlier notice, never
   *  a later one. */
  start(task: { readonly tokenBudget?: unknown; readonly tokensUsed?: unknown }): void {
    const { tokenBudget, tokensUsed } = task;
    if (typeof tokenBudget !== 'number' || !Number.isFinite(tokenBudget) || tokenBudget <= 0)
      return;
    if (typeof tokensUsed !== 'number' || !Number.isFinite(tokensUsed) || tokensUsed < 0) return;
    this.budget = tokenBudget;
    this.startingCharge = tokensUsed;
  }

  /** A finished model call (`message_end` of an assistant message). */
  recordCall(usage: unknown): void {
    const charge = chargedTokens(usage);
    this.runCharge += charge;
    if (charge > 0) {
      this.lastCall = usage;
      this.lastCallCharge = charge;
    }
  }

  /** `session_before_compact`: what to count if the compaction ends without usage. */
  compactionStarting(preparation: unknown): void {
    this.pendingCompaction = compactionEstimate(preparation);
  }

  /** `session_compact`, with the compaction entry's `usage` when pi had one. */
  compactionEnded(usage: unknown): void {
    const charge = chargedTokens(usage);
    this.runCharge += charge > 0 ? charge : (this.pendingCompaction ?? 0);
    this.pendingCompaction = undefined;
  }

  /** `session_compact_failed`: a call may have been made and charged all the same. */
  compactionFailed(): void {
    this.runCharge += this.pendingCompaction ?? 0;
    this.pendingCompaction = undefined;
  }

  /** `cache_warming_decision` with `action: "warm"`: pi is about to replay the last request. */
  warmingRefresh(): void {
    this.runCharge += promptTokens(this.lastCall) + 1;
  }

  get charged(): number {
    return this.startingCharge + this.runCharge;
  }

  get limit(): number | undefined {
    return this.budget;
  }

  /** Whether the next model call carries the notice. Once it does, every later call does. */
  shouldHint(): boolean {
    if (this.hinting) return true;
    if (this.budget === undefined) return false;
    const left = this.budget - this.charged;
    this.hinting = left < HINT_CALLS * this.lastCallCharge || left <= 0;
    return this.hinting;
  }
}
