import type {
  CreateUserResultWire,
  PlatformSettingsWire,
  PurgeUsersResultWire,
  UserStatusWire,
  UserWire,
} from '@nexttime/shared';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import {
  invalidateCapability,
  useCapability,
  useCapabilityList,
} from '../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { breadcrumbFor } from '../../lib/nav.js';
import { ENV_ADMIN_TITLE } from '../../lib/platform-errors.js';
import { deriveWorkspaceOptions } from '../../lib/platform-workspaces.js';
import { deriveUserStatus } from '../../lib/status-tone.js';
import { DataTable, type DataTableColumn } from '../kit/data-table.js';
import { PageHeader } from '../kit/page-header.js';
import { Button } from '../ui/Button.js';
import { Drawer } from '../ui/Drawer.js';
import { EmptyState } from '../ui/EmptyState.js';
import { ErrorBanner } from '../ui/ErrorBanner.js';
import { Field, Input, Select } from '../ui/Field.js';
import { SkeletonRows } from '../ui/Skeleton.js';
import { StatusChip } from '../ui/StatusChip.js';
import { useToast } from '../ui/Toast.js';
import { CreateUserForm } from './CreateUserForm.js';
import { PurgeUsersDialog } from './PurgeUsersDialog.js';
import { TemporaryPasswordDialog } from './TemporaryPasswordDialog.js';
import { UserDetailPanel } from './UserDetailPanel.js';
import { UserMembershipsPanel } from './UserMembershipsPanel.js';

export interface PlatformUsersPageProps {
  readonly http: CapabilityCaller;
}

const PAGE_SIZE = 50;

type StatusFilter = 'all' | UserStatusWire;

/**
 * Exactly one panel is open at a time. `user`/`memberships` carry only the row's **id** — the
 * `UserWire` itself is re-derived from the live list on every render, so a mutation that answers
 * with a fresh row (or a reload after one that does not, like `add_membership`) is reflected in
 * the open drawer without a second copy of the row going stale behind it.
 */
type Panel =
  | { readonly kind: 'closed' }
  | { readonly kind: 'create' }
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'memberships'; readonly userId: string }
  | { readonly kind: 'password'; readonly login: string; readonly password: string }
  | { readonly kind: 'purgeUsers' };

/**
 * components/platform/PlatformUsersPage: 用户 Users (`/platform/users`, design doc §5/§6.1) — the
 * platform user directory and every row action on it: `list_users` (status + query filters,
 * cursor-paged), `create_user`, `update_user`, `set_user_status`, `reset_user_password`,
 * `set_user_budget`, `add_membership` / `set_membership_role` / `remove_membership`, `merge_user`.
 * Reachable only for `platformRole === 'admin'` (gated in `App.tsx`'s `Routed`); every capability
 * here is `scope: 'platform'` and ignores the workspace header, so a platform-only session (an
 * admin with zero memberships) works exactly the same.
 *
 * `get_platform_settings` is read alongside the list but never gates it: it only supplies
 * `envAdmins` (the `NEXTTIME_PLATFORM_ADMINS` logins that can be neither disabled nor demoted,
 * design §6.6), `defaultWorkspaceId` and `defaultPlatformRole` for the create dialog. A settings
 * read that fails leaves the directory fully usable.
 *
 * S6-A A6 (docs/console-completion-plan.md §5.2 "列表默认过滤", §4 "User 与 Principal"): the
 * default view sends `hideResidual: true` — the users awaiting activation whose every membership
 * is in a disabled or ephemeral workspace (or was removed) are acceptance residue, hidden until
 * the toggle shows them. The "清理待激活用户" entry (`PurgeUsersDialog`) lists the `pendingOnly`
 * candidates and hands a selection to `purge_user`; the directory is re-read afterwards.
 */
