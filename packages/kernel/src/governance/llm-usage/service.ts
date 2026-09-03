import type { PoolClient } from 'pg';
import { z } from 'zod';
import { enqueue } from '../../substrate/outbox/index.js';

/**
 * governance/llm-usage/service: ingests usage reports from `llm-proxy` (design doc §7.7, §13
 * "用量上报有 outbox 式重放"; docs/development-tasks.md S1.7) into `llm_usage`
 * (migrations/llm-usage/0001_llm_usage.sql), and evaluates the per-workspace daily token budget
 * (I18-adjacent — the full quota system lands in S2.7; this is just the 80% warning half named
 * explicitly in the S1.7 task brief).
 *
 * `recordUsage` takes an already-open `PoolClient` (same convention as
 * governance/capability/handles.ts) — the caller is expected to already be running inside
 * `withWorkspace(...)`. Unlike that module's Handle writes, this one does **not** need
 * `skipRoleSwitch`: `llm_usage`'s RLS predicate is workspace-only (no `app_principal()`
 * comparison), so running under the ordinary `nexttime_app` role gets `with check (workspace_id =
 * app_workspace())` for free — the caller's `principalId` context value is inert to this table's
 * policy either way. `interfaces/http/internal/llm-usage.ts` passes the record's own `sessionId`
 * as that inert `principalId` (there is no authenticated human/agent principal on this
 * kernel-internal route — see that file's own doc comment).
 */

// -------------------------------------------------------------------------------------------
// Wire shape
// -------------------------------------------------------------------------------------------

/**
 * One normalized usage record, as POSTed (as a JSON array, batched) to `/internal/llm-usage` by
 * `llm-proxy`. Field names are camelCase, matching this codebase's established wire-schema
 * convention (packages/shared/src/events.ts, packages/egress-proxy/src/report.ts's
 * `EgressObservation`) rather than the `workspace_id`-style snake_case the S1.7 task brief's
 * prose uses when describing this shape — that prose names DB columns, not a wire-format mandate
 * (assumption, see PR body "假设").
 */
export const LlmUsageRecordSchema = z
  .object({
    workspaceId: z.string().uuid(),
    sessionId: z.string().uuid(),
    jti: z.string().uuid(),
    provider: z.string().min(1),
    model: z.string().min(1),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative().optional(),
    cacheWriteTokens: z.number().int().nonnegative().optional(),
    /** USD, from the provider's configured `ModelCost` rates when present (design doc §7.7:
     *  "成本元数据复用 pi-ai 的 ModelCost"). Omitted when the model has no configured cost. */
    costUsd: z.number().nonnegative().optional(),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime().optional(),
    /** Free-text outcome (no shared enum — see the migration's own header comment for why);
     *  `packages/llm-proxy` documents the values it actually writes (`completed`/`error`). */
    status: z.string().min(1),
  })
  .strict();
export type LlmUsageRecord = z.infer<typeof LlmUsageRecordSchema>;

/** A batch POSTed to `/internal/llm-usage` — a bare JSON array (S1.7 task brief: "JSON array of
 *  records, batched"), not wrapped in an envelope object. */
export const LlmUsageBatchSchema = z.array(LlmUsageRecordSchema);

/** Thrown by `recordUsage` when called with records that do not all share one `workspaceId` —
 *  the caller (the internal HTTP route) is expected to have already grouped by workspace. */
export class LlmUsageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmUsageValidationError';
  }
}

// -------------------------------------------------------------------------------------------
// recordUsage
// -------------------------------------------------------------------------------------------

