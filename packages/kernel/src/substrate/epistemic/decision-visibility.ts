/**
 * substrate/epistemic/decision-visibility (STATUS legacy 421): who may read a Decision — the half
 * of the rule the database cannot apply on its own.
 *
 * A Decision is shown only to whoever may see what it is about. migrations/governance/0028 records
 * that subject on the row (set by the database on every insert, from the Decision's Activity) and
 * applies two parts in `decisions_visibility`: a Decision of a conversation reads like the
 * conversation, a conflict ruling like its Conflict. The other two parts depend on the channel —
 * the workspace owner sees every goal run only on the human channel (application/goal's
 * `seesEveryRun`) — which RLS cannot see, so every epistemic read of Decisions (`query_decisions`,
 * `find_precedents`, `causal_chain`, `decision_impact`, `explain`, `export_prov`, the Explorer)
 * appends {@link decisionVisibleSql} with the caller's {@link DecisionViewer}:
 *
 *   - `goal_run_id` set (an outcome Decision, or a reconcile Decision of a goal step's request):
 *     the owner on the human channel and the run's requester — `get_goal`'s rule;
 *   - else `action_request_id` set (an approval or reconcile Decision): whoever `get_action` shows
 *     the request to — the owner, a holder of a matching scope, the requester
 *     ({@link actionRequestVisibleToCallerSql}, the one definition both use);
 *   - else `subject_unresolved` (it names a subject that does not resolve): the owner on the human
 *     channel only;
 *   - else everyone RLS lets through.
 *
 * A hidden Decision reads exactly like an id that does not exist.
 *
 * **Cross-table reads**: `goal_runs` is application/goal's table, `action_requests` and
 * `capability_grants` governance's — the same read-only-SQL precedent decisions.ts's module comment
 * sets out (substrate may not import either module). The caller computes the two "sees every"
 * bits from the role and channel and hands them in.
 */

/** Who an epistemic read of Decisions is for. */
export interface DecisionViewer {
  /** The human caller, or a Handle's `obo` principal (I13). */
  readonly principalId: string;
  /** The workspace owner on the human channel: every goal run's Decisions, and those whose subject
   *  does not resolve (application/goal's `seesEveryRun`). */
  readonly seesEveryGoalRun: boolean;
  /** The workspace owner, on either channel: every request's Decisions (`get_action`'s rule,
   *  governance/approval/reads.ts). */
  readonly seesEveryActionRequest: boolean;
}

/** governance/capability/grants.ts's `GATEKEEPER_GRANT_CAPABILITY` — the `resource_type` of a
 *  grant on a whole gate. Restated here (substrate may not import governance); grants.test.ts holds
 *  the two equal. */
export const GATEKEEPER_GRANT_RESOURCE_TYPE = 'gatekeeper';

/**
 * R-42 (maintainer decision D-22, docs/code-review-2026-10-02.md): who may *read* an
 * ActionRequest. `get_action` and `list_action_requests` share this one predicate, so a single-row
 * read never shows more than the list does: the workspace owner sees every row; anyone else sees
 * a row whose `action_kind` / `resource_scope` matches one of their own active
 * `capability_grants` (I14 — the same match `listPendingForApprover` and `approverHasScope` use,
 * including item 2's "gatekeeper grant satisfies I14" branch), or a row they requested themselves
 * (`on_behalf_of` — design doc §8.5: the requester follows their own request's status even
 * without the scope to decide it). The table alias is always `ar`; `isOwnerParam` /
 * `principalParam` are the calling query's own positional placeholders for "the caller is the
 * workspace owner" and the caller's principal id. Moved here from governance/approval/reads.ts
 * (legacy 421) so a request's Decisions are read under exactly this rule.
 */
export function actionRequestVisibleToCallerSql(
  isOwnerParam: string,
  principalParam: string,
): string {
  return `(
    ${isOwnerParam}::boolean
    or ar.on_behalf_of = ${principalParam}::uuid
    or exists (
      select 1 from capability_grants cg
      where cg.workspace_id = ar.workspace_id
        and cg.principal_id = ${principalParam}::uuid
        and cg.status = 'active'
        and (cg.expires_at is null or cg.expires_at > now())
        and (
          (cg.resource_type = ar.action_kind
           and (cg.resource_id is null or cg.resource_id::text = ar.resource_scope))
          or (
            ar.resource_scope is not null
            and cg.resource_type = '${GATEKEEPER_GRANT_RESOURCE_TYPE}'
            and (cg.resource_id is null or cg.resource_id::text = ar.resource_scope)
          )
        )
    )
  )`;
}

/**
 * SQL, true when `viewer` may read the `decisions` row aliased `alias` (module comment).
 * `workspaceParam` is the calling query's own placeholder for the workspace id (every caller filters
 * `alias.workspace_id` on it); the three binds start at `$firstParam`: append `values` to the
 * query's own, in order. Never null for non-null binds.
 *
 * **Query plan**: each subject's check is an uncorrelated `in (select …)` — the runs the caller
 * requested, the requests `get_action` shows them — so Postgres builds each set once per query and
 * probes it per row. Written as a correlated `exists` it plans the same hashed lookup but costs it
 * per row, and on a large workspace that estimate alone crosses `jit_above_cost`: half a second of
 * JIT compile on every read (measured on 200k Decisions; governance 0028 writes its policy the same
 * way for the same reason).
 */
export function decisionVisibleSql(
  alias: string,
  viewer: DecisionViewer,
  workspaceParam: string,
  firstParam: number,
): { readonly sql: string; readonly values: readonly [boolean, boolean, string] } {
  const goal = `$${firstParam}`;
  const request = `$${firstParam + 1}`;
  const principal = `$${firstParam + 2}`;
  return {
    sql: `(case
      when ${alias}.goal_run_id is not null then
        ${goal}::boolean or ${alias}.goal_run_id in (
          select g.id from goal_runs g
          where g.workspace_id = ${workspaceParam}::uuid
            and g.on_behalf_of = ${principal}::uuid
        )
      when ${alias}.action_request_id is not null then
        ${request}::boolean or ${alias}.action_request_id in (
          select ar.id from action_requests ar
          where ar.workspace_id = ${workspaceParam}::uuid
            and ${actionRequestVisibleToCallerSql('false', principal)}
        )
      else not ${alias}.subject_unresolved or ${goal}::boolean
    end)`,
    values: [viewer.seesEveryGoalRun, viewer.seesEveryActionRequest, viewer.principalId],
  };
}
