import type { BlastRadius, OperationMode } from '@nexttime/shared';
import { type ReactNode, useId, useRef, useState } from 'react';
import { useT } from '../../lib/i18n.js';
import { Button } from './Button.js';
import { Field, Textarea } from './Field.js';
import { RefChip } from './RefChip.js';
import { StatusChip } from './StatusChip.js';

export interface ApprovalCardRef {
  readonly id: string;
  readonly name?: string | null;
  readonly href?: string;
}

export interface ApprovalCardProps {
  readonly actionRequestId: string;
  /** The capability / Operation the Worker proposed (`docker.container_stop`, `http.delete`). */
  readonly actionKind: string;
  readonly mode?: OperationMode;
  readonly blastRadius: BlastRadius;
  /** `ActionRequest.status` — rendered as the shared `actionRequest` StatusChip. */
  readonly status?: string;
  /** What the action touches — a resource name, a path, a container id. */
  readonly target: ReactNode;
  readonly gatekeeper?: ApprovalCardRef;
  /** The human the Worker acts for (`ActionRequest.onBehalfOfPrincipal`). */
  readonly onBehalfOf?: ApprovalCardRef;
  /** The policy line that put this request in the queue ("require_approval: execute on prod"). */
  readonly policySummary?: ReactNode;
  /** Parameters block (the caller's redaction-aware `<pre>`), or any extra body. */
  readonly children?: ReactNode;
  /** Defaults to `blastRadius === 'high'` (§5.8 / §12 item 6: reason mandatory for high impact). */
  readonly reasonRequired?: boolean;
  /** "在审批页打开" — the queue page's deep link; omitted when already there. */
  readonly approvalsHref?: string;
  readonly onApprove?: (reason: string | undefined) => void | Promise<void>;
  readonly onReject?: (reason: string | undefined) => void | Promise<void>;
  /** "总是允许 Always allow this kind" — operator+ only; omit to hide. */
  /** "总是允许": approve this request AND auto-approve its action kind from now on. Receives the
   *  typed reason (if any) so a reason given before choosing this button is not dropped. */
  readonly onAlwaysAllow?: (reason: string | undefined) => void | Promise<void>;
  /** Decided / not actionable: no buttons, status only. */
  readonly readOnly?: boolean;
  readonly testId?: string;
}

const REASON_REQUIRED_MESSAGE =
  '高影响动作必须填写批准理由 A reason is required for a high-impact action';

/**
 * components/ui/ApprovalCard (S6-A0, §5.9 "ApprovalCard"): the one card the chat thread and the
 * approvals page share — capability, target, on-behalf-of (a `RefChip`), policy summary, blast
 * radius chip, and the four decisions (批准 / 拒绝 / 总是允许 / 在审批页打开). Pure presentation:
 * the callbacks do the calling. The reason textarea is always offered; it is validated as
 * mandatory for approval when `reasonRequired` (default: high blast radius — the kernel enforces
 * the same rule, C25 / §12 item 6, so this is the friendly copy in front of a 400, never the
 * gate).
 */
