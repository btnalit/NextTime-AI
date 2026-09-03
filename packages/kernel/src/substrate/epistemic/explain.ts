import type { PoolClient } from 'pg';

/**
 * substrate/epistemic/explain: the PROV-O provenance walk — Fact / Decision / Turn (an Activity)
 * → Observation(s) → Source, plus the asserting/started_by/decided_by Principal (design doc §5.1.3
 * PROV-O, §7.1 epistemic module "explain", §9.3 `explain` capability; docs/development-tasks.md
 * S1.3: "explain(client, workspaceId, {factId|activityId|decisionId})"). A Turn is an Activity of
 * `kind='agent_turn'` (chat module, S1.4) — `explainActivity` below needs no Turn-specific
 * handling since it already walks any Activity id generically.
 *
 * Cross-module read (assumption — see PR body "假设"): `links` (Facts) is the `graph` module's
 * table (design doc §7.1), and the module contract (§7.10) says a module must not query another
 * module's table directly. `explain` is nonetheless implemented here with a direct, read-only
 * SELECT against `links`/`activities`/`observations`/`sources`/`principals` rather than going
 * through `GraphStore`'s public interface, because `GraphStore` (packages/kernel/src/substrate/
 * graph/{store,sql-store,queries}.ts) has no "fetch one Fact by id" method today, and this task's
 * explicit file ownership excludes adding one there (only the S1.2-review invalidation-reason
 * change is in scope for those three files). `explain`'s job is inherently this cross-cutting
 * provenance read — it is the one place in the epistemic module's charter that is expected to
 * follow a Fact's `activity_id` — so a read-only SELECT here, never a write, is the narrowest
 * deviation from the module-boundary convention that still satisfies the S1.3 dispatch. A future
 * task could close this cleanly by adding `GraphStore.getFact(client, workspaceId, factId)` and
 * having this module call it instead.
 */

export interface ExplainPrincipalRef {
  readonly id: string;
  readonly kind: string;
  readonly role: string | null;
  readonly displayName: string | null;
}

export interface ExplainSourceRef {
  readonly id: string;
  readonly kind: string;
  readonly uri: string | null;
  readonly visibility: string;
  readonly ownerPrincipal: ExplainPrincipalRef | null;
}

export interface ExplainObservationRef {
  readonly id: string;
  readonly createdAt: string;
  readonly source: ExplainSourceRef | null;
}

export interface ExplainActivityRef {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly createdAt: string;
  readonly endedAt: string | null;
  readonly startedByPrincipal: ExplainPrincipalRef | null;
  readonly observations: readonly ExplainObservationRef[];
  /**
   * S2.9 addition: `activities.metadata` verbatim (docs/development-tasks.md S2.9 "explain 到该
   * WorkerRun") — `application/task/spawn.ts` already stamps `{taskId, workerRunId}` on every
   * `kind='worker_run'` Activity, and `application/task/result.ts` stamps the same two fields
   * (plus `evidence`, §7.3 "把证据挂到 Activity") on its own `kind='worker_result'` Activity;
   * surfacing the raw object here (rather than inventing typed `taskId`/`workerRunId` fields) lets
   * `explain` reach either without this module special-casing either Activity `kind`.
   */
  readonly metadata: Record<string, unknown>;
}

export interface ExplainFactRef {
  readonly id: string;
  readonly linkType: string;
  readonly epistemicStatus: string;
  readonly assertedByPrincipal: ExplainPrincipalRef | null;
  readonly verifiedByPrincipal: ExplainPrincipalRef | null;
}

export interface ExplainDecisionRef {
  readonly id: string;
  readonly status: string;
  readonly summary: string | null;
  readonly decidedByPrincipal: ExplainPrincipalRef | null;
  readonly source: ExplainSourceRef | null;
}

export interface ExplainResult {
  readonly nodeType: 'fact' | 'activity' | 'decision';
  readonly fact?: ExplainFactRef;
  readonly decision?: ExplainDecisionRef;
  /** `null` only when a Fact/Decision row has no `activity_id` — I3 makes that impossible for a
   *  Fact; `decisions.activity_id` is likewise `not null`, so this is `null` only in practice
   *  never — kept nullable defensively rather than asserted. */
  readonly activity: ExplainActivityRef | null;
}

