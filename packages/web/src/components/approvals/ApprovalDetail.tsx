import { visibleLines } from '@nexttime/shared';
import { useId, useRef, useState } from 'react';
import { useCanOpen } from '../../hooks/useCanOpen.js';
import { useFocusWhenLost } from '../../hooks/useFocusWhenLost.js';
import { isDecidable } from '../../lib/action-card.js';
import {
  alwaysAllowOffer,
  alwaysAllowStaleRequestText,
  alwaysAllowUnpublishedText,
  requestDefinitionText,
} from '../../lib/always-allow.js';
import { auditHref } from '../../lib/audit.js';
import { credentialReviewCount, credentialReviewPaths } from '../../lib/credential-review.js';
import { DECISION_REASON_MAX_LENGTH, decisionReasonCountText } from '../../lib/decision-reason.js';
import {
  actionKindLabel,
  actionKindRaw,
  actionKindTagText,
  formatDateTime,
  formatRelative,
  prettyJsonVisible,
  redactSensitive,
} from '../../lib/format.js';
import type { ActionRequestRow } from '../../lib/governance.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { actorRuntimeLabel, policyDecisionLabel } from '../../lib/labels.js';
import { actionTargetHoldsText, actionTargetOrSystemText } from '../../lib/queue-scope.js';
import { labelText, statusChipStyle } from '../../lib/status-tone.js';
import { Button } from '../kit/button.js';
import { Confirm } from '../kit/confirm.js';
import { CredentialReview } from '../kit/credential-review.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { Field, describedBy } from '../kit/field.js';
import { KeyValue, type KeyValueItem } from '../kit/key-value.js';
import { Notice } from '../kit/notice.js';
import { RedactedNote } from '../kit/redacted-note.js';
import { RefChip } from '../kit/ref-chip.js';
import { StatusChip } from '../kit/status-chip.js';
import { Textarea } from '../kit/textarea.js';
import { ActionFailureNotice, FailureReasonWhere } from './ActionFailure.js';
import { ActionWaitingNotice } from './ActionWaiting.js';
import { RequesterAccountNotice } from './RequesterAccountNotice.js';
import { nameOf, resourceScopeLabel } from './useDirectoryNames.js';

export interface ApprovalDecisionInput {
  readonly actionRequestId: string;
  readonly reason: string | undefined;
  /** "总是允许 Always allow this kind" — approve, then `set_auto_approved_action_kind` (the
   *  pre-S6-A semantics of the same checkbox, kept: the two are one gesture). */
  readonly alwaysAllow: boolean;
  /** The reader ticked 「已核对凭据」 (decision 2026-10-09 "二次确认"); absent means `false`. */
  readonly credentialsReviewed?: boolean;
}

export interface ApprovalDetailProps {
  readonly row: ActionRequestRow;
  readonly principalNames?: ReadonlyMap<string, string>;
  readonly gatekeeperNames?: ReadonlyMap<string, string>;
  /** `false` hides "总是允许" — `set_auto_approved_action_kind` is operator+, and the session has
   *  already been told 403 for it (hooks/usePermissions). */
  readonly canAlwaysAllow: boolean;
  /** The reader's own principal (`hooks/useWorkspaceIdentity`), when known — a request made on
   *  their behalf that may not be self-approved gets no decision controls (kernel decide.ts
   *  `SelfApprovalNotAllowedError`, which refuses reject as well as approve). */
  readonly callerPrincipalId?: string | null;
  /** The confirmed decision — throws so the confirm stays open with the kernel's error (awaited
   *  so the direct low/medium Approve's own button shows busy while it is in flight). */
  readonly onApprove: (input: ApprovalDecisionInput) => Promise<void>;
  readonly onReject: (input: Omit<ApprovalDecisionInput, 'alwaysAllow'>) => Promise<void>;
  /** The most recent error from a *direct* (no-confirm, low/medium blast radius) decision on this
   *  request — a confirm-gated decision's own error renders inline in the confirm instead. */
  readonly error: unknown | null;
  /** The confirm's own state, owned by the page (`ApprovalQueuePage`) rather than this component:
   *  an optimistic decision (`moveToDecided`) can, for one render, leave the row findable in
   *  neither the page's `pendingRows` nor its `decided` map — during which the page falls back to
   *  a skeleton instead of mounting this component. Keeping `pending` here would lose it (and the
   *  open popover) across that remount; lifted to the page, it survives. */
  readonly pending: PendingConfirm | null;
  readonly onPendingChange: (pending: PendingConfirm | null) => void;
}

