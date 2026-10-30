import type { EvalBudgetWire } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { resolveQuotas } from '../task/index.js';

/**
 * The evaluation budget (S10 E3-2a; coordinator 2026-10-30: its own quota, apart from the daily
 * cost budget): what evaluation runs may spend in a UTC month, `evaluation.monthly_cost_budget_usd`
 * ($10 unless the owner sets it). Spent is read where it is recorded — the `llm_usage` rows of
 * evaluation Tasks' runs (by their Handle session) in the month, priced rows only — so it counts a
 * run that is still going, and a call recorded after its trial was scored.
 *
 * A run is not started once the month's budget is spent (`EvaluationBudgetExhaustedError`, 429).
 * A started run is not cut off — its Task's own token budget bounds it; the console estimates a
 * run's cost before it starts (`trialCostUsd` × the trials it would hold) and says when it would
 * not fit, so a run is not refused part-way.
 */

/** How many of the latest scored, priced trials `trialCostUsd` averages — a trial that ended
 *  without a report (cancelled, withheld at start) says little of what a run costs. */
const TRIAL_COST_SAMPLE = 20;

/** The UTC month `at` falls in: [start, end). */
export function evaluationBudgetPeriod(at: Date): { readonly start: Date; readonly end: Date } {
  return {
    start: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)),
    end: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1)),
  };
}

export interface EvalBudget {
  readonly monthlyBudgetUsd: number;
  readonly spentUsd: number;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly trialCostUsd: number | null;
  readonly unpricedTrials: number;
}

export async function readEvalBudget(
  client: PoolClient,
  workspaceId: string,
  at: Date = new Date(),
): Promise<EvalBudget> {
  const { start, end } = evaluationBudgetPeriod(at);
  const quotas = await resolveQuotas(client, workspaceId);
  const usage = await client.query<{ spent: number | null; unpriced: string }>(
    `select sum(u.cost_usd)::float8 as spent,
            count(distinct t.id) filter (where u.cost_usd is null)::bigint as unpriced
       from llm_usage u
       join worker_runs w on w.workspace_id = u.workspace_id and w.session_id = u.session_id
       join tasks t on t.workspace_id = w.workspace_id and t.id = w.task_id
      where u.workspace_id = $1 and t.purpose = 'evaluation'
        and u.started_at >= $2 and u.started_at < $3`,
    [workspaceId, start, end],
  );
  const trialCost = await client.query<{ average: number | null }>(
    `select avg(cost_usd)::float8 as average
       from (select cost_usd from eval_trials
              where workspace_id = $1 and status = 'scored' and cost_usd is not null
              order by finished_at desc
              limit $2) recent`,
    [workspaceId, TRIAL_COST_SAMPLE],
  );
  return {
    monthlyBudgetUsd: quotas.evaluationMonthlyCostBudgetUsd,
    spentUsd: usage.rows[0]?.spent ?? 0,
    periodStart: start,
    periodEnd: end,
    trialCostUsd: trialCost.rows[0]?.average ?? null,
    unpricedTrials: Number(usage.rows[0]?.unpriced ?? 0),
  };
}

export function evalBudgetWire(budget: EvalBudget): EvalBudgetWire {
  return {
    monthlyBudgetUsd: budget.monthlyBudgetUsd,
    spentUsd: budget.spentUsd,
    periodStart: budget.periodStart.toISOString(),
    periodEnd: budget.periodEnd.toISOString(),
    trialCostUsd: budget.trialCostUsd,
    unpricedTrials: budget.unpricedTrials,
  };
}
