import type {
  PlatformDraftResidueWire,
  PlatformWorkspaceWire,
  RuntimeInventoryWire,
} from '@nexttime/shared';
import { useCapability, useCapabilityList } from '../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import { useT } from '../../lib/i18n.js';
import { breadcrumbFor } from '../../lib/nav.js';
import { isResidueWorkspace, residueWorkspacesHref } from '../../lib/platform-workspaces.js';
import { DataTable, type DataTableColumn } from '../kit/data-table.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { Notice } from '../kit/notice.js';
import { PageHeader } from '../kit/page-header.js';
import { DashboardCard } from '../kit/section.js';
import { StatusChip } from '../kit/status-chip.js';

export interface PlatformResiduePageProps {
  readonly http: CapabilityCaller;
}

/**
 * components/platform/PlatformResiduePage: 验收残留 (`#/platform/residue`, S8 W4-C, journey ⑤
 * 清理验收残留 — docs/development-tasks.md §5e F4). Today "残留" only has a dedicated view at the
 * workspace layer (`PlatformWorkspacesPage`'s residue preset + `PurgeWorkspaceDrawer`); this page
 * is the cross-category summary journey ⑤'s own spec asks for — workspaces, draft definitions,
 * exited entry containers — so an admin does not need to already know to look in three places.
 *
 * Deliberately **no new write path**: every category either links to an existing purge flow
 * (workspaces) or is read-only by design (drafts — see `PlatformDraftResidueWireSchema`'s own doc
 * comment for why a bulk-delete capability does not exist; entry containers — the kernel has no
 * write for container state yet, `roll_entry_containers` only acts on containers that both need
 * rebuild *and* are still running, W5-C is adding purge-time reclaim for the exited case this page
 * surfaces). Reusing three already-loaded reads (`list_workspaces`, `platform_draft_residue`,
 * `runtime_inventory`) rather than a new combined capability — F6 allows a read model, but there is
 * no new *data* here to justify one; this page is a different arrangement of existing reads.
 *
 * A new file (S8 risk ①, F3): `components/kit/*` only, never `components/ui/*` — the responsive
 * `DataTable` stands in for the two item lists here (a one-column `primary` cell is enough for a
 * name + a `high` status chip), and `Notice` stands in for a loading/empty line — neither list
 * needs its own new kit primitive for two short rows of copy.
 */
