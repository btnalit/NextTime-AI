import { useMemo } from 'react';
import { useCapabilityList } from '../../hooks/useCapability.js';
import { usePermissions } from '../../hooks/usePermissions.js';
import type { CapabilityCaller, PushSource } from '../../lib/clients.js';
import { isForbiddenError } from '../../lib/errors.js';
import { formatDateTime, formatRelative, humanizeKind } from '../../lib/format.js';
import type { ActionRequestRow } from '../../lib/governance.js';
import { Button } from '../ui/Button.js';
import { DataList, DataRow } from '../ui/DataList.js';
import { ErrorBanner } from '../ui/ErrorBanner.js';
import { Icon } from '../ui/Icon.js';
import { Notice } from '../ui/Notice.js';
import { RefChip } from '../ui/RefChip.js';
import { SkeletonRows } from '../ui/Skeleton.js';
import { StatusChip } from '../ui/StatusChip.js';
import { nameOf } from './useDirectoryNames.js';

export interface LinkedApprovalsProps {
  readonly http: CapabilityCaller;
  readonly pushes: PushSource;
  readonly taskId: string;
  readonly principalNames?: ReadonlyMap<string, string>;
  readonly onOpenApproval: (actionRequestId: string) => void;
}

const PAGE_SIZE = 20;

/**
 * components/approvals/LinkedApprovals (S6-A C28 — docs/console-completion-plan.md §5.5, §6;
 * runbook web-console.md 已知缺口 6): the Task detail's "关联审批" over
 * `list_action_requests{taskId}` — every ActionRequest any of the Task's WorkerRuns raised,
 * decided ones included (the handler resolves `taskId` to the Task's `parent_worker_run_id`s;
 * an unknown Task is an empty page, not a 404). Replaces the `list_pending` reverse lookup that
 * could only ever show still-pending rows. Keyset "加载更多" via `useCapabilityList`; the
 * `action.pending` / `action.updated` pushes reload this one Task's list (C7: a task-scoped
 * refetch, never a workspace-wide one).
 *
 * `list_action_requests` is `minRole: 'operator'` (same as `list_pending`): a member session
 * that has already learned the 403 gets the explanation without another request; the first 403
 * of a session is learned here through `useCapabilityList`'s own permission marking.
 */
export function LinkedApprovals(props: LinkedApprovalsProps) {
  const permissions = usePermissions();
  if (permissions.isDenied('list_action_requests')) {
    return (
      <Notice testId="linked-approvals-forbidden">
        查看关联审批需要 operator 角色。 Linked approvals need the operator role
        (`list_action_requests`).
      </Notice>
    );
  }
  return <LinkedApprovalsList {...props} />;
}

function LinkedApprovalsList({
  http,
  pushes,
  taskId,
  principalNames,
  onOpenApproval,
}: LinkedApprovalsProps) {
  const params = useMemo(() => ({ taskId, limit: PAGE_SIZE }), [taskId]);
  const linked = useCapabilityList<ActionRequestRow>(http, 'list_action_requests', params, {
    pushes,
    reloadOn: ['actionPending', 'actionUpdated'],
  });
  const rows = linked.state.status === 'ready' ? linked.state.data.items : [];
  const nextCursor = linked.state.status === 'ready' ? linked.state.data.nextCursor : undefined;

  if (linked.state.status === 'loading') {
    return (
      <SkeletonRows count={2} label="Loading linked approvals" testId="linked-approvals-loading" />
    );
  }
  if (linked.state.status === 'error') {
    if (isForbiddenError(linked.state.error)) {
      return (
        <Notice testId="linked-approvals-forbidden">
          查看关联审批需要 operator 角色。 Linked approvals need the operator role
          (`list_action_requests`).
        </Notice>
      );
    }
    return (
      <ErrorBanner
        error={linked.state.error}
        title="无法加载关联审批 Could not load linked approvals"
        onRetry={() => void linked.reload()}
        testId="linked-approvals-error"
      />
    );
  }
  if (rows.length === 0) {
    return (
      <span className="text-3 text-small" data-testid="linked-approvals-empty">
        该任务的 Worker 尚未提出任何执行类动作。 No WorkerRun of this Task has raised an
        ActionRequest.
      </span>
    );
  }
  return (
    <div className="stack-s">
      {linked.state.refreshError ? (
        <ErrorBanner error={linked.state.refreshError} onRetry={() => void linked.reload()} />
      ) : null}
      <DataList ariaLabel="Linked approvals" testId="linked-approvals-list">
        {rows.map((row) => {
          const decidedBy = row.decidedBy ?? null;
          return (
            <DataRow
              key={row.id}
              testId="linked-approval-row"
              onSelect={() => onOpenApproval(row.id)}
              leading={<StatusChip machine="actionRequest" status={row.status} size="s" />}
              title={
                <>
                  <span className="truncate">{humanizeKind(row.actionKindTag)}</span>
                  <span className="tag">{row.actionKindTag}</span>
                  {row.blastRadius !== 'low' ? (
                    <StatusChip machine="blastRadius" status={row.blastRadius} size="s" />
                  ) : null}
                </>
              }
              meta={
                <>
                  {row.resourceScope ? (
                    <>
                      <span className="mono truncate">{row.resourceScope}</span>
                      <span className="meta-sep" />
                    </>
                  ) : null}
                  <time title={formatDateTime(row.requestedAt)}>
                    请求 requested {formatRelative(row.requestedAt)}
                  </time>
                  {decidedBy ? (
                    <>
                      <span className="meta-sep" />
                      <span className="text-3">决定 decided by</span>
                      <RefChip
                        kind="principal"
                        id={decidedBy}
                        name={nameOf(principalNames, decidedBy)}
                        size="s"
                      />
                    </>
                  ) : null}
                  {row.decisionReason ? (
                    <>
                      <span className="meta-sep" />
                      <span className="truncate" title={row.decisionReason}>
                        “{row.decisionReason}”
                      </span>
                    </>
                  ) : null}
                </>
              }
              trailing={<Icon name="chevron-right" />}
            />
          );
        })}
      </DataList>
      {nextCursor !== undefined ? (
        <div className="row" style={{ justifyContent: 'center' }}>
          <Button
            variant="secondary"
            size="s"
            loading={linked.loadingMore}
            onClick={() => void linked.loadMore()}
          >
            加载更多 Load more
          </Button>
        </div>
      ) : null}
      {linked.loadMoreError !== null ? (
        <ErrorBanner
          error={linked.loadMoreError}
          title="无法加载更多关联审批 Could not load more linked approvals"
        />
      ) : null}
    </div>
  );
}
