import type {
  ConnectorModeWire,
  ConnectorWire,
  ExternalRuntimeWire,
  GateInstanceWire,
} from '@nexttime/shared';
import { useState } from 'react';
import { useCapabilityList } from '../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import { Button } from '../ui/Button.js';
import { Drawer } from '../ui/Drawer.js';
import { EmptyState } from '../ui/EmptyState.js';
import { ErrorBanner } from '../ui/ErrorBanner.js';
import { Select } from '../ui/Field.js';
import { Notice } from '../ui/Notice.js';
import { PageHeader } from '../ui/PageHeader.js';
import { SkeletonRows } from '../ui/Skeleton.js';
import { Tabs } from '../ui/Tabs.js';
import { GateInstanceDetailPanel } from './GateInstanceDetailPanel.js';
import { PlatformError } from './PlatformError.js';

const CONNECTOR_MODE_VALUES: readonly ConnectorModeWire[] = [
  'disabled',
  'self_serve',
  'platform_preset',
];

const GATE_STATUS_LABEL: Readonly<Record<GateInstanceWire['status'], string>> = {
  discovered: '未启用 Discovered',
  enabled: '已启用 Enabled',
  disabled: '已禁用 Disabled',
  lost: '失联 Lost',
};

type Tab = 'connectors' | 'instances' | 'runtimes';

export interface PlatformIntegrationsPageProps {
  readonly http: CapabilityCaller;
}

/**
 * components/platform/PlatformIntegrationsPage: 集成 Integrations (`/platform/integrations`,
 * docs/platform-admin-design.md §6.3 集成) — P-B1's platform-scope half: the connector catalog
 * (three-state mode + a per-connector Operation deny-list), every gate instance that has
 * announced itself (rename / enable-disable / MCP trust / test connection), and the inventory of
 * external runtimes (Claude Code, a local pi over `/mcp`, a collector) across every workspace.
 * The workspace-side "enable from platform catalog" and "issue a service Handle" halves live on
 * `ConnectionsPage`/`AccessPage` instead — they need a workspace and a Principal, which this
 * platform-scope page has neither of (design §6.3's own split, `development-tasks.md` §P-B
 * "拆分与决定").
 */
export function PlatformIntegrationsPage({ http }: PlatformIntegrationsPageProps) {
  const [tab, setTab] = useState<Tab>('connectors');

  return (
    <div className="page" data-testid="platform-integrations-page">
      <PageHeader
        title="集成 Integrations"
        description="The platform's integration catalog: connectors, the gate instances that announced themselves, and the external runtimes using them."
      />

      <Tabs<Tab>
        ariaLabel="Integrations tabs"
        value={tab}
        onChange={setTab}
        options={[
          {
            value: 'connectors',
            label: '接入包 Connectors',
            testId: 'integrations-tab-connectors',
          },
          {
            value: 'instances',
            label: '门实例 Gate instances',
            testId: 'integrations-tab-instances',
          },
          {
            value: 'runtimes',
            label: '外部运行时 External runtimes',
            testId: 'integrations-tab-runtimes',
          },
        ]}
      />

      {tab === 'connectors' ? <ConnectorsTab http={http} /> : null}
      {tab === 'instances' ? <GateInstancesTab http={http} /> : null}
      {tab === 'runtimes' ? <ExternalRuntimesTab http={http} /> : null}
    </div>
  );
}

// -------------------------------------------------------------------------------------------
// 接入包 Connectors
// -------------------------------------------------------------------------------------------

