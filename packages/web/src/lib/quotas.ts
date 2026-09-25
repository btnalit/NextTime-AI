/**
 * lib/quotas: the five I18 quota keys (`application/task/quotas.ts` `QUOTA_KEY_VALUES` in the
 * kernel — not re-exported through `@nexttime/shared`, so mirrored here by hand) with a human
 * label, unit, and the value bounds `set_quota` enforces server-side
 * (`QUOTA_VALUE_SCHEMAS`/`HARD_MAX_DEPTH`, same file). Kept in one place so `ModelsPage`'s
 * read-only table and `governance/QuotaEditSheet`'s editor never drift from each other — extend
 * this file (not either component) if the kernel ever adds a sixth axis.
 */

export const QUOTA_KEY_VALUES = [
  'task.max_depth',
  'task.max_concurrent_worker_runs_per_user',
  'task.default_token_budget',
  'task.default_duration_limit_sec',
  'task.daily_cost_budget_usd',
] as const;
export type QuotaKey = (typeof QUOTA_KEY_VALUES)[number];

export interface QuotaKeyInfo {
  readonly zh: string;
  readonly en: string;
  readonly unit: string;
  readonly min: number;
  /** `undefined` — no upper bound enforced client-side (the kernel still enforces its own). */
  readonly max?: number;
  readonly integer: boolean;
  /** Can this axis be set to "unlimited" (`value: null`)? Only the two budget axes — depth,
   *  concurrency, and duration always resolve to a concrete number (`resolveQuotas`'s own
   *  defaults). */
  readonly nullable: boolean;
}

/** Mirrors kernel `QUOTA_VALUE_SCHEMAS` / `HARD_MAX_DEPTH` (`application/task/quotas.ts`) — keep
 *  in sync by hand if either changes; `set_quota` is the final authority regardless of what this
 *  form allows through. */
export const QUOTA_KEY_INFO: Readonly<Record<QuotaKey, QuotaKeyInfo>> = {
  'task.max_depth': {
    zh: '派生链深度上限',
    en: 'Max invoke_worker depth',
    unit: '',
    min: 0,
    max: 3,
    integer: true,
    nullable: false,
  },
  'task.max_concurrent_worker_runs_per_user': {
    zh: '每用户并发 WorkerRun 数',
    en: 'Concurrent WorkerRuns per user',
    unit: '',
    min: 0,
    integer: true,
    nullable: false,
  },
  'task.default_token_budget': {
    zh: '每 Task token 预算',
    en: 'Per-Task token budget',
    unit: 'tokens',
    min: 0,
    integer: true,
    nullable: true,
  },
  'task.default_duration_limit_sec': {
    zh: '每 Task 时长上限',
    en: 'Per-Task duration limit',
    unit: 's',
    min: 1,
    integer: true,
    nullable: false,
  },
  'task.daily_cost_budget_usd': {
    zh: '每工作区日成本',
    en: 'Daily cost budget',
    unit: 'USD',
    min: 0,
    integer: false,
    nullable: true,
  },
};
