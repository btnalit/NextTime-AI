import type {
  LlmProviderApiKindWire,
  LlmProviderAuthHeaderWire,
  LlmProviderInputWire,
  LlmProviderModelDiscoveryResultWire,
  LlmProviderModelProbeOutcomeWire,
  LlmProviderWire,
} from '@nexttime/shared';
import { LLM_PROVIDER_PROBE_MAX_MODELS } from '@nexttime/shared';
import { type FormEvent, useMemo, useRef, useState } from 'react';
import { useT } from '../../../lib/i18n.js';
import {
  type LlmAdminClient,
  LlmAdminError,
  llmAdminErrorMessage,
} from '../../../lib/llm-admin.js';
import {
  PROVIDER_PRESETS,
  type ProviderPreset,
  defaultAuthHeader,
  envNameProblem,
  explainUpstreamError,
  guessApiKind,
  isHttpUrl,
  normalizeBaseUrl,
  normalizeEnvName,
  presetForBaseUrl,
  providerIdFromUrl,
  providerIdProblem,
  providerKeyProblem,
  slugifyProviderId,
} from '../../../lib/provider-form.js';
import { Button } from '../../ui/Button.js';
import { ErrorBanner } from '../../ui/ErrorBanner.js';
import { Field, Input, Select } from '../../ui/Field.js';
import { Icon } from '../../ui/Icon.js';
import { Notice } from '../../ui/Notice.js';

/** What the page does after the provider row itself is saved: set the typed key as the
 *  provider's console key, then run 测试调用. */
export interface ProviderFormExtras {
  /** The typed API key, trimmed; absent = leave the credential as it is. */
  readonly key?: string;
  readonly testAfterSave: boolean;
}

export interface ProviderFormProps {
  /** Editing an existing row (id locked) or creating a new one. */
  readonly initial?: LlmProviderWire;
  /** For 「从供应商获取模型」. */
  readonly client: Pick<LlmAdminClient, 'discoverModels' | 'probeModels'>;
  /** Ids already taken — a create form flags a clash before the round trip. */
  readonly existingIds?: readonly string[];
  readonly onSubmit: (input: LlmProviderInputWire, extras: ProviderFormExtras) => Promise<void>;
  readonly onCancel: () => void;
}

const API_KINDS: ReadonlyArray<{
  value: LlmProviderApiKindWire;
  labelZh: string;
  labelEn: string;
  path: string;
}> = [
  {
    value: 'openai-completions',
    labelZh: 'OpenAI 兼容 · chat/completions（OpenAI、DeepSeek、OpenRouter、各类中转…）',
    labelEn: 'OpenAI-compatible · chat/completions (OpenAI, DeepSeek, OpenRouter, relays…)',
    path: '/v1/chat/completions',
  },
  {
    value: 'openai-responses',
    labelZh: 'OpenAI 兼容 · responses 接口',
    labelEn: 'OpenAI-compatible · responses',
    path: '/v1/responses',
  },
  {
    value: 'anthropic-messages',
    labelZh: 'Anthropic · messages',
    labelEn: 'Anthropic · messages',
    path: '/v1/messages',
  },
];

interface ModelRowDraft {
  readonly key: number;
  readonly id: string;
  readonly displayName: string;
}

type Discovery =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready';
      readonly result: LlmProviderModelDiscoveryResultWire;
      /** The (api, base URL, header, credential) the list was fetched for. */
      readonly fingerprint: string;
    }
  | { readonly status: 'error'; readonly error: unknown };

/** One model's 「验证」 state, keyed by `${fingerprint}|${modelId}` so a changed address or key
 *  hides results that no longer apply. */
type Probe =
  | { readonly status: 'loading' }
  | { readonly status: 'done'; readonly outcome: LlmProviderModelProbeOutcomeWire }
  | { readonly status: 'error'; readonly error: unknown };

/** A short marker for "which credential" without keeping a second copy of the key around. */
function credentialMarker(key: string, envName: string): string {
  const typed = key.trim();
  if (typed.length > 0) return `k:${typed.length}:${typed.slice(-4)}`;
  return envName.length > 0 ? `e:${envName}` : 'stored';
}

/**
 * components/platform/providers/ProviderForm: 新增 / 编辑 LLM 供应商 (S6-B, docs/console-completion-
 * plan.md §5.4; S7-A console keys). Produces exactly the `LlmProviderInputWire` llm-proxy validates
 * plus the extras the page applies after the row is saved — the typed key (set as this provider's
 * console key through `PUT /providers/:id/secret`, never part of the provider row) and whether to
 * run 测试调用 right away.
 *
 * What the form does for the administrator instead of refusing input:
 *   - quick picks for vendors whose endpoint fits the proxy's `<base>/v1/…` rule (lib/provider-
 *     form.ts `PROVIDER_PRESETS`) fill the API kind, Base URL and auth header;
 *   - the id follows the name (or the host) until it is typed by hand;
 *   - a pasted endpoint (`…/v1/chat/completions`, no scheme, trailing slash) becomes the bare base
 *     on blur, and the field shows the exact URL the proxy will call;
 *   - the env var name is normalized as typed (`deepseek-api-key` → `DEEPSEEK_API_KEY`,
 *     `export X=…` → `X`), and a key pasted there is moved to the key field;
 *   - 「从供应商获取模型」 lists the upstream's real model ids (llm-proxy `POST /model-discovery`,
 *     run automatically once a key is entered), and every typed id is checked against that list;
 *   - the submit button says what is still missing instead of being silently disabled.
 */
