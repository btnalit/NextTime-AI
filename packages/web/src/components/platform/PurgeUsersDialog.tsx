import type { PurgeUsersResultWire, UserWire } from '@nexttime/shared';
import { useState } from 'react';
import { useCapabilityList } from '../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import { HttpError } from '../../lib/http-client.js';
import { platformErrorMessage } from '../../lib/platform-errors.js';
import { PURGE_USER_SKIP_REASON_LABELS } from '../../lib/platform-workspaces.js';
import { Confirm } from '../kit/confirm.js';
import { Button } from '../ui/Button.js';
import { Drawer } from '../ui/Drawer.js';
import { EmptyState } from '../ui/EmptyState.js';
import { ErrorBanner } from '../ui/ErrorBanner.js';
import { Notice } from '../ui/Notice.js';
import { SkeletonRows } from '../ui/Skeleton.js';

export interface PurgeUsersDialogProps {
  readonly http: CapabilityCaller;
  /** Close — before or after a purge (the page re-reads its list on `onPurged` regardless). */
  readonly onClose: () => void;
  /** `purge_user` answered; `outcomes` has one row per requested id. */
  readonly onPurged: (result: PurgeUsersResultWire) => void;
}

/** `purge_user{userIds}` is `max(200)` (`capabilities.ts`); the candidate list pages at the same
 *  size so one page is one batch at most. */
const BATCH_MAX = 200;

/** Kernel 4xx with the console's bilingual copy as its message, for `Confirm`'s own inline banner. */
function friendly(err: unknown): unknown {
  const mapped = platformErrorMessage(err);
  if (mapped === null || !(err instanceof HttpError)) return err;
  return new HttpError(err.kind, mapped, err.code);
}

/**
 * components/platform/PurgeUsersDialog (S6-A A6, docs/console-completion-plan.md §5.2
 * `purge_user`, §5.9 "用户页复用工作区页的筛选与清除模式"): the "清理待激活用户" batch entry.
 * Lists `list_users{pendingOnly: true}` — every user still awaiting activation, the population
 * `purge_user` can take from (the page's own default view hides the residual subset of it,
 * `hideResidual`) — with a checkbox per row, then `kit/confirm tier="irreversible"` listing the
 * chosen logins, then `purge_user{userIds}`. The result is rendered per user (`purged`, or
 * `skipped` + the kernel's reason in bilingual copy — a skipped user never fails the batch), and
 * handed to the page to re-read the directory.
 *
 * S8 W1-A7: reclassified from the old `ConfirmTier`'s `high` tier to `irreversible` — `purge_user`
 * is a hard delete (no undo), so it belongs with the other unrecoverable actions even though there
 * is no single target name to retype for a batch; `target` is omitted (the acknowledgement
 * checkbox alone gates the danger button, the same as `PurgeWorkspaceDrawer`'s batch-less cases).
 *
 * Two modes of one `Drawer` (pick → results) plus the confirm tier, which is a centred
 * `AlertDialog` of its own: the list drawer unmounts while the tier is open so there is never more
 * than one focus trap. The result is held here, not in the tier — the tier closes itself after
 * `onConfirm`.
 */
