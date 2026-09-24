import { useState } from 'react';
import { invalidateCapability, useCapabilityList } from '../hooks/useCapability.js';
import { usePermissions } from '../hooks/usePermissions.js';
import { useWorkspaceIdentity } from '../hooks/useWorkspaceIdentity.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { isForbiddenError } from '../lib/errors.js';
import { formatDateTime, formatRelative, prettyJson } from '../lib/format.js';
import type { GatekeeperListRow, GrantRow, PrincipalRow } from '../lib/governance.js';
import { useT } from '../lib/i18n.js';
import { breadcrumbFor } from '../lib/nav.js';
import { hrefs } from '../lib/router.js';
import { GrantCapabilityForm } from './GrantCapabilityForm.js';
import { IssueServiceHandleSection } from './IssueServiceHandleSection.js';
import { PageHeader } from './kit/page-header.js';
import { Button } from './ui/Button.js';
import { DataList, DataRow } from './ui/DataList.js';
import { Drawer } from './ui/Drawer.js';
import { EmptyState } from './ui/EmptyState.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Field, Input } from './ui/Field.js';
import { RefChip, useRefNames } from './ui/RefChip.js';
import { SkeletonRows } from './ui/Skeleton.js';
import { StatusChip } from './ui/StatusChip.js';
import { useToast } from './ui/Toast.js';

export interface AccessPageProps {
  readonly http: CapabilityCaller;
}

/**
 * components/AccessPage: 访问 Access (`/govern/access`, S3.11) — the CapabilityGrant matrix.
 * `list_grants{principalId?}` / `grant_capability` (existing) / `revoke_capability` (existing).
 * All owner-only per the design doc's minRole table ("成员/授权/策略 = owner") — this page's write
 * affordances (Grant / Revoke / issue a service Handle) hide behind the same `canManage` rule
 * `MembersPage` uses: the authoritative `get_workspace.caller.role` (owner only) once it is
 * known, the `grant_capability` 403 inference only as fallback (C9 — `list_grants` is
 * operator-readable, so an operator never learned that denial and saw owner-only buttons).
 *
 * B3 (§5.8 "id → 名称"): the grant's principal, its grantor and a `gatekeeper` resource render as
 * `RefChip`s named from `list_principals` (already read for the filter / form) and
 * `list_gatekeepers` (member-readable, read here for the names alone); a missing name degrades to
 * the grey bare-id chip. S8 W1-C (#243) made `list_grants` and `list_principals` keyset-paginated
 * (B5 no longer holds — this comment said "both stay single-page" until S8 W1-A4). `grants` offers
 * "加载更多" below the list; `principalsList` feeds the filter's `<datalist>` and
 * `IssueServiceHandleSection`'s picker, so it auto-loads every page instead (a missing suggestion
 * past page one is a correctness bug, not a paging UX choice).
 */
