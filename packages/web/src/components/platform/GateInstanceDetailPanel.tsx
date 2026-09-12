import type { GateInstanceWire, GateTrustWire } from '@nexttime/shared';
import { useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import { Button } from '../ui/Button.js';
import { CopyId } from '../ui/CopyId.js';
import { Field, Input } from '../ui/Field.js';
import { Notice } from '../ui/Notice.js';
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
 */
export function GateInstanceDetailPanel({
  http,
  instance,
  onChanged,
}: GateInstanceDetailPanelProps) {
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

  return (
    <div className="stack" data-testid="gate-instance-detail">
      <dl className="definition-list">
        <dt>Gate id</dt>
        <dd>
          <CopyId id={instance.gateId} label="gate" />
        </dd>
        <dt>接入包 Connector</dt>
        <dd className="mono">{instance.connector}</dd>
        <dt>种类 Transport</dt>
        <dd>{instance.transportKind}</dd>
        <dt>目标 Target</dt>
        <dd className="mono">{instance.target}</dd>
        <dt>端点 Endpoint</dt>
        <dd className="mono">{instance.endpoint}</dd>
        <dt>健康 Health</dt>
        <dd>{instance.health}</dd>
        <dt>最近心跳 Last seen</dt>
        <dd>
          {instance.lastSeenAt === null ? (
            '从未 Never'
          ) : (
            <time title={formatDateTime(instance.lastSeenAt)}>
              {formatRelative(instance.lastSeenAt)}
            </time>
          )}
        </dd>
        <dt>启用它的工作区数</dt>
        <dd className="mono">{instance.enabledWorkspaceCount}</dd>
      </dl>

      <div className="divider" />

      <Field id="gid-display-name" label="名称 Display name">
        <Input
          id="gid-display-name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          disabled={savingName}
        />
      </Field>
      <PlatformError error={nameError} title="无法重命名 Could not rename this instance" />
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button
          variant="secondary"
          onClick={() => void saveName()}
          loading={savingName}
          disabled={!nameDirty}
        >
          保存 Save
        </Button>
      </div>

      <div className="divider" />

      <PlatformError error={statusError} title="无法修改状态 Could not change the status" />
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span
          className={`chip chip-s ${instance.status === 'enabled' ? 'chip-ok' : instance.status === 'lost' ? 'chip-warn' : 'chip-neutral'}`}
        >
          {instance.status}
        </span>
        <Button
          variant={instance.status === 'enabled' ? 'danger' : 'secondary'}
          onClick={() => void setStatus(instance.status === 'enabled' ? 'disabled' : 'enabled')}
          loading={changingStatus}
          data-testid="gate-instance-status-toggle"
        >
          {instance.status === 'enabled' ? '禁用 Disable' : '启用 Enable'}
        </Button>
      </div>

      {instance.transportKind === 'mcp' ? (
        <>
          <div className="divider" />
          <Notice>
            只对 MCP 类型生效：标记为 vetted
            后，非破坏性、幂等的工具调用可以被自动批准；随时可以撤销，
            并且每次审批决策都会重新读取这个标记。 MCP only — marking an instance vetted allows
            auto-approval of non-destructive, idempotent tool calls; it is revocable any time and
            read fresh at every approval decision.
          </Notice>
          <PlatformError
            error={trustError}
            title="无法设置信任级别 Could not set the trust level"
          />
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span
              className={`chip chip-s ${instance.trust === 'vetted' ? 'chip-ok' : 'chip-neutral'}`}
            >
              {instance.trust}
            </span>
            <Button
              variant="secondary"
              onClick={() => void setTrust(instance.trust === 'vetted' ? 'byo' : 'vetted')}
              loading={changingTrust}
              data-testid="gate-instance-trust-toggle"
            >
              {instance.trust === 'vetted'
                ? '撤销 vetted Revoke vetted'
                : '标记为 vetted Mark vetted'}
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
          测试连接 Test connection
        </Button>
      </div>
      <PlatformError error={testError} title="无法测试连接 Could not test this connection" />
      {testResult ? (
        <div className="stack-s" data-testid="gate-instance-test-result">
          <dl className="definition-list">
            <dt>健康 Health</dt>
            <dd>{testResult.health}</dd>
            <dt>描述的 Operation 数</dt>
            <dd className="mono">{testResult.describedOperationCount ?? '—'}</dd>
            <dt>检查时间 Checked</dt>
            <dd>
              <time title={formatDateTime(testResult.checkedAt)}>
                {formatRelative(testResult.checkedAt)}
              </time>
            </dd>
          </dl>
        </div>
      ) : null}

      <div className="divider" />

      <div className="stack-s">
        <span>Announced operations ({instance.operations.length})</span>
        {instance.operations.length === 0 ? (
          <p className="text-3">
            这个实例还没有 announce 过任何 Operation。 No Operations announced.
          </p>
        ) : (
          <div className="table-scroll">
            <table className="data-table" data-testid="gate-instance-operations-table">
              <thead>
                <tr>
                  <th>名称 Name</th>
                  <th>模式 Mode</th>
                  <th>Blast radius</th>
                  <th>Hints</th>
                </tr>
              </thead>
              <tbody>
                {instance.operations.map((operation) => (
                  <tr key={operation.name}>
                    <td className="mono">{operation.name}</td>
                    <td>{operation.mode}</td>
                    <td>{operation.blastRadius}</td>
                    <td>
                      {[
                        operation.readOnlyHint ? '只读 read-only' : null,
                        operation.destructiveHint ? '破坏性 destructive' : null,
                        operation.idempotentHint ? '幂等 idempotent' : null,
                        operation.autoApprovable ? '可自动批准 auto-approvable' : null,
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
    </div>
  );
}
