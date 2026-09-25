import type {
  AvailableGateInstanceWire,
  GateHostTokenWire,
  GateInstanceWire,
  GateTrustWire,
} from '@nexttime/shared';
import { useState } from 'react';
import { useCapabilityList } from '../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import { useT } from '../../lib/i18n.js';
import { transportKindLabel } from '../../lib/labels.js';
import { hrefs } from '../../lib/router.js';
import { deriveGateInstanceStatus } from '../../lib/status-tone.js';
import { DrawerSection, DrawerSections } from '../kit/drawer-section.js';
import { Button } from '../ui/Button.js';
import { CopyId } from '../ui/CopyId.js';
import { Field, Input } from '../ui/Field.js';
import { Notice } from '../ui/Notice.js';
import { RefChip } from '../ui/RefChip.js';
import { StatusChip } from '../ui/StatusChip.js';
import { GateCredentialEntry } from './GateCredentialEntry.js';
import { PlatformError } from './PlatformError.js';

/** `GateInstanceTestResultWireSchema`'s shape (`packages/shared/src/wire/platform.ts`) — no
 *  `export type` alongside that schema, so it is redefined locally the way `lib/governance.ts`
 *  redefines every S3.11 shape it codes against. `health` is `GateInstanceWire['health']` rather
 *  than a re-import of the (also unexported) `GateHealthWireSchema`'s inferred type. */
interface GateInstanceTestResult {
  readonly gateId: string;
  readonly health: GateInstanceWire['health'];
  readonly describedOperationCount: number | null;
  readonly checkedAt: string;
}

export interface GateInstanceDetailPanelProps {
  readonly http: CapabilityCaller;
  readonly instance: GateInstanceWire;
  /** A capability answered with a fresh `GateInstanceWire` for this row. */
  readonly onChanged: (instance: GateInstanceWire) => void;
  /** `delete_gate_instance` succeeded — the caller drops the row and closes this drawer. */
  readonly onDeleted: (gateId: string) => void;
}

/**
 * components/platform/GateInstanceDetailPanel: one gate instance's drawer body (P-B1, design
 * §6.3 "门实例") — `update_gate_instance` (rename / enable-disable / MCP trust) and
 * `test_gate_instance` (probes health + re-describes Operations without changing anything else).
 *
 * Trust (`vetted`) only applies to `transportKind === 'mcp'` — the kernel refuses anything else
 * with `trust_not_applicable` — so the control (and its explanation) render only for an MCP
 * instance rather than offering a toggle that can only fail. Enabling/disabling is comparatively
 * low-stakes here (design §6.3: a disabled instance just disappears from the workspace catalog —
 * an existing workspace link keeps working until its own Operations are disabled), so this panel,
 * unlike `WorkspaceDetailPanel`/`UserDetailPanel`, acts directly rather than behind a confirm step.
 *
 * S6-C: B7 (docs/console-completion-plan.md §4 "接入三层": 启用 only appears in `discovered`) —
 * the status control is one button whose meaning follows the machine: `discovered` → 启用,
 * `enabled` → 禁用, `disabled` → 重新启用, `lost` → 启用 (the kernel accepts it — a gate that
 * announced once and fell silent is enabled on its return; the CI seed is exactly that), derived
 * `awaiting_host` → 启用 disabled with a hint. And §5.6's
 * instance ↔ connection links: the workspaces using this instance (`enabledWorkspaceCount` — the
 * wire carries the count, not the list) plus, when this session has a workspace in scope, that
 * workspace's own Gatekeeper for it (`list_available_gate_instances`, a workspace-plane read that
 * simply yields nothing on a platform-only session) linking to its 系统接入 detail.
 */
