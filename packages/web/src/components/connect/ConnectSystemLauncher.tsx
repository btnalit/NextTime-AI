import type {
  AvailableGateInstanceWire,
  ConnectorWire,
  EnableGateInstanceResultWire,
  GateHostTokenWire,
  GateInstanceWire,
} from '@nexttime/shared';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { useCapabilityList } from '../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import {
  type GatePath,
  gateInstanceAnnounced,
  gatePathForKind,
  useGateInstancePoll,
} from '../../lib/gate-instances.js';
import type { PrincipalRow } from '../../lib/governance.js';
import { GATE_ID_PATTERN } from '../../lib/platform-errors.js';
import { hrefs } from '../../lib/router.js';
import { deriveGateInstanceStatus } from '../../lib/status-tone.js';
import { OnboardingWizardReview } from '../OnboardingWizardReview.js';
import { CreateGateInstanceForm } from '../platform/CreateGateInstanceForm.js';
import { GateCredentialEntry } from '../platform/GateCredentialEntry.js';
import { PlatformError } from '../platform/PlatformError.js';
import { Button } from '../ui/Button.js';
import { ErrorBanner } from '../ui/ErrorBanner.js';
import { Field, Input, Select } from '../ui/Field.js';
import { Launcher, type LauncherKind, type LauncherStep } from '../ui/Launcher.js';
import { Notice } from '../ui/Notice.js';
import { RefChip } from '../ui/RefChip.js';
import { SkeletonRows } from '../ui/Skeleton.js';
import { StatusChip } from '../ui/StatusChip.js';
import { PackagedGateChecklist } from './PackagedGateChecklist.js';

export interface ConnectSystemLauncherResult {
  readonly gateId: string | null;
  /** The workspace's Gatekeeper object id once 在本工作区启用 ran (or the instance was already
   *  linked here); `null` when the launcher stopped on the platform side. */
  readonly gatekeeperId: string | null;
}

export interface ConnectSystemLauncherProps {
  readonly http: CapabilityCaller;
  /** Which page mounted it: the workspace 系统接入 page or the platform 集成 page. The steps the
   *  other plane owns render as a notice with a link instead of a form (§5.6). */
  readonly origin: 'workspace' | 'platform';
  /** The session may call platform-scope capabilities (`session.user.platformRole === 'admin'`).
   *  Implied by `origin: 'platform'`; from the workspace page it is what lets an administrator
   *  create / enable the instance in place instead of being sent to the 集成 page. */
  readonly platformAdmin?: boolean;
  /** Workspace side: the caller may `enable_gate_instance` (owner). Ignored on the platform page. */
  readonly canEnable?: boolean;
  /** Workspace side: the already-loaded platform catalog (`list_available_gate_instances`), so the
   *  launcher knows whether this workspace has linked the chosen instance (its `gatekeeperId`)
   *  without a second read. */
  readonly available?: readonly AvailableGateInstanceWire[];
  /** Workspace side: `enable_gate_instance` succeeded — the page reloads its registry + catalog. */
  readonly onEnabled?: (result: EnableGateInstanceResultWire) => void;
  /** Platform side: a gate instance was created or changed — the page splices its list. */
  readonly onInstanceChanged?: (instance: GateInstanceWire) => void;
  readonly onCancel: () => void;
  readonly onFinished: (result: ConnectSystemLauncherResult) => void;
  /** How often the gate-instance list is re-read while waiting (default 5 s; tests shorten it). */
  readonly pollIntervalMs?: number;
}

/** One gate as the launcher tracks it, whichever list it came from. */
interface TrackedGate {
  readonly gateId: string;
  readonly displayName: string;
  readonly connector: string;
  readonly transportKind: LauncherKind;
  readonly status: GateInstanceWire['status'];
  readonly health: GateInstanceWire['health'];
  readonly operationCount: number;
  /** Heard from and described Operations (`lib/gate-instances.ts` `gateInstanceAnnounced`). A
   *  workspace-catalog row is enabled, hence announced. */
  readonly announced: boolean;
  /** The full platform row when the reader is an administrator; `null` from the workspace catalog. */
  readonly platform: GateInstanceWire | null;
}

function fromPlatformRow(row: GateInstanceWire): TrackedGate {
  return {
    gateId: row.gateId,
    displayName: row.displayName,
    connector: row.connector,
    transportKind: row.transportKind,
    status: row.status,
    health: row.health,
    operationCount: row.operationCount,
    announced: gateInstanceAnnounced(row),
    platform: row,
  };
}

function fromAvailableRow(row: AvailableGateInstanceWire): TrackedGate {
  return {
    gateId: row.gateId,
    displayName: row.displayName,
    connector: row.connector,
    transportKind: row.transportKind,
    status: row.status,
    health: row.health,
    operationCount: row.operationCount,
    announced: true,
    platform: null,
  };
}

