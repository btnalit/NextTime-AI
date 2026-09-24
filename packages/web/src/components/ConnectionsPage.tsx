import type { AvailableGateInstanceWire } from '@nexttime/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useCapabilityList } from '../hooks/useCapability.js';
import { usePermissions } from '../hooks/usePermissions.js';
import { useResource } from '../hooks/useResource.js';
import type { CapabilityCaller } from '../lib/clients.js';
import {
  type CancelConnectionRequestResult,
  type ConnectionRequestRow,
  type CreateConnectionResult,
  type GraphObjectRow,
  cancelConnectionRequestMessage,
  gatekeeperFromObject,
  operationFromObject,
  searchItems,
} from '../lib/connections.js';
import { describeError, isForbiddenError } from '../lib/errors.js';
import { formatDateTime, formatRelative, shortId } from '../lib/format.js';
import type { PrincipalRow } from '../lib/governance.js';
import { HttpError } from '../lib/http-client.js';
import { breadcrumbFor } from '../lib/nav.js';
import { statusValues } from '../lib/status-tone.js';
import { AvailableGateInstancesSection } from './AvailableGateInstancesSection.js';
import { CompleteConnectionForm } from './CompleteConnectionForm.js';
import { GatekeeperDetailDrawer } from './GatekeeperDetailDrawer.js';
import { OnboardingWizard } from './OnboardingWizard.js';
import { GatekeeperCard } from './RegisteredSystemsSection.js';
import { RequestConnectionForm } from './RequestConnectionForm.js';
import { ConnectSystemLauncher } from './connect/ConnectSystemLauncher.js';
import { PageHeader } from './kit/page-header.js';
import { Button } from './ui/Button.js';
import { ConfirmTier } from './ui/ConfirmTier.js';
import { DataList, DataRow } from './ui/DataList.js';
import { Drawer } from './ui/Drawer.js';
import { EmptyState } from './ui/EmptyState.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Notice } from './ui/Notice.js';
import { SkeletonRows } from './ui/Skeleton.js';
import { StatusChip } from './ui/StatusChip.js';
import { Tabs } from './ui/Tabs.js';
import { useToast } from './ui/Toast.js';

export interface ConnectionsPageProps {
  readonly http: CapabilityCaller;
  /** The Gatekeeper whose S3.11 health/operations detail drawer is open (`#/govern/systems/<id>`,
   *  route-addressable so a link can deep-link straight into it). */
  readonly selectedGatekeeperId?: string;
  readonly onSelectGatekeeper?: (gatekeeperId: string | null) => void;
  /** S6-C: `session.user?.platformRole === 'admin'` (routes.tsx) — lets the launcher create /
   *  enable the platform instance in place and the registered-system cards link to the platform
   *  集成 page. `false` (an apiKey session, a plain member) shows the "需要管理员" notices instead. */
  readonly platformAdmin?: boolean;
}

type RequestFilter = 'requested' | 'all' | 'completed' | 'cancelled';
type DrawerMode =
  | { readonly kind: 'closed' }
  | { readonly kind: 'request' }
  | { readonly kind: 'complete'; readonly request: ConnectionRequestRow | null }
  | { readonly kind: 'wizard' }
  | { readonly kind: 'launcher' };

const REQUEST_FILTERS: readonly RequestFilter[] = [
  'requested',
  'all',
  ...(statusValues('connectionRequest').filter(
    (status) => status !== 'requested',
  ) as RequestFilter[]),
];

/**
 * components/ConnectionsPage: rendered at `/govern/systems` (系统接入 Systems) — the two halves of
 * design doc §7.6 "连接系统" on the live S2.13 capabilities. (a) Connection requests —
 * `list_connection_requests` (owner), completed through `create_connection`, or raised here with
 * `request_connection`. (b) Registered systems — the `Gatekeeper`/`Operation` graph Objects via
 * `search`, with `publish_manifest` and `connect_gatekeeper`. `search` is capped at 50 results per
 * object type (kernel gap). S3.11/S3.14 addition: each card's "Health & operations" action opens
 * `GatekeeperDetailDrawer` (`get_gatekeeper`, new) — the rest of this page (including its file
 * name) is otherwise untouched by that task; see the PR report for why it was not renamed/rewritten.
 *
 * S6-C (docs/console-completion-plan.md §5.6): the page's one primary action is now "接入一个系统
 * Connect a system" — `ConnectSystemLauncher`, the same launcher the platform 集成 page opens
 * (§5.9 principle 1: one ink button per page; the older 接入向导 / quick registration / request
 * buttons stay as secondaries). The platform catalog (`list_available_gate_instances`) is read
 * here once and shared by the catalog section, the launcher and the registered-system cards (the
 * gatekeeper → platform-instance link). C26: a `requested` row gets 取消 Cancel
 * (`cancel_connection_request`, medium-tier confirm; the returned row is spliced in place).
 */
