import { type Operation, operationAbsentAnswers } from '@nexttime/shared';

/**
 * governance/gatekeepers/absent-answers-review (S11 「门确认不存在」 B-a): a person confirms, when an
 * observe Operation declaring answers that mean "does not exist" (`absent_statuses` /
 * `absent_exit_codes`, `operationAbsentAnswers`) is published, that the gate's credentials can see
 * what such a call looks up — so the target gives those answers only when the thing is not there,
 * never for "no permission", a wrong address or a misconfigured proxy (a 404), nor for another
 * failure the command reports with the same exit code (`ls`, `stat`, `kubectl`). Goal acceptance
 * takes a gate's `absent` answer as evidence that something was removed (B-b), and that evidence
 * is worth only what this confirmation says: a 404 for a hidden resource would "prove" a deletion
 * that never happened.
 *
 * **Who confirms.** `publish_operation` is a human-channel capability (never in any Handle's
 * scope: `@nexttime/shared`'s `HUMAN_ONLY_CAPABILITY_NAMES`), and its `absentAnswersReviewed`
 * counts only with the resolved person calling it (`PublishOperationInput.actor`): the confirmer
 * recorded is that person. Nothing an agent writes carries a confirmation — a proposal's or a manifest's definition never holds one
 * (`registerOperationDraftObject` drops the keys), and the bulk paths that publish without a person
 * (`publish_manifest`, `enable_gate_instance`) leave a declaring draft unpublished
 * (`absentAnswerDrafts`) for one to publish it.
 *
 * **What is recorded.** The published version's `absentAnswersReviewedBy` (the principal) and
 * `absentAnswersReviewedAt` — bookkeeping keys beside its definition, like `proposedBy`. A version's
 * definition never changes after publish (a revision is a new version), so the confirmation stays
 * bound to the declaration it was given for. A ChangePlan revision keeps the live version's
 * definition and so carries its live version's confirmation (`publishOperationRevision`).
 */

export type OperationAbsentAnswers = NonNullable<ReturnType<typeof operationAbsentAnswers>>;

/** Who confirmed a version's `absentAnswers`, and when (ISO 8601). */
export interface OperationAbsentAnswersReview {
  readonly reviewedBy: string;
  readonly reviewedAt: string;
}

/** A gate's draft a bulk publish left unpublished because it declares answers that mean "does not
 *  exist", with those answers. */
export interface AbsentAnswerDraft {
  readonly name: string;
  readonly absentAnswers: OperationAbsentAnswers;
}

export class AbsentAnswersReviewRequiredError extends Error {
  readonly code = 'absent_answers_review_required' as const;
  readonly details: { readonly absentAnswers: OperationAbsentAnswers };
  constructor(id: string, absentAnswers: OperationAbsentAnswers) {
    const answers =
      'statuses' in absentAnswers
        ? `status(es) ${absentAnswers.statuses.join(', ')}`
        : `exit status(es) ${absentAnswers.exitCodes.join(', ')}`;
    super(
      `Operation ${id} declares that the target's ${answers} mean "does not exist" — confirm with absentAnswersReviewed: true that the gate's credentials can see what it looks up, so it gives those answers only when the thing is not there (not for no permission, a wrong address, or any other failure that gives the same answer)`,
    );
    this.name = 'AbsentAnswersReviewRequiredError';
    this.details = { absentAnswers };
  }
}

/** The answers `operation` declares mean "does not exist" (observe class only), or `undefined`. */
export function absentAnswersOfDefinition(
  operation: Pick<Operation, 'mode' | 'binding'>,
): OperationAbsentAnswers | undefined {
  return operationAbsentAnswers(operation);
}

/** The bookkeeping keys a published version keeps its confirmation under. */
export const ABSENT_ANSWERS_REVIEW_KEYS = [
  'absentAnswersReviewedBy',
  'absentAnswersReviewedAt',
] as const;

/** `properties`' confirmation, when both keys hold strings. */
export function absentAnswersReviewOf(
  properties: Readonly<Record<string, unknown>>,
): OperationAbsentAnswersReview | undefined {
  const reviewedBy = properties.absentAnswersReviewedBy;
  const reviewedAt = properties.absentAnswersReviewedAt;
  return typeof reviewedBy === 'string' && typeof reviewedAt === 'string'
    ? { reviewedBy, reviewedAt }
    : undefined;
}

/** The properties `review` is stored as. */
export function absentAnswersReviewProperties(
  review: OperationAbsentAnswersReview,
): Record<(typeof ABSENT_ANSWERS_REVIEW_KEYS)[number], string> {
  return {
    absentAnswersReviewedBy: review.reviewedBy,
    absentAnswersReviewedAt: review.reviewedAt,
  };
}
