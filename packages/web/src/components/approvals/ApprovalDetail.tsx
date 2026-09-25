import { useState } from 'react';
import { isDecidable } from '../../lib/action-card.js';
import { auditHref } from '../../lib/audit.js';
import {
  formatDateTime,
  formatRelative,
  humanizeKind,
  prettyJson,
  redactSensitive,
} from '../../lib/format.js';
import type { ActionRequestRow } from '../../lib/governance.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { labelText, statusChipStyle } from '../../lib/status-tone.js';
import { Confirm } from '../kit/confirm.js';
import { ApprovalCard } from '../ui/ApprovalCard.js';
import { ErrorBanner } from '../ui/ErrorBanner.js';
import { Notice } from '../ui/Notice.js';
import { RefChip } from '../ui/RefChip.js';
import { nameOf } from './useDirectoryNames.js';

export interface ApprovalDecisionInput {
  readonly actionRequestId: string;
  readonly reason: string | undefined;
  /** "总是允许 Always allow this kind" — approve, then `set_auto_approved_action_kind` (the
   *  pre-S6-A semantics of the same checkbox, kept: the two are one gesture). */
  readonly alwaysAllow: boolean;
}

export interface ApprovalDetailProps {
  readonly row: ActionRequestRow;
  readonly principalNames?: ReadonlyMap<string, string>;
  readonly gatekeeperNames?: ReadonlyMap<string, string>;
  /** `false` hides "总是允许" — `set_auto_approved_action_kind` is operator+, and the session has
   *  already been told 403 for it (hooks/usePermissions). */
  readonly canAlwaysAllow: boolean;
  /** The confirmed decision — throws so the confirm stays open with the kernel's error (awaited
   *  so the card's own button shows busy for a low/medium Approve, which calls this directly). */
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
    }
  | { readonly kind: 'reject'; readonly reason: string | undefined };

/**
 * components/approvals/ApprovalDetail (S6-A B2 / C25, S8 W1-A7 — docs/console-completion-plan.md
 * §5.8 "确认态", §5.9 "待我审批"; audit S13): the approvals page's rendering of one ActionRequest
 * on the shared `ui/ApprovalCard` (the same card the chat thread is moving to). Governance fields
 * are the card's own (kind, blast radius, status, target, gatekeeper / on-behalf-of as `RefChip`s
 * with names from the directory hooks); this component adds what the card leaves to its body: the
 * redacted parameters, the timestamps, the human decision (`decisionReason` / `decidedBy` /
 * `decidedAt`, S6-A wire fields — absent or `null` when no human decided), the "总是允许"
 * checkbox, and the "查看溯源" link into the audit page (§5.5).
 *
 * A high-blast-radius Approve and every Reject go through `kit/confirm` (`medium`, listing the
 * impact, rendered here) before the call — low/medium Approve is the card's one click (§5.9
 * principle 4). The confirm's `anchor` is the whole `ApprovalCard`, not just its Approve/Reject
 * button: the card is a plain function component with no forwarded ref to its own buttons (also
 * used by the chat thread's inline card), so anchoring to the card itself (the popover aligns to
 * its bottom-right, where the buttons render) keeps the confirm next to the action without
 * widening this lane to `ui/ApprovalCard.tsx`. `pending`/`onPendingChange` are controlled from the
 * page rather than local state — see the prop's own doc comment for why. `approve{reason?}` /
 * `reject{reason?}` carry the reason the card collected (mandatory for high, validated by the card
 * in front of the kernel's own 400 `reason_required`). Replaces `ActionRequestDetail` for this
 * page only — the chat's inline card (`ActionRequestCard.tsx`, chat lane) keeps
 * `ActionRequestDetail` until it migrates.
 */
