import {
  type ActionWaitingFields,
  waitingReason,
  waitingShortLabel,
} from '../../lib/action-outcome.js';
import { useT } from '../../lib/i18n.js';
import { Notice } from '../kit/notice.js';

type WaitingRow = { readonly status: string } & ActionWaitingFields;

/**
 * components/approvals/ActionWaiting (legacy 287, review of #586): why an ActionRequest that has
 * not finished is waiting, from the `outcomeInDoubt` / `queuedBehind` the kernel derives on read
 * (`lib/action-outcome`). An `executing` row whose call got no answer may already have run (danger);
 * an approved row is queued behind an earlier request on the same system (info). Renders nothing
 * for a row that says neither.
 */

/** A few words under a list row's status chip. */
export function ActionWaitingLine({
  row,
  testId,
}: {
  readonly row: WaitingRow;
  readonly testId?: string;
}) {
  const t = useT();
  const waiting = waitingShortLabel(row, t);
  if (!waiting) return null;
  return (
    <span
      className={`text-small ${waiting.tone === 'danger' ? 'text-danger' : 'text-3'}`}
      data-testid={testId}
      data-waiting={waiting.tone === 'danger' ? 'outcome_in_doubt' : 'queued_behind'}
    >
      {waiting.label}
    </span>
  );
}

/** The whole reason, for a detail pane. */
export function ActionWaitingNotice({
  row,
  testId,
}: {
  readonly row: WaitingRow;
  readonly testId?: string;
}) {
  const t = useT();
  const reason = waitingReason(row, t);
  if (!reason) return null;
  return (
    <Notice tone={reason.tone} testId={testId}>
      <span className="stack-s">
        <span className="font-medium">{reason.title}</span>
        <span>{reason.message}</span>
      </span>
    </Notice>
  );
}
