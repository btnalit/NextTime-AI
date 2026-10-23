import type { ConnectorPresetWire, GateInstanceWire } from '@nexttime/shared';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import { presentError } from '../../lib/errors.js';
import {
  deriveGateId,
  isAbsoluteUrl,
  normalizeGateIdInput,
  withDefaultScheme,
} from '../../lib/gate-input.js';
import { HttpError } from '../../lib/http-client.js';
import { sentenceGap, useT } from '../../lib/i18n.js';
import { connectorModeLabel } from '../../lib/labels.js';
import { GATE_ID_PATTERN } from '../../lib/platform-errors.js';
import { Button } from '../kit/button.js';
import { ErrorDetails } from '../kit/error-details.js';
import { Field, describedBy } from '../kit/field.js';
import { Notice } from '../kit/notice.js';
import { StillNeeded } from '../kit/still-needed.js';
import { gateOperationLine } from './PendingManifestReview.js';
import { PlatformError } from './PlatformError.js';
import { useConnectorsByName } from './integrations/connector-visibility.js';

export interface PresetGateInstanceFormProps {
  readonly http: CapabilityCaller;
  readonly preset: ConnectorPresetWire;
  readonly onCreated: (instance: GateInstanceWire) => void;
  readonly onCancel: () => void;
}

/** The gate id an instance of `preset` gets when the administrator names it nothing else: the
 *  preset's own name for the first one (`ragflow`), then `ragflow-2`, `ragflow-3`, … — the kernel
 *  still refuses one that is taken (`gate_id_taken`), said in the banner. */
export function presetGateId(preset: ConnectorPresetWire): string {
  return preset.instanceCount === 0 ? preset.name : `${preset.name}-${preset.instanceCount + 1}`;
}

/**
 * components/platform/PresetGateInstanceForm (S11 P1-F): `create_gate_instance` with `preset` — a
 * gate-host instance of a system this platform ships a connector preset for (`list_connector_presets`,
 * RAGFlow first). The preset fixes the transport, the credential mode, the Operations and the
 * connector, so the administrator types the address only; the name and the gate id are filled in.
 * What the instance will offer, where it is filed and which credential it needs afterwards are said
 * before anything is created. A preset whose connector a packaged gate holds is not offered: the
 * system is connected already, and the kernel refuses a gate-host instance there
 * (`connector_packaged`). Like `CreateGateInstanceForm`, it never takes a credential.
 */