export function AccessPage({ http }: AccessPageProps) {
  const t = useT();
  const permissions = usePermissions();
  const toast = useToast();
  const { role } = useWorkspaceIdentity(http);
  // C20: `principalFilter` is what the input shows; `committedFilter` is what `list_grants` is
  // asked for. They diverge only while an id is being typed — committed on blur / Enter, or at
  // once when the text matches a member from the directory — so a half-typed id never fires a
  // query per keystroke (each one a `list_grants{principalId}` that flashes "No grants yet").
  const [principalFilter, setPrincipalFilter] = useState('');
  const [committedFilter, setCommittedFilter] = useState('');
  const [grantOpen, setGrantOpen] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<unknown | null>(null);

  const principalsList = useCapabilityList<PrincipalRow>(
    http,
    'list_principals',
    {},
    { autoLoadAll: true },
  );
  const principals = principalsList.state.status === 'ready' ? principalsList.state.data.items : [];
  const gatekeepersList = useCapabilityList<GatekeeperListRow>(http, 'list_gatekeepers');
  const principalNames = useRefNames(
    principalsList.state.status === 'ready' ? principalsList.state.data : undefined,
  );
  const gatekeeperNames = useRefNames(
    gatekeepersList.state.status === 'ready' ? gatekeepersList.state.data : undefined,
  );

  const grants = useCapabilityList<GrantRow>(
    http,
    'list_grants',
    committedFilter ? { principalId: committedFilter } : {},
  );

  function commitFilter(value: string = principalFilter): void {
    setCommittedFilter(value.trim());
  }

  function handleFilterChange(value: string): void {
    setPrincipalFilter(value);
    // An exact directory match (a picked suggestion, or a pasted id) and an emptied field both
    // apply immediately — nothing more will be typed for them.
    if (value === '' || principals.some((row) => row.id === value)) commitFilter(value);
  }

  const canManage =
    role.kind === 'known' ? role.role === 'owner' : !permissions.isDenied('grant_capability');

  function refreshGrants(): void {
    invalidateCapability(http, 'list_grants');
    void grants.reload();
  }

  async function handleRevoke(grantId: string): Promise<void> {
    setRevoking(grantId);
    setRevokeError(null);
    try {
      await http.call('revoke_capability', { grantId });
      grants.mutate((data) => ({
        ...data,
        items: data.items.map((row) =>
          row.id === grantId ? { ...row, status: 'revoked' as const } : row,
        ),
      }));
      toast.push({ tone: 'info', title: t('已撤销授权', 'Grant revoked') });
    } catch (err) {
      if (isForbiddenError(err)) permissions.markDenied('revoke_capability');
      setRevokeError(err);
    } finally {
      setRevoking(null);
    }
  }

  const rows = grants.state.status === 'ready' ? grants.state.data.items : [];
  const forbidden = grants.state.status === 'error' && isForbiddenError(grants.state.error);

  return (
    <div className="page">
      <PageHeader
        breadcrumb={breadcrumbFor('access')}
        title={t('访问', 'Access')}
        description={t(
          '哪个主体持有哪项能力、作用于哪个资源。',
          'Which Principal holds which capability, over which resource.',
        )}
        actions={
          canManage ? (
            <Button variant="primary" icon="plus" onClick={() => setGrantOpen(true)}>
              {t('授予能力', 'Grant capability')}
            </Button>
          ) : undefined
        }
      />

      <div className="page-toolbar">
        {/* C20: one control from first paint — an id input with the member directory as a
            `<datalist>` once `list_principals` lands — rather than an `<Input>` that turned into
            a `<Select>` mid-typing and dropped whatever had been typed. Picking a suggestion
            fills (and commits) the id; an empty value is "all members". */}
        <Field
          id="access-principal-filter"
          label={t('按主体筛选', 'Filter by principal')}
          hint={
            principals.length > 0
              ? t(
                  '从建议里选一个成员，或输入 principal id 后按 Enter；留空 = 全部成员。 Pick a member from the suggestions, or type a principal id and press Enter. Empty =',
                  'all members.',
                )
              : t(
                  'Principal id（可选），按 Enter 应用；留空 = 全部成员。 Principal id (optional) — press Enter to apply. Empty =',
                  'all members.',
                )
          }
        >
          <Input
            id="access-principal-filter"
            value={principalFilter}
            onChange={(event) => handleFilterChange(event.target.value)}
            onBlur={() => commitFilter()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitFilter();
              }
            }}
            placeholder={t('全部成员', 'All members')}
            list="access-principal-suggestions"
            mono
          />
          <datalist id="access-principal-suggestions">
            {principals.map((row) => (
              <option key={row.id} value={row.id}>
                {row.displayName}
              </option>
            ))}
          </datalist>
        </Field>
      </div>

      {revokeError !== null ? (
        <ErrorBanner error={revokeError} title={t('无法撤销授权', 'Could not revoke this grant')} />
      ) : null}

      {grants.state.status === 'loading' ? (
        <SkeletonRows count={4} label="Loading grants" testId="grants-loading" />
      ) : grants.state.status === 'error' ? (
        forbidden ? (
          <EmptyState
            icon="shield"
            title={t('需要 owner 权限', 'Owner role required')}
            body={t(
              'list_grants 仅工作区 owner 可读。',
              'list_grants is restricted to the workspace owner.',
            )}
            testId="grants-forbidden"
          />
        ) : (
          <ErrorBanner
            error={grants.state.error}
            title={t('无法加载授权', 'Could not load grants')}
            onRetry={() => void grants.reload()}
            testId="grants-error"
          />
        )
      ) : rows.length === 0 ? (
        <EmptyState
          icon="key"
          title={t('还没有授权', 'No grants yet')}
          body={t(
            '把一个门（或其他资源）授予成员，他的入口 agent 才能使用它。',
            'Grant a Gatekeeper (or another resource) to a member so their entry agent can use it.',
          )}
          testId="grants-empty"
        />
      ) : (
        <DataList ariaLabel="Grants" testId="grants-list">
          {rows.map((row) => (
            <DataRow
              key={row.id}
              testId="grant-row"
              leading={<StatusChip machine="grant" status={row.status} size="s" />}
              title={
                <>
                  <span className="tag">{row.resourceType}</span>
                  {row.resourceId === null || row.resourceId === undefined ? (
                    <span className="text-3">{t('任意', 'any')}</span>
                  ) : row.resourceType === 'gatekeeper' ? (
                    <RefChip
                      kind="gatekeeper"
                      id={row.resourceId}
                      name={gatekeeperNames.get(row.resourceId)}
                      href={hrefs.gatekeeper(row.resourceId)}
                      size="s"
                      testId="grant-resource"
                    />
                  ) : (
                    <span className="mono truncate" data-testid="grant-resource">
                      {row.resourceId}
                    </span>
                  )}
                </>
              }
              meta={
                <>
                  <RefChip
                    kind="principal"
                    id={row.principalId}
                    name={principalNames.get(row.principalId)}
                    size="s"
                    testId="grant-principal"
                  />
                  <span className="meta-sep" />
                  <span>{t('授予者', 'by')}</span>
                  <RefChip
                    kind="principal"
                    id={row.grantedBy}
                    name={principalNames.get(row.grantedBy)}
                    size="s"
                    testId="grant-granted-by"
                  />
                  <span className="meta-sep" />
                  <time title={formatDateTime(row.createdAt)}>{formatRelative(row.createdAt)}</time>
                  {row.expiresAt ? (
                    <>
                      <span className="meta-sep" />
                      <span title={formatDateTime(row.expiresAt)}>
                        {t('到期', 'expires')} {formatRelative(row.expiresAt)}
                      </span>
                    </>
                  ) : null}
                  {row.scope && Object.keys(row.scope).length > 0 ? (
                    <>
                      <span className="meta-sep" />
                      <span className="mono truncate" title={prettyJson(row.scope)}>
                        {prettyJson(row.scope)}
                      </span>
                    </>
                  ) : null}
                </>
              }
              trailing={
                row.status === 'active' && canManage ? (
                  <Button
                    variant="danger"
                    size="s"
                    onClick={() => void handleRevoke(row.id)}
                    loading={revoking === row.id}
                  >
                    {t('撤销', 'Revoke')}
                  </Button>
                ) : undefined
              }
            />
          ))}
        </DataList>
      )}
      {grants.state.status === 'ready' && grants.state.data.nextCursor !== undefined ? (
        <div className="row" style={{ justifyContent: 'center' }}>
          <Button
            variant="secondary"
            loading={grants.loadingMore}
            onClick={() => void grants.loadMore()}
          >
            {t('加载更多', 'Load more')}
          </Button>
        </div>
      ) : null}
      {grants.state.status === 'ready' && grants.state.data.truncated === true ? (
        <p className="text-3 text-small" data-testid="grants-truncated">
          {t(
            '已达到单次读取上限 Reached the per-page limit — 继续点“加载更多”查看其余授权',
            'keep loading more to see the rest.',
          )}
        </p>
      ) : null}
      {grants.loadMoreError !== null ? (
        <ErrorBanner
          error={grants.loadMoreError}
          title="Could not load more grants"
          testId="grants-load-more-error"
        />
      ) : null}

      {canManage ? <IssueServiceHandleSection http={http} principals={principals} /> : null}

      <Drawer
        open={grantOpen}
        onClose={() => setGrantOpen(false)}
        title={t('授予能力', 'Grant capability')}
        subtitle="grant_capability{principalId, resourceType, resourceId?, scope?}"
        testId="grant-drawer"
      >
        {grantOpen ? (
          <GrantCapabilityForm
            http={http}
            principals={principals}
            defaultPrincipalId={committedFilter || undefined}
            onCancel={() => setGrantOpen(false)}
            onDone={() => {
              setGrantOpen(false);
              toast.push({ tone: 'ok', title: t('已授予', 'Grant created') });
              refreshGrants();
            }}
          />
        ) : null}
      </Drawer>
    </div>
  );
}
