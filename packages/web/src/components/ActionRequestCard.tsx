import { type ActionCardData, isDecidable } from '../lib/action-card.js';
import { ActionRequestDetail } from './ActionRequestDetail.js';
import { StatusChip } from './ui/StatusChip.js';

export interface ActionRequestCardProps {
  readonly card: ActionCardData;
  readonly busy: boolean;
  readonly error: unknown | null;
  readonly onApprove: (actionRequestId: string, options: { alwaysAllow: boolean }) => void;
  readonly onReject: (actionRequestId: string, reason: string | undefined) => void;
  readonly canAlwaysAllow: boolean;
}

/**
 * components/ActionRequestCard: the approval card inline in a chat (design doc §7.6, §8.5; S2.10
 * deliverable 2). Three modes, decided by the caller through `card.isHolder`/`card.status`:
 *   - holder + `pending_approval` → full detail with the decision form (`ActionRequestDetail`);
 *   - holder + decided → full detail, no form;
 *   - not a holder → a status-only line (§8.5 "请求者的对话里只显示该动作的状态，没有批准按钮").
 * `.action-card` / `.action-card-status` are stable hooks for e2e/approvals.spec.ts.
 */
export function ActionRequestCard(props: ActionRequestCardProps) {
  const { card } = props;
  if (!card.isHolder) {
    return (
      <div
        className="action-card action-card-status-only"
        data-action-request-id={card.actionRequestId}
      >
        <div className="row-wrap">
          <StatusChip
            machine="actionRequest"
            status={card.status ?? 'pending_approval'}
            size="s"
            className="action-card-status"
          />
          <span className="tag">{card.actionKindTag}</span>
          {card.resourceScope ? <span className="text-3 mono">{card.resourceScope}</span> : null}
        </div>
        <p className="text-2 text-small pre-wrap">{card.description}</p>
      </div>
    );
  }

  const blocking = card.awaitDecision && isDecidable(card.status);
  return (
    <div
      className={`action-card${blocking ? ' action-card-blocking' : ''}`}
      data-action-request-id={card.actionRequestId}
    >
      <ActionRequestDetail {...props} compact />
    </div>
  );
}
