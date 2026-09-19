import type { FastifyInstance } from 'fastify';
import type { PoolLike } from '../../../adapters/db/pool.js';
import {
  configuredDailyTokenBudget,
  nextUtcMidnight,
  sumTodayCostUsdByWorkspace,
  sumTodayTokensByWorkspace,
} from '../../../governance/llm-usage/index.js';

/**
 * interfaces/http/internal/llm-budget: `GET /internal/llm-budget-exhausted` (S6-B, leftover 19 —
 * docs/STATUS.md §4 row 19; design doc §5.4 I18 "到 100% 时 llm-proxy 返回预算耗尽错误"). The model
 * proxy polls this every `BUDGET_SYNC_INTERVAL_MS` (its budget-sync.ts) and refuses completions
 * for every workspace listed with 402 `budget_exhausted`, before contacting any upstream. The
 * kernel's own post-hoc stop (`application/task/service.ts` `recordWorkerRunUsage`: Task
 * `failed: budget_exhausted` + child Handle revoked) stays the backstop; this route is what turns
 * "100%" into an immediate, explainable refusal for *every* session of the workspace — entry
 * chat included, which no per-Task mechanism reaches.
 *
 * Two budget axes, both "today" in UTC, both already defined elsewhere and only *read* here:
 *
 *   - `workspace_daily_cost` — the I18 "每工作区日成本" quota, `task.daily_cost_budget_usd`
 *     (application/task/quotas.ts; a `quotas` row per workspace that set one; `null` = unlimited),
 *     against `governance/llm-usage`'s `cost_usd` sum. Until now this was checked only at
 *     `invoke_worker` time — the leftover's exact gap.
 *   - `workspace_daily_tokens` — S1.7's global `LLM_DAILY_TOKEN_BUDGET` (`governance/llm-usage`,
 *     whose 80% crossing already emits `BudgetWarning`), against the token sum. Unset = no rows.
 *
 * Response: `{exhausted: [{workspaceId, scope, budget, spent, until}], now}` — the *complete*
 * current set (the proxy replaces, never accumulates), `until` = the next UTC midnight so the
 * proxy self-expires a row if this kernel is unreachable across the day boundary, `now` = the DB
 * clock like handle-revocations.ts. Cost rows come first so a workspace over both budgets is
 * reported by the axis the operator configured deliberately.
 *
 * Trust boundary and query posture: behind `interfaces/internal-auth`'s shared-secret guard like
 * every `/internal/*` route. Cross-workspace by nature — same deliberate, narrow exception
 * handle-revocations.ts documents: a bare `pool.connect()` (superuser login role, no
 * `SET LOCAL ROLE`, so RLS does not scope the reads), and one direct read of the `quotas` table
 * (application/task's; `resolveQuotas` there is per-workspace and needs a workspace transaction,
 * which is exactly what a "which workspaces are over budget" question does not have). The
 * `llm_usage` sums are governance/llm-usage's own exported reads — that table is never queried
 * from here.
 */

export type BudgetScope = 'workspace_daily_cost' | 'workspace_daily_tokens';

export interface ExhaustedBudgetRow {
  readonly workspaceId: string;
  readonly scope: BudgetScope;
  readonly budget: number;
  readonly spent: number;
  readonly until: string;
}

export interface ListExhaustedBudgetsResult {
  readonly exhausted: readonly ExhaustedBudgetRow[];
  readonly now: string;
}

const DAILY_COST_QUOTA_KEY = 'task.daily_cost_budget_usd';

export async function defaultListExhaustedBudgets(
  pool: PoolLike,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ListExhaustedBudgetsResult> {
  const client = await pool.connect();
  try {
    const nowResult = await client.query<{ now: Date }>('select now() as now');
    const now = nowResult.rows[0]?.now ?? new Date();
    const until = nextUtcMidnight(now).toISOString();
    const exhausted: ExhaustedBudgetRow[] = [];

    // Axis 1: per-workspace daily cost quota — only rows holding a JSON *number*. `value` is
    // jsonb, so an "unlimited" quota is stored as JSON `null`, which is not SQL NULL: filtering
    // on `jsonb_typeof` (not `is not null`) is what keeps an unlimited workspace off this list
    // instead of reading it as a budget of 0.
    const quotas = await client.query<{ workspace_id: string; value: unknown }>(
      "select workspace_id, value from quotas where key = $1 and jsonb_typeof(value) = 'number'",
      [DAILY_COST_QUOTA_KEY],
    );
    if (quotas.rows.length > 0) {
      const spentByWorkspace = new Map(
        (await sumTodayCostUsdByWorkspace(client)).map((row) => [row.workspaceId, row.total]),
      );
      for (const row of quotas.rows) {
        if (typeof row.value !== 'number' || !Number.isFinite(row.value)) continue;
        const budget = row.value;
        const spent = spentByWorkspace.get(row.workspace_id) ?? 0;
        if (spent >= budget) {
          exhausted.push({
            workspaceId: row.workspace_id,
            scope: 'workspace_daily_cost',
            budget,
            spent,
            until,
          });
        }
      }
    }

    // Axis 2: the global daily token budget, if configured.
    const tokenBudget = configuredDailyTokenBudget(env);
    if (tokenBudget !== undefined) {
      for (const row of await sumTodayTokensByWorkspace(client)) {
        if (row.total >= tokenBudget) {
          exhausted.push({
            workspaceId: row.workspaceId,
            scope: 'workspace_daily_tokens',
            budget: tokenBudget,
            spent: row.total,
            until,
          });
        }
      }
    }

    return { exhausted, now: now.toISOString() };
  } finally {
    client.release();
  }
}

export interface LlmBudgetRoutesDeps {
  readonly pool: PoolLike;
  /** Injectable for tests, so route-shape tests never touch Postgres. Defaults to
   *  `defaultListExhaustedBudgets` above. */
  readonly listExhaustedBudgets?: () => Promise<ListExhaustedBudgetsResult>;
}

export async function registerLlmBudgetRoutes(
  app: FastifyInstance,
  deps: LlmBudgetRoutesDeps,
): Promise<void> {
  const listExhaustedBudgets =
    deps.listExhaustedBudgets ?? (() => defaultListExhaustedBudgets(deps.pool));

  app.get('/internal/llm-budget-exhausted', async (_request, reply) => {
    try {
      const result = await listExhaustedBudgets();
      return { exhausted: result.exhausted, now: result.now };
    } catch (err) {
      app.log?.error?.(err, 'llm-budget: query failed');
      reply.code(500);
      return {
        ok: false,
        error: { code: 'internal_error', message: 'failed to evaluate budgets' },
      };
    }
  });
}
