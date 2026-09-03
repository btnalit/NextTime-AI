import { type FormEvent, useState } from 'react';
import { HttpError } from '../lib/http-client.js';
import type { HttpClient } from '../lib/http-client.js';

const KIND_OPTIONS = ['http', 'mcp', 'cli', 'ssh'] as const;
type ConnectionKind = (typeof KIND_OPTIONS)[number];

export interface ConnectionCardProps {
  readonly httpClient: HttpClient;
}

/**
 * components/ConnectionCard: "填地址、凭证、种类 → 门实例" (design doc §8.5, docs/development-
 * tasks.md S2.10 deliverable 5). Wired to `create_connection` (packages/shared/src/
 * capabilities.ts, `group: 'connection'`) — that capability's *shape* landed on `main` from S2.1's
 * scaffolding, but S2.13 (the module that actually implements it, `governance/connections`) has not
 * — every submission today resolves the call and then fails with the kernel's stable `501
 * not_implemented` envelope, surfaced below as a distinct "not implemented yet" note rather than a
 * generic error (see this package's README "已知偏离" for the full reasoning: build against the
 * declared shape now, or ship nothing at all and redo this file once S2.13 lands — the former is
 * strictly more useful and this file's own submit handler already isolates the one thing likely to
 * change, the `credentials` shape, behind a single JSON.parse).
 *
 * `credentials` (S2.13's own params schema: `z.unknown()`) is collected here as free-form JSON
 * text rather than kind-specific structured fields — S2.13 has not decided what "凭证种类" (the
 * task brief's own phrase) means per connection kind yet, so this form does not guess a shape that
 * might not survive that task's own design pass.
 */
export function ConnectionCard({ httpClient }: ConnectionCardProps) {
  const [kind, setKind] = useState<ConnectionKind>('http');
  const [target, setTarget] = useState('');
  const [credentialsText, setCredentialsText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<unknown>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [notImplemented, setNotImplemented] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setNotImplemented(false);
    setResult(undefined);

    let credentials: unknown = credentialsText;
    if (credentialsText.trim()) {
      try {
        credentials = JSON.parse(credentialsText);
      } catch {
        // Not valid JSON — send the raw string; `create_connection`'s params schema accepts
        // `z.unknown()`, so a plain token/password string is a legitimate value too.
        credentials = credentialsText;
      }
    }

    try {
      const created = await httpClient.call('create_connection', { kind, target, credentials });
      setResult(created);
      setTarget('');
      setCredentialsText('');
    } catch (err) {
      if (err instanceof HttpError && err.code === 'not_implemented') {
        setNotImplemented(true);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="connection-form" onSubmit={(event) => void handleSubmit(event)}>
      <label>
        Kind
        <select value={kind} onChange={(event) => setKind(event.target.value as ConnectionKind)}>
          {KIND_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      <label>
        Address
        <input
          type="text"
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          placeholder={kind === 'http' ? 'https://api.example.com/openapi.json' : 'address'}
          required
        />
      </label>
      <label>
        Credentials
        <textarea
          value={credentialsText}
          onChange={(event) => setCredentialsText(event.target.value)}
          placeholder='token, or JSON e.g. {"apiKey":"..."}'
          rows={3}
        />
      </label>

      <button type="submit" disabled={submitting || target.trim().length === 0}>
        {submitting ? 'Connecting…' : 'Connect'}
      </button>

      {notImplemented && (
        <p className="hint">
          The kernel accepted this shape but has no S2.13 handler yet — connection registration is
          not implemented on this kernel build.
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {result !== undefined && (
        <pre className="action-card-simulated">{JSON.stringify(result, null, 2)}</pre>
      )}
    </form>
  );
}
