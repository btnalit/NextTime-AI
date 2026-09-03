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
}

type CredentialKind = 'shared' | 'connected_account';

interface FieldErrors {
  readonly endpoint?: string;
  readonly credentials?: string;
  readonly manifestSource?: string;
  readonly target?: string;
}

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
 */
export function CompleteConnectionForm({
  http,
  request,
  onDone,
  onCancel,
}: CompleteConnectionFormProps) {
  const [kind, setKind] = useState<ConnectionKind>(request?.kind ?? 'http');
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
    if (!target.trim()) errors.target = 'Target is required.';
    if (!endpoint.trim()) errors.endpoint = 'The Gatekeeper endpoint is required.';
    if (credentialKind === 'connected_account' && !credentials.trim()) {
      errors.credentials = 'A connected-account credential is required, or choose Shared.';
    }
    if (manifestSource.trim() && !/^[a-z][a-z0-9+.-]*:\/\//i.test(manifestSource.trim())) {
      errors.manifestSource = 'Manifest source must be a URL.';
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
          Completing request <span className="mono">{request.id.slice(0, 8)}</span> from principal{' '}
          <span className="mono">{request.requestedBy.slice(0, 8)}</span>.
        </Notice>
      ) : null}

      <Field id="cc-kind" label="Kind" required>
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

      <Field
        id="cc-target"
        label="Target system"
        required
        error={fieldErrors.target}
        hint="What the Gatekeeper fronts — a base URL, host, or service name."
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
        label="Gatekeeper endpoint"
        required
        error={fieldErrors.endpoint}
        hint="The running Gatekeeper instance's own HTTP address (every kind, including cli/ssh, is fronted by one)."
      >
        <Input
          id="cc-endpoint"
          value={endpoint}
          onChange={(event) => setEndpoint(event.target.value)}
          placeholder="http://gate-host:port"
          invalid={!!fieldErrors.endpoint}
          aria-describedby={describedBy('cc-endpoint', true, !!fieldErrors.endpoint)}
          disabled={submitting}
          mono
        />
      </Field>

      <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="field-label">Credential</legend>
        <div className="radio-group" role="radiogroup" aria-label="Credential kind">
          <label className="radio-option">
            <input
              type="radio"
              name="credentialKind"
              value="shared"
              checked={credentialKind === 'shared'}
              onChange={() => setCredentialKind('shared')}
              disabled={submitting}
            />
            Shared — the gate already holds a credential (env/config)
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
            Connected account — send a per-user credential to the gate
          </label>
        </div>
      </fieldset>

      {credentialKind === 'connected_account' ? (
        <>
          <Field
            id="cc-credentials"
            label="Credentials"
            required
            error={fieldErrors.credentials}
            hint="A token, or a JSON object. Sent to the Gatekeeper's ConnectedAccount store only — the kernel never persists it and this field is cleared on submit."
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
          <Field
            id="cc-obo"
            label="On behalf of (principal id)"
            hint="Whose account this credential belongs to. Defaults to the requester, or to you."
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
          label="Manifest source"
          error={fieldErrors.manifestSource}
          hint={
            kind === 'http'
              ? 'OpenAPI document URL to import operations from. Leave empty to use the gate’s own describe_operations.'
              : 'MCP server endpoint to import tools/list from. Leave empty to use the gate’s own describe_operations.'
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
            aria-describedby={describedBy('cc-manifest', true, !!fieldErrors.manifestSource)}
            disabled={submitting}
            mono
          />
        </Field>
      ) : null}

      {submitError !== null ? (
        <ErrorBanner error={submitError} title="The gate did not accept this connection" />
      ) : null}

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={submitting}>
          Register Gatekeeper
        </Button>
      </div>
    </form>
  );
}
