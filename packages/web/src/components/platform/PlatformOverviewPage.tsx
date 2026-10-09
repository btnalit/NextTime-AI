import type {
  GateInstanceWire,
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
import { type ProviderStatusKind, describeProviderHealth } from '../../lib/provider-status.js';
import { hrefs } from '../../lib/router.js';
import { BindApiKeyForm } from '../BindApiKeyForm.js';
import { EmptyState as KitEmptyState } from '../kit/empty-state.js';
import { KeyValue } from '../kit/key-value.js';
import { PageHeader } from '../kit/page-header.js';
import { DashboardCard } from '../kit/section.js';
import { DataList, DataRow } from '../ui/DataList.js';
import { EmptyState } from '../ui/EmptyState.js';
import { ErrorBanner } from '../ui/ErrorBanner.js';
import { Icon, type IconName } from '../ui/Icon.js';
import { Notice } from '../ui/Notice.js';
import { SkeletonRows } from '../ui/Skeleton.js';
import { UpdateReminder } from './UpdateReminder.js';

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
  providerHealthFile: PlatformOverviewWire['providerHealthFile'],
  defaultWorkspaceRow: PlatformWorkspaceWire | undefined,
  defaultWorkspaceRowsReady: boolean,
  t: Translate,
): string {
  switch (item.key) {
    case 'providers':
      if (item.done) {
        return t(
          `${counts.modelsAvailable} 个可用模型`,
          `${counts.modelsAvailable} model(s) available`,
        );
      }
      // Review M1: no readable health file — unknown, never available; the log says why.
      if (counts.modelsConfigured > 0 && providerHealthFile !== 'ok') {
        return t(
          `已配置 ${counts.modelsConfigured} 个模型，但没读到供应商状态（llm-proxy 没写出状态文件，看它的日志）`,
          `${counts.modelsConfigured} model(s) configured, but the provider status could not be read (llm-proxy has not written its status file; check its log)`,
        );
      }
      // Audit P0-2: models configured but none whose provider passed a test is not "no provider".
      return counts.modelsConfigured > 0
        ? t(
            `已配置 ${counts.modelsConfigured} 个模型，但没有一个供应商测试通过——去测试或修复`,
            `${counts.modelsConfigured} model(s) configured, but no provider has passed a test — test or fix it`,
          )
        : t(
            '还没有模型供应商——在控制台添加一个（DeepSeek、Anthropic、OpenAI 等），填上密钥即可',
            'No model provider yet — add one in the console (DeepSeek, Anthropic, OpenAI, …); a key is all it needs',
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

/** `ChecklistItemWire.key` → where "前往 Go" sends the admin. `runtime` has no page of its own yet
 *  (a later wave) — see this component's own render for its fallback text. `providers` used to be
 *  host-only (`llm-providers.yaml`) and had no link either; S7-A let the console write a provider's
 *  key too (ui-audit O2 "过期文案"), so it now points at 模型与供应商 like every other item. */
const CHECKLIST_LINKS: Readonly<Partial<Record<ChecklistItem['key'], string>>> = {
  providers: hrefs.platformModels(),
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
 * S10 U1: `UpdateReminder` sits above the residue banner — a newer platform release / pi, or a
 * stale version feed (its own `platform_updates` read; a loading or failed read shows nothing).
 *
 * S8 W2 U3a (ui-audit-2026-09-23 O1, §5.9 控制塔 "待处理 / 运行中 / 图谱新鲜度 / 费用四指标、
 * 「需要人处理」列表"): `platform_status`的 30-day cross-workspace `llmUsage30d` backs "费用"；
 * "需要人处理" 由 `platform_overview` 已有的数据在客户端拼出（`health` 里的 degraded/down 条目、
 * `counts.pendingActivationUsers`）——不额外发起读。
 *
 * S8 W4-C (本车道补上的缺口): "待处理" / "运行中" / "图谱新鲜度" 现在直接来自
 * `platform_overview.counts.pendingActionRequests` / `runningTasks` / `graphFreshness`——
 * `platform-handlers.ts` 自己的按工作区循环（`computeCrossWorkspaceOverview`），限定在与
 * `gatekeepers` 同一个已排除验收残留的工作区集合上（ui-audit O3）。`graphFreshness.staleSourceCount`
 * 为 0 即读作"全部新鲜"——读成功后这个字段总是存在，不是给不存在的能力占位的 "—"。
 *
 * S8 W4-C (ui-audit O3 "计数与列表同口径，残留单独显示"): 工作区 卡片显示
 * `nonResidueWorkspaceCount`——由这里已经在读的、未过滤的 `list_workspaces`（残留横幅同一份数据）
 * 就地算出（`items.length - residue.length`），不是内核原始的 `counts.workspaces`——与工作区页
 * 默认（隐藏残留）视图的计数口径一致，残留只在横幅里单独出现。`counts.gatekeepers` 已在服务端
 * 排除残留（同一车道）；`counts.users` 仍统计全部用户（含验收残留的待激活账户）——要收窄它需要
 * 这个页面目前不发起的 `list_users` 读，留作后续（见本车道的 PR 报告）。
 *
 * S8 W4-C (ui-audit L1 "两段式"): 下面的 body 先渲染控制塔指标 + 服务健康 + 需要人处理，再是
 * 视觉上次要的区域（版本 / 开始使用 / 最近平台审计，审计最多 5 行）——绑定 API key 留在最后，
 * 已经不在第一屏视线里。
 */
export function PlatformOverviewPage({ http, onKeyBound }: PlatformOverviewPageProps) {
  const t = useT();
  const overview = useCapability<PlatformOverviewWire>(http, 'platform_overview');
  const workspaces = useCapabilityList<PlatformWorkspaceWire>(http, 'list_workspaces');
  const status = useCapability<PlatformStatusWire>(http, 'platform_status');
  // Audit P0-4: gate instances discovered but never enabled are a decision only an administrator
  // can make, so they belong in 需要人处理. A separate read like `list_workspaces` above: a failure
  // just leaves them out of the list.
  const gateInstances = useCapabilityList<GateInstanceWire>(
    http,
    'list_gate_instances',
    DISCOVERED_GATE_INSTANCES,
  );
  const discoveredGates =
    gateInstances.state.status === 'ready' ? gateInstances.state.data.items : [];
  const residue =
    workspaces.state.status === 'ready'
      ? workspaces.state.data.items.filter((row) => isResidueWorkspace(row))
      : [];
  const defaultWorkspaceRow =
    workspaces.state.status === 'ready'
      ? workspaces.state.data.items.find((row) => row.isDefault)
      : undefined;
  // ui-audit O3: the same unfiltered read the residue banner above already counts — see this
  // file's own module doc comment.
  const nonResidueWorkspaceCount =
    workspaces.state.status === 'ready'
      ? workspaces.state.data.items.length - residue.length
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
      <UpdateReminder http={http} />
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
          discoveredGates={discoveredGates}
          nonResidueWorkspaceCount={nonResidueWorkspaceCount}
          onKeyBound={(result) => {
            onKeyBound?.(result);
            void overview.reload();
          }}
        />
      )}
    </div>
  );
}

const RECENT_AUDIT_LIMIT = 5;
const DISCOVERED_GATE_INSTANCES: Readonly<Record<string, unknown>> = { status: 'discovered' };

function PlatformOverviewBody({
  data,
  status,
  defaultWorkspaceRow,
  defaultWorkspaceRowsReady,
  discoveredGates,
  nonResidueWorkspaceCount,
  onKeyBound,
}: {
  readonly data: PlatformOverviewWire;
  readonly status: Resource<PlatformStatusWire>;
  readonly defaultWorkspaceRow: PlatformWorkspaceWire | undefined;
  readonly defaultWorkspaceRowsReady: boolean;
  /** Gate instances that announced themselves but were never enabled (audit P0-4). */
  readonly discoveredGates: readonly GateInstanceWire[];
  /** ui-audit O3 — `undefined` while `list_workspaces` is still loading; falls back to the
   *  kernel's raw `counts.workspaces` for that one frame (see this file's own module doc
   *  comment). */
  readonly nonResidueWorkspaceCount: number | undefined;
  readonly onKeyBound: (result: MeResult) => void;
}) {
  const t = useT();
  const attentionItems = buildAttentionItems(data, discoveredGates, t);
  const recentAudit = data.recentAudit.slice(0, RECENT_AUDIT_LIMIT);
  return (
    <>
      {/* S8 W4-C (ui-audit L1 "两段式"): first screen — control-tower metrics, service health,
       *  cost, and 需要人处理. Everything below the `divider` (version / getting-started / recent
       *  audit) is reference material an admin checks less often. */}
      {/* V10 (docs/console-visual-p3-spec-2026-09-26.md): the empty state is one compact line, not
       *  a full-height block — `kit/empty-state`'s `inline` variant, never `ui/EmptyState`'s block
       *  card. `padded` follows suit: the empty line takes the card's normal edge padding (there is
       *  no list of rows managing its own), the populated list keeps `padded={false}` as before. */}
      <DashboardCard
        title={t('需要人处理', 'Needs attention')}
        padded={attentionItems.length === 0}
      >
        {attentionItems.length === 0 ? (
          <KitEmptyState
            icon={<Icon name="check" size="s" />}
            title={t('没有需要人工处理的事项', 'Nothing needs attention right now')}
            variant="inline"
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

      {/* ui-audit O1 / P3-6 V10: the control tower's own three activity metrics — 待处理 / 运行中 /
       *  图谱新鲜度 (费用 is `CostCard` below, a `kit/key-value` block, not a tile: it already
       *  carries four figures of its own) — and the four scale tiles (用户/工作区/门实例/可用模型),
       *  which answer "how big is this deployment", a first-screen question too, just a different
       *  one. Grouped (MihomoOrbit reference: small tinted icon tile, uppercase grey label, 24/600
       *  value) rather than seven equal-weight cards in one undifferentiated row. */}
      <div className="stack" data-testid="platform-counts">
        <div className="platform-tile-group">
          <div className="section-title">{t('运行', 'Activity')}</div>
          <div className="platform-tiles">
            <CountTile
              testId="platform-count-pending-action-requests"
              icon="approvals"
              deco="violet"
              label={t('待审批', 'Pending approvals')}
              value={data.counts.pendingActionRequests}
            />
            <CountTile
              testId="platform-count-running-tasks"
              icon="tasks"
              deco="blue"
              label={t('运行中', 'Running tasks')}
              value={data.counts.runningTasks}
            />
            <GraphFreshnessTile freshness={data.graphFreshness} t={t} />
          </div>
        </div>
        <div className="platform-tile-group">
          <div className="section-title">{t('资源', 'Scale')}</div>
          <div className="platform-tiles">
            <CountTile
              testId="platform-count-users"
              icon="badge"
              deco="indigo"
              label={t('用户', 'Users')}
              value={data.counts.users}
            />
            <CountTile
              testId="platform-count-workspaces"
              icon="grid"
              deco="pink"
              label={t('工作区', 'Workspaces')}
              value={nonResidueWorkspaceCount ?? data.counts.workspaces}
            />
            <CountTile
              testId="platform-count-gatekeepers"
              icon="shield"
              deco="blue"
              label={t('门实例', 'Gatekeepers')}
              value={data.counts.gatekeepers}
            />
            <CountTile
              testId="platform-count-models"
              icon="cpu"
              deco="violet"
              label={t('可用模型', 'Models available')}
              value={
                // Review M1: with no readable health file nothing is known to work — not "0".
                data.providerHealthFile !== 'ok' && data.counts.modelsConfigured > 0
                  ? '—'
                  : data.counts.modelsAvailable
              }
              sub={
                data.providerHealthFile !== 'ok' && data.counts.modelsConfigured > 0
                  ? t(
                      `已配置 ${data.counts.modelsConfigured} 个，状态未知`,
                      `${data.counts.modelsConfigured} configured; status unknown`,
                    )
                  : data.counts.modelsConfigured > data.counts.modelsAvailable
                    ? t(
                        `已配置 ${data.counts.modelsConfigured} 个，只计测试通过的`,
                        `${data.counts.modelsConfigured} configured; only tested ones count`,
                      )
                    : undefined
              }
            />
          </div>
        </div>
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

      <div className="divider" data-testid="platform-overview-secondary-divider" />

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
                data.providerHealthFile,
                defaultWorkspaceRow,
                defaultWorkspaceRowsReady,
                t,
              )}
              trailing={checklistTrailing(item, data.counts, t)}
            />
          ))}
        </DataList>
      </DashboardCard>

      <DashboardCard
        title={t('最近平台审计', 'Recent platform audit')}
        actions={<a href={hrefs.platformAudit()}>{t('查看全部', 'View all')}</a>}
        padded={false}
      >
        {recentAudit.length === 0 ? (
          <EmptyState
            icon="search"
            title={t('暂无平台审计', 'No platform audit rows yet')}
            testId="platform-overview-audit-empty"
          />
        ) : (
          <DataList ariaLabel="Recent platform audit" testId="platform-overview-audit">
            {recentAudit.map((row) => (
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

/** O1's "图谱新鲜度" tile — same `CountTile` shell (the big number is `staleSourceCount`, uniform
 *  with its sibling tiles), plus a small sub-line: "全部新鲜" at `0`, otherwise how many
 *  workspaces those stale sources are spread across. */
function GraphFreshnessTile({
  freshness,
  t,
}: {
  readonly freshness: PlatformOverviewWire['graphFreshness'];
  readonly t: Translate;
}) {
  const fresh = freshness.staleSourceCount === 0;
  return (
    <div className="card platform-tile" data-testid="platform-count-graph-freshness">
      <div className="platform-tile-head">
        <span className="platform-tile-icon platform-tile-icon-cyan">
          <Icon name="link" />
        </span>
        <span className="platform-tile-label">{t('图谱新鲜度', 'Graph freshness')}</span>
      </div>
      <div className="platform-tile-value" data-testid="platform-graph-freshness-value">
        {freshness.staleSourceCount}
      </div>
      <div className="text-3 text-small" data-testid="platform-graph-freshness-detail">
        {fresh
          ? t('全部新鲜', 'All fresh')
          : t(
              `陈旧 · ${freshness.affectedWorkspaceCount} 个工作区`,
              `stale · ${freshness.affectedWorkspaceCount} workspace(s)`,
            )}
      </div>
    </div>
  );
}

interface AttentionItem {
  readonly key: string;
  readonly title: string;
  readonly href: string;
}

/** O1's "需要人处理" list — composed client-side from `platform_overview`'s own `health`,
 *  `modelProviders` and `counts`, never a separate read (see this file's own module doc comment for why). A degraded
 *  or down service and a pending-activation user count are both already surfaced elsewhere on
 *  this page (the health chips, the checklist's `users` row) — this list exists to pull the ones
 *  that need a *decision*, not just a status, into one place. */
function buildAttentionItems(
  data: PlatformOverviewWire,
  discoveredGates: readonly GateInstanceWire[],
  t: Translate,
): readonly AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const gate of discoveredGates) {
    items.push({
      key: `gate-discovered-${gate.gateId}`,
      title: t(
        `门实例「${gate.displayName}」已发现，等待启用`,
        `Gate instance "${gate.displayName}" was discovered and awaits enabling`,
      ),
      href: hrefs.platformGateInstance(gate.gateId),
    });
  }
  // Review M1: models.json was read but provider-health.json was not — every provider's status is
  // unknown. One item says so; the llm-proxy health row it degrades is the same fact.
  const healthUnreadable = data.providerHealthFile !== 'ok' && data.counts.modelsConfigured > 0;
  for (const entry of data.health) {
    if (entry.status !== 'degraded' && entry.status !== 'down') continue;
    if (healthUnreadable && entry.service === 'llm-proxy' && entry.status === 'degraded') continue;
    items.push({
      key: `health-${entry.service}`,
      title:
        entry.status === 'down'
          ? t(`${entry.service} 服务离线`, `${entry.service} is down`)
          : t(`${entry.service} 服务异常`, `${entry.service} is degraded`),
      href: hrefs.platformStatus(),
    });
  }
  if (healthUnreadable) {
    items.push({
      key: 'model-provider-health-unreadable',
      title: t(
        `读不到模型供应商状态（${data.counts.modelsConfigured} 个模型状态未知）`,
        `Model provider status unreadable (${data.counts.modelsConfigured} model(s) with unknown status)`,
      ),
      href: hrefs.platformModels(),
    });
  } else {
    items.push(...providerAttentionItems(data.modelProviders, t));
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

/**
 * Audit P0-2: providers whose models a member can pick but whose calls fail, were never verified,
 * or have no status — one item per status (#530 P2: eleven single rows crowded the list), naming
 * the providers and linking straight to the one when there is only one. `disabled` is an
 * administrator's choice, not a to-do, and is not listed.
 */
function providerAttentionItems(
  providers: PlatformOverviewWire['modelProviders'],
  t: Translate,
): AttentionItem[] {
  const byStatus = new Map<ProviderStatusKind, { ids: string[]; models: number }>();
  for (const provider of providers) {
    const kind: ProviderStatusKind = provider.health?.status ?? 'unknown';
    if (kind === 'ok' || kind === 'disabled') continue;
    const group = byStatus.get(kind) ?? { ids: [], models: 0 };
    group.ids.push(provider.id);
    group.models += provider.models;
    byStatus.set(kind, group);
  }
  return [...byStatus].map(([kind, group]) => {
    const health = describeProviderHealth(kind);
    const [only] = group.ids;
    return {
      key: `model-provider-${kind}`,
      title:
        group.ids.length === 1
          ? t(
              `模型供应商「${only}」${health.zh}（${group.models} 个模型）`,
              `Model provider "${only}": ${health.en} (${group.models} model(s))`,
            )
          : t(
              `${health.zh}：${group.ids.length} 个模型供应商（${group.ids.join('、')}），共 ${group.models} 个模型`,
              `${health.en}: ${group.ids.length} model providers (${group.ids.join(', ')}), ${group.models} model(s)`,
            ),
      href:
        only !== undefined && group.ids.length === 1
          ? hrefs.platformModelsProvider(only)
          : hrefs.platformModels(),
    };
  });
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
        <KeyValue
          testId="platform-cost"
          items={[
            {
              key: 'calls',
              label: t('调用次数', 'Calls'),
              value: status.state.data.llmUsage30d.callCount,
            },
            {
              key: 'input',
              label: t('输入 tokens', 'Input tokens'),
              value: status.state.data.llmUsage30d.totalInputTokens,
            },
            {
              key: 'output',
              label: t('输出 tokens', 'Output tokens'),
              value: status.state.data.llmUsage30d.totalOutputTokens,
            },
            {
              key: 'cost',
              label: t('费用', 'Cost'),
              value: (
                <span data-testid="platform-cost-value">
                  {status.state.data.llmUsage30d.totalCostUsd !== null
                    ? `$${status.state.data.llmUsage30d.totalCostUsd.toFixed(2)}`
                    : t('无费用记录', 'No cost recorded')}
                </span>
              ),
            },
          ]}
        />
      )}
    </DashboardCard>
  );
}

function checklistTrailing(
  item: ChecklistItem,
  counts: PlatformOverviewWire['counts'],
  t: Translate,
) {
  // Audit P0-2: models configured but none whose provider passed a test — the providers table,
  // where 测试 is, not a new provider.
  if (item.key === 'providers' && !item.done && counts.modelsConfigured > 0) {
    return (
      <a
        href={hrefs.platformModels()}
        className="inline-flex min-h-9 items-center"
        data-testid="checklist-test-provider"
      >
        {t('去测试供应商', 'Test the providers')}
      </a>
    );
  }
  // Audit P0-3: an undone 模型供应商 step opens 新增供应商 directly, named as what it does.
  if (item.key === 'providers' && !item.done) {
    return (
      <a
        href={hrefs.platformModelsNewProvider()}
        className="inline-flex min-h-9 items-center"
        data-testid="checklist-add-provider"
      >
        {t('添加供应商', 'Add a provider')}
      </a>
    );
  }
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
  return undefined;
}

/** The five decorative (never governance) icon-tile hues P3-6 added — `tokens.css`'s `--deco-*`. */
type TileDeco = 'blue' | 'violet' | 'pink' | 'cyan' | 'indigo';

function CountTile({
  testId,
  icon,
  deco,
  label,
  value,
  sub,
}: {
  readonly testId: string;
  readonly icon: IconName;
  readonly deco: TileDeco;
  readonly label: string;
  readonly value: number | string;
  /** A line under the value qualifying it. */
  readonly sub?: string;
}) {
  return (
    <div className="card platform-tile" data-testid={testId}>
      <div className="platform-tile-head">
        <span className={`platform-tile-icon platform-tile-icon-${deco}`}>
          <Icon name={icon} />
        </span>
        <span className="platform-tile-label">{label}</span>
      </div>
      <div className="platform-tile-value">{value}</div>
      {sub !== undefined ? (
        <div className="text-3 text-small" data-testid={`${testId}-sub`}>
          {sub}
        </div>
      ) : null}
    </div>
  );
}
