import { type ReactNode, useState } from 'react';
import { failureReading } from '../../lib/action-outcome.js';
import { auditHref } from '../../lib/audit.js';
import { useT } from '../../lib/i18n.js';
import { capabilityHolders } from '../../lib/role-holders.js';
import { Button } from '../kit/button.js';
import { Notice } from '../kit/notice.js';
import { RouteLink } from '../kit/route-link.js';

type FailureRow = {
  readonly status: string;
  readonly failureKind?: string | null;
  /** Legacy 329: the last failure's reason as the kernel recorded it — redacted, clipped, unseen
   *  characters shown as `\u{XXXX}`. Plain text, line breaks kept. */
  readonly failureReason?: string | null;
  /** Legacy 339: `failureReason` is only the head of a longer reason (the whole is audited). */
  readonly failureReasonTruncated?: boolean;
};

/** A reason longer than this many lines or code points starts folded (legacy 339). */
const FOLD_LINES = 4;
const FOLD_CODE_POINTS = 280;

function isLong(text: string): boolean {
  return text.split('\n').length > FOLD_LINES || [...text].length > FOLD_CODE_POINTS;
}

/**
 * Legacy 339 (UX acceptance of #609, P2-1 / P2-2): a failure reason as plain text with its line
 * breaks — folded to its first lines when long, with a toggle, so a gate's diagnostic dump never
 * reads as the thing to act on; and, when the kernel only sent its head, a line saying so and
 * where the whole is (`where`).
 */
export function FailureReasonText({
  reason,
  truncated,
  where,
  label,
  testId,
}: {
  readonly reason: string;
  readonly truncated: boolean;
  /** Where the whole reason can be read — only shown when `truncated`. */
  readonly where: ReactNode;
  /** A lead-in such as 「原因：」, inside the folded text. */
  readonly label?: string;
  readonly testId?: string;
}) {
  const t = useT();
  const long = isLong(reason);
  const [open, setOpen] = useState(false);
  const folded = long && !open;
  return (
    <span className="stack-s" data-testid={testId}>
      <span
        className={folded ? 'pre-wrap line-clamp-4' : 'pre-wrap'}
        data-testid={testId ? `${testId}-text` : undefined}
        data-folded={folded ? '' : undefined}
      >
        {label}
        {reason}
      </span>
      {long ? (
        <span>
          <Button
            variant="ghost"
            size="s"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            data-testid={testId ? `${testId}-toggle` : undefined}
          >
            {open ? t('收起', 'Show less') : t('展开全部', 'Show all')}
          </Button>
        </span>
      ) : null}
      {truncated ? (
        <span
          className="text-3 text-small"
          data-testid={testId ? `${testId}-truncated` : undefined}
        >
          {t('只显示了开头的 1000 个字符。', 'Only the first 1,000 characters are shown. ')}
          {where}
        </span>
      ) : null}
    </span>
  );
}

/** Where a truncated reason's whole is, for a reader outside the audit page: a link to the
 *  request's audit when their role may open it, else who can (`RouteLink`: never a link onto a
 *  page that only says "not your role"). */
export function FailureReasonWhere({ actionRequestId }: { readonly actionRequestId: string }) {
  const t = useT();
  return (
    <RouteLink
      href={auditHref({ actionRequestId })}
      refused={t(
        `完整内容在这条请求的审计记录里，只有${capabilityHolders('audit_query', t, 'or')}能看。`,
        `The whole reason is in this request’s audit record, which only ${capabilityHolders('audit_query', t, 'or')} can read.`,
      )}
      testId="failure-reason-audit-link"
    >
      {t('在审计记录里看完整内容', 'Read the whole reason in the audit record')}
    </RouteLink>
  );
}

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
  reasonWhere,
  testId,
}: {
  readonly row: FailureRow;
  readonly check?: Parameters<typeof failureReading>[2];
  /** Where a truncated reason's whole is (`FailureReasonWhere`). */
  readonly reasonWhere?: ReactNode;
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
          <FailureReasonText
            reason={row.failureReason}
            truncated={row.failureReasonTruncated === true}
            where={reasonWhere}
            label={t('原因：', 'Reason: ')}
            testId={testId ? `${testId}-reason` : undefined}
          />
        ) : null}
      </span>
    </Notice>
  );
}