const KIND_PATH_COPY: Readonly<Record<LauncherKind, string>> = {
  http: 'HTTP / OpenAPI 服务由平台门宿主承载（P-B2a）：管理员在此建实例（目标地址、OpenAPI 清单、凭证模式），凭证直接录入门宿主，工作区一键启用。 Served by the platform gate host — an administrator creates the instance here, the credential goes straight to the host, and a workspace enables it with one click.',
  mcp: 'MCP server 同样由平台门宿主承载：清单来自它的 tools/list（readOnlyHint → observe，其余 execute）；管理员可标记 vetted 以允许自动批准幂等、非破坏性的工具。 Also served by the gate host — its tools/list becomes the manifest; an administrator may mark it vetted.',
  ssh: 'SSH 主机是打包门：需要二进制与私钥，走 compose 服务 + 自注册。下一步显示部署清单，门 announce 后自动接上后续步骤。 A packaged gate — the next step shows the deployment checklist and waits for the gate to announce itself.',
  cli: '命令行工具是打包门：需要二进制与目标凭证，走 compose 服务 + 自注册。下一步显示部署清单，门 announce 后自动接上后续步骤。 A packaged gate — the next step shows the deployment checklist and waits for the gate to announce itself.',
};

/**
 * components/connect/ConnectSystemLauncher: S6-C (docs/console-completion-plan.md §5.6 "一个
 * '接入一个系统'入口", A7 / B7; §5.9 "Launcher") — the one launcher both the workspace 系统接入
 * page and the platform 集成 page open from their `PageHeader.primaryAction`, built on
 * `ui/Launcher`'s four steps. The two paths of design §6.3 branch on the kind chosen in step 1:
 *
 *   1 选类型          http / mcp / ssh / cli + which path that means.
 *   2 连接与凭证      hosted (http / mcp): `CreateGateInstanceForm` (platform) → shared credential
 *                     straight to the gate host (`GateCredentialEntry`) → wait for the host's
 *                     takeover. packaged (ssh / cli): `PackagedGateChecklist`, then poll until the
 *                     announced instance appears. Either way the reader may instead pick an
 *                     instance that already exists.
 *   3 能力与策略      platform: 启用 (only in `discovered`, B7) + connector → 平台预置 + the announced
 *                     Operations; workspace: 在本工作区启用 (`enable_gate_instance` imports *and*
 *                     publishes) → review classification (`OnboardingWizardReview`, composed, not
 *                     copied) → grant a member (`connect_gatekeeper`).
 *   4 握手验证        `test_gate_instance` (platform) and the resulting status / health / Gatekeeper.
 *
 * Whichever plane the mounting page is not on renders as a notice with a link (a non-admin on the
 * workspace page sees "需要管理员在平台集成页创建实例"; the platform page sends the workspace steps
 * to 系统接入). An administrator on the workspace page (`platformAdmin`) does both in place. The
 * standalone forms it composes keep their own behaviour and tests; nothing here duplicates their
 * fields or calls. Credentials still go browser → caddy → gate host (P-B2a) — this launcher
 * never sees one.
 */
