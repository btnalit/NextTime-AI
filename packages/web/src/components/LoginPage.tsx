import { type FormEvent, useState } from 'react';

/**
 * components/LoginPage: the API-key login screen (design doc §7.6; docs/development-tasks.md
 * S1.8 deliverable 1). Submitting hands the raw key to `onLogin`, which owns actually opening
 * the WS connection and authenticating (src/App.tsx) — this component only collects input.
 */
export interface LoginPageProps {
  readonly onLogin: (apiKey: string) => void;
  readonly pending: boolean;
  readonly error: string | null;
}

export function LoginPage({ onLogin, pending, error }: LoginPageProps) {
  const [apiKey, setApiKey] = useState('');

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = apiKey.trim();
    if (!trimmed || pending) return;
    onLogin(trimmed);
  }

  return (
    <div className="centered-screen">
      <form className="login-form" onSubmit={handleSubmit}>
        <h1>NextTime AI</h1>
        <p className="hint">Sign in with your workspace API key.</p>
        <label htmlFor="api-key">API key</label>
        <input
          id="api-key"
          name="api-key"
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          disabled={pending}
          placeholder="sk-..."
        />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={pending || apiKey.trim().length === 0}>
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
