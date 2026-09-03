import { type FormEvent, useState } from 'react';
import type { CapabilityCaller } from '../lib/clients.js';
import { CONNECTION_KIND_VALUES, type ConnectionKind } from '../lib/connections.js';
import { Button } from './ui/Button.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Field, Input, Select } from './ui/Field.js';

export interface RequestConnectionFormProps {
  readonly http: CapabilityCaller;
  readonly onDone: (result: { connectionRequestId: string; status: string }) => void;
  readonly onCancel: () => void;
}

/** components/RequestConnectionForm: `request_connection {kind, target}` — proposes a connection
 *  for the owner to complete later (the card an agent would otherwise raise from a chat). */
export function RequestConnectionForm({ http, onDone, onCancel }: RequestConnectionFormProps) {
  const [kind, setKind] = useState<ConnectionKind>('http');
  const [target, setTarget] = useState('');
  const [error, setError] = useState<unknown | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const targetError = target.trim() ? null : 'Target is required.';
  const [touched, setTouched] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setTouched(true);
    if (targetError) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await http.call<{ connectionRequestId: string; status: string }>(
        'request_connection',
        { kind, target: target.trim() },
      );
      onDone(result);
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="stack" onSubmit={(event) => void handleSubmit(event)} noValidate>
      <Field id="rc-kind" label="Kind" required>
        <Select
          id="rc-kind"
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
      <Field id="rc-target" label="Target system" required error={touched ? targetError : null}>
        <Input
          id="rc-target"
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          onBlur={() => setTouched(true)}
          invalid={touched && !!targetError}
          disabled={submitting}
          placeholder="https://erp.example.internal or a hostname"
          mono
        />
      </Field>
      {error !== null ? <ErrorBanner error={error} title="Could not create the request" /> : null}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={submitting}>
          Request connection
        </Button>
      </div>
    </form>
  );
}
