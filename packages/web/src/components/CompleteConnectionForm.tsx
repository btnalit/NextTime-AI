import type { MintConnectionSecretResultWire } from '@nexttime/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { useCapabilityList } from '../hooks/useCapability.js';
import type { CapabilityCaller } from '../lib/clients.js';
import {
  CONNECTION_KIND_VALUES,
  type ConnectionKind,
  type ConnectionRequestRow,
  type CreateConnectionParams,
  type CreateConnectionResult,
  supportsManifestSource,
} from '../lib/connections.js';
import { describeError } from '../lib/errors.js';
import { isAbsoluteUrl, withDefaultScheme } from '../lib/gate-input.js';
import type { PrincipalRow } from '../lib/governance.js';
import { HttpError } from '../lib/http-client.js';
import { type Translate, useT } from '../lib/i18n.js';
import { roleLabel } from '../lib/labels.js';
import { ConnectionSecretReveal } from './connect/ConnectionSecretReveal.js';
import { Button } from './ui/Button.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Field, Input, Select, Textarea, describedBy } from './ui/Field.js';
import { Notice } from './ui/Notice.js';

export interface CompleteConnectionFormProps {
  readonly http: CapabilityCaller;
  /** The `request_connection` card being completed; omitted when the owner connects directly. */
  readonly request?: ConnectionRequestRow | null;
  readonly onDone: (result: CreateConnectionResult) => void;
  readonly onCancel: () => void;
  /** S3.12's onboarding wizard (`OnboardingWizard.tsx`) already collected the kind in its own
   *  step ① and passes it here instead of duplicating the Kind field — `request?.kind` still wins
   *  when both are given (completing a real request always reflects the request's own kind). */
  readonly initialKind?: ConnectionKind;
  /** Hides the Kind field entirely (the wizard's step ① already showed it) — `false` for every
   *  pre-existing caller (`ConnectionsPage`'s own two drawers), so this is purely additive. */
  readonly hideKindField?: boolean;
}

type CredentialKind = 'shared' | 'connected_account';

interface FieldErrors {
  readonly endpoint?: string;
  readonly credentials?: string;
  readonly manifestSource?: string;
  readonly target?: string;
}

/** "Looks like a URL": a scheme followed by `://` — the loose check the manifest-source field
 *  always had. The endpoint no longer uses it (C15 follow-up): a missing scheme there is filled
 *  with `http://` instead of refused, and what remains is checked with `new URL()` (a bare compose
 *  service name with a port parses fine once it has a scheme). */
const URL_LIKE_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Parses the credential box: JSON when it is JSON, the raw string otherwise (the gate's
 *  ConnectedAccount store accepts either — `create_connection.credentials` is `z.unknown()`). */
