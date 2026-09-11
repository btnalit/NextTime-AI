import { type FormEvent, useState } from 'react';
import { type MeResult, bindApiKey } from '../lib/auth-api.js';
import { HttpError } from '../lib/http-client.js';
import { Button } from './ui/Button.js';
import { Card } from './ui/Card.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Field, Input } from './ui/Field.js';

export interface BindApiKeyFormProps {
  readonly onBound: (result: MeResult) => void;
  /** Injectable `fetch` for tests — see `lib/auth-api.ts`'s own module doc comment. */
  readonly fetchImpl?: typeof fetch;
}

/** Kernel wire code → the exact Chinese copy this form shows for a bind failure
 *  (`auth-routes.ts` `POST /api/auth/bind-api-key`). Anything else falls back to the kernel's own
 *  message via `ErrorBanner`. */
function bindErrorMessage(err: unknown): string | null {
  if (!(err instanceof HttpError) || err.kind !== 'capability_error') return null;
  switch (err.code) {
    case 'invalid_api_key':
      return '这把 API key 不属于任何成员';
    case 'already_claimed':
      return '这把 key 属于另一个已经设置了密码的账户';
    case 'already_member':
      return '你已经是该工作区的成员了';
    default:
      return null;
  }
}

/**
 * components/BindApiKeyForm: cookie-authenticated "fold a pre-existing API key's workspace
 * membership into my account" (S4.1 revised; `POST /api/auth/bind-api-key`, `lib/auth-api.ts`).
 * Shared by `NoWorkspacePage` (the pre-created `admin`'s first-login screen, or anyone else who
 * signed in with a password but still holds a separate API key from before) and `AccountPage`
 * (cookie mode, to bind additional keys at any time). Unlike `ClaimPasswordCard`
 * (`AccountPage.tsx`) this never mints a new session — the caller already has one — so it only
 * ever returns the caller's refreshed `{user, memberships}`.
 */
export function BindApiKeyForm({ onBound, fetchImpl }: BindApiKeyFormProps) {
  const [apiKey, setApiKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = apiKey.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await bindApiKey(trimmed, fetchImpl);
      setApiKey('');
      onBound(result);
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  const inline = bindErrorMessage(error);

  return (
    <Card title="绑定已有 API key Bind an existing API key">
      <form className="stack" onSubmit={(event) => void handleSubmit(event)} noValidate>
        <Field
          id="bind-api-key"
          label="API key"
          required
          hint="把这把 key 所属的工作区成员资格归到当前账户；之后用密码登录即可进入该工作区。"
        >
          <Input
            id="bind-api-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            disabled={submitting}
            placeholder="sk-..."
            mono
          />
        </Field>

        {inline ? (
          <p className="field-error" role="alert">
            {inline}
          </p>
        ) : error !== null ? (
          <ErrorBanner error={error} title="无法绑定 Could not bind the key" />
        ) : null}

        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button type="submit" variant="primary" loading={submitting} disabled={!apiKey.trim()}>
            绑定 Bind
          </Button>
        </div>
      </form>
    </Card>
  );
}