export type PendingConfirm =
  | {
      readonly kind: 'approve';
      readonly reason: string | undefined;
      readonly alwaysAllow: boolean;
      readonly credentialsReviewed: boolean;
    }
  | { readonly kind: 'reject'; readonly reason: string | undefined };

/**
 * components/approvals/ApprovalDetail (console redesign P3-4 V6 "待我审批"; S6-A B2 / C25, S8
 * W1-A7 — docs/console-completion-plan.md §5.8 "确认态"; audit S13): one ActionRequest's detail,
 * on `components/kit/*` only — the shared `ui/ApprovalCard` (still used by the chat thread's
 * inline card) is gone from this file; this rewrite owns its own header, `kit/key-value` "动作"
 * section, "决定" read-only section and decision footer instead of delegating to that card's body
 * slots. Rendered as the wide layout's detail pane content and, unchanged, as the narrow layout's
 * `kit/sheet` content (`ApprovalQueuePage` decides which).
 *
 * Decision semantics are unchanged from the pre-redesign card (§5.9 principle 4): low/medium
 * Approve calls `onApprove` directly; a high-blast-radius Approve and every Reject set `pending`
 * via `onPendingChange` and go through `kit/confirm` (`medium` tier, never `irreversible` — that
 * tier is an open maintainer decision, not part of this slice) anchored to the decision footer.
 * `approve{reason?}` / `reject{reason?}` payloads are unchanged. The reason is mandatory (and
 * validated in place, mirroring the kernel's own 400 `reason_required`) only for a high-impact
 * Approve — Reject and low/medium Approve both accept an empty reason.
 */
