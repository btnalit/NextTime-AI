import { type FormEvent, useState } from 'react';
import { describeError } from '../lib/errors.js';
import { Button } from './ui/Button.js';
import { Card } from './ui/Card.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Field, Input, describedBy } from './ui/Field.js';
import { Kbd } from './ui/Kbd.js';

/**
 * components/LoginPage: the API-key sign-in (design doc §7.6; S1.8 deliverable 1). Collects the
 * key and hands it to `onLogin`, which owns opening the socket and authenticating (src/App.tsx).
 * The key is held in component state only until then; `lib/session.ts` keeps it in
 * `sessionStorage` afterwards — never localStorage, never a cookie, never logged.
 */
export interface LoginPageProps {
  readonly onLogin: (apiKey: string) => void;
  readonly pending: boolean;
  readonly error: unknown | null;
}

export function LoginPage({ onLogin, pending, error }: LoginPageProps) {
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
    <div className="login-screen">
      <Card className="login-card" padded={false}>
        <form className="stack" onSubmit={handleSubmit} noValidate>
          <div className="login-brand">
            <div className="sidebar-mark" aria-hidden>
              N
            </div>
            <div>
              <h1 className="login-title">NextTime AI</h1>
              <p className="login-subtitle">Sign in to the workspace console</p>
            </div>
          </div>

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

          {described && !unauthorized ? <ErrorBanner error={error} title="Could not sign in" /> : null}

          <Button
            type="submit"
            variant="primary"
            loading={pending}
            disabled={apiKey.trim().length === 0}
          >
            Sign in
          </Button>

          <div className="login-footer">
            <span>
              Your key is issued by the workspace owner (<code>bootstrap add-principal</code>) and is
              kept in this tab only until you sign out.
            </span>
            <span>
              <Kbd>Enter</Kbd> to sign in
            </span>
          </div>
        </form>
      </Card>
    </div>
  );
}
