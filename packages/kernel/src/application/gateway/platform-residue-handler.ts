import type { PlatformDraftResidueWire } from '@nexttime/shared';
import { DEFAULT_DRAFT_EXPIRY_DAYS } from '../worker/index.js';
import type { CapabilityHandler } from './capability-handler.js';

/**
 * application/gateway/platform-residue-handler: `platform_draft_residue` (S8 W4-C, journey ⑤
 * 清理验收残留). A cross-workspace **count** of `worker_definitions` / `skills` / `procedures`
 * rows still `status = 'draft'` — never their content or proposer (I16: a draft is visible only
 * to the principal who proposed it; a platform admin is never that principal). Counting alone
 * reveals nothing I16 protects, which is exactly why this capability's contract stops there —
 * see `PlatformDraftResidueWireSchema`'s own doc comment for why no listing/delete capability
 * accompanies it.
 *
 * Runs inside the platform transaction (`adapters/db/platform-context.ts`'s `withPlatform`,
 * `nexttime_app` role, `app.platform = on`) — `worker_definitions`/`skills`/`procedures` carry
 * only a `workspace_id = app_workspace()` RLS policy (no per-principal restriction; I16 is
 * enforced in application code, by every *listing* capability's own `proposed_by` filter, not by
 * a DB policy), so a plain `count(*) group by workspace_id`-free aggregate across every
 * workspace under `app.platform = on` would still need RLS to permit it — it does not by
 * default. Same per-workspace `setWorkspaceContext` loop `platform-handlers.ts`'s
 * `computeCrossWorkspaceOverview` already established for exactly this shape, reused here rather
 * than a raw admin-mode connection this handler does not have access to (it receives an ordinary
 * `nexttime_app` `PoolClient`, not the scheduler's own superuser pool).
 */
export const platformDraftResidueHandler: CapabilityHandler = async (client) => {
  const workspaces = await client.query<{ id: string }>('select id from workspaces');

  let workerDefinitions = 0;
  let skills = 0;
  let procedures = 0;
  const NIL_PRINCIPAL = '00000000-0000-0000-0000-000000000000';
  for (const workspace of workspaces.rows) {
    await client.query("select set_config('app.workspace_id', $1, true)", [workspace.id]);
    await client.query("select set_config('app.principal_id', $1, true)", [NIL_PRINCIPAL]);
    const result = await client.query<{
      worker_definitions: string;
      skills: string;
      procedures: string;
    }>(
      `select
         (select count(*) from worker_definitions where workspace_id = $1 and status = 'draft')::text as worker_definitions,
         (select count(*) from skills where workspace_id = $1 and status = 'draft')::text as skills,
         (select count(*) from procedures where workspace_id = $1 and status = 'draft')::text as procedures`,
      [workspace.id],
    );
    const row = result.rows[0];
    if (!row) continue;
    workerDefinitions += Number(row.worker_definitions);
    skills += Number(row.skills);
    procedures += Number(row.procedures);
  }
  await client.query("select set_config('app.workspace_id', '', true)");
  await client.query("select set_config('app.principal_id', '', true)");

  // Same env var, same fallback `main()` (`index.ts`) reads at boot for the periodic sweep —
  // re-read here rather than threaded through as a handler dependency, since this is a display
  // value, not a decision this handler makes: a malformed value would already have failed the
  // scheduler at startup (`parseNonNegativeIntEnvVar`'s own fail-fast contract), so by the time
  // any capability handler runs, an unset var is the only case left to fall back on.
  const rawThreshold = process.env.DRAFT_EXPIRY_DAYS;
  const parsedThreshold = rawThreshold === undefined ? Number.NaN : Number(rawThreshold);
  const expiryThresholdDays =
    Number.isFinite(parsedThreshold) && parsedThreshold >= 0
      ? parsedThreshold
      : DEFAULT_DRAFT_EXPIRY_DAYS;

  const result: PlatformDraftResidueWire = {
    workerDefinitions,
    skills,
    procedures,
    total: workerDefinitions + skills + procedures,
    expiryThresholdDays,
    checkedAt: new Date().toISOString(),
  };
  return { result };
};
