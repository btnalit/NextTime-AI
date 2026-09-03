import { useState } from 'react';
import { type ActionCardData, isDecidable } from '../lib/action-card.js';
import { formatDateTime, formatRelative, prettyJson, redactSensitive } from '../lib/format.js';
import { Button } from './ui/Button.js';
import { CopyId } from './ui/CopyId.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Notice } from './ui/Notice.js';
import { StatusChip } from './ui/StatusChip.js';
import { Textarea } from './ui/Field.js';

export interface ActionRequestDetailProps {
  readonly card: ActionCardData;
  /** Disables the decision controls while an approve/reject call is in flight. */
  readonly busy: boolean;
  /** The most recent error from a decision call on *this* request, if any. */
  readonly error: unknown | null;
  readonly onApprove: (actionRequestId: string, options: { alwaysAllow: boolean }) => void;
  readonly onReject: (actionRequestId: string, reason: string | undefined) => void;
  /** `false` hides "Always allow this kind" — `set_auto_approved_action_kind` is operator+, and
   *  the session has already been told 403 for it (hooks/usePermissions). */
  readonly canAlwaysAllow: boolean;
  /** Inline (chat card) variant: no timestamps block, tighter meta. */
  readonly compact?: boolean;
}

const BLAST_TONE: Readonly<Record<'low' | 'medium' | 'high', string>> = {
  low: 'chip-neutral',
  medium: 'chip-warn',
  high: 'chip-danger',
};

/**
 * components/ActionRequestDetail: the one rendering of an ActionRequest — used inside the
 * Approvals drawer and, via `ActionRequestCard`, inline in a chat. Governance fields first (kind,
 * gate, scope, blast radius, requester), then params (sensitive keys redacted client-side, see
 * `lib/format.ts` `redactSensitive`), then the decision form while the request is decidable
 * (`isDecidable` — `ACTION_REQUEST_TRANSITIONS` only leaves `pending_approval` on approve/reject).
 * `approve` takes no reason on the wire (`packages/shared/src/capabilities.ts`), so the reason
 * box is labelled as travelling with Reject only.
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
  const [reason, setReason] = useState('');
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  const decidable = card.isHolder && isDecidable(card.status);
  const blocking = card.awaitDecision && isDecidable(card.status);
  const reasonId = `reason-${card.actionRequestId}`;

  return (
    <div className="stack" data-testid="action-request-detail" data-action-request-id={card.actionRequestId}>
      <header className="action-detail-header">
        <div className="stack-s grow">
          <h3 className="action-detail-title">{card.title}</h3>
          <div className="row-wrap">
            <span className="tag" title="Action kind">
              {card.actionKindTag}
            </span>
            {card.blastRadius ? (
              <span className={`chip chip-s ${BLAST_TONE[card.blastRadius]}`} title="Blast radius">
                {card.blastRadius} blast radius
              </span>
            ) : null}
            {blocking ? (
              <span className="chip chip-s chip-warn" title="The Worker is blocked until you decide">
                blocking
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
              <span className="text-3">on behalf of</span>
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
              <time title={formatDateTime(card.requestedAt)}>{formatRelative(card.requestedAt)}</time>
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

      {blocking && decidable ? <Notice tone="warn">Awaiting your decision.</Notice> : null}

      {decidable ? (
        <div className="stack-s" data-testid="decision-form">
          <Textarea
            id={reasonId}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Reason (optional, recorded with Reject)"
            aria-label="Decision reason"
            rows={2}
            disabled={busy}
          />
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
              onClick={() => onApprove(card.actionRequestId, { alwaysAllow })}
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
