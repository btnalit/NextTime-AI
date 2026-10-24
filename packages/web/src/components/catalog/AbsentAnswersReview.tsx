import type { OperationAbsentAnswersWire } from '@nexttime/shared';
import { useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import { formatRelative } from '../../lib/format.js';
import {
  type OperationCatalogRow,
  absentAnswersOnlyWhenText,
  absentAnswersWhenText,
} from '../../lib/governance.js';
import { HttpError } from '../../lib/http-client.js';
import { sentenceGap, useT } from '../../lib/i18n.js';
import { RefChip } from '../kit/ref-chip.js';

/**
 * components/catalog/AbsentAnswersReview (S11 「门确认不存在」 B-a): the question in front of
 * Publish on an observe Operation draft that declares answers meaning "does not exist"
 * (`OperationCatalogRow.absentAnswers`), and, on a published version, who answered it.
 *
 * Goal acceptance takes such an answer as evidence that something was removed, so it is worth only
 * what the publisher confirms: the gate's credentials can see what the call looks up, and the
 * target gives these answers only when it is not there — not for "no permission", a wrong address
 * or a misconfigured proxy. The catalog asks before the click (the row says the draft declares
 * some), keeps Publish disabled until it is ticked and sends `absentAnswersReviewed: true`. The
 * kernel enforces the same rule (400 `absent_answers_review_required`); a refusal the row did not
 * predict (an older read of the row) opens the same question. The tick is for one draft's content:
 * keyed by its digest, so a re-import that rewrites the draft drops it.
 */

export interface AbsentAnswersReviewState {
  /** The answers to confirm, or `null` when this draft asks for no confirmation. */
  readonly answers: OperationAbsentAnswersWire | null;
  readonly checked: boolean;
  readonly blocked: boolean;
  readonly setChecked: (checked: boolean) => void;
  /** `publish_operation`'s param, when there is something confirmed to send. */
  readonly params: () => { absentAnswersReviewed?: true };
  /** Takes the kernel's refusal; `true` when it was this one (the question opens). */
  readonly capture: (err: unknown) => boolean;
}

/** The declared answers a 400 `absent_answers_review_required` names, or `null` for anything else. */
function refusedAnswers(err: unknown): OperationAbsentAnswersWire | null {
  if (!(err instanceof HttpError) || err.code !== 'absent_answers_review_required') return null;
  const answers = err.details?.absentAnswers;
  if (answers === null || typeof answers !== 'object') return null;
  const value = answers as Record<string, unknown>;
  if (Array.isArray(value.statuses)) {
    return { statuses: value.statuses.filter((s): s is number => typeof s === 'number') };
  }
  if (Array.isArray(value.exitCodes)) {
    return { exitCodes: value.exitCodes.filter((c): c is number => typeof c === 'number') };
  }
  return null;
}

export function useAbsentAnswersReview(
  subjectKey: string | null,
  row: Pick<OperationCatalogRow, 'status' | 'absentAnswers'> | undefined,
): AbsentAnswersReviewState {
  const [state, setState] = useState<{
    readonly key: string | null;
    readonly refused: OperationAbsentAnswersWire | null;
    readonly checked: boolean;
  }>({ key: null, refused: null, checked: false });
  const current = subjectKey !== null && state.key === subjectKey;
  const declared = row?.status === 'draft' ? (row.absentAnswers ?? null) : null;
  const answers = declared ?? (current ? state.refused : null);
  const checked = answers !== null && current && state.checked;
  return {
    answers,
    checked,
    blocked: answers !== null && !checked,
    setChecked: (next) =>
      setState((prev) =>
        prev.key === subjectKey
          ? { ...prev, checked: next }
          : { key: subjectKey, refused: null, checked: next },
      ),
    params: () => (checked ? { absentAnswersReviewed: true } : {}),
    capture: (err) => {
      const refused = refusedAnswers(err);
      if (refused === null) return false;
      setState({ key: subjectKey, refused, checked: false });
      return true;
    },
  };
}

/** The confirmation itself, above the draft's Publish. Renders nothing when none is asked for. */
export function AbsentAnswersReviewSlot({
  review,
  busy,
}: {
  readonly review: AbsentAnswersReviewState;
  readonly busy: boolean;
}) {
  const t = useT();
  if (review.answers === null) return null;
  const when = absentAnswersWhenText(review.answers, t);
  const onlyWhen = absentAnswersOnlyWhenText(review.answers, t);
  return (
    <fieldset
      className="notice notice-warn m-0 min-w-0 flex-col items-stretch"
      aria-label={t('确认表示不存在的回答', 'Confirm the answers that mean “not there”')}
      data-testid="operation-absent-review"
    >
      <p className="m-0">
        <strong>
          {t(
            `发布前确认：${when}，记为“要查的东西不存在”。`,
            `Confirm before publishing: ${when}, it is recorded as “the thing looked up does not exist”.`,
          )}
        </strong>
        {sentenceGap(t)}
        {t(
          '目标验收会把这个回答当作“已经删掉”的证据。有的目标在没有权限、地址或代理配错时也会这样回答，那时它证明不了任何东西。',
          'Goal acceptance takes this answer as evidence that something was removed. Some targets answer the same way for no permission, a wrong address or a misconfigured proxy, and then it proves nothing.',
        )}
      </p>
      <label className="flex items-start gap-2 text-13 text-text">
        <input
          type="checkbox"
          checked={review.checked}
          disabled={busy}
          onChange={(event) => review.setChecked(event.target.checked)}
          className="mt-0.5"
          data-testid="operation-absent-review-confirm"
        />
        <span>
          {t(
            `门用的凭据看得到要查的东西；${onlyWhen}（不是没权限、地址或代理配错）。确认后记下是你确认的。`,
            `The gate’s credentials can see what this looks up; ${onlyWhen} (not for no permission, a wrong address or a misconfigured proxy). Your confirmation is recorded.`,
          )}
        </span>
      </label>
    </fieldset>
  );
}

/** On a published (or deprecated) version that declares such answers: who confirmed them, when —
 *  or that nobody did, for a version published before the confirmation existed. */
export function AbsentAnswersReviewedLine({
  http,
  row,
}: {
  readonly http: CapabilityCaller;
  readonly row: Pick<OperationCatalogRow, 'status' | 'absentAnswers' | 'absentAnswersReview'>;
}) {
  const t = useT();
  if (row.absentAnswers === undefined || row.status === 'draft') return null;
  const review = row.absentAnswersReview;
  if (review === undefined) {
    return (
      <span className="text-3 text-small" data-testid="catalog-detail-absent-unreviewed">
        {t(
          '这个版本发布时没有人确认过门用的凭据看得到要查的东西（它发布于需要确认之前）。',
          'Nobody confirmed, when this version was published, that the gate’s credentials can see what it looks up (it was published before that was asked).',
        )}
      </span>
    );
  }
  return (
    <span className="text-3 text-small row-wrap" data-testid="catalog-detail-absent-reviewed">
      <RefChip kind="principal" id={review.reviewedBy} http={http} size="s" />
      <span title={review.reviewedAt}>
        {t(
          `发布时确认（${formatRelative(review.reviewedAt)}）：门用的凭据看得到要查的东西，只有它不存在时目标才这样回答。`,
          `confirmed when publishing it (${formatRelative(review.reviewedAt)}): the gate’s credentials can see what it looks up, and the target answers this way only when it is not there.`,
        )}
      </span>
    </span>
  );
}
