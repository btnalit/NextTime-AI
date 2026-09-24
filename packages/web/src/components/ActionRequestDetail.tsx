import { useState } from 'react';
import { type ActionCardData, isDecidable } from '../lib/action-card.js';
import { formatDateTime, formatRelative, prettyJson, redactSensitive } from '../lib/format.js';
import { useT } from '../lib/i18n.js';
import { Button } from './ui/Button.js';
import { CopyId } from './ui/CopyId.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Textarea } from './ui/Field.js';
import { Notice } from './ui/Notice.js';
import { StatusChip } from './ui/StatusChip.js';

export interface ActionRequestDetailProps {
  readonly card: ActionCardData;
  /** Disables the decision controls while an approve/reject call is in flight. */
  readonly busy: boolean;
  /** The most recent error from a decision call on *this* request, if any. */
  readonly error: unknown | null;
  /** `reason` (S6-A C25) is present only when the textarea holds a non-blank value — kept out
   *  of the options object otherwise so pre-S6-A callers see exactly the shape they always did. */
  readonly onApprove: (
    actionRequestId: string,
    options: { alwaysAllow: boolean; reason?: string },
  ) => void;
  readonly onReject: (actionRequestId: string, reason: string | undefined) => void;
  /** `false` hides "Always allow this kind" — `set_auto_approved_action_kind` is operator+, and
   *  the session has already been told 403 for it (hooks/usePermissions). */
  readonly canAlwaysAllow: boolean;
  /** Inline (chat card) variant: no timestamps block, tighter meta. */
  readonly compact?: boolean;
}

/**
 * components/ActionRequestDetail: the one rendering of an ActionRequest — used inside the
 * Approvals drawer and, via `ActionRequestCard`, inline in a chat. Governance fields first (kind,
 * gate, scope, blast radius, requester), then params (sensitive keys redacted client-side, see
 * `lib/format.ts` `redactSensitive`), then the decision form while the request is decidable
 * (`isDecidable` — `ACTION_REQUEST_TRANSITIONS` only leaves `pending_approval` on approve/reject).
 * S6-A C25: `approve{reason?}` exists on the wire and the kernel refuses a high-blast-radius
 * approval without one (400 `reason_required`) — the textarea travels with both decisions and
 * Approve is refused client-side, with the same message, while `blastRadius === 'high'` and the
 * box is blank. The approvals page itself no longer renders this component: it uses
 * `approvals/ApprovalDetail` on the shared `ui/ApprovalCard` (with the tiered confirmation);
 * this one stays for the chat's inline card (`ActionRequestCard.tsx`) until that lane migrates.
 */
