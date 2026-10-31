import {
  type DraftEvaluationArmTallyWire,
  type DraftEvaluationEvidenceWire,
  type DraftEvaluationWire,
  FAMILY_HISTORY_VERDICTS,
  type PublishAcknowledgementItemWire,
  type PublishEvaluationReview,
  type SkillPublishEvidenceWire,
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
 * acknowledged, not only the newest: running the same content again does not take a failure away.
 * `publish_skill` reads it again in its own transaction, after the draft's row is locked and its
 * not-running check passed (application/worker `publishSkill`): no evaluation of the draft starts
 * or ends meanwhile, so what is checked is what is published on.
 */

/** The draft as reviewed. */
export interface PublishEvidenceTarget {
  readonly skillId: string;
  readonly version: number;
  readonly draftDigest: string;
}

/** How many of the draft's finished evaluations the evidence holds. */
const EVIDENCE_LIMIT = 20;

/** How many of the family's other drafts that did not hold `familyHistory` shows. */
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

/** What the draft's evaluations say to whoever publishes it — those `viewer` may see (as
 *  `get_draft_evaluation`), so nothing for a draft they may not see. */
export async function readSkillPublishEvidence(
  client: PoolClient,
  workspaceId: string,
  viewer: DraftEvaluationActor,
  target: PublishEvidenceTarget,
): Promise<SkillPublishEvidenceWire> {
  const rows = await client.query<{ id: string; status: 'running' | 'finished' }>(
    `select e.id, e.status from eval_draft_evaluations e
      where e.workspace_id = $1 and e.skill_id = $4 and e.skill_version = $5
        and e.draft_digest = $6 and e.status in ('running', 'finished')
        and ${DRAFT_EVALUATION_VISIBLE_TO('$2', '$3')}
      order by e.created_at desc, e.id desc
      limit $7`,
    [
      workspaceId,
      seesEveryDraft(viewer.role),
      viewer.principalId,
      target.skillId,
      target.version,
      target.draftDigest,
      // One runs at a time.
      EVIDENCE_LIMIT + 1,
    ],
  );
  const finished = rows.rows.filter((r) => r.status === 'finished').slice(0, EVIDENCE_LIMIT);
  const evaluations: DraftEvaluationWire[] = [];
  for (const row of finished) {
    evaluations.push(await getDraftEvaluation(client, workspaceId, viewer, row.id));
  }
  const acknowledge: PublishAcknowledgementItemWire[] = [];
  for (const evaluation of evaluations) {
    acknowledge.push(...(await acknowledgementsOf(client, workspaceId, evaluation)));
  }
  const family = await listDraftEvaluations(client, workspaceId, viewer, {
    skillId: target.skillId,
  });
  return {
    evaluations: evaluations.map(evidenceOf),
    runningEvaluationId: rows.rows.find((r) => r.status === 'running')?.id ?? null,
    acknowledge,
    familyHistory: family
      .filter(
        (e) =>
          e.status === 'finished' &&
          e.verdict !== null &&
          (FAMILY_HISTORY_VERDICTS as readonly string[]).includes(e.verdict) &&
          !(
            e.candidate.version === target.version && e.candidate.draftDigest === target.draftDigest
          ),
      )
      .slice(0, FAMILY_HISTORY_LIMIT),
  };
}

/** What the publish's audit record says of its evidence: the evaluation it was made on (`null`:
 *  none), its verdict and why, and how many failures it acknowledged — the acknowledgements
 *  themselves, with their reasons, are in its params. */
export interface PublishEvidenceAudit {
  readonly evaluation: {
    readonly id: string;
    readonly verdict: string | null;
    readonly reason: string | null;
    readonly acknowledged: number;
  } | null;
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
  const evidence = await readSkillPublishEvidence(client, workspaceId, publisher, target);
  const latest = evidence.evaluations[0] ?? null;
  const reviewed = review?.evaluationId ?? null;
  if (reviewed !== (latest?.id ?? null)) {
    throw new EvaluationChangedError(reviewed, latest?.id ?? null);
  }
  const key = (item: { readonly evaluationId: string; readonly caseId: string }) =>
    `${item.evaluationId}/${item.caseId}`;
  const needed = new Set(evidence.acknowledge.map(key));
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
  const missing = evidence.acknowledge.filter((item) => !given.has(key(item)));
  if (missing.length > 0) {
    throw new EvaluationReviewRequiredError(
      missing.map((item) => ({ evaluationId: item.evaluationId, caseId: item.caseId })),
    );
  }
  return {
    evaluation: latest
      ? {
          id: latest.id,
          verdict: latest.verdict,
          reason: latest.reason,
          acknowledged: given.size,
        }
      : null,
  };
}
