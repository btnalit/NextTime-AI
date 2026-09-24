import {
  type ActionCardData,
  DECIDABLE_STATUS,
  FALLBACK_BLAST_RADIUS,
  isDecidable,
} from '../lib/action-card.js';
import { prettyJson, redactSensitive } from '../lib/format.js';
import { useT } from '../lib/i18n.js';
import { hrefs } from '../lib/router.js';
import { ApprovalCard } from './ui/ApprovalCard.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Notice } from './ui/Notice.js';
import { StatusChip } from './ui/StatusChip.js';

export interface ActionRequestCardProps {
  readonly card: ActionCardData;
  /** The most recent error from a decision call on *this* request, if any — rendered under the
   *  card's decision controls. */
  readonly error: unknown | null;
  /** `reason` is what the reader typed in the card's reason box (trimmed; `undefined` when
   *  blank). The kernel requires it for a `high` blast radius (400 `reason_required`, C25); the
   *  card validates that in front of the call. `alwaysAllow` is the "总是允许" button: approve,
   *  then write the auto-approval rule for this kind. May return a promise — the card keeps its
   *  spinner up until it settles, so the handler must catch its own errors and surface them
   *  through `error`. */
  readonly onApprove: (
    actionRequestId: string,
    options: { readonly reason: string | undefined; readonly alwaysAllow: boolean },
  ) => void | Promise<void>;
  readonly onReject: (actionRequestId: string, reason: string | undefined) => void | Promise<void>;
  /** `false` hides "总是允许 Always allow" — `set_auto_approved_action_kind` is operator+, and
   *  the session has already been told 403 for it (hooks/usePermissions). */
  readonly canAlwaysAllow: boolean;
}

/**
 * components/ActionRequestCard: the approval card inline in a chat (design doc §7.6, §8.5; S2.10
 * deliverable 2; S6-A: rendered on `ui/ApprovalCard`, the one card the thread and the approvals
 * page share — docs/console-completion-plan.md §5.9 "ApprovalCard"). Two modes, decided by the
 * caller through `card.isHolder` / `card.status`:
 *   - holder → the shared card (capability / target / gatekeeper / on-behalf-of / policy / blast
 *     radius / 批准 · 拒绝 · 总是允许 · 在审批页打开), read-only once the request left
 *     `pending_approval`;
 *   - not a holder → a status-only line (§8.5 "请求者的对话里只显示该动作的状态，没有批准按钮").
 * Both end in the one-line outcome ("执行类动作提示": 待审批 / 已执行 / 已拒绝 …) whose chip carries
 * `.action-card-status` — with `.action-card`, the stable hooks e2e/approvals.spec.ts keys on.
 * `ApprovalCard` is not handed `status`, so that line is the card's only status chip.
 */
export function ActionRequestCard({
  card,
  error,
  onApprove,
  onReject,
  canAlwaysAllow,
}: ActionRequestCardProps) {
  const t = useT();
  const status = card.status ?? DECIDABLE_STATUS;
  const outcome = (
    <div className="system-status-line" data-testid="action-outcome" data-status={status}>
      <StatusChip machine="actionRequest" status={status} size="s" className="action-card-status" />
    </div>
  );

  if (!card.isHolder) {
    return (
      <div
        className="action-card action-card-status-only"
        data-action-request-id={card.actionRequestId}
      >
        <div className="row-wrap">
          <span className="tag">{card.actionKindTag}</span>
          {card.resourceScope ? <span className="text-3 mono">{card.resourceScope}</span> : null}
        </div>
        <p className="text-2 text-small pre-wrap">{card.description}</p>
        {outcome}
      </div>
    );
  }

  const decidable = isDecidable(card.status);
  const blocking = card.awaitDecision && decidable;
  const blastRadius = card.blastRadius ?? FALLBACK_BLAST_RADIUS;
  // Kernel I8: a `high` blast radius can never be auto-approved — no rule to offer.
  const offerAlwaysAllow = canAlwaysAllow && blastRadius !== 'high';
  const hasParams = card.params !== undefined && Object.keys(card.params).length > 0;

  return (
    <div
      className={`action-card${blocking ? ' action-card-blocking' : ''}`}
      data-action-request-id={card.actionRequestId}
    >
      <ApprovalCard
        actionRequestId={card.actionRequestId}
        actionKind={card.actionKindTag}
        blastRadius={blastRadius}
        target={<span className="mono">{card.resourceScope ?? '—'}</span>}
        gatekeeper={card.gatekeeperId ? { id: card.gatekeeperId } : undefined}
        onBehalfOf={card.onBehalfOf !== undefined ? { id: card.onBehalfOf } : undefined}
        policySummary={card.policyDecision ? card.policyDecision : undefined}
        approvalsHref={hrefs.approval(card.actionRequestId)}
        readOnly={!decidable}
        onApprove={(reason) => onApprove(card.actionRequestId, { reason, alwaysAllow: false })}
        onReject={(reason) => onReject(card.actionRequestId, reason)}
        onAlwaysAllow={
          offerAlwaysAllow
            ? (reason) => onApprove(card.actionRequestId, { reason, alwaysAllow: true })
            : undefined
        }
        testId="action-request-card"
      >
        {card.description && card.description !== card.title ? (
          <p className="pre-wrap text-2">{card.description}</p>
        ) : null}
        {card.actorRuntime ? (
          <div className="row-wrap text-small">
            <span className="text-3">{t('运行时', 'Runtime')}</span>
            <span className="tag">{card.actorRuntime}</span>
          </div>
        ) : null}
        {hasParams && card.params ? (
          <div className="stack-s">
            <span className="section-title">{t('参数', 'Parameters')}</span>
            <pre className="code-block params-block">
              {prettyJson(redactSensitive(card.params))}
            </pre>
          </div>
        ) : null}
        {card.simulated !== undefined ? (
          <div className="stack-s">
            <span className="section-title">{t('模拟效果', 'Simulated effect')}</span>
            <pre className="code-block action-card-simulated">{prettyJson(card.simulated)}</pre>
          </div>
        ) : null}
        {blocking ? (
          <Notice tone="warn">
            {t('等待你的决定，Worker 已阻塞。', 'Awaiting your decision — the Worker is blocked.')}
          </Notice>
        ) : null}
      </ApprovalCard>
      {error !== null && error !== undefined ? <ErrorBanner error={error} /> : null}
      {outcome}
    </div>
  );
}