export function PlatformUsersPage({ http }: PlatformUsersPageProps) {
  const t = useT();
  const toast = useToast();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [hideResidual, setHideResidual] = useState(true);
  const [queryInput, setQueryInput] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [panel, setPanel] = useState<Panel>({ kind: 'closed' });

  // `list_users`'s `query` is `min(1)` — an empty box omits the field rather than sending `''`;
  // `hideResidual` is only ever sent as `true` (omitted = shown, the kernel's default).
  const params = useMemo(() => {
    const next: Record<string, unknown> = { limit: PAGE_SIZE };
    if (statusFilter !== 'all') next.status = statusFilter;
    if (appliedQuery !== '') next.query = appliedQuery;
    if (hideResidual) next.hideResidual = true;
    return next;
  }, [statusFilter, appliedQuery, hideResidual]);

  const users = useCapabilityList<UserWire>(http, 'list_users', params);
  const settings = useCapability<PlatformSettingsWire>(http, 'get_platform_settings');

  const rows = users.state.status === 'ready' ? users.state.data.items : [];
  const nextCursor = users.state.status === 'ready' ? users.state.data.nextCursor : undefined;
  const settingsData = settings.state.status === 'ready' ? settings.state.data : null;
  const envAdmins = settingsData?.envAdmins ?? [];
  const defaultWorkspaceId = settingsData?.defaultWorkspaceId ?? null;

  const workspaces = useMemo(
    () => deriveWorkspaceOptions(rows, defaultWorkspaceId),
    [rows, defaultWorkspaceId],
  );

  const openUserId =
    panel.kind === 'user' || panel.kind === 'memberships' ? panel.userId : undefined;
  const openUser = openUserId === undefined ? undefined : rows.find((row) => row.id === openUserId);

  // A row can disappear under an open drawer — `merge_user` deletes the source, and a re-read
  // with a narrower filter can drop it too. Close rather than render a drawer with no subject.
  // Only once the list is `ready` again: mid-read there is legitimately nothing to find.
  useEffect(() => {
    if (openUserId !== undefined && openUser === undefined && users.state.status === 'ready') {
      setPanel({ kind: 'closed' });
    }
  }, [openUserId, openUser, users.state.status]);

  /** Re-read the directory while a drawer is open — `reload()` alone keeps the cached page on
   *  screen (`refreshing: true`) so the open drawer's subject stays resolvable for the whole
   *  round trip. Used by every mutation that answers with something other than a `UserWire`
   *  (`add_membership`, `set_membership_role`, `remove_membership`). */
  function reloadList(): void {
    void users.reload();
  }

  /** Re-read the directory after a row was added or removed, dropping the cache with it so a
   *  remount cannot flash the pre-mutation page (the convention `MembersPage` established). Safe
   *  to empty `rows` for a frame here: both callers close the drawer first. */
  function refreshList(): void {
    invalidateCapability(http, 'list_users');
    void users.reload();
  }

  function replaceUser(updated: UserWire): void {
    users.mutate((data) => ({
      ...data,
      items: data.items.map((row) => (row.id === updated.id ? updated : row)),
    }));
  }

  function handleFilterSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setAppliedQuery(queryInput.trim());
  }

  function handleCreated(result: CreateUserResultWire): void {
    setPanel({
      kind: 'password',
      login: result.user.login,
      password: result.temporaryPassword,
    });
    refreshList();
  }

  /** The dialog stays open on its results view; the directory (every cached `list_users` page,
   *  the dialog's own `pendingOnly` read included) is re-read underneath it. */
  function handlePurgedUsers(result: PurgeUsersResultWire): void {
    const skipped = result.outcomes.length - result.purgedCount;
    toast.push({
      tone: result.purgedCount > 0 ? 'ok' : 'warn',
      title: `已清理 ${result.purgedCount} 个用户 Purged ${result.purgedCount} users`,
      description:
        skipped > 0 ? `${skipped} 个被跳过 skipped — 原因见对话框 see the dialog` : undefined,
      key: 'purge-users',
    });
    invalidateCapability(http, 'list_users');
    void users.reload();
  }

  return (
    <div className="page">
      <PageHeader
        breadcrumb={breadcrumbFor('platformUsers')}
        title={t('用户', 'Users')}
        description={t(
          '谁能登录、属于哪些工作区、预算多少。',
          'Who can sign in, which workspaces they belong to, and their budgets.',
        )}
        primaryAction={
          <Button variant="primary" icon="plus" onClick={() => setPanel({ kind: 'create' })}>
            {t('新建用户', 'Create user')}
          </Button>
        }
        actions={
          <Button
            variant="secondary"
            icon="users"
            onClick={() => setPanel({ kind: 'purgeUsers' })}
            data-testid="purge-users-open"
          >
            {t('清理待激活用户', 'Clean up pending users')}
          </Button>
        }
      />

      <form
        className="inline-form row-wrap"
        onSubmit={handleFilterSubmit}
        data-testid="platform-users-filter-form"
      >
        <Field id="platform-users-status" label={t('状态', 'Status')}>
          <Select
            id="platform-users-status"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
          >
            <option value="all">{t('全部', 'All')}</option>
            <option value="active">{t('活跃', 'Active')}</option>
            <option value="disabled">{t('已停用', 'Disabled')}</option>
          </Select>
        </Field>
        <Field
          id="platform-users-query"
          label={t('搜索', 'Search')}
          hint={t('登录名或显示名', 'Login or display name')}
        >
          <Input
            id="platform-users-query"
            value={queryInput}
            onChange={(event) => setQueryInput(event.target.value)}
          />
        </Field>
        <Button type="submit" variant="secondary">
          {t('应用', 'Apply')}
        </Button>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={hideResidual}
            onChange={(event) => setHideResidual(event.target.checked)}
            data-testid="platform-users-hide-residual"
          />
          <span>隐藏验收残留 Hide residual（待激活且成员资格全在已停用 / 临时工作区）</span>
        </label>
      </form>

      {users.state.status === 'loading' ? (
        <SkeletonRows count={5} label="Loading users" testId="platform-users-loading" />
      ) : users.state.status === 'error' ? (
        <ErrorBanner
          error={users.state.error}
          title="Could not load the user directory"
          onRetry={() => void users.reload()}
          testId="platform-users-error"
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="users"
          title={t('没有匹配的用户', 'No matching users')}
          testId="platform-users-empty"
        />
      ) : (
        <DataTable
          columns={userColumns(envAdmins, (userId) => setPanel({ kind: 'user', userId }), t)}
          data={rows}
          getRowId={(row) => row.id}
          ariaLabel="Users"
          testId="platform-users-table"
          rowTestId={() => 'platform-user-row'}
          rowDataAttrs={(row) => ({ 'data-login': row.login })}
        />
      )}

      {users.state.status === 'ready' && nextCursor !== undefined ? (
        <div className="row" style={{ justifyContent: 'center' }}>
          <Button
            variant="secondary"
            loading={users.loadingMore}
            onClick={() => void users.loadMore()}
          >
            {t('加载更多', 'Load more')}
          </Button>
        </div>
      ) : null}
      {users.loadMoreError !== null ? (
        <ErrorBanner
          error={users.loadMoreError}
          title="Could not load more users"
          testId="platform-users-load-more-error"
        />
      ) : null}

      <Drawer
        open={panel.kind === 'create'}
        onClose={() => setPanel({ kind: 'closed' })}
        title={t('新建用户', 'Create user')}
        subtitle="A temporary password is generated and shown once."
        testId="create-user-drawer"
      >
        {panel.kind === 'create' ? (
          <CreateUserForm
            http={http}
            workspaces={workspaces}
            defaultWorkspaceId={defaultWorkspaceId}
            defaultPlatformRole={settingsData?.defaultPlatformRole ?? 'user'}
            onCreated={handleCreated}
            onCancel={() => setPanel({ kind: 'closed' })}
          />
        ) : null}
      </Drawer>

      <Drawer
        open={panel.kind === 'user' && openUser !== undefined}
        onClose={() => setPanel({ kind: 'closed' })}
        title={openUser?.displayName ?? t('用户', 'User')}
        subtitle={openUser ? <span className="mono">{openUser.login}</span> : undefined}
        testId="user-drawer"
      >
        {panel.kind === 'user' && openUser ? (
          <UserDetailPanel
            key={openUser.id}
            http={http}
            user={openUser}
            users={rows}
            envAdmins={envAdmins}
            onChanged={replaceUser}
            onMerged={() => {
              setPanel({ kind: 'closed' });
              refreshList();
            }}
            onTemporaryPassword={(login, password) =>
              setPanel({ kind: 'password', login, password })
            }
            onOpenMemberships={() => setPanel({ kind: 'memberships', userId: openUser.id })}
          />
        ) : null}
      </Drawer>

      <Drawer
        open={panel.kind === 'memberships' && openUser !== undefined}
        onClose={() => setPanel({ kind: 'closed' })}
        title={t('成员资格', 'Memberships')}
        subtitle={openUser ? <span className="mono">{openUser.login}</span> : undefined}
        testId="user-memberships-drawer"
      >
        {panel.kind === 'memberships' && openUser ? (
          <UserMembershipsPanel
            key={openUser.id}
            http={http}
            user={openUser}
            workspaces={workspaces}
            onChanged={reloadList}
            onBack={() => setPanel({ kind: 'user', userId: openUser.id })}
          />
        ) : null}
      </Drawer>

      {panel.kind === 'password' ? (
        <TemporaryPasswordDialog
          login={panel.login}
          password={panel.password}
          onClose={() => setPanel({ kind: 'closed' })}
        />
      ) : null}

      {panel.kind === 'purgeUsers' ? (
        <PurgeUsersDialog
          http={http}
          onClose={() => setPanel({ kind: 'closed' })}
          onPurged={handlePurgedUsers}
        />
      ) : null}
    </div>
  );
}

