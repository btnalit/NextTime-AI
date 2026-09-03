import { useState } from 'react';
import type { ActionCardData } from '../lib/action-card.js';

/** Statuses `list_pending`/`get_action`/a card's own local override can carry that still count as
 *  "awaiting a decision" — buttons stay enabled only in this state (docs/development-tasks.md
 *  S2.10 deliverable 2: cards for an already-decided ActionRequest show no buttons). */
const PENDING_STATUSES = new Set(['pending_approval']);

export interface ActionRequestCardProps {
  readonly card: ActionCardData;
  /** Disables every button while an approve/reject/always-approve call is in flight. */
  readonly busy: boolean;
  /** The most recent error from an approve/reject/always-approve call on *this* card, if any. */
  readonly error: string | null;
  readonly onApprove: (actionRequestId: string) => void;
  readonly onReject: (actionRequestId: string, reason: string | undefined) => void;
  readonly onAlwaysApprove: (actionKind: string) => void;
}

/**
 * components/ActionRequestCard: the approval card (design doc §7.6, §8.5; docs/development-
 * tasks.md S2.10 deliverable 2 — "title, Markdown description, simulate/effect block when present,
 * action kind tag, buttons Approve / Reject (with reason) / '总是批准此类', await_decision 时的阻塞样式").
 *
 * Renders in one of three modes, chosen by the caller via `card.isHolder`/`card.status` (this
 * component never decides them itself — `ChatPage`/`ApprovalQueuePage` own that policy, since the
 * two callers source `card.status` differently: a live `action.updated` push override in one case,
 * the row's own `status` in the other):
 *   - `isHolder && status === 'pending_approval'` → full card with buttons.
 *   - `isHolder && status !== 'pending_approval'` → full card, buttons hidden (already decided).
 *   - `!isHolder` → status-only line, no buttons regardless of status (§8.5 "请求者的对话里只显示该
 *     动作的状态，没有批准按钮").
 *
 * No Markdown renderer is used — the kernel's own `description`/`text` today are concatenated
 * plain text, not real Markdown (S2.11 implementation note); `white-space: pre-wrap` preserves
 * whatever line breaks the source already has, and a fenced ```...``` block (from
 * `lib/action-card.ts`'s `actionCardFromRow` params dump) still reads fine as plain text.
 */
export function ActionRequestCard({
  card,
  busy,
  error,
  onApprove,
  onReject,
  onAlwaysApprove,
}: ActionRequestCardProps) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');

  if (!card.isHolder) {
    return (
      <div className="action-card action-card-status-only">
        <span className="action-card-kind">{card.actionKindLabel}</span>
        <span className={`action-card-status action-card-status-${card.status ?? 'unknown'}`}>
          {card.status ?? 'pending'}
        </span>
        <p className="action-card-description">{card.description}</p>
      </div>
    );
  }

  const decided = card.status !== undefined && !PENDING_STATUSES.has(card.status);
  const blocking = card.awaitDecision && !decided;

  function submitReject(): void {
    onReject(card.actionRequestId, reason.trim() || undefined);
    setRejecting(false);
    setReason('');
  }

  return (
    <div className={`action-card${blocking ? ' action-card-blocking' : ''}`}>
      <header className="action-card-header">
        <h3 className="action-card-title">{card.title}</h3>
        <span className="action-card-kind">{card.actionKindTag}</span>
      </header>

      {card.resourceScope && <p className="action-card-scope">scope: {card.resourceScope}</p>}
      <p className="action-card-description">{card.description}</p>

      {card.simulated !== undefined && (
        <pre className="action-card-simulated">{JSON.stringify(card.simulated, null, 2)}</pre>
      )}

      {blocking && <p className="action-card-blocking-notice">Awaiting your decision.</p>}

      {decided ? (
        <p className={`action-card-status action-card-status-${card.status}`}>{card.status}</p>
      ) : (
        <div className="action-card-actions">
          {rejecting ? (
            <div className="action-card-reject-form">
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Reason (optional)"
                rows={2}
                disabled={busy}
              />
              <div className="action-card-actions">
                <button type="button" disabled={busy} onClick={submitReject}>
                  Confirm reject
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => setRejecting(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <button type="button" disabled={busy} onClick={() => onApprove(card.actionRequestId)}>
                Approve
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => setRejecting(true)}
              >
                Reject
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => onAlwaysApprove(card.actionKindTag)}
              >
                Always approve this kind
              </button>
            </>
          )}
        </div>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
