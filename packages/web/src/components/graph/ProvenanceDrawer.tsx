import type { ConflictWire, ExplainResultWire, FactWire } from '@nexttime/shared';
import { useCapability } from '../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import { auditHrefForNode } from '../../lib/graph-route.js';
import { explainToProvenance } from '../../lib/graph-view.js';
import { useT } from '../../lib/i18n.js';
import { Drawer } from '../ui/Drawer.js';
import { ErrorBanner } from '../ui/ErrorBanner.js';
import { ProvenanceChain } from '../ui/ProvenanceChain.js';
import { RefChip } from '../ui/RefChip.js';
import { SkeletonRows } from '../ui/Skeleton.js';
import { FreshnessChip } from './FreshnessChip.js';

export interface ProvenanceDrawerProps {
  readonly http: CapabilityCaller;
  /** The Fact whose "溯源" was clicked; `null` keeps the drawer closed. */
  readonly fact: FactWire | null;
  readonly asOf: number;
  readonly conflicts?: readonly ConflictWire[];
  readonly onClose: () => void;
}

/**
 * components/graph/ProvenanceDrawer (plan §5.7 "Fact 溯源"): `explain{nodeId: factId}` — narrowed
 * by leftover 1 to the Fact's own Observation — mapped onto `ui/ProvenanceChain` (Fact → Activity
 * → Source, raw evidence behind the disclosure), plus the Fact's freshness as of the page's
 * instant, any open Conflict it sits in (count + ids — no Conflict UI exists in the console yet,
 * so there is nothing to link to), and "在审计页打开 Open in audit" (`?nodeId=` on the audit route).
 */
export function ProvenanceDrawer({ http, fact, asOf, conflicts, onClose }: ProvenanceDrawerProps) {
  const t = useT();
  return (
    <Drawer
      open={fact !== null}
      title={t('溯源', 'Provenance')}
      subtitle={
        fact ? (
          <span className="row-wrap">
            <span className="mono">{fact.linkType}</span>
            <RefChip kind="object" id={fact.id} name="Fact" size="s" />
          </span>
        ) : undefined
      }
      onClose={onClose}
      wide
      testId="graph-provenance-drawer"
      footer={
        fact ? (
          <a
            className="btn btn-secondary btn-s"
            href={auditHrefForNode(fact.id)}
            data-testid="graph-open-in-audit"
          >
            {t('在审计页打开', 'Open in audit')}
          </a>
        ) : undefined
      }
    >
      {fact ? (
        <ProvenanceBody
          key={fact.id}
          http={http}
          fact={fact}
          asOf={asOf}
          conflicts={conflicts ?? []}
        />
      ) : null}
    </Drawer>
  );
}

function ProvenanceBody({
  http,
  fact,
  asOf,
  conflicts,
}: {
  readonly http: CapabilityCaller;
  readonly fact: FactWire;
  readonly asOf: number;
  readonly conflicts: readonly ConflictWire[];
}) {
  const t = useT();
  const explain = useCapability<ExplainResultWire>(http, 'explain', { nodeId: fact.id });
  const inConflict = conflicts.length > 0;
  return (
    <div className="stack">
      <div className="row-wrap">
        <FreshnessChip
          input={{
            lastObservedAt: fact.lastObservedAt,
            supersededAt: fact.supersededAt,
            invalidatedAt: fact.invalidatedAt,
            invalidationReason: fact.invalidationReason,
            epistemicStatus: fact.epistemicStatus,
            inConflict,
          }}
          asOf={asOf}
          testId="graph-provenance-freshness"
        />
        <span className="text-3 text-small" title={formatDateTime(fact.lastObservedAt)}>
          {fact.lastObservedAt
            ? `最近观测 Last observed ${formatRelative(fact.lastObservedAt, asOf)}`
            : `记录 Recorded ${formatRelative(fact.recordedAt, asOf)}`}
        </span>
      </div>
      {inConflict ? (
        <div className="notice notice-warn" data-testid="graph-provenance-conflicts">
          <div className="grow stack-s">
            <span>
              {t(
                <>该事实处于 {conflicts.length} 个未解决冲突中</>,
                <>
                  In {conflicts.length} open {conflicts.length === 1 ? 'Conflict' : 'Conflicts'}
                </>,
              )}
            </span>
            <span className="row-wrap">
              {conflicts.map((conflict) => (
                <RefChip
                  key={conflict.id}
                  kind="object"
                  id={conflict.id}
                  name={`Conflict · ${conflict.conflictType}`}
                  size="s"
                />
              ))}
            </span>
          </div>
        </div>
      ) : null}
      {explain.state.status === 'loading' ? (
        <SkeletonRows count={3} label="Loading provenance" testId="graph-provenance-loading" />
      ) : explain.state.status === 'error' ? (
        <ErrorBanner
          error={explain.state.error}
          title={t('无法解释该事实', 'Could not explain this Fact')}
          onRetry={() => void explain.reload()}
          testId="graph-provenance-error"
        />
      ) : (
        <ProvenanceChain
          {...explainToProvenance(explain.state.data)}
          raw={explain.state.data}
          // Fact / Activity / Source ids are not graph Objects — no object page to link to.
          hrefFor={() => undefined}
          testId="graph-provenance-chain"
        />
      )}
    </div>
  );
}
