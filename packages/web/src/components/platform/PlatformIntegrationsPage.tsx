import type {
  ConnectorModeWire,
  ConnectorWire,
  ExternalRuntimeWire,
  GateInstanceWire,
} from '@nexttime/shared';
import { useEffect, useState } from 'react';
import { useCapabilityList } from '../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import { useT } from '../../lib/i18n.js';
import { connectorModeLabel, transportKindLabel } from '../../lib/labels.js';
import { breadcrumbFor } from '../../lib/nav.js';
import { deriveGateInstanceStatus } from '../../lib/status-tone.js';
import { ConnectSystemLauncher } from '../connect/ConnectSystemLauncher.js';
import { Confirm } from '../kit/confirm.js';
import { PageHeader } from '../kit/page-header.js';
import { Button } from '../ui/Button.js';
import { Drawer } from '../ui/Drawer.js';
import { EmptyState } from '../ui/EmptyState.js';
import { ErrorBanner } from '../ui/ErrorBanner.js';
import { Select } from '../ui/Field.js';
import { Notice } from '../ui/Notice.js';
import { SkeletonRows } from '../ui/Skeleton.js';
import { StatusChip } from '../ui/StatusChip.js';
import { Tabs } from '../ui/Tabs.js';
import { CreateGateInstanceForm } from './CreateGateInstanceForm.js';
import { GateInstanceDetailPanel } from './GateInstanceDetailPanel.js';
import { PlatformError } from './PlatformError.js';

const CONNECTOR_MODE_VALUES: readonly ConnectorModeWire[] = [
  'disabled',
  'self_serve',
  'platform_preset',
];

type Tab = 'connectors' | 'instances' | 'runtimes';

