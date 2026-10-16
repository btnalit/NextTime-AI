import { useCapability } from '../hooks/useCapability.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { actionKindRaw, actionKindTagText, formatDateTime, formatRelative } from '../lib/format.js';
import type { GatekeeperDetail } from '../lib/governance.js';
import { useT } from '../lib/i18n.js';
import { gateOwnedParamsText } from './connect/GateOwnedParams.js';
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
 * that page keeps unchanged — this is the one new read this PR adds to it. `health` is the wire's
 * `'ok' | 'unreachable' | 'unauthorized'`, shown with the `gateHealth` chip the system card and
 * the gate instance lists use, so the drawer and the card never disagree (legacy 271).
 */
export function GatekeeperDetailDrawer({ http, gatekeeperId }: GatekeeperDetailDrawerProps) {
  const t = useT();
  const detail = useCapability<GatekeeperDetail>(http, 'get_gatekeeper', { gatekeeperId });

  if (detail.state.status === 'loading') {
    return (
      <SkeletonRows
        count={3}
        label={t('正在加载门…', 'Loading gatekeeper')}
        testId="gatekeeper-detail-loading"
      />
    );
  }
  if (detail.state.status === 'error') {
    // B6 (S6-A0): a `get_gatekeeper` not_found is "no such gatekeeper", rendered by the ordinary
    // error banner — the S3.11 "该能力尚未上线" placeholder branch is retired with the rest.
    return (
      <ErrorBanner
        error={detail.state.error}
        title={t('无法加载这个门的健康与操作', "Could not load this gate's health and operations")}
        onRetry={() => void detail.reload()}
        testId="gatekeeper-detail-error"
      />
    );
  }

  const gate = detail.state.data;
  // Review #501 on #577 ② (the drawer's case of legacy 281): the gate's published and deprecated
  // versions of one name are listed side by side, so where a name repeats each row says its
  // version — and the row key carries it, so React never sees two rows under one key.
  const nameCounts = new Map<string, number>();
  for (const operation of gate.operations) {
    nameCounts.set(operation.name, (nameCounts.get(operation.name) ?? 0) + 1);
  }

  return (
    <div className="stack" data-testid="gatekeeper-detail">
      <dl className="definition-list">
        <dt>{t('健康', 'Health')}</dt>
        <dd>
          <StatusChip
            machine="gateHealth"
            status={gate.health}
            size="s"
            testId="gatekeeper-health"
          />
        </dd>
        <dt>{t('清单版本', 'Manifest version')}</dt>
        <dd>{gate.manifestVersion ?? '—'}</dd>
        <dt>{t('操作', 'Operation')}</dt>
        <dd>{gate.operationCount}</dd>
        <dt>{t('创建于', 'Created')}</dt>
        <dd>
          <time title={formatDateTime(gate.createdAt)}>{formatRelative(gate.createdAt)}</time>
        </dd>
      </dl>

      <div className="divider" />

      {gate.operations.length === 0 ? (
        <EmptyState
          icon="connections"
          title={t('这个门没有 Operation', 'No operations on this gate')}
        />
      ) : (
        <div className="gatekeeper-ops">
          {gate.operations.map((operation, index) => (
            <div
              className="op-item"
              key={`${operation.name}@${operation.version ?? `#${index}`}`}
              title={actionKindRaw(operation.name)}
            >
              <span className="op-name">{actionKindTagText(operation.name)}</span>
              {(nameCounts.get(operation.name) ?? 0) > 1 && operation.version !== undefined ? (
                <span
                  className="text-3 text-small"
                  data-testid={`gatekeeper-op-version-${operation.name}-${operation.version}`}
                >
                  v{operation.version}
                </span>
              ) : null}
              <StatusChip machine="publishable" status={operation.status} size="s" />
              {/* UX acceptance of #567 P3: a draft held back for a gate-owned param is not an
               *  ordinary draft — it cannot be published until the gate's manifest changes. */}
              {operation.status === 'draft' &&
              operation.gateOwnedParams &&
              operation.gateOwnedParams.length > 0 ? (
                <span
                  className="chip chip-s chip-warn"
                  title={t(
                    `声明了只能由门自己设置的参数：${gateOwnedParamsText(operation.gateOwnedParams, t)}`,
                    `Declares params only the gate sets: ${gateOwnedParamsText(operation.gateOwnedParams, t)}`,
                  )}
                  data-testid={`gatekeeper-op-held-${operation.name}`}
                >
                  {t('发布不了', 'Cannot be published')}
                </span>
              ) : null}
              {/* S8 W1-A11 (audit L3): mode through the shared StatusChip machine, not a bare tag. */}
              {operation.mode ? (
                <StatusChip machine="operationMode" status={operation.mode} size="s" />
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