export function PlatformResiduePage({ http }: PlatformResiduePageProps) {
  const t = useT();
  const workspaces = useCapabilityList<PlatformWorkspaceWire>(http, 'list_workspaces', {});
  const drafts = useCapability<PlatformDraftResidueWire>(http, 'platform_draft_residue');
  const runtime = useCapability<RuntimeInventoryWire>(http, 'runtime_inventory');

  const residueWorkspaces =
    workspaces.state.status === 'ready'
      ? workspaces.state.data.items.filter((row) => isResidueWorkspace(row))
      : [];
  const exitedContainers =
    runtime.state.status === 'ready'
      ? runtime.state.data.residentContainers.filter((row) => !row.running)
      : [];

  const workspaceColumns: readonly DataTableColumn<PlatformWorkspaceWire>[] = [
    {
      id: 'name',
      header: t('名称', 'Name'),
      priority: 'primary',
      cell: (workspace) => <span className="truncate">{workspace.name}</span>,
    },
    {
      id: 'reason',
      header: t('原因', 'Reason'),
      priority: 'high',
      cell: (workspace) =>
        workspace.status === 'disabled'
          ? t('已停用', 'Disabled')
          : t('临时工作区已到期', 'Ephemeral workspace expired'),
    },
    {
      id: 'status',
      header: t('状态', 'Status'),
      priority: 'high',
      cell: (workspace) => (
        <StatusChip
          machine="workspaceStatus"
          status={workspace.status}
          size="s"
          testId="residue-workspace-status"
        />
      ),
    },
  ];

  const containerColumns: readonly DataTableColumn<
    RuntimeInventoryWire['residentContainers'][number]
  >[] = [
    {
      id: 'image',
      header: t('镜像', 'Image'),
      priority: 'primary',
      cell: (container) => (
        <span className="truncate mono">{container.image ?? container.containerId}</span>
      ),
    },
    {
      id: 'status',
      header: t('状态', 'Status'),
      priority: 'high',
      cell: (container) => container.status,
    },
    {
      id: 'lastTouched',
      header: t('最近活动', 'Last touched'),
      cell: (container) =>
        container.lastTouchedAt === null ? (
          <span className="text-3">—</span>
        ) : (
          <time title={formatDateTime(container.startedAt)}>
            {formatRelative(container.lastTouchedAt)}
          </time>
        ),
    },
    {
      id: 'workspace',
      header: t('工作区', 'Workspace'),
      cellClassName: 'mono text-small',
      cell: (container) => container.workspaceId.slice(0, 8),
    },
  ];

  return (
    <div className="page" data-testid="platform-residue-page">
      <PageHeader
        breadcrumb={breadcrumbFor('platformResidue')}
        title={t('验收残留', 'Acceptance residue')}
        description={t(
          '一次验收或试用之后留下的东西：过期或已停用的工作区、还没人认领的草稿、已退出的入口容器。',
          'What a run of acceptance or trial testing leaves behind: expired or disabled workspaces, unclaimed drafts, exited entry containers.',
        )}
      />

      <DashboardCard
        title={t('工作区', 'Workspaces')}
        actions={
          <a href={residueWorkspacesHref()} data-testid="residue-open-workspaces">
            {t('去清理', 'Review and purge')}
          </a>
        }
        data-testid="residue-workspaces-card"
      >
        {workspaces.state.status === 'loading' ? (
          <Notice testId="residue-workspaces-loading">
            {t('正在加载工作区…', 'Loading workspaces')}
          </Notice>
        ) : workspaces.state.status === 'error' ? (
          <ErrorBanner
            error={workspaces.state.error}
            title={t('无法加载工作区列表', 'Could not load the workspace list')}
            onRetry={() => void workspaces.reload()}
            testId="residue-workspaces-error"
          />
        ) : residueWorkspaces.length === 0 ? (
          <Notice testId="residue-workspaces-empty">
            {t('当前没有可清理的工作区', 'No workspace residue to clean up right now')}
          </Notice>
        ) : (
          <DataTable
            columns={workspaceColumns}
            data={residueWorkspaces}
            getRowId={(workspace) => workspace.id}
            ariaLabel={t('残留工作区', 'Residue workspaces')}
            testId="residue-workspaces-list"
            rowTestId={() => 'residue-workspace-row'}
          />
        )}
      </DashboardCard>

      <DashboardCard title={t('草稿定义', 'Draft definitions')} data-testid="residue-drafts-card">
        {drafts.state.status === 'loading' ? (
          <Notice testId="residue-drafts-loading">
            {t('正在加载草稿统计…', 'Loading draft counts')}
          </Notice>
        ) : drafts.state.status === 'error' ? (
          <ErrorBanner
            error={drafts.state.error}
            title={t('无法加载草稿统计', 'Could not load draft counts')}
            onRetry={() => void drafts.reload()}
            testId="residue-drafts-error"
          />
        ) : (
          <>
            <dl className="definition-list" data-testid="residue-drafts-counts">
              <dt>{t('Worker 定义', 'Worker definitions')}</dt>
              <dd className="mono">{drafts.state.data.workerDefinitions}</dd>
              <dt>Skill</dt>
              <dd className="mono">{drafts.state.data.skills}</dd>
              <dt>Procedure</dt>
              <dd className="mono">{drafts.state.data.procedures}</dd>
              <dt>{t('合计', 'Total')}</dt>
              <dd className="mono">{drafts.state.data.total}</dd>
            </dl>
            <p className="text-3 text-small">
              {drafts.state.data.expiryThresholdDays > 0
                ? t(
                    `只显示数量，不显示内容：草稿只对提议者本人可见。超过 ${drafts.state.data.expiryThresholdDays} 天未处理的草稿会被自动清理并记入审计；提议者也可以随时在"我的草稿"里主动丢弃。`,
                    `Counts only — a draft's content is visible only to its own proposer. Drafts older than ${drafts.state.data.expiryThresholdDays} days are cleaned up automatically (recorded in the audit); the proposer can also discard one at any time from "我的草稿".`,
                  )
                : t(
                    '只显示数量，不显示内容：草稿只对提议者本人可见。自动清理当前已关闭，草稿只能由提议者主动丢弃。',
                    'Counts only — a draft’s content is visible only to its own proposer. Automatic cleanup is currently disabled; a draft can only be discarded by its own proposer.',
                  )}
            </p>
          </>
        )}
      </DashboardCard>

      <DashboardCard
        title={t('已退出的入口容器', 'Exited entry containers')}
        data-testid="residue-containers-card"
      >
        {runtime.state.status === 'loading' ? (
          <Notice testId="residue-containers-loading">
            {t('正在加载运行层清单…', 'Loading the runtime inventory')}
          </Notice>
        ) : runtime.state.status === 'error' ? (
          <ErrorBanner
            error={runtime.state.error}
            title={t('无法加载运行层清单', 'Could not load the runtime inventory')}
            onRetry={() => void runtime.reload()}
            testId="residue-containers-error"
          />
        ) : exitedContainers.length === 0 ? (
          <Notice testId="residue-containers-empty">
            {t('没有已退出的入口容器', 'No exited entry containers')}
          </Notice>
        ) : (
          <>
            <DataTable
              columns={containerColumns}
              data={exitedContainers}
              getRowId={(container) => container.containerId}
              ariaLabel={t('已退出的入口容器', 'Exited entry containers')}
              testId="residue-containers-list"
              rowTestId={() => 'residue-container-row'}
            />
            {/* ui-audit journey ⑤ / development-tasks.md §5e leftover 77: the kernel has no write
             *  to reclaim these yet — `roll_entry_containers` only stops a *running* container that
             *  needs a rebuild, never one already exited. W5-C is adding purge-time container
             *  reclaim; this note names the gap rather than offering a button that would fail.
             *  The visible copy names no internal tracking number (F5 文案守卫). */}
            <p className="text-3 text-small">
              {t(
                '目前还没有从控制台回收它们的入口——运行层还没有对应的清除能力，后续波次会补上。',
                'No console action reclaims these yet — the runtime layer has no delete capability for them yet; a later wave adds it.',
              )}
            </p>
          </>
        )}
      </DashboardCard>
    </div>
  );
}
