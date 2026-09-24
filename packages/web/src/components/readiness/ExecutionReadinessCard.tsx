import type { ExecutionReadinessWire } from '@nexttime/shared';
import type { CapabilityCaller } from '../../lib/clients.js';
import { useT } from '../../lib/i18n.js';
import { executionReadinessMissingCodeLabel } from '../../lib/labels.js';
import { DashboardCard } from '../kit/section.js';
import { DataList, DataRow } from '../ui/DataList.js';
import { ErrorBanner } from '../ui/ErrorBanner.js';
import { Icon } from '../ui/Icon.js';
import { SkeletonRows } from '../ui/Skeleton.js';
import {
  missingCauseText,
  missingKey,
  missingLinkHref,
  missingLinkLabel,
} from './readiness-copy.js';
import { useExecutionReadiness } from './useExecutionReadiness.js';

export interface ExecutionReadinessCardProps {
  readonly http: CapabilityCaller;
}

/**
 * components/readiness/ExecutionReadinessCard: J1's "执行就绪" check (ui-audit-2026-09-23 J1 —
 * "平台概览「开始使用」5 项全绿，却没有一项检查执行就绪"; docs/development-tasks.md §5e F6
 * `execution_readiness`).
 *
 * **Placement** (see this lane's PR report for the full reasoning): the audit's own wording names
 * "平台概览" as where this belongs, but `PlatformOverviewPage` is `scope:'platform'` — reachable
 * only for a `platformRole==='admin'` console session and calling only `http`'s platform-scope
 * capabilities, with **no current workspace** (`session.ws`/`selectedWorkspaceId` never enter that
 * page — its own module doc comment). `execution_readiness` is `scope:'workspace'` (unset =
 * workspace, `capabilities.ts` `Capability.scope` doc comment) — it cannot be called meaningfully
 * from a page with no workspace context. There is also no separate workspace-scoped "overview"
 * page (`lib/router.ts` has exactly one `overview`-shaped route, the platform one) — the page a
 * signed-in workspace member/owner/operator actually lands on is `#/work/chats` (`lib/router.ts`'s
 * `DEFAULT_ROUTE`, and `routes.tsx`'s `isDefaultLanding`). This card mounts there instead
 * (`ChatListPage.tsx`), right under the page header — the first thing a reader sees before the
 * chat list itself.
 *
 * Reads the signed-in caller's own readiness (`useExecutionReadiness`) — every role from `member`
 * up may read their own (`execution_readiness`'s `minRole:'member'`); only an operator/owner may
 * pass another principal's id, which this card does not do (the optional member picker the task
 * brief allows is left for a follow-up — see the PR report's assumptions).
 */
export function ExecutionReadinessCard({ http }: ExecutionReadinessCardProps) {
  const t = useT();
  const readiness = useExecutionReadiness(http);

  return (
    <DashboardCard title={t('执行就绪', 'Execution readiness')} padded={false}>
      {readiness.state.status === 'loading' ? (
        <div className="p-4">
          <SkeletonRows count={2} label={t('正在检查执行就绪…', 'Checking execution readiness')} />
        </div>
      ) : readiness.state.status === 'error' ? (
        <div className="p-4">
          <ErrorBanner
            error={readiness.state.error}
            title={t('无法加载执行就绪状态', 'Could not load execution readiness')}
            onRetry={() => void readiness.reload()}
            testId="execution-readiness-error"
          />
        </div>
      ) : (
        <ExecutionReadinessBody data={readiness.state.data} />
      )}
    </DashboardCard>
  );
}

function ExecutionReadinessBody({ data }: { readonly data: ExecutionReadinessWire }) {
  const t = useT();
  const grantedGates = data.gates.filter((gate) => gate.granted).length;
  const delegableWorkers = data.workers.filter((worker) => worker.delegable).length;
  const gateNames = new Map(data.gates.map((gate) => [gate.gateId, gate.name]));

  return (
    <>
      <dl className="definition-list p-4" data-testid="execution-readiness-counts">
        <dt>{t('可用门', 'Gates available')}</dt>
        <dd>{data.gates.length}</dd>
        <dt>{t('已授权门', 'Gates granted')}</dt>
        <dd>{grantedGates}</dd>
        <dt>{t('可委派 Worker', 'Delegable Workers')}</dt>
        <dd>{delegableWorkers}</dd>
      </dl>
      {data.ready ? (
        <div className="row px-4 pb-4" data-testid="execution-readiness-ready">
          <Icon name="check" className="text-ok" label={t('已就绪', 'Ready')} />
          <span>
            {t('入口 agent 已经可以委派执行任务。', 'Your entry agent can already delegate work.')}
          </span>
        </div>
      ) : (
        <DataList ariaLabel="Execution readiness gaps" testId="execution-readiness-missing">
          {data.missing.map((item) => (
            <DataRow
              key={missingKey(item)}
              testId="execution-readiness-missing-item"
              leading={
                <Icon
                  name="alert"
                  className="text-warn"
                  label={executionReadinessMissingCodeLabel(item.code, t)}
                />
              }
              title={missingCauseText(item, gateNames, t)}
              trailing={
                <a href={missingLinkHref(item)} className="inline-flex min-h-9 items-center">
                  {missingLinkLabel(item, t)}
                </a>
              }
            />
          ))}
        </DataList>
      )}
    </>
  );
}
