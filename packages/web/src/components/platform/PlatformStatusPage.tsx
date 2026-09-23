import type { PlatformStatusWire } from '@nexttime/shared';
import { useEffect } from 'react';
import { useCapability } from '../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { formatAuditActor, formatDateTime } from '../../lib/format.js';
import { hrefs } from '../../lib/router.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { DataList, DataRow } from '../ui/DataList.js';
import { EmptyState } from '../ui/EmptyState.js';
import { ErrorBanner } from '../ui/ErrorBanner.js';
import { PageHeader } from '../ui/PageHeader.js';
import { SkeletonRows } from '../ui/Skeleton.js';
import { StatusChip } from '../ui/StatusChip.js';

export interface PlatformStatusPageProps {
  readonly http: CapabilityCaller;
}

/** design §9 P-C: "a stopped gate turns red within 30 s" — the page's own poll interval, not a
 *  push subscription (`platform_status` has no push kind of its own; every other governance page
 *  reload-on-push wires into `actionPending`/`actionUpdated`/`taskUpdated`, none of which fire for
 *  a service health flip). */
const AUTO_REFRESH_MS = 30_000;

/**
 * components/platform/PlatformStatusPage: 运行状态 Status (`#/platform/status`, admin, read-only
 * — design doc §6.7) — `platform_status`: service health (kernel/postgres probed in-process;
 * llm-proxy/worker-supervisor via a 2s healthz probe; egress-proxy always `unknown`, loopback-only
 * by design; each `list_gate_instances` gate's last-checked health, not re-probed here), the
 * backup item (honestly "未配置" until 遗留 6 lands — E4, never a stubbed timer), a 30-day
 * cross-workspace llm_usage rollup, and the last 50 platform audit rows (same row rendering as
 * `PlatformAuditPage`, via `formatAuditActor`).
 *
 * Auto-refreshes every 30s while the tab is visible (design §9 P-C's own acceptance line) — paused
 * on `document.visibilityState !== 'visible'` and resumed (with an immediate reload, so switching
 * back never waits out a stale half-interval) on return; a manual 刷新 Refresh button covers the
 * rest. Uses `useCapability`'s own `reload()` (kept fresh via a ref so the interval's identity
 * never has to be rebuilt on every render) rather than a new capability-polling hook — this page is
 * the only place platform_status is read.
 */
export function PlatformStatusPage({ http }: PlatformStatusPageProps) {
  const status = useCapability<PlatformStatusWire>(http, 'platform_status');
  const reload = status.reload;

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    function start(): void {
      if (timer !== undefined) return;
      timer = setInterval(() => void reload(), AUTO_REFRESH_MS);
    }
    function stop(): void {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    }
    function onVisibilityChange(): void {
      if (document.visibilityState === 'visible') {
        void reload();
        start();
      } else {
        stop();
      }
    }
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [reload]);

  return (
    <div className="page" data-testid="platform-status-page">
      <PageHeader
        breadcrumb={[{ label: '平台 Platform' }, { label: '运行状态' }]}
        title="运行状态 Status"
        description="哪个服务不健康、队列积压、备份多久了。 Which service is unhealthy, and how stale the backup is — auto-refreshes every 30s while this tab is visible."
        actions={
          <Button
            variant="ghost"
            icon="refresh"
            onClick={() => void status.reload()}
            loading={status.state.status === 'ready' && status.state.refreshing}
            data-testid="status-refresh"
          >
            刷新 Refresh
          </Button>
        }
      />

      {status.state.status === 'loading' ? (
        <SkeletonRows count={4} label="Loading platform status" testId="status-loading" />
      ) : status.state.status === 'error' ? (
        <ErrorBanner
          error={status.state.error}
          title="Could not load the platform status"
          onRetry={() => void status.reload()}
          testId="status-error"
        />
      ) : (
        <StatusBody data={status.state.data} />
      )}
    </div>
  );
}

function StatusBody({ data }: { readonly data: PlatformStatusWire }) {
  return (
    <>
      <Card title="服务健康 Health">
        <div className="row-wrap" data-testid="status-health">
          {data.health.map((entry) => (
            <span key={entry.service} className="row" title={entry.detail ?? entry.status}>
              <StatusChip
                machine="serviceHealth"
                status={entry.status}
                size="s"
                testId="status-health-chip"
              />
              <span className="text-small">{entry.service}</span>
            </span>
          ))}
        </div>
      </Card>

      <Card title="备份 Backup">
        <p className="text-2" data-testid="status-backup">
          {data.backup.configured ? '已配置 Configured' : '未配置 Not configured'} —{' '}
          {data.backup.detail}
        </p>
      </Card>

      <Card title="30 天用量 30-day usage">
        <dl className="definition-list" data-testid="status-llm-usage">
          <dt>调用次数 Calls</dt>
          <dd>{data.llmUsage30d.callCount}</dd>
          <dt>输入 tokens Input tokens</dt>
          <dd>{data.llmUsage30d.totalInputTokens}</dd>
          <dt>输出 tokens Output tokens</dt>
          <dd>{data.llmUsage30d.totalOutputTokens}</dd>
          <dt>费用 Cost</dt>
          <dd>
            {data.llmUsage30d.totalCostUsd !== null
              ? `$${data.llmUsage30d.totalCostUsd.toFixed(2)}`
              : '—'}
          </dd>
        </dl>
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
            testId="status-audit-empty"
          />
        ) : (
          <DataList ariaLabel="Recent platform audit" testId="status-audit-list">
            {data.recentAudit.map((row) => (
              <DataRow
                key={row.id}
                testId="status-audit-row"
                title={row.action}
                meta={`${formatAuditActor(row)} · ${formatDateTime(row.createdAt)}`}
              />
            ))}
          </DataList>
        )}
      </Card>
    </>
  );
}
