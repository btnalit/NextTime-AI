import type { AvailableGateInstanceWire, OperationSummaryWire, Role } from '@nexttime/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { invalidateCapability, useCapabilityList } from '../../hooks/useCapability.js';
import { usePermissions } from '../../hooks/usePermissions.js';
import { useResource } from '../../hooks/useResource.js';
import { useRoleCan } from '../../hooks/useRoleCan.js';
import { useWorkspaceIdentity } from '../../hooks/useWorkspaceIdentity.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import {
  type CancelConnectionRequestResult,
  type ConnectionRequestRow,
  type CreateConnectionResult,
  cancelConnectionRequestOverrides,
} from '../../lib/connections.js';
import { describeError, isForbiddenError } from '../../lib/errors.js';
import { formatDateTime, formatRelative, shortId } from '../../lib/format.js';
import type { GrantRow, PrincipalRow } from '../../lib/governance.js';
import { useT } from '../../lib/i18n.js';
import { breadcrumbFor } from '../../lib/nav.js';
import { labelText, statusChipStyle, statusValues } from '../../lib/status-tone.js';
import { AvailableGateInstancesSection } from '../AvailableGateInstancesSection.js';
import { CompleteConnectionForm } from '../CompleteConnectionForm.js';
import { GatekeeperDetailDrawer } from '../GatekeeperDetailDrawer.js';
import { OnboardingWizard } from '../OnboardingWizard.js';
import { RequestConnectionForm } from '../RequestConnectionForm.js';
import { ConnectSystemLauncher } from '../connect/ConnectSystemLauncher.js';
import { Button } from '../kit/button.js';
import { Confirm } from '../kit/confirm.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../kit/dropdown-menu.js';
import { EmptyState } from '../kit/empty-state.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { Notice } from '../kit/notice.js';
import { PageHeader } from '../kit/page-header.js';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../kit/sheet.js';
import { StatusChip } from '../kit/status-chip.js';
import { Tabs } from '../kit/tabs.js';
import {
  announceReadinessChange,
  useExecutionReadiness,
} from '../readiness/useExecutionReadiness.js';
import { SystemAccessCard, type SystemAccessGranteeRow } from './SystemAccessCard.js';
import { useMemberReachability } from './useMemberReachability.js';

