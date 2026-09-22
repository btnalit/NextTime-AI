import type {
  LlmProviderApiKindWire,
  LlmProviderAuthHeaderWire,
  LlmProviderInputWire,
  LlmProviderWire,
} from '@nexttime/shared';
import { type FormEvent, useState } from 'react';
import { LlmAdminError, llmAdminErrorMessage } from '../../../lib/llm-admin.js';
import { Button } from '../../ui/Button.js';
import { ErrorBanner } from '../../ui/ErrorBanner.js';
import { Field, Input, Select } from '../../ui/Field.js';
import { Notice } from '../../ui/Notice.js';

export interface ProviderFormProps {
  /** Editing an existing row (id locked) or creating a new one. */
  readonly initial?: LlmProviderWire;
  readonly onSubmit: (input: LlmProviderInputWire) => Promise<void>;
  readonly onCancel: () => void;
}

/** Same rules as `@nexttime/shared` wire/llm-admin.ts (`LLM_PROVIDER_ID_PATTERN`,
 *  `LlmProviderApiKeyEnvWireSchema`) — type-only import there, so the two regexes are restated
 *  here; the proxy re-validates on every write. */
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const RESERVED_IDS = new Set(['admin', 'healthz', 'internal']);
const API_KEY_ENV_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;

const API_KINDS: ReadonlyArray<{ value: LlmProviderApiKindWire; label: string }> = [
  {
    value: 'openai-completions',
    label: 'OpenAI 兼容 · chat/completions（OpenAI、DeepSeek、Gemini 兼容端点…）',
  },
  { value: 'openai-responses', label: 'OpenAI 兼容 · responses' },
  { value: 'anthropic-messages', label: 'Anthropic · messages' },
];

interface ModelRowDraft {
  readonly key: number;
  readonly id: string;
  readonly displayName: string;
}

function isValidUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * components/platform/providers/ProviderForm: 新增 / 编辑供应商 (S6-B, docs/console-completion-
 * plan.md §5.4 "名称、API 种类…base URL；鉴权头；模型清单与显示名；启用"). Produces exactly the
 * `LlmProviderInputWire` llm-proxy validates — and therefore has no key field at all: the key is
 * the env var the operator sets in `secrets/llm-proxy.env` (`apiKeyEnv` names it; the page shows
 * whether it is present). The auth header follows the api kind by default (`authorization` +
 * Bearer for the OpenAI family, `x-api-key` for Anthropic) but stays editable for a compatible
 * endpoint that wants the other one.
 */