export function parseCredentials(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

/** The 400 codes whose message names the field it is about: `invalid_params`, and R-27's
 *  `connection_target_refused` (an `endpoint` / `manifestSource` aimed at the platform). */
const FIELD_ERROR_CODES: ReadonlySet<string> = new Set([
  'invalid_params',
  'connection_target_refused',
]);

/** The Chinese-first explanation shown on a field a kernel 400 named, ahead of the kernel's own
 *  (English) text — which stays visible as the secondary "server message" so nothing is lost. */
export function fieldErrorExplanation(
  field: keyof FieldErrors,
  code: string,
  t: Translate,
): string {
  if (code === 'credentials_in_connection_params') {
    return field === 'endpoint'
      ? t(
          '门端点里不能带用户名、密码、查询参数（?）或片段（#），已拒绝，什么也没保存：只填门自己的地址，凭据填到「凭证」里或配置在门上。',
          'The Gatekeeper endpoint cannot carry a user name, password, query string (?) or fragment (#) — refused, nothing was saved. Enter only the gate’s own address; put the credential in Credentials or in the gate’s configuration.',
        )
      : t(
          '目标系统里带了凭据（URL 里的密码、token 或 key），已拒绝，什么也没保存：目标系统只写地址或名称，凭据填到「凭证」里或配置在门上。',
          'The target system carries a credential (a URL password, a token or a key) — refused, nothing was saved. Enter only its address or name; put the credential in Credentials or in the gate’s configuration.',
        );
  }
  if (code === 'connection_target_refused') {
    return t(
      '这个地址指向平台自身的服务，已被拒绝：请填写门在网络上可达的地址（带域名或 IP），不要用 localhost 或单段主机名。',
      "This address points at one of the platform's own services and was refused — use the gate's network-reachable address (with a domain or IP), not localhost or a single-label host name.",
    );
  }
  switch (field) {
    case 'credentials':
      return t(
        '门没有接受这份凭证：请填一个 token，或一个 JSON 对象。',
        'The gate did not accept this credential — enter a token or a JSON object.',
      );
    case 'manifestSource':
      return t(
        '清单来源不被接受：需要一个可访问的完整地址，例如 https://api.example.com/openapi.json。',
        'The manifest source was not accepted — it needs a full, reachable address such as https://api.example.com/openapi.json.',
      );
    case 'endpoint':
      return t(
        '门端点不被接受：需要门自己的完整地址，例如 http://gate-host:8080。',
        "The Gatekeeper endpoint was not accepted — it needs the gate's own full address, such as http://gate-host:8080.",
      );
    case 'target':
      return t(
        '目标系统不被接受：请填一个 base URL、host 或服务名。',
        'The target system was not accepted — enter a base URL, host or service name.',
      );
  }
}

/** The field a `credentials_in_connection_params` 400 names (`details.field`, legacy 186) — the
 *  kernel's message mentions "credentials" too, so it is never guessed from the text. */
function connectionCredentialField(err: unknown): keyof FieldErrors | undefined {
  const field = err instanceof HttpError ? err.details?.field : undefined;
  return field === 'target' || field === 'endpoint' ? field : undefined;
}

/** Maps a kernel `invalid_params` (400) to the field it is most likely about. */
export function fieldForInvalidParams(message: string): keyof FieldErrors | undefined {
  const lower = message.toLowerCase();
  if (lower.includes('credential')) return 'credentials';
  if (lower.includes('manifest')) return 'manifestSource';
  if (lower.includes('endpoint')) return 'endpoint';
  if (lower.includes('target')) return 'target';
  return undefined;
}

/**
 * components/CompleteConnectionForm: the owner's half of the S2.13 flow — turn a connection
 * request (or a blank) into a registered Gatekeeper via `create_connection`
 * (`packages/shared/src/capabilities.ts`). Credentials go straight to the gate and are cleared
 * from this form the moment the call returns; they are never echoed, logged or kept in state after
 * submit. 400 highlights the field it names (a Chinese explanation first, the kernel's own text
 * second); 502/504 show the gate's own message verbatim. `aria-describedby` follows what `Field`
 * actually renders (C16): the hint always, plus the error while there is one.
 *
 * Fills instead of refusing (console UX pass): an endpoint typed as `gate-host:8080` gets
 * `http://` on blur (with a note), and "代表谁" is a member picker rather than a raw id box.
 *
 * R-01 (maintainer decision D-01): the gate being registered is one the workspace runs itself, so
 * the kernel calls it with that gate's own connection secret, never the platform gate token. The
 * form mints one when it opens (`mint_connection_secret` — nothing is stored until
 * `create_connection`), shows it once with a copy control, and sends it as `connectionSecret`; the
 * owner puts it in the gate's config before registering. Closing the form discards it.
 */
export function CompleteConnectionForm({
  http,
  request,
  onDone,
  onCancel,
  initialKind,
  hideKindField = false,
}: CompleteConnectionFormProps) {
  const t = useT();
  const [kind, setKind] = useState<ConnectionKind>(request?.kind ?? initialKind ?? 'http');
  const [target, setTarget] = useState(request?.target ?? '');
  const [endpoint, setEndpoint] = useState('');
  const [credentialKind, setCredentialKind] = useState<CredentialKind>('shared');
  const [credentials, setCredentials] = useState('');
  const [onBehalfOf, setOnBehalfOf] = useState('');
  /** The endpoint had no scheme and `http://` was prepended on blur — said under the field. */
  const [endpointSchemeAdded, setEndpointSchemeAdded] = useState(false);
  const [manifestSource, setManifestSource] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<unknown | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [connectionSecret, setConnectionSecret] = useState<string | null>(null);
  const [secretError, setSecretError] = useState<unknown | null>(null);

  useEffect(() => {
    let current = true;
    http.call<MintConnectionSecretResultWire>('mint_connection_secret', {}).then(
      (result) => {
        if (current) setConnectionSecret(result.connectionSecret);
      },
      (err: unknown) => {
        if (current) setSecretError(err);
      },
    );
    return () => {
      current = false;
    };
  }, [http]);

  /** What gets sent: a bare `host:port` gets `http://` (a gate endpoint is plain http inside the
   *  deployment network — the field's own placeholder). */
  const endpointValue = withDefaultScheme(endpoint, 'http');

  function completeEndpoint(): void {
    const next = withDefaultScheme(endpoint, 'http');
    if (next !== endpoint.trim()) setEndpointSchemeAdded(true);
    setEndpoint(next);
  }

  function validate(): FieldErrors {
    const errors: { -readonly [K in keyof FieldErrors]?: string } = {};
    if (!target.trim()) errors.target = t('目标是必填项。', 'Target is required.');
    if (!endpoint.trim()) {
      errors.endpoint = t(
        '门端点是必填项：填门自己的地址，例如 http://gate-host:8080。',
        "The Gatekeeper endpoint is required — the gate's own address, e.g. http://gate-host:8080.",
      );
    } else if (!isAbsoluteUrl(endpointValue)) {
      // C15: the kernel only checks non-empty, then fails the gate round trip with a far less
      // helpful `gatekeeper_error` / `gatekeeper_timeout` — say it here, on the field. A missing
      // scheme is no longer an error (`http://` is prepended); what is left is a malformed host.
      errors.endpoint = t(
        '门端点需要一个完整的地址，例如 http://gate-host:8080（不能有空格）。',
        'The Gatekeeper endpoint needs a full address, e.g. http://gate-host:8080 (no spaces).',
      );
    }
    if (credentialKind === 'connected_account' && !credentials.trim()) {
      errors.credentials = t(
        '连接账户方式需要一份凭证，否则请选择共享。',
        'A connected-account credential is required, or choose Shared.',
      );
    }
    if (manifestSource.trim() && !URL_LIKE_PATTERN.test(manifestSource.trim())) {
      errors.manifestSource = t(
        '清单来源需要一个完整的地址，例如 https://api.example.com/openapi.json。',
        'The manifest source needs a full address, e.g. https://api.example.com/openapi.json.',
      );
    }
    return errors;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const errors = validate();
    setFieldErrors(errors);
    setSubmitError(null);
    if (Object.keys(errors).length > 0) return;
    if (connectionSecret === null) return;

    const params: CreateConnectionParams = {
      ...(request ? { connectionRequestId: request.id } : {}),
      kind,
      target: target.trim(),
      endpoint: endpointValue,
      connectionSecret,
      credentialKind,
      ...(credentialKind === 'connected_account'
        ? { credentials: parseCredentials(credentials) }
        : {}),
      ...(credentialKind === 'connected_account' && onBehalfOf.trim()
        ? { onBehalfOf: onBehalfOf.trim() }
        : {}),
      ...(supportsManifestSource(kind) && manifestSource.trim()
        ? { manifestSource: manifestSource.trim() }
        : {}),
    };

    setEndpoint(endpointValue);
    setSubmitting(true);
    try {
      const result = await http.call<CreateConnectionResult>('create_connection', params);
      setCredentials('');
      onDone(result);
    } catch (err) {
      setCredentials('');
      const described = describeError(err);
      const field =
        described.code === 'credentials_in_connection_params'
          ? connectionCredentialField(err)
          : FIELD_ERROR_CODES.has(described.code)
            ? fieldForInvalidParams(described.message)
            : undefined;
      if (field) {
        // A Chinese-first explanation of the field, with the kernel's own (English) text kept as
        // the secondary detail rather than shown alone.
        setFieldErrors({
          [field]: `${fieldErrorExplanation(field, described.code, t)} ${t('服务端原文：', 'Server message: ')}${described.message}`,
        });
      } else {
        setSubmitError(err);
      }
    } finally {
      setSubmitting(false);
    }
  }

  const showManifest = supportsManifestSource(kind);
  // console-ux-3: for an http gate the OpenAPI document usually sits at `<target>/openapi.json` —
  // offered as a one-click fill (never set silently), the same pattern as the platform's
  // `CreateGateInstanceForm`. A target that is not a URL or host yields no suggestion.
  const targetUrl = withDefaultScheme(target, 'https');
  const suggestedManifest =
    kind === 'http' && targetUrl !== '' && isAbsoluteUrl(targetUrl)
      ? `${targetUrl.replace(/\/+$/, '')}/openapi.json`
      : '';

  return (
    <form
      className="stack"
      onSubmit={(event) => void handleSubmit(event)}
      noValidate
      data-testid="complete-connection-form"
    >
      {request ? (
        <Notice>
          {t(
            <>
              完成申请 <span className="mono">{request.id.slice(0, 8)}</span>，来自主体{' '}
              <span className="mono">{request.requestedBy.slice(0, 8)}</span>。
            </>,
            <>
              Completing request <span className="mono">{request.id.slice(0, 8)}</span> from
              principal <span className="mono">{request.requestedBy.slice(0, 8)}</span>.
            </>,
          )}
        </Notice>
      ) : null}

      {hideKindField ? null : (
        <Field id="cc-kind" label={t('类型', 'Kind')} required>
          <Select
            id="cc-kind"
            value={kind}
            onChange={(event) => setKind(event.target.value as ConnectionKind)}
            disabled={submitting}
          >
            {CONNECTION_KIND_VALUES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </Field>
      )}

      <Field
        id="cc-target"
        label={t('目标系统', 'Target system')}
        required
        error={fieldErrors.target}
        hint={t(
          '门前面对接的是什么——一个 base URL、host 或服务名。',
          'What the Gatekeeper fronts — a base URL, host, or service name.',
        )}
      >
        <Input
          id="cc-target"
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          invalid={!!fieldErrors.target}
          aria-describedby={describedBy('cc-target', true, !!fieldErrors.target)}
          disabled={submitting}
          mono
        />
      </Field>

      <Field
        id="cc-endpoint"
        label={t('门端点', 'Gatekeeper endpoint')}
        required
        error={fieldErrors.endpoint}
        hint={
          <>
            {t(
              '正在运行的门实例自己的 HTTP 地址（每种类型，包括 cli/ssh，都由一个门前置）；没写 http:// 会自动补上。',
              "The running Gatekeeper instance's own HTTP address (every kind, including cli/ssh, is fronted by one); http:// is added if you leave it out.",
            )}
            {endpointSchemeAdded ? (
              <span data-testid="cc-endpoint-scheme-note">
                {' '}
                {t(
                  '已自动补上 http://；如果门走 https，请改成 https://。',
                  'Added http:// for you — change it to https:// if the gate serves https.',
                )}
              </span>
            ) : null}
          </>
        }
      >
        <Input
          id="cc-endpoint"
          value={endpoint}
          onChange={(event) => {
            setEndpoint(event.target.value);
            setEndpointSchemeAdded(false);
          }}
          onBlur={completeEndpoint}
          placeholder="http://gate-host:port"
          invalid={!!fieldErrors.endpoint}
          aria-describedby={describedBy('cc-endpoint', true, !!fieldErrors.endpoint)}
          disabled={submitting}
          mono
        />
      </Field>

      <div className="field" data-testid="cc-connection-secret">
        <span className="field-label">{t('门的连接密钥', 'Gate connection secret')}</span>
        {connectionSecret !== null ? (
          <ConnectionSecretReveal secret={connectionSecret} testId="cc-connection-secret-reveal" />
        ) : secretError !== null ? (
          <ErrorBanner
            error={secretError}
            title={t('无法生成连接密钥', 'Could not generate a connection secret')}
          />
        ) : (
          <span className="text-3 text-small">{t('正在生成…', 'Generating…')}</span>
        )}
      </div>

      <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="field-label">{t('凭证', 'Credential')}</legend>
        <div
          className="radio-group"
          role="radiogroup"
          aria-label={t('凭证类型', 'Credential kind')}
        >
          <label className="radio-option">
            <input
              type="radio"
              name="credentialKind"
              value="shared"
              checked={credentialKind === 'shared'}
              onChange={() => setCredentialKind('shared')}
              disabled={submitting}
            />
            {t(
              '共享 —— 门已经持有一份凭证（env/config）',
              'Shared — the gate already holds a credential (env/config)',
            )}
          </label>
          <label className="radio-option">
            <input
              type="radio"
              name="credentialKind"
              value="connected_account"
              checked={credentialKind === 'connected_account'}
              onChange={() => setCredentialKind('connected_account')}
              disabled={submitting}
            />
            {t(
              '已连接账户 —— 把逐用户的凭证发给门',
              'Connected account — send a per-user credential to the gate',
            )}
          </label>
        </div>
      </fieldset>

      {credentialKind === 'connected_account' ? (
        <>
          <Field
            id="cc-credentials"
            label={t('凭证', 'Credentials')}
            required
            error={fieldErrors.credentials}
            hint={t(
              '一个 token，或一个 JSON 对象。只送到门的 ConnectedAccount 存储——内核不会持久化它，提交后这个字段会被清空。',
              "A token, or a JSON object. Sent to the Gatekeeper's ConnectedAccount store only — the kernel never persists it and this field is cleared on submit.",
            )}
          >
            <Textarea
              id="cc-credentials"
              value={credentials}
              onChange={(event) => setCredentials(event.target.value)}
              rows={3}
              invalid={!!fieldErrors.credentials}
              aria-describedby={describedBy('cc-credentials', true, !!fieldErrors.credentials)}
              autoComplete="off"
              spellCheck={false}
              disabled={submitting}
              mono
            />
          </Field>
          <OnBehalfOfField
            http={http}
            request={request ?? null}
            value={onBehalfOf}
            onChange={setOnBehalfOf}
            disabled={submitting}
          />
        </>
      ) : null}

      {showManifest ? (
        <Field
          id="cc-manifest"
          label={t('清单来源', 'Manifest source')}
          error={fieldErrors.manifestSource}
          hint={
            kind === 'http'
              ? t(
                  '导入 Operation 用的 OpenAPI 文档 URL。留空则使用门自己的 describe_operations。',
                  'OpenAPI document URL to import operations from. Leave empty to use the gate’s own describe_operations.',
                )
              : t(
                  '导入 tools/list 用的 MCP 服务端点。留空则使用门自己的 describe_operations。',
                  'MCP server endpoint to import tools/list from. Leave empty to use the gate’s own describe_operations.',
                )
          }
        >
          <Input
            id="cc-manifest"
            value={manifestSource}
            onChange={(event) => setManifestSource(event.target.value)}
            placeholder={
              kind === 'http'
                ? suggestedManifest || 'https://api.example.internal/openapi.json'
                : 'http://mcp-host:port/mcp'
            }
            invalid={!!fieldErrors.manifestSource}
            aria-describedby={describedBy('cc-manifest', true, !!fieldErrors.manifestSource)}
            disabled={submitting}
            mono
          />
          {suggestedManifest && manifestSource.trim() !== suggestedManifest ? (
            <div className="row">
              <Button
                variant="ghost"
                size="s"
                onClick={() => setManifestSource(suggestedManifest)}
                disabled={submitting}
                data-testid="cc-manifest-suggest"
              >
                {t(`使用 ${suggestedManifest}`, `Use ${suggestedManifest}`)}
              </Button>
            </div>
          ) : null}
        </Field>
      ) : null}

      {submitError !== null ? (
        <ErrorBanner
          error={submitError}
          title={t('门未接受这次连接', 'The gate did not accept this connection')}
        />
      ) : null}

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>
          {t('取消', 'Cancel')}
        </Button>
        <Button
          type="submit"
          variant="primary"
          loading={submitting}
          disabled={connectionSecret === null}
        >
          {t('注册门', 'Register Gatekeeper')}
        </Button>
      </div>
    </form>
  );
}

/**
 * "代表谁": a member picker over `list_principals` (the same source and filter
 * `access/GrantGateForm` uses — active human members, internal service principals left out),
 * mounted only once a per-member credential is chosen so the shared case never reads the
 * directory. Empty = the kernel's own default (the requester, else the caller). A failed read falls
 * back to a manual principal-id box, said so in the hint.
 */
function OnBehalfOfField({
  http,
  request,
  value,
  onChange,
  disabled,
}: {
  readonly http: CapabilityCaller;
  readonly request: ConnectionRequestRow | null;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled: boolean;
}) {
  const t = useT();
  const principals = useCapabilityList<PrincipalRow>(
    http,
    'list_principals',
    {},
    {
      autoLoadAll: true,
    },
  );
  const options =
    principals.state.status === 'ready'
      ? (principals.state.data.items ?? []).filter(
          (row) => row.kind === 'human' && !row.disabledAt && !row.internal,
        )
      : [];
  const failed = principals.state.status === 'error';
  const requester = request ? options.find((row) => row.id === request.requestedBy) : undefined;

  return (
    <Field
      id="cc-obo"
      label={t('代表谁', 'On behalf of')}
      hint={
        failed
          ? t(
              '读不到成员列表，可以直接填对方的 principal id；留空则默认是申请人，或你自己。',
              'Could not read the member list — enter their principal id directly, or leave it empty for the requester (or you).',
            )
          : t(
              '这份凭证归属于谁的账户。默认是申请人，或你自己。',
              'Whose account this credential belongs to. Defaults to the requester, or to you.',
            )
      }
    >
      {failed ? (
        <Input
          id="cc-obo"
          value={value}
          onChange={(event) => onChange(event.target.value.trim())}
          disabled={disabled}
          placeholder={t('principal id（可选）', 'principal id (optional)')}
          data-testid="cc-obo-manual"
          mono
        />
      ) : (
        <Select
          id="cc-obo"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled || principals.state.status === 'loading'}
          data-testid="cc-obo-select"
        >
          <option value="">
            {principals.state.status === 'loading'
              ? t('正在加载成员…', 'Loading members…')
              : requester
                ? t(
                    `默认：申请人 ${requester.displayName}`,
                    `Default: the requester, ${requester.displayName}`,
                  )
                : request
                  ? t('默认：申请人', 'Default: the requester')
                  : t('默认：你自己', 'Default: you')}
          </option>
          {options.map((row) => (
            <option key={row.id} value={row.id}>
              {row.displayName} ({roleLabel(row.role, t)})
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}