export type ExplainInput =
  | { readonly factId: string }
  | { readonly activityId: string }
  | { readonly decisionId: string };

export class ExplainNodeNotFoundError extends Error {
  constructor(kind: 'fact' | 'activity' | 'decision', workspaceId: string, nodeId: string) {
    super(`explain: ${kind} not found: workspace ${workspaceId}, id ${nodeId}`);
    this.name = 'ExplainNodeNotFoundError';
  }
}

// -------------------------------------------------------------------------------------------
// Row shapes
// -------------------------------------------------------------------------------------------

interface PrincipalDbRow {
  id: string;
  kind: string;
  role: string;
  display_name: string | null;
}

interface SourceDbRow {
  id: string;
  kind: string;
  uri: string | null;
  visibility: string;
  owner_principal_id: string;
}

interface ObservationDbRow {
  id: string;
  source_id: string;
  created_at: Date;
}

interface ActivityDbRow {
  id: string;
  kind: string;
  status: string;
  created_at: Date;
  ended_at: Date | null;
  started_by: string | null;
  metadata: Record<string, unknown>;
}

interface FactDbRow {
  id: string;
  link_type: string;
  epistemic_status: string;
  activity_id: string;
  asserted_by: string;
  verified_by: string | null;
}

interface DecisionDbRow {
  id: string;
  status: string;
  summary: string | null;
  activity_id: string;
  source_id: string | null;
  decided_by: string | null;
}

// -------------------------------------------------------------------------------------------
// Single-row lookups
// -------------------------------------------------------------------------------------------

