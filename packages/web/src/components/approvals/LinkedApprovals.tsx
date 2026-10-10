import { useMemo } from 'react';
import { useCapabilityList } from '../../hooks/useCapability.js';
import { useRoleCan } from '../../hooks/useRoleCan.js';
import type { CapabilityCaller, PushSource } from '../../lib/clients.js';
import { isForbiddenError } from '../../lib/errors.js';
import { formatDateTime, formatRelative, humanizeKind, shortId } from '../../lib/format.js';
import type { ActionRequestRow } from '../../lib/governance.js';
import { useT } from '../../lib/i18n.js';
import { Button } from '../kit/button.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { List, ListRow } from '../kit/list-row.js';
import { Notice } from '../kit/notice.js';
import { SkeletonRows } from '../kit/skeleton.js';
import { StatusChip } from '../kit/status-chip.js';
import { nameOf, resourceScopeLabel } from './useDirectoryNames.js';

export interface LinkedApprovalsProps {
  readonly http: CapabilityCaller;
  readonly pushes: PushSource;
  readonly taskId: string;
  readonly principalNames?: ReadonlyMap<string, string>;
  readonly onOpenApproval: (actionRequestId: string) => void;
}

const PAGE_SIZE = 20;

/** The Task's approvals are an operator/owner read: say whom to ask, never the capability name. */
function LinkedApprovalsForbidden() {
  const t = useT();
  return (
    <Notice testId="linked-approvals-forbidden">
      {t(
        '关联的审批只有 operator 和工作区所有者能看。要查看，请工作区所有者把你的角色改为 operator。',
        'Only operators and the workspace owner see linked approvals. To see them, ask the workspace owner to make you an operator.',
      )}
    </Notice>
  );
}

/**
 * components/approvals/LinkedApprovals (console redesign P3-4 part B, on `components/kit/*` only;
 * S6-A C28 — docs/console-completion-plan.md §5.5, §6; runbook web-console.md 已知缺口 6): the Task
 * detail's "关联审批" over `list_action_requests{taskId}` — every ActionRequest any of the Task's
 * WorkerRuns raised, decided ones included (the handler resolves `taskId` to the Task's
 * `parent_worker_run_id`s; an unknown Task is an empty page, not a 404). Replaces the
 * `list_pending` reverse lookup that could only ever show still-pending rows. Keyset "加载更多" via
 * `useCapabilityList`; the `action.pending` / `action.updated` pushes reload this one Task's list
 * (C7: a task-scoped refetch, never a workspace-wide one).
 *
 * `list_action_requests` is `minRole: 'operator'` (same as `list_pending`): a member session
 * that has already learned the 403 gets the explanation without another request; the first 403
 * of a session is learned here through `useCapabilityList`'s own permission marking.
 */
export function LinkedApprovals(props: LinkedApprovalsProps) {
  const can = useRoleCan(props.http);
  if (can('list_action_requests') === false) {
    return <LinkedApprovalsForbidden />;
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
  const t = useT();
  const params = useMemo(() => ({ taskId, limit: PAGE_SIZE }), [taskId]);
  const linked = useCapabilityList<ActionRequestRow>(http, 'list_action_requests', params, {
    pushes,
    reloadOn: ['actionPending', 'actionUpdated'],
  });
  const rows = linked.state.status === 'ready' ? linked.state.data.items : [];
  const nextCursor = linked.state.status === 'ready' ? linked.state.data.nextCursor : undefined;

  if (linked.state.status === 'loading') {
    return (
      <SkeletonRows
        count={2}
        label={t('正在加载关联审批…', 'Loading linked approvals')}
        testId="linked-approvals-loading"
      />
    );
  }
  if (linked.state.status === 'error') {
    if (isForbiddenError(linked.state.error)) {
      return <LinkedApprovalsForbidden />;
    }
    return (
      <ErrorBanner
        error={linked.state.error}
        title={t('无法加载关联审批', 'Could not load linked approvals')}
        onRetry={() => void linked.reload()}
        testId="linked-approvals-error"
      />
    );
  }
  if (rows.length === 0) {
    return (
      <span className="text-3 text-small" data-testid="linked-approvals-empty">
        {t(
          '该任务的 Worker 尚未提出任何执行类动作。',
          'No WorkerRun of this Task has raised an ActionRequest.',
        )}
      </span>
    );
  }
  return (
    <div className="stack-s">
      {linked.state.refreshError ? (
        <ErrorBanner error={linked.state.refreshError} onRetry={() => void linked.reload()} />
      ) : null}
      <List ariaLabel="Linked approvals" testId="linked-approvals-list">
        {rows.map((row) => {
          const decidedBy = row.decidedBy ?? null;
          return (
            <ListRow
              key={row.id}
              testId="linked-approval-row"
              onSelect={() => onOpenApproval(row.id)}
            >
              <span className="row-wrap">
                <StatusChip machine="actionRequest" status={row.status} size="s" />
                <span className="truncate">{humanizeKind(row.actionKindTag)}</span>
                {row.blastRadius !== 'low' ? (
                  <StatusChip machine="blastRadius" status={row.blastRadius} size="s" />
                ) : null}
              </span>
              <span className="row-wrap text-3">
                {resourceScopeLabel(row, undefined) ? (
                  <>
                    <span className="mono truncate">{resourceScopeLabel(row, undefined)}</span>
                    <span className="meta-sep" />
                  </>
                ) : null}
                <time title={formatDateTime(row.requestedAt)}>
                  {t('请求', 'requested')} {formatRelative(row.requestedAt)}
                </time>
                {decidedBy ? (
                  <>
                    <span className="meta-sep" />
                    <span>{t('决定', 'decided by')}</span>
                    <span className="truncate">
                      {nameOf(principalNames, decidedBy) ?? shortId(decidedBy)}
                    </span>
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
              </span>
            </ListRow>
          );
        })}
      </List>
      {nextCursor !== undefined ? (
        <div className="row" style={{ justifyContent: 'center' }}>
          <Button
            variant="secondary"
            size="s"
            aria-busy={linked.loadingMore}
            disabled={linked.loadingMore}
            onClick={() => void linked.loadMore()}
          >
            {t('加载更多', 'Load more')}
          </Button>
        </div>
      ) : null}
      {linked.loadMoreError !== null ? (
        <ErrorBanner
          error={linked.loadMoreError}
          title={t('无法加载更多关联审批', 'Could not load more linked approvals')}
        />
      ) : null}
    </div>
  );
}