export function ApprovalCard({
  actionRequestId,
  actionKind,
  mode,
  blastRadius,
  status,
  target,
  gatekeeper,
  onBehalfOf,
  policySummary,
  children,
  reasonRequired,
  approvalsHref,
  onApprove,
  onReject,
  onAlwaysAllow,
  readOnly = false,
  testId,
}: ApprovalCardProps) {
  const t = useT();
  const required = reasonRequired ?? blastRadius === 'high';
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'approve' | 'reject' | 'always' | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const reasonId = useId();
  const titleId = useId();

  async function decide(kind: 'approve' | 'reject' | 'always'): Promise<void> {
    const trimmed = reason.trim();
    if (kind === 'approve' && required && trimmed === '') {
      setReasonError(REASON_REQUIRED_MESSAGE);
      reasonRef.current?.focus();
      return;
    }
    setReasonError(null);
    setBusy(kind);
    try {
      if (kind === 'approve') await onApprove?.(trimmed === '' ? undefined : trimmed);
      else if (kind === 'reject') await onReject?.(trimmed === '' ? undefined : trimmed);
      else await onAlwaysAllow?.(trimmed === '' ? undefined : trimmed);
    } finally {
      setBusy(null);
    }
  }

  const showActions = !readOnly && (onApprove || onReject || onAlwaysAllow);
  return (
    <article
      className={`approval-card approval-card-${blastRadius}`}
      aria-labelledby={titleId}
      data-testid={testId}
      data-action-request-id={actionRequestId}
      data-blast-radius={blastRadius}
    >
      <header className="approval-card-header">
        <div className="approval-card-heading">
          <span className="section-title">{t('审批', 'Approval')}</span>
          <h3 className="approval-card-title mono" id={titleId}>
            {actionKind}
          </h3>
        </div>
        <div className="row-wrap">
          {mode !== undefined ? (
            <StatusChip machine="operationMode" status={mode} size="s" />
          ) : null}
          <StatusChip
            machine="blastRadius"
            status={blastRadius}
            size="s"
            testId="approval-blast-radius"
          />
          {status !== undefined ? (
            <StatusChip machine="actionRequest" status={status} size="s" testId="approval-status" />
          ) : null}
        </div>
      </header>

      <dl className="definition-list">
        <dt>{t('目标', 'Target')}</dt>
        <dd data-testid="approval-target">{target}</dd>
        {gatekeeper ? (
          <>
            <dt>{t('门', 'Gatekeeper')}</dt>
            <dd>
              <RefChip
                kind="gatekeeper"
                id={gatekeeper.id}
                name={gatekeeper.name}
                href={gatekeeper.href}
                size="s"
              />
            </dd>
          </>
        ) : null}
        {onBehalfOf ? (
          <>
            <dt>{t('代表', 'On behalf of')}</dt>
            <dd>
              <RefChip
                kind="principal"
                id={onBehalfOf.id}
                name={onBehalfOf.name}
                href={onBehalfOf.href}
                size="s"
                testId="approval-on-behalf-of"
              />
            </dd>
          </>
        ) : null}
        {policySummary !== undefined ? (
          <>
            <dt>{t('策略', 'Policy')}</dt>
            <dd data-testid="approval-policy">{policySummary}</dd>
          </>
        ) : null}
        <dt>{t('请求', 'Request')}</dt>
        <dd>
          <RefChip kind="actionRequest" id={actionRequestId} name={null} size="s" />
        </dd>
      </dl>

      {children}

      {showActions ? (
        <>
          <Field
            id={reasonId}
            label={t('理由', 'Reason')}
            required={required}
            hint={
              required
                ? t(
                    '高影响：批准必须说明理由，进审计。 High impact —',
                    'approval needs a reason; it is audited.',
                  )
                : t('可选；拒绝或批准时一并记入审计。', 'Optional; recorded with the decision.')
            }
            error={reasonError}
          >
            <Textarea
              id={reasonId}
              ref={reasonRef}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                if (reasonError) setReasonError(null);
              }}
              rows={2}
              invalid={reasonError !== null}
              aria-required={required || undefined}
              aria-describedby={reasonError ? `${reasonId}-error` : `${reasonId}-hint`}
              data-testid="approval-reason"
            />
          </Field>
          <div className="approval-card-actions">
            {onApprove ? (
              <Button
                variant="primary"
                loading={busy === 'approve'}
                disabled={busy !== null && busy !== 'approve'}
                onClick={() => void decide('approve')}
                data-testid="approval-approve"
              >
                {t('批准', 'Approve')}
              </Button>
            ) : null}
            {onReject ? (
              <Button
                variant="danger"
                loading={busy === 'reject'}
                disabled={busy !== null && busy !== 'reject'}
                onClick={() => void decide('reject')}
                data-testid="approval-reject"
              >
                {t('拒绝', 'Reject')}
              </Button>
            ) : null}
            {onAlwaysAllow ? (
              <Button
                variant="secondary"
                loading={busy === 'always'}
                disabled={busy !== null && busy !== 'always'}
                onClick={() => void decide('always')}
                data-testid="approval-always-allow"
              >
                {t('总是允许', 'Always allow')}
              </Button>
            ) : null}
            {approvalsHref !== undefined ? (
              <a
                className="approval-card-link"
                href={approvalsHref}
                data-testid="approval-open-page"
              >
                {t('在审批页打开', 'Open in approvals')}
              </a>
            ) : null}
          </div>
        </>
      ) : approvalsHref !== undefined ? (
        <a className="approval-card-link" href={approvalsHref} data-testid="approval-open-page">
          {t('在审批页打开', 'Open in approvals')}
        </a>
      ) : null}
    </article>
  );
}