export interface RecordUsageOptions {
  /**
   * Turn resolution hook (S1.7 task brief: "resolveTurnId hook (default null; S1.4 will map
   * session → running Turn)"). Defaults to a function that always returns `null` — this module
   * itself does not import `application/host-bridge` or `application/chat` (§7.10 layering:
   * governance may not depend on application), so it cannot resolve a Turn on its own. The real
   * implementation (docs/development-tasks.md S1.7 补注, 2026-09) is supplied by
   * `interfaces/http/internal/llm-usage.ts`, the layer-legal place that already depends on both
   * `application/host-bridge` (`findAttributableTurnForSession`) and this module — see that
   * route's own doc comment "Turn attribution" for the full rule. A caller that supplies no hook
   * at all (e.g. a test, or a future caller with no Turn concept) still gets `turn_id = null`,
   * never an error.
   */
  readonly resolveTurnId?: (sessionId: string) => Promise<string | null> | string | null;
  /** Overrides `LLM_DAILY_TOKEN_BUDGET` for tests. `undefined` (the default, when the env var is
   *  also unset) means unlimited — no budget check runs at all. */
  readonly dailyTokenBudgetTokens?: number;
  /**
   * S2.7 addition (docs/development-tasks.md S2.7 "usage reports carry sessionId; a Worker
   * session's usage must count against its Task's budget" — "same layer-legal shape as the turn
   * attribution added in PR #37"): called once per record *actually inserted* this call (never
   * for a replayed record `on conflict do nothing` skips — see the call site below), after that
   * record's own INSERT, in the same transaction. Same reasoning as `resolveTurnId`: this module
   * may not import `application/task` (governance may not depend on application, §7.10), so the
   * per-Task token-budget accounting itself lives there; `interfaces/http/internal/llm-usage.ts`
   * supplies the real hook, bound to the same `client`/transaction this call runs in. Defaults to
   * a no-op.
   */
  readonly onRecordInserted?: (record: LlmUsageRecord) => Promise<void> | void;
}

export interface RecordUsageResult {
  /** Number of records actually inserted — a replayed record already present under the
   *  `(workspace_id, jti, started_at)` unique constraint counts as 0, not an error. */
  readonly inserted: number;
  /** Set only on the batch whose insert(s) pushed the workspace's UTC-day token total from below
   *  80% of the configured budget to at or above it (an edge-triggered crossing — see module doc
   *  comment on why this alone guarantees "once per workspace per day" with no extra state). */
  readonly budgetWarning?: { readonly percent: number };
}

function defaultResolveTurnId(): null {
  return null;
}

function readDailyTokenBudgetFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.LLM_DAILY_TOKEN_BUDGET;
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Sums today's (UTC calendar day, explicit `at time zone 'utc'` — never the session's/server's
 * local `current_date`) total token usage (input + output + cache read + cache write) for one
 * workspace. Used both before and after a batch's insert to detect an 80%-budget crossing —
 * two separate sums, not "before + this batch's raw token count", because a replayed batch that
 * `on conflict do nothing` skips must not be double-counted (see `recordUsage`).
 */
async function sumTodayTokens(client: PoolClient, workspaceId: string): Promise<number> {
  const result = await client.query<{ total: string }>(
    `select coalesce(sum(
       input_tokens + output_tokens + coalesce(cache_read_tokens, 0) + coalesce(cache_write_tokens, 0)
     ), 0) as total
     from llm_usage
     where workspace_id = $1
       and started_at >= (date_trunc('day', now() at time zone 'utc') at time zone 'utc')`,
    [workspaceId],
  );
  return Number(result.rows[0]?.total ?? 0);
}

/**
 * Sums today's (UTC calendar day) total `cost_usd` for one workspace — the I18 "每工作区日成本"
 * quota's own data source (design doc §5.4 I18; docs/development-tasks.md S2.7), a distinct axis
 * from `sumTodayTokens`'s token-count budget above (S1.7's `LLM_DAILY_TOKEN_BUDGET`). Rows with a
 * `null` `cost_usd` (a model with no configured `ModelCost` rate, this table's own header comment)
 * contribute `0`, never `null`-poisoning the sum. Exported for `application/task`'s quota checks
 * — `governance/llm-usage` owns `llm_usage`, so this is the layer-legal read `application/task`
 * (which may depend on governance's service interface, §7.10) calls rather than querying the
 * table directly.
 */
