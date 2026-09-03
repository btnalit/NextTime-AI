import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePermissions } from '../hooks/usePermissions.js';
import { useResource } from '../hooks/useResource.js';
import type { CapabilityCaller } from '../lib/clients.js';
import {
  type ConnectionRequestRow,
  type CreateConnectionResult,
  type GraphObjectRow,
  gatekeeperFromObject,
  operationFromObject,
} from '../lib/connections.js';
import { isForbiddenError } from '../lib/errors.js';
import { formatDateTime, formatRelative, shortId } from '../lib/format.js';
import { statusValues } from '../lib/status-tone.js';
import { CompleteConnectionForm } from './CompleteConnectionForm.js';
import { GatekeeperCard } from './RegisteredSystemsSection.js';
import { RequestConnectionForm } from './RequestConnectionForm.js';
import { Button } from './ui/Button.js';
import { DataList, DataRow } from './ui/DataList.js';
import { Drawer } from './ui/Drawer.js';
import { EmptyState } from './ui/EmptyState.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Notice } from './ui/Notice.js';
import { PageHeader } from './ui/PageHeader.js';
import { SkeletonRows } from './ui/Skeleton.js';
import { StatusChip } from './ui/StatusChip.js';
import { Tabs } from './ui/Tabs.js';
import { useToast } from './ui/Toast.js';

export interface ConnectionsPageProps {
  readonly http: CapabilityCaller;
}

type RequestFilter = 'requested' | 'all' | 'completed' | 'cancelled';
type DrawerMode =
  | { readonly kind: 'closed' }
  | { readonly kind: 'request' }
  | { readonly kind: 'complete'; readonly request: ConnectionRequestRow | null };

const REQUEST_FILTERS: readonly RequestFilter[] = [
  'requested',
  'all',
  ...(statusValues('connectionRequest').filter(
    (status) => status !== 'requested',
  ) as RequestFilter[]),
];

/**
 * components/ConnectionsPage: the two halves of design doc §7.6 "连接系统" on the live S2.13
 * capabilities. (a) Connection requests — `list_connection_requests` (owner), completed through
 * `create_connection`, or raised here with `request_connection`. (b) Registered systems — the
 * `Gatekeeper`/`Operation` graph Objects via `search`, with `publish_manifest` and
 * `connect_gatekeeper`. `search` is capped at 50 results per object type (kernel gap).
 */
