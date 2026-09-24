import { useEffect, useRef, useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import type { ActionRequestRow } from '../../lib/governance.js';
import { useT } from '../../lib/i18n.js';
import { hrefs } from '../../lib/router.js';
import { nameOf } from '../approvals/useDirectoryNames.js';
import { ApprovalCard } from '../ui/ApprovalCard.js';
import { ErrorBanner } from '../ui/ErrorBanner.js';
import { RefChip } from '../ui/RefChip.js';
import { SkeletonRows } from '../ui/Skeleton.js';

export interface ApprovalContextProps {
  readonly http: CapabilityCaller;
  readonly actionRequestId: string;
  readonly principalNames?: ReadonlyMap<string, string>;
  readonly gatekeeperNames?: ReadonlyMap<string, string>;
  /** Fires once the request is loaded — the page hands its `approvalDecisionId` to the explain
   *  section (a decided request's provenance root). */
  readonly onLoaded: (row: ActionRequestRow) => void;
}

/**
 * components/audit/ApprovalContext (S6-A A4 — docs/console-completion-plan.md §5.5 "从 …
 * 审批详情 … 加'查看溯源'链接"): the audit page opened from an approval — the request itself
 * (`get_action`, read-only `ui/ApprovalCard`, no decision controls here) with its human decision
 * and its WorkerRun, so the reader sees what was approved next to the audit rows and the
 * decision's provenance chain the other two sections load for it.
 */
export function ApprovalContext({
  http,
  actionRequestId,
  principalNames,
  gatekeeperNames,
  onLoaded,
}: ApprovalContextProps) {
  const t = useT();
  const [row, setRow] = useState<ActionRequestRow | null>(null);
  const [error, setError] = useState<unknown | null>(null);
  // Read at load time only — a fresh `onLoaded` closure per render must not re-fetch.
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  useEffect(() => {
    let cancelled = false;
    setRow(null);
    setError(null);
    http
      .call<ActionRequestRow>('get_action', { actionRequestId })
      .then((loaded) => {
        if (cancelled) return;
        setRow(loaded);
        onLoadedRef.current(loaded);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [http, actionRequestId]);

  return (
    <section
      className="section"
      aria-labelledby="approval-context-title"
      data-testid="approval-context"
    >
      <div className="section-header">
        <h2 id="approval-context-title">{t('审批上下文', 'Approval context')}</h2>
      </div>
      {error !== null ? (
        <ErrorBanner
          error={error}
          title={t('无法加载该审批请求', 'Could not load this approval request')}
          testId="approval-context-error"
        />
      ) : row === null ? (
        <SkeletonRows count={2} label="Loading approval" testId="approval-context-loading" />
      ) : (
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
          policySummary={row.policyDecision ?? undefined}
          readOnly
          approvalsHref={hrefs.approval(row.id)}
          testId="approval-context-card"
        >
          <dl className="definition-list">
            <dt>{t('请求于', 'Requested')}</dt>
            <dd>
              <time title={formatDateTime(row.requestedAt)}>{formatRelative(row.requestedAt)}</time>
            </dd>
            {row.decidedBy ? (
              <>
                <dt>{t('决定者', 'Decided by')}</dt>
                <dd className="row-wrap">
                  <RefChip
                    kind="principal"
                    id={row.decidedBy}
                    name={nameOf(principalNames, row.decidedBy)}
                    size="s"
                    testId="approval-context-decided-by"
                  />
                  {row.decidedAt ? (
                    <time className="text-3" title={formatDateTime(row.decidedAt)}>
                      {formatRelative(row.decidedAt)}
                    </time>
                  ) : null}
                </dd>
              </>
            ) : null}
            {row.decisionReason ? (
              <>
                <dt>{t('理由', 'Reason')}</dt>
                <dd className="pre-wrap">{row.decisionReason}</dd>
              </>
            ) : null}
            {row.parentWorkerRunId ? (
              <>
                <dt>{t('Worker 运行', 'Worker run')}</dt>
                <dd>
                  <RefChip kind="object" id={row.parentWorkerRunId} name="WorkerRun" size="s" />
                </dd>
              </>
            ) : null}
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
          </dl>
        </ApprovalCard>
      )}
    </section>
  );
}
