import type {
  PlatformWorkspaceWire,
  PurgeWorkspaceResultWire,
  WorkspacePurposeWire,
  WorkspaceStatusWire,
} from '@nexttime/shared';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { useCapabilityList } from '../../hooks/useCapability.js';
import type { WireMembership } from '../../lib/auth-api.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import type { ModelRow } from '../../lib/governance.js';
import { useT } from '../../lib/i18n.js';
import { breadcrumbFor } from '../../lib/nav.js';
import { isResidueWorkspace, readResiduePreset } from '../../lib/platform-workspaces.js';
import { DataTable, type DataTableColumn } from '../kit/data-table.js';
import { PageHeader } from '../kit/page-header.js';
import { Button } from '../ui/Button.js';
import { Drawer } from '../ui/Drawer.js';
import { EmptyState } from '../ui/EmptyState.js';
import { ErrorBanner } from '../ui/ErrorBanner.js';
import { Field, Select } from '../ui/Field.js';
import { SkeletonRows } from '../ui/Skeleton.js';
import { StatusChip } from '../ui/StatusChip.js';
import { useToast } from '../ui/Toast.js';
import { CreateWorkspaceForm } from './CreateWorkspaceForm.js';
import { PurgeWorkspaceDrawer } from './PurgeWorkspaceDrawer.js';
import { WorkspaceDetailPanel, WorkspaceLifecycle } from './WorkspaceDetailPanel.js';

export interface PlatformWorkspacesPageProps {
  readonly http: CapabilityCaller;
  /** The signed-in administrator's own workspace memberships — the only workspaces whose own
   *  (`scope:'workspace'`) configuration pages they can actually open. */
  readonly memberships: readonly WireMembership[];
  /** Switch the session to `workspaceId` and land on its 成员与授权 page. */
  readonly onOpenWorkspaceConfig: (workspaceId: string) => void;
  /** The location hash at mount (defaults to `window.location.hash`) — the overview banner's
   *  `?residue=1` preselects the residue view (`lib/platform-workspaces.ts`). */
  readonly initialHash?: string;
}

/**
 * Exactly one panel is open at a time. `workspace` / `purge` carry only the row's **id** — the
 * `PlatformWorkspaceWire` is re-derived from the live list on every render, so every mutation that
 * answers with a fresh row is reflected in the open drawer without a second copy going stale
 * behind it (the shape `PlatformUsersPage` established). `purge` is its own panel kind rather
 * than a state inside the detail panel: `PurgeWorkspaceDrawer` (and the `ConfirmTier` inside it)
 * is a `Drawer`, and two open drawers would fight over one focus trap.
 */
type Panel =
  | { readonly kind: 'closed' }
  | { readonly kind: 'create' }
  | { readonly kind: 'workspace'; readonly workspaceId: string }
  | { readonly kind: 'purge'; readonly workspaceId: string };

type StatusFilter = 'all' | WorkspaceStatusWire;
type PurposeFilter = 'all' | WorkspacePurposeWire;

interface Filters {
  readonly status: StatusFilter;
  readonly purpose: PurposeFilter;
  /** `list_workspaces{includeExpired}`: `false` drops expired ephemeral workspaces. */
  readonly includeExpired: boolean;
  /** Client-side: only rows `isResidueWorkspace` — disabled ∪ expired ephemeral, the exact
   *  complement of the default view. Reads everything (`{}`) and filters here, since the kernel's
   *  filters cannot express the union. */
  readonly residueOnly: boolean;
}

/** S6-A A1 (§5.2 "列表默认过滤"): hide `disabled` and expired `ephemeral` workspaces. */
const DEFAULT_FILTERS: Filters = {
  status: 'active',
  purpose: 'all',
  includeExpired: false,
  residueOnly: false,
};

/** The overview banner's preset: everything, narrowed client-side to residue. */
const RESIDUE_FILTERS: Filters = {
  status: 'all',
  purpose: 'all',
  includeExpired: true,
  residueOnly: true,
};

