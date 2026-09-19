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
  /** The page decides whether a confirmation step (`ConfirmTier`) precedes the call — this
   *  component only reports the intent. Awaited so the card's own button shows busy. */
  readonly onApprove: (input: ApprovalDecisionInput) => Promise<void>;
  readonly onReject: (input: Omit<ApprovalDecisionInput, 'alwaysAllow'>) => Promise<void>;
  /** The most recent error from a decision call on *this* request, if any. */
  readonly error: unknown | null;
}

/**
 * components/approvals/ApprovalDetail (S6-A B2 / C25 — docs/console-completion-plan.md §5.8
 * "确认态", §5.9 "待我审批"): the approvals page's rendering of one ActionRequest on the shared
 * `ui/ApprovalCard` (the same card the chat thread is moving to). Governance fields are the
 * card's own (kind, blast radius, status, target, gatekeeper / on-behalf-of as `RefChip`s with
 * names from the directory hooks); this component adds what the card leaves to its body: the
 * redacted parameters, the timestamps, the human decision (`decisionReason` / `decidedBy` /
 * `decidedAt`, S6-A wire fields — absent or `null` when no human decided), the "总是允许"
 * checkbox, and the "查看溯源" link into the audit page (§5.5).
 *
 * The reason textarea and its high-blast-radius validation live in `ApprovalCard` (kernel rule
 * C25 mirrored client-side); the page's `ConfirmTier` step runs *after* the card has accepted
 * the reason. Replaces `ActionRequestDetail` for this page only — the chat's inline card
 * (`ActionRequestCard.tsx`, chat lane) keeps `ActionRequestDetail` until it migrates.
 */
export function ApprovalDetail({
  row,
  principalNames,
  gatekeeperNames,
  canAlwaysAllow,
  onApprove,
  onReject,
  error,
}: ApprovalDetailProps) {
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  const decidable = isDecidable(row.status);
  const blocking = row.awaitDecision && decidable;
  const decided = row.decidedBy !== undefined && row.decidedBy !== null;
  const decisionReason = row.decisionReason ?? null;
  const provenance = auditHref({
    actionRequestId: row.id,
    ...(row.approvalDecisionId ? { nodeId: row.approvalDecisionId } : {}),
  });

  return (
    <div className="stack" data-testid="approval-detail" data-action-request-id={row.id}>
      {blocking ? (
        <Notice tone="warn" testId="approval-blocking">
          Worker 已暂停，等待你的决定。 The Worker is blocked until you decide.
        </Notice>
      ) : null}

      <ApprovalCard
        actionRequestId={row.id}
        actionKind={row.actionKindTag}
        blastRadius={row.blastRadius}
        status={row.status}
        target={
          row.resourceScope ? (
            <span className="mono">{row.resourceScope}</span>
          ) : (
            <span className="text-3">未限定资源 No resource scope</span>
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
                  · 发起自 from <span className="tag">{row.actorRuntime}</span>
                </span>
              ) : null}
            </span>
          ) : undefined
        }
        readOnly={!decidable}
        onApprove={
          decidable
            ? (reason) => onApprove({ actionRequestId: row.id, reason, alwaysAllow })
            : undefined
        }
        onReject={decidable ? (reason) => onReject({ actionRequestId: row.id, reason }) : undefined}
        testId="approval-card"
      >
        {row.params && Object.keys(row.params).length > 0 ? (
          <div className="stack-s">
            <span className="section-title">参数 Parameters</span>
            <pre className="code-block params-block" data-testid="approval-params">
              {prettyJson(redactSensitive(row.params))}
            </pre>
          </div>
        ) : null}

        <dl className="definition-list">
          <dt>请求于 Requested</dt>
          <dd>
            <time title={formatDateTime(row.requestedAt)}>{formatRelative(row.requestedAt)}</time>
            <span className="text-3"> · {formatDateTime(row.requestedAt)}</span>
          </dd>
          {row.executedAt ? (
            <>
              <dt>执行于 Executed</dt>
              <dd>{formatDateTime(row.executedAt)}</dd>
            </>
          ) : null}
          {row.failedAt ? (
            <>
              <dt className="text-danger">失败于 Failed</dt>
              <dd className="text-danger">{formatDateTime(row.failedAt)}</dd>
            </>
          ) : null}
          {!decidable ? (
            <>
              <dt>决定 Decision</dt>
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
                    无人工决定（自动 / 策略 / 过期） No human decision (auto / policy / expiry)
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
              <dt>Worker 运行 Worker run</dt>
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
              总是允许 Always allow <code>{row.actionKindTag}</code>（批准时一并写入自动批准规则 —
              approving also writes the auto-approval rule）
            </span>
          </label>
        ) : null}

        <a className="approval-card-link" href={provenance} data-testid="approval-provenance-link">
          查看溯源 View provenance · {humanizeKind(row.actionKindTag)}
        </a>
      </ApprovalCard>

      {error !== null && error !== undefined ? (
        <ErrorBanner error={error} testId="approval-decision-error" />
      ) : null}
    </div>
  );
}