export interface PlatformIntegrationsPageProps {
  readonly http: CapabilityCaller;
  /** S6-C: `#/platform/integrations/<gateId>` — opens the 门实例 tab with that instance's drawer
   *  (the deep link the workspace page's "平台实例" chip uses). Needs `lib/router.ts` to parse the
   *  trailing segment (another lane's file; the exact route lines are in the S6-C report). */
  readonly selectedGateId?: string;
  readonly onSelectGate?: (gateId: string | null) => void;
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
 *
 * S6-C (docs/console-completion-plan.md §5.6): the page's one primary action is "接入一个系统
 * Connect a system" — the same `ConnectSystemLauncher` the workspace 系统接入 page opens, mounted
 * here with `origin: 'platform'` (the workspace steps link to 系统接入). The 门实例 tab keeps its
 * own 新建门宿主实例 button as the quick path.
 */
export function PlatformIntegrationsPage({
  http,
  selectedGateId,
  onSelectGate,
}: PlatformIntegrationsPageProps) {
  const t = useT();
  const [tab, setTab] = useState<Tab>(selectedGateId !== undefined ? 'instances' : 'connectors');
  const [launcherOpen, setLauncherOpen] = useState(false);
  // The instance drawer to open: the route's (deep link) or, until `lib/router.ts` carries that
  // segment, a local one the launcher's finish sets — so "finish → see the instance" works either way.
  const [localGateId, setLocalGateId] = useState<string | undefined>(undefined);
  const openGateId = selectedGateId ?? localGateId;
  // A deep link that arrives after mount (the hash changing under an already-rendered page) still
  // lands on the instances tab.
  useEffect(() => {
    if (selectedGateId !== undefined) setTab('instances');
  }, [selectedGateId]);
  function selectGate(gateId: string | null): void {
    setLocalGateId(gateId ?? undefined);
    onSelectGate?.(gateId);
  }

  return (
    <div className="page" data-testid="platform-integrations-page">
      <PageHeader
        title={t('集成', 'Integrations')}
        description={t(
          '平台的集成目录：接入包、announce 过的门实例、以及在用它们的外部运行时。',
          "The platform's integration catalog: connectors, the gate instances that announced themselves, and the external runtimes using them.",
        )}
        breadcrumb={breadcrumbFor('platformIntegrations')}
        primaryAction={
          <Button
            variant="primary"
            icon="plus"
            onClick={() => setLauncherOpen(true)}
            data-testid="connect-system-button"
          >
            {t('接入一个系统', 'Connect a system')}
          </Button>
        }
      />

      <Drawer
        open={launcherOpen}
        onClose={() => setLauncherOpen(false)}
        title={t('接入一个系统', 'Connect a system')}
        subtitle="选类型 → 连接与凭证 → 能力与策略 → 握手验证"
        wide
        testId="connect-system-drawer"
      >
        {launcherOpen ? (
          <ConnectSystemLauncher
            http={http}
            origin="platform"
            onCancel={() => setLauncherOpen(false)}
            onFinished={(result) => {
              setLauncherOpen(false);
              if (result.gateId) {
                setTab('instances');
                selectGate(result.gateId);
              }
            }}
          />
        ) : null}
      </Drawer>

      <Tabs<Tab>
        ariaLabel="Integrations tabs"
        value={tab}
        onChange={setTab}
        options={[
          {
            value: 'connectors',
            label: t('接入包', 'Connectors'),
            testId: 'integrations-tab-connectors',
          },
          {
            value: 'instances',
            label: t('门实例', 'Gate instances'),
            testId: 'integrations-tab-instances',
          },
          {
            value: 'runtimes',
            label: t('外部运行时', 'External runtimes'),
            testId: 'integrations-tab-runtimes',
          },
        ]}
      />

      {tab === 'connectors' ? <ConnectorsTab http={http} /> : null}
      {tab === 'instances' ? (
        <GateInstancesTab http={http} selectedGateId={openGateId} onSelectGate={selectGate} />
      ) : null}
      {tab === 'runtimes' ? <ExternalRuntimesTab http={http} /> : null}
    </div>
  );
}

// -------------------------------------------------------------------------------------------
// 接入包 Connectors
// -------------------------------------------------------------------------------------------

function ConnectorsTab({ http }: { readonly http: CapabilityCaller }) {
  const t = useT();
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
        <SkeletonRows
          count={3}
          label={t('正在加载接入包…', 'Loading connectors')}
          testId="connectors-loading"
        />
      ) : connectors.state.status === 'error' ? (
        <ErrorBanner
          error={connectors.state.error}
          title={t('无法加载接入包目录', 'Could not load the connector catalog')}
          onRetry={() => void connectors.reload()}
          testId="connectors-error"
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="grid"
          title={t('还没有接入包', 'No connectors yet')}
          testId="connectors-empty"
        />
      ) : (
        <div className="table-scroll">
          <table className="data-table" data-testid="connectors-table">
            <thead>
              <tr>
                <th>{t('名称', 'Name')}</th>
                <th>{t('种类', 'Kind')}</th>
                <th>{t('来源', 'Origin')}</th>
                <th>{t('模式', 'Mode')}</th>
                <th>{t('实例数', 'Instances')}</th>
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

/** The select's minimum width — S8 W1-A7 batch design review finding: at 768px the longest mode
 *  value, `platform_preset`, truncated inside the (previously unconstrained) `<select>`. */
const CONNECTOR_MODE_SELECT_STYLE = { minWidth: '11rem' } as const;

function ConnectorRow({
  http,
  connector,
  onChanged,
}: {
  readonly http: CapabilityCaller;
  readonly connector: ConnectorWire;
  readonly onChanged: (connector: ConnectorWire) => void;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [savingMode, setSavingMode] = useState(false);
  const [modeError, setModeError] = useState<unknown | null>(null);
  // S8 W1-A7 (audit S13/PI1): the select no longer applies on change — it stashes the attempted
  // value and opens a confirm next to itself; cancelling (Escape, Cancel, outside click) leaves
  // `pendingMode` null, so the select's own `value` falls back to `connector.mode` and visually
  // reverts. `set_connector_mode` fires only from the confirm's own `onConfirm`.
  const [pendingMode, setPendingMode] = useState<ConnectorModeWire | null>(null);
  const [modeConfirmOpen, setModeConfirmOpen] = useState(false);

  async function changeMode(mode: ConnectorModeWire): Promise<void> {
    if (savingMode) return;
    setSavingMode(true);
    setModeError(null);
    try {
      onChanged(
        await http.call<ConnectorWire>('set_connector_mode', { name: connector.name, mode }),
      );
      setPendingMode(null);
    } catch (err) {
      setModeError(err);
      throw err;
    } finally {
      setSavingMode(false);
    }
  }

  function requestModeChange(mode: ConnectorModeWire): void {
    if (mode === connector.mode) return;
    setPendingMode(mode);
    setModeConfirmOpen(true);
  }

  // The rule (stated in the confirm's own description, not just chosen silently): switching a
  // connector *to* `disabled` while it has live gate instances cuts every one of them off
  // platform-wide at once (audit S13's own wording) — that is the one case worth the extra
  // retype-to-confirm friction. Every other mode change (including disabling a connector with no
  // instances yet) is reversible in effect — flip it back — so a medium popover is enough.
  const disablingInUse = pendingMode === 'disabled' && connector.instanceCount > 0;

  return (
    <>
      <tr data-testid={`connector-row-${connector.name}`}>
        <td className="mono">{connector.name}</td>
        <td>{transportKindLabel(connector.kind, t)}</td>
        <td>{connector.packaged ? t('预置', 'Packaged') : t('通用', 'Generic')}</td>
        <td>
          <Confirm
            tier={disablingInUse ? 'irreversible' : 'medium'}
            open={modeConfirmOpen}
            onOpenChange={(open) => {
              setModeConfirmOpen(open);
              if (!open) setPendingMode(null);
            }}
            anchor={
              <Select
                data-testid={`connector-mode-${connector.name}`}
                style={CONNECTOR_MODE_SELECT_STYLE}
                aria-label={t(
                  `接入包「${connector.name}」的模式`,
                  `Mode for connector "${connector.name}"`,
                )}
                value={pendingMode ?? connector.mode}
                onChange={(event) => requestModeChange(event.target.value as ConnectorModeWire)}
                disabled={savingMode}
              >
                {CONNECTOR_MODE_VALUES.map((mode) => (
                  <option key={mode} value={mode}>
                    {connectorModeLabel(mode, t)}
                  </option>
                ))}
              </Select>
            }
            title={`${t('切换模式为', 'Switch mode to')} ${connectorModeLabel(pendingMode ?? connector.mode, t)}`}
            description={
              disablingInUse
                ? t(
                    'disabled 会立即让所有启用它的工作区都拿不到这个接入包，platform 范围生效。',
                    'disabled immediately cuts off every workspace that enabled this connector, platform-wide.',
                  )
                : `新模式对这个接入包往后的启用/展示生效；改错了可以随时再切回来。 The new mode governs this connector's own enable/visibility from here on — switch it back at any time if this was a mistake.`
            }
            target={disablingInUse ? connector.name : undefined}
            impact={[
              `${connector.instanceCount} 个门实例 gate instances`,
              `${connector.operationCount} 个 Operation`,
            ]}
            confirmLabel={t('切换', 'Switch')}
            danger={pendingMode === 'disabled'}
            onConfirm={() => (pendingMode ? changeMode(pendingMode) : undefined)}
            testId={`connector-mode-confirm-${connector.name}`}
          />
          <PlatformError
            error={modeError}
            title={t('无法设置模式', 'Could not set the mode')}
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
            {expanded ? t('收起', 'Collapse') : t('展开', 'Expand')}
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
  const t = useT();
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
        {t(
          '禁用后下一次调用即被拒绝；这个改动不影响已经启用它的工作区。',
          'Disabled from the next call on — it never affects a workspace that already enabled this instance.',
        )}
      </Notice>
      {instances.state.status === 'loading' ? (
        <SkeletonRows count={2} label="Loading instances" />
      ) : instances.state.status === 'error' ? (
        <ErrorBanner
          error={instances.state.error}
          title={t('无法读取实例', "Could not load this connector's instances")}
          onRetry={() => void instances.reload()}
        />
      ) : names.length === 0 ? (
        <p className="text-3">{t('还没有已知的', 'Operation No known Operations yet')}</p>
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
      <PlatformError error={error} title={t('无法保存禁用列表', 'Could not save the deny list')} />
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button variant="secondary" onClick={() => void save()} loading={saving} disabled={!dirty}>
          {t('保存', 'Save')}
        </Button>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------------------------------
// 门实例 Gate instances
// -------------------------------------------------------------------------------------------

type InstancesPanel =
  | { readonly kind: 'closed' }
  | { readonly kind: 'create' }
  | { readonly kind: 'gate'; readonly gateId: string };

function GateInstancesTab({
  http,
  selectedGateId,
  onSelectGate,
}: {
  readonly http: CapabilityCaller;
  readonly selectedGateId?: string;
  readonly onSelectGate?: (gateId: string | null) => void;
}) {
  const t = useT();
  const [panel, setPanelState] = useState<InstancesPanel>(() =>
    selectedGateId !== undefined ? { kind: 'gate', gateId: selectedGateId } : { kind: 'closed' },
  );
  // The route is the source of truth for which drawer is open when the page is deep-linked; a
  // local open/close also updates the hash through `onSelectGate` when the caller wires it.
  useEffect(() => {
    if (selectedGateId !== undefined) setPanelState({ kind: 'gate', gateId: selectedGateId });
  }, [selectedGateId]);
  function setPanel(next: InstancesPanel): void {
    setPanelState(next);
    if (next.kind === 'gate') onSelectGate?.(next.gateId);
    else if (panel.kind === 'gate') onSelectGate?.(null);
  }
  const instances = useCapabilityList<GateInstanceWire>(http, 'list_gate_instances', {});
  const rows = instances.state.status === 'ready' ? instances.state.data.items : [];
  const open = panel.kind === 'gate' ? rows.find((row) => row.gateId === panel.gateId) : undefined;

  function replace(updated: GateInstanceWire): void {
    instances.mutate((data) => ({
      ...data,
      items: data.items.map((row) => (row.gateId === updated.gateId ? updated : row)),
    }));
  }

  /** `create_gate_instance` already answers with the full, current row — no reload needed before
   *  opening its detail drawer (the `PlatformWorkspacesPage`'s own `handleCreated` shape, minus
   *  the reload it does for a reason specific to that page). */
  function handleCreated(created: GateInstanceWire): void {
    instances.mutate((data) => ({ ...data, items: [created, ...data.items] }));
    setPanel({ kind: 'gate', gateId: created.gateId });
  }

  function handleDeleted(gateId: string): void {
    instances.mutate((data) => ({
      ...data,
      items: data.items.filter((row) => row.gateId !== gateId),
    }));
    setPanel({ kind: 'closed' });
  }

  return (
    <div className="stack" data-testid="integrations-instances">
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        {/* S8 W1-A11 (audit L2): secondary, not primary — the page header's "接入一个系统" is
         *  this view's one ink primary action, and both buttons are visible together whenever
         *  this tab is open. */}
        <Button
          variant="secondary"
          size="s"
          icon="plus"
          onClick={() => setPanel({ kind: 'create' })}
          data-testid="new-gate-instance"
        >
          {t('新建门宿主实例', 'Create hosted instance')}
        </Button>
      </div>

      {instances.state.status === 'loading' ? (
        <SkeletonRows
          count={3}
          label={t('正在加载门实例…', 'Loading gate instances')}
          testId="gate-instances-loading"
        />
      ) : instances.state.status === 'error' ? (
        <ErrorBanner
          error={instances.state.error}
          title={t('无法加载门实例', 'Could not load gate instances')}
          onRetry={() => void instances.reload()}
          testId="gate-instances-error"
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="connections"
          title={t('还没有门实例announce过', 'No gate instance has announced itself yet')}
          testId="gate-instances-empty"
        />
      ) : (
        <div className="table-scroll">
          <table className="data-table" data-testid="gate-instances-table">
            <thead>
              <tr>
                <th>{t('名称', 'Name')}</th>
                <th>{t('接入包', 'Connector')}</th>
                <th>{t('种类', 'Kind')}</th>
                <th>{t('状态', 'Status')}</th>
                <th>{t('健康', 'Health')}</th>
                <th>{t('最近心跳', 'Last seen')}</th>
                <th>Operation 数</th>
                <th>启用它的工作区数</th>
                <th aria-label="Trust" />
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                // The whole row opens the detail drawer for pointer users; the 详情 Details button
                // in the last cell is the keyboard path (S6-A0 / C13 — a `<tr>` with only
                // `onClick`/`onKeyDown` and no focusable child was unreachable by keyboard; same
                // pattern as `PlatformWorkspacesPage`'s `WorkspaceRow`). `setPanel` is idempotent,
                // so the button's click bubbling up to the row costs nothing. The row's own key
                // handler only answers keys aimed at the row itself (never at the button, which
                // handles Enter/Space natively) — it exists for the lint pairing, not as the path.
                <tr
                  key={row.gateId}
                  className="row-clickable"
                  data-testid={`gate-instance-row-${row.gateId}`}
                  onClick={() => setPanel({ kind: 'gate', gateId: row.gateId })}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setPanel({ kind: 'gate', gateId: row.gateId });
                    }
                  }}
                >
                  <td>
                    <div className="stack-s" style={{ gap: 0 }}>
                      <span>
                        {row.displayName}
                        {row.hosted ? (
                          <span className="tag" data-testid="gate-hosted-badge">
                            {t('宿主', 'hosted')}
                          </span>
                        ) : null}
                      </span>
                      <span className="mono text-3">{row.gateId}</span>
                    </div>
                  </td>
                  <td className="mono">{row.connector}</td>
                  <td>{row.transportKind}</td>
                  <td>
                    <StatusChip
                      machine="gateInstance"
                      status={deriveGateInstanceStatus(row)}
                      size="s"
                      testId="gate-instance-status"
                    />
                  </td>
                  <td>
                    <StatusChip
                      machine="gateHealth"
                      status={row.health}
                      size="s"
                      testId="gate-instance-health"
                    />
                  </td>
                  <td>
                    {row.lastSeenAt === null ? (
                      t('从未', 'Never')
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
                  <td>
                    <Button
                      variant="ghost"
                      onClick={() => setPanel({ kind: 'gate', gateId: row.gateId })}
                      data-testid={`gate-instance-open-${row.gateId}`}
                    >
                      {t('详情', 'Details')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Drawer
        open={panel.kind === 'create'}
        onClose={() => setPanel({ kind: 'closed' })}
        title={t('新建门宿主实例', 'Create hosted instance')}
        subtitle={t(
          'cli/ssh 由管理员部署；http/mcp 由门宿主接管并导入它的 Operation。',
          'administrator, http/mcp; the gate host takes it over and imports its Operations.',
        )}
        testId="create-gate-instance-drawer"
      >
        {panel.kind === 'create' ? (
          <CreateGateInstanceForm
            http={http}
            onCreated={handleCreated}
            onCancel={() => setPanel({ kind: 'closed' })}
          />
        ) : null}
      </Drawer>

      <Drawer
        open={open !== undefined}
        onClose={() => setPanel({ kind: 'closed' })}
        title={open?.displayName ?? t('门实例', 'Gate instance')}
        subtitle={open ? <span className="mono">{open.gateId}</span> : undefined}
        testId="gate-instance-drawer"
      >
        {open ? (
          <GateInstanceDetailPanel
            key={open.gateId}
            http={http}
            instance={open}
            onChanged={replace}
            onDeleted={handleDeleted}
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
  const t = useT();
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
          {t('刷新', 'Refresh')}
        </Button>
      </div>

      {runtimes.state.status === 'loading' ? (
        <SkeletonRows
          count={2}
          label={t('正在加载外部运行时…', 'Loading external runtimes')}
          testId="external-runtimes-loading"
        />
      ) : runtimes.state.status === 'error' ? (
        <ErrorBanner
          error={runtimes.state.error}
          title={t('无法加载外部运行时', 'Could not load external runtimes')}
          onRetry={() => void runtimes.reload()}
          testId="external-runtimes-error"
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="link"
          title={t('还没有外部运行时', 'No external runtimes yet')}
          body={t(
            'Claude Code、通过 /mcp 连接的本机 pi，或一个 collector 在签发 Handle 并建立会话后会出现在这里。',
            'Claude Code, a local pi connected over /mcp, or a collector shows up here once it holds an issued Handle and has an open session.',
          )}
          testId="external-runtimes-empty"
        />
      ) : (
        <div className="table-scroll">
          <table className="data-table" data-testid="external-runtimes-table">
            <thead>
              <tr>
                <th>{t('工作区', 'Workspace')}</th>
                <th>Principal</th>
                <th>{t('会话种类', 'Session kind')}</th>
                <th>{t('创建时间', 'Created')}</th>
                <th>{t('过期', 'Expires')}</th>
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
  const t = useT();
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
        <PlatformError error={error} title={t('无法吊销', 'Could not revoke this runtime')} />
        {confirming ? (
          <div className="row-wrap" style={{ justifyContent: 'flex-end' }}>
            <Button variant="ghost" size="s" onClick={() => setConfirming(false)}>
              {t('取消', 'Cancel')}
            </Button>
            <Button variant="danger" size="s" onClick={() => void revoke()} loading={revoking}>
              {t('确认吊销', 'Confirm revoke')}
            </Button>
          </div>
        ) : (
          <Button
            variant="danger"
            size="s"
            onClick={() => setConfirming(true)}
            data-testid={`external-runtime-revoke-${runtime.sessionId}`}
          >
            {t('吊销', 'Revoke')}
          </Button>
        )}
      </td>
    </tr>
  );
}
