import type { PlatformOverviewWire } from '@nexttime/shared';
import { useCapability } from '../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { formatDateTime } from '../../lib/format.js';
import { hrefs } from '../../lib/router.js';
import { BindApiKeyForm } from '../BindApiKeyForm.js';
import { Card } from '../ui/Card.js';
import { DataList, DataRow } from '../ui/DataList.js';
import { EmptyState } from '../ui/EmptyState.js';
import { ErrorBanner } from '../ui/ErrorBanner.js';
import { Icon } from '../ui/Icon.js';
import { PageHeader } from '../ui/PageHeader.js';
import { SkeletonRows } from '../ui/Skeleton.js';

export interface PlatformOverviewPageProps {
  readonly http: CapabilityCaller;
}

type ChecklistItem = PlatformOverviewWire['checklist'][number];
type ServiceHealth = PlatformOverviewWire['health'][number];

/** `ChecklistItemWire.key` → bilingual label (design doc §4's five first-run steps). */
const CHECKLIST_LABELS: Readonly<Record<ChecklistItem['key'], string>> = {
  providers: '模型供应商 Model providers',
  defaultWorkspace: '默认工作区 Default workspace',
  integrations: '集成 Integrations',
  users: '用户 Users',
  runtime: '运行层 Runtime',
};

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
 * pre-existing API key's workspace membership onto this account without leaving the overview.
 */
export function PlatformOverviewPage({ http }: PlatformOverviewPageProps) {
  const overview = useCapability<PlatformOverviewWire>(http, 'platform_overview');

  return (
    <div className="page">
      <PageHeader
        title="概览 Overview"
        description="Kernel version, service health, the first-run checklist, and recent platform audit."
      />
      {overview.state.status === 'loading' ? (
        <SkeletonRows count={4} label="Loading overview" testId="platform-overview-loading" />
      ) : overview.state.status === 'error' ? (
        <ErrorBanner
          error={overview.state.error}
          title="Could not load the platform overview"
          onRetry={() => void overview.reload()}
          testId="platform-overview-error"
        />
      ) : (
        <PlatformOverviewBody
          data={overview.state.data}
          onKeyBound={() => void overview.reload()}
        />
      )}
    </div>
  );
}

function PlatformOverviewBody({
  data,
  onKeyBound,
}: {
  readonly data: PlatformOverviewWire;
  readonly onKeyBound: () => void;
}) {
  return (
    <>
      <Card title="版本 Version">
        <dl className="definition-list">
          <dt>Kernel</dt>
          <dd>{data.version.kernel}</dd>
          <dt>已应用迁移 Migrations applied</dt>
          <dd>{data.version.migrationsApplied}</dd>
          <dt>最新迁移 Latest migration</dt>
          <dd>{data.version.latestMigration ?? '—'}</dd>
        </dl>
      </Card>

      <Card title="开始使用 Getting started" padded={false}>
        <DataList ariaLabel="Getting started checklist" testId="platform-checklist">
          {data.checklist.map((item) => (
            <DataRow
              key={item.key}
              testId="platform-checklist-item"
              leading={
                <Icon
                  name={item.done ? 'check' : 'clock'}
                  label={item.done ? '已完成 Done' : '待完成 To do'}
                />
              }
              title={CHECKLIST_LABELS[item.key]}
              meta={item.detail}
              trailing={checklistTrailing(item)}
            />
          ))}
        </DataList>
      </Card>

      <div className="platform-tiles" data-testid="platform-counts">
        <CountTile testId="platform-count-users" label="用户 Users" value={data.counts.users} />
        <CountTile
          testId="platform-count-workspaces"
          label="工作区 Workspaces"
          value={data.counts.workspaces}
        />
        <CountTile
          testId="platform-count-gatekeepers"
          label="门实例 Gatekeepers"
          value={data.counts.gatekeepers}
        />
        <CountTile
          testId="platform-count-models"
          label="可用模型 Models available"
          value={data.counts.modelsAvailable}
        />
      </div>

      <Card title="服务健康 Health">
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
      </Card>

      <Card
        title="最近平台审计 Recent platform audit"
        actions={<a href={hrefs.platformAudit()}>查看全部 View all</a>}
        padded={false}
      >
        {data.recentAudit.length === 0 ? (
          <EmptyState
            icon="search"
            title="暂无平台审计 No platform audit rows yet"
            testId="platform-overview-audit-empty"
          />
        ) : (
          <DataList ariaLabel="Recent platform audit" testId="platform-overview-audit">
            {data.recentAudit.map((row) => (
              <DataRow
                key={row.id}
                testId="platform-overview-audit-row"
                title={row.action}
                meta={`${row.actorLogin ?? row.actorUserId} · ${formatDateTime(row.createdAt)}`}
              />
            ))}
          </DataList>
        )}
      </Card>

      {data.counts.pendingActivationUsers > 0 ? <BindApiKeyForm onBound={onKeyBound} /> : null}
    </>
  );
}

function checklistTrailing(item: ChecklistItem) {
  const href = CHECKLIST_LINKS[item.key];
  if (href) return <a href={href}>前往 Go</a>;
  if (item.key === 'providers') {
    return <span className="text-3 text-small">当前经主机配置 Configured on the host</span>;
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
