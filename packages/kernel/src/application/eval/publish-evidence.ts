import {
  type DraftEvaluationArmTallyWire,
  type DraftEvaluationEvidenceWire,
  type DraftEvaluationReason,
  type DraftEvaluationSummaryWire,
  type DraftEvaluationVerdict,
  type DraftEvaluationWire,
  FAMILY_HISTORY_VERDICTS,
  type PublishAcknowledgementItemWire,
  type PublishEvaluationReview,
  type SkillPublishCandidateState,
  type SkillPublishEvidenceWire,
  type SkillPublishFamilyEntryWire,
  publishAcknowledgesVerdict,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { seesEveryDraft } from '../../governance/capability/index.js';
import {
  DRAFT_EVALUATION_VISIBLE_TO,
  type DraftEvaluationActor,
  getDraftEvaluation,
  listDraftEvaluations,
  readStageVerdictTrials,
} from './draft-evaluations.js';
import {
  EvaluationChangedError,
  EvaluationReviewRequiredError,
  PublishAcknowledgementInputError,
} from './errors.js';
import { casesToAcknowledge } from './verdict.js';

/**
 * application/eval/publish-evidence: a Skill draft's evaluations as evidence for whoever publishes
 * it (S10 E3-3; docs/s10-evolution-plan-2026-10-04.md §5.5 结果去哪, §5.6 发布审阅, I-E3).
 * Evaluation gives evidence and never publishes, nor stops anyone publishing — but the publish
 * names the evidence it was made on, and acknowledges, one by one with a reason, each failure of an
 * evaluation that found the draft `regressed` or `worse` (victor 2026-10-23 分叉 2 = b).
 *
 * The evidence is the draft's own evaluations — those of exactly its `(skillId, version,
 * draftDigest)`, so of the content being published — that finished; the newest is the one a
 * publish names. Every `regressed` / `worse` one among them asks for its failures to be
 * acknowledged, not only the newest, however many evaluations ran since: running the same content
 * again does not take a failure away. `publish_skill` checks it again in its own transaction,
 * after the draft's row is locked and its not-running check passed (application/worker
 * `publishSkill`): no evaluation of the draft starts or ends meanwhile, so what is checked is what
 * is published on.
 */

/** The draft as reviewed. */
export interface PublishEvidenceTarget {
  readonly skillId: string;
  readonly version: number;
  readonly draftDigest: string;
}

/** How many of the draft's newest finished evaluations the evidence shows (with every older one
 *  whose failures are still acknowledged). */
const EVIDENCE_LIMIT = 20;

/** How many evaluations of the family's other drafts that did not hold `familyHistory` shows. */
const FAMILY_HISTORY_LIMIT = 10;

/** Two arms' tallies added up — `costUsd` `null` when either's is. */
function addTallies(
  a: DraftEvaluationArmTallyWire,
  b: DraftEvaluationArmTallyWire,
): DraftEvaluationArmTallyWire {
  return {
    trials: a.trials + b.trials,
    passed: a.passed + b.passed,
    failed: a.failed + b.failed,
    errored: a.errored + b.errored,
    voided: a.voided + b.voided,
    open: a.open + b.open,
    costUsd: a.costUsd === null || b.costUsd === null ? null : a.costUsd + b.costUsd,
    tokens: a.tokens + b.tokens,
  };
}

const NO_TRIALS: DraftEvaluationArmTallyWire = {
  trials: 0,
  passed: 0,
  failed: 0,
  errored: 0,
  voided: 0,
  open: 0,
  costUsd: 0,
  tokens: 0,
};

function evidenceOf(evaluation: DraftEvaluationWire): DraftEvaluationEvidenceWire {
  const { otherSkills, candidateContent, baselineContent, stages, environments, ...summary } =
    evaluation;
  return {
    ...summary,
    decidingStage: stages.find((s) => s.stage === evaluation.decidedBy) ?? null,
    baselineTotal: stages.map((s) => s.baseline).reduce(addTallies, NO_TRIALS),
    candidateTotal: stages.map((s) => s.candidate).reduce(addTallies, NO_TRIALS),
  };
}

/** The failures of `evaluation` to acknowledge — none unless its verdict asks for them. */
async function acknowledgementsOf(
  client: PoolClient,
  workspaceId: string,
  evaluation: DraftEvaluationWire,
): Promise<PublishAcknowledgementItemWire[]> {
  const stage = evaluation.decidedBy;
  if (
    evaluation.verdict === null ||
    !publishAcknowledgesVerdict(evaluation.verdict) ||
    (stage !== 'regression' && stage !== 'confirm')
  ) {
    return [];
  }
  const deciding = evaluation.stages.find((s) => s.stage === stage);
  if (!deciding) return [];
  const trials = await readStageVerdictTrials(client, workspaceId, evaluation.id, stage);
  const caseIds = casesToAcknowledge(
    evaluation.verdict,
    deciding.cases.map((c) => c.caseId),
    trials,
  );
  return caseIds.flatMap((caseId) => {
    const row = deciding.cases.find((c) => c.caseId === caseId);
    return row
      ? [
          {
            evaluationId: evaluation.id,
            caseId,
            title: row.title,
            split: row.split,
            stage,
            baseline: row.baseline,
            candidate: row.candidate,
          },
        ]
      : [];
  });
}

/** One of the draft's evaluations of exactly this content, in brief. */
interface ContentEvaluationRow {
  readonly id: string;
  readonly status: 'running' | 'finished';
  readonly verdict: DraftEvaluationVerdict | null;
  readonly reason: DraftEvaluationReason | null;
}

/** Every evaluation of exactly the draft's content that `viewer` may see and that runs or
 *  finished, newest first — ids and verdicts only, so all of them, however many: an old one's
 *  failures are acknowledged as much as the newest's. */
async function readContentEvaluations(
  client: PoolClient,
  workspaceId: string,
  viewer: DraftEvaluationActor,
  target: PublishEvidenceTarget,
): Promise<readonly ContentEvaluationRow[]> {
  const rows = await client.query<ContentEvaluationRow>(
    `select e.id, e.status, e.verdict, e.reason from eval_draft_evaluations e
      where e.workspace_id = $1 and e.skill_id = $4 and e.skill_version = $5
        and e.draft_digest = $6 and e.status in ('running', 'finished')
        and ${DRAFT_EVALUATION_VISIBLE_TO('$2', '$3')}
      order by e.created_at desc, e.id desc`,
    [
      workspaceId,
      seesEveryDraft(viewer.role),
      viewer.principalId,
      target.skillId,
      target.version,
      target.draftDigest,
    ],
  );
  return rows.rows;
}

function acknowledged(row: ContentEvaluationRow): boolean {
  return (
    row.status === 'finished' && row.verdict !== null && publishAcknowledgesVerdict(row.verdict)
  );
}

/** The failures to acknowledge over `evaluations`, in their order. */
async function acknowledgementsOver(
  client: PoolClient,
  workspaceId: string,
  evaluations: Iterable<DraftEvaluationWire>,
): Promise<PublishAcknowledgementItemWire[]> {
  const items: PublishAcknowledgementItemWire[] = [];
  for (const evaluation of evaluations) {
    items.push(...(await acknowledgementsOf(client, workspaceId, evaluation)));
  }
  return items;
}

/** What the draft's evaluations say to whoever publishes it — those `viewer` may see (as
 *  `get_draft_evaluation`), so nothing for a draft they may not see. */
export async function readSkillPublishEvidence(
  client: PoolClient,
  workspaceId: string,
  viewer: DraftEvaluationActor,
  target: PublishEvidenceTarget,
): Promise<SkillPublishEvidenceWire> {
  const rows = await readContentEvaluations(client, workspaceId, viewer, target);
  // The newest EVIDENCE_LIMIT, and every older one whose failures are still acknowledged.
  const shown = rows
    .filter((r) => r.status === 'finished')
    .filter((r, index) => index < EVIDENCE_LIMIT || acknowledged(r));
  const evaluations: DraftEvaluationWire[] = [];
  for (const row of shown) {
    evaluations.push(await getDraftEvaluation(client, workspaceId, viewer, row.id));
  }
  return {
    evaluations: evaluations.map(evidenceOf),
    runningEvaluationId: rows.find((r) => r.status === 'running')?.id ?? null,
    acknowledge: await acknowledgementsOver(client, workspaceId, evaluations),
    familyHistory: await withCandidateState(
      client,
      workspaceId,
      await listDraftEvaluations(client, workspaceId, viewer, {
        skillId: target.skillId,
        verdicts: FAMILY_HISTORY_VERDICTS,
        notContent: { version: target.version, draftDigest: target.draftDigest },
        limit: FAMILY_HISTORY_LIMIT,
      }),
    ),
  };
}

/** Each evaluation with what became of the draft it evaluated (#842 UX P2-1): its version, if that
 *  very content is still there — a draft, or published (and maybe deprecated) since — else
 *  `rejected` when a rejection of that content is recorded (`draft_rejections`), else `discarded`
 *  by its proposer. */
async function withCandidateState(
  client: PoolClient,
  workspaceId: string,
  evaluations: readonly DraftEvaluationSummaryWire[],
): Promise<SkillPublishFamilyEntryWire[]> {
  if (evaluations.length === 0) return [];
  const states = await client.query<{ id: string; state: SkillPublishCandidateState }>(
    `select e.id,
            coalesce(v.status,
                     case when exists (
                       select 1 from draft_rejections r
                        where r.workspace_id = e.workspace_id and r.kind = 'skill'
                          and r.family_id = e.skill_id and r.version = e.skill_version
                          and r.draft_digest = e.draft_digest)
                     then 'rejected' else 'discarded' end) as state
       from eval_draft_evaluations e
       left join skills v on v.workspace_id = e.workspace_id and v.id = e.skill_id
        and v.version = e.skill_version and v.proposed_by = e.candidate_proposed_by
        and v.name = e.candidate_name and v.description = e.candidate_description
        and v.markdown = e.candidate_markdown
      where e.workspace_id = $1 and e.id = any($2::uuid[])`,
    [workspaceId, evaluations.map((e) => e.id)],
  );
  const stateOf = new Map(states.rows.map((r) => [r.id, r.state] as const));
  return evaluations.map((e) => ({ ...e, candidateState: stateOf.get(e.id) ?? 'discarded' }));
}

/** What the publish's audit record says of its evidence: the evaluation it was made on (`null`:
 *  none) with its verdict and why, and how many failures the publish acknowledged — over every
 *  evaluation of the content that asks for them, not only that one (review #493 on #842, O1); the
 *  acknowledgements themselves, each with its evaluation and reason, are in its params. */
export interface PublishEvidenceAudit {
  readonly evaluation: {
    readonly id: string;
    readonly verdict: string | null;
    readonly reason: string | null;
  } | null;
  readonly acknowledgedFailures: number;
}

/**
 * Checks what the publisher reviewed (`review`; omitted is "none") against the draft's evidence
 * now, in the publish's transaction — after `publishSkill` locked the draft and found none of its
 * evaluations running. Another evaluation finished since is `EvaluationChangedError`; a failure to
 * acknowledge with no acknowledgement is `EvaluationReviewRequiredError` (each named); an
 * acknowledgement of no such failure, or of one twice, is `PublishAcknowledgementInputError`. A
 * throw rolls the publish back.
 */
export async function checkPublishEvidence(
  client: PoolClient,
  workspaceId: string,
  publisher: DraftEvaluationActor,
  target: PublishEvidenceTarget,
  review: PublishEvaluationReview | undefined,
): Promise<PublishEvidenceAudit> {
  // Not the whole evidence: the newest evaluation's id and verdict, and the failures of those that
  // ask for them — read under the registry lock `publishSkill` holds, so no more than that.
  const rows = await readContentEvaluations(client, workspaceId, publisher, target);
  const latest = rows.find((r) => r.status === 'finished') ?? null;
  const reviewed = review?.evaluationId ?? null;
  if (reviewed !== (latest?.id ?? null)) {
    throw new EvaluationChangedError(reviewed, latest?.id ?? null);
  }
  const asking: DraftEvaluationWire[] = [];
  for (const row of rows.filter(acknowledged)) {
    asking.push(await getDraftEvaluation(client, workspaceId, publisher, row.id));
  }
  const acknowledge = await acknowledgementsOver(client, workspaceId, asking);
  const key = (item: { readonly evaluationId: string; readonly caseId: string }) =>
    `${item.evaluationId}/${item.caseId}`;
  const needed = new Set(acknowledge.map(key));
  const given = new Set<string>();
  for (const acknowledgement of review?.acknowledgements ?? []) {
    const k = key(acknowledgement);
    if (given.has(k)) {
      throw new PublishAcknowledgementInputError(
        `evaluationReview.acknowledgements names case ${acknowledgement.caseId} of evaluation ${acknowledgement.evaluationId} twice`,
      );
    }
    if (!needed.has(k)) {
      throw new PublishAcknowledgementInputError(
        `evaluationReview.acknowledgements names case ${acknowledgement.caseId} of evaluation ${acknowledgement.evaluationId}, which is no failure of this draft's evaluations to acknowledge`,
      );
    }
    given.add(k);
  }
  const missing = acknowledge.filter((item) => !given.has(key(item)));
  if (missing.length > 0) {
    throw new EvaluationReviewRequiredError(
      missing.map((item) => ({ evaluationId: item.evaluationId, caseId: item.caseId })),
    );
  }
  return {
    evaluation: latest ? { id: latest.id, verdict: latest.verdict, reason: latest.reason } : null,
    acknowledgedFailures: given.size,
  };
}