export function ActionRequestDetail({
  card,
  busy,
  error,
  onApprove,
  onReject,
  canAlwaysAllow,
  compact = false,
}: ActionRequestDetailProps) {
  const t = useT();
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  const reasonRequired = card.blastRadius === 'high';
  const decidable = card.isHolder && isDecidable(card.status);
  const blocking = card.awaitDecision && isDecidable(card.status);
  const reasonId = `reason-${card.actionRequestId}`;

  return (
    <div
      className="stack"
      data-testid="action-request-detail"
      data-action-request-id={card.actionRequestId}
    >
      <header className="action-detail-header">
        <div className="stack-s grow">
          <h3 className="action-detail-title">{card.title}</h3>
          <div className="row-wrap">
            <span className="tag" title={t('动作类型', 'Action kind')}>
              {card.actionKindTag}
            </span>
            {card.blastRadius ? (
              <StatusChip machine="blastRadius" status={card.blastRadius} size="s" />
            ) : null}
            {blocking ? (
              <span
                className="chip chip-s chip-warn"
                title={t('Worker 在你决定之前被阻塞', 'The Worker is blocked until you decide')}
              >
                {t('阻塞中', 'blocking')}
              </span>
            ) : null}
          </div>
        </div>
        <StatusChip
          machine="actionRequest"
          status={card.status ?? 'pending_approval'}
          className="action-card-status"
        />
      </header>

      {card.description && card.description !== card.title ? (
        <p className="pre-wrap text-2">{card.description}</p>
      ) : null}

      <dl className="definition-list">
        <dt>Gatekeeper</dt>
        <dd>{card.gatekeeperId ? <CopyId id={card.gatekeeperId} label="gatekeeper" /> : '—'}</dd>
        <dt>Scope</dt>
        <dd className="mono">{card.resourceScope ?? '—'}</dd>
        {card.onBehalfOf !== undefined ? (
          <>
            <dt>Requested by</dt>
            <dd className="row-wrap">
              {card.actorRuntime ? <span className="tag">{card.actorRuntime}</span> : null}
              <span className="text-3">{t('代表', 'on behalf of')}</span>
              <CopyId id={card.onBehalfOf} label="principal" />
            </dd>
          </>
        ) : null}
        {card.policyDecision ? (
          <>
            <dt>Policy</dt>
            <dd>{card.policyDecision}</dd>
          </>
        ) : null}
        {!compact && card.requestedAt ? (
          <>
            <dt>Requested</dt>
            <dd>
              <time title={formatDateTime(card.requestedAt)}>
                {formatRelative(card.requestedAt)}
              </time>
            </dd>
          </>
        ) : null}
        {!compact && card.executedAt ? (
          <>
            <dt>Executed</dt>
            <dd>{formatDateTime(card.executedAt)}</dd>
          </>
        ) : null}
        {!compact && card.failedAt ? (
          <>
            <dt>Failed</dt>
            <dd>{formatDateTime(card.failedAt)}</dd>
          </>
        ) : null}
      </dl>

      {card.params && Object.keys(card.params).length > 0 ? (
        <div className="stack-s">
          <span className="section-title">Parameters</span>
          <pre className="code-block params-block">{prettyJson(redactSensitive(card.params))}</pre>
        </div>
      ) : null}

      {card.simulated !== undefined ? (
        <div className="stack-s">
          <span className="section-title">Simulated effect</span>
          <pre className="code-block action-card-simulated">{prettyJson(card.simulated)}</pre>
        </div>
      ) : null}

      {blocking && decidable ? (
        <Notice tone="warn">{t('等待你决定。', 'Awaiting your decision.')}</Notice>
      ) : null}

      {decidable ? (
        <div className="stack-s" data-testid="decision-form">
          <Textarea
            id={reasonId}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              if (reasonError) setReasonError(null);
            }}
            placeholder={
              reasonRequired
                ? t(
                    '理由（高影响：批准必填，进审计）',
                    'Reason (required for a high-impact approval; audited)',
                  )
                : t('理由（可选，随决定记入审计）', 'Reason (optional, recorded with the decision)')
            }
            aria-label="Decision reason"
            aria-required={reasonRequired || undefined}
            aria-describedby={reasonError ? `${reasonId}-error` : undefined}
            rows={2}
            disabled={busy}
            invalid={reasonError !== null}
          />
          {reasonError ? (
            <p className="field-error" id={`${reasonId}-error`} role="alert">
              {reasonError}
            </p>
          ) : null}
          <div className="action-detail-actions">
            {canAlwaysAllow ? (
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={alwaysAllow}
                  onChange={(event) => setAlwaysAllow(event.target.checked)}
                  disabled={busy}
                />
                <span>
                  Always allow <code>{card.actionKindTag}</code>
                </span>
              </label>
            ) : null}
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => onReject(card.actionRequestId, reason.trim() || undefined)}
            >
              Reject
            </Button>
            <Button
              variant="primary"
              loading={busy}
              onClick={() => {
                const trimmed = reason.trim();
                if (reasonRequired && trimmed === '') {
                  setReasonError(
                    t(
                      '高影响动作必须填写批准理由',
                      'A reason is required for a high-impact action',
                    ),
                  );
                  return;
                }
                onApprove(card.actionRequestId, {
                  alwaysAllow,
                  ...(trimmed !== '' ? { reason: trimmed } : {}),
                });
              }}
            >
              Approve
            </Button>
          </div>
        </div>
      ) : null}

      {error !== null && error !== undefined ? <ErrorBanner error={error} /> : null}
    </div>
  );
}
