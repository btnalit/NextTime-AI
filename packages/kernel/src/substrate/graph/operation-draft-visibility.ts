/**
 * substrate/graph/operation-draft-visibility: the one read rule for **Operation drafts**, in both
 * forms — a predicate over a loaded row and the same rule as SQL for queries over `objects` /
 * `links` (review 2026-10-02 D-26; STATUS leftover 123).
 *
 * An Operation is the one meta-ontology entity whose drafts live in the graph: it has no table of
 * its own, so `registerOperationDraftObject` (substrate/ontology/meta-objects.ts) writes the draft
 * as an `objects` row with `properties.status = 'draft'` plus `proposedBy` / `proposedByKind`, and
 * an `exposes` Fact from its Gatekeeper. (WorkerDefinition, Skill and Procedure Objects are
 * projected only when a version is published, so the graph never holds their drafts.)
 *
 * The rule: a draft is visible to its proposer and to the workspace's draft reviewers; published
 * and deprecated rows are visible to everyone; a row with no `status` reads as a draft (as
 * `toOperationRecord` reads it), and a draft with no recorded proposer is nobody's — reviewers
 * only. Who counts as a reviewer is governance's `seesEveryDraft(role)` (owner and builder,
 * governance/capability/publish-authority.ts); substrate may not import governance, so the caller
 * computes that bit and hands it in as `GraphReadViewer.seesEveryDraft` — the same bind value
 * application/worker/draft-visibility.ts's `draftVisibilityBinds` produces.
 *
 * Callers: `operationVisibleTo` / `countOperationsByGatekeeper` (governance/gatekeepers/
 * manifest.ts — the Operation directory) and the generic graph reads (`SqlGraphStore.getObject` /
 * `getObjectsByIds` / `search` / `searchPage` / `traverse` / `stateAt` / `listRecentFacts`, and
 * `explainByNodeId` in substrate/epistemic) when given a viewer. A hidden draft reads exactly like
 * an id that does not exist: no row, and no Fact touching it — so `traverse` neither returns it
 * as a neighbour nor walks through it.
 *
 * No imports: substrate/epistemic uses this file directly, and substrate/graph already depends on
 * substrate/epistemic.
 */

/** Who a graph read is narrowed for: the human caller, or a Handle's `obo` principal (I13). */
export interface GraphReadViewer {
  readonly principalId: string;
  /** governance's `seesEveryDraft(role)` for that principal's workspace role. */
  readonly seesEveryDraft: boolean;
}

/** Whether `viewer` may see an Operation row with this `status` / proposer. */
export function operationDraftVisibleTo(
  viewer: GraphReadViewer,
  row: { readonly status: string | undefined; readonly proposedBy: string | undefined },
): boolean {
  if ((row.status ?? 'draft') !== 'draft') return true;
  if (viewer.seesEveryDraft) return true;
  return row.proposedBy !== undefined && row.proposedBy === viewer.principalId;
}

/**
 * SQL, true when the `objects` row aliased `alias` is an Operation draft hidden from the viewer
 * whose binds are the placeholders `seesEveryParam` (boolean) and `principalParam` (text).
 * Never null for non-null binds (`is distinct from` covers a missing proposer), so `not (...)` is
 * a safe visibility filter. A row-level expression only: no join, no subquery, so it adds no scan
 * to the query it is appended to.
 */
export function operationDraftHiddenSql(
  alias: string,
  seesEveryParam: string,
  principalParam: string,
): string {
  return `(${alias}.object_type = 'Operation'
    and coalesce(${alias}.properties ->> 'status', 'draft') = 'draft'
    and not ${seesEveryParam}::boolean
    and (${alias}.properties ->> 'proposedBy' is distinct from ${principalParam}::text
         or ${alias}.properties ->> 'proposedByKind' is null))`;
}

/**
 * SQL, true when the `links` row aliased `linkAlias` touches (either endpoint) an Operation draft
 * hidden from the viewer. At most two primary-key probes on `objects (workspace_id, id)` per Fact
 * the query already selected; for a reviewer none at all — inside the subquery `not $seesEvery`
 * is a conjunct with no column reference, which Postgres plans as a one-time filter.
 */
export function linkTouchesHiddenOperationDraftSql(
  linkAlias: string,
  seesEveryParam: string,
  principalParam: string,
): string {
  return `exists (
    select 1 from objects hidden_op
    where hidden_op.workspace_id = ${linkAlias}.workspace_id
      and hidden_op.id in (${linkAlias}.source_object_id, ${linkAlias}.target_object_id)
      and ${operationDraftHiddenSql('hidden_op', seesEveryParam, principalParam)}
  )`;
}
