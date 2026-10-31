import type {
  DraftEvaluationDevVerdict,
  DraftEvaluationReason,
  DraftEvaluationStageName,
  DraftEvaluationVerdict,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import {
  endActivity,
  recordSourceObservation,
  registerPrivateSource,
  startActivity,
} from '../../substrate/epistemic/index.js';
import { getOrCreateEvaluationPrincipal } from './principal.js';

/**
 * application/eval/summary: the one Observation the graph holds of a finished draft evaluation
 * (S10 E3-3; docs/s10-evolution-plan-2026-10-04.md §3.1 EvalRun "专用表行 + 一条摘要 Observation
 * （其 Activity `kind=evaluation`，不含用例内容）", §3.2 "EvalRun generated 一条摘要 Observation，作为
 * 发布审阅的 Evidence", §3.3 I-E4). Written in the transaction that finishes the evaluation
 * (`draft-evaluations.ts` `finishEvaluation`), which the trial tick runs as the evaluation
 * Principal; its id goes on the evaluation's row (migrations/worker/0012), and a publish made on
 * the evaluation names it in its audit record.
 *
 *   - **What it says**: the evaluation's id, the draft it evaluated (family, version, content
 *     digest), the suite version, the verdict, why and the stage that decided it, and the dev
 *     verdict the proposer is told. Never a case, a score or a transcript — those stay in the
 *     `eval_*` tables, read through human-channel capabilities only.
 *   - **Who reads it**: no one but the evaluation Principal. Its Source is the workspace's
 *     evaluation Source, `private` to that Principal, so RLS on `observations` hides the row from
 *     every other Principal's transaction — an agent's (whatever its person's role), and a
 *     person's alike; people read the evaluation itself. The verdict here is the one people see,
 *     holdout included, which an agent is never told (§5.5 封闭: only `dev`), and `explain` /
 *     `export_prov` / any later read of Observations cannot show it to one.
 *   - **Its Activity** (`kind = 'evaluation'`, started by the evaluation Principal) is
 *     workspace-visible like every Activity: its metadata names the evaluation and nothing else.
 */

export const EVALUATION_ACTIVITY_KIND = 'evaluation';
export const EVALUATION_SOURCE_KIND = 'evaluation';

export interface EvaluationSummary {
  readonly evaluationId: string;
  readonly skillId: string;
  readonly version: number;
  readonly draftDigest: string;
  readonly suiteId: string;
  readonly suiteVersion: number;
  readonly verdict: DraftEvaluationVerdict;
  readonly reason: DraftEvaluationReason;
  readonly decidedBy: DraftEvaluationStageName;
  readonly devVerdict: DraftEvaluationDevVerdict;
}

/** The workspace's evaluation Source, created the first time an evaluation finishes. Found by kind
 *  and owner (the evaluation Principal — no one else's transaction can write a `private` Source it
 *  owns), not by name: a name would be one any member could take first with `register_source`. */
async function getOrCreateEvaluationSource(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
): Promise<string> {
  const find = async (): Promise<string | undefined> => {
    const found = await client.query<{ id: string }>(
      `select id from sources
        where workspace_id = $1 and kind = $2 and owner_principal_id = $3
          and visibility = 'private'
        order by created_at, id limit 1`,
      [workspaceId, EVALUATION_SOURCE_KIND, principalId],
    );
    return found.rows[0]?.id;
  };
  const existing = await find();
  if (existing) return existing;
  await client.query('select pg_advisory_xact_lock(hashtext($1::text))', [
    `${workspaceId}:evaluation-source`,
  ]);
  const raced = await find();
  if (raced) return raced;
  const source = await registerPrivateSource(client, workspaceId, {
    kind: EVALUATION_SOURCE_KIND,
    ownerPrincipalId: principalId,
    metadata: { purpose: 'draft_evaluation_summaries' },
  });
  return source.id;
}

/** Records the summary Observation of a finished evaluation and returns its id. Run as the
 *  evaluation Principal (the trial tick's transaction): RLS refuses the private Source's row to
 *  any other — this throws rather than write a summary someone else could read. */
export async function recordEvaluationSummary(
  client: PoolClient,
  workspaceId: string,
  summary: EvaluationSummary,
): Promise<string> {
  const principalId = await getOrCreateEvaluationPrincipal(client, workspaceId);
  const activity = await startActivity(client, workspaceId, {
    kind: EVALUATION_ACTIVITY_KIND,
    principalId,
    metadata: { draftEvaluationId: summary.evaluationId },
  });
  const sourceId = await getOrCreateEvaluationSource(client, workspaceId, principalId);
  const observation = await recordSourceObservation(client, workspaceId, {
    sourceId,
    activityId: activity.id,
    content: {
      purpose: 'draft_evaluation',
      evaluationId: summary.evaluationId,
      kind: 'skill',
      skillId: summary.skillId,
      version: summary.version,
      draftDigest: summary.draftDigest,
      suiteId: summary.suiteId,
      suiteVersion: summary.suiteVersion,
      verdict: summary.verdict,
      reason: summary.reason,
      decidedBy: summary.decidedBy,
      devVerdict: summary.devVerdict,
    },
  });
  await endActivity(client, workspaceId, activity.id, 'completed');
  return observation.id;
}
