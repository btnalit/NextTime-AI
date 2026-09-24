import { useState } from 'react';
import { invalidateCapability, useCapabilityList } from '../hooks/useCapability.js';
import { usePermissions } from '../hooks/usePermissions.js';
import { useWorkspaceIdentity } from '../hooks/useWorkspaceIdentity.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { isForbiddenError } from '../lib/errors.js';
import { formatDateTime, formatRelative } from '../lib/format.js';
import { type PrincipalRow, principalDisplayRole } from '../lib/governance.js';
import { useT } from '../lib/i18n.js';
import { principalKindLabel } from '../lib/labels.js';
import { breadcrumbFor } from '../lib/nav.js';
import { AddMemberForm } from './AddMemberForm.js';
import { CreatePrincipalForm } from './CreatePrincipalForm.js';
import { PrincipalDetail } from './PrincipalDetail.js';
import { PageHeader } from './kit/page-header.js';
import { Button } from './ui/Button.js';
import { DataList, DataRow } from './ui/DataList.js';
import { Drawer } from './ui/Drawer.js';
import { EmptyState } from './ui/EmptyState.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Icon } from './ui/Icon.js';
import { SkeletonRows } from './ui/Skeleton.js';
import { StatusChip } from './ui/StatusChip.js';
import { useToast } from './ui/Toast.js';

export interface MembersPageProps {
  readonly http: CapabilityCaller;
}

type DrawerState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'addMember' }
  | { readonly kind: 'create' }
  | { readonly kind: 'detail'; readonly principal: PrincipalRow };

/**
 * components/MembersPage: 成员与授权 Members (`/govern/members`, S3.11) — `list_principals`,
 * `add_member`, `create_principal`, `set_principal_role`, `rotate_api_key`, `disable_principal`.
 * All owner-only per the design doc's own minRole table ("成员/授权/策略 = owner"), except
 * `rotate_api_key` ("owner 或本人" — a non-owner rotating their own key would need a `principalId`
 * they cannot discover from this page anyway, since a member never sees `/govern/*` once role is
 * proven — see `Sidebar`), so this page's write affordances hide behind a single `canManage`
 * flag. C9 (console-completion-plan §2b): that flag reads the *authoritative* role first —
 * `get_workspace.caller.role` via `useWorkspaceIdentity`, owner only, the same read the Sidebar
 * badge already makes — and falls back to the 403 inference only while that read is not ready.
 * The inference alone never hid these buttons from an operator: `list_principals` is
 * operator-readable, so an operator's session never learned a denial and could click straight
 * into a guaranteed 403.
 *
 * P-A1 splits the two things "add a member" used to mean (design doc §5): a **person** joins by
 * their platform login (`add_member` — a membership Principal with no API key, they sign in with
 * the password their platform account already has), and a **service credential** (`create_principal`
 * — a `kind: 'service'` Principal and its one-time API key, for scripts and acceptance harnesses).
 * `canManage` still keys off `create_principal`: both writes are owner-only and the kernel denies
 * them together.
 */