export function ConnectionsPage({
  http,
  selectedGatekeeperId,
  onSelectGatekeeper,
  platformAdmin = false,
}: ConnectionsPageProps) {
  const permissions = usePermissions();
  const toast = useToast();
  const [filter, setFilter] = useState<RequestFilter>('requested');
  const [drawer, setDrawer] = useState<DrawerMode>({ kind: 'closed' });
  const [cancelling, setCancelling] = useState<ConnectionRequestRow | null>(null);

  const loadRequests = useCallback(
    () =>
      http
        .call<{ items: readonly ConnectionRequestRow[] }>('list_connection_requests', {})
        .then((result) => result.items),
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
        .call<unknown>('search', { query: '', objectType: 'Gatekeeper' })
        .then((result) => searchItems<GraphObjectRow>(result).map(gatekeeperFromObject)),
    [http],
  );
  const gatekeepers = useResource(loadGatekeepers);
  const loadOperations = useCallback(
    () =>
      http
        .call<unknown>('search', { query: '', objectType: 'Operation' })
        .then((result) =>
          searchItems<GraphObjectRow>(result).flatMap((row) => operationFromObject(row) ?? []),
        ),
    [http],
  );
  const operations = useResource(loadOperations);
  const available = useCapabilityList<AvailableGateInstanceWire>(
    http,
    'list_available_gate_instances',
    {},
  );
  const availableRows = available.state.status === 'ready' ? available.state.data.items : [];
  // S8 W1-A6 (audit S10 "授权表单要粘贴 principal UUID"): loaded once here, shared by every
  // registered-system card's own "Grant to principal" picker (`GatekeeperCard`'s own doc
  // comment) — the same `list_principals` directory `AccessPage`'s grant form already uses.
  const principalsList = useCapabilityList<PrincipalRow>(
    http,
    'list_principals',
    {},
    {
      autoLoadAll: true,
    },
  );
  const principalRows =
    principalsList.state.status === 'ready' ? principalsList.state.data.items : [];

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

  /** C26: `cancel_connection_request` answers with the row itself (`status: 'cancelled'`) — spliced
   *  in place; a mapped refusal (403 not yours / 409 no longer requested) becomes bilingual copy,
   *  anything else is the kernel's own message. Thrown so `ConfirmTier` keeps the card open. */
  async function cancelRequest(row: ConnectionRequestRow): Promise<void> {
    try {
      const cancelled = await http.call<CancelConnectionRequestResult>(
        'cancel_connection_request',
        { connectionRequestId: row.id },
      );
      requests.mutate((rows) => rows.map((item) => (item.id === cancelled.id ? cancelled : item)));
      toast.push({ tone: 'ok', title: '已取消申请 Connection request cancelled' });
    } catch (err) {
      const described = describeError(err);
      const mapped = cancelConnectionRequestMessage(described.code);
      if (described.code === 'illegal_transition') void requests.reload();
      // Keep the wire code on the rethrow so `ErrorBanner` still titles it (`CODE_TITLES`).
      throw mapped ? new HttpError('capability_error', mapped, described.code) : err;
    }
  }

  const canCreate = !permissions.isDenied('create_connection');

  return (
    <div className="page">
      <PageHeader
        title="系统接入 Systems"
        description="把系统接到门后面、发布它的 Operation、把门授予成员的入口 agent。 Bring systems in behind a Gatekeeper, publish their operations, and grant gates to people's entry agents."
        breadcrumb={breadcrumbFor('systems')}
        primaryAction={
          <Button
            variant="primary"
            icon="plus"
            onClick={() => setDrawer({ kind: 'launcher' })}
            data-testid="connect-system-button"
          >
            接入一个系统 Connect a system
          </Button>
        }
        actions={
          <>
            <Button variant="secondary" icon="inbox" onClick={() => setDrawer({ kind: 'request' })}>
              申请连接 Request connection
            </Button>
            {canCreate ? (
              <Button
                variant="secondary"
                icon="connections"
                onClick={() => setDrawer({ kind: 'complete', request: null })}
                data-testid="register-gate-button"
              >
                直接注册门 Register a gate
              </Button>
            ) : null}
            {canCreate ? (
              <Button variant="secondary" icon="grid" onClick={() => setDrawer({ kind: 'wizard' })}>
                接入向导 Onboarding wizard
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
                  row.status === 'requested' ? (
                    <span className="row-wrap">
                      {canCreate ? (
                        <Button
                          variant="secondary"
                          size="s"
                          onClick={() => setDrawer({ kind: 'complete', request: row })}
                        >
                          完成 Complete
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="s"
                        onClick={() => setCancelling(row)}
                        data-testid={`cancel-request-${row.id}`}
                      >
                        取消 Cancel
                      </Button>
                    </span>
                  ) : undefined
                }
              />
            ))}
          </DataList>
        )}
        {cancelling ? (
          <ConfirmTier
            tier="medium"
            open
            title="取消连接申请 Cancel this connection request"
            description="申请回到「已取消」；门与已导入的 Operation 不受影响。只能取消自己的申请，owner 可取消任何申请。 The request becomes cancelled; nothing registered is touched. Only your own request — the owner may cancel any."
            target={`${cancelling.kind} · ${cancelling.target}`}
            confirmLabel="取消申请 Cancel request"
            cancelLabel="保留 Keep"
            danger
            onConfirm={() => cancelRequest(cancelling)}
            onClose={() => setCancelling(null)}
            testId="cancel-request-confirm"
          />
        ) : null}
      </section>

      <AvailableGateInstancesSection
        http={http}
        available={available}
        onEnabled={reloadRegistry}
        canEnable={canCreate}
      />

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
                onOpenDetail={onSelectGatekeeper}
                platformInstance={
                  availableRows.find((row) => row.gatekeeperId === gatekeeper.id) ?? null
                }
                platformAdmin={platformAdmin}
                principals={principalRows}
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
          drawer.kind === 'complete' && drawer.request
            ? '完成连接 Complete connection'
            : '直接注册门 Register a gate'
        }
        subtitle="注册一个已在跑的门实例、把清单导入为草稿；凭证只存在门里。 Registers the Gatekeeper, imports its manifest as drafts, and stores the credential in the gate only."
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

      <Drawer
        open={drawer.kind === 'launcher'}
        onClose={() => setDrawer({ kind: 'closed' })}
        title="接入一个系统 Connect a system"
        subtitle="选类型 → 连接与凭证 → 能力与策略 → 握手验证"
        wide
        testId="connect-system-drawer"
      >
        {drawer.kind === 'launcher' ? (
          <ConnectSystemLauncher
            http={http}
            origin="workspace"
            platformAdmin={platformAdmin}
            canEnable={canCreate}
            available={availableRows}
            onEnabled={() => {
              void available.reload();
              reloadRegistry();
            }}
            onCancel={() => setDrawer({ kind: 'closed' })}
            onFinished={(result) => {
              setDrawer({ kind: 'closed' });
              void available.reload();
              reloadRegistry();
              if (result.gatekeeperId) onSelectGatekeeper?.(result.gatekeeperId);
            }}
          />
        ) : null}
      </Drawer>

      <Drawer
        open={drawer.kind === 'wizard'}
        onClose={() => setDrawer({ kind: 'closed' })}
        title="接入向导 Onboarding wizard"
        subtitle="Kind → target/credential → import manifest → review operations → done."
        wide
        testId="onboarding-wizard-drawer"
      >
        {drawer.kind === 'wizard' ? (
          <OnboardingWizard
            http={http}
            onCancel={() => setDrawer({ kind: 'closed' })}
            onFinished={(gatekeeperId) => {
              setDrawer({ kind: 'closed' });
              reloadRegistry();
              void requests.reload();
              onSelectGatekeeper?.(gatekeeperId);
            }}
          />
        ) : null}
      </Drawer>

      <Drawer
        open={selectedGatekeeperId !== undefined}
        onClose={() => onSelectGatekeeper?.(null)}
        title="Health & operations"
        subtitle={
          selectedGatekeeperId ? <span className="mono">{selectedGatekeeperId}</span> : undefined
        }
        testId="gatekeeper-detail-drawer"
      >
        {selectedGatekeeperId ? (
          <GatekeeperDetailDrawer
            key={selectedGatekeeperId}
            http={http}
            gatekeeperId={selectedGatekeeperId}
          />
        ) : null}
      </Drawer>
    </div>
  );
}