export function ProviderForm({ initial, onSubmit, onCancel }: ProviderFormProps) {
  const editing = initial !== undefined;
  const [id, setId] = useState(initial?.id ?? '');
  const [displayName, setDisplayName] = useState(initial?.displayName ?? '');
  const [api, setApi] = useState<LlmProviderApiKindWire>(initial?.api ?? 'openai-completions');
  const [upstreamBaseUrl, setUpstreamBaseUrl] = useState(initial?.upstreamBaseUrl ?? '');
  const [authHeader, setAuthHeader] = useState<LlmProviderAuthHeaderWire>(
    initial?.authHeader ?? 'authorization',
  );
  const [apiKeyEnv, setApiKeyEnv] = useState(initial?.apiKeyEnv ?? '');
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
  const [nextKey, setNextKey] = useState(models.length);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const idTrimmed = id.trim();
  const idValid = PROVIDER_ID_PATTERN.test(idTrimmed) && !RESERVED_IDS.has(idTrimmed);
  const urlValid = isValidUrl(upstreamBaseUrl.trim()) && !/\/v1\/?$/.test(upstreamBaseUrl.trim());
  // S7-A: optional — a provider may rely purely on a console key (set separately, after
  // creation, via ProviderSecretForm) and have no env var at all.
  const envValid = apiKeyEnv.trim().length === 0 || API_KEY_ENV_PATTERN.test(apiKeyEnv.trim());
  const modelIds = models.map((m) => m.id.trim()).filter((v) => v.length > 0);
  const modelsValid = modelIds.length > 0 && new Set(modelIds).size === modelIds.length;
  const ready = idValid && urlValid && envValid && modelsValid && !submitting;

  function chooseApi(next: LlmProviderApiKindWire): void {
    setApi(next);
    // Follow the api kind's own convention unless the operator already moved it.
    setAuthHeader(next === 'anthropic-messages' ? 'x-api-key' : 'authorization');
  }

  function updateModel(key: number, patch: Partial<ModelRowDraft>): void {
    setModels((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!ready) return;
    const input: LlmProviderInputWire = {
      id: idTrimmed,
      ...(displayName.trim().length > 0 ? { displayName: displayName.trim() } : {}),
      api,
      upstreamBaseUrl: upstreamBaseUrl.trim().replace(/\/+$/, ''),
      authHeader,
      authScheme: authHeader === 'authorization' ? 'Bearer' : null,
      ...(apiKeyEnv.trim().length > 0 ? { apiKeyEnv: apiKeyEnv.trim() } : {}),
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
      await onSubmit(input);
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  const mapped = llmAdminErrorMessage(error);

  return (
    <form
      className="stack"
      onSubmit={(event) => void handleSubmit(event)}
      noValidate
      data-testid="provider-form"
    >
      {editing && initial.source === 'file' ? (
        <Notice testId="provider-form-override-notice">
          这是主机 llm-providers.yaml 里的供应商；保存会在代理的存储里建一条覆盖记录，yaml
          本身不改。 This provider comes from llm-providers.yaml on the host — saving creates an
          override in the proxy’s store; the yaml itself is not modified.
        </Notice>
      ) : null}

      <Field
        id="provider-id"
        label="Id"
        required
        hint="小写字母/数字/连字符；成为代理路由 /<id>/v1 与 models.json 里的 provider 名。 Lowercase slug — becomes the proxy route and the models.json provider name."
        error={
          id.length > 0 && !idValid ? '格式不合法或为保留名 Invalid or reserved id' : undefined
        }
      >
        <Input
          id="provider-id"
          value={id}
          onChange={(event) => setId(event.target.value)}
          disabled={editing || submitting}
          mono
          autoFocus={!editing}
          data-testid="provider-id"
        />
      </Field>

      <Field id="provider-display-name" label="名称 Display name">
        <Input
          id="provider-display-name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          disabled={submitting}
          placeholder={idTrimmed || 'id'}
          data-testid="provider-display-name"
        />
      </Field>

      <Field
        id="provider-api"
        label="API 种类 API kind"
        required
        hint="Gemini 走它的 OpenAI 兼容端点（§12 第 2 项：原生适配器不排期）。 Gemini goes through its OpenAI-compatible endpoint."
      >
        <Select
          id="provider-api"
          value={api}
          onChange={(event) => chooseApi(event.target.value as LlmProviderApiKindWire)}
          disabled={submitting}
          data-testid="provider-api"
        >
          {API_KINDS.map((kind) => (
            <option key={kind.value} value={kind.value}>
              {kind.label}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        id="provider-base-url"
        label="Base URL"
        required
        hint="供应商的源站，不带 /v1（代理自己拼路径），如 https://api.example.com。 The bare upstream origin, without /v1."
        error={
          upstreamBaseUrl.length > 0 && !urlValid
            ? '需要 http(s) URL，且不能以 /v1 结尾 Needs an http(s) URL not ending in /v1'
            : undefined
        }
      >
        <Input
          id="provider-base-url"
          value={upstreamBaseUrl}
          onChange={(event) => setUpstreamBaseUrl(event.target.value)}
          disabled={submitting}
          mono
          inputMode="url"
          data-testid="provider-base-url"
        />
      </Field>

      <Field
        id="provider-auth-header"
        label="鉴权头 Auth header"
        required
        hint="代理把真实密钥放进这个头发给上游：authorization 用 Bearer 前缀，x-api-key 不带前缀。 The header the proxy puts the real key in upstream."
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

      <Field
        id="provider-api-key-env"
        label="密钥环境变量名 Key env var"
        hint="可选——只填变量名，值由操作员写进主机 secrets/llm-proxy.env 后重建 llm-proxy。留空也可以，保存后在下方为这个供应商单独设置控制台密钥（优先于环境变量）。 Optional — the variable name only, its value set by the operator in secrets/llm-proxy.env on the host. Leave it blank and set a console key for this provider after saving instead (it takes priority over the env var)."
        error={
          apiKeyEnv.length > 0 && !envValid ? '大写字母、数字、下划线 UPPER_CASE only' : undefined
        }
      >
        <Input
          id="provider-api-key-env"
          value={apiKeyEnv}
          onChange={(event) => setApiKeyEnv(event.target.value.toUpperCase())}
          disabled={submitting}
          mono
          placeholder="EXAMPLE_API_KEY"
          data-testid="provider-api-key-env"
        />
      </Field>

      <fieldset className="field" data-testid="provider-models">
        <legend className="field-label">
          模型清单 Models{' '}
          <span className="field-required" aria-hidden>
            *
          </span>
        </legend>
        <p className="field-hint">
          模型 id 按供应商原样填（如 gpt-4.1-mini）；显示名可选，进 models.json 的 name。 The
          provider’s own model id; the display name is optional.
        </p>
        <div className="stack-s">
          {models.map((row, index) => (
            <div className="row" key={row.key} data-testid="provider-model-row">
              <Input
                aria-label={`Model ${index + 1} id`}
                value={row.id}
                onChange={(event) => updateModel(row.key, { id: event.target.value })}
                disabled={submitting}
                mono
                placeholder="model-id"
                data-testid="provider-model-id"
              />
              <Input
                aria-label={`Model ${index + 1} display name`}
                value={row.displayName}
                onChange={(event) => updateModel(row.key, { displayName: event.target.value })}
                disabled={submitting}
                placeholder="显示名 display name（可选）"
                data-testid="provider-model-display-name"
              />
              <Button
                variant="ghost"
                size="s"
                icon="close"
                iconOnly
                aria-label={`Remove model ${index + 1}`}
                disabled={submitting || models.length === 1}
                onClick={() => setModels((rows) => rows.filter((r) => r.key !== row.key))}
              />
            </div>
          ))}
          <div>
            <Button
              variant="secondary"
              size="s"
              icon="plus"
              disabled={submitting}
              onClick={() => {
                setModels((rows) => [...rows, { key: nextKey, id: '', displayName: '' }]);
                setNextKey((k) => k + 1);
              }}
              data-testid="provider-model-add"
            >
              添加模型 Add model
            </Button>
          </div>
        </div>
        {modelIds.length > 0 && !modelsValid ? (
          <p className="field-error" role="alert">
            模型 id 重复 Duplicate model ids
          </p>
        ) : null}
      </fieldset>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
          disabled={submitting}
          data-testid="provider-enabled"
        />
        <span>启用（可路由、进入 models.json） Enabled — routable and listed in models.json</span>
      </label>

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
            title="保存失败 Could not save the provider"
            testId="provider-form-error"
          />
        )
      ) : null}

      <div className="row">
        <Button
          type="submit"
          variant="primary"
          disabled={!ready}
          loading={submitting}
          data-testid="provider-submit"
        >
          {editing ? '保存 Save' : '新增 Create'}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>
          取消 Cancel
        </Button>
      </div>
    </form>
  );
}
