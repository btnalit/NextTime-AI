import type {
  AvailableGateInstanceWire,
  EnableGateInstanceResultWire,
  GateHostTokenWire,
} from '@nexttime/shared';
import { useEffect, useState } from 'react';
import { useCapabilityList } from '../hooks/useCapability.js';
import { usePermissions } from '../hooks/usePermissions.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { isForbiddenError } from '../lib/errors.js';
import { hrefs } from '../lib/router.js';
import { GateCredentialEntry } from './platform/GateCredentialEntry.js';
import { PlatformError } from './platform/PlatformError.js';
import { Button } from './ui/Button.js';
import { EmptyState } from './ui/EmptyState.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Notice } from './ui/Notice.js';
import { SkeletonRows } from './ui/Skeleton.js';

export interface AvailableGateInstancesSectionProps {
  readonly http: CapabilityCaller;
  /** The Registered systems section below must reload too: `enable_gate_instance` registers a
   *  Gatekeeper object that section reads independently. */
  readonly onEnabled: () => void;
  /** Owner-only: shows the 启用 button. Members still see the list and, on linked rows, the
   *  per-member credential entry (P-B2a). */
  readonly canEnable: boolean;
}

/**
 * components/AvailableGateInstancesSection: "从平台目录启用 Enable from platform catalog"
 * (`ConnectionsPage`, P-B1, design §6.3) — `list_available_gate_instances` /
 * `enable_gate_instance`, the workspace-owner half of P-B1's platform catalog. Rendered only for
 * an owner (`ConnectionsPage`'s existing `canCreate` — `create_connection`'s own owner-only
 * `deniedClosure`, which `enable_gate_instance`/`list_available_gate_instances` share).
 */
export function AvailableGateInstancesSection({
  http,
  onEnabled,
  canEnable,
}: AvailableGateInstancesSectionProps) {
  const permissions = usePermissions();
  const available = useCapabilityList<AvailableGateInstanceWire>(
    http,
    'list_available_gate_instances',
    {},
  );
  const forbidden = available.state.status === 'error' && isForbiddenError(available.state.error);
  useEffect(() => {
    if (forbidden) permissions.markDenied('list_available_gate_instances');
  }, [forbidden, permissions]);

  const rows = available.state.status === 'ready' ? available.state.data.items : [];

  function handleEnabled(result: EnableGateInstanceResultWire): void {
    available.mutate((data) => ({
      ...data,
      items: data.items.map((row) =>
        row.gateId === result.gateId
          ? { ...row, gatekeeperId: result.gatekeeperId, status: 'enabled' }
          : row,
      ),
    }));
    onEnabled();
  }

  return (
    <section className="section" aria-labelledby="available-gates-title">
      <div className="section-header">
        <h2 id="available-gates-title">从平台目录启用 Enable from platform catalog</h2>
        <Button
          variant="ghost"
          size="s"
          icon="refresh"
          onClick={() => void available.reload()}
          loading={available.state.status === 'ready' && available.state.refreshing}
        >
          刷新 Refresh
        </Button>
      </div>

      {available.state.status === 'loading' ? (
        <SkeletonRows
          count={2}
          label="Loading the platform catalog"
          testId="available-gates-loading"
        />
      ) : forbidden ? (
        <Notice testId="available-gates-forbidden">
          从平台目录启用是 owner 专属操作 Enabling from the platform catalog is owner-only.
        </Notice>
      ) : available.state.status === 'error' ? (
        <ErrorBanner
          error={available.state.error}
          title="Could not load the platform catalog"
          onRetry={() => void available.reload()}
          testId="available-gates-error"
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="grid"
          title="平台目录里还没有可启用的实例 Nothing to enable yet"
          body="An administrator sets a connector to 平台预置 platform-preset for its instances to show up here."
          testId="available-gates-empty"
        />
      ) : (
        <div className="table-scroll">
          <table className="data-table" data-testid="available-gates-table">
            <thead>
              <tr>
                <th>名称 Name</th>
                <th>接入包 Connector</th>
                <th>状态/健康 Status/health</th>
                <th>Operation 数</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <AvailableGateRow
                  key={row.gateId}
                  http={http}
                  row={row}
                  onEnabled={handleEnabled}
                  canEnable={canEnable}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function AvailableGateRow({
  http,
  row,
  onEnabled,
  canEnable,
}: {
  readonly http: CapabilityCaller;
  readonly row: AvailableGateInstanceWire;
  readonly onEnabled: (result: EnableGateInstanceResultWire) => void;
  readonly canEnable: boolean;
}) {
  const [enabling, setEnabling] = useState(false);
  const [error, setError] = useState<unknown | null>(null);
  const [publishedCount, setPublishedCount] = useState<number | null>(null);

  async function enable(): Promise<void> {
    if (enabling) return;
    setEnabling(true);
    setError(null);
    try {
      const result = await http.call<EnableGateInstanceResultWire>('enable_gate_instance', {
        gateId: row.gateId,
      });
      setPublishedCount(result.publishedOperationNames.length);
      onEnabled(result);
    } catch (err) {
      setError(err);
    } finally {
      setEnabling(false);
    }
  }

  return (
    <tr data-testid={`available-gate-${row.gateId}`}>
      <td>{row.displayName}</td>
      <td className="mono">{row.connector}</td>
      <td>
        {row.status} · {row.health}
      </td>
      <td className="mono">{row.operationCount}</td>
      <td>
        {row.gatekeeperId ? (
          <div className="stack-s">
            <a href={hrefs.gatekeeper(row.gatekeeperId)}>已启用 Enabled</a>
            <GateCredentialEntry
              requestToken={() =>
                http.call<GateHostTokenWire>('issue_gate_credential_token', {
                  gateId: row.gateId,
                })
              }
              tokenButtonLabel="录入我的凭证 Enter my credential"
            />
          </div>
        ) : canEnable ? (
          <Button
            variant="primary"
            size="s"
            onClick={() => void enable()}
            loading={enabling}
            data-testid={`enable-gate-${row.gateId}`}
          >
            启用 Enable
          </Button>
        ) : (
          <span className="muted">未启用（由 owner 启用） Not enabled (owner enables)</span>
        )}
        <PlatformError error={error} title="无法启用 Could not enable this instance" />
        {publishedCount !== null ? (
          <Notice>
            已发布 {publishedCount} 个 Operation Published {publishedCount} operation
            {publishedCount === 1 ? '' : 's'}
          </Notice>
        ) : null}
      </td>
    </tr>
  );
}
