import type { PoolClient } from 'pg';
import { sumTodayCostUsd } from '../../governance/llm-usage/index.js';
import { HARD_MAX_DEPTH, type ResolvedQuotas, resolveQuotas } from './quotas.js';
import { QuotaExceededError } from './types.js';

/**
 * application/task/quota-check: I18's per-Task checks (derivation depth, concurrent Tasks per
 * principal, the workspace's daily cost) and the lock they run under — shared by every path that
 * creates a Task: `invoke_worker` (`invoke.ts`) and the goal advancer's step attempts
 * (`step-attempt.ts`, S11 GO2). Both take {@link lockTaskQuotas} first and insert the Task in the
 * same transaction, so the count the next caller reads includes it (P2-6, review job 652a4abc — see
 * `invoke.ts`'s `insertQueuedTaskWithQuotaCheck`).
 */

/** Serializes Task creation per (workspace, principal) until the transaction ends. */
export async function lockTaskQuotas(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
): Promise<void> {
  await client.query('select pg_advisory_xact_lock(hashtext($1::text))', [
    `${workspaceId}:${principalId}`,
  ]);
}

/** Throws `QuotaExceededError` (`depth_exceeded` / `concurrency_exceeded` /
 *  `daily_cost_exceeded`) when a new Task at `depth` for `principalId` would break an I18 limit;
 *  returns the resolved quotas otherwise. Call under {@link lockTaskQuotas}. */
export async function assertTaskQuotas(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
  definitionId: string,
  depth: number,
): Promise<ResolvedQuotas> {
  const resolvedQuotas = await resolveQuotas(client, workspaceId);

  if (depth > resolvedQuotas.maxDepth) {
    throw new QuotaExceededError(
      'depth_exceeded',
      `${definitionId}: derivation depth ${depth} exceeds the workspace's max depth (${resolvedQuotas.maxDepth}, hard ceiling ${HARD_MAX_DEPTH}) — invoke from a shallower WorkerRun or reduce nesting`,
    );
  }

  const concurrentResult = await client.query<{ count: string }>(
    `select count(*)::bigint as count
     from tasks
     where workspace_id = $1
       and on_behalf_of = $2
       and status in ('queued', 'running', 'waiting_approval')`,
    [workspaceId, principalId],
  );
  const concurrentCount = Number(concurrentResult.rows[0]?.count ?? 0);
  if (concurrentCount >= resolvedQuotas.maxConcurrentWorkerRunsPerUser) {
    throw new QuotaExceededError(
      'concurrency_exceeded',
      `${concurrentCount} WorkerRun(s)/queued Task(s) already active for this user, at or above ` +
        `the workspace limit (${resolvedQuotas.maxConcurrentWorkerRunsPerUser})`,
    );
  }

  if (resolvedQuotas.dailyCostBudgetUsd !== null) {
    const spentToday = await sumTodayCostUsd(client, workspaceId);
    if (spentToday >= resolvedQuotas.dailyCostBudgetUsd) {
      throw new QuotaExceededError(
        'daily_cost_exceeded',
        `workspace has spent $${spentToday.toFixed(2)} today, at or above the daily cost budget ` +
          `($${resolvedQuotas.dailyCostBudgetUsd.toFixed(2)})`,
      );
    }
  }

  return resolvedQuotas;
}