/** The `list_workspaces` params for a filter state — the default view is exactly
 *  `{status:'active', includeExpired:false}` (the registry's own description of it). */
function listParams(filters: Filters): Readonly<Record<string, unknown>> {
  if (filters.residueOnly) return {};
  const params: Record<string, unknown> = {};
  if (filters.status !== 'all') params.status = filters.status;
  if (filters.purpose !== 'all') params.purpose = filters.purpose;
  if (!filters.includeExpired) params.includeExpired = false;
  return params;
}

/**
 * components/platform/PlatformWorkspacesPage: 工作区 Workspaces (`/platform/workspaces`,
 * docs/platform-admin-design.md §2 "工作区配置归管理面", §5 "工作区配置" row) — the platform's list
 * of workspaces and everything P-A2 added to it: `list_workspaces`, `create_workspace`,
 * `update_workspace`, `set_workspace_status`, `set_allowed_models`, plus owner delegation through
 * `add_membership` / `set_membership_role`. Reachable only for `platformRole === 'admin'` (gated in
 * `App.tsx`'s `Routed`); every capability here is `scope: 'platform'` and ignores the workspace
 * header, so a platform-only session (an admin with zero memberships) configures workspaces it has
 * no data access to — which is the point of the design's "管理权与数据权是两层".
 *
 * S6-A A1 (docs/console-completion-plan.md §5.2, §5.9 "页面对照原型 — 工作区"): the list defaults
 * to `{status:'active', includeExpired:false}` — acceptance residue (disabled, expired ephemeral)
 * is hidden until the status / purpose / include-expired controls or the overview banner's
 * `?residue=1` preset ask for it; `purpose`, expiry and disabled-at are columns; and a `purgeable`
 * row (never the platform default) carries the 清除 Purge entry that opens
 * `PurgeWorkspaceDrawer` (preview → irreversible confirm → `purge_workspace{confirm:true}`).
 *
 * `list_platform_models` is the llm-proxy catalog as the platform plane reads it: an administrator
 * configuring a workspace they are not a member of cannot use the workspace-scoped `list_models`.
 * The per-workspace configuration pages themselves (成员与授权, 访问, 能力目录 …) are unchanged
 * `scope:'workspace'` pages — reaching them still means *being* in the workspace, so the drawer
 * offers the switch only when the administrator is already a member (P-A2 deliberately does not
 * implement acting in a workspace without a membership).
 */
