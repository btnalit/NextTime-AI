import type { PoolClient } from 'pg';
import { z } from 'zod';

/**
 * application/task/quotas: I18's compiled-in defaults + `quotas` table override resolution
 * (design doc §5.4 I18, §9.2 "quotas(workspace_id, key, value jsonb)"; docs/development-tasks.md
 * S2.7 "quota keys ... as workspace policy data ... with compiled-in defaults and a set_quota
 * handler"; migrations/task/0002_quotas.sql).
 *
 * Five keys, one per I18 axis:
 *
 *   - `task.max_depth`                        — invoke_worker derivation-chain depth ceiling.
 *   - `task.max_concurrent_worker_runs_per_user` — per-`on_behalf_of` concurrent WorkerRuns.
 *   - `task.default_token_budget`             — per-Task token budget (recorded on the Task at
 *                                                invoke time; `null` = unlimited).
 *   - `task.default_duration_limit_sec`       — per-Task wall-clock duration limit (also becomes
 *                                                the supervisor spawn's `timeoutSec` and the
 *                                                child Handle's ttl).
 *   - `task.daily_cost_budget_usd`            — per-workspace daily `llm_usage.cost_usd` sum cap
 *                                                (`governance/llm-usage`'s `sumTodayCostUsd`);
 *                                                `null` = unlimited.
 *
 * `HARD_MAX_DEPTH` (3) is I18's own invariant, not a workspace-adjustable default — a workspace
 * may only ever *tighten* `task.max_depth` below it, never loosen past it (`resolveQuotas` clamps
 * this on every read, so a stray `set_quota` write above 3 — blocked at write time too, see
 * `QUOTA_VALUE_SCHEMAS` below — can never silently take effect even if one somehow landed).
 */

export const HARD_MAX_DEPTH = 3;

export const QUOTA_KEY_VALUES = [
  'task.max_depth',
  'task.max_concurrent_worker_runs_per_user',
  'task.default_token_budget',
  'task.default_duration_limit_sec',
  'task.daily_cost_budget_usd',
] as const;
export type QuotaKey = (typeof QUOTA_KEY_VALUES)[number];

export function isQuotaKey(key: string): key is QuotaKey {
  return (QUOTA_KEY_VALUES as readonly string[]).includes(key);
}

/** Compiled-in defaults (docs/development-tasks.md S2.7 "compiled-in defaults"): applied whenever
 *  a workspace has no `quotas` row for a given key. `task.default_duration_limit_sec` mirrors
 *  `worker-supervisor`'s own `TASK_MAX_RUNTIME_SEC` default (3600s, `packages/worker-supervisor/
 *  README.md`) so a Task's recorded duration limit and its container's own supervisor-enforced
 *  timeout agree unless a workspace explicitly overrides one. */
export const DEFAULT_QUOTA_VALUES: {
  readonly [K in QuotaKey]: number | null;
} = {
  'task.max_depth': HARD_MAX_DEPTH,
  'task.max_concurrent_worker_runs_per_user': 5,
  'task.default_token_budget': 200_000,
  'task.default_duration_limit_sec': 3600,
  'task.daily_cost_budget_usd': null,
};

/** Per-key value validation for `set_quota` (`application/task/service.ts`'s `setQuotaValue`) —
 *  every key here is a single number (or `null` for the two "unlimited" axes), never an object,
 *  so one shared numeric-or-null shape per key is enough; kept as a map (rather than one schema)
 *  so a future non-numeric quota key does not have to fit the same shape. */
export const QUOTA_VALUE_SCHEMAS: { readonly [K in QuotaKey]: z.ZodType } = {
  'task.max_depth': z.number().int().min(0).max(HARD_MAX_DEPTH),
  'task.max_concurrent_worker_runs_per_user': z.number().int().min(0),
  'task.default_token_budget': z.number().int().min(0).nullable(),
  'task.default_duration_limit_sec': z.number().int().min(1),
  'task.daily_cost_budget_usd': z.number().min(0).nullable(),
};

export class UnknownQuotaKeyError extends Error {
  constructor(key: string) {
    super(`set_quota: unknown quota key "${key}" — known keys: ${QUOTA_KEY_VALUES.join(', ')}`);
    this.name = 'UnknownQuotaKeyError';
  }
}

export class InvalidQuotaValueError extends Error {
  constructor(key: QuotaKey, message: string) {
    super(`set_quota: invalid value for "${key}": ${message}`);
    this.name = 'InvalidQuotaValueError';
  }
}

