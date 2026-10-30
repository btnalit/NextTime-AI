import {
  CONNECTOR_NAME_PATTERN,
  type ConnectorPresetWire,
  type ConnectorWire,
  type GateInstanceWire,
  isGenericConnector,
} from '@nexttime/shared';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useCapabilityList } from '../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { presentError } from '../../lib/errors.js';
import {
  deriveGateId,
  gateIdFromTarget,
  isAbsoluteUrl,
  normalizeGateIdInput,
  suggestedManifestSource,
  withDefaultScheme,
} from '../../lib/gate-input.js';
import { HttpError } from '../../lib/http-client.js';
import { type Translate, sentenceGap, useT } from '../../lib/i18n.js';
import { connectorModeLabel } from '../../lib/labels.js';
import { GATE_ID_PATTERN } from '../../lib/platform-errors.js';
import { useGuardedClose } from '../kit/discard-guard.js';
import { ErrorDetails } from '../kit/error-details.js';
import { StillNeeded } from '../kit/still-needed.js';
import { Button } from '../ui/Button.js';
import { Field, Input } from '../ui/Field.js';
import { Notice } from '../ui/Notice.js';
import { PlatformError } from './PlatformError.js';
import { PresetGateInstanceForm } from './PresetGateInstanceForm.js';
import { useConnectorsByName } from './integrations/connector-visibility.js';

export interface CreateGateInstanceFormProps {
  readonly http: CapabilityCaller;
  readonly onCreated: (instance: GateInstanceWire) => void;
  readonly onCancel: () => void;
  /** S11 P1-F: start on this connector preset (`hrefs.platformConnectorPreset`, a pack's 需要平台接入
   *  system); otherwise the form starts on 其他系统. */
  readonly initialPreset?: string;
  /** The transport the reader already chose (the launcher's step 1): only presets of it are
   *  offered. */
  readonly transportKind?: TransportKind;
}

type TransportKind = 'http' | 'mcp';
type CredentialMode = 'shared' | 'connected_account';
/** Where the instance is filed (P1): a connector named after its system, or the generic one of its
 *  kind (`http` / `mcp`) — whose mode also decides whether workspaces connect that kind themselves. */
type ConnectorChoice = 'system' | 'generic';

/** Legacy 396 (UX acceptance of #644): the existing system connector a new instance most likely
 *  belongs to — one of this kind (not packaged, not generic) whose name the gate id starts with,
 *  followed by a hyphen (`billing` for `billing-2` or `billing-eu`). The longest such name wins, so
 *  `billing-eu` beats `billing` for `billing-eu-2`. `null` when none does (or the list is not read
 *  yet): the connector is then named after the gate id, as before. */
function existingConnectorFor(
  gateId: string,
  kind: TransportKind,
  connectors: ReadonlyMap<string, ConnectorWire> | null,
): string | null {
  if (connectors === null) return null;
  let best: string | null = null;
  for (const row of connectors.values()) {
    if (row.packaged || isGenericConnector(row.name) || row.kind !== kind) continue;
    if (!gateId.startsWith(`${row.name}-`)) continue;
    if (best === null || row.name.length > best.length) best = row.name;
  }
  return best;
}

/** Why the system connector name cannot be used, said on the field — `null` when it can. Mirrors
 *  `create_gate_instance`'s refusals (`connector_kind_mismatch`, `connector_packaged`) against the
 *  `list_connectors` the form read (`null` while that loads or when it cannot be read: the kernel
 *  still decides). */
function connectorNameProblem(
  name: string,
  kind: TransportKind,
  connectors: ReadonlyMap<string, ConnectorWire> | null,
  t: Translate,
): string | null {
  if (!CONNECTOR_NAME_PATTERN.test(name)) {
    return t(
      '最多 64 位小写字母、数字或连字符，以字母或数字开头，例如 billing。',
      'Up to 64 lowercase letters, digits or hyphens, starting with a letter or digit, e.g. billing.',
    );
  }
  if (isGenericConnector(name)) {
    return t(
      `「${name}」是通用接入包的名字。要用通用接入包，选下面「通用接入包」；否则换一个名字。`,
      `"${name}" is the name of a generic connector. To use it, choose "Generic connector" below; otherwise pick another name.`,
    );
  }
  const existing = connectors?.get(name);
  if (existing?.packaged) {
    return t(
      `「${name}」属于一个打包的门，放不了门宿主实例，换一个名字。`,
      `"${name}" belongs to a packaged gate and cannot hold a gate-host instance — pick another name.`,
    );
  }
  if (existing && existing.kind !== kind) {
    return t(
      `「${name}」是 ${existing.kind} 接入包，放不了 ${kind} 实例，换一个名字。`,
      `"${name}" is an ${existing.kind} connector and cannot hold an ${kind} instance — pick another name.`,
    );
  }
  return null;
}

