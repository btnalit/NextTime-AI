import { ROLE_VALUES, type Role } from '@nexttime/shared';
import { type FormEvent, useState } from 'react';
import type { CapabilityCaller } from '../lib/clients.js';
import type { CreatePrincipalResult } from '../lib/governance.js';
import { Button } from './ui/Button.js';
import { CopyId } from './ui/CopyId.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Field, Input, Select } from './ui/Field.js';
import { Notice } from './ui/Notice.js';

export interface CreatePrincipalFormProps {
  readonly http: CapabilityCaller;
  /** Called once the reader has acknowledged the one-time key and the drawer should close. */
  readonly onDone: (principal: CreatePrincipalResult['principal']) => void;
  readonly onCancel: () => void;
}

/**
 * components/CreatePrincipalForm: `create_principal{role, displayName}` (S3.11) — always a
 * `kind: 'human'` principal (the capability takes no `kind` param; agent/service principals come
 * from a WorkerDefinition spawn, not this form). Two phases: `form` (role + display name) →
 * `created` (the returned API key, shown exactly once — `docs/development-tasks.md` §S3.11: "API
 * key 只显示一次"). The key never touches `lib/session.ts`/`sessionStorage` and is dropped from
 * this component's own state the moment the drawer closes (mirrors `CompleteConnectionForm`'s
 * credential-clearing discipline for the shared-credential field).
 */
export function CreatePrincipalForm({ http, onDone, onCancel }: CreatePrincipalFormProps) {
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown | null>(null);
  const [created, setCreated] = useState<CreatePrincipalResult | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = displayName.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await http.call<CreatePrincipalResult>('create_principal', {
        role,
        displayName: trimmed,
      });
      setCreated(result);
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  if (created) {
    return (
      <div className="stack" data-testid="create-principal-key">
        <Notice tone="warn">
          This API key is shown once. Copy it now and send it to{' '}
          <strong>{created.principal.displayName}</strong> — the console never displays it again.
        </Notice>
        <div className="code-block row" style={{ justifyContent: 'space-between' }}>
          <span className="mono" data-testid="created-api-key">
            {created.apiKey}
          </span>
          <CopyId id={created.apiKey} label="API key" full />
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button
            variant="primary"
            onClick={() => {
              setAcknowledged(true);
              onDone(created.principal);
            }}
            disabled={acknowledged}
          >
            我已复制 I've copied it — Done
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="stack"
      onSubmit={(event) => void handleSubmit(event)}
      noValidate
      data-testid="create-principal-form"
    >
      <Field id="cp-name" label="Display name" required>
        <Input
          id="cp-name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          disabled={submitting}
          autoFocus
        />
      </Field>

      <Field id="cp-role" label="Role" required hint="Can be changed later from the member's row.">
        <Select
          id="cp-role"
          value={role}
          onChange={(event) => setRole(event.target.value as Role)}
          disabled={submitting}
        >
          {ROLE_VALUES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </Select>
      </Field>

      {error !== null ? <ErrorBanner error={error} title="Could not create this member" /> : null}

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={submitting} disabled={!displayName.trim()}>
          Create
        </Button>
      </div>
    </form>
  );
}