export async function sumTodayCostUsd(client: PoolClient, workspaceId: string): Promise<number> {
  const result = await client.query<{ total: string }>(
    `select coalesce(sum(coalesce(cost_usd, 0)), 0) as total
     from llm_usage
     where workspace_id = $1
       and started_at >= (date_trunc('day', now() at time zone 'utc') at time zone 'utc')`,
    [workspaceId],
  );
  return Number(result.rows[0]?.total ?? 0);
}

/**
 * Idempotently inserts `records` into `llm_usage` (idempotency key: `(workspace_id, jti,
 * started_at)` — see the migration's header comment for why this option was picked over a
 * client-generated id) and, when `LLM_DAILY_TOKEN_BUDGET` (or `options.dailyTokenBudgetTokens`)
 * is configured, checks whether this call's insert(s) crossed 80% of the workspace's UTC-day
 * token budget; if so, enqueues exactly one `BudgetWarning` domain event (design doc §7.10 event
 * vocabulary) via `substrate/outbox`'s `enqueue()`, in the same transaction as the insert.
 *
 * Every record in `records` must share one `workspaceId` — this function does not itself open
 * `withWorkspace` (see module doc comment), so it has no way to scope a mixed-workspace batch
 * correctly; the caller (the internal HTTP route) groups by `workspaceId` first.
 */
export async function recordUsage(
  client: PoolClient,
  records: readonly LlmUsageRecord[],
  options: RecordUsageOptions = {},
): Promise<RecordUsageResult> {
  if (records.length === 0) return { inserted: 0 };

  const workspaceId = records[0]?.workspaceId;
  for (const record of records) {
    if (record.workspaceId !== workspaceId) {
      throw new LlmUsageValidationError(
        'recordUsage: every record in one call must share the same workspaceId',
      );
    }
  }
  if (workspaceId === undefined) return { inserted: 0 };

  const resolveTurnId = options.resolveTurnId ?? defaultResolveTurnId;
  const onRecordInserted = options.onRecordInserted ?? (() => {});
  const budget = options.dailyTokenBudgetTokens ?? readDailyTokenBudgetFromEnv();

  const before = budget !== undefined ? await sumTodayTokens(client, workspaceId) : 0;

  let inserted = 0;
  for (const record of records) {
    const turnId = await resolveTurnId(record.sessionId);
    const result = await client.query(
      `insert into llm_usage (
         workspace_id, session_id, jti, turn_id, provider, model,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd,
         started_at, finished_at, status
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       on conflict (workspace_id, jti, started_at) do nothing`,
      [
        record.workspaceId,
        record.sessionId,
        record.jti,
        turnId ?? null,
        record.provider,
        record.model,
        record.inputTokens,
        record.outputTokens,
        record.cacheReadTokens ?? null,
        record.cacheWriteTokens ?? null,
        record.costUsd ?? null,
        record.startedAt,
        record.finishedAt ?? null,
        record.status,
      ],
    );
    const recordInserted = (result.rowCount ?? 0) > 0;
    if (recordInserted) {
      inserted += 1;
      // Only for a genuinely new row — a replayed record the `on conflict` skips must never be
      // double-counted against a Task's token budget (see this option's own doc comment).
      await onRecordInserted(record);
    }
  }

  if (budget === undefined) return { inserted };

  const after = await sumTodayTokens(client, workspaceId);
  const warningThreshold = budget * 0.8;
  if (before < warningThreshold && after >= warningThreshold) {
    const percent = Math.min(100, (after / budget) * 100);
    await enqueue(client, {
      type: 'BudgetWarning',
      workspaceId,
      scope: 'workspace_daily',
      percent,
    });
    return { inserted, budgetWarning: { percent } };
  }

  return { inserted };
}
