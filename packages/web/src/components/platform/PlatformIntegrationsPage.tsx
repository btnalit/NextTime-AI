import type {
  ConnectorModeWire,
  ConnectorWire,
  ExternalRuntimeWire,
  GateInstanceWire,
  SelfConnectionWire,
} from '@nexttime/shared';
import { isGenericConnector } from '@nexttime/shared';
import { useEffect, useState } from 'react';
import { useCapabilityList } from '../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { addressText } from '../../lib/connections.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { connectorModeLabel, principalShownName, transportKindLabel } from '../../lib/labels.js';
import { breadcrumbFor } from '../../lib/nav.js';
import { type IntegrationsTab, hrefs, navigate, readIntegrationsTab } from '../../lib/router.js';
import { deriveGateInstanceStatus, deriveSelfConnectionStatus } from '../../lib/status-tone.js';
import { ConnectSystemLauncher } from '../connect/ConnectSystemLauncher.js';
import { Confirm } from '../kit/confirm.js';
import { DataTable, type DataTableColumn } from '../kit/data-table.js';
import { PageHeader } from '../kit/page-header.js';
import { RedactedNote } from '../kit/redacted-note.js';
import { Button } from '../ui/Button.js';
import { Drawer } from '../ui/Drawer.js';
import { EmptyState } from '../ui/EmptyState.js';
import { ErrorBanner } from '../ui/ErrorBanner.js';
import { Field, Input, Select, describedBy } from '../ui/Field.js';
import { Notice } from '../ui/Notice.js';
import { SkeletonRows } from '../ui/Skeleton.js';
import { StatusChip } from '../ui/StatusChip.js';
import { Tabs } from '../ui/Tabs.js';
import { CreateGateInstanceForm } from './CreateGateInstanceForm.js';
import { GateInstanceDetailPanel } from './GateInstanceDetailPanel.js';
import { PlatformError } from './PlatformError.js';
import {
  hiddenFromWorkspaces,
  hiddenInstanceBadge,
  useConnectorsByName,
} from './integrations/connector-visibility.js';
import { useConnectorDenyList } from './integrations/useConnectorDenyList.js';
import { useConnectorMode } from './integrations/useConnectorMode.js';
import { useGateInstancesPanel } from './integrations/useGateInstancesPanel.js';
import { useRevokeRuntime } from './integrations/useRevokeRuntime.js';
import {
  SUSPENSION_REASON_MAX,
  useSelfConnectionSuspension,
} from './integrations/useSelfConnectionSuspension.js';

const CONNECTOR_MODE_VALUES: readonly ConnectorModeWire[] = [
  'disabled',
  'self_serve',
  'platform_preset',
];

type Tab = IntegrationsTab;

/** The tab a bare `#/platform/integrations[?tab=…]` names; `null` on an instance's own URL. */
function tabInHash(): Tab | null {
  const hash = window.location.hash;
  if (hash.split('?')[0] !== hrefs.platformIntegrations()) return null;
  return readIntegrationsTab(hash) ?? 'connectors';
}

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
 * announced itself (rename / enable-disable / MCP trust / test connection), the gates workspaces
 * connected themselves (P0b: the platform's per-connection 暂停 / 恢复 cut-off for them — the
 * connector mode only gates new connections), and the inventory of external runtimes (Claude
 * Code, a local pi over `/mcp`, a collector) across every workspace.
 * The workspace-side "enable from platform catalog" and "issue a service Handle" halves live on
 * `ConnectionsPage`/`AccessPage` instead — they need a workspace and a Principal, which this
 * platform-scope page has neither of (design §6.3's own split, `development-tasks.md` §P-B
 * "拆分与决定").
 *
 * S6-C (docs/console-completion-plan.md §5.6): the page's one primary action is "接入一个系统
 * Connect a system" — the same `ConnectSystemLauncher` the workspace 系统接入 page opens, mounted
 * here with `origin: 'platform'` (the workspace steps link to 系统接入). The 门实例 tab keeps its
 * own 新建门宿主实例 button as the quick path.
 *
 * Each tab's own state/business logic (console redesign P1) moved to `platform/integrations/use*`
 * hooks — none of them render anything or need `components/ui/*`. The tabs' JSX itself stays here:
 * it renders `Button`/`Drawer`/`EmptyState`/`ErrorBanner`/`Select`/`Notice`/`SkeletonRows`/
 * `StatusChip`, none of which have an identical-rendering `components/kit/*` replacement yet
 * (`scripts/guards/legacy-ui-importers.json`).
 */
