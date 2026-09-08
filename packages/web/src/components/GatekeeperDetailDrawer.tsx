import { useCapability } from '../hooks/useCapability.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { isNotFoundError } from '../lib/errors.js';
import { formatDateTime, formatRelative } from '../lib/format.js';
import { type GatekeeperDetail, healthView } from '../lib/governance.js';
import { EmptyState } from './ui/EmptyState.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { SkeletonRows } from './ui/Skeleton.js';
import { StatusChip } from './ui/StatusChip.js';

export interface GatekeeperDetailDrawerProps {
  readonly http: CapabilityCaller;
  readonly gatekeeperId: string;
}

/**
 * components/GatekeeperDetailDrawer: `get_gatekeeper` (S3.11, new) — health + the Operation list,
 * inside the Systems page's (`/govern/systems`) detail drawer. Additive to the existing S2.13
 * `search`-based Gatekeeper/Operation flow (`lib/connections.ts`, `RegisteredSystemsSection.tsx`)
 * that page keeps unchanged — this is the one new read this PR adds to it. `health`'s shape is
 * read defensively (`lib/governance.ts` `healthView`) since no schema for it exists anywhere yet.
 */
export function GatekeeperDetailDrawer({ http, gatekeeperId }: GatekeeperDetailDrawerProps) {
  const detail = useCapability<GatekeeperDetail>(http, 'get_gatekeeper', { gatekeeperId });

  if (detail.state.status === 'loading') {
    return <SkeletonRows count={3} label="Loading gatekeeper" testId="gatekeeper-detail-loading" />;
  }
  if (detail.state.status === 'error') {
    if (isNotFoundError(detail.state.error)) {
      return (
        <EmptyState
          icon="connections"
          title="该能力尚未上线 Not live yet"
          body="get_gatekeeper is part of S3.11, still landing on the kernel side."
          testId="gatekeeper-detail-unavailable"
        />
      );
    }
    return (
      <ErrorBanner
        error={detail.state.error}
        title="Could not load this gate's health and operations"
        onRetry={() => void detail.reload()}
        testId="gatekeeper-detail-error"
      />
    );
  }

  const gate = detail.state.data;
  const health = healthView(gate.health);

  return (
    <div className="stack" data-testid="gatekeeper-detail">
      <dl className="definition-list">
        <dt>Health</dt>
        <dd>
          <span className={`chip chip-s chip-${health.tone}`} data-testid="gatekeeper-health">
            {health.label}
          </span>
        </dd>
        <dt>Manifest version</dt>
        <dd>{gate.manifestVersion ?? '—'}</dd>
        <dt>Operations</dt>
        <dd>{gate.operationCount}</dd>
        <dt>Created</dt>
        <dd>
          <time title={formatDateTime(gate.createdAt)}>{formatRelative(gate.createdAt)}</time>
        </dd>
      </dl>

      <div className="divider" />

      {gate.operations.length === 0 ? (
        <EmptyState icon="connections" title="No operations on this gate" />
      ) : (
        <div className="gatekeeper-ops">
          {gate.operations.map((operation) => (
            <div className="op-item" key={operation.name} title={operation.name}>
              <span className="op-name">{operation.name}</span>
              <StatusChip machine="publishable" status={operation.status} size="s" />
              {operation.mode ? <span className="tag">{operation.mode}</span> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