export function PurgeUsersDialog({ http, onClose, onPurged }: PurgeUsersDialogProps) {
  const candidates = useCapabilityList<UserWire>(http, 'list_users', {
    pendingOnly: true,
    limit: BATCH_MAX,
  });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [step, setStep] = useState<'pick' | 'confirm'>('pick');
  const [result, setResult] = useState<PurgeUsersResultWire | null>(null);

  const rows = candidates.state.status === 'ready' ? candidates.state.data.items : [];
  const nextCursor =
    candidates.state.status === 'ready' ? candidates.state.data.nextCursor : undefined;
  const chosen = rows.filter((row) => selected.has(row.id));
  const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.id));

  function toggle(userId: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(userId)) next.delete(userId);
      else if (next.size < BATCH_MAX) next.add(userId);
      return next;
    });
  }

  function toggleAll(): void {
    setSelected(allSelected ? new Set() : new Set(rows.slice(0, BATCH_MAX).map((row) => row.id)));
  }

  async function execute(): Promise<void> {
    try {
      const answered = await http.call<PurgeUsersResultWire>('purge_user', {
        userIds: chosen.map((row) => row.id),
      });
      setResult(answered);
      onPurged(answered);
    } catch (err) {
      throw friendly(err);
    }
  }

  if (step === 'confirm') {
    return (
      <Confirm
        tier="irreversible"
        open
        onOpenChange={(open) => {
          if (!open) setStep('pick');
        }}
        title={`清理 ${chosen.length} 个待激活用户 Purge ${chosen.length} pending users`}
        description="从未激活且无活跃成员资格的用户会被删除；有密码、登录过、仍有成员资格或被审计引用的会被内核跳过并说明原因。 Never-activated users with no active membership are deleted; the kernel skips (and explains) any with a password, a login, a live membership or an audit reference."
        impact={chosen.map((row) => `${row.login} — ${row.displayName}`)}
        confirmLabel="确认清理 Purge"
        onConfirm={execute}
        testId="purge-users-confirm"
      />
    );
  }

  if (result !== null) {
    const byId = new Map(chosen.map((row) => [row.id, row] as const));
    return (
      <Drawer
        open
        onClose={onClose}
        title="清理结果 Purge results"
        subtitle={`已清理 ${result.purgedCount} / ${result.outcomes.length} Purged ${result.purgedCount} of ${result.outcomes.length}`}
        testId="purge-users-results"
        footer={
          <Button variant="primary" onClick={onClose} data-testid="purge-users-done">
            关闭 Close
          </Button>
        }
      >
        <table className="data-table" data-testid="purge-users-outcomes">
          <thead>
            <tr>
              <th>登录名 Login</th>
              <th>结果 Outcome</th>
              <th>原因 Reason</th>
            </tr>
          </thead>
          <tbody>
            {result.outcomes.map((outcome) => (
              <tr
                key={outcome.userId}
                data-testid="purge-user-outcome"
                data-outcome={outcome.status}
                data-user-id={outcome.userId}
              >
                <td className="mono">
                  {outcome.login ?? byId.get(outcome.userId)?.login ?? outcome.userId}
                </td>
                <td>
                  <span
                    className={`chip chip-s ${outcome.status === 'purged' ? 'chip-ok' : 'chip-neutral'}`}
                  >
                    {outcome.status === 'purged' ? '已清理 Purged' : '已跳过 Skipped'}
                  </span>
                </td>
                <td>
                  {outcome.reason === undefined ? (
                    <span className="text-3">—</span>
                  ) : (
                    <>
                      {PURGE_USER_SKIP_REASON_LABELS[outcome.reason]}
                      {outcome.detail ? (
                        <span className="text-3 text-small"> · {outcome.detail}</span>
                      ) : null}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Drawer>
    );
  }

  return (
    <Drawer
      open
      onClose={onClose}
      title="清理待激活用户 Clean up pending users"
      subtitle="验收脚本与迁移 0019 留下的、从未设置密码的账户。 Accounts that never got a password — acceptance runs and migration 0019."
      testId="purge-users-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} data-testid="purge-users-cancel">
            取消 Cancel
          </Button>
          <Button
            variant="danger"
            disabled={chosen.length === 0}
            onClick={() => setStep('confirm')}
            data-testid="purge-users-continue"
          >
            清理 {chosen.length} 个 Purge {chosen.length}
          </Button>
        </>
      }
    >
      <div className="stack">
        <Notice>
          只有从未激活且没有活跃成员资格的用户会被删除；其余的内核会跳过并说明原因。成员资格仍在
          一次性工作区里的，随该工作区清除即可。 Only never-activated users with no active
          membership are deleted; the kernel skips the rest and says why. Users whose memberships
          are all in an ephemeral workspace go with that workspace's purge instead.
        </Notice>

        {candidates.state.status === 'loading' ? (
          <SkeletonRows count={4} label="Loading pending users" testId="purge-users-loading" />
        ) : candidates.state.status === 'error' ? (
          <ErrorBanner
            error={candidates.state.error}
            title="无法加载待激活用户 Could not load pending users"
            onRetry={() => void candidates.reload()}
            testId="purge-users-error"
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon="users"
            title="没有待激活用户 No pending users"
            testId="purge-users-empty"
          />
        ) : (
          <>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                data-testid="purge-users-select-all"
              />
              <span>
                全选 Select all ({Math.min(rows.length, BATCH_MAX)}
                {rows.length > BATCH_MAX ? ` / ${rows.length}` : ''})
              </span>
            </label>
            <div className="stack-s" data-testid="purge-users-candidates">
              {rows.map((row) => (
                <label className="checkbox" key={row.id} data-testid="purge-user-candidate">
                  <input
                    type="checkbox"
                    checked={selected.has(row.id)}
                    onChange={() => toggle(row.id)}
                    data-user-id={row.id}
                  />
                  <span className="stack-s">
                    <span>
                      <span className="mono">{row.login}</span> · {row.displayName}
                    </span>
                    <span className="text-3 text-small">
                      {row.memberships.length === 0
                        ? '无成员资格 no memberships'
                        : row.memberships
                            .map(
                              (membership) =>
                                `${membership.workspaceName}@${membership.role}${membership.disabled ? ' (disabled)' : ''}`,
                            )
                            .join(', ')}
                      {' · '}
                      <time title={formatDateTime(row.createdAt)}>
                        创建 created {formatRelative(row.createdAt)}
                      </time>
                    </span>
                  </span>
                </label>
              ))}
            </div>
            {nextCursor !== undefined ? (
              <div className="row" style={{ justifyContent: 'center' }}>
                <Button
                  variant="secondary"
                  size="s"
                  loading={candidates.loadingMore}
                  onClick={() => void candidates.loadMore()}
                >
                  加载更多 Load more
                </Button>
              </div>
            ) : null}
            {candidates.loadMoreError !== null ? (
              <ErrorBanner
                error={candidates.loadMoreError}
                title="无法加载更多 Could not load more"
              />
            ) : null}
          </>
        )}
      </div>
    </Drawer>
  );
}