export function ConnectionsPage({ http }: ConnectionsPageProps) {
  const permissions = usePermissions();
  const toast = useToast();
  const [filter, setFilter] = useState<RequestFilter>('requested');
  const [drawer, setDrawer] = useState<DrawerMode>({ kind: 'closed' });

  const loadRequests = useCallback(
    () =>
      http
        .call<{ connectionRequests: readonly ConnectionRequestRow[] }>(
          'list_connection_requests',
          {},
        )
        .then((result) => result.connectionRequests),
    [http],
  );
  const requests = useResource(loadRequests);
  const requestsForbidden =
    requests.state.status === 'error' && isForbiddenError(requests.state.error);
  useEffect(() => {
    if (requestsForbidden) permissions.markDenied('list_connection_requests');
  }, [requestsForbidden, permissions]);

  const loadGatekeepers = useCallback(
    () =>
      http
        .call<readonly GraphObjectRow[]>('search', { query: '', objectType: 'Gatekeeper' })
        .then((rows) => rows.map(gatekeeperFromObject)),
    [http],
  );
  const gatekeepers = useResource(loadGatekeepers);
  const loadOperations = useCallback(
    () =>
      http
        .call<readonly GraphObjectRow[]>('search', { query: '', objectType: 'Operation' })
        .then((rows) => rows.flatMap((row) => operationFromObject(row) ?? [])),
    [http],
  );
  const operations = useResource(loadOperations);

  const requestRows = useMemo(() => {
    const rows = requests.state.status === 'ready' ? requests.state.data : [];
    const filtered = filter === 'all' ? rows : rows.filter((row) => row.status === filter);
    return [...filtered].sort((a, b) => {
      if (a.status !== b.status)
        return a.status === 'requested' ? -1 : b.status === 'requested' ? 1 : 0;
      return b.requestedAt.localeCompare(a.requestedAt);
    });
  }, [requests.state, filter]);
  const requestedCount =
    requests.state.status === 'ready'
      ? requests.state.data.filter((row) => row.status === 'requested').length
      : 0;

  function reloadRegistry(): void {
    void gatekeepers.reload();
    void operations.reload();
  }

  function handleCompleted(result: CreateConnectionResult): void {
    setDrawer({ kind: 'closed' });
    toast.push({
      tone: 'ok',
      title: 'Gatekeeper registered',
      description: `${result.importedOperationNames.length} operation${result.importedOperationNames.length === 1 ? '' : 's'} imported as drafts — publish the manifest to expose them.`,
    });
    void requests.reload();
    reloadRegistry();
  }

  const canCreate = !permissions.isDenied('create_connection');

  return (
    <div className="page">
      <PageHeader
        title="Connections"
        description="Bring systems in behind a Gatekeeper, publish their operations, and grant gates to people's entry agents."
        actions={
          <>
            <Button variant="secondary" icon="plus" onClick={() => setDrawer({ kind: 'request' })}>
              Request connection
            </Button>
            {canCreate ? (
              <Button
                variant="primary"
                icon="connections"
                onClick={() => setDrawer({ kind: 'complete', request: null })}
              >
                Connect a system
              </Button>
            ) : null}
          </>
        }
      />

      <section className="section" aria-labelledby="connection-requests-title">
        <div className="section-header">
          <h2 id="connection-requests-title">
            Connection requests
            {requestedCount > 0 ? <span className="nav-badge">{requestedCount}</span> : null}
          </h2>
          {!requestsForbidden ? (
            <Tabs<RequestFilter>
              ariaLabel="Filter connection requests"
              value={filter}
              onChange={setFilter}
              options={REQUEST_FILTERS.map((value) => ({
                value,
                label: value === 'all' ? 'All' : value.charAt(0).toUpperCase() + value.slice(1),
              }))}
            />
          ) : null}
        </div>

        {requests.state.status === 'loading' ? (
          <SkeletonRows count={2} label="Loading connection requests" testId="requests-loading" />
        ) : requests.state.status === 'error' ? (
          requestsForbidden ? (
            <Notice testId="requests-forbidden">
              Connection requests are owner-only (<code>list_connection_requests</code>). You can
              still raise a request; the workspace owner completes it.
            </Notice>
          ) : (
            <ErrorBanner
              error={requests.state.error}
              title="Could not load connection requests"
              onRetry={() => void requests.reload()}
              testId="requests-error"
            />
          )
        ) : requestRows.length === 0 ? (
          <EmptyState
            icon="inbox"
            title={
              filter === 'requested' ? 'No open connection requests' : 'No connection requests'
            }
            body="An agent (or you) proposes a system with request_connection; completing it here registers the Gatekeeper and imports its operations as drafts."
            action={
              <Button
                variant="secondary"
                icon="plus"
                onClick={() => setDrawer({ kind: 'request' })}
              >
                Request connection
              </Button>
            }
            testId="requests-empty"
          />
        ) : (
          <DataList ariaLabel="Connection requests" testId="requests-list">
            {requestRows.map((row) => (
              <DataRow
                key={row.id}
                testId="request-row"
                leading={<StatusChip machine="connectionRequest" status={row.status} size="s" />}
                title={
                  <>
                    <span className="tag">{row.kind}</span>
                    <span className="mono truncate">{row.target}</span>
                  </>
                }
                meta={
                  <>
                    <span title={row.requestedBy}>by {shortId(row.requestedBy)}</span>
                    <span className="meta-sep" />
                    <time title={formatDateTime(row.requestedAt)}>
                      {formatRelative(row.requestedAt)}
                    </time>
                    {row.gatekeeperId ? (
                      <>
                        <span className="meta-sep" />
                        <span title={row.gatekeeperId}>gate {shortId(row.gatekeeperId)}</span>
                      </>
                    ) : null}
                  </>
                }
                trailing={
                  row.status === 'requested' && canCreate ? (
                    <Button
                      variant="primary"
                      size="s"
                      onClick={() => setDrawer({ kind: 'complete', request: row })}
                    >
                      Complete
                    </Button>
                  ) : undefined
                }
              />
            ))}
          </DataList>
        )}
      </section>

      <section className="section" aria-labelledby="registered-systems-title">
        <div className="section-header">
          <h2 id="registered-systems-title">Registered systems</h2>
          <Button
            variant="ghost"
            size="s"
            icon="refresh"
            onClick={reloadRegistry}
            loading={gatekeepers.state.status === 'ready' && gatekeepers.state.refreshing}
          >
            Refresh
          </Button>
        </div>

        {gatekeepers.state.status === 'loading' ? (
          <SkeletonRows count={2} label="Loading registered systems" testId="gatekeepers-loading" />
        ) : gatekeepers.state.status === 'error' ? (
          <ErrorBanner
            error={gatekeepers.state.error}
            title="Could not load registered systems"
            onRetry={reloadRegistry}
            testId="gatekeepers-error"
          />
        ) : gatekeepers.state.data.length === 0 ? (
          <EmptyState
            icon="connections"
            title="No Gatekeeper registered yet"
            body="Complete a connection request (or connect a system directly) to register the first gate."
            testId="gatekeepers-empty"
          />
        ) : (
          <div className="stack">
            {operations.state.status === 'error' ? (
              <ErrorBanner
                error={operations.state.error}
                title="Could not load operations"
                onRetry={() => void operations.reload()}
              />
            ) : null}
            {gatekeepers.state.data.map((gatekeeper) => (
              <GatekeeperCard
                key={gatekeeper.id}
                http={http}
                gatekeeper={gatekeeper}
                operations={
                  operations.state.status === 'ready'
                    ? operations.state.data.filter(
                        (operation) => operation.gatekeeperId === gatekeeper.id,
                      )
                    : []
                }
                canPublish={!permissions.isDenied('publish_manifest')}
                canGrant={!permissions.isDenied('connect_gatekeeper')}
                onChanged={reloadRegistry}
                onForbidden={permissions.markDenied}
              />
            ))}
            {gatekeepers.state.data.length >= 50 ? (
              <Notice tone="warn">
                Showing the 50 most recently updated gates — <code>search</code> has no paging yet.
              </Notice>
            ) : null}
          </div>
        )}
      </section>

      <Drawer
        open={drawer.kind === 'request'}
        onClose={() => setDrawer({ kind: 'closed' })}
        title="Request a connection"
        subtitle="Creates a connection-request card for the workspace owner to complete."
        testId="request-connection-drawer"
      >
        <RequestConnectionForm
          http={http}
          onCancel={() => setDrawer({ kind: 'closed' })}
          onDone={() => {
            setDrawer({ kind: 'closed' });
            toast.push({ tone: 'ok', title: 'Connection requested' });
            void requests.reload();
          }}
        />
      </Drawer>

      <Drawer
        open={drawer.kind === 'complete'}
        onClose={() => setDrawer({ kind: 'closed' })}
        title={
          drawer.kind === 'complete' && drawer.request ? 'Complete connection' : 'Connect a system'
        }
        subtitle="Registers the Gatekeeper, imports its manifest as drafts, and stores the credential in the gate only."
        wide
        testId="complete-connection-drawer"
      >
        {drawer.kind === 'complete' ? (
          <CompleteConnectionForm
            key={drawer.request?.id ?? 'direct'}
            http={http}
            request={drawer.request}
            onDone={handleCompleted}
            onCancel={() => setDrawer({ kind: 'closed' })}
          />
        ) : null}
      </Drawer>
    </div>
  );
}
