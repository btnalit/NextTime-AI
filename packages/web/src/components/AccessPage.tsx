import { useState } from 'react';
import { invalidateCapability, useCapabilityList } from '../hooks/useCapability.js';
import { usePermissions } from '../hooks/usePermissions.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { isForbiddenError, isNotFoundError } from '../lib/errors.js';
import { formatDateTime, formatRelative, prettyJson, shortId } from '../lib/format.js';
import type { GrantRow, PrincipalRow } from '../lib/governance.js';
import { GrantCapabilityForm } from './GrantCapabilityForm.js';
import { Button } from './ui/Button.js';
import { DataList, DataRow } from './ui/DataList.js';
import { Drawer } from './ui/Drawer.js';
import { EmptyState } from './ui/EmptyState.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Field, Input, Select } from './ui/Field.js';
import { PageHeader } from './ui/PageHeader.js';
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
 * affordances (Grant / Revoke) hide behind the same `create_principal`-derived `canManage` signal
 * `MembersPage` uses (same closure — `grant_capability` and `create_principal` share `minRole:
 * 'owner'`, so a 403 on either denies both, per `hooks/usePermissions.tsx`'s `deniedClosure`).
 */
export function AccessPage({ http }: AccessPageProps) {
  const permissions = usePermissions();
  const toast = useToast();
  const [principalFilter, setPrincipalFilter] = useState('');
  const [grantOpen, setGrantOpen] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<unknown | null>(null);

  const principalsList = useCapabilityList<PrincipalRow>(http, 'list_principals');
  const principals = principalsList.state.status === 'ready' ? principalsList.state.data.items : [];

  const grants = useCapabilityList<GrantRow>(
    http,
    'list_grants',
    principalFilter ? { principalId: principalFilter } : {},
  );

  const canManage = !permissions.isDenied('grant_capability');

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
      toast.push({ tone: 'info', title: 'Grant revoked' });
    } catch (err) {
      if (isForbiddenError(err)) permissions.markDenied('revoke_capability');
      setRevokeError(err);
    } finally {
      setRevoking(null);
    }
  }

  const rows = grants.state.status === 'ready' ? grants.state.data.items : [];
  const forbidden = grants.state.status === 'error' && isForbiddenError(grants.state.error);
  const unavailable = grants.state.status === 'error' && isNotFoundError(grants.state.error);

  return (
    <div className="page">
      <PageHeader
        title="访问 Access"
        description="Which Principal holds which capability, over which resource."
        actions={
          canManage ? (
            <Button variant="primary" icon="plus" onClick={() => setGrantOpen(true)}>
              Grant capability
            </Button>
          ) : undefined
        }
      />

      <div className="page-toolbar">
        <Field id="access-principal-filter" label="Filter by principal">
          {principals.length > 0 ? (
            <Select
              id="access-principal-filter"
              value={principalFilter}
              onChange={(event) => setPrincipalFilter(event.target.value)}
            >
              <option value="">All members</option>
              {principals.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.displayName}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              id="access-principal-filter"
              value={principalFilter}
              onChange={(event) => setPrincipalFilter(event.target.value)}
              placeholder="principal id (optional)"
              mono
            />
          )}
        </Field>
      </div>

      {revokeError !== null ? (
        <ErrorBanner error={revokeError} title="Could not revoke this grant" />
      ) : null}

      {grants.state.status === 'loading' ? (
        <SkeletonRows count={4} label="Loading grants" testId="grants-loading" />
      ) : grants.state.status === 'error' ? (
        unavailable ? (
          <EmptyState
            icon="key"
            title="该能力尚未上线 Not live yet"
            body="list_grants is part of S3.11, still landing on the kernel side."
            testId="grants-unavailable"
          />
        ) : forbidden ? (
          <EmptyState
            icon="shield"
            title="需要 owner 权限"
            body="list_grants is restricted to the workspace owner."
            testId="grants-forbidden"
          />
        ) : (
          <ErrorBanner
            error={grants.state.error}
            title="Could not load grants"
            onRetry={() => void grants.reload()}
            testId="grants-error"
          />
        )
      ) : rows.length === 0 ? (
        <EmptyState
          icon="key"
          title="No grants yet"
          body="Grant a Gatekeeper (or another resource) to a member so their entry agent can use it."
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
                  <span className="mono truncate">{row.resourceId ?? 'any'}</span>
                </>
              }
              meta={
                <>
                  <span title={row.principalId}>principal {shortId(row.principalId)}</span>
                  <span className="meta-sep" />
                  <span title={row.grantedBy}>by {shortId(row.grantedBy)}</span>
                  <span className="meta-sep" />
                  <time title={formatDateTime(row.createdAt)}>{formatRelative(row.createdAt)}</time>
                  {row.expiresAt ? (
                    <>
                      <span className="meta-sep" />
                      <span>expires {formatRelative(row.expiresAt)}</span>
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
                    Revoke
                  </Button>
                ) : undefined
              }
            />
          ))}
        </DataList>
      )}

      <Drawer
        open={grantOpen}
        onClose={() => setGrantOpen(false)}
        title="Grant capability"
        subtitle="grant_capability{principalId, resourceType, resourceId?, scope?}"
        testId="grant-drawer"
      >
        {grantOpen ? (
          <GrantCapabilityForm
            http={http}
            principals={principals}
            defaultPrincipalId={principalFilter || undefined}
            onCancel={() => setGrantOpen(false)}
            onDone={() => {
              setGrantOpen(false);
              toast.push({ tone: 'ok', title: 'Grant created' });
              refreshGrants();
            }}
          />
        ) : null}
      </Drawer>
    </div>
  );
}