/**
 * S8 W1-A4 (audit S3): column definitions for the responsive `DataTable` — `displayName` is the
 * card title (`primary`), `status` and the 管理 Manage action stay always-visible next to it
 * (`high`), everything else becomes a label/value pair at ≤ 768px. `envAdmins`/`onOpen` are
 * closed over per render rather than module-level state, matching the row callbacks the original
 * `<table>` markup captured the same way.
 */
function userColumns(
  envAdmins: readonly string[],
  onOpen: (userId: string) => void,
  t: Translate,
): readonly DataTableColumn<UserWire>[] {
  return [
    {
      id: 'displayName',
      header: t('显示名', 'Display name'),
      priority: 'primary',
      cell: (user) => (
        <>
          <span className="truncate">{user.displayName}</span>
          {envAdmins.includes(user.login) ? (
            <span className="tag" title={ENV_ADMIN_TITLE} data-testid="platform-user-env-admin">
              env
            </span>
          ) : null}
        </>
      ),
    },
    {
      id: 'login',
      header: t('登录名', 'Login'),
      priority: 'high',
      cellClassName: 'mono',
      cell: (user) => user.login,
    },
    {
      id: 'status',
      header: t('状态', 'Status'),
      priority: 'high',
      cell: (user) => (
        // `status` first (an explicitly disabled account is disabled whatever else is true of
        // it), then `hasPassword: false` — the "待激活" state a backfilled or password-less user
        // sits in (`wire/platform.ts` `UserWireSchema`). `待激活` is a *derived* display value,
        // never a filter value: `list_users`'s own `status` param is only `active | disabled`.
        // S6-A0 (C17): the derivation lives in `lib/status-tone.ts` (`deriveUserStatus`) and
        // renders through the shared `StatusChip` — one colour vocabulary with every other status
        // in the console.
        <StatusChip
          machine="userStatus"
          status={deriveUserStatus(user)}
          size="s"
          testId="platform-user-status"
        />
      ),
    },
    {
      id: 'actions',
      header: '',
      priority: 'high',
      hideInCard: true,
      cell: (user) => (
        <Button variant="ghost" size="s" onClick={() => onOpen(user.id)}>
          {t('管理', 'Manage')}
        </Button>
      ),
    },
    {
      id: 'platformRole',
      header: '平台角色 Role',
      cell: (user) => user.platformRole,
    },
    {
      id: 'workspaces',
      header: '工作区 Workspaces',
      cell: (user) => (
        <div className="row-wrap">
          {user.memberships.length === 0 ? (
            <span className="text-3">—</span>
          ) : (
            user.memberships.map((membership) => (
              <span
                key={membership.workspaceId}
                className={`chip chip-s ${membership.disabled ? 'chip-neutral' : 'chip-info'}`}
                title={membership.disabled ? '成员资格已停用 Membership disabled' : undefined}
                data-testid="platform-user-workspace-chip"
              >
                {membership.workspaceName}@{membership.role}
              </span>
            ))
          )}
        </div>
      ),
    },
    {
      id: 'budget',
      header: '预算 Budget',
      cellClassName: 'mono',
      cell: (user) => (
        <>
          {user.dailyCallLimit === null ? '默认 default' : user.dailyCallLimit} /{' '}
          {user.monthlyTokenBudget === null ? '默认 default' : user.monthlyTokenBudget}
        </>
      ),
    },
    {
      id: 'lastLogin',
      header: '最近登录 Last login',
      cell: (user) =>
        user.lastLoginAt === null ? (
          <span className="text-3">从未 Never</span>
        ) : (
          <time title={formatDateTime(user.lastLoginAt)}>{formatRelative(user.lastLoginAt)}</time>
        ),
    },
    {
      id: 'created',
      header: '创建 Created',
      cell: (user) => (
        <time title={formatDateTime(user.createdAt)}>{formatRelative(user.createdAt)}</time>
      ),
    },
  ];
}