/** True when the proxy relayed the provider's own 401 / 403 — the key itself was refused. */
function rejectedCredential(error: unknown): boolean {
  if (!(error instanceof LlmAdminError) || error.code !== 'upstream_error') return false;
  const details = error.details;
  const status =
    typeof details === 'object' && details !== null && 'status' in details
      ? (details as { status: unknown }).status
      : null;
  return status === 401 || status === 403;
}

/** True when the failure looks like a relay without a model list (404 / 405 / 501, or a body that
 *  is not a model list) — the only case where "type the model ids instead" is the right advice.
 *  A refused key (401 / 403), a rate limit or an unreachable upstream must not suggest it. */
function relayMayNotListModels(error: unknown): boolean {
  if (!(error instanceof LlmAdminError)) return false;
  if (error.code === 'upstream_invalid_response') return true;
  if (error.code !== 'upstream_error') return false;
  const details = error.details;
  const status =
    typeof details === 'object' && details !== null && 'status' in details
      ? (details as { status: unknown }).status
      : null;
  return status === 404 || status === 405 || status === 501;
}

export function ProviderForm({
  initial,
  client,
  existingIds = [],
  onSubmit,
  onCancel,
}: ProviderFormProps) {
  const t = useT();
  const editing = initial !== undefined;
  const [presetKey, setPresetKey] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState(initial?.displayName ?? '');
  const [id, setId] = useState(initial?.id ?? '');
  const [idTouched, setIdTouched] = useState(editing);
  const [api, setApi] = useState<LlmProviderApiKindWire>(initial?.api ?? 'openai-completions');
  const [apiTouched, setApiTouched] = useState(editing);
  const [baseUrl, setBaseUrl] = useState(initial?.upstreamBaseUrl ?? '');
  const [baseNote, setBaseNote] = useState<'none' | 'scheme-added' | 'suffix-stripped' | 'both'>(
    'none',
  );
  const [authHeader, setAuthHeader] = useState<LlmProviderAuthHeaderWire>(
    initial?.authHeader ?? 'authorization',
  );
  const [key, setKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [apiKeyEnv, setApiKeyEnv] = useState(initial?.apiKeyEnv ?? '');
  const [envNote, setEnvNote] = useState<'none' | 'normalized' | 'value-dropped' | 'secret'>(
    'none',
  );
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [models, setModels] = useState<ModelRowDraft[]>(() =>
    initial && initial.models.length > 0
      ? initial.models.map((m, index) => ({
          key: index,
          id: m.id,
          displayName: m.displayName ?? '',
        }))
      : [{ key: 0, id: '', displayName: '' }],
  );
  const nextKey = useRef(models.length);
  const [discovery, setDiscovery] = useState<Discovery>({ status: 'idle' });
  const [probes, setProbes] = useState<Readonly<Record<string, Probe>>>({});
  const [filter, setFilter] = useState('');
  const [testAfterSave, setTestAfterSave] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const normalizedBase = normalizeBaseUrl(baseUrl).value;
  const preset: ProviderPreset | undefined =
    PROVIDER_PRESETS.find((p) => p.key === presetKey) ?? presetForBaseUrl(normalizedBase);
  const urlValid = isHttpUrl(normalizedBase);
  const apiPath = API_KINDS.find((kind) => kind.value === api)?.path ?? '/v1';

  const idTrimmed = id.trim();
  const idProblem = editing
    ? null
    : (providerIdProblem(idTrimmed, t) ??
      (existingIds.includes(idTrimmed)
        ? t(`已有 id 为「${idTrimmed}」的供应商，换一个`, `A provider "${idTrimmed}" exists`)
        : null));
  const envProblem = envNameProblem(apiKeyEnv, t);

  const modelIds = models.map((m) => m.id.trim()).filter((v) => v.length > 0);
  const duplicateIds = modelIds.filter((v, i) => modelIds.indexOf(v) !== i);

  const storedCredential = editing && initial.credentialPresent;
  const upstreamChanged =
    editing && normalizedBase.toLowerCase() !== initial.upstreamBaseUrl.toLowerCase();
  const keyProblem = providerKeyProblem(key, t);
  const hasTypedKey = key.trim().length > 0 && keyProblem === null;
  const canDiscover =
    urlValid &&
    !submitting &&
    (hasTypedKey ||
      (apiKeyEnv.length > 0 && !envProblem) ||
      (storedCredential && !upstreamChanged));
  const fingerprint = `${api}|${normalizedBase}|${authHeader}|${credentialMarker(key, apiKeyEnv)}`;
  const discovered = discovery.status === 'ready' ? discovery.result.models : null;
  const discoveredIds = useMemo(() => new Set((discovered ?? []).map((m) => m.id)), [discovered]);
  const discoveryStale = discovery.status === 'ready' && discovery.fingerprint !== fingerprint;
  // The provider refused this credential while listing models (401 / 403): probing models with it
  // would only spend calls on the same refusal, so ticking or typing a model does not probe until
  // the key changes (the next listing replaces this state). 「验证所选模型」 still runs on request.
  const keyRejected = discovery.status === 'error' && rejectedCredential(discovery.error);
  // A credential will resolve after saving: a typed key, an env var name (the proxy reports
  // whether it is actually set), or the provider's existing credential on the same upstream.
  const credentialAfterSave =
    hasTypedKey || apiKeyEnv.length > 0 || (storedCredential && !upstreamChanged);

  const missing: string[] = [];
  if (!editing && idProblem) missing.push(t('有效的 id', 'a valid id'));
  if (!urlValid) missing.push('Base URL');
  if (envProblem) missing.push(t('合法的环境变量名', 'a valid env var name'));
  if (keyProblem) missing.push(t('格式正确的密钥', 'a well-formed key'));
  if (modelIds.length === 0) missing.push(t('至少一个模型', 'at least one model'));
  if (duplicateIds.length > 0) missing.push(t('去掉重复的模型', 'no duplicate models'));
  const ready = missing.length === 0 && !submitting;

  function applyPreset(next: ProviderPreset): void {
    setPresetKey(next.key);
    setDisplayName(next.displayName);
    if (!idTouched) setId(next.id);
    setApi(next.api);
    setApiTouched(true);
    setAuthHeader(defaultAuthHeader(next.api));
    setBaseUrl(next.upstreamBaseUrl);
    setBaseNote('none');
    setDiscovery({ status: 'idle' });
  }

  function changeDisplayName(value: string): void {
    setDisplayName(value);
    if (!idTouched && !editing) {
      setId(slugifyProviderId(value) || providerIdFromUrl(normalizedBase));
    }
  }

  function chooseApi(next: LlmProviderApiKindWire): void {
    setApi(next);
    setApiTouched(true);
    setAuthHeader(defaultAuthHeader(next));
  }

  function commitBaseUrl(): void {
    const normalized = normalizeBaseUrl(baseUrl);
    setBaseUrl(normalized.value);
    setBaseNote(normalized.changed);
    if (!apiTouched) {
      const guessed = guessApiKind(normalized.value);
      if (guessed) {
        setApi(guessed);
        setAuthHeader(defaultAuthHeader(guessed));
      }
    }
    if (!idTouched && !editing && slugifyProviderId(displayName).length === 0) {
      setId(providerIdFromUrl(normalized.value));
    }
  }

  function changeEnvName(raw: string): void {
    const normalized = normalizeEnvName(raw);
    if (normalized.note === 'secret') {
      // The key itself was pasted here — move it where it belongs instead of upper-casing it.
      setKey(raw.trim());
      setApiKeyEnv('');
      setEnvNote('secret');
      return;
    }
    setApiKeyEnv(normalized.value);
    setEnvNote(normalized.note);
  }

  function addModelRow(modelId = '', name = ''): void {
    const rowKey = nextKey.current;
    nextKey.current += 1;
    setModels((rows) => [...rows, { key: rowKey, id: modelId, displayName: name }]);
  }

  function toggleDiscovered(modelId: string, name: string | null): void {
    const ticking = !models.some((row) => row.id.trim() === modelId);
    if (ticking && !probeFor(modelId) && !keyRejected) void probe([modelId]);
    setModels((rows) => {
      if (rows.some((row) => row.id.trim() === modelId)) {
        return rows.filter((row) => row.id.trim() !== modelId);
      }
      const rowKey = nextKey.current;
      nextKey.current += 1;
      // Fill the first empty manual row before adding a new one.
      const emptyIndex = rows.findIndex((row) => row.id.trim().length === 0);
      const added = { key: rowKey, id: modelId, displayName: name ?? '' };
      if (emptyIndex >= 0) return rows.map((row, i) => (i === emptyIndex ? added : row));
      return [...rows, added];
    });
  }

  function updateModel(rowKey: number, patch: Partial<ModelRowDraft>): void {
    setModels((rows) => rows.map((row) => (row.key === rowKey ? { ...row, ...patch } : row)));
  }

  /** The upstream + credential fields `/model-discovery` and `/model-probe` share. */
  function upstreamRequest() {
    return {
      id: idTrimmed.length > 0 && !providerIdProblem(idTrimmed, t) ? idTrimmed : 'new-provider',
      api,
      upstreamBaseUrl: normalizedBase,
      authHeader,
      ...(hasTypedKey ? { key: key.trim() } : {}),
      ...(!hasTypedKey && apiKeyEnv.length > 0 && !envProblem ? { apiKeyEnv } : {}),
    };
  }

  /** Runs the provider test (completion + tool call) against `ids` with the form's own upstream
   *  and credential — automatically when a model is ticked or typed, or for every picked model
   *  from 「验证所选模型」. */
  async function probe(ids: readonly string[]): Promise<void> {
    const wanted = [...new Set(ids.map((v) => v.trim()).filter((v) => v.length > 0))].slice(
      0,
      LLM_PROVIDER_PROBE_MAX_MODELS,
    );
    if (!canDiscover || wanted.length === 0) return;
    const requestFingerprint = fingerprint;
    setProbes((prev) => {
      const next = { ...prev };
      for (const model of wanted) next[`${requestFingerprint}|${model}`] = { status: 'loading' };
      return next;
    });
    try {
      const result = await client.probeModels({ ...upstreamRequest(), models: wanted });
      setProbes((prev) => {
        const next = { ...prev };
        for (const outcome of result.results) {
          next[`${requestFingerprint}|${outcome.model}`] = { status: 'done', outcome };
        }
        return next;
      });
    } catch (err) {
      setProbes((prev) => {
        const next = { ...prev };
        for (const model of wanted)
          next[`${requestFingerprint}|${model}`] = { status: 'error', error: err };
        return next;
      });
    }
  }

  function probeFor(modelId: string): Probe | undefined {
    return probes[`${fingerprint}|${modelId.trim()}`];
  }

  async function discover(): Promise<void> {
    if (!canDiscover) return;
    const base = normalizeBaseUrl(baseUrl).value;
    setBaseUrl(base);
    const requestFingerprint = fingerprint;
    setDiscovery({ status: 'loading' });
    try {
      const result = await client.discoverModels({ ...upstreamRequest(), upstreamBaseUrl: base });
      setDiscovery({ status: 'ready', result, fingerprint: requestFingerprint });
      setFilter('');
      if (result.models.length > 0 && result.models.length <= 3 && modelIds.length === 0) {
        // A short list (a single-model relay, a fine-tune endpoint): take all of it, in place of
        // the empty starter row.
        setModels(
          result.models.map((model) => {
            const rowKey = nextKey.current;
            nextKey.current += 1;
            return { key: rowKey, id: model.id, displayName: model.displayName ?? '' };
          }),
        );
        void probe(result.models.map((model) => model.id));
      }
    } catch (err) {
      setDiscovery({ status: 'error', error: err });
    }
  }

  function maybeAutoDiscover(): void {
    // Once per (upstream, credential): entering a key is the natural moment to fetch the list.
    if (!hasTypedKey || !canDiscover || discovery.status === 'loading') return;
    if (discovery.status === 'ready' && discovery.fingerprint === fingerprint) return;
    void discover();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!ready) return;
    const base = normalizeBaseUrl(baseUrl).value;
    const input: LlmProviderInputWire = {
      id: idTrimmed,
      ...(displayName.trim().length > 0 ? { displayName: displayName.trim() } : {}),
      api,
      upstreamBaseUrl: base,
      authHeader,
      authScheme: authHeader === 'authorization' ? 'Bearer' : null,
      ...(apiKeyEnv.length > 0 ? { apiKeyEnv } : {}),
      models: models
        .filter((m) => m.id.trim().length > 0)
        .map((m) => {
          const existing = initial?.models.find((row) => row.id === m.id.trim());
          return {
            id: m.id.trim(),
            displayName: m.displayName.trim().length > 0 ? m.displayName.trim() : null,
            cost: existing?.cost ?? null,
          };
        }),
      enabled,
    };
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(input, {
        ...(hasTypedKey ? { key: key.trim() } : {}),
        testAfterSave: testAfterSave && credentialAfterSave && enabled,
      });
      setKey('');
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  const mapped = llmAdminErrorMessage(error, t);
  const discoveryError = discovery.status === 'error' ? discovery.error : null;
  const discoveryErrorText = discoveryError ? llmAdminErrorMessage(discoveryError, t) : null;
  const discoveryExplain =
    discoveryError instanceof LlmAdminError
      ? explainUpstreamError(discoveryError.message, t)
      : null;
  const filterLower = filter.trim().toLowerCase();
  const visibleDiscovered = (discovered ?? []).filter(
    (m) =>
      filterLower.length === 0 ||
      m.id.toLowerCase().includes(filterLower) ||
      (m.displayName ?? '').toLowerCase().includes(filterLower),
  );
  const selectedSet = new Set(modelIds);

  return (
    <form
      className="stack provider-form"
      onSubmit={(event) => void handleSubmit(event)}
      noValidate
      data-testid="provider-form"
    >
      {editing && initial.source === 'file' ? (
        <Notice testId="provider-form-override-notice">
          {t(
            '这是主机 llm-providers.yaml 里的供应商；保存会在代理的存储里建一条覆盖记录，yaml 本身不改。',
            'This provider comes from llm-providers.yaml on the host — saving creates an override in the proxy’s store; the yaml itself is not modified.',
          )}
        </Notice>
      ) : null}

      {editing ? null : (
        <div className="field" data-testid="provider-presets">
          <span className="field-label">{t('快速选择', 'Quick pick')}</span>
          <div className="provider-presets">
            {PROVIDER_PRESETS.map((item) => (
              <button
                key={item.key}
                type="button"
                className="provider-preset"
                aria-pressed={presetKey === item.key}
                onClick={() => applyPreset(item)}
                disabled={submitting}
                data-testid={`provider-preset-${item.key}`}
              >
                {item.displayName}
              </button>
            ))}
          </div>
          <p className="field-hint">
            {t(
              '选一个会自动填好 API 种类、Base URL 和鉴权头；其他兼容 OpenAI 的服务或中转直接在下面填。',
              'Fills the API kind, Base URL and auth header; any other OpenAI-compatible service or relay goes below.',
            )}
          </p>
        </div>
      )}

      <div className="provider-form-grid">
        <Field id="provider-display-name" label={t('名称', 'Display name')}>
          <Input
            id="provider-display-name"
            value={displayName}
            onChange={(event) => changeDisplayName(event.target.value)}
            disabled={submitting}
            placeholder={t('如 DeepSeek', 'e.g. DeepSeek')}
            autoFocus={!editing}
            data-testid="provider-display-name"
          />
        </Field>

        <Field
          id="provider-id"
          label="Id"
          required
          hint={
            editing
              ? t('id 创建后不能改。', 'The id cannot change after creation.')
              : t(
                  `跟随名称自动生成，也可以自己改；路由为 /${idTrimmed || '<id>'}/v1。`,
                  `Follows the name unless you edit it; routed as /${idTrimmed || '<id>'}/v1.`,
                )
          }
          error={!editing && (idTouched || id.length > 0) && idProblem ? idProblem : undefined}
        >
          <Input
            id="provider-id"
            value={id}
            onChange={(event) => {
              setIdTouched(true);
              // Live form of slugifyProviderId: keeps a trailing hyphen so one can be typed.
              setId(
                event.target.value
                  .toLowerCase()
                  .replace(/[\s_.:/]+/g, '-')
                  .replace(/[^a-z0-9-]/g, '')
                  .slice(0, 63),
              );
            }}
            disabled={editing || submitting}
            mono
            aria-invalid={!editing && id.length > 0 && idProblem !== null}
            data-testid="provider-id"
          />
        </Field>
      </div>

      <Field id="provider-api" label={t('API 种类', 'API kind')} required>
        <Select
          id="provider-api"
          value={api}
          onChange={(event) => chooseApi(event.target.value as LlmProviderApiKindWire)}
          disabled={submitting}
          data-testid="provider-api"
        >
          {API_KINDS.map((kind) => (
            <option key={kind.value} value={kind.value}>
              {t(kind.labelZh, kind.labelEn)}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        id="provider-base-url"
        label="Base URL"
        required
        hint={
          urlValid ? (
            <span data-testid="provider-base-url-preview">
              {baseNote === 'suffix-stripped' || baseNote === 'both'
                ? t('已去掉末尾的 /v1 等路径（代理会自己拼）。', 'Trailing /v1 path removed. ')
                : null}
              {baseNote === 'scheme-added' || baseNote === 'both'
                ? t('已补上 https://。', 'https:// added. ')
                : null}
              {t('代理实际请求：', 'The proxy calls: ')}
              <span className="mono">
                {normalizedBase}
                {apiPath}
              </span>
            </span>
          ) : (
            t(
              '供应商的地址，可以直接粘贴文档里的完整接口地址，会自动整理成源站。',
              'Paste the provider’s endpoint as documented — it is trimmed to the origin.',
            )
          )
        }
        error={
          baseUrl.trim().length > 0 && !urlValid
            ? t(
                '不是有效的网址，例如 https://api.deepseek.com',
                'Not a valid URL, e.g. https://api.deepseek.com',
              )
            : undefined
        }
      >
        <Input
          id="provider-base-url"
          value={baseUrl}
          onChange={(event) => {
            setBaseUrl(event.target.value);
            setBaseNote('none');
          }}
          onBlur={commitBaseUrl}
          disabled={submitting}
          mono
          inputMode="url"
          placeholder="https://api.example.com"
          data-testid="provider-base-url"
        />
      </Field>
      {upstreamChanged && initial?.credentialSource === 'console' ? (
        <Notice tone="warn" testId="provider-upstream-change-notice">
          {t(
            'Base URL 变了：保存时代理会清除原来的控制台密钥（密钥只发往它录入时的上游）。请在下面重新填写这个上游的密钥。',
            'The Base URL changed — saving clears the stored console key (a key only goes to the upstream it was entered for). Enter the key for the new upstream below.',
          )}
        </Notice>
      ) : null}

      <Field
        id="provider-key"
        label={t('API 密钥', 'API key')}
        error={keyProblem ?? undefined}
        hint={
          editing && initial.credentialSource === 'console' && !upstreamChanged
            ? t(
                '已设置控制台密钥；留空保持不变，填写则更换。',
                'A console key is set — leave blank to keep it, type to replace it.',
              )
            : t(
                `只写不读：保存后存进代理自己的状态目录，从不回显。${preset ? `获取：${preset.keyHint}` : ''}`,
                `Write-only — held in the proxy’s own state directory, never shown again.${preset ? ` Get one at ${preset.keyHint}` : ''}`,
              )
        }
      >
        <div className="input-group">
          <Input
            id="provider-key"
            type={showKey ? 'text' : 'password'}
            value={key}
            onChange={(event) => {
              setKey(event.target.value);
              if (envNote === 'secret') setEnvNote('none');
            }}
            onBlur={maybeAutoDiscover}
            autoComplete="new-password"
            spellCheck={false}
            disabled={submitting}
            mono
            placeholder={
              editing && initial.credentialSource === 'console' && !upstreamChanged
                ? '••••••••'
                : 'sk-…'
            }
            data-testid="provider-key"
          />
          <Button
            variant="ghost"
            size="s"
            icon={showKey ? 'eye-off' : 'eye'}
            iconOnly
            aria-label={showKey ? t('隐藏密钥', 'Hide key') : t('显示密钥', 'Show key')}
            onClick={() => setShowKey((v) => !v)}
            disabled={submitting}
          />
        </div>
      </Field>
      {envNote === 'secret' ? (
        <Notice testId="provider-env-was-secret">
          {t(
            '刚才粘进「环境变量名」的看起来是密钥本身，已移到「API 密钥」里（不会显示在环境变量栏）。',
            'What was pasted into the env var field looks like the key itself — it was moved to the API key field.',
          )}
        </Notice>
      ) : null}

      <details
        className="disclosure"
        open={editing && initial.credentialSource === 'env' ? true : undefined}
        data-testid="provider-env-disclosure"
      >
        <summary>
          <Icon name="chevron-right" size="s" className="icon-chevron" />
          {t('改用主机环境变量提供密钥（可选）', 'Use a host env var instead (optional)')}
        </summary>
        <div className="disclosure-body">
          <Field
            id="provider-api-key-env"
            label={t('环境变量名', 'Env var name')}
            hint={
              envNote === 'value-dropped'
                ? t(
                    '只保留了变量名，等号后的值已丢弃——值只能写在主机上。',
                    'Only the name was kept; the value after "=" was dropped — values live on the host only.',
                  )
                : t(
                    `只填变量名，会自动转成大写和下划线。值由操作员写进主机 secrets/llm-proxy.env（${apiKeyEnv || preset?.apiKeyEnv || 'NAME'}=<密钥>）后重建 llm-proxy。上面填了 API 密钥就不需要它；两者都有时控制台密钥优先。`,
                    `The name only, upper-cased automatically. The operator puts ${apiKeyEnv || preset?.apiKeyEnv || 'NAME'}=<key> in secrets/llm-proxy.env and recreates llm-proxy. Not needed when an API key is entered above; the console key wins when both exist.`,
                  )
            }
            error={envProblem ?? undefined}
          >
            <Input
              id="provider-api-key-env"
              value={apiKeyEnv}
              onChange={(event) => changeEnvName(event.target.value)}
              disabled={submitting}
              mono
              autoComplete="off"
              spellCheck={false}
              placeholder={preset?.apiKeyEnv ?? 'EXAMPLE_API_KEY'}
              data-testid="provider-api-key-env"
            />
          </Field>
        </div>
      </details>

      <fieldset className="field provider-models" data-testid="provider-models">
        <legend className="field-label">
          {t('模型', 'Models')}{' '}
          <span className="field-required" aria-hidden>
            *
          </span>
        </legend>
        <div className="row-wrap">
          <Button
            variant="secondary"
            size="s"
            icon="refresh"
            onClick={() => void discover()}
            loading={discovery.status === 'loading'}
            disabled={!canDiscover || discovery.status === 'loading'}
            data-testid="provider-discover"
          >
            {discovery.status === 'ready'
              ? t('重新获取', 'Fetch again')
              : t('从供应商获取模型', 'Fetch models from the provider')}
          </Button>
          <span className="text-small text-3" data-testid="provider-discover-status">
            {!urlValid
              ? t('先填 Base URL。', 'Enter the Base URL first.')
              : !canDiscover
                ? t(
                    '填写 API 密钥（或环境变量名）后即可获取。',
                    'Enter the API key (or an env var name) to fetch.',
                  )
                : discovery.status === 'ready'
                  ? discoveryStale
                    ? t('地址或密钥改了，建议重新获取。', 'Address or key changed — fetch again.')
                    : t(
                        `供应商列出 ${discovery.result.models.length} 个模型${discovery.result.truncated ? '（仅显示前 500 个）' : ''}，勾选要用的。`,
                        `${discovery.result.models.length} models listed${discovery.result.truncated ? ' (first 500 shown)' : ''} — tick the ones to use.`,
                      )
                  : t(
                      '会用上面的密钥调用一次供应商的模型列表接口，不保存任何东西。',
                      'Calls the provider’s model list once with the key above; nothing is saved.',
                    )}
          </span>
        </div>

        {discoveryError !== null ? (
          <div className="field-error" role="alert" data-testid="provider-discover-error">
            {discoveryErrorText ??
              (discoveryError instanceof Error ? discoveryError.message : String(discoveryError))}
            {discoveryExplain ? <div className="text-2">{discoveryExplain}</div> : null}
            {relayMayNotListModels(discoveryError) ? (
              <div className="text-2" data-testid="provider-discover-manual-hint">
                {t(
                  '有些中转不提供模型列表：可以在下面手动填写模型 id。',
                  'Some relays do not list models — type the model ids below instead.',
                )}
              </div>
            ) : null}
          </div>
        ) : null}

        {(discoveryError !== null || (discovered && discovered.length === 0)) &&
        preset &&
        preset.suggestedModels.length > 0 ? (
          <div className="provider-model-picker" data-testid="provider-model-suggestions">
            <span className="text-small text-2">
              {keyRejected
                ? t(
                    `${preset.displayName} 的常用模型（预设建议）。供应商拒绝了这把密钥，勾选不会自动验证——先修正密钥：`,
                    `Common ${preset.displayName} models (suggestions). The provider refused this key, so ticking one does not check it — fix the key first:`,
                  )
                : t(
                    `${preset.displayName} 的常用模型（预设建议，未用你的密钥核验——勾选后会自动验证）：`,
                    `Common ${preset.displayName} models (suggestions, not checked with your key — ticking one checks it):`,
                  )}
            </span>
            <ul className="provider-model-options">
              {preset.suggestedModels.map((modelId) => (
                <li key={modelId}>
                  <label className="provider-model-option">
                    <input
                      type="checkbox"
                      checked={selectedSet.has(modelId)}
                      onChange={() => toggleDiscovered(modelId, null)}
                      disabled={submitting}
                      data-testid="provider-model-suggestion"
                    />
                    <span className="mono">{modelId}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {discovered && discovered.length > 0 ? (
          <div className="provider-model-picker" data-testid="provider-model-picker">
            {discovered.length > 8 ? (
              <Input
                aria-label={t('筛选模型', 'Filter models')}
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder={t('筛选，如 sonnet / gpt-4.1 / chat', 'Filter, e.g. sonnet / gpt-4.1')}
                data-testid="provider-model-filter"
              />
            ) : null}
            <ul className="provider-model-options">
              {visibleDiscovered.map((model) => (
                <li key={model.id}>
                  <label className="provider-model-option">
                    <input
                      type="checkbox"
                      checked={selectedSet.has(model.id)}
                      onChange={() => toggleDiscovered(model.id, model.displayName)}
                      disabled={submitting}
                      data-testid="provider-model-option"
                    />
                    <span className="mono">{model.id}</span>
                    {model.displayName ? (
                      <span className="text-3 truncate">{model.displayName}</span>
                    ) : null}
                  </label>
                </li>
              ))}
              {visibleDiscovered.length === 0 ? (
                <li className="text-small text-3">{t('没有匹配的模型。', 'No model matches.')}</li>
              ) : null}
            </ul>
          </div>
        ) : discovered && discovered.length === 0 ? (
          <p className="text-small text-3">
            {t(
              '供应商返回了空的模型列表，请手动填写模型 id。',
              'The provider listed no models — type the model ids below.',
            )}
          </p>
        ) : null}

        <div className="stack-s">
          {modelIds.length > 0 ? (
            <div className="row-wrap">
              <span className="text-small text-2">
                {t(`已选 ${modelIds.length} 个模型`, `${modelIds.length} selected`)}
              </span>
              <Button
                variant="secondary"
                size="s"
                onClick={() => void probe(modelIds)}
                disabled={!canDiscover || modelIds.some((m) => probeFor(m)?.status === 'loading')}
                data-testid="provider-probe-selected"
              >
                {t('验证所选模型', 'Check the picked models')}
              </Button>
              <span className="text-small text-3">
                {canDiscover
                  ? t(
                      `每个模型测一次对话和一次工具调用（一次至多 ${LLM_PROVIDER_PROBE_MAX_MODELS} 个），不保存任何东西。`,
                      `One chat and one tool call per model (up to ${LLM_PROVIDER_PROBE_MAX_MODELS} at a time); nothing is saved.`,
                    )
                  : t('填写 API 密钥后可验证。', 'Enter the API key to check them.')}
              </span>
            </div>
          ) : null}
          {models.map((row, index) => {
            const trimmed = row.id.trim();
            const unlisted =
              discovered !== null && trimmed.length > 0 && !discoveredIds.has(trimmed);
            const duplicate = trimmed.length > 0 && duplicateIds.includes(trimmed);
            return (
              <div className="stack-s" key={row.key}>
                <div className="row provider-model-row" data-testid="provider-model-row">
                  <Input
                    aria-label={t(`模型 ${index + 1} 的 id`, `Model ${index + 1} id`)}
                    value={row.id}
                    onChange={(event) => updateModel(row.key, { id: event.target.value })}
                    onBlur={() => {
                      updateModel(row.key, { id: row.id.trim() });
                      if (trimmed.length > 0 && !probeFor(trimmed) && !keyRejected)
                        void probe([trimmed]);
                    }}
                    disabled={submitting}
                    mono
                    placeholder={t('模型 id，如 deepseek-chat', 'model id, e.g. deepseek-chat')}
                    aria-invalid={duplicate || undefined}
                    data-testid="provider-model-id"
                  />
                  <Input
                    aria-label={t(`模型 ${index + 1} 的显示名`, `Model ${index + 1} display name`)}
                    value={row.displayName}
                    onChange={(event) => updateModel(row.key, { displayName: event.target.value })}
                    disabled={submitting}
                    placeholder={t('显示名（可选）', 'Display name (optional)')}
                    data-testid="provider-model-display-name"
                  />
                  <Button
                    variant="ghost"
                    size="s"
                    icon="close"
                    iconOnly
                    aria-label={t(`移除模型 ${index + 1}`, `Remove model ${index + 1}`)}
                    disabled={submitting}
                    onClick={() => setModels((rows) => rows.filter((r) => r.key !== row.key))}
                  />
                </div>
                {duplicate ? (
                  <p className="field-error">{t('这个 id 重复了', 'Duplicate id')}</p>
                ) : unlisted && probeFor(trimmed)?.status !== 'done' ? (
                  <p
                    className="field-hint provider-model-unlisted"
                    data-testid="provider-model-unlisted"
                  >
                    {t(
                      '供应商的模型列表里没有这个 id——检查拼写；中转的别名可以保留，验证一下就知道能不能用。',
                      'Not in the provider’s list — check the spelling; a relay alias may still work, check it to find out.',
                    )}
                  </p>
                ) : null}
                {trimmed.length > 0 ? <ModelProbeStatus probe={probeFor(trimmed)} /> : null}
              </div>
            );
          })}
          <div>
            <Button
              variant="ghost"
              size="s"
              icon="plus"
              disabled={submitting}
              onClick={() => addModelRow()}
              data-testid="provider-model-add"
            >
              {t('手动添加模型', 'Add a model by id')}
            </Button>
          </div>
        </div>
      </fieldset>

      <details className="disclosure" data-testid="provider-advanced">
        <summary>
          <Icon name="chevron-right" size="s" className="icon-chevron" />
          {t('高级：鉴权头', 'Advanced: auth header')}
        </summary>
        <div className="disclosure-body">
          <Field
            id="provider-auth-header"
            label={t('鉴权头', 'Auth header')}
            hint={t(
              '已按 API 种类自动选好；只有接口要求另一种时才改。',
              'Chosen from the API kind; change it only if the endpoint wants the other one.',
            )}
          >
            <Select
              id="provider-auth-header"
              value={authHeader}
              onChange={(event) => setAuthHeader(event.target.value as LlmProviderAuthHeaderWire)}
              disabled={submitting}
              data-testid="provider-auth-header"
            >
              <option value="authorization">authorization: Bearer &lt;key&gt;</option>
              <option value="x-api-key">x-api-key: &lt;key&gt;</option>
            </Select>
          </Field>
        </div>
      </details>

      <div className="stack-s">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            disabled={submitting}
            data-testid="provider-enabled"
          />
          <span>
            {t(
              '启用（可路由，工作区可以选它的模型）',
              'Enabled — routable, workspaces can pick its models',
            )}
          </span>
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={testAfterSave && credentialAfterSave && enabled}
            onChange={(event) => setTestAfterSave(event.target.checked)}
            disabled={submitting || !credentialAfterSave || !enabled}
            data-testid="provider-test-after-save"
          />
          <span>
            {credentialAfterSave
              ? t(
                  '保存后立即测试（一次补全 + 一次工具调用，只花极少 token）',
                  'Test right after saving (one completion + one tool call, a few tokens)',
                )
              : t(
                  '保存后立即测试——需要先填 API 密钥或环境变量名',
                  'Test right after saving — needs an API key or env var name',
                )}
          </span>
        </label>
      </div>

      {error !== null ? (
        mapped !== null ? (
          <div
            className="field-error"
            role="alert"
            data-testid="provider-form-error"
            data-error-code={error instanceof LlmAdminError ? error.code : undefined}
          >
            {mapped}
          </div>
        ) : (
          <ErrorBanner
            error={error}
            title={t('保存失败', 'Could not save the provider')}
            testId="provider-form-error"
          />
        )
      ) : null}

      <div className="row-wrap">
        <Button
          type="submit"
          variant="primary"
          disabled={!ready}
          loading={submitting}
          data-testid="provider-submit"
        >
          {editing ? t('保存', 'Save') : t('新增', 'Create')}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>
          {t('取消', 'Cancel')}
        </Button>
        {missing.length > 0 && !submitting ? (
          <span className="text-small text-3" data-testid="provider-form-missing">
            {t(`还差：${missing.join('、')}`, `Still needed: ${missing.join(', ')}`)}
          </span>
        ) : null}
      </div>
    </form>
  );
}

/** One model's 「验证」 result under its row: checking, usable, chat only, or failed with the
 *  likely cause (lib/provider-form.ts `explainUpstreamError`) and the raw error folded away. */
function ModelProbeStatus({ probe }: { readonly probe: Probe | undefined }) {
  const t = useT();
  if (!probe) return null;
  if (probe.status === 'loading') {
    return (
      <p className="field-hint" data-testid="provider-model-probe" data-state="loading">
        {t('验证中：测一次对话和一次工具调用…', 'Checking: one chat and one tool call…')}
      </p>
    );
  }
  if (probe.status === 'error') {
    const message =
      llmAdminErrorMessage(probe.error, t) ??
      (probe.error instanceof Error ? probe.error.message : String(probe.error));
    return (
      <p className="field-error" data-testid="provider-model-probe" data-state="error">
        {t(`没能验证：${message}`, `Could not check: ${message}`)}
      </p>
    );
  }
  const { outcome } = probe;
  const verdict =
    outcome.completion === 'ok' && outcome.toolCall === 'ok'
      ? 'ok'
      : outcome.completion === 'ok'
        ? 'chat-only'
        : 'failed';
  const explanation = explainUpstreamError(
    outcome.error,
    t,
    outcome.completion === 'ok' ? 'tool_call' : 'completion',
  );
  return (
    <div
      className={`provider-model-probe provider-model-probe-${verdict}`}
      data-testid="provider-model-probe"
      data-state={verdict}
    >
      <span>
        {verdict === 'ok'
          ? t(
              `✓ 可用：对话和工具调用都通过（${outcome.latencyMs} ms）`,
              `✓ Usable: chat and tool calling both work (${outcome.latencyMs} ms)`,
            )
          : verdict === 'chat-only'
            ? t(
                '! 只能对话：工具调用失败，Worker 和门工具用不了它',
                '! Chat only: tool calling failed, so Workers and gate tools cannot use it',
              )
            : t('✗ 调用失败', '✗ The call failed')}
      </span>
      {explanation ? <span className="text-2">{explanation}</span> : null}
      {outcome.error ? (
        <details className="text-3">
          <summary>{t('原始错误', 'Raw error')}</summary>
          <span className="mono">{outcome.error}</span>
        </details>
      ) : null}
    </div>
  );
}