/** A `credentials_in_connection_params` refusal (review of #549): the field `details.field` names,
 *  shown on that field rather than in the banner. */
interface AddressRefusal {
  readonly field: 'target' | 'manifestSource';
  readonly error: unknown;
}

function addressRefusalOf(err: unknown): AddressRefusal | null {
  if (!(err instanceof HttpError) || err.code !== 'credentials_in_connection_params') return null;
  const field = err.details?.field;
  return field === 'target' || field === 'manifestSource' ? { field, error: err } : null;
}

const ALL_PRESETS: Readonly<Record<string, unknown>> = {};

/**
 * components/platform/CreateGateInstanceForm: 新建门宿主实例 — where to start, then the form for
 * it. S11 P1-F: a system this platform ships a connector preset for (`list_connector_presets`) is
 * one choice each, above 其他系统 — its form (`PresetGateInstanceForm`) asks for the address only.
 * With no preset (none shipped, none of this kind, or the list unreadable) the choice is not shown
 * and the form is the one below, as before.
 */
export function CreateGateInstanceForm({
  http,
  onCreated,
  onCancel,
  initialPreset,
  transportKind,
}: CreateGateInstanceFormProps) {
  // Legacy 497: in a drawer whose form was edited, 取消 asks before discarding it.
  const guardedClose = useGuardedClose();
  const t = useT();
  const list = useCapabilityList<ConnectorPresetWire>(http, 'list_connector_presets', ALL_PRESETS, {
    autoLoadAll: true,
  });
  const presets =
    list.state.status === 'ready'
      ? list.state.data.items.filter(
          (preset) => transportKind === undefined || preset.transportKind === transportKind,
        )
      : [];
  /** The chosen preset's name; `null` is 其他系统; `undefined` is nothing chosen yet. UX acceptance
   *  of #715 (P3-2): with presets to offer, neither is picked for the reader — the question comes
   *  alone, so a preset is not passed over under 其他系统's long form. */
  const [source, setSource] = useState<string | null | undefined>(initialPreset);
  const preset =
    typeof source === 'string' ? presets.find((row) => row.name === source) : undefined;
  const waiting = source !== null && list.state.status === 'loading';
  const choosing = source === undefined && !waiting && presets.length > 0;
  // A link to a preset this platform version does not ship (or one of another kind), or a preset
  // list that cannot be read, falls back to 其他系统 and says so.
  const fallbackNote =
    typeof source !== 'string' || waiting || preset !== undefined
      ? null
      : list.state.status === 'error'
        ? t(
            '读不到平台的接入预设，下面按其他系统填写。',
            'Could not read the platform’s connector presets; fill in the form below as for any other system.',
          )
        : t(
            `这个平台版本没有「${source}」的接入预设，下面按其他系统填写。`,
            `This platform version ships no connector preset "${source}"; fill in the form below as for any other system.`,
          );

  return (
    <div className="stack" data-testid="create-gate-instance">
      {presets.length > 0 ? (
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field-label">{t('接入什么', 'What to connect')}</legend>
          <div
            className="radio-group"
            role="radiogroup"
            aria-label={t('接入什么', 'What to connect')}
          >
            {presets.map((row) => (
              <label className="radio-option" key={row.name}>
                <input
                  type="radio"
                  name="gateSource"
                  value={row.name}
                  checked={source === row.name}
                  onChange={() => setSource(row.name)}
                  data-testid={`cgi-source-preset-${row.name}`}
                />
                {row.packagedConnector
                  ? t(
                      `${row.displayName}（已由打包的门接入）`,
                      `${row.displayName} (connected by a packaged gate)`,
                    )
                  : t(
                      `${row.displayName} — 平台自带的预设，只填地址`,
                      `${row.displayName} — a preset the platform ships; enter the address only`,
                    )}
              </label>
            ))}
            <label className="radio-option">
              <input
                type="radio"
                name="gateSource"
                value=""
                checked={source !== undefined && !waiting && preset === undefined}
                onChange={() => setSource(null)}
                data-testid="cgi-source-custom"
              />
              {t(
                '其他 http / mcp 系统 — 自己填目标和清单来源',
                'Another http / mcp system — enter its target and manifest source',
              )}
            </label>
          </div>
        </fieldset>
      ) : null}
      {waiting ? (
        <p className="text-3 text-small" style={{ margin: 0 }} data-testid="cgi-presets-loading">
          {t('正在读取接入预设…', 'Reading the connector presets…')}
        </p>
      ) : choosing ? (
        <div className="stack-s" data-testid="cgi-source-unchosen">
          <p className="text-3 text-small" style={{ margin: 0 }}>
            {t(
              '先选接入什么：平台自带预设的系统只要填地址；其他系统要自己填目标和清单来源。',
              'Choose what to connect first: a system the platform ships a preset for needs its address only; any other system needs its target and manifest source.',
            )}
          </p>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => guardedClose(onCancel)}>
              {t('取消', 'Cancel')}
            </Button>
          </div>
        </div>
      ) : preset ? (
        <PresetGateInstanceForm
          key={preset.name}
          http={http}
          preset={preset}
          onCreated={onCreated}
          onCancel={onCancel}
        />
      ) : (
        <>
          {fallbackNote !== null ? (
            <Notice tone="warn" testId="cgi-preset-unknown">
              {fallbackNote}
            </Notice>
          ) : null}
          <CustomGateInstanceForm http={http} onCreated={onCreated} onCancel={onCancel} />
        </>
      )}
    </div>
  );
}

