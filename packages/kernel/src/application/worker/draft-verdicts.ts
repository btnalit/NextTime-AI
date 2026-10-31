import {
  type DraftEvaluationDevVerdict,
  SKILL_DRAFT_VERDICTS_LIMIT,
  type SkillDraftVerdictsWire,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';

/**
 * What the proposer of a Skill's drafts — and an agent acting for them — is told of their
 * evaluations (S10 E3-3, `get_skill_draft_verdicts`; docs/s10-evolution-plan-2026-10-04.md §3.3
 * I-E4, §5.5 封闭 / 防噪: the Handle sees the verdict on `dev` only, never the pass counts). Read
 * from worker/0010–0012 `eval_draft_evaluations` as `draft-evaluating.ts` reads it — a few columns
 * of the row, nothing of the suite, the cases, the trials or the verdict people see — so this
 * Handle-channel read never reaches `application/eval` (`.dependency-cruiser.cjs`).
 *
 *   - **Whose**: the evaluations of drafts `viewerPrincipalId` proposed (`candidate_proposed_by`,
 *     kept after the draft is discarded, rejected or published). Not every draft the viewer may
 *     see: the owner and builders see every draft, but each is told only of their own (I-E4
 *     "自己草稿") — their agents likewise.
 *   - **Which**: finished with a dev verdict — one that finished before the dev verdict was kept
 *     (worker/0012) has none to give, and a cancelled one gave nothing. Not one that still runs:
 *     an agent polling until it shows up finished would time it (#845 review).
 *   - **What**: version, the content's digest and the dev verdict. No time: how long one ran
 *     would say how far it got.
 */
export async function readSkillDraftVerdicts(
  client: PoolClient,
  workspaceId: string,
  viewerPrincipalId: string,
  skillId: string,
): Promise<SkillDraftVerdictsWire> {
  const rows = await client.query<{
    skill_version: number;
    draft_digest: string;
    dev_verdict: DraftEvaluationDevVerdict;
  }>(
    `select skill_version, draft_digest, dev_verdict from eval_draft_evaluations
      where workspace_id = $1 and skill_id = $2 and candidate_proposed_by = $3
        and status = 'finished' and dev_verdict is not null
      order by created_at desc, id desc
      limit $4`,
    [workspaceId, skillId, viewerPrincipalId, SKILL_DRAFT_VERDICTS_LIMIT + 1],
  );
  const items = rows.rows.slice(0, SKILL_DRAFT_VERDICTS_LIMIT).map((row) => ({
    version: row.skill_version,
    draftDigest: row.draft_digest,
    devVerdict: row.dev_verdict,
  }));
  return rows.rows.length > SKILL_DRAFT_VERDICTS_LIMIT ? { items, truncated: true } : { items };
}
