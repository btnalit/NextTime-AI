import { useState } from 'react';
import { invalidateCapability, useCapabilityList } from '../hooks/useCapability.js';
import { usePermissions } from '../hooks/usePermissions.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { isForbiddenError, isNotFoundError } from '../lib/errors.js';
import { formatDateTime, formatRelative } from '../lib/format.js';
import { type PrincipalRow, principalDisplayRole } from '../lib/governance.js';
import { AddMemberForm } from './AddMemberForm.js';
import { CreatePrincipalForm } from './CreatePrincipalForm.js';
import { PrincipalDetail } from './PrincipalDetail.js';
import { Button } from './ui/Button.js';
import { DataList, DataRow } from './ui/DataList.js';
import { Drawer } from './ui/Drawer.js';
import { EmptyState } from './ui/EmptyState.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Icon } from './ui/Icon.js';
import { PageHeader } from './ui/PageHeader.js';
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
 * 403-derived flag.
 *
 * P-A1 splits the two things "add a member" used to mean (design doc §5): a **person** joins by
 * their platform login (`add_member` — a membership Principal with no API key, they sign in with
 * the password their platform account already has), and a **service credential** (`create_principal`
 * — a `kind: 'service'` Principal and its one-time API key, for scripts and acceptance harnesses).
 * `canManage` still keys off `create_principal`: both writes are owner-only and the kernel denies
 * them together.
 */
export function MembersPage({ http }: MembersPageProps) {
  const permissions = usePermissions();
  const toast = useToast();
  const principals = useCapabilityList<PrincipalRow>(http, 'list_principals');
  const [drawer, setDrawer] = useState<DrawerState>({ kind: 'closed' });

  const canManage = !permissions.isDenied('create_principal');

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
  const unavailable =
    principals.state.status === 'error' && isNotFoundError(principals.state.error);

  return (
    <div className="page">
      <PageHeader
        title="成员与授权 Members"
        description="Who can sign in, what role they hold, and their API key lifecycle."
        actions={
          canManage ? (
            <>
              <Button
                variant="primary"
                icon="plus"
                onClick={() => setDrawer({ kind: 'addMember' })}
              >
                添加成员 Add member
              </Button>
              <Button variant="secondary" icon="key" onClick={() => setDrawer({ kind: 'create' })}>
                服务凭证 Service credential (API key)
              </Button>
            </>
          ) : undefined
        }
      />

      {principals.state.status === 'loading' ? (
        <SkeletonRows count={4} label="Loading members" testId="members-loading" />
      ) : principals.state.status === 'error' ? (
        unavailable ? (
          <EmptyState
            icon="users"
            title="该能力尚未上线 Not live yet"
            body="list_principals is part of S3.11, still landing on the kernel side."
            testId="members-unavailable"
          />
        ) : forbidden ? (
          <EmptyState
            icon="shield"
            title="需要 owner 权限"
            body="list_principals is restricted to the workspace owner."
            testId="members-forbidden"
          />
        ) : (
          <ErrorBanner
            error={principals.state.error}
            title="Could not load members"
            onRetry={() => void principals.reload()}
            testId="members-error"
          />
        )
      ) : rows.length === 0 ? (
        <EmptyState
          icon="users"
          title="No members yet"
          body="Create the first member to hand out an API key."
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
                  {row.kind !== 'human' ? <span className="tag">{row.kind}</span> : null}
                  {row.disabledAt ? <span className="tag text-danger">disabled</span> : null}
                </>
              }
              meta={
                <>
                  <span className="mono">{principalDisplayRole(row)}</span>
                  <span className="meta-sep" />
                  <time title={formatDateTime(row.createdAt)}>{formatRelative(row.createdAt)}</time>
                  {row.hasApiKey ? (
                    <>
                      <span className="meta-sep" />
                      <span>API key issued</span>
                    </>
                  ) : null}
                </>
              }
              trailing={<Icon name="chevron-right" />}
            />
          ))}
        </DataList>
      )}

      <Drawer
        open={drawer.kind === 'addMember'}
        onClose={() => setDrawer({ kind: 'closed' })}
        title="添加成员 Add member"
        subtitle="By platform login — no account is created here and no API key is issued."
        testId="add-member-drawer"
      >
        {drawer.kind === 'addMember' ? (
          <AddMemberForm
            http={http}
            onCancel={() => setDrawer({ kind: 'closed' })}
            onDone={(principal) => {
              setDrawer({ kind: 'closed' });
              toast.push({ tone: 'ok', title: `${principal.displayName} added` });
              refreshList();
            }}
          />
        ) : null}
      </Drawer>

      <Drawer
        open={drawer.kind === 'create'}
        onClose={() => setDrawer({ kind: 'closed' })}
        title="服务凭证 Service credential (API key)"
        subtitle="Creates a kind: 'service' Principal and its API key — for scripts and harnesses, never for a person."
        testId="create-principal-drawer"
      >
        {drawer.kind === 'create' ? (
          <CreatePrincipalForm
            http={http}
            onCancel={() => setDrawer({ kind: 'closed' })}
            onDone={(principal) => {
              setDrawer({ kind: 'closed' });
              toast.push({ tone: 'ok', title: `${principal.displayName} created` });
              refreshList();
            }}
          />
        ) : null}
      </Drawer>

      <Drawer
        open={drawer.kind === 'detail'}
        onClose={() => setDrawer({ kind: 'closed' })}
        title={drawer.kind === 'detail' ? drawer.principal.displayName : 'Member'}
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
