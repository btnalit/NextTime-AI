import type { PoolClient } from 'pg';

/**
 * governance/gatekeepers/service-principal: the shared `service`-kind Principal a Gatekeeper's
 * `observe`/`apply` result writes assert Facts as (design doc §5.6 `epistemic_status`: "observed
 * （系统 API 直接读取，采集器）"). `substrate/graph/store.ts`'s `assertFact` derives
 * `epistemic_status` purely from the calling `CallerPrincipal.kind` — writing a gate's observed
 * data as `observed` (not `inferred`, the status a Worker/entry `agent`-kind caller would get)
 * therefore requires asserting *as* a `service`-kind Principal, distinct from whichever Handle
 * actually invoked `request_action`.
 *
 * One shared Principal per workspace (not one per Gatekeeper instance): the distinction that
 * matters for `epistemic_status` is "this came from a system API, not agent inference" — which is
 * uniform across every Gatekeeper — not which specific Gatekeeper produced it (`explain()` already
 * traces that through the Fact's `activity_id`/`Gatekeeper --exposes--> Operation` edges, not
 * through `asserted_by`). Looked up by a fixed `display_name` and lazily created on first use
 * (idempotent: a concurrent race creates at most a small number of harmless duplicate rows — no
 * unique constraint exists on `display_name`, and correctness does not depend on there being only
 * one — but a fresh workspace only calls this rarely enough that it's a non-issue in practice).
 */

const SERVICE_PRINCIPAL_DISPLAY_NAME = '__gatekeeper_service__';

interface PrincipalIdRow {
  id: string;
}

/** Returns the workspace's shared Gatekeeper service Principal id, creating it if it does not yet
 *  exist. `role: 'member'` — a service Principal asserting observed Facts needs no elevated role
 *  (role gates human-channel capability calls, §5.1.1; this Principal never authenticates). */
export async function getOrCreateGatekeeperServicePrincipal(
  client: PoolClient,
  workspaceId: string,
): Promise<string> {
  const existing = await client.query<PrincipalIdRow>(
    "select id from principals where workspace_id = $1 and kind = 'service' and display_name = $2 limit 1",
    [workspaceId, SERVICE_PRINCIPAL_DISPLAY_NAME],
  );
  const found = existing.rows[0];
  if (found) return found.id;

  const inserted = await client.query<PrincipalIdRow>(
    `insert into principals (workspace_id, kind, role, display_name)
     values ($1, 'service', 'member', $2)
     returning id`,
    [workspaceId, SERVICE_PRINCIPAL_DISPLAY_NAME],
  );
  const row = inserted.rows[0];
  if (!row) {
    throw new Error('getOrCreateGatekeeperServicePrincipal: INSERT ... RETURNING produced no row');
  }
  return row.id;
}
