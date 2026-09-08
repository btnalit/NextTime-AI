import type { PoolClient } from 'pg';

/**
 * application/task/agent-principal: `ensureWorkerAgentPrincipal` — the one agent-kind Principal
 * per (workspace, WorkerDefinition) a WorkerRun's contract Facts are `asserted_by` (design
 * decision replacing PR #84's interim `CallerPrincipal.viaAgent` downgrade flag; see
 * migrations/core/0014_worker_agent_principals.sql's header comment for the full rationale and
 * docs/development-tasks.md's S2.9 implementation note for the history).
 *
 * Granularity is per (workspace, WorkerDefinition) *identity* (`worker_definitions.id`, stable
 * across `publishWorkerDefinition` versions), never per version and never per run: the version
 * already lives on the Task (`tasks.worker_definition_version`) and the run is already the
 * Activity/WorkerRun itself — a principal-per-run would explode `principals` for no provenance
 * benefit, since "which agent asserted this" only ever needs to resolve to "this WorkerDefinition".
 *
 * **Provenance subject only, never an authorization subject.** This Principal is never
 * `on_behalf_of` anything, never authenticates (`api_key_hash` stays null), and is never checked
 * against a Grant/role — a Worker's actual authority is the attenuated Handle its WorkerRun already
 * holds, minted from the human caller's own scope (`handle-mint.ts`). Its only job is to be a
 * stable `asserted_by`/`started_by` identity so `explain()` can answer "which agent wrote this
 * Fact", independent of which human happened to invoke it this time — that human is recorded
 * separately, as `on_behalf_of` provenance on the Activity (`result.ts`'s own doc comment).
 */

interface AgentPrincipalIdRow {
  readonly id: string;
}

/**
 * Idempotent under concurrency via the partial unique index on `(workspace_id,
 * worker_definition_id) where worker_definition_id is not null` (migrations/core/0014) — the `on
 * conflict` clause below must repeat that exact predicate for Postgres to infer the index as the
 * arbiter. Two concurrent first-spawns of the same WorkerDefinition race the INSERT; the loser's
 * conflict resolves to the same row (`do update`, not `do nothing`, so `display_name` also
 * self-heals if the WorkerDefinition's own `name` content changes on a later published version) —
 * both callers observe the same single principal id either way.
 */
export async function ensureWorkerAgentPrincipal(
  client: PoolClient,
  workspaceId: string,
  workerDefinitionId: string,
  definitionName: string,
): Promise<string> {
  const displayName = `worker:${definitionName}`;
  const result = await client.query<AgentPrincipalIdRow>(
    `insert into principals (workspace_id, kind, role, worker_definition_id, display_name)
     values ($1, 'agent', 'member', $2, $3)
     on conflict (workspace_id, worker_definition_id) where worker_definition_id is not null
     do update set display_name = excluded.display_name
     returning id`,
    [workspaceId, workerDefinitionId, displayName],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('ensureWorkerAgentPrincipal: INSERT ... RETURNING produced no row');
  }
  return row.id;
}