export function GateInstanceDetailPanel({
  http,
  instance,
  onChanged,
  onDeleted,
}: GateInstanceDetailPanelProps) {
  const t = useT();
  const [displayName, setDisplayName] = useState(instance.displayName);
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState<unknown | null>(null);

  const [changingStatus, setChangingStatus] = useState(false);
  const [statusError, setStatusError] = useState<unknown | null>(null);

  const [changingTrust, setChangingTrust] = useState(false);
  const [trustError, setTrustError] = useState<unknown | null>(null);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<GateInstanceTestResult | null>(null);
  const [testError, setTestError] = useState<unknown | null>(null);

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<unknown | null>(null);

  const nameDirty = displayName.trim() !== instance.displayName && displayName.trim().length > 0;

  async function saveName(): Promise<void> {
    if (!nameDirty || savingName) return;
    setSavingName(true);
    setNameError(null);
    try {
      onChanged(
        await http.call<GateInstanceWire>('update_gate_instance', {
          gateId: instance.gateId,
          displayName: displayName.trim(),
        }),
      );
    } catch (err) {
      setNameError(err);
    } finally {
      setSavingName(false);
    }
  }

  async function setStatus(status: 'enabled' | 'disabled'): Promise<void> {
    if (changingStatus) return;
    setChangingStatus(true);
    setStatusError(null);
    try {
      onChanged(
        await http.call<GateInstanceWire>('update_gate_instance', {
          gateId: instance.gateId,
          status,
        }),
      );
    } catch (err) {
      setStatusError(err);
    } finally {
      setChangingStatus(false);
    }
  }

  async function setTrust(trust: GateTrustWire): Promise<void> {
    if (changingTrust) return;
    setChangingTrust(true);
    setTrustError(null);
    try {
      onChanged(
        await http.call<GateInstanceWire>('update_gate_instance', {
          gateId: instance.gateId,
          trust,
        }),
      );
    } catch (err) {
      setTrustError(err);
    } finally {
      setChangingTrust(false);
    }
  }

  async function test(): Promise<void> {
    if (testing) return;
    setTesting(true);
    setTestError(null);
    try {
      setTestResult(
        await http.call<GateInstanceTestResult>('test_gate_instance', { gateId: instance.gateId }),
      );
    } catch (err) {
      setTestError(err);
    } finally {
      setTesting(false);
    }
  }

  async function deleteInstance(): Promise<void> {
    if (deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await http.call('delete_gate_instance', { gateId: instance.gateId });
      onDeleted(instance.gateId);
    } catch (err) {
      setDeleteError(err);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="stack" data-testid="gate-instance-detail">
      {/* S8 W1-A11 (audit L8): the drawer's fixed three sections — metadata / related links /
       *  edit form — replacing the old flat stack of dl / form / action blocks separated only by
       *  `.divider`s in whatever order each one was written. The hosted-instance block (metadata,
       *  credential entry, delete) is kept as one unit inside Edit form — it is dominated by its
       *  two actions (enter the credential, delete), and its own unit test reaches the credential
       *  entry's token button through `gate-instance-hosted-definition`, so it cannot split across
       *  sections without breaking that lookup. */}
      <DrawerSections>
        <DrawerSection title={t('元数据 Metadata', 'Metadata')}>
          <dl className="definition-list">
            <dt>Gate id</dt>
            <dd>
              {/* S8 W1-A6 (audit S10): gate ids are short human-readable slugs
                  (`gatekeeper-quickbooks`, …), not UUIDs — CopyId's default 8-char truncation
                  turned one into the meaningless "gatekeep". `full` shows it whole; slugs are
                  already short enough (migrations/core/0023_gate_instances.sql caps them at 64
                  chars). */}
              <CopyId id={instance.gateId} label="gate" full />
            </dd>
            <dt>{t('接入包', 'Connector')}</dt>
            <dd className="mono">{instance.connector}</dd>
            <dt>{t('种类', 'Transport')}</dt>
            <dd>{transportKindLabel(instance.transportKind, t)}</dd>
            <dt>{t('目标', 'Target')}</dt>
            <dd className="mono">{instance.target}</dd>
            <dt>{t('端点', 'Endpoint')}</dt>
            <dd className="mono">{instance.endpoint}</dd>
            <dt>{t('健康', 'Health')}</dt>
            <dd>
              <StatusChip
                machine="gateHealth"
                status={instance.health}
                size="s"
                testId="gate-instance-detail-health"
              />
            </dd>
            <dt>{t('最近心跳', 'Last seen')}</dt>
            <dd>
              {instance.lastSeenAt === null ? (
                t('从未', 'Never')
              ) : (
                <time title={formatDateTime(instance.lastSeenAt)}>
                  {formatRelative(instance.lastSeenAt)}
                </time>
              )}
            </dd>
            <dt>{t('启用它的工作区数', 'Enabling workspaces')}</dt>
            <dd className="mono">{instance.enabledWorkspaceCount}</dd>
          </dl>

          {testResult ? (
            <div className="stack-s" data-testid="gate-instance-test-result">
              <dl className="definition-list">
                <dt>{t('健康', 'Health')}</dt>
                <dd>
                  <StatusChip
                    machine="gateHealth"
                    status={testResult.health}
                    size="s"
                    testId="gate-instance-test-health"
                  />
                </dd>
                <dt>{t('描述的 Operation 数', 'Described operations')}</dt>
                <dd className="mono">{testResult.describedOperationCount ?? '—'}</dd>
                <dt>{t('检查时间', 'Checked')}</dt>
                <dd>
                  <time title={formatDateTime(testResult.checkedAt)}>
                    {formatRelative(testResult.checkedAt)}
                  </time>
                </dd>
              </dl>
            </div>
          ) : null}

          <div className="stack-s">
            <span>
              {t(
                `已 announce 的 Operation（${instance.operations.length}）`,
                `Announced operations (${instance.operations.length})`,
              )}
            </span>
            {instance.operations.length === 0 ? (
              <p className="text-3">
                {t('这个实例还没有 announce 过任何 Operation。', 'No Operations announced.')}
              </p>
            ) : (
              <div className="table-scroll">
                <table className="data-table" data-testid="gate-instance-operations-table">
                  <thead>
                    <tr>
                      <th>{t('名称', 'Name')}</th>
                      <th>{t('模式', 'Mode')}</th>
                      <th>{t('影响级', 'Blast radius')}</th>
                      <th>{t('提示', 'Hints')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {instance.operations.map((operation) => (
                      <tr key={operation.name}>
                        <td className="mono">{operation.name}</td>
                        <td>
                          <StatusChip machine="operationMode" status={operation.mode} size="s" />
                        </td>
                        <td>
                          <div className="row-wrap">
                            <StatusChip
                              machine="blastRadius"
                              status={operation.blastRadius}
                              size="s"
                            />
                            {operation.autoApprovable ? (
                              <StatusChip machine="autoApprovable" status="true" size="s" />
                            ) : null}
                          </div>
                        </td>
                        <td>
                          {[
                            operation.readOnlyHint ? t('只读', 'read-only') : null,
                            operation.destructiveHint ? t('破坏性', 'destructive') : null,
                            operation.idempotentHint ? t('幂等', 'idempotent') : null,
                          ]
                            .filter(Boolean)
                            .join(' · ') || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </DrawerSection>

        <DrawerSection title={t('相关链接 Related links', 'Related links')}>
          <WorkspacesUsingSection http={http} instance={instance} />
        </DrawerSection>

        <DrawerSection title={t('编辑 Edit', 'Edit')}>
          <Field id="gid-display-name" label={t('名称', 'Display name')}>
            <Input
              id="gid-display-name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              disabled={savingName}
            />
          </Field>
          <PlatformError
            error={nameError}
            title={t('无法重命名', 'Could not rename this instance')}
          />
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button
              variant="secondary"
              onClick={() => void saveName()}
              loading={savingName}
              disabled={!nameDirty}
            >
              {t('保存', 'Save')}
            </Button>
          </div>

          <div className="divider" />

          <PlatformError
            error={statusError}
            title={t('无法修改状态', 'Could not change the status')}
          />
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <StatusChip
              machine="gateInstance"
              status={deriveGateInstanceStatus(instance)}
              size="s"
              testId="gate-instance-detail-status"
            />
            <StatusToggle
              instance={instance}
              busy={changingStatus}
              onChange={(status) => void setStatus(status)}
            />
          </div>

          {instance.transportKind === 'mcp' ? (
            <>
              <div className="divider" />
              <Notice>
                {t(
                  '只对 MCP 类型生效：标记为 vetted 后，非破坏性、幂等的工具调用可以被自动批准；随时可以撤销， 并且每次审批决策都会重新读取这个标记。 MCP only —',
                  'marking an instance vetted allows auto-approval of non-destructive, idempotent tool calls; it is revocable any time and read fresh at every approval decision.',
                )}
              </Notice>
              <PlatformError
                error={trustError}
                title={t('无法设置信任级别', 'Could not set the trust level')}
              />
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <StatusChip
                  machine="gateTrust"
                  status={instance.trust}
                  size="s"
                  testId="gate-instance-detail-trust"
                />
                <Button
                  variant="secondary"
                  onClick={() => void setTrust(instance.trust === 'vetted' ? 'byo' : 'vetted')}
                  loading={changingTrust}
                  data-testid="gate-instance-trust-toggle"
                >
                  {instance.trust === 'vetted'
                    ? t('撤销 vetted', 'Revoke vetted')
                    : t('标记为 vetted', 'Mark vetted')}
                </Button>
              </div>
            </>
          ) : null}

          <div className="divider" />

          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button
              variant="secondary"
              icon="refresh"
              onClick={() => void test()}
              loading={testing}
              data-testid="gate-instance-test"
            >
              {t('测试连接', 'Test connection')}
            </Button>
          </div>
          <PlatformError
            error={testError}
            title={t('无法测试连接', 'Could not test this connection')}
          />

          {instance.hosted && instance.definition ? (
            <>
              <div className="divider" />
              <div className="stack-s" data-testid="gate-instance-hosted-definition">
                <span className="tag" data-testid="gate-instance-hosted-tag">
                  {t('宿主', 'hosted')}
                </span>
                <dl className="definition-list">
                  <dt>{t('种类', 'Transport')}</dt>
                  <dd>{instance.definition.transportKind}</dd>
                  <dt>{t('目标', 'Target')}</dt>
                  <dd className="mono">{instance.definition.target}</dd>
                  <dt>{t('凭证模式', 'Credential mode')}</dt>
                  <dd>
                    {instance.definition.credentialMode === 'shared'
                      ? t('共享', 'Shared')
                      : t('按人', 'Connected account')}
                  </dd>
                  <dt>Manifest source</dt>
                  <dd className="mono">{instance.definition.manifestSource ?? '—'}</dd>
                </dl>

                {instance.definition.credentialMode === 'shared' ? (
                  <div className="stack-s">
                    <span className="field-label">
                      {t('录入共享凭证', 'Enter shared credential')}
                    </span>
                    <GateCredentialEntry
                      requestToken={() =>
                        http.call<GateHostTokenWire>('issue_gate_host_token', {
                          gateId: instance.gateId,
                        })
                      }
                      tokenButtonLabel={t('获取 5 分钟令牌', 'Get a 5-minute token')}
                    />
                  </div>
                ) : null}

                <div className="divider" />
                <PlatformError
                  error={deleteError}
                  title={t('无法删除', 'Could not delete this instance')}
                  testId="gate-instance-delete-error"
                />
                {confirmingDelete ? (
                  <div className="row-wrap" style={{ justifyContent: 'flex-end' }}>
                    <Button variant="ghost" size="s" onClick={() => setConfirmingDelete(false)}>
                      {t('取消', 'Cancel')}
                    </Button>
                    <Button
                      variant="danger"
                      size="s"
                      onClick={() => void deleteInstance()}
                      loading={deleting}
                      data-testid="gate-instance-delete-confirm"
                    >
                      {t('确认删除', 'Confirm delete')}
                    </Button>
                  </div>
                ) : (
                  <div className="row" style={{ justifyContent: 'flex-end' }}>
                    <Button
                      variant="danger"
                      size="s"
                      onClick={() => setConfirmingDelete(true)}
                      data-testid="gate-instance-delete"
                    >
                      {t('删除', 'Delete')}
                    </Button>
                  </div>
                )}
              </div>
            </>
          ) : null}
        </DrawerSection>
      </DrawerSections>
    </div>
  );
}

/** B7: the one status button, labelled by the machine (see the module doc comment). Keeps the
 *  `gate-instance-status-toggle` test id and the exact `禁用 Disable` text two e2e specs branch on. */
function StatusToggle({
  instance,
  busy,
  onChange,
}: {
  readonly instance: GateInstanceWire;
  readonly busy: boolean;
  readonly onChange: (status: 'enabled' | 'disabled') => void;
}) {
  const t = useT();
  const display = deriveGateInstanceStatus(instance);
  if (display === 'awaiting_host') {
    return (
      <Button
        variant="secondary"
        disabled
        title={t('等待门宿主接管后再启用', 'Wait for the gate host to take it over')}
        data-testid="gate-instance-status-toggle"
      >
        {t('启用', 'Enable')}
      </Button>
    );
  }
  if (display === 'discovered' || display === 'lost') {
    return (
      <Button
        variant="secondary"
        onClick={() => onChange('enabled')}
        loading={busy}
        data-testid="gate-instance-status-toggle"
      >
        {t('启用', 'Enable')}
      </Button>
    );
  }
  if (display === 'disabled') {
    return (
      <Button
        variant="secondary"
        onClick={() => onChange('enabled')}
        loading={busy}
        data-testid="gate-instance-status-toggle"
      >
        {t('重新启用', 'Re-enable')}
      </Button>
    );
  }
  return (
    <Button
      variant="danger"
      onClick={() => onChange('disabled')}
      loading={busy}
      data-testid="gate-instance-status-toggle"
    >
      {t('禁用', 'Disable')}
    </Button>
  );
}

/** §5.6 instance → connection link. S8 W4-C (ui-audit PI3 "'4 个工作区已启用'但不列出是哪 4 个"):
 *  the platform wire now also exposes `enablingWorkspaces` (W1-C, leftover 48) — up to
 *  `ENABLING_WORKSPACES_LIMIT` names, newest link first; `enabledWorkspaceCount` stays the true
 *  total even when the list is shorter (kernel-side truncation, never guessed). Also shows a link
 *  to the workspace 系统接入 page, and — for the session's own workspace, when it has one — that
 *  workspace's Gatekeeper for this instance as a `RefChip`. The workspace read fails quietly
 *  (403 / no workspace on a platform-only session): nothing is rendered for it. */
function WorkspacesUsingSection({
  http,
  instance,
}: {
  readonly http: CapabilityCaller;
  readonly instance: GateInstanceWire;
}) {
  const t = useT();
  const available = useCapabilityList<AvailableGateInstanceWire>(
    http,
    'list_available_gate_instances',
    {},
  );
  const own =
    available.state.status === 'ready'
      ? available.state.data.items.find((row) => row.gateId === instance.gateId)
      : undefined;
  const enablingWorkspaces = instance.enablingWorkspaces ?? [];
  const unlistedCount = instance.enabledWorkspaceCount - enablingWorkspaces.length;
  return (
    <div className="stack-s" data-testid="gate-instance-workspaces">
      <span className="section-title">{t('启用它的工作区', 'Workspaces using it')}</span>
      {instance.enabledWorkspaceCount === 0 ? (
        <p className="text-2">{t('还没有工作区启用它。', 'No workspace has enabled it yet.')}</p>
      ) : enablingWorkspaces.length > 0 ? (
        <>
          <ul data-testid="gate-instance-enabling-workspaces">
            {enablingWorkspaces.map((workspace) => (
              <li key={workspace.id} className="text-2">
                {workspace.name}
              </li>
            ))}
          </ul>
          {unlistedCount > 0 ? (
            <p className="text-3 text-small">
              {t(`另有 ${unlistedCount} 个未列出`, `${unlistedCount} more not shown`)}
            </p>
          ) : null}
        </>
      ) : (
        // `enablingWorkspaces` omitted or empty while `enabledWorkspaceCount > 0` (a pre-W1-C
        // fixture, or the kernel-side list came back empty for another reason) — the count-only
        // sentence this section rendered before W4-C, kept as a fallback.
        <p className="text-2">
          {t(
            `${instance.enabledWorkspaceCount} 个工作区已启用（各自的连接在该工作区的系统接入页）。`,
            `${instance.enabledWorkspaceCount} workspace${instance.enabledWorkspaceCount === 1 ? '' : 's'} enabled it — each connection lives on that workspace's own Systems page.`,
          )}
        </p>
      )}
      {own?.gatekeeperId ? (
        <div className="row-wrap" data-testid="gate-instance-own-workspace">
          <span className="text-3">{t('当前工作区', 'Current workspace:')}</span>
          <RefChip
            kind="gatekeeper"
            id={own.gatekeeperId}
            name={own.displayName}
            href={hrefs.gatekeeper(own.gatekeeperId)}
            size="s"
            testId="gate-instance-own-gatekeeper"
          />
        </div>
      ) : null}
      <a href={hrefs.systems()} data-testid="gate-instance-systems-link">
        {t('打开工作区系统接入页 Open the workspace 系统接入', 'page')}
      </a>
    </div>
  );
}
