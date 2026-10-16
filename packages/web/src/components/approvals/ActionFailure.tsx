import { failureReading } from '../../lib/action-outcome.js';
import { useT } from '../../lib/i18n.js';
import { Notice } from '../kit/notice.js';

type FailureRow = {
  readonly status: string;
  readonly failureKind?: string | null;
  /** Legacy 329: the last failure's reason as the kernel recorded it — redacted, clipped, unseen
   *  characters shown as `\u{XXXX}`. Plain text, line breaks kept. */
  readonly failureReason?: string | null;
};

/**
 * components/approvals/ActionFailure (S11 GO1): which kind of failure a `failed` / `compensated`
 * ActionRequest is, from the row's own `failureKind` (`lib/action-outcome` `failureReading`) — never
 * from its reason text. Nothing ran (`not_delivered`) and refused (`refused`) are quiet notes;
 * outcome unknown (`outcome_unknown`) is `danger`: the action may already have run, and the reader
 * must check the target before anything else. A `withdrawn` row says nothing ran and nothing is
 * needed (legacy 328). Renders nothing for any other row.
 */

/** A few words under a list row's status chip. */
export function ActionFailureLine({
  row,
  testId,
}: {
  readonly row: FailureRow;
  readonly testId?: string;
}) {
  const t = useT();
  const reading = failureReading(row, t);
  if (!reading) return null;
  return (
    <span
      className={`text-small ${reading.tone === 'danger' ? 'text-danger' : 'text-3'}`}
      data-testid={testId}
      data-failure-kind={reading.kind}
    >
      {reading.short}
    </span>
  );
}

/** The whole reading, for a detail pane. `check` names the system and the action, so "outcome
 *  unknown" says what to check where. */
export function ActionFailureNotice({
  row,
  check,
  testId,
}: {
  readonly row: FailureRow;
  readonly check?: Parameters<typeof failureReading>[2];
  readonly testId?: string;
}) {
  const t = useT();
  const reading = failureReading(row, t, check);
  if (!reading) return null;
  return (
    <Notice tone={reading.tone} testId={testId}>
      <span className="stack-s" data-failure-kind={reading.kind}>
        <span className="font-medium">{reading.title}</span>
        <span>{reading.message}</span>
        {reading.kind !== 'withdrawn' && row.failureReason ? (
          <span className="pre-wrap" data-testid={testId ? `${testId}-reason` : undefined}>
            {t('原因：', 'Reason: ')}
            {row.failureReason}
          </span>
        ) : null}
      </span>
    </Notice>
  );
}
