import type { ExecutionReadinessWire } from '@nexttime/shared';
import type { CapabilityCaller } from '../../lib/clients.js';
import { describeError } from '../../lib/errors.js';
import { useT } from '../../lib/i18n.js';
import { executionReadinessMissingCodeLabel } from '../../lib/labels.js';
import { Button } from '../kit/button.js';
import { DashboardCard } from '../kit/section.js';
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
 *
 * `components/kit/*` boundary (S8 risk ①): this file may not import `components/ui/*`, so its own
 * error-banner rendering is a small local replica of `ui/ErrorBanner` over the same CSS classes —
 * not a new dependency, just no component-wrapper import (same technique `components/access/
 * GrantGateForm.tsx` / `components/connect/EnableGateConfirm.tsx` use). No Tailwind utility class
 * appears here that `components/kit/*` does not already use — this file is outside Tailwind's
 * `@source` scope (`styles/tailwind.css`), so an arbitrary utility class here would silently not
 * exist in the built CSS.
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
        <LocalErrorBanner
          error={readiness.state.error}
          title={t('无法加载执行就绪状态', 'Could not load execution readiness')}
          onRetry={() => void readiness.reload()}
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
  const grantedGates = data.gates.filter((gate) => gate.granted).length;
  const delegableWorkers = data.workers.filter((worker) => worker.delegable).length;
  const gateNames = new Map(data.gates.map((gate) => [gate.gateId, gate.name]));

  return (
    <div className="stack" data-testid="execution-readiness-body">
      <dl className="definition-list" data-testid="execution-readiness-counts">
        <dt>{t('可用门', 'Gates available')}</dt>
        <dd>{data.gates.length}</dd>
        <dt>{t('已授权门', 'Gates granted')}</dt>
        <dd>{grantedGates}</dd>
        <dt>{t('可委派 Worker', 'Delegable Workers')}</dt>
        <dd>{delegableWorkers}</dd>
      </dl>
      {data.ready ? (
        <div className="row" data-testid="execution-readiness-ready">
          <span className="chip chip-ok chip-s">{t('已就绪', 'Ready')}</span>
          <span>
            {t('入口 agent 已经可以委派执行任务。', 'Your entry agent can already delegate work.')}
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

/** A small local `ui/ErrorBanner` replica (with retry, over `components/kit/button`) — this file
 *  may not import `components/ui/*`. */
function LocalErrorBanner({
  error,
  title,
  onRetry,
  testId,
}: {
  readonly error: unknown;
  readonly title?: string;
  readonly onRetry?: () => void;
  readonly testId?: string;
}) {
  const t = useT();
  const described = describeError(error);
  return (
    <div
      className="error-banner"
      role="alert"
      data-testid={testId}
      data-error-code={described.code}
    >
      <div className="error-banner-body">
        <div className="error-banner-title">
          <span>{title ?? described.title}</span>
          <code className="error-banner-code">{described.code}</code>
        </div>
        {described.message && described.message !== described.title ? (
          <p className="error-banner-message">{described.message}</p>
        ) : null}
      </div>
      {onRetry ? (
        <div className="error-banner-actions">
          <Button variant="secondary" size="s" onClick={onRetry}>
            {t('重试', 'Retry')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
