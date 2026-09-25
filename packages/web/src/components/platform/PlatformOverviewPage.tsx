import type {
  PlatformOverviewWire,
  PlatformStatusWire,
  PlatformWorkspaceWire,
} from '@nexttime/shared';
import { useCapability, useCapabilityList } from '../../hooks/useCapability.js';
import type { Resource } from '../../hooks/useResource.js';
import type { MeResult } from '../../lib/auth-api.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { formatAuditActor, formatDateTime } from '../../lib/format.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { breadcrumbFor } from '../../lib/nav.js';
import { isResidueWorkspace, residueWorkspacesHref } from '../../lib/platform-workspaces.js';
import { hrefs } from '../../lib/router.js';
import { BindApiKeyForm } from '../BindApiKeyForm.js';
import { PageHeader } from '../kit/page-header.js';
import { DashboardCard } from '../kit/section.js';
import { DataList, DataRow } from '../ui/DataList.js';
import { EmptyState } from '../ui/EmptyState.js';
import { ErrorBanner } from '../ui/ErrorBanner.js';
import { Icon } from '../ui/Icon.js';
import { Notice } from '../ui/Notice.js';
import { SkeletonRows } from '../ui/Skeleton.js';

export interface PlatformOverviewPageProps {
  readonly http: CapabilityCaller;
  /** The refreshed `{user, memberships}` `POST /api/auth/bind-api-key` answers with. `App` routes
   *  it back through its own cookie-auth path, so a platform-only admin (zero memberships, no WS)
   *  is upgraded to a real workspace session and can open the workspace it just bound without
   *  reloading. Optional — this page renders standalone in its own tests. */
  readonly onKeyBound?: (result: MeResult) => void;
}

type ChecklistItem = PlatformOverviewWire['checklist'][number];
type ServiceHealth = PlatformOverviewWire['health'][number];

/** `ChecklistItemWire.key` → bilingual label (design doc §4's five first-run steps). */
const CHECKLIST_LABELS: Readonly<
  Record<ChecklistItem['key'], { readonly zh: string; readonly en: string }>
> = {
  providers: { zh: '模型供应商', en: 'Model providers' },
  defaultWorkspace: { zh: '默认工作区', en: 'Default workspace' },
  integrations: { zh: '集成', en: 'Integrations' },
  users: { zh: '用户', en: 'Users' },
  runtime: { zh: '运行层', en: 'Runtime' },
};

/**
 * S8 W1-A10 (audit S14 "P-C…内部指标名…(s) 复数"): `item.detail` (`PlatformOverviewWire`) is
 * kernel-authored English prose with "(s)" plurals and, for `runtime`, the design doc's own
 * internal section number "P-C" — never rendered verbatim. This recomputes each key's meta line
 * client-side from `data.counts` (already on the wire) instead.
 *
 * `defaultWorkspace` (S8 W3 F1, leftover 85 "default workspace …" mixed-language line): W1-A10
 * left this one key reading the kernel's own `detail` verbatim — it alone carries the workspace's
 * *name*, not in `counts`. This page already loads `list_workspaces` for the residue banner
 * above, and `PlatformWorkspaceWire.isDefault` marks the same row the kernel's `detail` string
 * describes, so `defaultWorkspaceRow` (passed down from `PlatformOverviewPage`, found by
 * `isDefault`) recomputes the same message bilingually instead. `list_workspaces` is a second,
 * independent read from `platform_overview` and may still be loading when this renders —
 * `defaultWorkspaceRowsReady` distinguishes "not found because it hasn't loaded yet" (fall back to
 * the kernel's own `detail`, the pre-existing text, rather than flash a wrong "no default
 * workspace" line) from "loaded and genuinely none" (the kernel invariant says this cannot happen,
 * but the translated line is still correct if it ever does).
 */
