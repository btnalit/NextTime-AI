import { type FormEvent, useState } from 'react';
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
import { useT } from '../lib/i18n.js';
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

/** "Looks like a URL": a scheme followed by `://` — the same loose check the manifest-source
 *  field always had, now shared with the endpoint (C15). Deliberately not `new URL()`: a gate
 *  endpoint is routinely a bare compose service name with a port, which the WHATWG parser accepts
 *  anyway, and this form's job is to catch a pasted hostname with no scheme, not to validate. */
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
 * submit. 400 highlights the field it names; 502/504 show the gate's own message verbatim.
 * `aria-describedby` follows what `Field` actually renders (C16): the hint only while there is
 * no error (`ui/Field.tsx` swaps the hint out for the error), so no control ever points at an id
 * that is not in the DOM.
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
  const [manifestSource, setManifestSource] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<unknown | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function validate(): FieldErrors {
    const errors: { -readonly [K in keyof FieldErrors]?: string } = {};
    if (!target.trim()) errors.target = t('目标是必填项。', 'Target is required.');
    if (!endpoint.trim()) {
      errors.endpoint = t('门端点是必填项。', 'The Gatekeeper endpoint is required.');
    } else if (!URL_LIKE_PATTERN.test(endpoint.trim())) {
      // C15: the kernel only checks non-empty, then fails the gate round trip with a far less
      // helpful `gatekeeper_error` / `gatekeeper_timeout` — say it here, on the field.
      errors.endpoint = t(
        '门端点必须是一个 URL（http://gate-host:port）。',
        'The Gatekeeper endpoint must be a URL (http://gate-host:port).',
      );
    }
    if (credentialKind === 'connected_account' && !credentials.trim()) {
      errors.credentials = t(
        '连接账户方式需要一份凭证，否则请选择共享。',
        'A connected-account credential is required, or choose Shared.',
      );
    }
    if (manifestSource.trim() && !URL_LIKE_PATTERN.test(manifestSource.trim())) {
      errors.manifestSource = t('清单来源必须是一个 URL。', 'Manifest source must be a URL.');
    }
    return errors;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const errors = validate();
    setFieldErrors(errors);
    setSubmitError(null);
    if (Object.keys(errors).length > 0) return;

    const params: CreateConnectionParams = {
      ...(request ? { connectionRequestId: request.id } : {}),
      kind,
      target: target.trim(),
      endpoint: endpoint.trim(),
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

    setSubmitting(true);
    try {
      const result = await http.call<CreateConnectionResult>('create_connection', params);
      setCredentials('');
      onDone(result);
    } catch (err) {
      setCredentials('');
      const described = describeError(err);
      const field =
        described.code === 'invalid_params' ? fieldForInvalidParams(described.message) : undefined;
      if (field) {
        setFieldErrors({ [field]: described.message });
      } else {
        setSubmitError(err);
      }
    } finally {
      setSubmitting(false);
    }
  }

  const showManifest = supportsManifestSource(kind);

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
          aria-describedby={describedBy('cc-target', !fieldErrors.target, !!fieldErrors.target)}
          disabled={submitting}
          mono
        />
      </Field>

      <Field
        id="cc-endpoint"
        label={t('门端点', 'Gatekeeper endpoint')}
        required
        error={fieldErrors.endpoint}
        hint={t(
          '正在运行的门实例自己的 HTTP 地址（每种类型，包括 cli/ssh，都由一个门前置）。',
          "The running Gatekeeper instance's own HTTP address (every kind, including cli/ssh, is fronted by one).",
        )}
      >
        <Input
          id="cc-endpoint"
          value={endpoint}
          onChange={(event) => setEndpoint(event.target.value)}
          placeholder="http://gate-host:port"
          invalid={!!fieldErrors.endpoint}
          aria-describedby={describedBy(
            'cc-endpoint',
            !fieldErrors.endpoint,
            !!fieldErrors.endpoint,
          )}
          disabled={submitting}
          mono
        />
      </Field>

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
              aria-describedby={describedBy(
                'cc-credentials',
                !fieldErrors.credentials,
                !!fieldErrors.credentials,
              )}
              autoComplete="off"
              spellCheck={false}
              disabled={submitting}
              mono
            />
          </Field>
          <Field
            id="cc-obo"
            label={t('代表谁（principal id）', 'On behalf of (principal id)')}
            hint={t(
              '这份凭证归属于谁的账户。默认是申请人，或你自己。',
              'Whose account this credential belongs to. Defaults to the requester, or to you.',
            )}
          >
            <Input
              id="cc-obo"
              value={onBehalfOf}
              onChange={(event) => setOnBehalfOf(event.target.value)}
              disabled={submitting}
              mono
            />
          </Field>
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
                ? 'https://api.example.internal/openapi.json'
                : 'http://mcp-host:port/mcp'
            }
            invalid={!!fieldErrors.manifestSource}
            aria-describedby={describedBy(
              'cc-manifest',
              !fieldErrors.manifestSource,
              !!fieldErrors.manifestSource,
            )}
            disabled={submitting}
            mono
          />
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
        <Button type="submit" variant="primary" loading={submitting}>
          {t('注册门', 'Register Gatekeeper')}
        </Button>
      </div>
    </form>
  );
}
