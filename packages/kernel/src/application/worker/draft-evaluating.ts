import type { PoolClient } from 'pg';

/** 409 draft_evaluating (S10 E3-2b, §3.4 草稿的评测子状态): a draft evaluation of this Skill draft
 *  is running, so the draft stays until it ends (or someone cancels it) — not discarded, rejected,
 *  expired or (E3-3) published: its evidence is not in yet. `application/eval` refuses a second
 *  evaluation of it with the same error. The database holds the deletes too (migrations/worker/
 *  0010's `skills_keep_evaluating_draft`). */
export class DraftEvaluatingError extends Error {
  readonly code = 'draft_evaluating' as const;
  constructor(id: string, version: number) {
    super(
      `Skill ${id}@${version} is being evaluated — wait for the evaluation to end, or cancel it, first; nothing was changed`,
    );
    this.name = 'DraftEvaluatingError';
  }
}

/** Refuses with `DraftEvaluatingError` while a draft evaluation of Skill draft `ref` runs
 *  (worker/0010 `eval_draft_evaluations`, read here as `eval-seal` reads `eval_suites`: one row's
 *  existence, no content). The caller holds the draft's row lock, which a start's share lock waits
 *  for, so none starts until it commits. */
export async function assertDraftNotEvaluating(
  client: PoolClient,
  workspaceId: string,
  ref: { readonly id: string; readonly version: number },
): Promise<void> {
  const running = await client.query(
    `select 1 from eval_draft_evaluations
      where workspace_id = $1 and skill_id = $2 and skill_version = $3 and status = 'running'
      limit 1`,
    [workspaceId, ref.id, ref.version],
  );
  if ((running.rowCount ?? 0) > 0) throw new DraftEvaluatingError(ref.id, ref.version);
}
