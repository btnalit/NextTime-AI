import type { PoolClient } from 'pg';
import { ForbiddenError } from './authorize.js';

/**
 * application/gateway/provenance-anchor-guard: the ownership half of the two provenance anchors a
 * caller can name on the graph write path (review 2026-10-02 R-02, maintainer decision D-03).
 *
 * A Fact's origin (`resolveFactOrigin`, substrate/epistemic/conflicts.ts) and its visibility
 * (`link_visible_to_caller`, migrations/core/0013) are both derived from the Activity it traces
 * to and the Sources observed on that Activity. Naming someone else's Activity therefore borrows
 * their origin — an `assert_fact` that supersedes their Fact without a Conflict (I5) and that
 * `explain` attributes to them — and observing a private Source on it hides every Fact of that
 * Activity from everyone. So the handlers that accept these anchors from a caller
 * (`submit_observations`'s `sourceId` and `activityId`, `assert_fact`/`supersede_fact`'s
 * `activityId`) require them to be the caller's own:
 *
 * - a Source's `owner_principal_id` is the caller (checked inline in `submit_observations`, which
 *   already reads the row for its 404);
 * - a caller-supplied Activity's `started_by` is the caller (`assertActivityStartedByCaller`).
 *
 * "The caller" is the handler's `principalId`: the human Principal on the human channel and the
 * Handle's `obo` on the handle channel (dispatch.ts's `callerContext`, I13) — so an agent acting
 * for a person may use that person's Sources and Activities, and nobody else's. The check lives in
 * the handlers only, not in RLS: kernel-internal flows legitimately pair a Source of one owner with
 * an Activity of another (gatekeeper observe/apply, worker_result / worker_session) and never go
 * through these handlers. Refusals are a plain `ForbiddenError` (403 `forbidden` on HTTP and WS).
 */

/** Refuses a caller-supplied `activityId` unless the caller started that Activity. One message for
 *  "no such Activity", "one RLS hides from you" (a private chat's turn) and "someone else's", so the
 *  refusal does not reveal whether a hidden Activity exists. A `started_by` of `null` (a system
 *  Activity) is never the caller's. */
export async function assertActivityStartedByCaller(
  client: PoolClient,
  workspaceId: string,
  capability: string,
  principalId: string,
  activityId: string,
): Promise<void> {
  const result = await client.query<{ started_by: string | null }>(
    'select started_by from activities where workspace_id = $1 and id = $2',
    [workspaceId, activityId],
  );
  if (result.rows[0]?.started_by !== principalId) {
    throw new ForbiddenError(
      `${capability}: activityId ${activityId} is not an Activity the caller started — a caller-supplied activityId must name one started by the calling principal (for a Handle, the principal it acts for); omit it to have this call start its own`,
    );
  }
}
