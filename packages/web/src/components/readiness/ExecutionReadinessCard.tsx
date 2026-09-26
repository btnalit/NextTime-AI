import type { ExecutionReadinessWire } from '@nexttime/shared';
import type { CapabilityCaller } from '../../lib/clients.js';
import { useT } from '../../lib/i18n.js';
import { executionReadinessMissingCodeLabel } from '../../lib/labels.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { DashboardCard } from '../kit/section.js';
import {
  gateReasonHref,
  gateReasonLink,
  gateReasonText,
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
    <DashboardCard title={t('执行就绪', 'Execution readiness')}>
      {readiness.state.status === 'loading' ? (
        <p className="text-3 text-small" data-testid="execution-readiness-loading">
          {t('正在检查执行就绪…', 'Checking execution readiness…')}
        </p>
      ) : readiness.state.status === 'error' ? (
        <ErrorBanner
          error={readiness.state.error}
          title={t('无法加载执行就绪状态', 'Could not load execution readiness')}
          onRetry={() => void readiness.reload()}
          retryLabel={t('重试', 'Retry')}
          testId="execution-readiness-error"
        />
      ) : (
        <ExecutionReadinessBody data={readiness.state.data} />
      )}
    </DashboardCard>
  );
}

function ExecutionReadinessBody({ data }: { readonly data: ExecutionReadinessWire }) {
  const t = useT();
  const gateNames = new Map(data.gates.map((gate) => [gate.gateId, gate.name]));
  const workerNames = new Map(
    data.workers.map((worker) => [worker.definitionId, worker.name ?? worker.definitionId]),
  );

  return (
    <div className="stack" data-testid="execution-readiness-body">
      {/* Console redesign M2: one row per system — what the entry agent can do with it right now,
       *  and if nothing, the first missing step and where to fix it. The old three counters and a
       *  single "ready" flag read green as soon as *any* system worked. */}
      {data.gates.length > 0 ? (
        <ul
          className="stack-s"
          style={{ listStyle: 'none', margin: 0, padding: 0 }}
          data-testid="execution-readiness-gates"
        >
          {data.gates.map((gate) => (
            <GateRow key={gate.gateId} gate={gate} workerNames={workerNames} />
          ))}
        </ul>
      ) : null}
      {data.ready ? (
        <div className="row" data-testid="execution-readiness-ready">
          <span className="chip chip-ok chip-s">{t('可委派', 'Can delegate')}</span>
          <span>
            {t(
              '需要多步或写操作的任务，入口 agent 已经可以委派给 Worker。',
              'Your entry agent can already delegate multi-step or write tasks to a Worker.',
            )}
          </span>
        </div>
      ) : (
        <ul
          className="stack-s"
          style={{ listStyle: 'none', margin: 0, padding: 0 }}
          data-testid="execution-readiness-missing"
        >
          {data.missing.map((item) => (
            <li
              key={missingKey(item)}
              className="row-wrap"
              data-testid="execution-readiness-missing-item"
            >
              <span className="chip chip-warn chip-s">
                {executionReadinessMissingCodeLabel(item.code, t)}
              </span>
              <span>{missingCauseText(item, gateNames, t)}</span>
              <a href={missingLinkHref(item)}>{missingLinkLabel(item, t)}</a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type GateWire = ExecutionReadinessWire['gates'][number];

function GateRow({
  gate,
  workerNames,
}: {
  readonly gate: GateWire;
  readonly workerNames: ReadonlyMap<string, string>;
}) {
  const t = useT();
  const workers = gate.workerDefinitionIds.map((id) => workerNames.get(id) ?? id).join('、');
  return (
    <li
      className="row-wrap"
      data-testid="execution-readiness-gate"
      data-gate-id={gate.gateId}
      data-status={gate.status}
    >
      <strong>{gate.name}</strong>
      {gate.status === 'direct' ? (
        <>
          <span className="chip chip-ok chip-s">{t('可直接调用', 'Callable directly')}</span>
          <span>
            {t(
              `你的智能体可以直接调用它的 ${gate.observeOperationCount} 个只读操作${
                gate.workerDefinitionIds.length > 0 ? `，也可委派给 ${workers}` : ''
              }。`,
              `Your agent can call its ${gate.observeOperationCount} read operation(s) itself${
                gate.workerDefinitionIds.length > 0 ? `, or delegate to ${workers}` : ''
              }.`,
            )}
          </span>
        </>
      ) : gate.status === 'via_worker' ? (
        <>
          <span className="chip chip-info chip-s">{t('需委派', 'Via a Worker')}</span>
          <span>
            {t(
              `你的智能体要委派给 ${workers} 才能用它。`,
              `Your agent has to delegate to ${workers} to use it.`,
            )}
          </span>
        </>
      ) : (
        <>
          <span className="chip chip-warn chip-s">{t('用不了', 'Not usable')}</span>
          <span>{gateReasonText(gate.reason, t)}</span>
          {gate.reason !== undefined ? (
            <a href={gateReasonHref(gate.reason)} style={{ textDecoration: 'underline' }}>
              {gateReasonLink(gate.reason, t)}
            </a>
          ) : null}
        </>
      )}
    </li>
  );
}