export interface ResolvedQuotas {
  readonly maxDepth: number;
  readonly maxConcurrentWorkerRunsPerUser: number;
  readonly defaultTokenBudget: number | null;
  readonly defaultDurationLimitSec: number;
  readonly dailyCostBudgetUsd: number | null;
}

interface QuotaDbRow {
  key: QuotaKey;
  value: number | null;
}

/** Reads every `quotas` row for `workspaceId` and merges it over `DEFAULT_QUOTA_VALUES`.
 *  `task.max_depth` is additionally clamped to `HARD_MAX_DEPTH` regardless of what is stored
 *  (defense in depth — see this module's own doc comment on why loosening past it must never take
 *  effect). */
export async function resolveQuotas(
  client: PoolClient,
  workspaceId: string,
): Promise<ResolvedQuotas> {
  const result = await client.query<QuotaDbRow>(
    'select key, value from quotas where workspace_id = $1 and key = any($2::text[])',
    [workspaceId, QUOTA_KEY_VALUES],
  );
  const overrides = new Map<QuotaKey, number | null>();
  for (const row of result.rows) {
    overrides.set(row.key, row.value);
  }

  const maxDepthRaw = overrides.has('task.max_depth')
    ? (overrides.get('task.max_depth') ?? DEFAULT_QUOTA_VALUES['task.max_depth'])
    : DEFAULT_QUOTA_VALUES['task.max_depth'];

  return {
    maxDepth: Math.min(maxDepthRaw ?? HARD_MAX_DEPTH, HARD_MAX_DEPTH),
    maxConcurrentWorkerRunsPerUser:
      overrides.get('task.max_concurrent_worker_runs_per_user') ??
      DEFAULT_QUOTA_VALUES['task.max_concurrent_worker_runs_per_user'] ??
      0,
    defaultTokenBudget: overrides.has('task.default_token_budget')
      ? (overrides.get('task.default_token_budget') ?? null)
      : DEFAULT_QUOTA_VALUES['task.default_token_budget'],
    defaultDurationLimitSec:
      overrides.get('task.default_duration_limit_sec') ??
      DEFAULT_QUOTA_VALUES['task.default_duration_limit_sec'] ??
      3600,
    dailyCostBudgetUsd: overrides.has('task.daily_cost_budget_usd')
      ? (overrides.get('task.daily_cost_budget_usd') ?? null)
      : DEFAULT_QUOTA_VALUES['task.daily_cost_budget_usd'],
  };
}

export interface SetQuotaInput {
  readonly key: string;
  readonly value: unknown;
  readonly updatedBy: string;
}

export interface QuotaRow {
  readonly workspaceId: string;
  readonly key: QuotaKey;
  readonly value: number | null;
  readonly updatedBy: string;
  readonly updatedAt: Date;
}

/** `set_quota`'s service half (human, owner — `packages/shared/src/capabilities.ts`). Validates
 *  `key` against `QUOTA_KEY_VALUES` and `value` against that key's own schema (throws
 *  `UnknownQuotaKeyError` / `InvalidQuotaValueError`, both readable-enough to relay to the
 *  caller verbatim, same spirit as `QuotaExceededError`), then upserts the override row. */
export async function setQuotaValue(
  client: PoolClient,
  workspaceId: string,
  input: SetQuotaInput,
): Promise<QuotaRow> {
  if (!isQuotaKey(input.key)) {
    throw new UnknownQuotaKeyError(input.key);
  }
  const schema = QUOTA_VALUE_SCHEMAS[input.key];
  const parsed = schema.safeParse(input.value);
  if (!parsed.success) {
    throw new InvalidQuotaValueError(input.key, parsed.error.message);
  }

  const result = await client.query<{
    workspace_id: string;
    key: QuotaKey;
    value: number | null;
    updated_by: string;
    updated_at: Date;
  }>(
    `insert into quotas (workspace_id, key, value, updated_by)
     values ($1, $2, $3::jsonb, $4)
     on conflict (workspace_id, key)
     do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()
     returning workspace_id, key, value, updated_by, updated_at`,
    [workspaceId, input.key, JSON.stringify(parsed.data), input.updatedBy],
  );
  const row = result.rows[0];
  if (!row) throw new Error('setQuotaValue: INSERT ... RETURNING produced no row');
  return {
    workspaceId: row.workspace_id,
    key: row.key,
    value: row.value,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}
