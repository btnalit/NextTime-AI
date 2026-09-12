import type { GateInstanceWire } from '@nexttime/shared';
import { type FormEvent, useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import { GATE_ID_PATTERN } from '../../lib/platform-errors.js';
import { Button } from '../ui/Button.js';
import { Field, Input } from '../ui/Field.js';
import { PlatformError } from './PlatformError.js';

export interface CreateGateInstanceFormProps {
  readonly http: CapabilityCaller;
  readonly onCreated: (instance: GateInstanceWire) => void;
  readonly onCancel: () => void;
}

type TransportKind = 'http' | 'mcp';
type CredentialMode = 'shared' | 'connected_account';

function isValidUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.href.length > 0;
  } catch {
    return false;
  }
}

/**
 * components/platform/CreateGateInstanceForm: `create_gate_instance` (P-B2a 决定 ⑥–⑬) — the
 * administrator half of the generic门宿主 flow. Never takes a credential (design's own line: "the
 * kernel is never in that path") — a shared credential is entered afterwards from
 * `GateInstanceDetailPanel` (`issue_gate_host_token` + `GateCredentialEntry`), a per-member one
 * from the workspace's 系统接入 page. `manifestSource` only makes sense for `http` (mcp lists tools
 * on the target itself, `capabilities.ts`'s own doc comment) — hidden, not just disabled, for mcp
 * so a stale value from switching kinds can never be submitted.
 */
export function CreateGateInstanceForm({ http, onCreated, onCancel }: CreateGateInstanceFormProps) {
  const [gateId, setGateId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [transportKind, setTransportKind] = useState<TransportKind>('http');
  const [target, setTarget] = useState('');
  const [credentialMode, setCredentialMode] = useState<CredentialMode>('shared');
  const [manifestSource, setManifestSource] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown | null>(null);

  const gateIdValid = GATE_ID_PATTERN.test(gateId.trim());
  const targetValid = target.trim().length > 0 && isValidUrl(target.trim());
  const ready = gateIdValid && targetValid && !submitting;

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!ready) return;
    const params: Record<string, unknown> = {
      gateId: gateId.trim(),
      transportKind,
      target: target.trim(),
      credentialMode,
    };
    if (displayName.trim().length > 0) params.displayName = displayName.trim();
    if (transportKind === 'http' && manifestSource.trim().length > 0) {
      params.manifestSource = manifestSource.trim();
    }
    setSubmitting(true);
    setError(null);
    try {
      onCreated(await http.call<GateInstanceWire>('create_gate_instance', params));
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      className="stack"
      onSubmit={(event) => void handleSubmit(event)}
      noValidate
      data-testid="create-gate-instance-form"
    >
      <Field
        id="cgi-gate-id"
        label="Gate id"
        required
        hint="小写字母/数字/连字符，成为它在门宿主上的路径（/i/<gateId>）。 Lowercase letters/digits/hyphens — becomes its gate-host path."
        error={gateId.length > 0 && !gateIdValid ? '格式不合法 Invalid gate id' : undefined}
      >
        <Input
          id="cgi-gate-id"
          value={gateId}
          onChange={(event) => setGateId(event.target.value)}
          disabled={submitting}
          mono
          autoFocus
        />
      </Field>

      <Field id="cgi-display-name" label="名称 Display name">
        <Input
          id="cgi-display-name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          disabled={submitting}
          placeholder={gateId.trim() || 'gate id'}
        />
      </Field>

      <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="field-label">种类 Transport</legend>
        <div className="radio-group" role="radiogroup" aria-label="Transport kind">
          <label className="radio-option">
            <input
              type="radio"
              name="transportKind"
              value="http"
              checked={transportKind === 'http'}
              onChange={() => setTransportKind('http')}
              disabled={submitting}
            />
            http — 从 OpenAPI 文档导入 Operations Imports Operations from an OpenAPI document
          </label>
          <label className="radio-option">
            <input
              type="radio"
              name="transportKind"
              value="mcp"
              checked={transportKind === 'mcp'}
              onChange={() => setTransportKind('mcp')}
              disabled={submitting}
            />
            mcp — 在目标上跑 tools/list Lists tools on the target itself
          </label>
        </div>
      </fieldset>

      <Field
        id="cgi-target"
        label="目标 Target"
        required
        hint="目标系统的基础 URL（http）或 MCP 端点（mcp）。 The target system's base URL (http) or MCP endpoint (mcp)."
        error={target.length > 0 && !targetValid ? '不是合法的 URL Not a valid URL' : undefined}
      >
        <Input
          id="cgi-target"
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          disabled={submitting}
          mono
          placeholder="https://…"
        />
      </Field>

      <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="field-label">凭证模式 Credential mode</legend>
        <div className="radio-group" role="radiogroup" aria-label="Credential mode">
          <label className="radio-option">
            <input
              type="radio"
              name="credentialMode"
              value="shared"
              checked={credentialMode === 'shared'}
              onChange={() => setCredentialMode('shared')}
              disabled={submitting}
            />
            共享 Shared — 整个实例一份凭证，由管理员录入 One credential for the whole instance,
            entered by an administrator
          </label>
          <label className="radio-option">
            <input
              type="radio"
              name="credentialMode"
              value="connected_account"
              checked={credentialMode === 'connected_account'}
              onChange={() => setCredentialMode('connected_account')}
              disabled={submitting}
            />
            按人 Connected account — 每个成员从工作区录入自己的一份 Each member enters their own
            from the workspace
          </label>
        </div>
      </fieldset>

      {transportKind === 'http' ? (
        <Field
          id="cgi-manifest-source"
          label="Manifest source"
          hint="可选：OpenAPI 文档 URL，留空则沿用门宿主已配置的清单。 Optional — the OpenAPI document URL to import from."
        >
          <Input
            id="cgi-manifest-source"
            value={manifestSource}
            onChange={(event) => setManifestSource(event.target.value)}
            disabled={submitting}
            mono
            placeholder="https://…/openapi.json"
          />
        </Field>
      ) : null}

      <PlatformError
        error={error}
        title="无法新建门宿主实例 Could not create this instance"
        testId="create-gate-instance-error"
      />

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>
          取消 Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          loading={submitting}
          disabled={!ready}
          data-testid="create-gate-instance-submit"
        >
          创建 Create
        </Button>
      </div>
    </form>
  );
}
