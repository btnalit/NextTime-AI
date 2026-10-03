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
    /** R-67: llm-proxy's id for the one upstream request this record meters, minted per request
     *  (never taken from the caller) and identical on every replay of the record — the record's
     *  identity (`llm_usage.request_id`, migrations/llm-usage/0002). Absent from an llm-proxy that
     *  predates R-67: such a record falls back to the `(workspace_id, jti, started_at)` key, see
     *  `recordUsage`. */
    requestId: z.string().uuid().optional(),
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
  /** Number of records actually inserted — a replayed record (same `requestId`, or for a record
   *  without one the same `(workspace_id, jti, started_at)`) counts as 0, not an error. */
  readonly inserted: number;
  /** R-68: records refused for good because the session or Handle they name no longer exists —
   *  the workspace was purged while llm-proxy still held its usage. Not inserted and not an
   *  error: retrying can never succeed, so the caller acknowledges them and logs. */
  readonly rejected: number;
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

/** What became of one record in `recordUsage`. */
type RecordOutcome = 'inserted' | 'duplicate' | 'rejected';

/** How many times in a row one record may find its `(jti, started_at)` microsecond taken by a
 *  concurrently committed row before `recordUsage` gives up and throws (the caller retries the
 *  group). Each miss jumps past every row already in that millisecond, so one is the norm. */
const MAX_SLOT_ATTEMPTS = 8;

/** Inserts one record at `started_at + $16 µs`, only if its session and Handle still exist (the
 *  two foreign keys — checked here, so a purged workspace's record is skipped instead of raising
 *  a 23503 that aborts the whole transaction). `on conflict do nothing` covers both unique keys:
 *  `request_id` (a replay) and 0001's `(workspace_id, jti, started_at)`. */
const INSERT_USAGE_SQL = `
  insert into llm_usage (
    workspace_id, session_id, jti, turn_id, provider, model,
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd,
    started_at, finished_at, status, request_id
  )
  select $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, $6::text,
         $7::bigint, $8::bigint, $9::bigint, $10::bigint, $11::numeric,
         $12::timestamptz + $16::int * interval '1 microsecond', $13::timestamptz, $14::text,
         $15::uuid
   where exists (select 1 from sessions s where s.workspace_id = $1::uuid and s.id = $2::uuid)
     and exists (
       select 1 from capability_handles h where h.workspace_id = $1::uuid and h.jti = $3::uuid
     )
  on conflict do nothing`;

/** Why `INSERT_USAGE_SQL` wrote nothing: a replay of the same `request_id`, a missing session or
 *  Handle, or else the `(jti, started_at)` slot is taken — and then the first microsecond offset
 *  past every row this Handle already has in that millisecond. */
const CLASSIFY_SKIPPED_USAGE_SQL = `
  select exists (
           select 1 from llm_usage u where u.workspace_id = $1::uuid and u.request_id = $2::uuid
         ) as replayed,
         exists (select 1 from sessions s where s.workspace_id = $1::uuid and s.id = $3::uuid)
           and exists (
             select 1 from capability_handles h
              where h.workspace_id = $1::uuid and h.jti = $4::uuid
           ) as references_exist,
         (select floor(extract(epoch from max(u.started_at) - $5::timestamptz) * 1000000)::int + 1
            from llm_usage u
           where u.workspace_id = $1::uuid and u.jti = $4::uuid
             and u.started_at >= $5::timestamptz
             and u.started_at < $5::timestamptz + interval '1 millisecond') as next_offset_micros`;

/**
 * One record's insert (the identity rules are on `recordUsage`). The microsecond step exists
 * only because 0001's key `(workspace_id, jti, started_at)` is kept for the previous release's
 * `on conflict` (migrations/llm-usage/0002): two requests under one Handle that started in the
 * same millisecond are two rows, the later one stored a few microseconds into that millisecond —
 * below llm-proxy's millisecond measurement, so the reported instant is unchanged.
 */
async function insertUsageRecord(
  client: PoolClient,
  record: LlmUsageRecord,
  turnId: string | null,
): Promise<RecordOutcome> {
  let offsetMicros = 0;
  for (let attempt = 0; attempt < MAX_SLOT_ATTEMPTS; attempt += 1) {
    const insert = await client.query(INSERT_USAGE_SQL, [
      record.workspaceId,
      record.sessionId,
      record.jti,
      turnId,
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
      record.requestId ?? null,
      offsetMicros,
    ]);
    if ((insert.rowCount ?? 0) > 0) return 'inserted';

    const { rows } = await client.query<{
      replayed: boolean;
      references_exist: boolean;
      next_offset_micros: number | null;
    }>(CLASSIFY_SKIPPED_USAGE_SQL, [
      record.workspaceId,
      record.requestId ?? null,
      record.sessionId,
      record.jti,
      record.startedAt,
    ]);
    const state = rows[0];
    if (state?.replayed) return 'duplicate';
    if (!state?.references_exist) return 'rejected';
    // 0001's key is taken. Without a request id it is the record's only identity, so this is a
    // replay — the pre-R-67 rule, kept for an llm-proxy that predates R-67.
    if (record.requestId === undefined) return 'duplicate';
    // Another request under this Handle holds the microsecond: move past every row in it.
    offsetMicros = Math.max(offsetMicros + 1, state.next_offset_micros ?? 0);
  }
  throw new Error(
    `recordUsage: request ${record.requestId} found its started_at taken ${MAX_SLOT_ATTEMPTS} times in a row`,
  );
}