export function MembersPage({ http }: MembersPageProps) {
  const t = useT();
  const permissions = usePermissions();
  const toast = useToast();
  const { role } = useWorkspaceIdentity(http);
  const principals = useCapabilityList<PrincipalRow>(http, 'list_principals');
  const [drawer, setDrawer] = useState<DrawerState>({ kind: 'closed' });

  const canManage =
    role.kind === 'known' ? role.role === 'owner' : !permissions.isDenied('create_principal');

  function refreshList(): void {
    invalidateCapability(http, 'list_principals');
    void principals.reload();
  }

  function handlePrincipalChanged(updated: PrincipalRow): void {
    principals.mutate((data) => ({
      ...data,
      items: data.items.map((row) => (row.id === updated.id ? updated : row)),
    }));
    setDrawer({ kind: 'detail', principal: updated });
  }

  const rows = principals.state.status === 'ready' ? principals.state.data.items : [];
  const forbidden = principals.state.status === 'error' && isForbiddenError(principals.state.error);

  return (
    <div className="page">
      <PageHeader
        breadcrumb={breadcrumbFor('members')}
        title={t('成员与授权', 'Members')}
        description={t(
          '谁能进入这个工作区、持有什么角色、API key 的生命周期。',
          'Who can sign in, what role they hold, and their API key lifecycle.',
        )}
        actions={
          canManage ? (
            <>
              <Button
                variant="primary"
                icon="plus"
                onClick={() => setDrawer({ kind: 'addMember' })}
              >
                {t('添加成员', 'Add member')}
              </Button>
              <Button variant="secondary" icon="key" onClick={() => setDrawer({ kind: 'create' })}>
                {t('服务凭证', 'Service credential (API key)')}
              </Button>
            </>
          ) : undefined
        }
      />

      {principals.state.status === 'loading' ? (
        <SkeletonRows count={4} label="Loading members" testId="members-loading" />
      ) : principals.state.status === 'error' ? (
        forbidden ? (
          <EmptyState
            icon="shield"
            title={t('需要 owner 权限', 'Owner role required')}
            body={t(
              'list_principals 仅工作区 owner 可读。',
              'list_principals is restricted to the workspace owner.',
            )}
            testId="members-forbidden"
          />
        ) : (
          <ErrorBanner
            error={principals.state.error}
            title={t('无法加载成员', 'Could not load members')}
            onRetry={() => void principals.reload()}
            testId="members-error"
          />
        )
      ) : rows.length === 0 ? (
        <EmptyState
          icon="users"
          title={t('还没有成员', 'No members yet')}
          body={t(
            '先添加一个成员，或创建一个服务凭证。',
            'Add the first member, or create a service credential.',
          )}
          testId="members-empty"
        />
      ) : (
        <DataList ariaLabel="Members" testId="members-list">
          {rows.map((row) => (
            <DataRow
              key={row.id}
              testId="member-row"
              onSelect={() => setDrawer({ kind: 'detail', principal: row })}
              leading={<StatusChip machine="role" status={row.role} size="s" />}
              title={
                <>
                  <span className="truncate">{row.displayName}</span>
                  {row.kind !== 'human' ? (
                    <span className="tag">{principalKindLabel(row.kind, t)}</span>
                  ) : null}
                  {row.disabledAt ? (
                    <span className="tag text-danger">{t('已停用', 'disabled')}</span>
                  ) : null}
                </>
              }
              meta={
                <>
                  <span className="mono">{principalDisplayRole(row, t)}</span>
                  <span className="meta-sep" />
                  <time title={formatDateTime(row.createdAt)}>{formatRelative(row.createdAt)}</time>
                  {row.hasApiKey ? (
                    <>
                      <span className="meta-sep" />
                      <span>{t('已签发', 'API key issued')}</span>
                    </>
                  ) : null}
                </>
              }
              trailing={<Icon name="chevron-right" />}
            />
          ))}
        </DataList>
      )}
      {principals.state.status === 'ready' && principals.state.data.nextCursor !== undefined ? (
        <div className="row" style={{ justifyContent: 'center' }}>
          <Button
            variant="secondary"
            loading={principals.loadingMore}
            onClick={() => void principals.loadMore()}
          >
            {t('加载更多', 'Load more')}
          </Button>
        </div>
      ) : null}
      {principals.state.status === 'ready' && principals.state.data.truncated === true ? (
        <p className="text-3 text-small" data-testid="members-truncated">
          {t(
            '已达到单次读取上限 Reached the per-page limit — 继续点“加载更多”查看其余成员',
            'keep loading more to see the rest.',
          )}
        </p>
      ) : null}
      {principals.loadMoreError !== null ? (
        <ErrorBanner
          error={principals.loadMoreError}
          title="Could not load more members"
          testId="members-load-more-error"
        />
      ) : null}

      <Drawer
        open={drawer.kind === 'addMember'}
        onClose={() => setDrawer({ kind: 'closed' })}
        title={t('添加成员', 'Add member')}
        subtitle={t(
          '按平台登录名添加；这里不创建账户、不签发 API key。 By platform login —',
          'no account is created here and no API key is issued.',
        )}
        testId="add-member-drawer"
      >
        {drawer.kind === 'addMember' ? (
          <AddMemberForm
            http={http}
            onCancel={() => setDrawer({ kind: 'closed' })}
            onDone={(principal) => {
              setDrawer({ kind: 'closed' });
              toast.push({ tone: 'ok', title: `已添加 ${principal.displayName} added` });
              refreshList();
            }}
          />
        ) : null}
      </Drawer>

      <Drawer
        open={drawer.kind === 'create'}
        onClose={() => setDrawer({ kind: 'closed' })}
        title={t('服务凭证', 'Service credential (API key)')}
        subtitle={t(
          "创建 kind: 'service' 的 Principal 及其 API key——给脚本与验收工具，不给人。 Creates a kind: 'service' Principal and its API key —",
          'for scripts and harnesses, never for a person.',
        )}
        testId="create-principal-drawer"
      >
        {drawer.kind === 'create' ? (
          <CreatePrincipalForm
            http={http}
            onCancel={() => setDrawer({ kind: 'closed' })}
            onDone={(principal) => {
              setDrawer({ kind: 'closed' });
              toast.push({ tone: 'ok', title: `已创建 ${principal.displayName} created` });
              refreshList();
            }}
          />
        ) : null}
      </Drawer>

      <Drawer
        open={drawer.kind === 'detail'}
        onClose={() => setDrawer({ kind: 'closed' })}
        title={drawer.kind === 'detail' ? drawer.principal.displayName : t('成员', 'Member')}
        subtitle={
          drawer.kind === 'detail' ? <span className="mono">{drawer.principal.id}</span> : undefined
        }
        testId="principal-drawer"
      >
        {drawer.kind === 'detail' ? (
          <PrincipalDetail
            key={drawer.principal.id}
            http={http}
            principal={drawer.principal}
            canManage={canManage}
            onChanged={handlePrincipalChanged}
            onForbidden={permissions.markDenied}
          />
        ) : null}
      </Drawer>
    </div>
  );
}
