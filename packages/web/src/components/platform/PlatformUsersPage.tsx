import type {
  CreateUserResultWire,
  PlatformSettingsWire,
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
import { ENV_ADMIN_TITLE } from '../../lib/platform-errors.js';
import { deriveWorkspaceOptions } from '../../lib/platform-workspaces.js';
import { Button } from '../ui/Button.js';
import { Drawer } from '../ui/Drawer.js';
import { EmptyState } from '../ui/EmptyState.js';
import { ErrorBanner } from '../ui/ErrorBanner.js';
import { Field, Input, Select } from '../ui/Field.js';
import { PageHeader } from '../ui/PageHeader.js';
import { SkeletonRows } from '../ui/Skeleton.js';
import { CreateUserForm } from './CreateUserForm.js';
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
  | { readonly kind: 'password'; readonly login: string; readonly password: string };

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
 */
export function PlatformUsersPage({ http }: PlatformUsersPageProps) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [queryInput, setQueryInput] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [panel, setPanel] = useState<Panel>({ kind: 'closed' });

  // `list_users`'s `query` is `min(1)` — an empty box omits the field rather than sending `''`.
  const params = useMemo(() => {
    const next: Record<string, unknown> = { limit: PAGE_SIZE };
    if (statusFilter !== 'all') next.status = statusFilter;
    if (appliedQuery !== '') next.query = appliedQuery;
    return next;
  }, [statusFilter, appliedQuery]);

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

  return (
    <div className="page">
      <PageHeader
        title="用户 Users"
        description="Who can sign in, which workspaces they belong to, and their budgets."
        actions={
          <Button variant="primary" icon="plus" onClick={() => setPanel({ kind: 'create' })}>
            新建用户 Create user
          </Button>
        }
      />

      <form
        className="inline-form row-wrap"
        onSubmit={handleFilterSubmit}
        data-testid="platform-users-filter-form"
      >
        <Field id="platform-users-status" label="状态 Status">
          <Select
            id="platform-users-status"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
          >
            <option value="all">全部 All</option>
            <option value="active">active</option>
            <option value="disabled">disabled</option>
          </Select>
        </Field>
        <Field
          id="platform-users-query"
          label="搜索 Search"
          hint="登录名或显示名 Login or display name"
        >
          <Input
            id="platform-users-query"
            value={queryInput}
            onChange={(event) => setQueryInput(event.target.value)}
          />
        </Field>
        <Button type="submit" variant="secondary">
          应用 Apply
        </Button>
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
          title="没有匹配的用户 No matching users"
          testId="platform-users-empty"
        />
      ) : (
        <div className="table-scroll">
          <table className="data-table" data-testid="platform-users-table">
            <thead>
              <tr>
                <th>登录名 Login</th>
                <th>显示名 Display name</th>
                <th>平台角色 Role</th>
                <th>状态 Status</th>
                <th>工作区 Workspaces</th>
                <th>预算 Budget</th>
                <th>最近登录 Last login</th>
                <th>创建 Created</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <UserRow
                  key={row.id}
                  user={row}
                  protectedAdmin={envAdmins.includes(row.login)}
                  onOpen={() => setPanel({ kind: 'user', userId: row.id })}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {users.state.status === 'ready' && nextCursor !== undefined ? (
        <div className="row" style={{ justifyContent: 'center' }}>
          <Button
            variant="secondary"
            loading={users.loadingMore}
            onClick={() => void users.loadMore()}
          >
            加载更多 Load more
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
        title="新建用户 Create user"
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
        title={openUser?.displayName ?? '用户 User'}
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
        title="成员资格 Memberships"
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
    </div>
  );
}

function UserRow({
  user,
  protectedAdmin,
  onOpen,
}: {
  readonly user: UserWire;
  readonly protectedAdmin: boolean;
  readonly onOpen: () => void;
}) {
  return (
    <tr data-testid="platform-user-row" data-login={user.login}>
      <td className="mono">{user.login}</td>
      <td>
        <span className="truncate">{user.displayName}</span>
        {protectedAdmin ? (
          <span className="tag" title={ENV_ADMIN_TITLE} data-testid="platform-user-env-admin">
            env
          </span>
        ) : null}
      </td>
      <td>{user.platformRole}</td>
      <td>
        <UserStatusCell user={user} />
      </td>
      <td>
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
      </td>
      <td className="mono">
        {user.dailyCallLimit === null ? '默认 default' : user.dailyCallLimit} /{' '}
        {user.monthlyTokenBudget === null ? '默认 default' : user.monthlyTokenBudget}
      </td>
      <td>
        {user.lastLoginAt === null ? (
          <span className="text-3">从未 Never</span>
        ) : (
          <time title={formatDateTime(user.lastLoginAt)}>{formatRelative(user.lastLoginAt)}</time>
        )}
      </td>
      <td>
        <time title={formatDateTime(user.createdAt)}>{formatRelative(user.createdAt)}</time>
      </td>
      <td>
        <Button variant="ghost" size="s" onClick={onOpen}>
          管理 Manage
        </Button>
      </td>
    </tr>
  );
}

/** `status` first (an explicitly disabled account is disabled whatever else is true of it), then
 *  `hasPassword: false` — the "待激活" state a backfilled or password-less user sits in
 *  (`wire/platform.ts` `UserWireSchema`). `待激活` is a *derived* display value, never a filter
 *  value: `list_users`'s own `status` param is only `active | disabled`. */
function UserStatusCell({ user }: { readonly user: UserWire }) {
  if (user.status === 'disabled') {
    return (
      <span className="chip chip-s chip-neutral" data-testid="platform-user-status">
        disabled
      </span>
    );
  }
  if (!user.hasPassword) {
    return (
      <span className="chip chip-s chip-warn" data-testid="platform-user-status">
        待激活 Pending activation
      </span>
    );
  }
  return (
    <span className="chip chip-s chip-ok" data-testid="platform-user-status">
      active
    </span>
  );
}