export function ConnectSystemLauncher({
  http,
  origin,
  platformAdmin = false,
  canEnable = false,
  available = [],
  onEnabled,
  onInstanceChanged,
  onCancel,
  onFinished,
  pollIntervalMs,
}: ConnectSystemLauncherProps) {
  const isAdmin = origin === 'platform' || platformAdmin;
  const onWorkspace = origin === 'workspace';
  const [step, setStep] = useState<LauncherStep>(0);
  const [kind, setKind] = useState<LauncherKind | null>(null);
  const [selectedGateId, setSelectedGateId] = useState<string | null>(null);
  /** The row `create_gate_instance` (or a platform write) last answered with — authoritative until
   *  the next poll replaces it. */
  const [ownInstance, setOwnInstance] = useState<GateInstanceWire | null>(null);
  const [intendedGateId, setIntendedGateId] = useState('');
  const [enabled, setEnabled] = useState<EnableGateInstanceResultWire | null>(null);

  const path: GatePath | null = kind === null ? null : gatePathForKind(kind);

  // One poll for the whole launcher: the platform list when the reader may read it (every status,
  // so a freshly announced packaged gate or a just-created hosted instance shows up), else the
  // workspace catalog (what this workspace may enable — an administrator has to enable + preset
  // the connector before a non-admin sees anything there). Active from step 2 on.
  const poll = useGateInstancePoll<GateInstanceWire | AvailableGateInstanceWire>(
    http,
    isAdmin ? 'list_gate_instances' : 'list_available_gate_instances',
    {},
    { active: step >= 1 && kind !== null, intervalMs: pollIntervalMs },
  );
  // Entering a step re-reads at once (the gate host may have taken over, an administrator may
  // have enabled) rather than waiting out the interval.
  const refreshPoll = poll.refresh;
  useEffect(() => {
    if (step >= 1) void refreshPoll();
  }, [step, refreshPoll]);
  const tracked: readonly TrackedGate[] = useMemo(() => {
    const rows = poll.state.status === 'ready' ? poll.state.data : [];
    // The newer of the two wins per gate: a platform write's answer (`ownInstance`) over a poll
    // row read before it, the poll over a stale answer (`updatedAt` is bumped on every write and
    // announce — ISO strings compare lexicographically).
    const mapped = rows.map((row) => {
      if (
        ownInstance &&
        'hosted' in row &&
        row.gateId === ownInstance.gateId &&
        ownInstance.updatedAt > row.updatedAt
      ) {
        return fromPlatformRow(ownInstance);
      }
      return 'hosted' in row ? fromPlatformRow(row) : fromAvailableRow(row);
    });
    if (ownInstance && !mapped.some((row) => row.gateId === ownInstance.gateId)) {
      mapped.unshift(fromPlatformRow(ownInstance));
    }
    return mapped;
  }, [poll.state, ownInstance]);
  const matching = useMemo(
    () => tracked.filter((row) => kind !== null && row.transportKind === kind),
    [tracked, kind],
  );
  const selected = tracked.find((row) => row.gateId === selectedGateId) ?? null;
  // The poll overtakes `create_gate_instance`'s answer once the host has taken the instance over.
  useEffect(() => {
    if (!ownInstance || poll.state.status !== 'ready') return;
    const fresh = poll.state.data.find((row) => row.gateId === ownInstance.gateId);
    if (fresh && 'hosted' in fresh && fresh.updatedAt > ownInstance.updatedAt) {
      setOwnInstance(fresh);
    }
  }, [poll.state, ownInstance]);
  // A typed GATE_ID auto-selects the packaged gate the moment it announces itself.
  useEffect(() => {
    if (selectedGateId !== null || path !== 'packaged') return;
    const wanted = intendedGateId.trim();
    if (wanted.length === 0) return;
    if (matching.some((row) => row.gateId === wanted)) setSelectedGateId(wanted);
  }, [matching, intendedGateId, selectedGateId, path]);

  const linkedGatekeeperId =
    enabled?.gatekeeperId ??
    available.find((row) => row.gateId === selectedGateId)?.gatekeeperId ??
    null;

  function chooseKind(next: LauncherKind): void {
    setKind(next);
    setSelectedGateId(null);
    setOwnInstance(null);
    setEnabled(null);
  }

  function handleCreated(instance: GateInstanceWire): void {
    setOwnInstance(instance);
    setSelectedGateId(instance.gateId);
    onInstanceChanged?.(instance);
  }

  function handleInstanceChanged(instance: GateInstanceWire): void {
    setOwnInstance(instance);
    onInstanceChanged?.(instance);
    void poll.refresh();
  }

  function handleEnabled(result: EnableGateInstanceResultWire): void {
    setEnabled(result);
    onEnabled?.(result);
  }

  const canNext = step === 0 ? kind !== null : step === 1 ? selected !== null : true;

  return (
    <Launcher
      step={step}
      kind={kind}
      onKindChange={chooseKind}
      onNext={() => {
        if (step === 3) onFinished({ gateId: selectedGateId, gatekeeperId: linkedGatekeeperId });
        else setStep((step + 1) as LauncherStep);
      }}
      onBack={() => setStep((step - 1) as LauncherStep)}
      canNext={canNext}
      testId="connect-system-launcher"
    >
      {step === 0 && kind !== null ? (
        <Notice testId="launcher-path-copy">{KIND_PATH_COPY[kind]}</Notice>
      ) : null}

      {step === 1 && kind !== null && path !== null ? (
        <ConnectionStep
          http={http}
          kind={kind}
          path={path}
          isAdmin={isAdmin}
          onWorkspace={onWorkspace}
          matching={matching}
          pollState={poll.state.status}
          selected={selected}
          onSelect={setSelectedGateId}
          ownInstance={ownInstance}
          onCreated={handleCreated}
          intendedGateId={intendedGateId}
          onIntendedGateId={setIntendedGateId}
          onBack={() => setStep(0)}
        />
      ) : null}

      {step === 2 && selected ? (
        <PolicyStep
          http={http}
          gate={selected}
          isAdmin={isAdmin}
          onWorkspace={onWorkspace}
          canEnable={canEnable}
          linkedGatekeeperId={linkedGatekeeperId}
          enabled={enabled}
          onInstanceChanged={handleInstanceChanged}
          onEnabled={handleEnabled}
        />
      ) : null}

      {step === 3 && selected ? (
        <HandshakeStep
          http={http}
          gate={selected}
          isAdmin={isAdmin}
          onWorkspace={onWorkspace}
          linkedGatekeeperId={linkedGatekeeperId}
          enabled={enabled}
        />
      ) : null}

      {step === 0 ? (
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onCancel}>
            取消 Cancel
          </Button>
        </div>
      ) : null}
    </Launcher>
  );
}

// -------------------------------------------------------------------------------------------
// Step 2 连接与凭证
// -------------------------------------------------------------------------------------------