export function ApprovalDetail({
  row,
  principalNames,
  gatekeeperNames,
  canAlwaysAllow,
  callerPrincipalId,
  onApprove,
  onReject,
  error,
  pending,
  onPendingChange,
}: ApprovalDetailProps) {
  // Legacy 500: the decision buttons are disabled while it runs, so a refusal left focus on <body>
  // — focus goes to the banner that says why.
  const submitErrorRef = useFocusWhenLost<HTMLDivElement>(error);
  const t = useT();
  const [reason, setReason] = useState('');
  const reasonCount = decisionReasonCountText(reason.length, t);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [credentialsReviewed, setCredentialsReviewed] = useState(false);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const reasonId = useId();

  const decidable = isDecidable(row.status);
  const blocking = row.awaitDecision && decidable;
  // Dead-end sweep of #592: the kernel refuses both decisions from the requester themselves when
  // the policy says requesters may not approve (`requesterCanApprove === false`; a high blast
  // radius by default) — the owner is not exempt. Say whose decision it is instead of offering
  // buttons that can only fail.
  const ownRequestLocked =
    decidable &&
    row.requesterCanApprove === false &&
    callerPrincipalId !== undefined &&
    callerPrincipalId !== null &&
    row.onBehalfOf === callerPrincipalId;
  const decided = row.decidedBy !== undefined && row.decidedBy !== null;
  const decisionReason = row.decisionReason ?? null;
  const reasonRequired = row.blastRadius === 'high';
  // R-20 / D-15: a `high` blast radius is never auto-approved (kernel I8 refuses the rule too), so
  // there is no rule to offer — the chat card already hid it.
  // Legacy 218 (UX acceptance of #592): "总是允许" allows the definition this request was made
  // against, and only while it is the one published (`lib/always-allow`). A request made under an
  // earlier one, or on an Operation with no published version, gets no offer (the kernel would
  // write no rule: 409 / 404), and the page says why — never an option refused after it is clicked.
  const alwaysAllowPossible = canAlwaysAllow && row.blastRadius !== 'high';
  const { offer, block, coveredVersion } = alwaysAllowOffer(row.publishedDefinition);
  const offerAlwaysAllow = alwaysAllowPossible && offer;
  const alwaysAllowBlock = alwaysAllowPossible ? block : null;
  const publishedVersion = row.publishedDefinition?.version ?? null;
  const alwaysAllowChosen = offerAlwaysAllow && alwaysAllow;
  const gateName = nameOf(gatekeeperNames, row.gatekeeperId) ?? row.gatekeeperId;
  // The kernel's count (the wire row's, else its 400 on a first attempt) — never the console's own.
  const suspectedSecretValues = row.suspectedSecretValues ?? credentialReviewCount(error) ?? 0;
  const suspectedSecretPaths = row.suspectedSecretPaths ?? credentialReviewPaths(error);
  const reviewed = suspectedSecretValues > 0 && credentialsReviewed;
  const approveBlocked = suspectedSecretValues > 0 && !credentialsReviewed;
  // #541 review N2: an operator works this page but cannot read the audit log.
  const canOpen = useCanOpen();
  const provenance = auditHref({
    actionRequestId: row.id,
    ...(row.approvalDecisionId ? { nodeId: row.approvalDecisionId } : {}),
  });

  /** low / medium → straight to the call (§5.9 principle 4 "中 · 可逆 → 一键批准"); high, or any
   *  approval that also writes the "总是允许" rule (R-20: it outlives this request and covers every
   *  requester, so it is never one click) → the confirm first. Resolves immediately either way
   *  (never awaits the real call) so `decide`'s own busy flag never sits spinning for however long
   *  the confirm stays open — the page-owned `error` prop is the one channel for a direct call's
   *  rejection; a confirmed call instead lets `runConfirm` re-throw into `Confirm`, which shows
   *  the error inline and keeps the popover open. */
  function requestApprove(reasonValue: string | undefined): void {
    if (row.blastRadius === 'high' || alwaysAllowChosen) {
      onPendingChange({
        kind: 'approve',
        reason: reasonValue,
        alwaysAllow: alwaysAllowChosen,
        credentialsReviewed: reviewed,
      });
      return;
    }
    onApprove({
      actionRequestId: row.id,
      reason: reasonValue,
      alwaysAllow: false,
      credentialsReviewed: reviewed,
    }).catch(() => {});
  }

  function requestReject(reasonValue: string | undefined): void {
    onPendingChange({ kind: 'reject', reason: reasonValue });
  }

  async function decide(kind: 'approve' | 'reject'): Promise<void> {
    const trimmed = reason.trim();
    if (kind === 'approve' && reasonRequired && trimmed === '') {
      setReasonError(
        t('高影响动作必须填写批准理由', 'A reason is required for a high-impact action'),
      );
      reasonRef.current?.focus();
      return;
    }
    setReasonError(null);
    setBusy(kind);
    try {
      if (kind === 'approve') await requestApprove(trimmed === '' ? undefined : trimmed);
      else await requestReject(trimmed === '' ? undefined : trimmed);
    } finally {
      setBusy(null);
    }
  }

  async function runConfirm(): Promise<void> {
    if (!pending) return;
    if (pending.kind === 'approve') {
      await onApprove({
        actionRequestId: row.id,
        reason: pending.reason,
        alwaysAllow: pending.alwaysAllow,
        credentialsReviewed: pending.credentialsReviewed,
      });
    } else {
      await onReject({ actionRequestId: row.id, reason: pending.reason });
    }
  }

  // L8a-10: a gate-scoped request (the kernel's only writer stores the gate's id as the scope) reads
  // as "the whole gate", never as the gate's raw id posing as the action's target. S11 GO12: this
  // row is the request's approval scope (what auto-approval and always-allow match on), labelled so
  // — 「目标」 is the instance the queue scope row below names.
  const scopeLabel = resourceScopeLabel(row, gatekeeperNames);
  const actionItems: KeyValueItem[] = [
    {
      key: 'kind',
      label: t('能力', 'Capability'),
      value: actionKindRaw(row.actionKindTag),
      mono: true,
    },
    {
      key: 'target',
      label: t('审批范围', 'Approval scope'),
      value: scopeLabel ? (
        <span className="mono" data-testid="approval-target" data-volatile="">
          {scopeLabel}
        </span>
      ) : row.resourceScope ? (
        <span data-testid="approval-target">{t('整个门', 'The whole gate')}</span>
      ) : (
        <span className="text-3" data-testid="approval-target">
          {t('未限定资源', 'No resource scope')}
        </span>
      ),
    },
    // S11 GO12: what the gate's queue orders it against — one instance, or the whole system — and,
    // while it has not finished, which later requests wait for it: an approver can tell whether
    // deciding it lets the requests behind it go. Its own row: the resource scope above is a
    // different thing (what auto-approval and always-allow match on).
    ...(row.target !== undefined
      ? [
          {
            key: 'queueScope',
            label: t('排队范围', 'Queue scope'),
            value: (
              <span className="stack-s">
                <span data-testid="approval-queue-target">
                  {actionTargetOrSystemText(row.target, t)}
                </span>
                {UNFINISHED_STATUSES.has(row.status) ? (
                  <span className="text-12 text-text-2" data-testid="approval-queue-holds">
                    {actionTargetHoldsText(row.target, t)}
                  </span>
                ) : null}
              </span>
            ),
          },
        ]
      : []),
    {
      key: 'gatekeeper',
      label: t('门', 'Gatekeeper'),
      value: (
        <RefChip
          kind="gatekeeper"
          id={row.gatekeeperId}
          name={nameOf(gatekeeperNames, row.gatekeeperId)}
          size="s"
        />
      ),
    },
  ];
  if (row.onBehalfOf !== undefined) {
    actionItems.push({
      key: 'onBehalfOf',
      label: t('代表', 'On behalf of'),
      value: (
        <RefChip
          kind="principal"
          id={row.onBehalfOf}
          name={nameOf(principalNames, row.onBehalfOf)}
          size="s"
          testId="approval-on-behalf-of"
        />
      ),
    });
  }
  // Legacy 216 ①: the definition the request was made under, for every approver — unless the
  // sentence beside the always-allow choice already says it (a stale or unpublished definition).
  const definitionText =
    alwaysAllowBlock === 'stale' || alwaysAllowBlock === 'unpublished'
      ? null
      : requestDefinitionText(row.publishedDefinition, t);
  if (definitionText !== null) {
    actionItems.push({
      key: 'definition',
      label: t('依据定义', 'Definition'),
      value: <span data-testid="approval-definition">{definitionText}</span>,
    });
  }
  if (row.policyDecision) {
    actionItems.push({
      key: 'policy',
      label: t('策略', 'Policy'),
      value: (
        // Legacy sweep (console batch, 2026-10-16): no raw-value tooltip.
        <span data-testid="approval-policy">{policyDecisionLabel(row.policyDecision, t)}</span>
      ),
    });
  }
  actionItems.push({
    key: 'requestedAt',
    label: t('请求于', 'Requested'),
    value: (
      <>
        <time title={formatDateTime(row.requestedAt)}>{formatRelative(row.requestedAt)}</time>
        <span className="text-3">
          {' · '}
          <time>{formatDateTime(row.requestedAt)}</time>
        </span>
      </>
    ),
  });
  if (row.executedAt) {
    actionItems.push({
      key: 'executedAt',
      label: t('执行于', 'Executed'),
      value: formatDateTime(row.executedAt),
    });
  }
  if (row.failedAt) {
    actionItems.push({
      key: 'failedAt',
      label: <span className="text-danger">{t('失败于', 'Failed')}</span>,
      value: <span className="text-danger">{formatDateTime(row.failedAt)}</span>,
    });
  }

  return (
    <div className="stack" data-testid="approval-detail" data-action-request-id={row.id}>
      <header className="stack-s approval-detail-header">
        <div className="row-wrap">
          <StatusChip
            machine="blastRadius"
            status={row.blastRadius}
            size="s"
            testId="approval-blast-radius"
          />
          <StatusChip
            machine="actionRequest"
            status={row.status}
            size="s"
            testId="approval-status"
          />
          {/* Audit P1-13: this request's own reference, named as such — `name={null}` read as
           *  「未知 / 已删除」 about the very request on screen. */}
          <RefChip kind="actionRequest" id={row.id} name={t('本请求', 'This request')} size="s" />
        </div>
        <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
          <h2 className="approval-detail-title" title={actionKindRaw(row.actionKindTag)}>
            {actionKindLabel(row.actionKindTag)}
            {scopeLabel ? <span className="mono text-2"> · {scopeLabel}</span> : null}
          </h2>
          {canOpen(provenance) !== false ? (
            <Button variant="secondary" size="s" asChild>
              <a href={provenance} data-testid="approval-provenance-link">
                {t('查看溯源', 'View provenance')}
              </a>
            </Button>
          ) : null}
        </div>
        <div className="row-wrap text-3">
          <span>{t('由', 'Proposed by')}</span>
          {row.actorRuntime ? (
            <span className="tag">{actorRuntimeLabel(row.actorRuntime, t)}</span>
          ) : (
            <span>{t('未知来源', 'an unknown source')}</span>
          )}
          {row.onBehalfOf !== undefined ? (
            <>
              <span className="meta-sep" />
              <span>{t('代表', 'on behalf of')}</span>
              <RefChip
                kind="principal"
                id={row.onBehalfOf}
                name={nameOf(principalNames, row.onBehalfOf)}
                size="s"
              />
            </>
          ) : null}
          <span className="meta-sep" />
          <time title={formatDateTime(row.requestedAt)}>{formatRelative(row.requestedAt)}</time>
          {row.parentWorkerRunId ? (
            <>
              <span className="meta-sep" />
              <span>{t('Worker 运行', 'Worker run')}</span>
              {/* Legacy 314 sweep: a WorkerRun is no graph Object `resolve_refs` can name. */}
              <RefChip
                kind="object"
                id={row.parentWorkerRunId}
                name={t('发起本请求的运行', 'The run that made this request')}
                size="s"
              />
            </>
          ) : null}
        </div>
      </header>

      <ActionWaitingNotice row={row} testId="approval-waiting" />
      {row.status === 'pending_approval' && row.onBehalfOfAccount === 'not_connected' ? (
        <RequesterAccountNotice
          own={callerPrincipalId != null && row.onBehalfOf === callerPrincipalId}
          testId="approval-requester-account"
        />
      ) : null}
      <ActionFailureNotice
        row={row}
        check={{
          system: nameOf(gatekeeperNames, row.gatekeeperId),
          // The Operation's own name, not its humanized label (UX acceptance of #601, P2-3):
          // `stock.adjust` and `stock_adjust` read alike, and this is what a person checks for.
          action: scopeLabel
            ? t(
                `${actionKindTagText(row.actionKindTag)}（${scopeLabel}）`,
                `${actionKindTagText(row.actionKindTag)} (${scopeLabel})`,
              )
            : actionKindTagText(row.actionKindTag),
        }}
        reasonWhere={<FailureReasonWhere actionRequestId={row.id} />}
        testId="approval-failure"
      />

      {blocking && !ownRequestLocked ? (
        <Notice tone="warn" testId="approval-blocking">
          {t('Worker 已暂停，等待你的决定。', 'The Worker is blocked until you decide.')}
        </Notice>
      ) : null}

      <section className="stack-s">
        <span className="section-title">{t('动作', 'Action')}</span>
        <KeyValue items={actionItems} />
      </section>

      {row.params && Object.keys(row.params).length > 0 ? (
        <section className="stack-s">
          <span className="section-title">{t('参数', 'Parameters')}</span>
          <pre className="code-block params-block" data-testid="approval-params">
            {prettyJsonVisible(redactSensitive(row.params))}
          </pre>
        </section>
      ) : null}

      {!decidable ? (
        <section className="stack-s">
          <span className="section-title">{t('决定', 'Decision')}</span>
          <div className="stack-s" data-testid="approval-decision">
            {decided ? (
              <span className="row-wrap">
                <RefChip
                  kind="principal"
                  id={row.decidedBy as string}
                  name={nameOf(principalNames, row.decidedBy as string)}
                  size="s"
                  testId="approval-decided-by"
                />
                {row.decidedAt ? (
                  <time className="text-3" title={formatDateTime(row.decidedAt)}>
                    {formatRelative(row.decidedAt)}
                  </time>
                ) : null}
              </span>
            ) : (
              <span className="text-3">
                {t(
                  '无人工决定（自动 / 策略 / 过期）',
                  'No human decision (auto / policy / expiry)',
                )}
              </span>
            )}
            {decisionReason ? (
              <span className="pre-wrap" data-testid="approval-decision-reason">
                {visibleLines(decisionReason)}
              </span>
            ) : null}
            <RedactedNote value={decisionReason} testId="approval-decision-reason-redacted" />
          </div>
        </section>
      ) : null}

      {/* Always mounted — unlike the read-only "决定" section above, this is never wrapped in
          `{decidable ? ... : null}`: the optimistic decision (`moveToDecided` in
          `useApprovalQueue`) flips `row.status` (and so `decidable`) to a decided value the
          instant the confirmed call starts, *before* it settles — an approve/reject already in
          flight through this very `Confirm`. Unmounting `Confirm` at that moment would discard its
          own in-flight `busy`/`error` state (`kit/confirm`'s `useConfirmRun`) a render before the
          kernel's rejection ever reaches it, silently dropping the inline error and reopening the
          popover empty. Only `anchor`'s content (the footer) is conditional on `decidable`; the
          popover itself, and whichever `pending` decision opened it, are unaffected by that flip. */}
      <Confirm
        tier="medium"
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) onPendingChange(null);
        }}
        anchor={
          decidable && ownRequestLocked ? (
            <Notice testId="approval-own-request">
              {t(
                '这条请求是代表你发起的，策略不允许发起人自己批准或拒绝（高影响的动作默认如此），所以这里没有决定按钮：要由另一位有审批权的人决定。',
                'This request was made on your behalf, and the policy does not let the requester approve or reject it (the default for high-impact actions), so there are no decision buttons here: someone else with approval rights decides.',
              )}
            </Notice>
          ) : decidable ? (
            <div className="stack-s approval-decision-footer">
              <Field
                id={reasonId}
                label={t('理由', 'Reason')}
                required={reasonRequired}
                hint={
                  reasonError
                    ? undefined
                    : reasonRequired
                      ? t(
                          '高影响：批准必须写理由，理由写入审计。',
                          'High impact: approving requires a reason; it is written to the audit log.',
                        )
                      : t('可选；随决定一并写入审计。', 'Optional; recorded with the decision.')
                }
                error={reasonError}
              >
                <Textarea
                  id={reasonId}
                  ref={reasonRef}
                  aria-label={t('理由', 'Reason')}
                  value={reason}
                  onChange={(event) => {
                    setReason(event.target.value);
                    if (reasonError) setReasonError(null);
                  }}
                  invalid={reasonError !== null}
                  aria-describedby={describedBy(reasonId, !reasonError, reasonError !== null)}
                  maxLength={DECISION_REASON_MAX_LENGTH}
                  data-testid="approval-reason"
                  data-discard-guard
                />
              </Field>
              {reasonCount !== null ? (
                <p
                  className="text-3 text-small m-0"
                  aria-live="polite"
                  data-testid="approval-reason-count"
                >
                  {reasonCount}
                </p>
              ) : null}

              {offerAlwaysAllow ? (
                <label className="checkbox" data-testid="approval-always-allow-option">
                  <input
                    type="checkbox"
                    checked={alwaysAllow}
                    onChange={(event) => setAlwaysAllow(event.target.checked)}
                  />
                  <span>
                    {t(
                      `总是允许门「${gateName}」上的 ${actionKindTagText(row.actionKindTag)}：今后任何人发起都自动批准，不只是这次请求。`,
                      `Always allow ${actionKindTagText(row.actionKindTag)} on gate “${gateName}”: from now on it is auto-approved for every requester, not only this request.`,
                    )}
                    {coveredVersion !== null
                      ? t(
                          `只对现在发布的 v${coveredVersion} 有效；以后发布新版本，请求会重新走审批。`,
                          ` It covers the v${coveredVersion} published now; once a new version is published, requests go back through approval.`,
                        )
                      : null}
                  </span>
                </label>
              ) : null}
              {alwaysAllowBlock === 'stale' && publishedVersion !== null ? (
                <p className="field-hint" data-testid="approval-always-allow-stale">
                  {alwaysAllowStaleRequestText(t, publishedVersion)}
                </p>
              ) : null}
              {alwaysAllowBlock === 'unpublished' ? (
                <p className="field-hint" data-testid="approval-always-allow-unpublished">
                  {alwaysAllowUnpublishedText(t, row.actionKindTag, gateName)}
                </p>
              ) : null}

              <CredentialReview
                count={suspectedSecretValues}
                paths={suspectedSecretPaths}
                subject="approve"
                checked={credentialsReviewed}
                onChange={setCredentialsReviewed}
                disabled={busy !== null}
              />

              <div className="row-wrap overlay-actions">
                <Button
                  variant="primary"
                  aria-busy={busy === 'approve'}
                  disabled={approveBlocked || busy !== null}
                  title={
                    approveBlocked
                      ? t('先勾选「已核对凭据」', 'Tick “Credentials reviewed” first')
                      : undefined
                  }
                  onClick={() => void decide('approve')}
                  data-testid="approval-approve"
                >
                  {t('批准', 'Approve')}
                </Button>
                <Button
                  variant="danger"
                  aria-busy={busy === 'reject'}
                  disabled={busy !== null}
                  onClick={() => void decide('reject')}
                  data-testid="approval-reject"
                >
                  {t('拒绝…', 'Reject…')}
                </Button>
              </div>

              <p className="text-3 text-small">
                {t(
                  '批准即写入审计：操作者、代表者、目标、参数与理由。',
                  'Approving writes to the audit log: the actor, on-behalf-of principal, target, parameters and reason.',
                )}
              </p>
            </div>
          ) : null
        }
        title={
          pending?.kind === 'reject'
            ? t(
                `拒绝 ${actionKindLabel(row.actionKindTag)}`,
                `Reject: ${actionKindLabel(row.actionKindTag)}`,
              )
            : pending?.alwaysAllow
              ? t(
                  `批准并总是允许 ${actionKindLabel(row.actionKindTag)}`,
                  `Approve and always allow: ${actionKindLabel(row.actionKindTag)}`,
                )
              : t(
                  `批准高影响动作 ${actionKindLabel(row.actionKindTag)}`,
                  `Approve a high-impact action: ${actionKindLabel(row.actionKindTag)}`,
                )
        }
        description={
          pending?.kind === 'reject'
            ? t(
                '拒绝后 Worker 不会执行该动作；请求进入历史，理由写入审计。',
                'The Worker will not run this action; the request moves to History and the reason is audited.',
              )
            : pending?.alwaysAllow
              ? t(
                  `批准后门立即执行这次请求，并写入一条自动批准规则：今后门「${gateName}」上的 ${actionKindTagText(row.actionKindTag)} 不论谁发起都直接执行，不再进入审批队列。规则只对这次请求所依据的定义${coveredVersion !== null ? `（v${coveredVersion}）` : ''}有效，以后发布新版本会重新走审批；其他门上的同名动作不受影响。规则可在「模型与配额 → 策略」中关闭。`,
                  `The Gatekeeper executes this request now, and an auto-approval rule is written: from now on ${actionKindTagText(row.actionKindTag)} on gate “${gateName}” runs without approval for every requester. The rule covers only the definition this request was made under${coveredVersion !== null ? ` (v${coveredVersion})` : ''} — a later version goes back through approval — and the same name on other gates is not affected. Turn the rule off under Models & Quotas → Policies.`,
                )
              : t(
                  '批准后门立即执行该动作，无法撤回；理由写入审计。',
                  'The Gatekeeper executes this immediately after approval; it cannot be recalled. The reason is audited.',
                )
        }
        target={
          scopeLabel ??
          nameOf(gatekeeperNames, row.gatekeeperId) ??
          actionKindTagText(row.actionKindTag)
        }
        impact={
          pending ? confirmImpact(pending, row, principalNames, gatekeeperNames, t) : undefined
        }
        confirmLabel={
          pending?.kind === 'reject'
            ? t('确认拒绝', 'Reject')
            : pending?.alwaysAllow
              ? t('批准并总是允许', 'Approve and always allow')
              : t('确认批准', 'Approve')
        }
        danger={
          pending?.kind === 'reject' ||
          row.blastRadius === 'high' ||
          (pending?.kind === 'approve' && pending.alwaysAllow)
        }
        onConfirm={runConfirm}
        testId="approval-confirm"
      >
        {pending ? (
          <KeyValue
            items={[
              {
                key: 'request',
                label: t('请求', 'Request'),
                // Legacy 314: named as the request on screen — `name={null}` with nothing to
                // resolve it read 「未知 / 已删除」 about a request that exists.
                value: (
                  <RefChip
                    kind="actionRequest"
                    id={row.id}
                    name={t('本请求', 'This request')}
                    size="s"
                  />
                ),
              },
              {
                key: 'reason',
                label: t('理由', 'Reason'),
                value: (
                  <span className="pre-wrap" data-testid="approval-confirm-reason">
                    {pending.reason ?? <span className="text-3">{t('（无）', '(none)')}</span>}
                  </span>
                ),
              },
              ...(pending.kind === 'approve' && pending.alwaysAllow
                ? [
                    {
                      key: 'alwaysAllow',
                      label: t('总是允许', 'Always allow'),
                      value: (
                        <span data-testid="approval-confirm-always-allow-scope">
                          {t(`门「${gateName}」上的 `, `On gate “${gateName}”, `)}
                          <code title={actionKindRaw(row.actionKindTag)}>
                            {actionKindTagText(row.actionKindTag)}
                          </code>{' '}
                          {coveredVersion !== null
                            ? t(
                                `今后对所有发起人自动批准（只对 v${coveredVersion}）`,
                                `will be auto-approved for every requester (v${coveredVersion} only)`,
                              )
                            : t(
                                '今后对所有发起人自动批准（只对这次请求的定义）',
                                'will be auto-approved for every requester (this request’s definition only)',
                              )}
                        </span>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        ) : null}
      </Confirm>

      {/* A 400 credentials_review_required is answered by the confirmation it opened above. */}
      {error !== null && error !== undefined && credentialReviewCount(error) === null ? (
        <div ref={submitErrorRef} tabIndex={-1}>
          <ErrorBanner error={error} testId="approval-decision-error" />
        </div>
      ) : null}
    </div>
  );
}

/** S11 GO12: the statuses in which a request still holds back the requests behind it. */
const UNFINISHED_STATUSES: ReadonlySet<string> = new Set([
  'pending_approval',
  'approved',
  'auto_approved',
  'executing',
]);

/** The confirm's impact lines (§5.8 "Approve 高影响时确认文案列出目标资源"). A pure helper, not a
 *  component — takes `t` from its caller. */
function confirmImpact(
  pending: PendingConfirm,
  row: ActionRequestRow,
  principalNames: ReadonlyMap<string, string> | undefined,
  gatekeeperNames: ReadonlyMap<string, string> | undefined,
  t: Translate,
): readonly string[] {
  const lines: string[] = [
    `${t('动作', 'Action')}: ${actionKindTagText(row.actionKindTag)}`,
    `${t('审批范围', 'Approval scope')}: ${
      resourceScopeLabel(row, gatekeeperNames) ??
      (row.resourceScope ? t('整个门', 'the whole gate') : t('未限定', 'no resource scope'))
    }`,
    `${t('门', 'Gatekeeper')}: ${gatekeeperNames?.get(row.gatekeeperId) ?? row.gatekeeperId}`,
    `${t('影响范围', 'Blast radius')}: ${labelText(statusChipStyle('blastRadius', row.blastRadius), t)}`,
  ];
  if (row.onBehalfOf) {
    lines.push(
      `${t('代表', 'On behalf of')}: ${principalNames?.get(row.onBehalfOf) ?? row.onBehalfOf}`,
    );
  }
  if (row.awaitDecision) {
    lines.push(
      pending.kind === 'approve'
        ? t('被阻塞的 Worker 将继续运行', 'The blocked Worker resumes')
        : t('被阻塞的 Worker 将收到拒绝', 'The blocked Worker is told no'),
    );
  }
  return lines;
}