function checklistDetail(
  item: ChecklistItem,
  counts: PlatformOverviewWire['counts'],
  defaultWorkspaceRow: PlatformWorkspaceWire | undefined,
  defaultWorkspaceRowsReady: boolean,
  t: Translate,
): string {
  switch (item.key) {
    case 'providers':
      return item.done
        ? t(`${counts.modelsAvailable} 个可用模型`, `${counts.modelsAvailable} model(s) available`)
        : t(
            '还没有可用模型——请在主机上配置模型供应商',
            'No model available yet — configure a provider on the host',
          );
    case 'integrations':
      return item.done
        ? t(
            `已接入 ${counts.gatekeepers} 个门实例`,
            `${counts.gatekeepers} gatekeeper(s) registered`,
          )
        : t('还没有接入任何系统', 'No system connected yet');
    case 'users':
      return item.done
        ? t(`已有 ${counts.activeUsers} 个活跃用户`, `${counts.activeUsers} active user(s)`)
        : t('目前只有管理员——去创建用户', 'Only the administrator so far — create users');
    case 'runtime':
      return t(
        'pi / 运行时镜像一致性由 CI 检查',
        'pi / runtime image consistency is enforced by CI',
      );
    case 'defaultWorkspace':
      if (defaultWorkspaceRow) {
        return t(
          `默认工作区「${defaultWorkspaceRow.name}」${defaultWorkspaceRow.status === 'active' ? '' : '（已停用）'}`,
          `default workspace "${defaultWorkspaceRow.name}"${defaultWorkspaceRow.status === 'active' ? '' : ' (disabled)'}`,
        );
      }
      return defaultWorkspaceRowsReady
        ? t(
            '还没有默认工作区——请在平台设置中选择一个',
            'No default workspace — pick one in platform settings',
          )
        : item.detail;
  }
}

/** `ChecklistItemWire.key` → where "前往 Go" sends the admin. `providers` and `runtime` have no
 *  page of their own yet (providers is host-configured; runtime is a later P-A wave) — see this
 *  component's own render for their fallback text. */
const CHECKLIST_LINKS: Readonly<Partial<Record<ChecklistItem['key'], string>>> = {
  defaultWorkspace: hrefs.platformSettings(),
  integrations: hrefs.systems(),
  users: hrefs.platformUsers(),
};

const HEALTH_CHIP_CLASS: Readonly<Record<ServiceHealth['status'], string>> = {
  ok: 'chip-ok',
  degraded: 'chip-warn',
  down: 'chip-danger',
  unknown: 'chip-neutral',
};

/**
 * components/platform/PlatformOverviewPage: 概览 Overview (`/platform/overview`, design doc §6.7)
 * — the administrator's landing page: kernel version/migrations, the first-run checklist (live
 * page state, never a wizard — §4), user/workspace/gatekeeper/model counts, a service-health
 * summary, and the most recent platform audit rows. Reachable only for `platformRole === 'admin'`
 * (gated one level up, in `App.tsx`'s `Routed`) — a session with zero workspace memberships still
 * lands here (`selectedWorkspaceId` undefined), so this page calls only `http` (`scope:'platform'`
 * capabilities ignore the workspace header entirely), never `session.ws`.
 *
 * `counts.pendingActivationUsers > 0` also surfaces `BindApiKeyForm` (S4.1 revised, shared with
 * the old `NoWorkspacePage`) — the "已有部署一次点击接管" path (§3.7): an admin binds a
 * pre-existing API key's workspace membership onto this account without leaving the overview. A
 * successful bind both re-reads this page (the checklist and the pending-activation count change)
 * and, via `onKeyBound`, refreshes the session itself.
 *
 * S6-A A1 / A6 (§5.9 "页面对照原型 — 控制塔 … 验收残留横幅"): the residue banner reads the
 * **unfiltered** `list_workspaces` (the only read that sees disabled and expired rows at once)
 * and counts `isResidueWorkspace` — the same predicate the workspaces page's residue preset
 * applies — linking to `#/platform/workspaces?residue=1`. A failed read simply shows no banner;
 * the version card is `platform_overview.version.kernel` (B1's real value lives in the kernel).
 *
 * S8 W2 U3a (ui-audit-2026-09-23 O1, §5.9 控制塔 "待处理 / 运行中 / 图谱新鲜度 / 费用四指标、
 * 「需要人处理」列表"): implemented against **only** capabilities that already exist — F6 forbids
 * a kernel change in this lane. `platform_status`'s 30-day cross-workspace `llmUsage30d` backs
 * "费用"; "需要人处理" is composed client-side from data `platform_overview` already returns
 * (degraded/down `health` entries, `counts.pendingActivationUsers`) — no extra read. "待处理"
 * (a cross-workspace pending-ActionRequest count), "运行中" (a cross-workspace running-Task
 * count) and "图谱新鲜度" (`ops.collector_silent`, computed server-side but not exposed by any
 * capability today — B1/G1's own audit rows) have no existing source and are intentionally not
 * rendered — see this lane's PR report for the gap list, never a fake zero or a "—" standing in
 * for real data.
 */