function ConnectionStep({
  http,
  kind,
  path,
  isAdmin,
  onWorkspace,
  matching,
  pollState,
  selected,
  onSelect,
  ownInstance,
  onCreated,
  intendedGateId,
  onIntendedGateId,
  onBack,
}: {
  readonly http: CapabilityCaller;
  readonly kind: LauncherKind;
  readonly path: GatePath;
  readonly isAdmin: boolean;
  readonly onWorkspace: boolean;
  readonly matching: readonly TrackedGate[];
  readonly pollState: 'loading' | 'error' | 'ready';
  readonly selected: TrackedGate | null;
  readonly onSelect: (gateId: string | null) => void;
  readonly ownInstance: GateInstanceWire | null;
  readonly onCreated: (instance: GateInstanceWire) => void;
  readonly intendedGateId: string;
  readonly onIntendedGateId: (value: string) => void;
  readonly onBack: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const showCreateForm = path === 'hosted' && isAdmin && (creating || (!selected && !ownInstance));

  return (
    <div className="stack" data-testid="launcher-step-connection-body">
      {path === 'packaged' ? (
        <>
          <PackagedGateChecklist
            kind={kind as 'ssh' | 'cli'}
            gateId={intendedGateId}
            testId="launcher-packaged-checklist"
          />
          <Field
            id="launcher-intended-gate-id"
            label="它的 GATE_ID Its GATE_ID"
            hint="可选：填了以后清单里的占位符会替换成它，announce 后自动选中。 Optional — fills the placeholders above and auto-selects the gate once it announces."
            error={
              intendedGateId.length > 0 && !GATE_ID_PATTERN.test(intendedGateId.trim())
                ? '格式不合法 Invalid gate id'
                : undefined
            }
          >
            <Input
              id="launcher-intended-gate-id"
              value={intendedGateId}
              onChange={(event) => onIntendedGateId(event.target.value)}
              mono
              placeholder="gatekeeper-<system>"
            />
          </Field>
        </>
      ) : !isAdmin ? (
        <Notice testId="launcher-needs-admin">
          需要管理员在平台<a href={hrefs.platformIntegrations()}>集成</a>
          页创建门宿主实例并启用它；之后它会出现在下面的目录里。 An administrator creates the
          gate-host instance on the platform <a href={hrefs.platformIntegrations()}>Integrations</a>{' '}
          page and enables it; it then shows up in the catalog below.
        </Notice>
      ) : showCreateForm ? (
        <div className="stack-s" data-testid="launcher-create-instance">
          <span className="section-title">新建门宿主实例 Create a hosted instance ({kind})</span>
          <CreateGateInstanceForm
            http={http}
            onCreated={(instance) => {
              setCreating(false);
              onCreated(instance);
            }}
            onCancel={creating ? () => setCreating(false) : onBack}
          />
        </div>
      ) : null}

      {path === 'hosted' && isAdmin && !showCreateForm ? (
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button variant="ghost" size="s" icon="plus" onClick={() => setCreating(true)}>
            再建一个 Create another
          </Button>
        </div>
      ) : null}

      <ExistingGatePicker
        kind={kind}
        path={path}
        isAdmin={isAdmin}
        onWorkspace={onWorkspace}
        matching={matching}
        pollState={pollState}
        selectedGateId={selected?.gateId ?? null}
        onSelect={onSelect}
      />

      {selected ? <SelectedGateSummary http={http} gate={selected} isAdmin={isAdmin} /> : null}
    </div>
  );
}

/** The live list of instances of the chosen kind — the "wait for announce" view for a packaged
 *  gate, the "or pick an existing one" view for a hosted kind. Polled by the launcher. */
function ExistingGatePicker({
  kind,
  path,
  isAdmin,
  onWorkspace,
  matching,
  pollState,
  selectedGateId,
  onSelect,
}: {
  readonly kind: LauncherKind;
  readonly path: GatePath;
  readonly isAdmin: boolean;
  readonly onWorkspace: boolean;
  readonly matching: readonly TrackedGate[];
  readonly pollState: 'loading' | 'error' | 'ready';
  readonly selectedGateId: string | null;
  readonly onSelect: (gateId: string | null) => void;
}) {
  const title =
    path === 'packaged'
      ? '等待门出现 Waiting for the gate to announce'
      : '或选择已有实例 Or pick an existing instance';
  return (
    <div className="stack-s" data-testid="launcher-existing-gates">
      <span className="section-title">{title}</span>
      {pollState === 'loading' ? (
        <SkeletonRows count={1} label="Loading gate instances" testId="launcher-gates-loading" />
      ) : pollState === 'error' ? (
        <Notice tone="warn" testId="launcher-gates-error">
          读不到门实例列表（{isAdmin ? 'list_gate_instances' : 'list_available_gate_instances'}
          ）；仍在重试。 Could not read the gate-instance list; still retrying.
        </Notice>
      ) : matching.length === 0 ? (
        <p className="text-3" data-testid="launcher-gates-empty">
          {path === 'packaged'
            ? `还没有 ${kind} 类型的门 announce${isAdmin ? '' : '（并由管理员启用、设为平台预置）'}；每 5 秒重查一次。 No ${kind} gate has announced itself${isAdmin ? '' : ' (and been enabled + preset by an administrator)'} yet — checking every 5 s.`
            : `目录里还没有 ${kind} 类型的实例。 No ${kind} instance in the catalog yet.`}
        </p>
      ) : (
        <div className="radio-group" role="radiogroup" aria-label="Gate instance">
          {matching.map((row) => (
            <label className="radio-option" key={row.gateId}>
              <input
                type="radio"
                name="launcher-gate"
                value={row.gateId}
                checked={selectedGateId === row.gateId}
                onChange={() => onSelect(row.gateId)}
                data-testid={`launcher-gate-${row.gateId}`}
              />
              <span className="row-wrap">
                <span>{row.displayName}</span>
                <span className="mono text-3">{row.gateId}</span>
                <span className="tag">{row.connector}</span>
                <StatusChip machine="gateInstance" status={row.status} size="s" />
                <StatusChip machine="gateHealth" status={row.health} size="s" />
              </span>
            </label>
          ))}
        </div>
      )}
      {onWorkspace && !isAdmin && path === 'packaged' ? (
        <p className="text-3">
          非管理员只能看到已启用且接入包为平台预置的实例。 A non-administrator only sees instances
          an administrator has enabled and whose connector is platform-preset.
        </p>
      ) : null}
    </div>
  );
}

/** The chosen instance: identity, status, health, and — for an administrator on a hosted
 *  `shared` instance — the credential entry straight to the gate host. */
function SelectedGateSummary({
  http,
  gate,
  isAdmin,
}: {
  readonly http: CapabilityCaller;
  readonly gate: TrackedGate;
  readonly isAdmin: boolean;
}) {
  const platform = gate.platform;
  return (
    <div className="stack-s" data-testid="launcher-selected-gate">
      <dl className="definition-list">
        <dt>Gate id</dt>
        <dd className="mono">{gate.gateId}</dd>
        <dt>名称 Name</dt>
        <dd>{gate.displayName}</dd>
        <dt>接入包 Connector</dt>
        <dd className="mono">{gate.connector}</dd>
        <dt>状态 Status</dt>
        <dd>
          <StatusChip
            machine="gateInstance"
            status={platform ? deriveGateInstanceStatus(platform) : gate.status}
            size="s"
            testId="launcher-gate-status"
          />
        </dd>
        <dt>健康 Health</dt>
        <dd>
          <StatusChip machine="gateHealth" status={gate.health} size="s" />
        </dd>
        <dt>Operation 数</dt>
        <dd className="mono">{gate.operationCount}</dd>
      </dl>
      {!gate.announced ? (
        <Notice tone="warn" testId="launcher-awaiting-announce">
          {platform?.hosted
            ? '等待门宿主接管：宿主下一次拉取时导入 Operation 并 announce（默认 60 秒内）。 Waiting for the gate host to take it over — it imports the Operations and announces on its next pull.'
            : '还没有心跳或 Operation。 No heartbeat or Operations yet.'}
        </Notice>
      ) : null}
      {isAdmin && platform?.hosted && platform.definition?.credentialMode === 'shared' ? (
        <div className="stack-s" data-testid="launcher-shared-credential">
          <span className="field-label">录入共享凭证 Enter the shared credential</span>
          <p className="text-3">
            凭证由浏览器直接送到门宿主（经 caddy），内核不经手。 Sent from this browser straight to
            the gate host — the kernel never sees it.
          </p>
          <GateCredentialEntry
            requestToken={() =>
              http.call<GateHostTokenWire>('issue_gate_host_token', { gateId: gate.gateId })
            }
            tokenButtonLabel="获取 5 分钟令牌 Get a 5-minute token"
          />
        </div>
      ) : null}
      {isAdmin &&
      platform?.hosted &&
      platform.definition?.credentialMode === 'connected_account' ? (
        <Notice>
          按人凭证：每个成员在工作区「系统接入」页的目录行里录入自己的一份。 Per-member credential —
          each member enters their own from the workspace 系统接入 catalog row.
        </Notice>
      ) : null}
    </div>
  );
}

// -------------------------------------------------------------------------------------------
// Step 3 能力与策略
// -------------------------------------------------------------------------------------------

function PolicyStep({
  http,
  gate,
  isAdmin,
  onWorkspace,
  canEnable,
  linkedGatekeeperId,
  enabled,
  onInstanceChanged,
  onEnabled,
}: {
  readonly http: CapabilityCaller;
  readonly gate: TrackedGate;
  readonly isAdmin: boolean;
  readonly onWorkspace: boolean;
  readonly canEnable: boolean;
  readonly linkedGatekeeperId: string | null;
  readonly enabled: EnableGateInstanceResultWire | null;
  readonly onInstanceChanged: (instance: GateInstanceWire) => void;
  readonly onEnabled: (result: EnableGateInstanceResultWire) => void;
}) {
  return (
    <div className="stack" data-testid="launcher-step-policy-body">
      {isAdmin ? (
        <PlatformEnableSection http={http} gate={gate} onInstanceChanged={onInstanceChanged} />
      ) : (
        <Notice testId="launcher-policy-needs-admin">
          平台侧的启用与接入包模式由管理员在<a href={hrefs.platformIntegrations()}>集成</a>
          页设置。 The platform-side enable and connector mode are an administrator's, on{' '}
          <a href={hrefs.platformIntegrations()}>Integrations</a>.
        </Notice>
      )}

      {gate.platform && gate.platform.operations.length > 0 ? (
        <div className="stack-s" data-testid="launcher-announced-operations">
          <span className="section-title">
            已 announce 的 Operation Announced operations ({gate.platform.operations.length})
          </span>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>名称 Name</th>
                  <th>模式 Mode</th>
                  <th>影响 Blast radius</th>
                </tr>
              </thead>
              <tbody>
                {gate.platform.operations.map((operation) => (
                  <tr key={operation.name}>
                    <td className="mono">{operation.name}</td>
                    <td>
                      <StatusChip machine="operationMode" status={operation.mode} size="s" />
                    </td>
                    <td>
                      <StatusChip machine="blastRadius" status={operation.blastRadius} size="s" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <div className="divider" />

      {onWorkspace ? (
        <WorkspaceEnableSection
          http={http}
          gate={gate}
          canEnable={canEnable}
          linkedGatekeeperId={linkedGatekeeperId}
          enabled={enabled}
          onEnabled={onEnabled}
        />
      ) : (
        <Notice testId="launcher-policy-workspace-link">
          工作区侧的启用、Operation 分类审核与成员授权在工作区的
          <a href={hrefs.systems()}>系统接入</a>页完成（owner）。 A workspace owner enables it,
          reviews the classification and grants members on{' '}
          <a href={hrefs.systems()}>系统接入 Systems</a>.
        </Notice>
      )}
    </div>
  );
}

/** Platform half of step 3: the administrator's 启用 (B7: while `discovered` or `lost`; `disabled` →
 *  re-enable; `enabled` → nothing to press) and the connector's 平台预置 mode — the two kernel
 *  preconditions of `enable_gate_instance` (`requireAvailable`: `gate_not_enabled` /
 *  `connector_not_preset`). */
function PlatformEnableSection({
  http,
  gate,
  onInstanceChanged,
}: {
  readonly http: CapabilityCaller;
  readonly gate: TrackedGate;
  readonly onInstanceChanged: (instance: GateInstanceWire) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown | null>(null);
  const connectors = useCapabilityList<ConnectorWire>(http, 'list_connectors', {});
  const connector =
    connectors.state.status === 'ready'
      ? connectors.state.data.items.find((row) => row.name === gate.connector)
      : undefined;
  const [presetting, setPresetting] = useState(false);
  const [presetError, setPresetError] = useState<unknown | null>(null);
  const platform = gate.platform;
  const displayStatus = platform ? deriveGateInstanceStatus(platform) : gate.status;

  async function setStatus(status: 'enabled' | 'disabled'): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onInstanceChanged(
        await http.call<GateInstanceWire>('update_gate_instance', { gateId: gate.gateId, status }),
      );
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function preset(): Promise<void> {
    if (presetting) return;
    setPresetting(true);
    setPresetError(null);
    try {
      const updated = await http.call<ConnectorWire>('set_connector_mode', {
        name: gate.connector,
        mode: 'platform_preset',
      });
      connectors.mutate((data) => ({
        ...data,
        items: data.items.map((row) => (row.name === updated.name ? updated : row)),
      }));
    } catch (err) {
      setPresetError(err);
    } finally {
      setPresetting(false);
    }
  }

  return (
    <div className="stack-s" data-testid="launcher-platform-enable">
      <span className="section-title">平台侧 Platform side</span>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="row-wrap">
          <StatusChip
            machine="gateInstance"
            status={displayStatus}
            size="s"
            testId="launcher-platform-status"
          />
          <StatusChip machine="gateHealth" status={gate.health} size="s" />
        </span>
        {gate.status === 'discovered' || gate.status === 'lost' ? (
          <Button
            variant="secondary"
            onClick={() => void setStatus('enabled')}
            loading={busy}
            disabled={!gate.announced}
            title={!gate.announced ? '等待它 announce 后再启用 Wait for its announce' : undefined}
            data-testid="launcher-platform-enable-button"
          >
            启用 Enable
          </Button>
        ) : gate.status === 'disabled' ? (
          <Button
            variant="secondary"
            onClick={() => void setStatus('enabled')}
            loading={busy}
            data-testid="launcher-platform-enable-button"
          >
            重新启用 Re-enable
          </Button>
        ) : null}
      </div>
      <PlatformError error={error} title="无法启用 Could not enable this instance" />

      {connectors.state.status === 'error' ? (
        <ErrorBanner
          error={connectors.state.error}
          title="读不到接入包目录 Could not load the connector catalog"
          onRetry={() => void connectors.reload()}
        />
      ) : connector && connector.mode !== 'platform_preset' ? (
        <div className="stack-s" data-testid="launcher-connector-preset">
          <Notice tone="warn">
            接入包 <code>{connector.name}</code> 当前是{' '}
            <StatusChip machine="connectorMode" status={connector.mode} size="s" />
            ；工作区只能从目录启用<strong>平台预置</strong>的接入包。 Connector{' '}
            <code>{connector.name}</code> is not platform-preset — a workspace can only enable
            platform-preset instances from the catalog.
          </Notice>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button
              variant="secondary"
              onClick={() => void preset()}
              loading={presetting}
              data-testid="launcher-connector-preset-button"
            >
              设为平台预置 Set platform preset
            </Button>
          </div>
          <PlatformError
            error={presetError}
            title="无法设置模式 Could not set the mode"
            testId="launcher-connector-preset-error"
          />
        </div>
      ) : connector ? (
        <p className="text-3" data-testid="launcher-connector-ok">
          接入包 <code>{connector.name}</code>：
          <StatusChip machine="connectorMode" status={connector.mode} size="s" />
        </p>
      ) : null}
    </div>
  );
}

/** Workspace half of step 3: 在本工作区启用 (`enable_gate_instance` — imports and publishes the
 *  announced Operations, links the workspace), then the composed review + grant. */
function WorkspaceEnableSection({
  http,
  gate,
  canEnable,
  linkedGatekeeperId,
  enabled,
  onEnabled,
}: {
  readonly http: CapabilityCaller;
  readonly gate: TrackedGate;
  readonly canEnable: boolean;
  readonly linkedGatekeeperId: string | null;
  readonly enabled: EnableGateInstanceResultWire | null;
  readonly onEnabled: (result: EnableGateInstanceResultWire) => void;
}) {
  const [enabling, setEnabling] = useState(false);
  const [error, setError] = useState<unknown | null>(null);

  async function enable(): Promise<void> {
    if (enabling) return;
    setEnabling(true);
    setError(null);
    try {
      onEnabled(
        await http.call<EnableGateInstanceResultWire>('enable_gate_instance', {
          gateId: gate.gateId,
        }),
      );
    } catch (err) {
      setError(err);
    } finally {
      setEnabling(false);
    }
  }

  return (
    <div className="stack" data-testid="launcher-workspace-enable">
      <span className="section-title">工作区侧 Workspace side</span>
      {linkedGatekeeperId === null ? (
        canEnable ? (
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="text-2">
              在本工作区启用：注册 Gatekeeper、导入并发布它 announce 的 Operation。 Enable here —
              registers the Gatekeeper and imports + publishes its announced Operations.
            </span>
            <Button
              variant="primary"
              onClick={() => void enable()}
              loading={enabling}
              data-testid="launcher-workspace-enable-button"
            >
              在本工作区启用 Enable here
            </Button>
          </div>
        ) : (
          <Notice testId="launcher-workspace-enable-owner-only">
            在本工作区启用是 owner 专属操作。 Enabling it in this workspace is owner-only.
          </Notice>
        )
      ) : (
        <div className="row-wrap" data-testid="launcher-workspace-linked">
          <span>已在本工作区启用 Enabled in this workspace:</span>
          <RefChip
            kind="gatekeeper"
            id={linkedGatekeeperId}
            name={gate.displayName}
            href={hrefs.gatekeeper(linkedGatekeeperId)}
            size="s"
            testId="launcher-gatekeeper-chip"
          />
          {enabled ? (
            <span className="text-3">
              已发布 {enabled.publishedOperationNames.length} 个 Operation Published{' '}
              {enabled.publishedOperationNames.length}
            </span>
          ) : null}
        </div>
      )}
      <PlatformError
        error={error}
        title="无法启用 Could not enable this instance"
        testId="launcher-workspace-enable-error"
      />

      {linkedGatekeeperId !== null ? (
        <>
          <div className="stack-s">
            <span className="section-title">审核 Operation 分类 Review classification</span>
            <OnboardingWizardReview
              http={http}
              gatekeeperId={linkedGatekeeperId}
              onDone={() => undefined}
              showDone={false}
            />
          </div>
          <GrantMemberForm http={http} gatekeeperId={linkedGatekeeperId} />
        </>
      ) : null}
    </div>
  );
}

/** `connect_gatekeeper` for one member — a principal picker over `list_principals` (B3: never a
 *  bare id when the directory is readable), falling back to a typed id when it is not. */
function GrantMemberForm({
  http,
  gatekeeperId,
}: {
  readonly http: CapabilityCaller;
  readonly gatekeeperId: string;
}) {
  const principals = useCapabilityList<PrincipalRow>(http, 'list_principals', {});
  const [principalId, setPrincipalId] = useState('');
  const [granting, setGranting] = useState(false);
  const [error, setError] = useState<unknown | null>(null);
  const [granted, setGranted] = useState<readonly string[]>([]);
  const options =
    principals.state.status === 'ready'
      ? principals.state.data.items.filter((row) => row.kind === 'human' && !row.disabledAt)
      : [];

  async function grant(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = principalId.trim();
    if (!trimmed || granting) return;
    setGranting(true);
    setError(null);
    try {
      await http.call('connect_gatekeeper', { gatekeeperId, principalId: trimmed });
      setGranted((prev) => [...prev, trimmed]);
      setPrincipalId('');
    } catch (err) {
      setError(err);
    } finally {
      setGranting(false);
    }
  }

  return (
    <form className="stack-s" onSubmit={(event) => void grant(event)} data-testid="launcher-grant">
      <span className="section-title">授予成员 Grant to a member</span>
      <Field
        id="launcher-grant-principal"
        label="成员 Member"
        hint="该成员的入口 agent 从此可以调用这个门（execute 类要下一次签发入口 Handle 后生效）。 Their entry agent may then use this gate."
      >
        {principals.state.status === 'ready' ? (
          <Select
            id="launcher-grant-principal"
            value={principalId}
            onChange={(event) => setPrincipalId(event.target.value)}
            disabled={granting}
          >
            <option value="">— 选择 Choose —</option>
            {options.map((row) => (
              <option key={row.id} value={row.id}>
                {row.displayName} ({row.role})
              </option>
            ))}
          </Select>
        ) : (
          <Input
            id="launcher-grant-principal"
            value={principalId}
            onChange={(event) => setPrincipalId(event.target.value)}
            disabled={granting}
            mono
            placeholder="principal id"
          />
        )}
      </Field>
      {granted.length > 0 ? (
        <p className="text-3" data-testid="launcher-granted">
          已授予 Granted:{' '}
          {granted.map((id) => (
            <RefChip
              key={id}
              kind="principal"
              id={id}
              name={options.find((row) => row.id === id)?.displayName}
              size="s"
            />
          ))}
        </p>
      ) : null}
      {error !== null ? <ErrorBanner error={error} title="无法授予 Could not grant" /> : null}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button
          type="submit"
          variant="secondary"
          loading={granting}
          disabled={!principalId.trim()}
          data-testid="launcher-grant-submit"
        >
          授予 Grant
        </Button>
      </div>
    </form>
  );
}

// -------------------------------------------------------------------------------------------
// Step 4 握手验证
// -------------------------------------------------------------------------------------------

interface GateInstanceTestResult {
  readonly gateId: string;
  readonly health: GateInstanceWire['health'];
  readonly describedOperationCount: number | null;
  readonly checkedAt: string;
}

function HandshakeStep({
  http,
  gate,
  isAdmin,
  onWorkspace,
  linkedGatekeeperId,
  enabled,
}: {
  readonly http: CapabilityCaller;
  readonly gate: TrackedGate;
  readonly isAdmin: boolean;
  readonly onWorkspace: boolean;
  readonly linkedGatekeeperId: string | null;
  readonly enabled: EnableGateInstanceResultWire | null;
}) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<GateInstanceTestResult | null>(null);
  const [error, setError] = useState<unknown | null>(null);
  const platform = gate.platform;

  async function test(): Promise<void> {
    if (testing) return;
    setTesting(true);
    setError(null);
    try {
      setResult(
        await http.call<GateInstanceTestResult>('test_gate_instance', { gateId: gate.gateId }),
      );
    } catch (err) {
      setError(err);
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="stack" data-testid="launcher-step-handshake-body">
      <dl className="definition-list">
        <dt>门实例 Gate instance</dt>
        <dd>
          {gate.displayName} <span className="mono text-3">{gate.gateId}</span>
        </dd>
        <dt>状态 Status</dt>
        <dd>
          <StatusChip
            machine="gateInstance"
            status={platform ? deriveGateInstanceStatus(platform) : gate.status}
            size="s"
            testId="launcher-handshake-status"
          />
        </dd>
        <dt>健康 Health</dt>
        <dd>
          <StatusChip
            machine="gateHealth"
            status={result?.health ?? gate.health}
            size="s"
            testId="launcher-handshake-health"
          />
        </dd>
        <dt>本工作区 This workspace</dt>
        <dd>
          {linkedGatekeeperId ? (
            <RefChip
              kind="gatekeeper"
              id={linkedGatekeeperId}
              name={gate.displayName}
              href={hrefs.gatekeeper(linkedGatekeeperId)}
              size="s"
              testId="launcher-handshake-gatekeeper"
            />
          ) : onWorkspace ? (
            '未启用 Not enabled here'
          ) : (
            <a href={hrefs.systems()}>到工作区系统接入页启用 Enable on 系统接入</a>
          )}
        </dd>
        {enabled ? (
          <>
            <dt>已发布 Published</dt>
            <dd className="mono">{enabled.publishedOperationNames.length}</dd>
          </>
        ) : null}
      </dl>

      {isAdmin ? (
        <>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button
              variant="secondary"
              icon="refresh"
              onClick={() => void test()}
              loading={testing}
              data-testid="launcher-test-connection"
            >
              测试连接 Test connection
            </Button>
          </div>
          <PlatformError error={error} title="无法测试连接 Could not test this connection" />
          {result ? (
            <dl className="definition-list" data-testid="launcher-test-result">
              <dt>描述的 Operation 数</dt>
              <dd className="mono">{result.describedOperationCount ?? '—'}</dd>
              <dt>检查时间 Checked</dt>
              <dd>
                <time title={formatDateTime(result.checkedAt)}>
                  {formatRelative(result.checkedAt)}
                </time>
              </dd>
            </dl>
          ) : null}
        </>
      ) : (
        <Notice>
          「测试连接」是平台侧操作；工作区里可在门详情（Health & operations）看到实时健康。 Test
          connection is a platform action; the workspace gate detail shows live health.
        </Notice>
      )}

      {gate.status === 'enabled' && gate.health === 'ok' && gate.announced ? (
        <Notice testId="launcher-handshake-ok">
          该门实例可用：已 announce、已启用、健康 ok。 This gate instance is usable — announced,
          enabled and healthy.
        </Notice>
      ) : null}
    </div>
  );
}