export interface SystemsPageProps {
  readonly http: CapabilityCaller;
  /** `#/govern/systems/<id>` — deep-links straight into that gate's health/operations drawer
   *  (`hrefs.gatekeeper`, used across the console: catalog rows, My Agent, the platform gate
   *  instance panel, audit resource links). */
  readonly selectedGatekeeperId?: string;
  readonly onSelectGatekeeper?: (gatekeeperId: string | null) => void;
  /** `session.user?.platformRole === 'admin'` — lets the launcher create/enable the platform
   *  instance in place. */
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

const EMPTY_NAMES: ReadonlyMap<string, string> = new Map();

/** The 待启用的平台实例 section, scrolled to from the empty state when it has rows (audit P1-16). */
const AVAILABLE_SECTION_ID = 'systems-available-instances';

/**
 * components/systems/SystemsPage: 系统与授权 Systems & access (`#/govern/systems`, also rendered
 * for `#/govern/access` — routes.tsx). Console redesign P2 (docs/console-redesign-plan-
 * 2026-09-25.md §4): merges 系统接入's registered-system half with 访问's per-member grant half —
 * one card per system in this workspace, who can use it and why not, and which Workers cover it —
 * instead of two pages neither of which answered "can this member's agent use this system".
 *
 * Kept unchanged from the two pages it replaces (secondary sections, reusing their existing
 * components as instructed): connection requests (`list_connection_requests` /
 * `cancel_connection_request` / `RequestConnectionForm` / `CompleteConnectionForm`), the platform
 * catalog's pending-enable instances (`AvailableGateInstancesSection`), the "接入一个系统" launcher
 * (`ConnectSystemLauncher`) and the legacy 接入向导/直接注册门 paths (`OnboardingWizard` /
 * `CompleteConnectionForm`), and the gate health/operations detail drawer
 * (`GatekeeperDetailDrawer`, `#/govern/systems/<id>`).
 *
 * New: the primary card list is driven by `execution_readiness`'s own `gates[]` (every enabled
 * Gatekeeper in the workspace, member-readable) rather than a `search{objectType:'Gatekeeper'}`
 * scan — it already carries the published-operation counts this page's cards need, and it is the
 * one read `M2` of the redesign plan introduced specifically to answer "what can be used, and by
 * whom". Per-member reachability comes from one `execution_readiness{principalId}` call per
 * distinct grantee (`useMemberReachability`) — not batched yet, flagged as a follow-up in the PR
 * report. `execution_readiness`'s `gate.workerDefinitionIds` is itself computed against the
 * *viewing* principal's own granted gates (attenuation — a Worker can only carry a gate the
 * delegating principal already holds), so "哪些 Worker 覆盖" shows coverage from this viewer's own
 * vantage point, not an omniscient union across every member — also noted in the PR report.
 *
 * Role gating follows the established "let the 403 tell you" pattern (`list_grants`/
 * `list_principals` are operator-readable; a plain member's read fails and the page degrades to
 * showing only that member's own row, with no grant/revoke actions) rather than pre-computing a
 * role client-side.
 */
export function SystemsPage({
  http,
  selectedGatekeeperId,
  onSelectGatekeeper,
  platformAdmin = false,
}: SystemsPageProps) {
  const t = useT();
  const permissions = usePermissions();
  const { principalId: selfPrincipalId } = useWorkspaceIdentity(http);
  // #541 acceptance must-fix 2: what this reader's role may do here, by the kernel's predicate.
  const can = useRoleCan(http);
  const [filter, setFilter] = useState<RequestFilter>('requested');
  const [drawer, setDrawer] = useState<DrawerMode>({ kind: 'closed' });
  const [cancelling, setCancelling] = useState<ConnectionRequestRow | null>(null);

  // ---- Primary content: systems -----------------------------------------------------------
  // Held until the reader's role is known: an auditor may not read it (#541 acceptance).
  const readiness = useExecutionReadiness(http, { enabled: can('execution_readiness') === true });
  const available = useCapabilityList<AvailableGateInstanceWire>(
    http,
    'list_available_gate_instances',
    {},
  );
  const availableRows = available.state.status === 'ready' ? available.state.data.items : [];
  const operationsList = useCapabilityList<OperationSummaryWire>(
    http,
    'list_operations',
    {},
    { autoLoadAll: true },
  );

  const healthByGate = useMemo(() => {
    const map = new Map<
      string,
      {
        readonly linked: boolean;
        readonly health?: string;
        readonly transportKind?: string;
        readonly platformGateId?: string;
      }
    >();
    for (const row of availableRows) {
      if (row.gatekeeperId) {
        map.set(row.gatekeeperId, {
          linked: true,
          health: row.health,
          transportKind: row.transportKind,
          // G3 (closing wave C6): the platform instance id — distinct from `row.gatekeeperId` —
          // `RefreshOperationGovernanceConfirm` reads the announced manifest from.
          platformGateId: row.gateId,
        });
      }
    }
    return map;
  }, [availableRows]);

  const draftCountByGate = useMemo(() => {
    const map = new Map<string, number>();
    if (operationsList.state.status === 'ready') {
      for (const op of operationsList.state.data.items) {
        if (op.status !== 'draft') continue;
        map.set(op.gatekeeperId, (map.get(op.gatekeeperId) ?? 0) + 1);
      }
    }
    return map;
  }, [operationsList.state]);

  const workerNames = useMemo(() => {
    if (readiness.state.status !== 'ready') return EMPTY_NAMES;
    return new Map(
      readiness.state.data.workers.map((w) => [w.definitionId, w.name ?? w.definitionId]),
    );
  }, [readiness.state]);

  function reloadRegistry(): void {
    void readiness.reload();
    void operationsList.reload();
  }

  // ---- 谁能用: owner/operator directory, degrading to a self-only view on a 403 --------------
  // Both held until the role is known: a builder / member gets the self-only view without asking
  // (#541 review M3).
  const principalsList = useCapabilityList<PrincipalRow>(
    http,
    'list_principals',
    {},
    { autoLoadAll: true, enabled: can('list_principals') === true },
  );
  const grantsList = useCapabilityList<GrantRow>(
    http,
    'list_grants',
    {},
    { autoLoadAll: true, enabled: can('list_grants') === true },
  );
  const directory = principalsList.state.status === 'ready' && grantsList.state.status === 'ready';

  const principalNames = useMemo(() => {
    if (principalsList.state.status !== 'ready') return EMPTY_NAMES;
    return new Map(principalsList.state.data.items.map((row) => [row.id, row.displayName]));
  }, [principalsList.state]);
  // R-39: the grantee's role, for the card's "also an approver" disclosure.
  const principalRoles = useMemo(() => {
    if (principalsList.state.status !== 'ready') return new Map<string, Role>();
    return new Map(principalsList.state.data.items.map((row) => [row.id, row.role]));
  }, [principalsList.state]);

  const grantsByGate = useMemo(() => {
    const map = new Map<string, GrantRow[]>();
    if (grantsList.state.status !== 'ready') return map;
    for (const row of grantsList.state.data.items) {
      if (row.status !== 'active' || row.resourceType !== 'gatekeeper' || !row.resourceId) continue;
      const list = map.get(row.resourceId) ?? [];
      list.push(row);
      map.set(row.resourceId, list);
    }
    return map;
  }, [grantsList.state]);

  const distinctPrincipalIds = useMemo(() => {
    const ids = new Set<string>();
    for (const rows of grantsByGate.values()) {
      for (const row of rows) {
        if (row.principalId !== selfPrincipalId) ids.add(row.principalId);
      }
    }
    return [...ids];
  }, [grantsByGate, selfPrincipalId]);

  const memberReadiness = useMemberReachability(http, distinctPrincipalIds);
  const readinessByPrincipal = useMemo(() => {
    const map = new Map(memberReadiness.byPrincipal);
    if (readiness.state.status === 'ready' && selfPrincipalId) {
      map.set(selfPrincipalId, readiness.state.data);
    }
    return map;
  }, [memberReadiness.byPrincipal, readiness.state, selfPrincipalId]);

  function reloadGrants(): void {
    invalidateCapability(http, 'list_grants');
    void grantsList.reload();
  }

  async function handleRevoke(grantId: string): Promise<void> {
    try {
      await http.call('revoke_capability', { grantId });
      announceReadinessChange(http);
      grantsList.mutate((data) => ({
        ...data,
        items: data.items.map((row) =>
          row.id === grantId ? { ...row, status: 'revoked' as const } : row,
        ),
      }));
    } catch (err) {
      if (isForbiddenError(err)) permissions.markDenied('revoke_capability');
      throw err;
    }
  }

  const canManage = can('grant_capability') !== false;

  // ---- 连接申请 Connection requests (ported from ConnectionsPage, unchanged behavior) --------
  // An owner-only read, held until the role is known: a role that may not make it is told so,
  // without asking (#541 review M3).
  const readsRequests = can('list_connection_requests');
  const loadRequests = useCallback(
    (): Promise<readonly ConnectionRequestRow[]> =>
      readsRequests === true
        ? http
            .call<{ items: readonly ConnectionRequestRow[] }>('list_connection_requests', {})
            .then((result) => result.items)
        : readsRequests === false
          ? Promise.resolve([])
          : new Promise<never>(() => undefined),
    [http, readsRequests],
  );
  const requests = useResource(loadRequests);
  const requestsForbidden =
    readsRequests === false ||
    (requests.state.status === 'error' && isForbiddenError(requests.state.error));
  useEffect(() => {
    if (requestsForbidden) permissions.markDenied('list_connection_requests');
  }, [requestsForbidden, permissions]);

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

  function handleCompleted(result: CreateConnectionResult): void {
    setDrawer({ kind: 'closed' });
    void requests.reload();
    reloadRegistry();
    if (result.gatekeeperId) onSelectGatekeeper?.(result.gatekeeperId);
  }

  async function cancelRequest(row: ConnectionRequestRow): Promise<void> {
    try {
      const cancelled = await http.call<CancelConnectionRequestResult>(
        'cancel_connection_request',
        { connectionRequestId: row.id },
      );
      requests.mutate((rows) => rows.map((item) => (item.id === cancelled.id ? cancelled : item)));
    } catch (err) {
      if (describeError(err).code === 'illegal_transition') void requests.reload();
      // Shown by the confirm with `cancelConnectionRequestOverrides`; the kernel's text stays.
      throw err;
    }
  }

  const cancelOverrides = cancelConnectionRequestOverrides(t);
  const canCreate = can('create_connection') !== false;
  const canRequest = can('request_connection') !== false;
  // An auditor reads neither its readiness nor the grants: the page says so once, read-only.
  const readsReadiness = can('execution_readiness') !== false;
  // #541 review: enabling a prepared instance is `enable_gate_instance` (owner) — once the reader's
  // role is known, the kernel's own predicate decides; before that, the 403 still tells.
  const canEnable = canCreate && can('enable_gate_instance') !== false;
  // Platform instances this workspace has not enabled yet (an enabled one already carries its
  // gatekeeper and is listed above as a connected system).
  const enableableCount = availableRows.filter((row) => !row.gatekeeperId).length;
  const gates = readiness.state.status === 'ready' ? readiness.state.data.gates : [];

  return (
    <div className="page">
      <PageHeader
        title={t('系统与授权', 'Systems & access')}
        description={t(
          '每个系统一张卡：谁能用它、用不了差哪一步、哪些 Worker 覆盖它。',
          'One card per system: who can use it, what is missing when they cannot, and which Workers cover it.',
        )}
        breadcrumb={breadcrumbFor('systems')}
        primaryAction={
          canRequest ? (
            <Button
              variant="primary"
              onClick={() => setDrawer({ kind: 'launcher' })}
              data-testid="connect-system-button"
            >
              {t('接入一个系统', 'Connect a system')}
            </Button>
          ) : undefined
        }
        actions={
          canCreate ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="s" data-testid="connect-system-more">
                  {t('更多接入方式', 'More ways to connect')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  data-testid="register-gate-button"
                  onSelect={() => setDrawer({ kind: 'complete', request: null })}
                >
                  {t('直接注册门（旧路径）', 'Register a gate directly (legacy)')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setDrawer({ kind: 'wizard' })}>
                  {t('接入向导', 'Onboarding wizard')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : undefined
        }
      />

      {!readsReadiness ? (
        <Notice testId="systems-read-only">
          {t(
            '你的角色是只读的：谁能用哪个系统由工作区所有者管理，这里不显示。下面列出平台为本工作区准备的系统；要查某个系统被谁调用过，到「审计」页按资源筛选。',
            'Your role is read-only: who may use which system is managed by a workspace owner and is not shown here. The systems the platform prepared for this workspace are listed below; to see who called a system, filter the Audit page by resource.',
          )}
        </Notice>
      ) : readiness.state.status === 'loading' ? (
        <p className="text-3 text-small" data-testid="systems-loading">
          {t('正在加载系统…', 'Loading systems…')}
        </p>
      ) : readiness.state.status === 'error' ? (
        <ErrorBanner
          error={readiness.state.error}
          title={t('无法加载系统', 'Could not load systems')}
          onRetry={() => void readiness.reload()}
          testId="systems-error"
        />
      ) : gates.length === 0 && enableableCount > 0 ? (
        // Audit P1-16: systems the platform already prepared are one click away below — "nothing
        // connected yet" next to them read as a contradiction. The header's 接入一个系统 stays the
        // one primary button on the page. #541 review: only rows not yet enabled count, and only a
        // reader who can enable them (`canEnable` below) is told to.
        <EmptyState
          title={
            canEnable
              ? t(
                  `有 ${enableableCount} 个系统已就绪，等待启用`,
                  `${enableableCount} system(s) ready to enable`,
                )
              : t(
                  `有 ${enableableCount} 个系统已就绪，等工作区所有者启用`,
                  `${enableableCount} system(s) ready, waiting for a workspace owner to enable`,
                )
          }
          body={
            canEnable
              ? t(
                  '平台已经准备好了下面这些系统，启用后就能在这里授权成员使用。',
                  'The platform has prepared the systems below; enable one, then grant members access to it here.',
                )
              : t(
                  '平台已经准备好了下面这些系统，需要工作区所有者启用并授权后你才能使用，请联系工作区所有者。',
                  'The platform has prepared the systems below; a workspace owner has to enable one and grant you access before you can use it. Ask a workspace owner.',
                )
          }
          action={
            <Button
              variant="secondary"
              onClick={() =>
                document
                  .getElementById(AVAILABLE_SECTION_ID)
                  ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }
              data-testid="systems-empty-see-available"
            >
              {canEnable
                ? t('查看待启用的系统', 'See the systems to enable')
                : t('查看这些系统', 'See these systems')}
            </Button>
          }
          testId="systems-empty"
        />
      ) : gates.length === 0 ? (
        <EmptyState
          title={t('还没有接入任何系统', 'No system connected yet')}
          body={t(
            '点上方的「接入一个系统」，把第一个系统接到门后面，之后就能在这里授权成员使用它。',
            'Use "Connect a system" above to bring the first one in behind a gate; you can then grant members access to it here.',
          )}
          testId="systems-empty"
        />
      ) : (
        <ul className="data-list systems-list" aria-label={t('已接入的系统', 'Connected systems')}>
          {gates.map((gate) => {
            const rows: readonly SystemAccessGranteeRow[] = directory
              ? (grantsByGate.get(gate.gateId) ?? []).map((row) => ({
                  grantId: row.id,
                  principalId: row.principalId,
                  principalName: principalNames.get(row.principalId),
                  principalRole: principalRoles.get(row.principalId),
                }))
              : selfPrincipalId
                ? [{ grantId: '', principalId: selfPrincipalId }]
                : [];
            return (
              <SystemAccessCard
                key={gate.gateId}
                http={http}
                gate={gate}
                healthInfo={healthByGate.get(gate.gateId) ?? { linked: false }}
                draftCount={draftCountByGate.get(gate.gateId) ?? 0}
                canPublish={can('publish_manifest') !== false}
                onPublished={reloadRegistry}
                workerNames={workerNames}
                rows={rows}
                directory={directory}
                canManage={canManage}
                readinessByPrincipal={readinessByPrincipal}
                // The cards below only render once `readiness` (the baseline, self read) is
                // itself `ready` — so a row's own "pending" state only ever needs to track the
                // batched per-*other*-member reads; the self row's entry is already in
                // `readinessByPrincipal` by construction (`readiness.state.status === 'ready'` is
                // exactly the condition under which `gates` — and this whole branch — renders).
                readinessLoading={memberReadiness.loading}
                onOpenDetail={(id) => onSelectGatekeeper?.(id)}
                onRevoke={handleRevoke}
                onGranted={reloadGrants}
                selfPrincipalId={selfPrincipalId}
                platformAdmin={platformAdmin}
              />
            );
          })}
        </ul>
      )}

      {/* --- 连接申请 Connection requests (owner queue; ported unchanged from ConnectionsPage) --- */}
      {canRequest || canCreate ? (
        <section className="section" aria-labelledby="connection-requests-title">
          <div className="section-header">
            <h2 id="connection-requests-title">
              {t('连接申请', 'Connection requests')}
              {requestedCount > 0 ? <span className="nav-badge">{requestedCount}</span> : null}
            </h2>
            {!requestsForbidden ? (
              // Bugfix (PR #324 review): this was a `<fieldset>` of individual `kit/button`
              // `primary`/`secondary` pairs — a proper segmented control (`kit/tabs`) instead, same
              // component the rest of the redesign already uses for this exact pattern (e.g.
              // 能力目录's Skill/Worker tabs).
              <Tabs
                ariaLabel={t('筛选连接申请', 'Filter connection requests')}
                value={filter}
                onChange={setFilter}
                options={REQUEST_FILTERS.map((value) => ({
                  value,
                  label:
                    value === 'all'
                      ? t('全部', 'All')
                      : labelText(statusChipStyle('connectionRequest', value), t),
                }))}
              />
            ) : null}
          </div>

          {requestsForbidden ? (
            <Notice testId="requests-forbidden">
              {t(
                '只有工作区所有者能看到连接申请列表。你仍可以发起申请，由所有者完成。',
                'Only the workspace owner can see the connection requests. You can still raise one; the owner completes it.',
              )}
            </Notice>
          ) : requests.state.status === 'loading' ? (
            <p className="text-3 text-small" data-testid="requests-loading">
              {t('正在加载连接申请…', 'Loading connection requests')}
            </p>
          ) : requests.state.status === 'error' ? (
            <ErrorBanner
              error={requests.state.error}
              title={t('无法加载连接申请', 'Could not load connection requests')}
              onRetry={() => void requests.reload()}
              testId="requests-error"
            />
          ) : requestRows.length === 0 ? (
            <EmptyState
              title={
                filter === 'requested'
                  ? t('没有待处理的连接申请', 'No open connection requests')
                  : t('没有连接申请', 'No connection requests')
              }
              body={t(
                '智能体（或你自己）可以申请接入一个系统；在这里完成申请，会注册这个门，并把它的 Operation 导入为草稿。',
                'An agent (or you) can request a system; completing the request here registers the Gatekeeper and imports its Operations as drafts.',
              )}
              action={
                <Button variant="secondary" onClick={() => setDrawer({ kind: 'request' })}>
                  {t('申请连接', 'Request connection')}
                </Button>
              }
              testId="requests-empty"
            />
          ) : (
            <div className="stack-s" data-testid="requests-list">
              {requestRows.map((row) => (
                <div className="row-wrap" key={row.id} data-testid="request-row">
                  <StatusChip machine="connectionRequest" status={row.status} size="s" />
                  <span className="tag">{row.kind}</span>
                  <span className="mono truncate">{row.target}</span>
                  <span className="text-3 text-small" title={row.requestedBy}>
                    {t('由', 'by')} {shortId(row.requestedBy)}
                  </span>
                  <time className="text-3 text-small" title={formatDateTime(row.requestedAt)}>
                    {formatRelative(row.requestedAt)}
                  </time>
                  {row.gatekeeperId ? (
                    <span className="text-3 text-small" title={row.gatekeeperId}>
                      {t('门', 'gate')} {shortId(row.gatekeeperId)}
                    </span>
                  ) : null}
                  {row.status === 'requested' ? (
                    <span className="row-wrap">
                      {canCreate ? (
                        <Button
                          variant="secondary"
                          size="s"
                          onClick={() => setDrawer({ kind: 'complete', request: row })}
                        >
                          {t('完成', 'Complete')}
                        </Button>
                      ) : null}
                      <Confirm
                        tier="medium"
                        open={cancelling?.id === row.id}
                        onOpenChange={(open) => setCancelling(open ? row : null)}
                        anchor={
                          <Button
                            variant="ghost"
                            size="s"
                            onClick={() => setCancelling(row)}
                            data-testid={`cancel-request-${row.id}`}
                          >
                            {t('取消', 'Cancel')}
                          </Button>
                        }
                        title={t('取消连接申请', 'Cancel this connection request')}
                        description={t(
                          '申请回到「已取消」；门与已导入的 Operation 不受影响。只能取消自己的申请，owner 可取消任何申请。',
                          'The request becomes cancelled; nothing registered is touched. Only your own request — the owner may cancel any.',
                        )}
                        target={`${row.kind} · ${row.target}`}
                        confirmLabel={t('取消申请', 'Cancel request')}
                        cancelLabel={t('保留', 'Keep')}
                        danger
                        onConfirm={() => cancelRequest(row)}
                        errorOverrides={cancelOverrides}
                        testId="cancel-request-confirm"
                      />
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {/* --- 待启用的平台实例 (unchanged component) ------------------------------------------- */}
      <section className="section" id={AVAILABLE_SECTION_ID}>
        <AvailableGateInstancesSection
          http={http}
          available={available}
          onEnabled={reloadRegistry}
          canEnable={canEnable}
          canEnterCredential={can('issue_gate_credential_token') !== false}
          platformAdmin={platformAdmin}
        />
      </section>

      <Sheet
        open={drawer.kind === 'request'}
        onOpenChange={(open) => !open && setDrawer({ kind: 'closed' })}
      >
        <SheetContent data-testid="request-connection-drawer">
          <SheetHeader>
            <SheetTitle>{t('申请连接', 'Request a connection')}</SheetTitle>
            <SheetDescription>
              {t(
                '为工作区 owner 创建一张连接申请卡，由 owner 完成它。',
                'Creates a connection-request card for the workspace owner to complete.',
              )}
            </SheetDescription>
          </SheetHeader>
          {drawer.kind === 'request' ? (
            <RequestConnectionForm
              http={http}
              onCancel={() => setDrawer({ kind: 'closed' })}
              onDone={() => {
                setDrawer({ kind: 'closed' });
                void requests.reload();
              }}
            />
          ) : null}
        </SheetContent>
      </Sheet>

      <Sheet
        open={drawer.kind === 'complete'}
        onOpenChange={(open) => !open && setDrawer({ kind: 'closed' })}
      >
        <SheetContent size="wide" data-testid="complete-connection-drawer">
          <SheetHeader>
            <SheetTitle>
              {drawer.kind === 'complete' && drawer.request
                ? t('完成连接', 'Complete connection')
                : t('直接注册门', 'Register a gate')}
            </SheetTitle>
            <SheetDescription>
              {t(
                '注册一个已在跑的门实例、把清单导入为草稿；凭证只存在门里。',
                'Registers the Gatekeeper, imports its manifest as drafts, and stores the credential in the gate only.',
              )}
            </SheetDescription>
          </SheetHeader>
          {drawer.kind === 'complete' ? (
            <CompleteConnectionForm
              key={drawer.request?.id ?? 'direct'}
              http={http}
              request={drawer.request}
              onDone={handleCompleted}
              onCancel={() => setDrawer({ kind: 'closed' })}
            />
          ) : null}
        </SheetContent>
      </Sheet>

      <Sheet
        open={drawer.kind === 'launcher'}
        onOpenChange={(open) => !open && setDrawer({ kind: 'closed' })}
      >
        <SheetContent size="wide" data-testid="connect-system-drawer">
          <SheetHeader>
            <SheetTitle>{t('接入一个系统', 'Connect a system')}</SheetTitle>
            <SheetDescription>选类型 → 连接与凭证 → 能力与策略 → 握手验证</SheetDescription>
          </SheetHeader>
          {drawer.kind === 'launcher' ? (
            <ConnectSystemLauncher
              http={http}
              origin="workspace"
              platformAdmin={platformAdmin}
              canEnable={canEnable}
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
        </SheetContent>
      </Sheet>

      <Sheet
        open={drawer.kind === 'wizard'}
        onOpenChange={(open) => !open && setDrawer({ kind: 'closed' })}
      >
        <SheetContent size="wide" data-testid="onboarding-wizard-drawer">
          <SheetHeader>
            <SheetTitle>{t('接入向导', 'Onboarding wizard')}</SheetTitle>
            <SheetDescription>
              {t(
                '类型 → 目标/凭证 → 导入清单 → 复核 Operation → 完成。',
                'Kind → target/credential → import manifest → review operations → done.',
              )}
            </SheetDescription>
          </SheetHeader>
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
        </SheetContent>
      </Sheet>

      <Sheet
        open={selectedGatekeeperId !== undefined}
        onOpenChange={(open) => !open && onSelectGatekeeper?.(null)}
      >
        <SheetContent data-testid="gatekeeper-detail-drawer">
          <SheetHeader>
            <SheetTitle>{t('健康与操作', 'Health & operations')}</SheetTitle>
            {selectedGatekeeperId ? (
              <SheetDescription className="mono">{selectedGatekeeperId}</SheetDescription>
            ) : null}
          </SheetHeader>
          {selectedGatekeeperId ? (
            <GatekeeperDetailDrawer
              key={selectedGatekeeperId}
              http={http}
              gatekeeperId={selectedGatekeeperId}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
