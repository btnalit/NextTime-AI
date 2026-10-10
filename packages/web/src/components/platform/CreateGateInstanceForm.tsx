import type { GateInstanceWire } from '@nexttime/shared';
import { type FormEvent, useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import {
  deriveGateId,
  gateIdFromTarget,
  isAbsoluteUrl,
  normalizeGateIdInput,
  withDefaultScheme,
} from '../../lib/gate-input.js';
import { useT } from '../../lib/i18n.js';
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

/**
 * components/platform/CreateGateInstanceForm: `create_gate_instance` (P-B2a 决定 ⑥–⑬) — the
 * administrator half of the generic门宿主 flow. Never takes a credential (design's own line: "the
 * kernel is never in that path") — a shared credential is entered afterwards from
 * `GateInstanceDetailPanel` (`issue_gate_host_token` + `GateCredentialEntry`), a per-member one
 * from the workspace's 系统接入 page. `manifestSource` is required for `http` (mcp lists tools
 * on the target itself, `capabilities.ts`'s own doc comment) — hidden, not just disabled, for mcp
 * so a stale value from switching kinds can never be submitted.
 *
 * Fills and normalizes instead of refusing (console UX pass): the gate id is derived from the
 * display name (or, failing that, the target's host) until the administrator edits it, and typed
 * input is normalized live (`lib/gate-input.ts` — lowercase, `_`/space/`.` → `-`); a target or
 * manifest URL without a scheme gets `https://` on blur, with a one-line note; for http the
 * manifest field offers `<target>/openapi.json` as a one-click fill (never set silently).
 */
export function CreateGateInstanceForm({ http, onCreated, onCancel }: CreateGateInstanceFormProps) {
  const t = useT();
  const [gateIdInput, setGateIdInput] = useState('');
  /** `true` once the administrator typed into the gate-id field; leaving it empty (blur) resumes
   *  derivation. */
  const [gateIdEdited, setGateIdEdited] = useState(false);
  /** The last keystroke changed what was typed (capitals, `_`, spaces, …) — says so under the field. */
  const [gateIdAdjusted, setGateIdAdjusted] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [transportKind, setTransportKind] = useState<TransportKind>('http');
  const [target, setTarget] = useState('');
  const [targetSchemeAdded, setTargetSchemeAdded] = useState(false);
  const [credentialMode, setCredentialMode] = useState<CredentialMode>('shared');
  const [manifestSource, setManifestSource] = useState('');
  const [manifestSchemeAdded, setManifestSchemeAdded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown | null>(null);

  const idFromName = deriveGateId(displayName);
  const derivedGateId = idFromName || gateIdFromTarget(target);
  const gateId = gateIdEdited ? gateIdInput : derivedGateId;
  const gateIdSource: 'name' | 'target' | null =
    gateIdEdited || derivedGateId.length === 0 ? null : idFromName ? 'name' : 'target';
  const gateIdValid = GATE_ID_PATTERN.test(gateId);

  // A value without a scheme counts as `https://…` (the blur handler writes that back into the
  // field; pressing Enter before blurring submits the same completed value).
  const targetValue = withDefaultScheme(target, 'https');
  const targetValid = targetValue.length > 0 && isAbsoluteUrl(targetValue);
  const manifestValue = withDefaultScheme(manifestSource, 'https');
  // C12 (console-completion-plan §2b): `create_gate_instance`'s `superRefine` requires
  // `manifestSource` for http (and it must be a URL) — the field said "required" while `ready`
  // ignored it, so a blank one was a guaranteed 400. Not consulted for mcp (field hidden).
  const manifestSourceValid =
    transportKind !== 'http' || (manifestValue.length > 0 && isAbsoluteUrl(manifestValue));
  const suggestedManifest = targetValid ? `${targetValue.replace(/\/+$/, '')}/openapi.json` : '';
  const ready = gateIdValid && targetValid && manifestSourceValid && !submitting;

  function changeGateId(raw: string): void {
    const normalized = normalizeGateIdInput(raw);
    setGateIdAdjusted(normalized !== raw);
    setGateIdInput(normalized);
    setGateIdEdited(true);
  }

  function completeTarget(): void {
    const next = withDefaultScheme(target, 'https');
    if (next !== target.trim()) setTargetSchemeAdded(true);
    setTarget(next);
  }

  function completeManifest(): void {
    const next = withDefaultScheme(manifestSource, 'https');
    if (next !== manifestSource.trim()) setManifestSchemeAdded(true);
    setManifestSource(next);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!ready) return;
    const params: Record<string, unknown> = {
      gateId,
      transportKind,
      target: targetValue,
      credentialMode,
    };
    if (displayName.trim().length > 0) params.displayName = displayName.trim();
    if (transportKind === 'http' && manifestValue.length > 0) {
      params.manifestSource = manifestValue;
    }
    setTarget(targetValue);
    if (transportKind === 'http') setManifestSource(manifestValue);
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

  const schemeNote = t(
    '已自动补上 https://；如果目标只走 http，请改成 http://。',
    'Added https:// for you — change it to http:// if the target only speaks plain http.',
  );

  return (
    <form
      className="stack"
      onSubmit={(event) => void handleSubmit(event)}
      noValidate
      data-testid="create-gate-instance-form"
    >
      <Field
        id="cgi-display-name"
        label={t('名称', 'Display name')}
        hint={t(
          '给人看的名称；下面的 Gate ID 会据此自动生成。',
          'A human-readable name — the gate id below is generated from it.',
        )}
      >
        <Input
          id="cgi-display-name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          disabled={submitting}
          placeholder={t('例如 Billing API', 'e.g. Billing API')}
          autoFocus
        />
      </Field>

      <Field
        id="cgi-gate-id"
        label="Gate id"
        required
        hint={
          <>
            {t(
              '2–64 位小写字母、数字或连字符，以字母或数字开头，会成为它在门宿主上的路径（/i/<gateId>）。大写、下划线、空格和点会自动转换。',
              'Lowercase letters, digits and hyphens, 2–64 characters, starting with a letter or digit; it becomes the gate-host path (/i/<gateId>). Capitals, underscores, spaces and dots are converted for you.',
            )}
            {gateIdSource !== null ? (
              <span data-testid="cgi-gate-id-derived">
                {' '}
                {gateIdSource === 'name'
                  ? t(
                      '已根据名称自动生成，可直接修改。',
                      'Generated from the display name — edit it if you like.',
                    )
                  : t(
                      '已根据目标地址自动生成，可直接修改。',
                      'Generated from the target host — edit it if you like.',
                    )}
              </span>
            ) : gateIdEdited && gateIdAdjusted ? (
              <span data-testid="cgi-gate-id-adjusted">
                {' '}
                {t(`已调整为 ${gateId}。`, `Adjusted to ${gateId}.`)}
              </span>
            ) : null}
          </>
        }
        error={
          gateId.length > 0 && !gateIdValid
            ? t(
                '至少需要 2 个字符：小写字母、数字或连字符，以字母或数字开头，例如 billing-api。',
                'Needs at least 2 characters — lowercase letters, digits or hyphens, starting with a letter or digit, e.g. billing-api.',
              )
            : undefined
        }
      >
        <Input
          id="cgi-gate-id"
          value={gateId}
          onChange={(event) => changeGateId(event.target.value)}
          onBlur={() => {
            if (gateIdInput.length === 0) setGateIdEdited(false);
          }}
          disabled={submitting}
          invalid={gateId.length > 0 && !gateIdValid}
          mono
          placeholder="billing-api"
        />
      </Field>

      <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="field-label">{t('种类', 'Transport')}</legend>
        <div className="radio-group" role="radiogroup" aria-label={t('种类', 'Transport kind')}>
          <label className="radio-option">
            <input
              type="radio"
              name="transportKind"
              value="http"
              checked={transportKind === 'http'}
              onChange={() => setTransportKind('http')}
              disabled={submitting}
            />
            {t(
              'http — Operation 从 OpenAPI 文档导入',
              'http — imports Operations from an OpenAPI document',
            )}
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
            {t('mcp — 在目标上运行 tools/list', 'mcp — lists the tools on the target itself')}
          </label>
        </div>
      </fieldset>

      <Field
        id="cgi-target"
        label={t('目标', 'Target')}
        required
        hint={
          <>
            {t(
              '目标系统的基础 URL（http）或 MCP 端点（mcp）；没写 https:// 会自动补上。',
              "The target system's base URL (http) or MCP endpoint (mcp); https:// is added if you leave it out.",
            )}
            {targetSchemeAdded ? (
              <span data-testid="cgi-target-scheme-note"> {schemeNote}</span>
            ) : null}
          </>
        }
        error={
          target.length > 0 && !targetValid
            ? t(
                '需要一个完整的地址，例如 https://billing.example.com 或 https://billing.example.com:8443/api。',
                'Needs a full address, e.g. https://billing.example.com or https://billing.example.com:8443/api.',
              )
            : undefined
        }
      >
        <Input
          id="cgi-target"
          value={target}
          onChange={(event) => {
            setTarget(event.target.value);
            setTargetSchemeAdded(false);
          }}
          onBlur={completeTarget}
          disabled={submitting}
          invalid={target.length > 0 && !targetValid}
          mono
          placeholder="https://billing.example.com"
        />
      </Field>

      <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="field-label">{t('凭证模式', 'Credential mode')}</legend>
        <div
          className="radio-group"
          role="radiogroup"
          aria-label={t('凭证模式', 'Credential mode')}
        >
          <label className="radio-option">
            <input
              type="radio"
              name="credentialMode"
              value="shared"
              checked={credentialMode === 'shared'}
              onChange={() => setCredentialMode('shared')}
              disabled={submitting}
            />
            {t(
              '共享 — 整个实例一份凭证，由管理员录入',
              'Shared — one credential for the whole instance, entered by an administrator',
            )}
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
            {t(
              '按人 — 每个成员在工作区录入自己的一份',
              'Connected account — each member enters their own from the workspace',
            )}
          </label>
        </div>
      </fieldset>

      {transportKind === 'http' ? (
        <Field
          id="cgi-manifest-source"
          label={t('清单来源', 'Manifest source')}
          required
          hint={
            <>
              {t(
                '必填：OpenAPI 文档的 URL，门宿主从这里导入 Operation。',
                'Required — the OpenAPI document URL the host imports Operations from.',
              )}
              {manifestSchemeAdded ? (
                <span data-testid="cgi-manifest-scheme-note"> {schemeNote}</span>
              ) : null}
            </>
          }
          error={
            manifestSource.length > 0 && !manifestSourceValid
              ? t(
                  '需要一个完整的地址，例如 https://billing.example.com/openapi.json。',
                  'Needs a full address, e.g. https://billing.example.com/openapi.json.',
                )
              : undefined
          }
        >
          <Input
            id="cgi-manifest-source"
            value={manifestSource}
            onChange={(event) => {
              setManifestSource(event.target.value);
              setManifestSchemeAdded(false);
            }}
            onBlur={completeManifest}
            disabled={submitting}
            mono
            required
            invalid={manifestSource.length > 0 && !manifestSourceValid}
            placeholder={suggestedManifest || 'https://billing.example.com/openapi.json'}
          />
          {suggestedManifest && manifestSource.trim() !== suggestedManifest ? (
            <div className="row">
              <Button
                variant="ghost"
                size="s"
                onClick={() => {
                  setManifestSource(suggestedManifest);
                  setManifestSchemeAdded(false);
                }}
                disabled={submitting}
                data-testid="cgi-manifest-suggest"
              >
                {t(`使用 ${suggestedManifest}`, `Use ${suggestedManifest}`)}
              </Button>
            </div>
          ) : null}
        </Field>
      ) : null}

      <PlatformError
        error={error}
        title={t('无法新建门宿主实例', 'Could not create this instance')}
        testId="create-gate-instance-error"
      />

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>
          {t('取消', 'Cancel')}
        </Button>
        <Button
          type="submit"
          variant="primary"
          loading={submitting}
          disabled={!ready}
          data-testid="create-gate-instance-submit"
        >
          {t('创建', 'Create')}
        </Button>
      </div>
    </form>
  );
}