export function PlatformOverviewPage({ http, onKeyBound }: PlatformOverviewPageProps) {
  const t = useT();
  const overview = useCapability<PlatformOverviewWire>(http, 'platform_overview');
  const workspaces = useCapabilityList<PlatformWorkspaceWire>(http, 'list_workspaces');
  const status = useCapability<PlatformStatusWire>(http, 'platform_status');
  const residue =
    workspaces.state.status === 'ready'
      ? workspaces.state.data.items.filter((row) => isResidueWorkspace(row))
      : [];
  const defaultWorkspaceRow =
    workspaces.state.status === 'ready'
      ? workspaces.state.data.items.find((row) => row.isDefault)
      : undefined;

  return (
    <div className="page">
      <PageHeader
        breadcrumb={breadcrumbFor('platformOverview')}
        title={t('概览', 'Overview')}
        description={t(
          '内核版本、服务健康、首次运行清单与最近的平台审计。',
          'Kernel version, service health, the first-run checklist, and recent platform audit.',
        )}
      />
      {residue.length > 0 ? (
        <Notice tone="warn" testId="platform-residue-banner">
          {t(
            `验收残留 ${residue.length} 个工作区待清除（已停用或已到期的临时工作区）。`,
            `${residue.length} workspace(s) of acceptance residue await purging (disabled, or ephemeral past expiry).`,
          )}{' '}
          <a href={residueWorkspacesHref()} data-testid="platform-residue-link">
            {t('去清理', 'Review and purge')}
          </a>
        </Notice>
      ) : null}
      {overview.state.status === 'loading' ? (
        <SkeletonRows
          count={4}
          label={t('正在加载概览…', 'Loading overview')}
          testId="platform-overview-loading"
        />
      ) : overview.state.status === 'error' ? (
        <ErrorBanner
          error={overview.state.error}
          title={t('无法加载平台概览', 'Could not load the platform overview')}
          onRetry={() => void overview.reload()}
          testId="platform-overview-error"
        />
      ) : (
        <PlatformOverviewBody
          data={overview.state.data}
          status={status}
          defaultWorkspaceRow={defaultWorkspaceRow}
          defaultWorkspaceRowsReady={workspaces.state.status === 'ready'}
          onKeyBound={(result) => {
            onKeyBound?.(result);
            void overview.reload();
          }}
        />
      )}
    </div>
  );
}