export function PresetGateInstanceForm({
  http,
  preset,
  onCreated,
  onCancel,
}: PresetGateInstanceFormProps) {
  const t = useT();
  const [displayName, setDisplayName] = useState('');
  const [gateIdInput, setGateIdInput] = useState('');
  const [gateIdEdited, setGateIdEdited] = useState(false);
  const [target, setTarget] = useState('');
  const [targetSchemeAdded, setTargetSchemeAdded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown | null>(null);
  /** A `credentials_in_connection_params` refusal: said on the address field. */
  const [targetRefusal, setTargetRefusal] = useState<unknown | null>(null);
  const targetInput = useRef<HTMLInputElement>(null);
  const connectors = useConnectorsByName(http);
  // UX acceptance of #715 (P3-1): the address field takes the focus back once a refusal is said on
  // it — submitting disabled it, which had dropped the focus to the page.
  useEffect(() => {
    if (targetRefusal !== null && !submitting) targetInput.current?.focus();
  }, [targetRefusal, submitting]);

  const derivedGateId = deriveGateId(displayName) || presetGateId(preset);
  const gateId = gateIdEdited ? gateIdInput : derivedGateId;
  const gateIdValid = GATE_ID_PATTERN.test(gateId);
  const targetValue = withDefaultScheme(target, 'https');
  const targetValid = targetValue.length > 0 && isAbsoluteUrl(targetValue);
  const joined = connectors?.get(preset.name);
  const ready = !preset.packagedConnector && gateIdValid && targetValid && !submitting;
  const missing = preset.packagedConnector
    ? []
    : [
        gateIdValid
          ? null
          : gateId.length === 0
            ? t('填写门 ID', 'enter a gate ID')
            : t('改正门 ID', 'fix the gate ID'),
        targetValid
          ? null
          : target.length === 0
            ? t('填写地址', 'enter the address')
            : t('改正地址', 'fix the address'),
      ].filter((item): item is string => item !== null);

  function completeTarget(): void {
    const next = withDefaultScheme(target, 'https');
    if (next !== target.trim()) setTargetSchemeAdded(true);
    setTarget(next);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!ready) return;
    setTarget(targetValue);
    setSubmitting(true);
    setError(null);
    setTargetRefusal(null);
    try {
      onCreated(
        await http.call<GateInstanceWire>('create_gate_instance', {
          gateId,
          displayName: displayName.trim() || preset.displayName,
          preset: preset.name,
          target: targetValue,
        }),
      );
    } catch (err) {
      if (err instanceof HttpError && err.code === 'credentials_in_connection_params') {
        setTargetRefusal(err);
      } else {
        setError(err);
      }
    } finally {
      setSubmitting(false);
    }
  }

  const refusal = targetRefusal === null ? null : presentError(targetRefusal, t);
  const targetError =
    refusal !== null
      ? t(
          '地址里带了凭据（URL 里的用户名密码，或 token、key 之类的查询参数），已拒绝，什么也没创建：只写地址。凭证在实例创建后从实例详情里录入。',
          'The address carries a credential (a user name and password in the URL, or a token or key in its query) — refused, nothing was created. Enter only the address; the credential is entered from the instance’s details once it exists.',
        )
      : target.length > 0 && !targetValid
        ? t(
            '需要一个完整的地址，例如 https://ragflow.example.com。',
            'Needs a full address, e.g. https://ragflow.example.com.',
          )
        : null;
  const gateIdError =
    gateId.length > 0 && !gateIdValid
      ? t(
          '至少需要 2 个字符：小写字母、数字或连字符，以字母或数字开头。',
          'Needs at least 2 characters — lowercase letters, digits or hyphens, starting with a letter or digit.',
        )
      : null;

  return (
    <form
      className="stack"
      onSubmit={(event) => void handleSubmit(event)}
      noValidate
      data-testid="preset-gate-instance-form"
    >
      <div className="stack-s" data-testid="preset-summary">
        <p style={{ margin: 0 }}>{preset.summary}</p>
        <span className="field-label">
          {t(
            `它提供的 ${preset.operations.length} 个操作（创建后由门宿主公布，平台启用它之前还会逐个列出）`,
            `The ${preset.operations.length} operations it offers (the gate host announces them once it exists; they are listed again before the platform enables it)`,
          )}
        </span>
        <ul className="stack-s" style={{ margin: 0 }} data-testid="preset-operations">
          {preset.operations.map((operation) => (
            <li key={operation.name} className="mono text-small">
              {gateOperationLine(operation, t)}
            </li>
          ))}
        </ul>
      </div>

      {preset.packagedConnector ? (
        <Notice tone="warn" testId="preset-packaged">
          {t(
            `接入包「${preset.name}」属于一个打包的门（它自己的容器），按预设建的实例不能加入它。这个系统已经接上了：在门实例列表里找接入包为 ${preset.name} 的门。`,
            `The connector "${preset.name}" belongs to a packaged gate (a container of its own), so an instance made from this preset cannot join it. The system is connected already: find the gate whose connector is ${preset.name} in the gate-instance list.`,
          )}
        </Notice>
      ) : (
        <>
          <Field
            id="pgi-target"
            label={t('地址', 'Address')}
            required
            hint={
              <>
                {preset.targetHint}
                {targetSchemeAdded ? (
                  <span data-testid="pgi-target-scheme-note">
                    {sentenceGap(t)}
                    {t(
                      '已自动补上 https://；如果它只走 http，请改成 http://。',
                      'Added https:// for you — change it to http:// if it only speaks plain http.',
                    )}
                  </span>
                ) : null}
              </>
            }
            error={targetError}
          >
            <input
              ref={targetInput}
              id="pgi-target"
              className="input input-mono"
              value={target}
              onChange={(event) => {
                setTarget(event.target.value);
                setTargetSchemeAdded(false);
                setTargetRefusal(null);
              }}
              onBlur={completeTarget}
              disabled={submitting}
              aria-invalid={targetError !== null || undefined}
              aria-describedby={describedBy('pgi-target', true, targetError !== null)}
              placeholder="https://"
              autoComplete="off"
              spellCheck={false}
            />
            {refusal !== null ? (
              <ErrorDetails code={refusal.code} raw={refusal.raw} testId="pgi-target-error" />
            ) : null}
          </Field>

          <Field
            id="pgi-display-name"
            label={t('名称', 'Display name')}
            hint={t(
              `不填就叫「${preset.displayName}」；同一个系统接了几套时，用名称区分它们。`,
              `Left empty, it is called "${preset.displayName}"; name it to tell several of the same system apart.`,
            )}
          >
            <input
              id="pgi-display-name"
              className="input"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              disabled={submitting}
              aria-describedby={describedBy('pgi-display-name', true, false)}
              placeholder={preset.displayName}
            />
          </Field>

          <Field
            id="pgi-gate-id"
            label={t('门 ID', 'Gate ID')}
            required
            hint={
              gateIdEdited
                ? t(
                    `它在门宿主上的路径是 /i/${gateId}。`,
                    `Its path on the gate host is /i/${gateId}.`,
                  )
                : t(
                    `已自动生成，它在门宿主上的路径是 /i/${gateId}，可直接修改。`,
                    `Generated for you — its path on the gate host is /i/${gateId}; edit it if you like.`,
                  )
            }
            error={gateIdError}
          >
            <input
              id="pgi-gate-id"
              className="input input-mono"
              value={gateId}
              onChange={(event) => {
                setGateIdInput(normalizeGateIdInput(event.target.value));
                setGateIdEdited(true);
              }}
              onBlur={() => {
                if (gateIdInput.length === 0) setGateIdEdited(false);
              }}
              disabled={submitting}
              aria-invalid={gateIdError !== null || undefined}
              aria-describedby={describedBy('pgi-gate-id', true, gateIdError !== null)}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          <p className="text-3 text-small" style={{ margin: 0 }} data-testid="preset-connector">
            {joined
              ? t(
                  `放进接入包「${preset.name}」：它已有 ${joined.instanceCount} 个实例（${connectorModeLabel(joined.mode, t)}），这个实例会加入它。`,
                  `Filed under the connector "${preset.name}": it already holds ${joined.instanceCount} instance(s) (${connectorModeLabel(joined.mode, t)}); this instance joins it.`,
                )
              : t(
                  `放进新的接入包「${preset.name}」，它是「平台预置」：平台启用实例后，工作区就能在目录里看到它。`,
                  `Filed under a new connector "${preset.name}", a platform preset: once the platform enables the instance, workspaces see it in the catalog.`,
                )}
          </p>

          <Notice testId="preset-credential">
            {preset.credentialMode === 'shared'
              ? t(
                  `凭证不在这里填。创建后在实例详情里录入，整个实例共用一份，直接交给门宿主，平台内核拿不到它。要准备的是：${preset.credentialHint}`,
                  `The credential is not entered here. Once the instance exists, enter it from its details — one for the whole instance, handed straight to the gate host; the platform kernel never sees it. What to prepare: ${preset.credentialHint}`,
                )
              : t(
                  `凭证不在这里填。每个成员在工作区的「系统与授权」里录入自己的一份，直接交给门宿主，平台内核拿不到它。要准备的是：${preset.credentialHint}`,
                  `The credential is not entered here. Each member enters their own under Systems & access in the workspace, handed straight to the gate host; the platform kernel never sees it. What to prepare: ${preset.credentialHint}`,
                )}
          </Notice>
        </>
      )}

      <PlatformError
        error={error}
        title={t('无法新建门宿主实例', 'Could not create this instance')}
        testId="preset-gate-instance-error"
      />

      <div className="row overlay-actions" style={{ justifyContent: 'flex-end' }}>
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>
          {t('取消', 'Cancel')}
        </Button>
        {preset.packagedConnector ? null : (
          <Button
            type="submit"
            variant="primary"
            disabled={!ready}
            data-testid="preset-gate-instance-submit"
          >
            {submitting ? t('正在创建…', 'Creating…') : t('创建', 'Create')}
          </Button>
        )}
        <StillNeeded items={missing} hidden={submitting} testId="preset-gate-instance-missing" />
      </div>
    </form>
  );
}