/**
 * The form for any other system: `create_gate_instance` (P-B2a 决定 ⑥–⑬) — the
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
 * manifest field offers `<target>/openapi.json` as a one-click fill (never set silently) — never
 * for a target carrying a credential, and never with its query (review of #549). A target or
 * manifest source the kernel refuses for carrying a credential is said on that field, with the
 * kernel's own text in the field's collapsed 「技术细节」.
 */
function CustomGateInstanceForm({
  http,
  onCreated,
  onCancel,
}: Pick<CreateGateInstanceFormProps, 'http' | 'onCreated' | 'onCancel'>) {
  // Legacy 497: in a drawer whose form was edited, 取消 asks before discarding it.
  const guardedClose = useGuardedClose();
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
  const [connectorChoice, setConnectorChoice] = useState<ConnectorChoice>('system');
  const [connectorInput, setConnectorInput] = useState('');
  /** `true` once the administrator typed (or picked) a connector name; clearing it resumes
   *  derivation from the gate id. */
  const [connectorEdited, setConnectorEdited] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown | null>(null);
  const [refusal, setRefusal] = useState<AddressRefusal | null>(null);
  const targetInput = useRef<HTMLInputElement>(null);
  const manifestInput = useRef<HTMLInputElement>(null);
  // UX acceptance of #715 (P3-1): the field a refusal is said on takes the focus back once the form
  // is enabled again — submitting disabled it, which had dropped the focus to the page.
  useEffect(() => {
    if (refusal === null || submitting) return;
    (refusal.field === 'target' ? targetInput : manifestInput).current?.focus();
  }, [refusal, submitting]);
  const connectors = useConnectorsByName(http);

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
  const suggestedManifest = targetValid ? suggestedManifestSource(targetValue) : '';

  // P1: by default the instance gets a connector of its own, named after the gate id, so putting
  // it in the catalog never changes whether workspaces may connect http / mcp themselves — unless
  // the gate id extends an existing connector's name (legacy 396), which it then joins.
  const existingForGateId = gateIdValid
    ? existingConnectorFor(gateId, transportKind, connectors)
    : null;
  const systemConnector = connectorEdited
    ? connectorInput
    : gateIdValid
      ? (existingForGateId ?? gateId)
      : '';
  const connector = connectorChoice === 'generic' ? transportKind : systemConnector;
  const connectorProblem =
    connectorChoice === 'system' && systemConnector.length > 0
      ? connectorNameProblem(systemConnector, transportKind, connectors, t)
      : null;
  const connectorValid =
    connectorChoice === 'generic' || (systemConnector.length > 0 && connectorProblem === null);
  /** The connector the instance would join, when it exists already (same kind, not packaged). */
  const joinedConnector =
    connectorChoice === 'system' && connectorValid ? connectors?.get(systemConnector) : undefined;
  /** Other system connectors of this kind, offered as a one-click fill. */
  const sameKindConnectors =
    connectors === null
      ? []
      : [...connectors.values()]
          .filter(
            (row) =>
              !row.packaged &&
              !isGenericConnector(row.name) &&
              row.kind === transportKind &&
              row.name !== systemConnector,
          )
          .map((row) => row.name)
          .sort();
  const genericConnector = connectors?.get(transportKind);
  const ready = gateIdValid && targetValid && manifestSourceValid && connectorValid && !submitting;
  // DoD item 4: a disabled 创建 says what it still waits for (the field labels' own words).
  const missing = [
    gateIdValid
      ? null
      : gateId.length === 0
        ? t('填写名称或门 ID', 'enter a name or gate ID')
        : t('改正门 ID', 'fix the gate ID'),
    targetValid
      ? null
      : target.length === 0
        ? t('填写目标', 'enter the target')
        : t('改正目标地址', 'fix the target URL'),
    manifestSourceValid
      ? null
      : manifestSource.length === 0
        ? t('填写清单来源', 'enter the manifest source')
        : t('改正清单来源', 'fix the manifest source'),
    connectorValid
      ? null
      : systemConnector.length === 0
        ? t('填写接入包名称', 'enter the connector name')
        : t('改正接入包名称', 'fix the connector name'),
  ].filter((item): item is string => item !== null);

  function changeGateId(raw: string): void {
    const normalized = normalizeGateIdInput(raw);
    setGateIdAdjusted(normalized !== raw);
    setGateIdInput(normalized);
    setGateIdEdited(true);
  }

  function changeConnector(raw: string): void {
    setConnectorInput(normalizeGateIdInput(raw));
    setConnectorEdited(true);
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
      connector,
    };
    if (displayName.trim().length > 0) params.displayName = displayName.trim();
    if (transportKind === 'http' && manifestValue.length > 0) {
      params.manifestSource = manifestValue;
    }
    setTarget(targetValue);
    if (transportKind === 'http') setManifestSource(manifestValue);
    setSubmitting(true);
    setError(null);
    setRefusal(null);
    try {
      onCreated(await http.call<GateInstanceWire>('create_gate_instance', params));
    } catch (err) {
      const refused = addressRefusalOf(err);
      if (refused) setRefusal(refused);
      else setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  /** The refusal's explanation and 「技术细节」 when it is about `field`. */
  function refusalOn(field: AddressRefusal['field']) {
    if (refusal?.field !== field) return null;
    const shown = presentError(refusal.error, t);
    return {
      message:
        field === 'target'
          ? t(
              '目标地址里带了凭据（URL 里的用户名密码，或 token、key 之类的查询参数），已拒绝，什么也没创建：只写目标地址。共享凭证在实例创建后从实例详情里录入；按人方式由成员在工作区各自录入。',
              'The target carries a credential (a user name and password in the URL, or a token or key in its query) — refused, nothing was created. Enter only the address. A shared credential is entered from the instance’s details once it exists; per-member credentials are entered by each member in their workspace.',
            )
          : t(
              '清单来源里带了凭据（URL 里的用户名密码，或 token、key 之类的查询参数），已拒绝，什么也没创建：只写文档地址。门宿主读取清单时不带凭据，文档需要能直接访问。',
              'The manifest source carries a credential (a user name and password in the URL, or a token or key in its query) — refused, nothing was created. Enter only the document’s address; the gate host reads it without a credential, so it must be reachable as is.',
            ),
      details: (
        <ErrorDetails
          code={shown.code}
          raw={shown.raw}
          testId={field === 'target' ? 'cgi-target-error' : 'cgi-manifest-source-error'}
        />
      ),
    };
  }
  const targetRefusal = refusalOn('target');
  const manifestRefusal = refusalOn('manifestSource');

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
          '给人看的名称；下面的门 ID 会据此自动生成。',
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
        label={t('门 ID', 'Gate ID')}
        required
        hint={
          <>
            {t(
              '2–64 位小写字母、数字或连字符，以字母或数字开头，会成为它在门宿主上的路径（/i/<gateId>）。大写、下划线、空格和点会自动转换。',
              'Lowercase letters, digits and hyphens, 2–64 characters, starting with a letter or digit; it becomes the gate-host path (/i/<gateId>). Capitals, underscores, spaces and dots are converted for you.',
            )}
            {gateIdSource !== null ? (
              <span data-testid="cgi-gate-id-derived">
                {sentenceGap(t)}
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
                {sentenceGap(t)}
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
              <>
                {sentenceGap(t)}
                <span data-testid="cgi-target-scheme-note">{schemeNote}</span>
              </>
            ) : null}
          </>
        }
        error={
          targetRefusal?.message ??
          (target.length > 0 && !targetValid
            ? t(
                '需要一个完整的地址，例如 https://billing.example.com 或 https://billing.example.com:8443/api。',
                'Needs a full address, e.g. https://billing.example.com or https://billing.example.com:8443/api.',
              )
            : undefined)
        }
        errorDetails={targetRefusal?.details}
      >
        <Input
          ref={targetInput}
          id="cgi-target"
          value={target}
          onChange={(event) => {
            setTarget(event.target.value);
            setTargetSchemeAdded(false);
            if (refusal?.field === 'target') setRefusal(null);
          }}
          onBlur={completeTarget}
          disabled={submitting}
          invalid={targetRefusal !== null || (target.length > 0 && !targetValid)}
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
                <>
                  {sentenceGap(t)}
                  <span data-testid="cgi-manifest-scheme-note">{schemeNote}</span>
                </>
              ) : null}
            </>
          }
          error={
            manifestRefusal?.message ??
            (manifestSource.length > 0 && !manifestSourceValid
              ? t(
                  '需要一个完整的地址，例如 https://billing.example.com/openapi.json。',
                  'Needs a full address, e.g. https://billing.example.com/openapi.json.',
                )
              : undefined)
          }
          errorDetails={manifestRefusal?.details}
        >
          <Input
            ref={manifestInput}
            id="cgi-manifest-source"
            value={manifestSource}
            onChange={(event) => {
              setManifestSource(event.target.value);
              setManifestSchemeAdded(false);
              if (refusal?.field === 'manifestSource') setRefusal(null);
            }}
            onBlur={completeManifest}
            disabled={submitting}
            mono
            required
            invalid={
              manifestRefusal !== null || (manifestSource.length > 0 && !manifestSourceValid)
            }
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

      <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="field-label">{t('接入包', 'Connector')}</legend>
        <div className="radio-group" role="radiogroup" aria-label={t('接入包', 'Connector')}>
          <label className="radio-option">
            <input
              type="radio"
              name="connectorChoice"
              value="system"
              checked={connectorChoice === 'system'}
              onChange={() => setConnectorChoice('system')}
              disabled={submitting}
              data-testid="cgi-connector-system"
            />
            {t(
              '这个系统自己的接入包（推荐）— 设为平台预置不影响工作区自己接入',
              'A connector of its own for this system (recommended) — making it a platform preset leaves self-connections alone',
            )}
          </label>
          <label className="radio-option">
            <input
              type="radio"
              name="connectorChoice"
              value="generic"
              checked={connectorChoice === 'generic'}
              onChange={() => setConnectorChoice('generic')}
              disabled={submitting}
              data-testid="cgi-connector-generic"
            />
            {t(
              `通用接入包「${transportKind}」— 和工作区自己接入的 ${transportKind} 系统共用`,
              `The generic connector "${transportKind}" — shared with the ${transportKind} systems workspaces connect themselves`,
            )}
          </label>
        </div>
      </fieldset>

      {connectorChoice === 'system' ? (
        <Field
          id="cgi-connector"
          label={t('接入包名称', 'Connector name')}
          required
          hint={
            <>
              {t(
                '同一个系统的几个实例放进同一个接入包。',
                'Instances of one system share one connector.',
              )}
              {/* Legacy 395: the 「新的接入包…」 sentence only when a new one is made — next to
               *  the 「会加入它」 note below it contradicted itself. */}
              {joinedConnector ? null : (
                <span data-testid="cgi-connector-new">
                  {sentenceGap(t)}
                  {t(
                    '新的接入包是「平台预置」：实例启用后工作区就能在目录里看到它，工作区自己接入 http / mcp 系统不受影响。',
                    'A new connector is a platform preset: once the instance is enabled, workspaces see it in the catalog, and their own http / mcp connections are unaffected.',
                  )}
                </span>
              )}
              {!connectorEdited && systemConnector.length > 0 ? (
                <span data-testid="cgi-connector-derived">
                  {sentenceGap(t)}
                  {existingForGateId !== null
                    ? t(
                        '门 ID 以这个已有接入包的名字开头，已选中它，可直接修改。',
                        'The gate ID starts with this existing connector’s name, so it is picked — edit it if you like.',
                      )
                    : joinedConnector
                      ? // Legacy 402: a gate id equal to an existing connector's name joins it —
                        // 「自动生成」 would read as a new one.
                        t(
                          '门 ID 和这个已有接入包同名，已选中它，可直接修改。',
                          'The gate ID matches this existing connector’s name, so it is picked — edit it if you like.',
                        )
                      : t(
                          '已根据门 ID 自动生成，可直接修改。',
                          'Generated from the gate ID — edit it if you like.',
                        )}
                </span>
              ) : null}
              {joinedConnector ? (
                <span data-testid="cgi-connector-joins">
                  {sentenceGap(t)}
                  {t(
                    `接入包「${joinedConnector.name}」已有 ${joinedConnector.instanceCount} 个实例（${connectorModeLabel(joinedConnector.mode, t)}），这个实例会加入它。`,
                    `Connector "${joinedConnector.name}" already holds ${joinedConnector.instanceCount} instance(s) (${connectorModeLabel(joinedConnector.mode, t)}); this instance joins it.`,
                  )}
                </span>
              ) : null}
            </>
          }
          error={connectorProblem ?? undefined}
        >
          <Input
            id="cgi-connector"
            value={systemConnector}
            onChange={(event) => changeConnector(event.target.value)}
            onBlur={() => {
              if (connectorInput.length === 0) setConnectorEdited(false);
            }}
            disabled={submitting}
            invalid={connectorProblem !== null}
            mono
            placeholder="billing"
          />
          {sameKindConnectors.length > 0 ? (
            <div className="row-wrap" data-testid="cgi-connector-suggestions">
              <span className="text-3 text-small">
                {t(`已有的 ${transportKind} 接入包：`, `Existing ${transportKind} connectors:`)}
              </span>
              {sameKindConnectors.map((name) => (
                <Button
                  key={name}
                  variant="ghost"
                  size="s"
                  onClick={() => {
                    setConnectorInput(name);
                    setConnectorEdited(true);
                  }}
                  disabled={submitting}
                  data-testid={`cgi-connector-suggestion-${name}`}
                >
                  {name}
                </Button>
              ))}
            </div>
          ) : null}
        </Field>
      ) : genericConnector?.mode === 'platform_preset' ? (
        <p
          className="text-3 text-small"
          style={{ margin: 0 }}
          data-testid="cgi-connector-generic-note"
        >
          {t(
            `通用接入包「${transportKind}」已是平台预置：实例启用后工作区就能在目录里看到它；工作区现在本来就不能自己接入 ${transportKind} 系统。`,
            `The generic connector "${transportKind}" is already a platform preset: once enabled, workspaces see the instance in the catalog; they already cannot connect ${transportKind} systems themselves.`,
          )}
        </p>
      ) : (
        <Notice tone="warn" testId="cgi-connector-generic-note">
          {t(
            `工作区要在目录里看到这个实例，得把通用接入包「${transportKind}」设为平台预置；那样所有工作区都不能再自己接入 ${transportKind} 系统（已建立的连接不受影响）。不想这样，就选「这个系统自己的接入包」。`,
            `For workspaces to see this instance in the catalog, the generic connector "${transportKind}" must become a platform preset — then no workspace can connect ${transportKind} systems itself any more (existing connections are unaffected). To avoid that, choose "A connector of its own for this system".`,
          )}
        </Notice>
      )}

      <PlatformError
        error={error}
        title={t('无法新建门宿主实例', 'Could not create this instance')}
        testId="create-gate-instance-error"
      />

      <div className="row overlay-actions" style={{ justifyContent: 'flex-end' }}>
        <Button variant="ghost" onClick={() => guardedClose(onCancel)} disabled={submitting}>
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
        <StillNeeded items={missing} hidden={submitting} testId="create-gate-instance-missing" />
      </div>
    </form>
  );
}