export function PlatformIntegrationsPage({
  http,
  selectedGateId,
  onSelectGate,
}: PlatformIntegrationsPageProps) {
  const t = useT();
  const [tab, setTab] = useState<Tab>(
    selectedGateId !== undefined ? 'instances' : (tabInHash() ?? 'connectors'),
  );
  // Legacy 380: the tab is in the URL — a change writes it, and back / forward reads it again.
  function changeTab(next: Tab): void {
    setTab(next);
    navigate(hrefs.platformIntegrationsTab(next));
  }
  useEffect(() => {
    const follow = () => {
      const fromHash = tabInHash();
      if (fromHash !== null) setTab(fromHash);
    };
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, []);
  const [launcherOpen, setLauncherOpen] = useState(false);
  // The 自己接入的门 tab's connector filter — set from a connector row's count, or the tab's own select.
  const [selfConnector, setSelfConnector] = useState<string | null>(null);
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
          '平台的集成目录：接入包、已公布的门实例、工作区自己接入的门，以及正在使用它们的外部运行时。',
          "The platform's integration catalog: connectors, the gate instances that announced themselves, the gates workspaces connected themselves, and the external runtimes using them.",
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
                // `selectGate` writes the instance's own URL.
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
        onChange={changeTab}
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
            value: 'self',
            label: t('自己接入的门', 'Self-connected gates'),
            testId: 'integrations-tab-self',
          },
          {
            value: 'runtimes',
            label: t('外部运行时', 'External runtimes'),
            testId: 'integrations-tab-runtimes',
          },
        ]}
      />

      {tab === 'connectors' ? (
        <ConnectorsTab
          http={http}
          onShowSelfConnections={(connector) => {
            setSelfConnector(connector);
            changeTab('self');
          }}
        />
      ) : null}
      {tab === 'instances' ? (
        <GateInstancesTab
          http={http}
          selectedGateId={openGateId}
          onSelectGate={selectGate}
          onShowConnectors={() => {
            selectGate(null);
            changeTab('connectors');
          }}
        />
      ) : null}
      {tab === 'self' ? (
        <SelfConnectionsTab
          http={http}
          connector={selfConnector}
          onConnectorChange={setSelfConnector}
          onShowInstance={(gateId) => {
            setTab('instances');
            selectGate(gateId);
          }}
        />
      ) : null}
      {tab === 'runtimes' ? <ExternalRuntimesTab http={http} /> : null}
    </div>
  );
}

// -------------------------------------------------------------------------------------------
// 接入包 Connectors
// -------------------------------------------------------------------------------------------

