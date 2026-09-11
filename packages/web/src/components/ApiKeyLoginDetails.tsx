import { type FormEvent, useState } from 'react';
import { describeError } from '../lib/errors.js';
import { Button } from './ui/Button.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Field, Input, describedBy } from './ui/Field.js';

export interface ApiKeyLoginDetailsProps {
  readonly onLogin: (apiKey: string) => void;
  readonly pending: boolean;
  readonly error: unknown | null;
}

/**
 * components/ApiKeyLoginDetails: the pre-S4.1 API-key sign-in, now a collapsed `<details>` shared
 * by `LoginPage` (the primary password login) and `SetupPage` (so a reader who already holds an
 * API key — or an e2e spec that only ever had one — never has to go through platform setup or
 * password login to reach the console; see `App.tsx`'s own doc comment on why `SetupPage` needs
 * this escape hatch too). `onLogin`/`pending`/`error` are owned by `App.tsx`, which runs the
 * multi-step WS connect + authenticate — unlike the single-fetch password/setup flows, this is not
 * self-contained.
 */
export function ApiKeyLoginDetails({ onLogin, pending, error }: ApiKeyLoginDetailsProps) {
  const [apiKey, setApiKey] = useState('');
  const [revealed, setRevealed] = useState(false);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = apiKey.trim();
    if (!trimmed || pending) return;
    onLogin(trimmed);
  }

  const described = error === null || error === undefined ? null : describeError(error);
  const unauthorized = described?.code === 'unauthorized';

  return (
    <details className="api-key-login">
      <summary>用 API key 登录 Use an API key instead</summary>
      <form className="stack" onSubmit={handleSubmit} noValidate>
        <Field
          id="api-key"
          label="API key"
          required
          error={unauthorized ? 'This key was not accepted by the kernel.' : null}
        >
          <div className="input-group">
            <Input
              id="api-key"
              name="api-key"
              type={revealed ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              disabled={pending}
              placeholder="sk-..."
              invalid={unauthorized}
              aria-describedby={describedBy('api-key', false, unauthorized)}
              mono
            />
            <Button
              variant="ghost"
              size="s"
              icon={revealed ? 'eye-off' : 'eye'}
              iconOnly
              aria-label={revealed ? 'Hide key' : 'Show key'}
              aria-pressed={revealed}
              onClick={() => setRevealed((value) => !value)}
              disabled={pending}
            />
          </div>
        </Field>

        {described && !unauthorized ? (
          <ErrorBanner error={error} title="Could not sign in" />
        ) : null}

        <Button
          type="submit"
          variant="primary"
          loading={pending}
          disabled={apiKey.trim().length === 0}
        >
          Sign in
        </Button>

        <p className="login-footer">
          <span>
            Your key is issued by the workspace owner (<code>bootstrap add-principal</code>) and is
            kept in this tab only until you sign out.
          </span>
        </p>
      </form>
    </details>
  );
}
