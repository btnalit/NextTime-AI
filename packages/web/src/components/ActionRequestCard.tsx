import { useState } from 'react';
import { useCanOpen } from '../hooks/useCanOpen.js';
import {
  type ActionCardData,
  DECIDABLE_STATUS,
  FALLBACK_BLAST_RADIUS,
  isDecidable,
} from '../lib/action-card.js';
import {
  alwaysAllowOffer,
  alwaysAllowStaleRequestText,
  alwaysAllowUnpublishedText,
  requestDefinitionText,
} from '../lib/always-allow.js';
import { credentialReviewCount } from '../lib/credential-review.js';
import {
  actionKindRaw,
  actionKindTagText,
  prettyJsonVisible,
  redactSensitive,
} from '../lib/format.js';
import { useT } from '../lib/i18n.js';
import { actorRuntimeLabel, policyDecisionLabel } from '../lib/labels.js';
import { capabilityHolders } from '../lib/role-holders.js';
import { hrefs } from '../lib/router.js';
import { Confirm } from './kit/confirm.js';
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
  /** `false` when the reader's role may not `approve`/`reject` (operator and owner only): the
   *  card shows the request and its progress, says who decides, and offers no button the kernel
   *  must refuse (#541 review M3). */
  readonly canDecide: boolean;
  /** The reader's own principal, when known: a request made on their behalf that may not be
   *  self-decided (`card.requesterCanApprove === false`) gets no decision buttons — the kernel
   *  refuses approve and reject alike (decide.ts `SelfApprovalNotAllowedError`). */
  readonly callerPrincipalId?: string | null;
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
  canDecide,
  callerPrincipalId,
}: ActionRequestCardProps) {
  const t = useT();
  const canOpen = useCanOpen();
  // The reason typed when "总是允许" was clicked, while its confirm is open (null = closed).
  const [pendingAlwaysAllow, setPendingAlwaysAllow] = useState<{
    readonly reason: string | undefined;
  } | null>(null);
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
          <span className="tag action-card-kind" title={actionKindRaw(card.actionKindTag)}>
            {actionKindTagText(card.actionKindTag)}
          </span>
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
  // Dead-end sweep of #592: the requester's own request, when the policy forbids self-decision.
  const ownRequestLocked =
    decidable &&
    card.requesterCanApprove === false &&
    callerPrincipalId !== undefined &&
    callerPrincipalId !== null &&
    card.onBehalfOf === callerPrincipalId;
  const mayDecide = canDecide && !ownRequestLocked;
  // Kernel I8: a `high` blast radius can never be auto-approved — no rule to offer. R-20 / D-15:
  // the rule is keyed by (gate, action kind), so a card whose gate is not known offers none.
  // Legacy 218 (UX acceptance of #592): only on a request read as made under the definition
  // published now (`lib/always-allow`) — the kernel writes no rule otherwise, and a card from a
  // chat message carries no such read until the chat fetches its row.
  const alwaysAllowPossible =
    canAlwaysAllow && mayDecide && blastRadius !== 'high' && card.gatekeeperId !== '';
  const alwaysAllow = alwaysAllowOffer(card.publishedDefinition);
  const offerAlwaysAllow = alwaysAllowPossible && alwaysAllow.offer;
  const alwaysAllowBlock = alwaysAllowPossible ? alwaysAllow.block : null;
  const definitionText = requestDefinitionText(card.publishedDefinition, t);
  const hasParams = card.params !== undefined && Object.keys(card.params).length > 0;
  // Decision 2026-10-09 "二次确认": the kernel's count, from the card's own content, else from its
  // 400 on an approve (a card written before the count existed carries none). Either way the card
  // then sends the approver to the approvals page instead of approving here.
  const suspectedSecretValues = card.suspectedSecretValues ?? credentialReviewCount(error) ?? 0;

  const approvalCard = (
    <ApprovalCard
      actionRequestId={card.actionRequestId}
      actionKind={card.actionKindTag}
      blastRadius={blastRadius}
      target={<span className="mono">{card.resourceScope ?? '—'}</span>}
      gatekeeper={card.gatekeeperId ? { id: card.gatekeeperId } : undefined}
      onBehalfOf={card.onBehalfOf !== undefined ? { id: card.onBehalfOf } : undefined}
      policySummary={
        card.policyDecision ? (
          // Legacy sweep (console batch, 2026-10-16): no raw-value tooltip — the label is the text.
          <span>{policyDecisionLabel(card.policyDecision, t)}</span>
        ) : undefined
      }
      approvalsHref={
        canDecide && canOpen(hrefs.approval(card.actionRequestId)) !== false
          ? hrefs.approval(card.actionRequestId)
          : undefined
      }
      readOnly={!decidable || !mayDecide}
      suspectedSecretValues={suspectedSecretValues}
      onApprove={(reason) => onApprove(card.actionRequestId, { reason, alwaysAllow: false })}
      onReject={(reason) => onReject(card.actionRequestId, reason)}
      onAlwaysAllow={offerAlwaysAllow ? (reason) => setPendingAlwaysAllow({ reason }) : undefined}
      testId="action-request-card"
    >
      {ownRequestLocked && canDecide ? (
        <Notice testId="action-card-own-request">
          {t(
            '这条请求是代表你发起的，策略不允许发起人自己批准或拒绝（高影响的动作默认如此）：要由另一位有审批权的人决定。',
            'This request was made on your behalf, and the policy does not let the requester approve or reject it (the default for high-impact actions): someone else with approval rights decides.',
          )}
        </Notice>
      ) : null}
      {/* Legacy 216 ①: which definition the request was made under, when the always-allow hints
       *  below (which already say it) are not shown — a high-impact card, or a reader who may not
       *  write rules. */}
      {alwaysAllowBlock !== 'stale' && alwaysAllowBlock !== 'unpublished' && definitionText ? (
        <p className="text-small text-2 m-0" data-testid="action-card-definition">
          {definitionText}
        </p>
      ) : null}
      {alwaysAllowBlock === 'stale' && card.publishedDefinition?.version != null ? (
        <p className="field-hint" data-testid="action-card-always-allow-stale">
          {alwaysAllowStaleRequestText(t, card.publishedDefinition.version)}
        </p>
      ) : null}
      {alwaysAllowBlock === 'unpublished' ? (
        <p className="field-hint" data-testid="action-card-always-allow-unpublished">
          {alwaysAllowUnpublishedText(t, card.actionKindTag)}
        </p>
      ) : null}
      {decidable && !canDecide ? (
        <Notice testId="action-card-awaits-approver">
          {t(
            `这一步要由${capabilityHolders('approve', t, 'or')}批准；这里会显示结果。`,
            `${capabilityHolders('approve', t, 'or')} approves this step; the outcome shows here.`,
          )}
        </Notice>
      ) : null}
      {card.description && card.description !== card.title ? (
        <p className="pre-wrap text-2">{card.description}</p>
      ) : null}
      {card.actorRuntime ? (
        <div className="row-wrap text-small">
          <span className="text-3">{t('运行时', 'Runtime')}</span>
          <span className="tag">{actorRuntimeLabel(card.actorRuntime, t)}</span>
        </div>
      ) : null}
      {hasParams && card.params ? (
        <div className="stack-s">
          <span className="section-title">{t('参数', 'Parameters')}</span>
          <pre className="code-block params-block">
            {prettyJsonVisible(redactSensitive(card.params))}
          </pre>
        </div>
      ) : null}
      {card.simulated !== undefined ? (
        <div className="stack-s">
          <span className="section-title">{t('模拟效果', 'Simulated effect')}</span>
          <pre className="code-block action-card-simulated">
            {prettyJsonVisible(card.simulated)}
          </pre>
        </div>
      ) : null}
      {blocking ? (
        <Notice tone="warn">
          {t('等待你的决定，Worker 已阻塞。', 'Awaiting your decision — the Worker is blocked.')}
        </Notice>
      ) : null}
    </ApprovalCard>
  );

  return (
    <div
      className={`action-card${blocking ? ' action-card-blocking' : ''}`}
      data-action-request-id={card.actionRequestId}
    >
      {/* R-20 / D-15: "总是允许" writes a rule that outlives this request and covers every
          requester of this gate's action kind — it always goes through a confirm that says so. */}
      <Confirm
        tier="medium"
        open={pendingAlwaysAllow !== null}
        onOpenChange={(open) => {
          if (!open) setPendingAlwaysAllow(null);
        }}
        anchor={approvalCard}
        title={t(
          `批准并总是允许 ${actionKindTagText(card.actionKindTag)}`,
          `Approve and always allow ${actionKindTagText(card.actionKindTag)}`,
        )}
        description={t(
          `批准这次请求，并写入一条自动批准规则：今后此门上的 ${actionKindTagText(card.actionKindTag)} 不论谁发起都直接执行，不再进入审批。规则只对这次请求所依据的定义有效：以后发布新版本会重新走审批；如果这之后门上已经发布了新版本，规则不会写入。其他门上的同名动作不受影响；规则可在「模型与配额 → 策略」中关闭。`,
          `Approves this request and writes an auto-approval rule: from now on ${actionKindTagText(card.actionKindTag)} on this gate runs without approval for every requester. The rule covers only the definition this request was made under: a later version goes back through approval, and if one has been published since, no rule is written. The same name on other gates is not affected; turn the rule off under Models & Quotas → Policies.`,
        )}
        target={actionKindTagText(card.actionKindTag)}
        impact={[
          `${t('门', 'Gatekeeper')}: ${card.gatekeeperId}`,
          `${t('规则范围', 'Rule scope')}: ${t('此门 · 所有发起人 · 今后 · 只对这次请求的定义', 'this gate · every requester · from now on · this request’s definition only')}`,
        ]}
        confirmLabel={t('批准并总是允许', 'Approve and always allow')}
        danger
        onConfirm={async () => {
          await onApprove(card.actionRequestId, {
            reason: pendingAlwaysAllow?.reason,
            alwaysAllow: true,
          });
        }}
        testId="action-card-always-allow-confirm"
      />
      {/* The credential 400 is answered by the card's own pointer to the approvals page. */}
      {error !== null && error !== undefined && credentialReviewCount(error) === null ? (
        <ErrorBanner error={error} />
      ) : null}
      {outcome}
    </div>
  );
}