function ConnectorsTab({ http }: { readonly http: CapabilityCaller }) {
  const connectors = useCapabilityList<ConnectorWire>(http, 'list_connectors', {});
  const rows = connectors.state.status === 'ready' ? connectors.state.data.items : [];

  function replace(updated: ConnectorWire): void {
    connectors.mutate((data) => ({
      ...data,
      items: data.items.map((row) => (row.name === updated.name ? updated : row)),
    }));
  }

  return (
    <div className="stack" data-testid="integrations-connectors">
      {connectors.state.status === 'loading' ? (
        <SkeletonRows count={3} label="Loading connectors" testId="connectors-loading" />
      ) : connectors.state.status === 'error' ? (
        <ErrorBanner
          error={connectors.state.error}
          title="Could not load the connector catalog"
          onRetry={() => void connectors.reload()}
          testId="connectors-error"
        />
      ) : rows.length === 0 ? (
        <EmptyState icon="grid" title="还没有接入包 No connectors yet" testId="connectors-empty" />
      ) : (
        <div className="table-scroll">
          <table className="data-table" data-testid="connectors-table">
            <thead>
              <tr>
                <th>名称 Name</th>
                <th>种类 Kind</th>
                <th>来源 Origin</th>
                <th>模式 Mode</th>
                <th>实例数 Instances</th>
                <th>Operation 数</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <ConnectorRow key={row.name} http={http} connector={row} onChanged={replace} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ConnectorRow({
  http,
  connector,
  onChanged,
}: {
  readonly http: CapabilityCaller;
  readonly connector: ConnectorWire;
  readonly onChanged: (connector: ConnectorWire) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [savingMode, setSavingMode] = useState(false);
  const [modeError, setModeError] = useState<unknown | null>(null);

  async function changeMode(mode: ConnectorModeWire): Promise<void> {
    if (savingMode) return;
    setSavingMode(true);
    setModeError(null);
    try {
      onChanged(
        await http.call<ConnectorWire>('set_connector_mode', { name: connector.name, mode }),
      );
    } catch (err) {
      setModeError(err);
    } finally {
      setSavingMode(false);
    }
  }

  return (
    <>
      <tr data-testid={`connector-row-${connector.name}`}>
        <td className="mono">{connector.name}</td>
        <td>{connector.kind}</td>
        <td>{connector.packaged ? '预置 Packaged' : '通用 Generic'}</td>
        <td>
          <Select
            data-testid={`connector-mode-${connector.name}`}
            value={connector.mode}
            onChange={(event) => void changeMode(event.target.value as ConnectorModeWire)}
            disabled={savingMode}
          >
            {CONNECTOR_MODE_VALUES.map((mode) => (
              <option key={mode} value={mode}>
                {mode}
              </option>
            ))}
          </Select>
          <PlatformError
            error={modeError}
            title="无法设置模式 Could not set the mode"
            testId={`connector-mode-error-${connector.name}`}
          />
        </td>
        <td className="mono">{connector.instanceCount}</td>
        <td className="mono">{connector.operationCount}</td>
        <td>
          <Button
            variant="ghost"
            size="s"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
          >
            {expanded ? '收起 Collapse' : '展开 Expand'}
          </Button>
        </td>
      </tr>
      {expanded ? (
        <tr>
          <td colSpan={7}>
            <ConnectorDenyList http={http} connector={connector} onChanged={onChanged} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** The per-Operation deny checklist for one connector — mounted only while its row is expanded
 *  (the `UserPicker` lazy-read shape), since `list_gate_instances{connector}` is otherwise a read
 *  no page needs until an administrator actually opens this row. The checklist's name universe is
 *  the union of every live instance's announced Operations *and* the connector's already-disabled
 *  names, so a name no instance announces right now (one that went `lost`, or was renamed) stays
 *  visible and can still be un-disabled. */
function ConnectorDenyList({
  http,
  connector,
  onChanged,
}: {
  readonly http: CapabilityCaller;
  readonly connector: ConnectorWire;
  readonly onChanged: (connector: ConnectorWire) => void;
}) {
  const instances = useCapabilityList<GateInstanceWire>(http, 'list_gate_instances', {
    connector: connector.name,
  });
  const [disabled, setDisabled] = useState<readonly string[]>(connector.disabledOperations);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown | null>(null);

  const liveNames =
    instances.state.status === 'ready'
      ? instances.state.data.items.flatMap((instance) =>
          instance.operations.map((operation) => operation.name),
        )
      : [];
  const names = Array.from(new Set([...liveNames, ...connector.disabledOperations])).sort();
  const dirty =
    disabled.length !== connector.disabledOperations.length ||
    disabled.some((name) => !connector.disabledOperations.includes(name));

  function toggle(name: string): void {
    setDisabled((prev) =>
      prev.includes(name) ? prev.filter((existing) => existing !== name) : [...prev, name],
    );
  }

  async function save(): Promise<void> {
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    try {
      onChanged(
        await http.call<ConnectorWire>('set_connector_mode', {
          name: connector.name,
          disabledOperations: [...disabled],
        }),
      );
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="stack-s"
      data-testid={`connector-disabled-ops-${connector.name}`}
      style={{ padding: '8px 0' }}
    >
      <Notice>
        禁用后下一次调用即被拒绝；这个改动不影响已经启用它的工作区。 Disabled from the next call on
        — it never affects a workspace that already enabled this instance.
      </Notice>
      {instances.state.status === 'loading' ? (
        <SkeletonRows count={2} label="Loading instances" />
      ) : instances.state.status === 'error' ? (
        <ErrorBanner
          error={instances.state.error}
          title="无法读取实例 Could not load this connector's instances"
          onRetry={() => void instances.reload()}
        />
      ) : names.length === 0 ? (
        <p className="text-3">还没有已知的 Operation No known Operations yet</p>
      ) : (
        names.map((name) => (
          <label className="checkbox" key={name}>
            <input
              type="checkbox"
              checked={disabled.includes(name)}
              onChange={() => toggle(name)}
              disabled={saving}
            />
            <span className="mono">{name}</span>
          </label>
        ))
      )}
      <PlatformError error={error} title="无法保存禁用列表 Could not save the deny list" />
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button variant="secondary" onClick={() => void save()} loading={saving} disabled={!dirty}>
          保存 Save
        </Button>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------------------------------
// 门实例 Gate instances
// -------------------------------------------------------------------------------------------

function GateInstancesTab({ http }: { readonly http: CapabilityCaller }) {
  const [openGateId, setOpenGateId] = useState<string | null>(null);
  const instances = useCapabilityList<GateInstanceWire>(http, 'list_gate_instances', {});
  const rows = instances.state.status === 'ready' ? instances.state.data.items : [];
  const open = openGateId !== null ? rows.find((row) => row.gateId === openGateId) : undefined;

  function replace(updated: GateInstanceWire): void {
    instances.mutate((data) => ({
      ...data,
      items: data.items.map((row) => (row.gateId === updated.gateId ? updated : row)),
    }));
  }

  return (
    <div className="stack" data-testid="integrations-instances">
      {instances.state.status === 'loading' ? (
        <SkeletonRows count={3} label="Loading gate instances" testId="gate-instances-loading" />
      ) : instances.state.status === 'error' ? (
        <ErrorBanner
          error={instances.state.error}
          title="Could not load gate instances"
          onRetry={() => void instances.reload()}
          testId="gate-instances-error"
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="connections"
          title="还没有门实例announce过 No gate instance has announced itself yet"
          testId="gate-instances-empty"
        />
      ) : (
        <div className="table-scroll">
          <table className="data-table" data-testid="gate-instances-table">
            <thead>
              <tr>
                <th>名称 Name</th>
                <th>接入包 Connector</th>
                <th>种类 Kind</th>
                <th>状态 Status</th>
                <th>健康 Health</th>
                <th>最近心跳 Last seen</th>
                <th>Operation 数</th>
                <th>启用它的工作区数</th>
                <th aria-label="Trust" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.gateId}
                  className="row-clickable"
                  data-testid={`gate-instance-row-${row.gateId}`}
                  onClick={() => setOpenGateId(row.gateId)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setOpenGateId(row.gateId);
                    }
                  }}
                >
                  <td>
                    <div className="stack-s" style={{ gap: 0 }}>
                      <span>{row.displayName}</span>
                      <span className="mono text-3">{row.gateId}</span>
                    </div>
                  </td>
                  <td className="mono">{row.connector}</td>
                  <td>{row.transportKind}</td>
                  <td>
                    <span
                      className={`chip chip-s ${row.status === 'enabled' ? 'chip-ok' : row.status === 'lost' ? 'chip-warn' : 'chip-neutral'}`}
                      data-testid="gate-instance-status"
                    >
                      {GATE_STATUS_LABEL[row.status]}
                    </span>
                  </td>
                  <td>
                    <span
                      className={`chip chip-s ${row.health === 'ok' ? 'chip-ok' : row.health === 'unknown' ? 'chip-neutral' : 'chip-warn'}`}
                    >
                      {row.health}
                    </span>
                  </td>
                  <td>
                    {row.lastSeenAt === null ? (
                      '从未 Never'
                    ) : (
                      <time title={formatDateTime(row.lastSeenAt)}>
                        {formatRelative(row.lastSeenAt)}
                      </time>
                    )}
                  </td>
                  <td className="mono">{row.operationCount}</td>
                  <td className="mono">{row.enabledWorkspaceCount}</td>
                  <td>
                    {row.trust === 'vetted' ? (
                      <span className="tag" data-testid="gate-instance-vetted-badge">
                        vetted
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Drawer
        open={open !== undefined}
        onClose={() => setOpenGateId(null)}
        title={open?.displayName ?? '门实例 Gate instance'}
        subtitle={open ? <span className="mono">{open.gateId}</span> : undefined}
        testId="gate-instance-drawer"
      >
        {open ? (
          <GateInstanceDetailPanel
            key={open.gateId}
            http={http}
            instance={open}
            onChanged={replace}
          />
        ) : null}
      </Drawer>
    </div>
  );
}

// -------------------------------------------------------------------------------------------
// 外部运行时 External runtimes
// -------------------------------------------------------------------------------------------

function ExternalRuntimesTab({ http }: { readonly http: CapabilityCaller }) {
  const runtimes = useCapabilityList<ExternalRuntimeWire>(http, 'list_external_runtimes', {});
  const rows = runtimes.state.status === 'ready' ? runtimes.state.data.items : [];

  function removeRow(sessionId: string): void {
    runtimes.mutate((data) => ({
      ...data,
      items: data.items.filter((row) => row.sessionId !== sessionId),
    }));
  }

  return (
    <div className="stack" data-testid="integrations-runtimes">
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button
          variant="ghost"
          size="s"
          icon="refresh"
          onClick={() => void runtimes.reload()}
          loading={runtimes.state.status === 'ready' && runtimes.state.refreshing}
        >
          刷新 Refresh
        </Button>
      </div>

      {runtimes.state.status === 'loading' ? (
        <SkeletonRows
          count={2}
          label="Loading external runtimes"
          testId="external-runtimes-loading"
        />
      ) : runtimes.state.status === 'error' ? (
        <ErrorBanner
          error={runtimes.state.error}
          title="Could not load external runtimes"
          onRetry={() => void runtimes.reload()}
          testId="external-runtimes-error"
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="link"
          title="还没有外部运行时 No external runtimes yet"
          body="Claude Code、通过 /mcp 连接的本机 pi，或一个 collector 在签发 Handle 并建立会话后会出现在这里。 Claude Code, a local pi connected over /mcp, or a collector shows up here once it holds an issued Handle and has an open session."
          testId="external-runtimes-empty"
        />
      ) : (
        <div className="table-scroll">
          <table className="data-table" data-testid="external-runtimes-table">
            <thead>
              <tr>
                <th>工作区 Workspace</th>
                <th>Principal</th>
                <th>会话种类 Session kind</th>
                <th>创建时间 Created</th>
                <th>过期 Expires</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <ExternalRuntimeRow
                  key={row.sessionId}
                  http={http}
                  runtime={row}
                  onRevoked={() => removeRow(row.sessionId)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ExternalRuntimeRow({
  http,
  runtime,
  onRevoked,
}: {
  readonly http: CapabilityCaller;
  readonly runtime: ExternalRuntimeWire;
  readonly onRevoked: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState<unknown | null>(null);

  async function revoke(): Promise<void> {
    if (revoking) return;
    setRevoking(true);
    setError(null);
    try {
      await http.call('revoke_external_runtime', {
        workspaceId: runtime.workspaceId,
        sessionId: runtime.sessionId,
      });
      onRevoked();
    } catch (err) {
      setError(err);
    } finally {
      setRevoking(false);
    }
  }

  return (
    <tr data-testid={`external-runtime-row-${runtime.sessionId}`}>
      <td>{runtime.workspaceName}</td>
      <td>{runtime.displayName ?? <span className="mono text-3">{runtime.principalId}</span>}</td>
      <td>{runtime.sessionKind}</td>
      <td>
        <time title={formatDateTime(runtime.createdAt)}>{formatRelative(runtime.createdAt)}</time>
      </td>
      <td>
        {runtime.expiresAt === null ? (
          '—'
        ) : (
          <time title={formatDateTime(runtime.expiresAt)}>{formatRelative(runtime.expiresAt)}</time>
        )}
      </td>
      <td>
        <PlatformError error={error} title="无法吊销 Could not revoke this runtime" />
        {confirming ? (
          <div className="row-wrap" style={{ justifyContent: 'flex-end' }}>
            <Button variant="ghost" size="s" onClick={() => setConfirming(false)}>
              取消 Cancel
            </Button>
            <Button variant="danger" size="s" onClick={() => void revoke()} loading={revoking}>
              确认吊销 Confirm revoke
            </Button>
          </div>
        ) : (
          <Button
            variant="danger"
            size="s"
            onClick={() => setConfirming(true)}
            data-testid={`external-runtime-revoke-${runtime.sessionId}`}
          >
            吊销 Revoke
          </Button>
        )}
      </td>
    </tr>
  );
}