/**
 * Idempotently inserts `records` into `llm_usage` and, when `LLM_DAILY_TOKEN_BUDGET` (or
 * `options.dailyTokenBudgetTokens`) is configured, checks whether this call's insert(s) crossed
 * 80% of the workspace's UTC-day token budget; if so, enqueues exactly one `BudgetWarning` domain
 * event (design doc §7.10 event vocabulary) via `substrate/outbox`'s `enqueue()`, in the same
 * transaction as the insert.
 *
 * Identity (R-67, migrations/llm-usage/0002): a record's `requestId` — llm-proxy mints one per
 * upstream request — so concurrent requests under one Handle are separate rows and a replay of
 * the same record is skipped. A record without one (an llm-proxy that predates R-67, only during
 * a rolling upgrade) falls back to 0001's key `(workspace_id, jti, started_at)`: a conflict there
 * is a replay, exactly as before.
 *
 * Purged workspaces (R-68): a record whose session or Handle no longer exists is counted in
 * `rejected` and skipped — never a foreign-key error that aborts the batch.
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
  if (records.length === 0) return { inserted: 0, rejected: 0 };

  const workspaceId = records[0]?.workspaceId;
  for (const record of records) {
    if (record.workspaceId !== workspaceId) {
      throw new LlmUsageValidationError(
        'recordUsage: every record in one call must share the same workspaceId',
      );
    }
  }
  if (workspaceId === undefined) return { inserted: 0, rejected: 0 };

  const resolveTurnId = options.resolveTurnId ?? defaultResolveTurnId;
  const onRecordInserted = options.onRecordInserted ?? (() => {});
  const budget = options.dailyTokenBudgetTokens ?? readDailyTokenBudgetFromEnv();

  const before = budget !== undefined ? await sumTodayTokens(client, workspaceId) : 0;

  let inserted = 0;
  let rejected = 0;
  for (const record of records) {
    const turnId = await resolveTurnId(record.sessionId);
    const outcome = await insertUsageRecord(client, record, turnId ?? null);
    if (outcome === 'rejected') rejected += 1;
    if (outcome === 'inserted') {
      inserted += 1;
      // Only for a genuinely new row — a replayed record the `on conflict` skips must never be
      // double-counted against a Task's token budget (see this option's own doc comment).
      await onRecordInserted(record);
    }
  }

  if (budget === undefined) return { inserted, rejected };

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
    return { inserted, rejected, budgetWarning: { percent } };
  }

  return { inserted, rejected };
}

// -------------------------------------------------------------------------------------------
// S6-B leftover 19 — the cross-workspace daily sums behind `GET /internal/llm-budget-exhausted`
// (interfaces/http/internal/llm-budget.ts; design doc I18 "到 100% 时 llm-proxy 返回预算耗尽错误").
// -------------------------------------------------------------------------------------------

export interface WorkspaceDailyTotal {
  readonly workspaceId: string;
  readonly total: number;
}

/**
 * Today's (UTC calendar day, same predicate as `sumTodayTokens` / `sumTodayCostUsd`) `cost_usd`
 * sum for *every* workspace with any usage today — one row per workspace. Meant for a
 * kernel-internal, cross-workspace caller on a superuser-pool client (the internal budget route,
 * same posture as `interfaces/http/internal/handle-revocations.ts`'s cross-workspace read):
 * under the RLS-constrained `nexttime_app` role this naturally collapses to the current
 * workspace's single row. `llm_usage` stays this module's table — the route never queries it.
 */
export async function sumTodayCostUsdByWorkspace(
  client: PoolClient,
): Promise<readonly WorkspaceDailyTotal[]> {
  const result = await client.query<{ workspace_id: string; total: string }>(
    `select workspace_id, coalesce(sum(coalesce(cost_usd, 0)), 0) as total
     from llm_usage
     where started_at >= (date_trunc('day', now() at time zone 'utc') at time zone 'utc')
     group by workspace_id`,
  );
  return result.rows.map((row) => ({ workspaceId: row.workspace_id, total: Number(row.total) }));
}

/** Today's total token sum (input + output + cache read + cache write — `sumTodayTokens`'s own
 *  definition) per workspace, for the `LLM_DAILY_TOKEN_BUDGET` axis of the same route. */
export async function sumTodayTokensByWorkspace(
  client: PoolClient,
): Promise<readonly WorkspaceDailyTotal[]> {
  const result = await client.query<{ workspace_id: string; total: string }>(
    `select workspace_id, coalesce(sum(
       input_tokens + output_tokens + coalesce(cache_read_tokens, 0) + coalesce(cache_write_tokens, 0)
     ), 0) as total
     from llm_usage
     where started_at >= (date_trunc('day', now() at time zone 'utc') at time zone 'utc')
     group by workspace_id`,
  );
  return result.rows.map((row) => ({ workspaceId: row.workspace_id, total: Number(row.total) }));
}

/** The configured `LLM_DAILY_TOKEN_BUDGET` (S1.7), or `undefined` for unlimited — exported so
 *  the budget route applies exactly the value `recordUsage`'s 80% warning uses. */
export function configuredDailyTokenBudget(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  return readDailyTokenBudgetFromEnv(env);
}

/** The next UTC midnight after `now` — when every "today" sum above resets, and therefore the
 *  `until` the proxy stops enforcing a budget-exhausted row on its own even if the kernel is
 *  unreachable then. */
export function nextUtcMidnight(now: Date = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0),
  );
}