function ConnectorsTab({
  http,
  onShowSelfConnections,
}: {
  readonly http: CapabilityCaller;
  /** Opens 自己接入的门 filtered to one connector (its row's count). */
  readonly onShowSelfConnections: (connector: string) => void;
}) {
  const t = useT();
  const connectors = useCapabilityList<ConnectorWire>(http, 'list_connectors', {});
  const rows = connectors.state.status === 'ready' ? connectors.state.data.items : [];
  // UX acceptance of #538 (out of scope there): which connectors have enabled instances — those
  // vanish from every workspace's catalog unless the connector is platform preset. A failed read
  // just leaves the hint out.
  const instances = useCapabilityList<GateInstanceWire>(http, 'list_gate_instances', ALL_INSTANCES);
  const enabledByConnector = new Map<string, number>();
  if (instances.state.status === 'ready') {
    for (const instance of instances.state.data.items) {
      if (instance.status !== 'enabled') continue;
      enabledByConnector.set(
        instance.connector,
        (enabledByConnector.get(instance.connector) ?? 0) + 1,
      );
    }
  }

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
          <table className="data-table data-table-cards" data-testid="connectors-table">
            <thead>
              <tr>
                <th>{t('名称', 'Name')}</th>
                <th>{t('种类', 'Kind')}</th>
                <th>{t('来源', 'Origin')}</th>
                <th>{t('模式', 'Mode')}</th>
                <th>{t('实例数', 'Instances')}</th>
                <th>{t('工作区自接', 'Self-connected')}</th>
                <th>Operation 数</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <ConnectorRow
                  key={row.name}
                  http={http}
                  connector={row}
                  enabledInstanceCount={enabledByConnector.get(row.name) ?? 0}
                  onChanged={replace}
                  onShowSelfConnections={() => onShowSelfConnections(row.name)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** R-41 (review 2026-10-02, maintainer decision D-19(a)): what a mode switch actually does — the
 *  mode is catalog visibility plus the gate on NEW connections (`enable_gate_instance`, and for the
 *  generic kinds `create_connection` / `request_connection`, R-40); it never touches a workspace
 *  that already enabled the connector. The real cut-off for those is the Operation deny list, which
 *  the same confirm offers (`useConnectorMode`'s `alsoDisableOperations`). A gate a workspace
 *  connected itself is outside both; P0b gave it its own cut-off (自己接入的门 → 暂停). */
function connectorModeDescription(
  pendingMode: ConnectorModeWire | null,
  catalogOnly: boolean,
  t: Translate,
  hidesEnabled = 0,
): string {
  // Leaving platform preset takes its enabled instances out of every workspace's catalog — said
  // first, with the count (UX acceptance of #538: nothing said so).
  const hides =
    hidesEnabled > 0
      ? t(
          `这个接入包有 ${hidesEnabled} 个已启用的实例，切换后它们会从各工作区的「待启用的平台实例」里消失，工作区也不能再启用它们。`,
          `This connector has ${hidesEnabled} enabled instance(s); after the switch they disappear from every workspace's “Platform instances pending enable” and can no longer be enabled there. `,
        )
      : '';
  return `${hides}${connectorModeDescriptionBody(pendingMode, catalogOnly, t)}`;
}

/** `catalogOnly`: not one of the generic connectors, so its mode never reaches a workspace's own
 *  connections (R-40 reads only the connector named by the connection's kind). */
function connectorModeDescriptionBody(
  pendingMode: ConnectorModeWire | null,
  catalogOnly: boolean,
  t: Translate,
): string {
  if (pendingMode === 'disabled') {
    return catalogOnly
      ? t(
          '禁用只拦新的：目录里不再列出它，工作区不能再启用它的实例。已经启用它的工作区照常可以调用——要立即切断，勾选下面的「同时禁用全部 Operation」。',
          'Disabling only stops new use: the catalog stops listing it and workspaces can no longer enable its instances. Workspaces that already enabled it keep calling it — to cut them off now, tick "Also disable all operations" below.',
        )
      : t(
          '禁用只拦新的：目录里不再列出它，工作区不能再启用它的实例，也不能再自己连这一类系统。已经启用它的工作区照常可以调用——要立即切断，勾选下面的「同时禁用全部 Operation」。工作区此前自己连的同类系统不受接入包状态影响；要切断其中某一个，到「自己接入的门」里暂停它。',
          'Disabling only stops new use: the catalog stops listing it, and workspaces can no longer enable its instances or connect this kind of system themselves. Workspaces that already enabled it keep calling it — to cut them off now, tick "Also disable all operations" below. Systems of this kind a workspace already connected itself are not affected by the connector state; to cut one of them off, suspend it under "Self-connected gates".',
        );
  }
  if (pendingMode === 'platform_preset' && !catalogOnly) {
    return t(
      '切到平台预置后，工作区只能从目录启用它的实例，不能再自己连这一类系统；已经建立的连接不受影响。改错了可以随时再切回来。',
      'As a platform preset, workspaces can only enable its instances from the catalog and can no longer connect this kind of system themselves; existing connections are unaffected. Switch it back at any time if this was a mistake.',
    );
  }
  return t(
    '新模式对这个接入包往后的启用/展示生效，已经建立的连接不受影响；改错了可以随时再切回来。',
    "The new mode governs this connector's enable/visibility from here on; existing connections are unaffected. Switch it back at any time if this was a mistake.",
  );
}

/** The connector table's 来源 column: a packaged gate's, a generic kind, or one an administrator
 *  named for a system's gate-host instances (P1, `create_gate_instance`'s `connector`). Legacy 398:
 *  「打包的门」, the console's word for a packaged gate elsewhere — 「预置」 read as the 模式
 *  column's 「平台预置」 next to it, which means something else. */
function connectorOriginLabel(connector: ConnectorWire, t: Translate): string {
  if (connector.packaged) return t('打包的门', 'Packaged gate');
  if (isGenericConnector(connector.name)) return t('通用', 'Generic');
  return t('门宿主', 'Gate host');
}

/** The select's minimum width — S8 W1-A7 batch design review finding: at 768px the longest mode
 *  value, `platform_preset`, truncated inside the (previously unconstrained) `<select>`. */
const CONNECTOR_MODE_SELECT_STYLE = { minWidth: '11rem' } as const;

function ConnectorRow({
  http,
  connector,
  enabledInstanceCount,
  onChanged,
  onShowSelfConnections,
}: {
  readonly http: CapabilityCaller;
  readonly connector: ConnectorWire;
  /** Instances of this connector the platform has enabled (`list_gate_instances`). */
  readonly enabledInstanceCount: number;
  readonly onChanged: (connector: ConnectorWire) => void;
  readonly onShowSelfConnections: () => void;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const mode = useConnectorMode(http, connector, onChanged);
  const { instanceCount, operationCount } = connector;

  return (
    <>
      <tr data-testid={`connector-row-${connector.name}`}>
        <td className="mono">{connector.name}</td>
        <td data-label={t('种类', 'Kind')}>{transportKindLabel(connector.kind, t)}</td>
        <td data-label={t('来源', 'Origin')}>{connectorOriginLabel(connector, t)}</td>
        <td data-label={t('模式', 'Mode')}>
          <Confirm
            tier="medium"
            open={mode.modeConfirmOpen}
            onOpenChange={mode.onModeConfirmOpenChange}
            anchor={
              <Select
                data-testid={`connector-mode-${connector.name}`}
                style={CONNECTOR_MODE_SELECT_STYLE}
                aria-label={t(
                  `接入包「${connector.name}」的模式`,
                  `Mode for connector "${connector.name}"`,
                )}
                value={mode.pendingMode ?? connector.mode}
                onChange={(event) =>
                  mode.requestModeChange(event.target.value as ConnectorModeWire)
                }
                disabled={mode.savingMode}
              >
                {CONNECTOR_MODE_VALUES.map((value) => (
                  <option key={value} value={value}>
                    {connectorModeLabel(value, t)}
                  </option>
                ))}
              </Select>
            }
            title={`${t('切换模式为', 'Switch mode to')} ${connectorModeLabel(mode.pendingMode ?? connector.mode, t)}`}
            description={connectorModeDescription(
              mode.pendingMode,
              !isGenericConnector(connector.name),
              t,
              connector.mode === 'platform_preset' && mode.pendingMode !== 'platform_preset'
                ? enabledInstanceCount
                : 0,
            )}
            target={connector.name}
            impact={[
              t(`${instanceCount} 个门实例`, `${instanceCount} gate instance(s)`),
              t(`${operationCount} 个 Operation`, `${operationCount} operation(s)`),
            ]}
            confirmLabel={t('切换', 'Switch')}
            danger={mode.pendingMode === 'disabled'}
            onConfirm={() => (mode.pendingMode ? mode.changeMode(mode.pendingMode) : undefined)}
            testId={`connector-mode-confirm-${connector.name}`}
          >
            {mode.disablingInUse ? (
              <label className="checkbox" data-testid={`connector-mode-deny-all-${connector.name}`}>
                <input
                  type="checkbox"
                  checked={mode.alsoDisableOperations}
                  onChange={(event) => mode.setAlsoDisableOperations(event.target.checked)}
                  disabled={mode.savingMode}
                  data-testid={`connector-mode-deny-all-checkbox-${connector.name}`}
                />
                <span>
                  {t(
                    `同时禁用全部 ${operationCount} 个 Operation：已从目录启用它的工作区下一次调用即被拒绝，这才是真正的切断。以后新上报的 Operation 不在其中；可以在展开的「允许调用的操作」里逐个恢复。`,
                    `Also disable all ${operationCount} operation(s): workspaces that enabled it from the catalog are refused on their next call — this is the actual cut-off. Operations announced later are not included; re-allow them one by one under "Operations agents may call".`,
                  )}
                </span>
              </label>
            ) : null}
          </Confirm>
          <PlatformError
            error={mode.modeError}
            title={t('无法设置模式', 'Could not set the mode')}
            testId={`connector-mode-error-${connector.name}`}
          />
          {connector.mode !== 'platform_preset' && enabledInstanceCount > 0 ? (
            <p
              className="text-3 text-small"
              style={{ margin: 0 }}
              data-testid={`connector-hidden-instances-${connector.name}`}
            >
              {t(
                `${enabledInstanceCount} 个已启用的实例不会出现在工作区的「待启用的平台实例」里（不是「平台预置」），还没启用它们的工作区看不到，也启用不了；已经启用的工作区照常使用。`,
                `${enabledInstanceCount} enabled instance(s) do not show up in a workspace's “Platform instances pending enable” (not platform preset): a workspace that has not enabled them can neither see nor enable them; workspaces that already did keep using them.`,
              )}
            </p>
          ) : null}
        </td>
        <td className="mono" data-label={t('实例数', 'Instances')}>
          {connector.instanceCount}
        </td>
        <td data-label={t('工作区自接', 'Self-connected')}>
          {!isGenericConnector(connector.name) ? (
            // `create_connection` takes only the four generic kinds — no other connector has any.
            <span className="text-3">—</span>
          ) : connector.selfConnectionCount === 0 ? (
            <span className="mono">0</span>
          ) : (
            <Button
              variant="ghost"
              size="s"
              onClick={onShowSelfConnections}
              data-testid={`connector-self-connections-${connector.name}`}
            >
              {connector.suspendedSelfConnectionCount > 0
                ? t(
                    `${connector.selfConnectionCount} 个（${connector.suspendedSelfConnectionCount} 个已暂停）`,
                    `${connector.selfConnectionCount} (${connector.suspendedSelfConnectionCount} suspended)`,
                  )
                : t(`${connector.selfConnectionCount} 个`, `${connector.selfConnectionCount}`)}
            </Button>
          )}
        </td>
        <td className="mono" data-label="Operation 数">
          {connector.operationCount}
        </td>
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
        <tr data-expanded-detail="">
          <td colSpan={8}>
            <ConnectorDenyList http={http} connector={connector} onChanged={onChanged} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** The per-Operation allow checklist for one connector — mounted only while its row is expanded
 *  (the `UserPicker` lazy-read shape), since `list_gate_instances{connector}` is otherwise a read
 *  no page needs until an administrator actually opens this row.
 *
 *  Production incident 2026-09-26: checked now means "the agent may call it" (default all checked)
 *  — the old checklist rendered checked = disabled, which reads backwards next to every other
 *  checklist in this console and invites exactly the mistake that caused the incident. The wire
 *  payload is unchanged (`set_connector_mode`'s `disabledOperations` still names what is refused);
 *  only this component's own rendering inverts (`useConnectorDenyList`'s own doc comment has the
 *  full reasoning). Unchecking something a linked workspace could already call needs a confirm
 *  naming exactly what would newly stop working — re-checking something back on needs none. */
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
  const denyList = useConnectorDenyList(http, connector, onChanged);
  const { instances } = denyList;
  const [filter, setFilter] = useState('');
  const needle = filter.trim().toLowerCase();
  const shown =
    needle === ''
      ? denyList.names
      : denyList.names.filter((name) => name.toLowerCase().includes(needle));
  const allowedCount = denyList.names.filter((name) => !denyList.disabled.includes(name)).length;

  return (
    <div
      className="stack-s"
      data-testid={`connector-disabled-ops-${connector.name}`}
      style={{ padding: '8px 0' }}
    >
      <strong>{t('允许调用的操作', 'Operations agents may call')}</strong>
      <Notice>
        {t(
          '取消勾选会在下一次调用即被拒绝，对每一个启用了这个接入包实例的工作区都生效；已经在运行的入口 agent 会被立即刷新，而不是等到它自己重新签发凭证。',
          'Unchecking takes effect on the very next call, in every workspace that enabled an instance of this connector — running entry agents are refreshed immediately rather than waiting for their own credentials to reissue.',
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
      ) : denyList.names.length === 0 ? (
        <p className="text-3">{t('还没有已知的 Operation', 'No known Operations yet')}</p>
      ) : (
        <>
          {/* field-inventory #10: a connector can announce dozens of Operations — find one by
           *  name, and allow / refuse everything the filter shows in one click. */}
          <div className="row-wrap">
            <Input
              aria-label={t('筛选操作', 'Filter operations')}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={t('按名称筛选…', 'Filter by name…')}
              mono
              data-testid={`connector-ops-filter-${connector.name}`}
            />
            <Button
              variant="ghost"
              size="s"
              onClick={() => denyList.setAllowed(shown, true)}
              loading={denyList.saving}
              data-testid={`connector-ops-allow-all-${connector.name}`}
            >
              {needle === '' ? t('全部允许', 'Allow all') : t('允许筛出的', 'Allow shown')}
            </Button>
            <Button
              variant="ghost"
              size="s"
              onClick={() => denyList.setAllowed(shown, false)}
              loading={denyList.saving}
              data-testid={`connector-ops-deny-all-${connector.name}`}
            >
              {needle === '' ? t('全部停用', 'Disable all') : t('停用筛出的', 'Disable shown')}
            </Button>
            <span
              className="text-3 text-small"
              data-testid={`connector-ops-count-${connector.name}`}
            >
              {t(
                `允许 ${allowedCount} / ${denyList.names.length} 个`,
                `${allowedCount} of ${denyList.names.length} allowed`,
              )}
            </span>
          </div>
          {shown.length === 0 ? (
            <p className="text-3 text-small">
              {t('没有名称匹配的操作。', 'No operation name matches.')}
            </p>
          ) : (
            shown.map((name) => (
              <label className="checkbox" key={name}>
                <input
                  type="checkbox"
                  checked={!denyList.disabled.includes(name)}
                  onChange={() => denyList.toggle(name)}
                  disabled={denyList.saving}
                />
                <span className="mono">{name}</span>
              </label>
            ))
          )}
        </>
      )}
      <PlatformError error={denyList.error} title={t('无法保存', 'Could not save')} />
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Confirm
          tier="medium"
          open={denyList.confirmOpen}
          onOpenChange={denyList.onConfirmOpenChange}
          anchor={
            // ux-lint-allow-disabled: nothing changed yet — the list shows the saved entries.
            <Button
              variant="secondary"
              onClick={() => denyList.requestSave()}
              loading={denyList.saving}
              disabled={!denyList.dirty}
            >
              {t('保存', 'Save')}
            </Button>
          }
          title={t('停用这些操作？', 'Disable these operations?')}
          description={t(
            '取消勾选的操作会在下一次调用即被拒绝，对每一个启用了这个接入包实例的工作区都生效；已经在运行的入口 agent 会被刷新。',
            'Unchecked operations refuse the very next call, in every workspace that enabled an instance of this connector — running entry agents are refreshed.',
          )}
          impact={[
            t(
              `${denyList.newlyDisabled.length} 个操作：${denyList.newlyDisabled.join('、')}`,
              `${denyList.newlyDisabled.length} operation(s): ${denyList.newlyDisabled.join(', ')}`,
            ),
            t(
              `${denyList.enabledWorkspaceCount} 个已启用的工作区`,
              `${denyList.enabledWorkspaceCount} enabled workspace(s)`,
            ),
          ]}
          confirmLabel={t('停用', 'Disable')}
          danger
          onConfirm={() => denyList.confirmSave()}
          testId={`connector-deny-list-confirm-${connector.name}`}
        />
      </div>
    </div>
  );
}

// -------------------------------------------------------------------------------------------
// 门实例 Gate instances
// -------------------------------------------------------------------------------------------

function GateInstancesTab({
  http,
  selectedGateId,
  onSelectGate,
  onShowConnectors,
}: {
  readonly http: CapabilityCaller;
  readonly selectedGateId?: string;
  readonly onSelectGate?: (gateId: string | null) => void;
  /** Leaves the instance drawer for the 接入包 tab, where a connector's mode is switched. */
  readonly onShowConnectors: () => void;
}) {
  const t = useT();
  const panel = useGateInstancesPanel(http, selectedGateId, onSelectGate);
  const { instances, rows, open, setPanel } = panel;
  const connectors = useConnectorsByName(http);

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
          title={t('还没有门实例公布过自己', 'No gate instance has announced itself yet')}
          testId="gate-instances-empty"
        />
      ) : (
        <div className="table-scroll">
          <table className="data-table data-table-cards" data-testid="gate-instances-table">
            <thead>
              <tr>
                <th>{t('名称', 'Name')}</th>
                <th>{t('接入包', 'Connector')}</th>
                <th>{t('种类', 'Kind')}</th>
                <th>{t('状态', 'Status')}</th>
                <th>{t('健康', 'Health')}</th>
                <th>{t('最近心跳', 'Last seen')}</th>
                <th>Operation 数</th>
                <th>{t('启用它的工作区数', 'Enabling workspaces')}</th>
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
                      <span className="row-wrap">
                        <span>{row.displayName}</span>
                        {row.hosted ? (
                          <span className="tag" data-testid="gate-hosted-badge">
                            {t('宿主', 'hosted')}
                          </span>
                        ) : null}
                        {/* Legacy K (UX acceptance of #538): a held manifest is visible from the
                         *  list, and says when calls are already refused because of it. */}
                        {row.pendingManifest ? (
                          <span
                            className="chip chip-s chip-warn"
                            data-testid="gate-pending-manifest-badge"
                          >
                            {row.pendingManifest.refusedOperations.length > 0
                              ? t(
                                  '新清单待采用 · 调用被拒',
                                  'New manifest to adopt · calls refused',
                                )
                              : t('新清单待采用', 'New manifest to adopt')}
                          </span>
                        ) : null}
                        {hiddenFromWorkspaces(row, connectors) !== null ? (
                          <span
                            className="chip chip-s chip-warn"
                            data-testid="gate-hidden-from-workspaces-badge"
                          >
                            {hiddenInstanceBadge(row, t)}
                          </span>
                        ) : null}
                      </span>
                      <span className="mono text-3">{row.gateId}</span>
                    </div>
                  </td>
                  <td className="mono" data-label={t('接入包', 'Connector')}>
                    {row.connector}
                  </td>
                  <td data-label={t('种类', 'Kind')}>{transportKindLabel(row.transportKind, t)}</td>
                  <td data-label={t('状态', 'Status')}>
                    <StatusChip
                      machine="gateInstance"
                      status={deriveGateInstanceStatus(row)}
                      size="s"
                      testId="gate-instance-status"
                    />
                  </td>
                  <td data-label={t('健康', 'Health')}>
                    <StatusChip
                      machine="gateHealth"
                      status={row.health}
                      size="s"
                      testId="gate-instance-health"
                    />
                  </td>
                  <td data-label={t('最近心跳', 'Last seen')}>
                    {row.lastSeenAt === null ? (
                      t('从未', 'Never')
                    ) : (
                      <time title={formatDateTime(row.lastSeenAt)}>
                        {formatRelative(row.lastSeenAt)}
                      </time>
                    )}
                  </td>
                  <td className="mono" data-label="Operation 数">
                    {row.operationCount}
                  </td>
                  <td className="mono" data-label={t('启用它的工作区数', 'Enabling workspaces')}>
                    {row.enabledWorkspaceCount}
                  </td>
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
        open={panel.panel.kind === 'create'}
        onClose={() => setPanel({ kind: 'closed' })}
        title={t('新建门宿主实例', 'Create hosted instance')}
        subtitle={t(
          'cli/ssh 由管理员部署；http/mcp 由门宿主接管并导入它的 Operation。',
          'administrator, http/mcp; the gate host takes it over and imports its Operations.',
        )}
        testId="create-gate-instance-drawer"
      >
        {panel.panel.kind === 'create' ? (
          <CreateGateInstanceForm
            http={http}
            initialPreset={panel.panel.preset}
            onCreated={panel.handleCreated}
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
            connector={connectors?.get(open.connector)}
            onShowConnectors={onShowConnectors}
            onChanged={panel.replace}
            onDeleted={panel.handleDeleted}
          />
        ) : null}
      </Drawer>
    </div>
  );
}

const ALL_INSTANCES: Readonly<Record<string, unknown>> = {};

// -------------------------------------------------------------------------------------------
// 自己接入的门 Self-connected gates (P0b, STATUS leftover 118 remainder ①)
// -------------------------------------------------------------------------------------------

const ALL_SELF_CONNECTIONS: Readonly<Record<string, unknown>> = {};

/** Every gate a workspace connected itself (`create_connection` in 系统与授权), and the platform's
 *  cut-off for one of them: 暂停 refuses every Operation of it from the next call until 恢复. The
 *  connector's mode only gates new connections and its deny list only reaches gates enabled from
 *  the catalog, so before this an administrator had no way to stop one that was already running.
 *  The connector filter is chosen, never typed: its options are the connectors in the list. */
function SelfConnectionsTab({
  http,
  connector,
  onConnectorChange,
  onShowInstance,
}: {
  readonly http: CapabilityCaller;
  readonly connector: string | null;
  readonly onConnectorChange: (connector: string | null) => void;
  /** Opens a platform gate instance's drawer (a self connection at that instance's address). */
  readonly onShowInstance: (gateId: string) => void;
}) {
  const t = useT();
  const connections = useCapabilityList<SelfConnectionWire>(
    http,
    'list_self_connections',
    ALL_SELF_CONNECTIONS,
  );
  const all = connections.state.status === 'ready' ? connections.state.data.items : [];
  const connectorOptions = [
    ...new Set([...all.map((row) => row.connector), ...(connector ? [connector] : [])]),
  ].sort();
  const rows = connector === null ? all : all.filter((row) => row.connector === connector);

  function replace(updated: SelfConnectionWire): void {
    connections.mutate((data) => ({
      ...data,
      items: data.items.map((row) =>
        row.workspaceId === updated.workspaceId && row.gatekeeperId === updated.gatekeeperId
          ? updated
          : row,
      ),
    }));
  }

  return (
    <div className="stack" data-testid="integrations-self-connections">
      {/* UX acceptance of #620 (P2-2): what a suspension does and does not cover is said here,
          once, so the 暂停 confirm keeps to what happens next and still fits its popover. */}
      <p className="text-3 text-small" style={{ margin: 0 }}>
        {t(
          '工作区在「系统与授权」里自己接入的门。接入包的模式只管新的接入；要切断某一个正在用的，在这里暂停它：它的全部 Operation 从下一次调用起被拒绝，智能体的调用、成员的读取和已排队的执行都一样；连接、Operation 和历史都保留，恢复后照常可用。',
          'Gates workspaces connected themselves in Systems & access. A connector’s mode only governs new connections; to cut off one in use, suspend it here: every Operation of it is refused from the next call — agent calls, members’ reads and queued executions alike — while the connection, its Operations and their history stay, and resuming it brings them back.',
        )}
      </p>
      <p className="text-3 text-small" style={{ margin: 0 }}>
        {t(
          '暂停只管这一条连接：暂停期间工作区不能自己解除、删除它或重新接入同一地址，但换个主机名或 IP 接入算新连接；要让工作区不能再自己接入这类门，在「接入包」里改它的模式。目标与门地址这里只显示协议、主机和端口，路径和参数只有工作区自己看得到。',
          'A suspension covers this one connection: while it lasts the workspace cannot lift it, delete it or connect the same address again, but the gate under another host name or IP is a new connection; to stop workspaces connecting this kind of gate themselves, change its mode under Connectors. Targets and gate addresses show their scheme, host and port only; the path and parameters are visible to the workspace alone.',
        )}
      </p>
      <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
        <Select
          aria-label={t('按接入包筛选', 'Filter by connector')}
          value={connector ?? ''}
          onChange={(event) => onConnectorChange(event.target.value || null)}
          data-testid="self-connections-connector-filter"
        >
          <option value="">{t('全部接入包', 'All connectors')}</option>
          {connectorOptions.map((name) => (
            <option key={name} value={name}>
              {transportKindLabel(name, t)}
            </option>
          ))}
        </Select>
        <Button
          variant="ghost"
          size="s"
          icon="refresh"
          onClick={() => void connections.reload()}
          loading={connections.state.status === 'ready' && connections.state.refreshing}
        >
          {t('刷新', 'Refresh')}
        </Button>
      </div>

      {connections.state.status === 'loading' ? (
        <SkeletonRows
          count={2}
          label={t('正在加载工作区自己接入的门…', 'Loading self-connected gates')}
          testId="self-connections-loading"
        />
      ) : connections.state.status === 'error' ? (
        <ErrorBanner
          error={connections.state.error}
          title={t('无法加载工作区自己接入的门', 'Could not load the self-connected gates')}
          onRetry={() => void connections.reload()}
          testId="self-connections-error"
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="link"
          title={
            connector === null
              ? t('还没有工作区自己接入的门', 'No self-connected gates yet')
              : t(
                  `没有经「${transportKindLabel(connector, t)}」自己接入的门`,
                  `No gates self-connected through “${transportKindLabel(connector, t)}”`,
                )
          }
          body={t(
            '工作区所有者在「系统与授权」里用通用接入包（HTTP、MCP、命令行、SSH）接入自己的门后，会出现在这里。',
            'A gate shows up here once a workspace owner connects it in Systems & access through a generic connector (HTTP, MCP, CLI, SSH).',
          )}
          testId="self-connections-empty"
        />
      ) : (
        // UX acceptance of #620 (P2-1): at ≤ 768px each row is one card — the system and its
        // 暂停 / 恢复 in its header, workspace, kind, connection and status under it — instead of a
        // six-column table whose status and action sat off-screen to the right.
        <DataTable
          columns={selfConnectionColumns(http, replace, onShowInstance, t)}
          data={rows}
          getRowId={(row) => `${row.workspaceId}:${row.gatekeeperId}`}
          ariaLabel={t('工作区自己接入的门', 'Self-connected gates')}
          testId="self-connections-table"
          rowTestId={(row) => `self-connection-row-${row.gatekeeperId}`}
        />
      )}
    </div>
  );
}

/** The 自己接入的门 table's columns (`kit/data-table`): the system is the card title and 暂停 /
 *  恢复 sits next to it (`primary` / `high`); workspace, kind, connection and status become label /
 *  value pairs at ≤ 768px. Cells that can run long wrap instead of being cut (`whitespace-normal` —
 *  a card's title and values are single-line by default). */
function selfConnectionColumns(
  http: CapabilityCaller,
  onChanged: (updated: SelfConnectionWire) => void,
  onShowInstance: (gateId: string) => void,
  t: Translate,
): readonly DataTableColumn<SelfConnectionWire>[] {
  return [
    {
      id: 'workspace',
      header: t('工作区', 'Workspace'),
      cell: (connection) => connection.workspaceName,
    },
    {
      id: 'system',
      header: t('系统', 'System'),
      priority: 'primary',
      cell: (connection) => (
        <div className="whitespace-normal">
          <div>{addressText(connection.target, t)}</div>
          <div className="mono text-3 text-small font-normal">
            {addressText(connection.endpoint, t)}
          </div>
          {connection.catalogGateId !== null ? (
            <p
              className="text-3 text-small font-normal"
              style={{ margin: 0 }}
              data-testid={`self-connection-catalog-${connection.gatekeeperId}`}
            >
              {t(
                `地址与平台门实例「${connection.catalogGateId}」相同（在这项检查出现之前接入的）：调用会用平台给这个实例的凭证。工作区从目录启用该实例后，它会改由实例接入；不该这样用时，暂停它。`,
                `Same address as platform gate instance “${connection.catalogGateId}” (connected before that check existed): calls to it use the credential the platform holds for that instance. Once the workspace enables that instance from the catalog it comes from the instance instead; if it should not be used this way, suspend it.`,
              )}{' '}
              <Button
                variant="ghost"
                size="s"
                onClick={() => onShowInstance(connection.catalogGateId ?? '')}
                data-testid={`self-connection-show-instance-${connection.gatekeeperId}`}
              >
                {t('查看实例', 'View instance')}
              </Button>
            </p>
          ) : null}
        </div>
      ),
    },
    {
      id: 'kind',
      header: t('种类', 'Kind'),
      cell: (connection) => transportKindLabel(connection.connector, t),
    },
    {
      id: 'connected',
      header: t('接入', 'Connected'),
      cell: (connection) => (
        <div className="whitespace-normal">
          <div>
            {connection.connectedByName ?? (
              <span className="text-3">
                {t('升级前接入，未记录接入人', 'Before this list; not recorded')}
              </span>
            )}
          </div>
          <time className="text-3 text-small" title={formatDateTime(connection.connectedAt)}>
            {formatRelative(connection.connectedAt)}
          </time>
        </div>
      ),
    },
    {
      id: 'status',
      header: t('状态', 'Status'),
      cell: (connection) => (
        <div className="whitespace-normal">
          <StatusChip machine="selfConnection" status={deriveSelfConnectionStatus(connection)} />
          {connection.suspendedAt !== null ? (
            <div
              className="text-3 text-small"
              data-testid={`self-connection-suspension-${connection.gatekeeperId}`}
            >
              <div>
                {connection.suspendedByLogin ?? t('平台管理员', 'A platform administrator')}
                {' · '}
                <time title={formatDateTime(connection.suspendedAt)}>
                  {formatRelative(connection.suspendedAt)}
                </time>
              </div>
              {connection.suspensionReason !== null ? (
                <div style={{ overflowWrap: 'anywhere' }}>
                  {t('原因：', 'Reason: ')}
                  {connection.suspensionReason}
                </div>
              ) : null}
              <RedactedNote
                value={connection.suspensionReason}
                testId={`self-connection-suspension-redacted-${connection.gatekeeperId}`}
              />
            </div>
          ) : null}
        </div>
      ),
    },
    {
      id: 'actions',
      header: '',
      priority: 'high',
      hideInCard: true,
      cell: (connection) => (
        <SelfConnectionAction http={http} connection={connection} onChanged={onChanged} />
      ),
    },
  ];
}

/** One row's 暂停 / 恢复 and its confirm — a component, not a cell function, because it owns the
 *  row's confirm state (`useSelfConnectionSuspension`). */
function SelfConnectionAction({
  http,
  connection,
  onChanged,
}: {
  readonly http: CapabilityCaller;
  readonly connection: SelfConnectionWire;
  readonly onChanged: (updated: SelfConnectionWire) => void;
}) {
  const t = useT();
  const suspension = useSelfConnectionSuspension(http, connection, onChanged);
  const suspended = connection.suspendedAt !== null;
  const rowId = connection.gatekeeperId;
  const reasonId = `self-connection-reason-${rowId}`;
  // Legacy 412: an old address the kernel masked whole reads as hidden, not as `[redacted]`.
  const targetText = addressText(connection.target, t);

  return (
    <Confirm
      tier="medium"
      open={suspension.confirmOpen}
      onOpenChange={suspension.onConfirmOpenChange}
      anchor={
        <Button
          variant={suspended ? 'secondary' : 'danger'}
          size="s"
          onClick={() => suspension.onConfirmOpenChange(true)}
          data-testid={`self-connection-${suspended ? 'resume' : 'suspend'}-${rowId}`}
        >
          {suspended ? t('恢复', 'Resume') : t('暂停', 'Suspend')}
        </Button>
      }
      title={
        suspended
          ? t(`恢复「${targetText}」`, `Resume “${targetText}”`)
          : t(`暂停「${targetText}」`, `Suspend “${targetText}”`)
      }
      // UX acceptance of #620 (P2-2): only what happens next — what a suspension covers is in the
      // tab's own introduction, so the confirm button stays in view at 1440×900.
      description={
        suspended
          ? t(
              '它已发布的 Operation 从下一次调用起恢复可调用，这个工作区的入口智能体凭证会重新签发。',
              'Its published Operations run again from the next call, and this workspace’s entry-agent Handles are re-issued.',
            )
          : t(
              '从下一次调用起，这个门的全部 Operation 都被拒绝，这个工作区的入口智能体凭证会重新签发。连接、它的 Operation 和历史都保留，随时可以恢复。',
              'From the next call on, every Operation of this gate is refused, and this workspace’s entry-agent Handles are re-issued. The connection, its Operations and their history stay; you can resume it at any time.',
            )
      }
      target={`${connection.workspaceName} · ${targetText}`}
      impact={[addressText(connection.endpoint, t)]}
      confirmLabel={suspended ? t('恢复', 'Resume') : t('暂停', 'Suspend')}
      danger={!suspended}
      onConfirm={suspension.apply}
      testId={`self-connection-confirm-${rowId}`}
    >
      {suspended ? null : (
        <Field
          id={reasonId}
          label={t('原因（可选）', 'Reason (optional)')}
          hint={t(
            '记在这次暂停上，列表和平台审计里都能看到。',
            'Kept with this suspension; shown in this list and in the platform audit.',
          )}
        >
          <Input
            id={reasonId}
            value={suspension.reason}
            maxLength={SUSPENSION_REASON_MAX}
            onChange={(event) => suspension.setReason(event.target.value)}
            aria-describedby={describedBy(reasonId, true, false)}
            data-testid={`self-connection-reason-input-${rowId}`}
          />
        </Field>
      )}
    </Confirm>
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
          <table className="data-table data-table-cards" data-testid="external-runtimes-table">
            <thead>
              <tr>
                <th>{t('工作区', 'Workspace')}</th>
                <th>{t('所属成员', 'Member')}</th>
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
  const revoke = useRevokeRuntime(http, runtime, onRevoked);

  return (
    <tr data-testid={`external-runtime-row-${runtime.sessionId}`}>
      <td>{runtime.workspaceName}</td>
      <td data-label={t('所属成员', 'Member')}>
        {principalShownName(runtime.displayName, t) ?? (
          <span className="mono text-3">{runtime.principalId}</span>
        )}
      </td>
      <td data-label={t('会话种类', 'Session kind')}>{runtime.sessionKind}</td>
      <td data-label={t('创建时间', 'Created')}>
        <time title={formatDateTime(runtime.createdAt)}>{formatRelative(runtime.createdAt)}</time>
      </td>
      <td data-label={t('过期', 'Expires')}>
        {runtime.expiresAt === null ? (
          '—'
        ) : (
          <time title={formatDateTime(runtime.expiresAt)}>{formatRelative(runtime.expiresAt)}</time>
        )}
      </td>
      <td>
        <PlatformError
          error={revoke.error}
          title={t('无法吊销', 'Could not revoke this runtime')}
        />
        {revoke.confirming ? (
          <div className="row-wrap" style={{ justifyContent: 'flex-end' }}>
            <Button variant="ghost" size="s" onClick={() => revoke.setConfirming(false)}>
              {t('取消', 'Cancel')}
            </Button>
            <Button
              variant="danger"
              size="s"
              onClick={() => void revoke.revoke()}
              loading={revoke.revoking}
            >
              {t('确认吊销', 'Confirm revoke')}
            </Button>
          </div>
        ) : (
          <Button
            variant="danger"
            size="s"
            onClick={() => revoke.setConfirming(true)}
            data-testid={`external-runtime-revoke-${runtime.sessionId}`}
          >
            {t('吊销', 'Revoke')}
          </Button>
        )}
      </td>
    </tr>
  );
}
