import type { GraphFreshnessWire } from '@nexttime/shared';
import { useCapability } from '../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import { useT } from '../../lib/i18n.js';
import { Notice } from '../kit/notice.js';

export interface GraphFreshnessNoticeProps {
  readonly http: CapabilityCaller;
}

/**
 * components/graph/GraphFreshnessNotice (S8 W4-A, ui-audit G1, STATUS leftover 70/62): a
 * workspace-wide "is the graph still updating" signal, above the per-Fact `陈旧 aging` colouring
 * `lib/graph-freshness.ts` already does. The 2026-09-18 incident is exactly what that per-Fact
 * colouring alone failed to surface — every affected Fact merely read "陈旧 · 5d ago" against a 2h
 * window, and nobody read "5 天" as "the collector stopped writing into this workspace five days
 * ago" until someone went looking by hand (STATUS leftover 70). `graph_freshness` names the cause
 * directly: any Source owned by a service Principal (a collector, an external runtime) whose
 * newest observation is older than the same collector-silence window.
 *
 * Renders nothing while loading/erroring (a decorative signal, never worth an ErrorBanner of its
 * own) and nothing for a workspace with no collector Source at all (nothing to be silent from —
 * the common case for a hand-built workspace with only human/agent-asserted Facts).
 */
export function GraphFreshnessNotice({ http }: GraphFreshnessNoticeProps) {
  const t = useT();
  const freshness = useCapability<GraphFreshnessWire>(http, 'graph_freshness', {});
  if (freshness.state.status !== 'ready') return null;
  const { sources, workspaceLastObservedAt } = freshness.state.data;
  if (sources.length === 0) return null;

  const silent = sources.filter((source) => source.silent);
  if (silent.length === 0) {
    return (
      <p className="text-3 text-small" data-testid="graph-freshness-ok">
        {t('采集来源正常观测', 'Collectors observing normally')}
        {workspaceLastObservedAt ? (
          <>
            {' · '}
            {t('最近观测', 'Last observed')}{' '}
            <time title={formatDateTime(workspaceLastObservedAt)}>
              {formatRelative(workspaceLastObservedAt)}
            </time>
          </>
        ) : null}
      </p>
    );
  }

  return (
    <Notice tone="warn" testId="graph-freshness-warn">
      <div className="stack-s">
        <span>
          {t('已超过观测窗口未再观测的采集来源', 'Collector sources past the observation window')}
          {': '}
          {silent.length}
        </span>
        <ul className="stack-s" data-testid="graph-freshness-silent-list">
          {silent.map((source) => (
            <li
              key={source.sourceId}
              className="text-2 text-small"
              data-testid="graph-freshness-silent-row"
            >
              <span className="mono">{source.name ?? source.kind}</span>
              {source.lastObservedAt ? (
                <>
                  {' — '}
                  <time title={formatDateTime(source.lastObservedAt)}>
                    {formatRelative(source.lastObservedAt)}
                  </time>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </Notice>
  );
}