export function PlatformWorkspacesPage({
  http,
  memberships,
  onOpenWorkspaceConfig,
  initialHash,
}: PlatformWorkspacesPageProps) {
  const t = useT();
  const toast = useToast();
  const [panel, setPanel] = useState<Panel>({ kind: 'closed' });
  const [filters, setFilters] = useState<Filters>(() =>
    readResiduePreset(initialHash ?? window.location.hash) ? RESIDUE_FILTERS : DEFAULT_FILTERS,
  );

  // The banner link can also land while this page is already mounted (same route kind — no
  // remount), so the preset is applied on `hashchange` too; the plain route never resets it.
  useEffect(() => {
    function onHashChange(): void {
      if (readResiduePreset(window.location.hash)) setFilters(RESIDUE_FILTERS);
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const params = useMemo(() => listParams(filters), [filters]);
  const workspaces = useCapabilityList<PlatformWorkspaceWire>(http, 'list_workspaces', params);
  const models = useCapabilityList<ModelRow>(http, 'list_platform_models');

  const loaded = workspaces.state.status === 'ready' ? workspaces.state.data.items : [];
  const rows = useMemo(
    () => (filters.residueOnly ? loaded.filter((row) => isResidueWorkspace(row)) : loaded),
    [loaded, filters.residueOnly],
  );
  const catalog = models.state.status === 'ready' ? models.state.data.items : [];

  const openWorkspace =
    panel.kind === 'workspace' || panel.kind === 'purge'
      ? loaded.find((row) => row.id === panel.workspaceId)
      : undefined;
  const memberOf = new Set(memberships.map((membership) => membership.workspaceId));

  /** In place, never a `reload()`: under the default filter a row just disabled would vanish on
   *  the re-read, taking the open drawer (and its 启用 Enable button) with it. It stays until the
   *  next read, showing its new status and retention clock. */
  function replaceWorkspace(updated: PlatformWorkspaceWire): void {
    workspaces.mutate((data) => ({
      ...data,
      items: data.items.map((row) => (row.id === updated.id ? updated : row)),
    }));
  }

  /** The new row is written into the loaded page before the re-read so the drawer this opens has
   *  a subject for the whole round trip (`reload()` keeps the cached page on screen). */
  function handleCreated(created: PlatformWorkspaceWire): void {
    workspaces.mutate((data) => ({ ...data, items: [...data.items, created] }));
    setPanel({ kind: 'workspace', workspaceId: created.id });
    void workspaces.reload();
  }

  function handlePurged(result: PurgeWorkspaceResultWire): void {
    workspaces.mutate((data) => ({
      ...data,
      items: data.items.filter((row) => row.id !== result.workspaceId),
    }));
    setPanel({ kind: 'closed' });
    const users =
      result.purgedUsers.length > 0 ? `，随之删除 ${result.purgedUsers.length} 个用户 users` : '';
    toast.push({
      tone: 'ok',
      title: `已清除工作区 Purged ${result.name}`,
      description: `${result.totalRows} 行 rows · ${result.activeHandles} 个 Handle 已吊销 revoked${users}`,
      key: `purge-workspace:${result.workspaceId}`,
    });
  }

  function patchFilters(patch: Partial<Filters>): void {
    setFilters((current) => ({ ...current, residueOnly: false, ...patch }));
  }

  const filtered =
    filters.residueOnly ||
    filters.status !== 'all' ||
    filters.purpose !== 'all' ||
    !filters.includeExpired;

  return (
    <div className="page" data-testid="platform-workspaces-page">
      <PageHeader
        breadcrumb={breadcrumbFor('platformWorkspaces')}
        title={t('工作区', 'Workspaces')}
        description={t(
          '每个工作区是一张共享图：给谁用、agent 可用哪些模型、由谁配置。',
          'Each workspace is one shared graph: who it is for, which models its agents may use, and who configures it.',
        )}
        actions={
          <Button
            variant="primary"
            icon="plus"
            onClick={() => setPanel({ kind: 'create' })}
            data-testid="new-workspace"
          >
            {t('新建工作区', 'Create workspace')}
          </Button>
        }
      />

      <form
        className="inline-form row-wrap"
        onSubmit={(event) => event.preventDefault()}
        data-testid="platform-workspaces-filter-form"
      >
        <Field id="platform-workspaces-status" label={t('状态', 'Status')}>
          <Select
            id="platform-workspaces-status"
            value={filters.status}
            onChange={(event) => patchFilters({ status: event.target.value as StatusFilter })}
          >
            <option value="active">{t('活跃', 'Active')}</option>
            <option value="disabled">{t('已停用', 'Disabled')}</option>
            <option value="all">{t('全部', 'All')}</option>
          </Select>
        </Field>
        <Field id="platform-workspaces-purpose" label={t('用途', 'Purpose')}>
          <Select
            id="platform-workspaces-purpose"
            value={filters.purpose}
            onChange={(event) => patchFilters({ purpose: event.target.value as PurposeFilter })}
          >
            <option value="all">{t('全部', 'All')}</option>
            <option value="standard">{t('常规', 'standard')}</option>
            <option value="ephemeral">{t('临时', 'ephemeral')}</option>
          </Select>
        </Field>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={filters.includeExpired}
            onChange={(event) => patchFilters({ includeExpired: event.target.checked })}
            data-testid="platform-workspaces-include-expired"
          />
          <span>{t('含已到期的临时工作区', 'Include expired ephemeral')}</span>
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={filters.residueOnly}
            onChange={(event) =>
              setFilters(event.target.checked ? RESIDUE_FILTERS : DEFAULT_FILTERS)
            }
            data-testid="platform-workspaces-residue-only"
          />
          <span>只看验收残留 Residue only（已停用或已到期 disabled or expired）</span>
        </label>
      </form>

      {models.state.status === 'error' ? (
        <ErrorBanner
          error={models.state.error}
          title={t('无法加载模型目录', 'Could not load the model catalog')}
          onRetry={() => void models.reload()}
          testId="platform-models-error"
        />
      ) : null}

      {workspaces.state.status === 'loading' ? (
        <SkeletonRows count={4} label="Loading workspaces" testId="platform-workspaces-loading" />
      ) : workspaces.state.status === 'error' ? (
        <ErrorBanner
          error={workspaces.state.error}
          title={t('无法加载工作区列表', 'Could not load the workspace list')}
          onRetry={() => void workspaces.reload()}
          testId="platform-workspaces-error"
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="grid"
          title={
            filtered
              ? t('没有匹配的工作区', 'No matching workspaces')
              : t('还没有工作区', 'No workspaces yet')
          }
          body={
            filtered
              ? t(
                  '默认视图隐藏已停用与已到期的临时工作区；改上面的筛选可查看。 The default view hides disabled and expired ephemeral workspaces —',
                  'widen the filters above.',
                )
              : undefined
          }
          testId="platform-workspaces-empty"
        />
      ) : (
        <DataTable
          columns={workspaceColumns(
            (workspaceId) => setPanel({ kind: 'workspace', workspaceId }),
            (workspaceId) => setPanel({ kind: 'purge', workspaceId }),
          )}
          data={rows}
          getRowId={(row) => row.id}
          ariaLabel="Workspaces"
          testId="platform-workspaces-table"
          onRowClick={(row) => setPanel({ kind: 'workspace', workspaceId: row.id })}
          rowTestId={(row) => `workspace-row-${row.id}`}
          rowDataAttrs={(row) => ({ 'data-workspace-id': row.id })}
        />
      )}

      <Drawer
        open={panel.kind === 'create'}
        onClose={() => setPanel({ kind: 'closed' })}
        title={t('新建工作区', 'Create workspace')}
        subtitle={t(
          '再建一张共享图，并指定它的第一个 owner。',
          'A second shared graph, with its first owner.',
        )}
        testId="create-workspace-drawer"
      >
        {panel.kind === 'create' ? (
          <CreateWorkspaceForm
            http={http}
            models={catalog}
            onCreated={handleCreated}
            onCancel={() => setPanel({ kind: 'closed' })}
          />
        ) : null}
      </Drawer>

      <Drawer
        open={panel.kind === 'workspace' && openWorkspace !== undefined}
        onClose={() => setPanel({ kind: 'closed' })}
        title={openWorkspace?.name ?? t('工作区', 'Workspace')}
        subtitle={openWorkspace ? <span className="mono">{openWorkspace.id}</span> : undefined}
        testId="workspace-drawer"
      >
        {panel.kind === 'workspace' && openWorkspace ? (
          <WorkspaceDetailPanel
            key={openWorkspace.id}
            http={http}
            workspace={openWorkspace}
            models={catalog}
            modelsReady={models.state.status === 'ready'}
            onChanged={replaceWorkspace}
            onDelegated={() => void workspaces.reload()}
            onOpenWorkspaceConfig={
              memberOf.has(openWorkspace.id)
                ? () => onOpenWorkspaceConfig(openWorkspace.id)
                : undefined
            }
            onPurge={() => setPanel({ kind: 'purge', workspaceId: openWorkspace.id })}
          />
        ) : null}
      </Drawer>

      {panel.kind === 'purge' && openWorkspace ? (
        <PurgeWorkspaceDrawer
          key={openWorkspace.id}
          http={http}
          workspace={openWorkspace}
          onClose={() => setPanel({ kind: 'workspace', workspaceId: openWorkspace.id })}
          onPurged={handlePurged}
        />
      ) : null}
    </div>
  );
}

/**
 * S8 W1-A4 (audit S3): column definitions for the responsive `DataTable`. The whole row still
 * opens the drawer (`DataTable`'s `onRowClick`); the 配置 Configure / 清除 Purge buttons no longer
 * need a manual `stopPropagation` — `DataTable` never fires `onRowClick` for a click that lands on
 * a nested `<button>` (the same guard `ui/DataList`'s `DataRow` used), so the previous "make it
 * idempotent with onOpen for Configure, stop it for Purge" split collapses into one shared rule.
 */
function workspaceColumns(
  onOpen: (workspaceId: string) => void,
  onPurge: (workspaceId: string) => void,
): readonly DataTableColumn<PlatformWorkspaceWire>[] {
  return [
    {
      id: 'name',
      header: '名称 Name',
      priority: 'primary',
      cell: (workspace) => <span className="truncate">{workspace.name}</span>,
    },
    {
      id: 'status',
      header: '状态 Status',
      priority: 'high',
      cell: (workspace) => (
        <>
          <StatusChip
            machine="workspaceStatus"
            status={workspace.status}
            size="s"
            testId="workspace-status"
          />
          {workspace.isDefault ? (
            <span className="tag" data-testid="workspace-default-badge">
              默认 Default
            </span>
          ) : null}
        </>
      ),
    },
    {
      id: 'actions',
      header: '',
      priority: 'high',
      hideInCard: true,
      cell: (workspace) => {
        const canPurge = workspace.purgeable && !workspace.isDefault;
        return (
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            {canPurge ? (
              <Button
                variant="danger"
                size="s"
                onClick={() => onPurge(workspace.id)}
                data-testid="workspace-purge"
              >
                清除 Purge
              </Button>
            ) : null}
            <Button variant="ghost" size="s" onClick={() => onOpen(workspace.id)}>
              配置 Configure
            </Button>
          </div>
        );
      },
    },
    {
      id: 'purpose',
      header: '用途 Purpose',
      cell: (workspace) => (
        <StatusChip
          machine="workspacePurpose"
          status={workspace.purpose}
          size="s"
          testId="workspace-purpose"
        />
      ),
    },
    {
      id: 'lifecycle',
      header: '生命周期 Lifecycle',
      cell: (workspace) => <WorkspaceLifecycle workspace={workspace} />,
    },
    {
      id: 'entryModel',
      header: '入口模型 Entry model',
      cellClassName: 'mono',
      cell: (workspace) =>
        workspace.entryModel ?? <span className="text-3">平台默认 Platform default</span>,
    },
    {
      id: 'allowedModels',
      header: '允许的模型 Allowed models',
      cell: (workspace) =>
        workspace.allowedModels.length === 0 ? (
          <span className="text-3">全部 All</span>
        ) : (
          `${workspace.allowedModels.length} 个`
        ),
    },
    {
      id: 'memberCount',
      header: '成员数 Members',
      cellClassName: 'mono',
      cell: (workspace) => workspace.memberCount,
    },
    {
      id: 'owners',
      header: 'Owners',
      cell: (workspace) => (
        <div className="row-wrap">
          {workspace.owners.length === 0 ? (
            <span className="text-3">—</span>
          ) : (
            workspace.owners.map((owner) => (
              <span
                key={owner.userId}
                className="chip chip-s chip-info"
                title={owner.displayName}
                data-testid="workspace-owner-chip"
              >
                {owner.login}
              </span>
            ))
          )}
        </div>
      ),
    },
  ];
}