function PlatformOverviewBody({
  data,
  status,
  defaultWorkspaceRow,
  defaultWorkspaceRowsReady,
  onKeyBound,
}: {
  readonly data: PlatformOverviewWire;
  readonly status: Resource<PlatformStatusWire>;
  readonly defaultWorkspaceRow: PlatformWorkspaceWire | undefined;
  readonly defaultWorkspaceRowsReady: boolean;
  readonly onKeyBound: (result: MeResult) => void;
}) {
  const t = useT();
  const attentionItems = buildAttentionItems(data, t);
  return (
    <>
      <DashboardCard title={t('需要人处理', 'Needs attention')} padded={false}>
        {attentionItems.length === 0 ? (
          <EmptyState
            icon="check"
            title={t('没有需要人工处理的事项', 'Nothing needs attention right now')}
            testId="platform-attention-empty"
          />
        ) : (
          <DataList ariaLabel="Needs attention" testId="platform-attention-items">
            {attentionItems.map((item) => (
              <DataRow
                key={item.key}
                testId="platform-attention-item"
                leading={<Icon name="alert" label={t('待处理', 'To do')} />}
                title={item.title}
                trailing={
                  <a href={item.href} className="inline-flex min-h-9 items-center">
                    {t('前往', 'Go')}
                  </a>
                }
              />
            ))}
          </DataList>
        )}
      </DashboardCard>

      <DashboardCard title={t('版本', 'Version')}>
        <dl className="definition-list">
          <dt>Kernel</dt>
          <dd>{data.version.kernel}</dd>
          <dt>{t('已应用迁移', 'Migrations applied')}</dt>
          <dd>{data.version.migrationsApplied}</dd>
          <dt>{t('最新迁移', 'Latest migration')}</dt>
          <dd>{data.version.latestMigration ?? '—'}</dd>
        </dl>
      </DashboardCard>

      <DashboardCard title={t('开始使用', 'Getting started')} padded={false}>
        <DataList ariaLabel="Getting started checklist" testId="platform-checklist">
          {data.checklist.map((item) => (
            <DataRow
              key={item.key}
              testId="platform-checklist-item"
              leading={
                <Icon
                  name={item.done ? 'check' : 'clock'}
                  label={item.done ? t('已完成', 'Done') : t('待完成', 'To do')}
                />
              }
              title={t(CHECKLIST_LABELS[item.key].zh, CHECKLIST_LABELS[item.key].en)}
              meta={checklistDetail(
                item,
                data.counts,
                defaultWorkspaceRow,
                defaultWorkspaceRowsReady,
                t,
              )}
              trailing={checklistTrailing(item, t)}
            />
          ))}
        </DataList>
      </DashboardCard>

      <div className="platform-tiles" data-testid="platform-counts">
        <CountTile
          testId="platform-count-users"
          label={t('用户', 'Users')}
          value={data.counts.users}
        />
        <CountTile
          testId="platform-count-workspaces"
          label={t('工作区', 'Workspaces')}
          value={data.counts.workspaces}
        />
        <CountTile
          testId="platform-count-gatekeepers"
          label={t('门实例', 'Gatekeepers')}
          value={data.counts.gatekeepers}
        />
        <CountTile
          testId="platform-count-models"
          label={t('可用模型', 'Models available')}
          value={data.counts.modelsAvailable}
        />
      </div>

      <DashboardCard title={t('服务健康', 'Health')}>
        <div className="row-wrap" data-testid="platform-health">
          {data.health.map((entry) => (
            <span
              key={entry.service}
              className={`chip ${HEALTH_CHIP_CLASS[entry.status]}`}
              title={entry.detail ?? entry.status}
              data-testid="platform-health-chip"
            >
              {entry.service}: {entry.status}
            </span>
          ))}
        </div>
      </DashboardCard>

      <CostCard status={status} />

      <DashboardCard
        title={t('最近平台审计', 'Recent platform audit')}
        actions={<a href={hrefs.platformAudit()}>{t('查看全部', 'View all')}</a>}
        padded={false}
      >
        {data.recentAudit.length === 0 ? (
          <EmptyState
            icon="search"
            title={t('暂无平台审计', 'No platform audit rows yet')}
            testId="platform-overview-audit-empty"
          />
        ) : (
          <DataList ariaLabel="Recent platform audit" testId="platform-overview-audit">
            {data.recentAudit.map((row) => (
              <DataRow
                key={row.id}
                testId="platform-overview-audit-row"
                title={row.action}
                meta={`${formatAuditActor(row, t)} · ${formatDateTime(row.createdAt)}`}
              />
            ))}
          </DataList>
        )}
      </DashboardCard>

      {data.counts.pendingActivationUsers > 0 ? <BindApiKeyForm onBound={onKeyBound} /> : null}
    </>
  );
}

interface AttentionItem {
  readonly key: string;
  readonly title: string;
  readonly href: string;
}

/** O1's "需要人处理" list — composed client-side from `platform_overview`'s own `health` and
 *  `counts`, never a separate read (see this file's own module doc comment for why). A degraded
 *  or down service and a pending-activation user count are both already surfaced elsewhere on
 *  this page (the health chips, the checklist's `users` row) — this list exists to pull the ones
 *  that need a *decision*, not just a status, into one place. */