async function fetchPrincipalRef(
  client: PoolClient,
  workspaceId: string,
  principalId: string | null,
): Promise<ExplainPrincipalRef | null> {
  if (principalId === null) return null;
  const result = await client.query<PrincipalDbRow>(
    'select id, kind, role, display_name from principals where workspace_id = $1 and id = $2',
    [workspaceId, principalId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id, kind: row.kind, role: row.role, displayName: row.display_name };
}

async function fetchSourceRef(
  client: PoolClient,
  workspaceId: string,
  sourceId: string | null,
): Promise<ExplainSourceRef | null> {
  if (sourceId === null) return null;
  const result = await client.query<SourceDbRow>(
    'select id, kind, uri, visibility, owner_principal_id from sources where workspace_id = $1 and id = $2',
    [workspaceId, sourceId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const ownerPrincipal = await fetchPrincipalRef(client, workspaceId, row.owner_principal_id);
  return {
    id: row.id,
    kind: row.kind,
    uri: row.uri,
    visibility: row.visibility,
    ownerPrincipal,
  };
}

async function fetchObservationRefs(
  client: PoolClient,
  workspaceId: string,
  activityId: string,
): Promise<readonly ExplainObservationRef[]> {
  const result = await client.query<ObservationDbRow>(
    'select id, source_id, created_at from observations where workspace_id = $1 and activity_id = $2 order by created_at asc',
    [workspaceId, activityId],
  );
  const observations: ExplainObservationRef[] = [];
  for (const row of result.rows) {
    const source = await fetchSourceRef(client, workspaceId, row.source_id);
    observations.push({ id: row.id, createdAt: row.created_at.toISOString(), source });
  }
  return observations;
}

async function fetchActivityRef(
  client: PoolClient,
  workspaceId: string,
  activityId: string,
): Promise<ExplainActivityRef | null> {
  const result = await client.query<ActivityDbRow>(
    'select id, kind, status, created_at, ended_at, started_by, metadata from activities where workspace_id = $1 and id = $2',
    [workspaceId, activityId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const [startedByPrincipal, observations] = await Promise.all([
    fetchPrincipalRef(client, workspaceId, row.started_by),
    fetchObservationRefs(client, workspaceId, row.id),
  ]);
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    endedAt: row.ended_at?.toISOString() ?? null,
    startedByPrincipal,
    observations,
    metadata: row.metadata ?? {},
  };
}

// -------------------------------------------------------------------------------------------
// explain
// -------------------------------------------------------------------------------------------

async function explainFact(
  client: PoolClient,
  workspaceId: string,
  factId: string,
): Promise<ExplainResult> {
  const result = await client.query<FactDbRow>(
    'select id, link_type, epistemic_status, activity_id, asserted_by, verified_by from links where workspace_id = $1 and id = $2',
    [workspaceId, factId],
  );
  const row = result.rows[0];
  if (!row) throw new ExplainNodeNotFoundError('fact', workspaceId, factId);

  const [assertedByPrincipal, verifiedByPrincipal, activity] = await Promise.all([
    fetchPrincipalRef(client, workspaceId, row.asserted_by),
    fetchPrincipalRef(client, workspaceId, row.verified_by),
    fetchActivityRef(client, workspaceId, row.activity_id),
  ]);

  return {
    nodeType: 'fact',
    fact: {
      id: row.id,
      linkType: row.link_type,
      epistemicStatus: row.epistemic_status,
      assertedByPrincipal,
      verifiedByPrincipal,
    },
    activity,
  };
}

async function explainActivity(
  client: PoolClient,
  workspaceId: string,
  activityId: string,
): Promise<ExplainResult> {
  const activity = await fetchActivityRef(client, workspaceId, activityId);
  if (!activity) throw new ExplainNodeNotFoundError('activity', workspaceId, activityId);
  return { nodeType: 'activity', activity };
}

async function explainDecision(
  client: PoolClient,
  workspaceId: string,
  decisionId: string,
): Promise<ExplainResult> {
  const result = await client.query<DecisionDbRow>(
    'select id, status, summary, activity_id, source_id, decided_by from decisions where workspace_id = $1 and id = $2',
    [workspaceId, decisionId],
  );
  const row = result.rows[0];
  if (!row) throw new ExplainNodeNotFoundError('decision', workspaceId, decisionId);

  const [decidedByPrincipal, source, activity] = await Promise.all([
    fetchPrincipalRef(client, workspaceId, row.decided_by),
    fetchSourceRef(client, workspaceId, row.source_id),
    fetchActivityRef(client, workspaceId, row.activity_id),
  ]);

  return {
    nodeType: 'decision',
    decision: {
      id: row.id,
      status: row.status,
      summary: row.summary,
      decidedByPrincipal,
      source,
    },
    activity,
  };
}

/**
 * Walks the PROV-O chain for one Fact, Activity (incl. a Turn), or Decision. Throws
 * `ExplainNodeNotFoundError` if the named node does not exist in `workspaceId` (RLS-visible rows
 * only — `client` must already be inside a `withWorkspace()` transaction, same convention as
 * every other substrate method).
 */
export async function explain(
  client: PoolClient,
  workspaceId: string,
  input: ExplainInput,
): Promise<ExplainResult> {
  if ('factId' in input) return explainFact(client, workspaceId, input.factId);
  if ('activityId' in input) return explainActivity(client, workspaceId, input.activityId);
  return explainDecision(client, workspaceId, input.decisionId);
}

/**
 * Resolves the `explain` capability's single `nodeId` param (packages/shared/src/capabilities.ts)
 * to a Fact, Activity, or Decision by probing each table in turn (Fact first, since that is the
 * most common `explain` target), then delegates to {@link explain}. Throws
 * `ExplainNodeNotFoundError` (tagged `'fact'`, matching the first table tried) if `nodeId` names
 * none of the three.
 */
export async function explainByNodeId(
  client: PoolClient,
  workspaceId: string,
  nodeId: string,
): Promise<ExplainResult> {
  try {
    return await explainFact(client, workspaceId, nodeId);
  } catch (err) {
    if (!(err instanceof ExplainNodeNotFoundError)) throw err;
  }
  try {
    return await explainActivity(client, workspaceId, nodeId);
  } catch (err) {
    if (!(err instanceof ExplainNodeNotFoundError)) throw err;
  }
  return explainDecision(client, workspaceId, nodeId);
}