export function ApprovalDetail({
  row,
  principalNames,
  gatekeeperNames,
  canAlwaysAllow,
  onApprove,
  onReject,
  error,
  pending,
  onPendingChange,
}: ApprovalDetailProps) {
  const t = useT();
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  const decidable = isDecidable(row.status);
  const blocking = row.awaitDecision && decidable;
  const decided = row.decidedBy !== undefined && row.decidedBy !== null;
  const decisionReason = row.decisionReason ?? null;
  const provenance = auditHref({
    actionRequestId: row.id,
    ...(row.approvalDecisionId ? { nodeId: row.approvalDecisionId } : {}),
  });

  /** From the card: low / medium → straight to the call (§5.9 principle 4 "中 · 可逆 → 一键批准");
   *  high → the confirm first. Resolves immediately either way so the card's own busy indicator
   *  never sits spinning for however long the confirm stays open. The direct path's own rejection
   *  is swallowed here (never awaited by the card either) — the page-owned `error` prop is the
   *  one channel for it; a confirmed call instead lets `runConfirm` below re-throw into `Confirm`,
   *  which shows the error inline and keeps the popover open. */
  function requestApprove(reason: string | undefined): void {
    if (row.blastRadius === 'high') {
      onPendingChange({ kind: 'approve', reason, alwaysAllow });
      return;
    }
    onApprove({ actionRequestId: row.id, reason, alwaysAllow }).catch(() => {});
  }

  function requestReject(reason: string | undefined): void {
    onPendingChange({ kind: 'reject', reason });
  }

  async function runConfirm(): Promise<void> {
    if (!pending) return;
    if (pending.kind === 'approve') {
      await onApprove({
        actionRequestId: row.id,
        reason: pending.reason,
        alwaysAllow: pending.alwaysAllow,
      });
    } else {
      await onReject({ actionRequestId: row.id, reason: pending.reason });
    }
  }

  return (
    <div className="stack" data-testid="approval-detail" data-action-request-id={row.id}>
      {blocking ? (
        <Notice tone="warn" testId="approval-blocking">
          {t('Worker 已暂停，等待你的决定。', 'The Worker is blocked until you decide.')}
        </Notice>
      ) : null}

      <Confirm
        tier="medium"
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) onPendingChange(null);
        }}
        anchor={
          <ApprovalCard
            actionRequestId={row.id}
            actionKind={row.actionKindTag}
            blastRadius={row.blastRadius}
            status={row.status}
            target={
              row.resourceScope ? (
                <span className="mono">{row.resourceScope}</span>
              ) : (
                <span className="text-3">{t('未限定资源', 'No resource scope')}</span>
              )
            }
            gatekeeper={{ id: row.gatekeeperId, name: nameOf(gatekeeperNames, row.gatekeeperId) }}
            onBehalfOf={
              row.onBehalfOf !== undefined
                ? { id: row.onBehalfOf, name: nameOf(principalNames, row.onBehalfOf) }
                : undefined
            }
            policySummary={
              row.policyDecision ? (
                <span className="mono">
                  {row.policyDecision}
                  {row.actorRuntime ? (
                    <span className="text-3">
                      {' '}
                      {t('· 发起自', 'from')}
                      <span className="tag">{row.actorRuntime}</span>
                    </span>
                  ) : null}
                </span>
              ) : undefined
            }
            readOnly={!decidable}
            onApprove={decidable ? (reason) => requestApprove(reason) : undefined}
            onReject={decidable ? (reason) => requestReject(reason) : undefined}
            testId="approval-card"
          >
            {row.params && Object.keys(row.params).length > 0 ? (
              <div className="stack-s">
                <span className="section-title">{t('参数', 'Parameters')}</span>
                <pre className="code-block params-block" data-testid="approval-params">
                  {prettyJson(redactSensitive(row.params))}
                </pre>
              </div>
            ) : null}

            <dl className="definition-list">
              <dt>{t('请求于', 'Requested')}</dt>
              <dd>
                <time title={formatDateTime(row.requestedAt)}>
                  {formatRelative(row.requestedAt)}
                </time>
                <span className="text-3"> · {formatDateTime(row.requestedAt)}</span>
              </dd>
              {row.executedAt ? (
                <>
                  <dt>{t('执行于', 'Executed')}</dt>
                  <dd>{formatDateTime(row.executedAt)}</dd>
                </>
              ) : null}
              {row.failedAt ? (
                <>
                  <dt className="text-danger">{t('失败于', 'Failed')}</dt>
                  <dd className="text-danger">{formatDateTime(row.failedAt)}</dd>
                </>
              ) : null}
              {!decidable ? (
                <>
                  <dt>{t('决定', 'Decision')}</dt>
                  <dd className="stack-s" data-testid="approval-decision">
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
                        {decisionReason}
                      </span>
                    ) : null}
                  </dd>
                </>
              ) : null}
              {row.parentWorkerRunId ? (
                <>
                  <dt>{t('Worker 运行', 'Worker run')}</dt>
                  <dd>
                    <RefChip kind="object" id={row.parentWorkerRunId} name={null} size="s" />
                  </dd>
                </>
              ) : null}
            </dl>

            {decidable && canAlwaysAllow ? (
              <label className="checkbox" data-testid="approval-always-allow-option">
                <input
                  type="checkbox"
                  checked={alwaysAllow}
                  onChange={(event) => setAlwaysAllow(event.target.checked)}
                />
                <span>
                  {t('总是允许', 'Always allow')}
                  <code>{row.actionKindTag}</code>（批准时一并写入自动批准规则 — approving also
                  writes the auto-approval rule）
                </span>
              </label>
            ) : null}

            <a
              className="approval-card-link"
              href={provenance}
              data-testid="approval-provenance-link"
            >
              {t('查看溯源', 'View provenance')} · {humanizeKind(row.actionKindTag)}
            </a>
          </ApprovalCard>
        }
        title={
          pending?.kind === 'reject'
            ? t(
                `拒绝 ${humanizeKind(row.actionKindTag)}`,
                `Reject: ${humanizeKind(row.actionKindTag)}`,
              )
            : t(
                `批准高影响动作 ${humanizeKind(row.actionKindTag)}`,
                `Approve a high-impact action: ${humanizeKind(row.actionKindTag)}`,
              )
        }
        description={
          pending?.kind === 'reject'
            ? t(
                '拒绝后 Worker 不会执行该动作；请求进入历史，理由写入审计。',
                'The Worker will not run this action; the request moves to History and the reason is audited.',
              )
            : t(
                '批准后门立即执行该动作，无法撤回；理由写入审计。',
                'The Gatekeeper executes this immediately after approval; it cannot be recalled. The reason is audited.',
              )
        }
        target={row.resourceScope ?? row.actionKindTag}
        impact={
          pending ? confirmImpact(pending, row, principalNames, gatekeeperNames, t) : undefined
        }
        confirmLabel={
          pending?.kind === 'reject' ? t('确认拒绝', 'Reject') : t('确认批准', 'Approve')
        }
        danger={pending?.kind === 'reject' || row.blastRadius === 'high'}
        onConfirm={runConfirm}
        testId="approval-confirm"
      >
        {pending ? (
          <dl className="definition-list">
            <dt>{t('请求', 'Request')}</dt>
            <dd>
              <RefChip kind="actionRequest" id={row.id} name={null} size="s" />
            </dd>
            <dt>{t('理由', 'Reason')}</dt>
            <dd className="pre-wrap" data-testid="approval-confirm-reason">
              {pending.reason ?? <span className="text-3">（无 none）</span>}
            </dd>
            {pending.kind === 'approve' && pending.alwaysAllow ? (
              <>
                <dt>{t('总是允许', 'Always allow')}</dt>
                <dd>
                  <code>{row.actionKindTag}</code> {t('今后自动批准', 'will be auto-approved')}
                </dd>
              </>
            ) : null}
          </dl>
        ) : null}
      </Confirm>

      {error !== null && error !== undefined ? (
        <ErrorBanner error={error} testId="approval-decision-error" />
      ) : null}
    </div>
  );
}

/** The confirm's impact lines (§5.8 "Approve 高影响时确认文案列出目标资源"). A pure helper, not a
 *  component — takes `t` from its caller (S8 W1-A10 i18n remainder: every line used to be a
 *  combined "中文 English" literal, ignoring the language switch; `blastRadius` reuses
 *  `lib/status-tone.ts`'s machine instead of a second hand-maintained low/medium/high map). */
function confirmImpact(
  pending: PendingConfirm,
  row: ActionRequestRow,
  principalNames: ReadonlyMap<string, string> | undefined,
  gatekeeperNames: ReadonlyMap<string, string> | undefined,
  t: Translate,
): readonly string[] {
  const lines: string[] = [
    `${t('动作', 'Action')}: ${row.actionKindTag}`,
    `${t('目标资源', 'Target')}: ${row.resourceScope ?? t('未限定', 'no resource scope')}`,
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