function buildAttentionItems(data: PlatformOverviewWire, t: Translate): readonly AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const entry of data.health) {
    if (entry.status !== 'degraded' && entry.status !== 'down') continue;
    items.push({
      key: `health-${entry.service}`,
      title:
        entry.status === 'down'
          ? t(`${entry.service} 服务离线`, `${entry.service} is down`)
          : t(`${entry.service} 服务异常`, `${entry.service} is degraded`),
      href: hrefs.platformStatus(),
    });
  }
  if (data.counts.pendingActivationUsers > 0) {
    items.push({
      key: 'pending-activation',
      title: t(
        `${data.counts.pendingActivationUsers} 位用户待激活`,
        `${data.counts.pendingActivationUsers} user(s) awaiting activation`,
      ),
      href: hrefs.platformUsers(),
    });
  }
  return items;
}

/** O1's "费用" metric — `platform_status`'s 30-day cross-workspace `llmUsage30d` rollup (the one
 *  existing capability read this lane found backing any of §5.9's four metrics — see this file's
 *  own module doc comment for "待处理" / "运行中" / "图谱新鲜度", which have none). A separate
 *  `useCapability` from `platform_overview`'s own, so a `platform_status` failure degrades only
 *  this one card, never the whole page. */
function CostCard({ status }: { readonly status: Resource<PlatformStatusWire> }) {
  const t = useT();
  return (
    <DashboardCard
      title={t('费用（近 30 天）', 'Cost (30d)')}
      actions={<a href={hrefs.platformStatus()}>{t('查看详情', 'View details')}</a>}
    >
      {status.state.status === 'loading' ? (
        <SkeletonRows
          count={1}
          label={t('正在加载费用…', 'Loading cost')}
          testId="platform-cost-loading"
        />
      ) : status.state.status === 'error' ? (
        <ErrorBanner
          error={status.state.error}
          title={t('无法加载费用', 'Could not load cost')}
          onRetry={() => void status.reload()}
          testId="platform-cost-error"
        />
      ) : (
        <dl className="definition-list" data-testid="platform-cost">
          <dt>{t('调用次数', 'Calls')}</dt>
          <dd>{status.state.data.llmUsage30d.callCount}</dd>
          <dt>{t('输入 tokens', 'Input tokens')}</dt>
          <dd>{status.state.data.llmUsage30d.totalInputTokens}</dd>
          <dt>{t('输出 tokens', 'Output tokens')}</dt>
          <dd>{status.state.data.llmUsage30d.totalOutputTokens}</dd>
          <dt>{t('费用', 'Cost')}</dt>
          <dd data-testid="platform-cost-value">
            {status.state.data.llmUsage30d.totalCostUsd !== null
              ? `$${status.state.data.llmUsage30d.totalCostUsd.toFixed(2)}`
              : t('无费用记录', 'No cost recorded')}
          </dd>
        </dl>
      )}
    </DashboardCard>
  );
}

function checklistTrailing(item: ChecklistItem, t: Translate) {
  const href = CHECKLIST_LINKS[item.key];
  // S8 W1-A8 (audit S6): a bare `<a>` here rendered a 45×21 hit area, under the §5.9 principle-6
  // 36px floor. `inline-flex min-h-9 items-center` is the same already-generated Tailwind
  // utility trio `kit/page-header.tsx`'s breadcrumb link uses for the identical problem — reused
  // here rather than adding a one-off CSS rule, since the classes exist in the build either way.
  if (href) {
    return (
      <a href={href} className="inline-flex min-h-9 items-center">
        {t('前往', 'Go')}
      </a>
    );
  }
  if (item.key === 'providers') {
    return (
      <span className="text-3 text-small">{t('当前经主机配置', 'Configured on the host')}</span>
    );
  }
  return undefined;
}

function CountTile({
  testId,
  label,
  value,
}: {
  readonly testId: string;
  readonly label: string;
  readonly value: number;
}) {
  return (
    <div className="card platform-tile" data-testid={testId}>
      <div className="platform-tile-label">{label}</div>
      <div className="platform-tile-value">{value}</div>
    </div>
  );
}
