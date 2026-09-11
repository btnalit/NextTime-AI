import { type FormEvent, useState } from 'react';
import { type SessionResult, setupPlatform } from '../lib/auth-api.js';
import { ApiKeyLoginDetails } from './ApiKeyLoginDetails.js';
import { Button } from './ui/Button.js';
import { Card } from './ui/Card.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Field, Input } from './ui/Field.js';
import { Notice } from './ui/Notice.js';

export interface SetupPageProps {
  /** `GET /api/platform/setup-state`'s `tokenAvailable` — `false` means the one-time token
   *  expired or was invalidated after too many wrong attempts; the form is disabled and the reader
   *  is told to restart the kernel to mint a fresh one. */
  readonly tokenAvailable: boolean;
  readonly onSetupComplete: (result: SessionResult) => void;
  /** "已有账户？登录" — flips `App.tsx`'s auth view to `LoginPage` without requiring the platform
   *  to be initialized first. See this component's own module doc comment for why this exists. */
  readonly onLoginInstead: () => void;
  readonly onApiKeyLogin: (apiKey: string) => void;
  readonly apiKeyPending: boolean;
  readonly apiKeyError: unknown | null;
  /** Injectable `fetch` for tests — see `lib/auth-api.ts`'s own module doc comment. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * components/SetupPage: first-run platform initialization (design doc §7.11 "初始化：一次性令牌，不
 * 是默认口令"; S4.1). Shown by `App.tsx` when `GET /api/auth/me` is 401 and
 * `GET /api/platform/setup-state` answers `initialized:false` — exchanges the one-time token
 * (`${NEXTTIME_DATA}/secrets/setup/token`) for the first platform administrator.
 *
 * Carries the same collapsed API-key `<details>` (`ApiKeyLoginDetails`) `LoginPage` does, plus an
 * "already have an account? log in" link that flips `App.tsx` to `LoginPage` outright. Neither is
 * in the original design-doc flow — added because "no active platform admin yet" and "the reader
 * already holds a working credential" are independent facts: a workspace API key predates S4.1
 * entirely and must keep working regardless of whether anyone has ever completed platform setup
 * (and several of this package's own Playwright specs, run against one shared kernel, only ever
 * hold an API key and never touch `/api/platform/setup` at all).
 */
export function SetupPage({
  tokenAvailable,
  onSetupComplete,
  onLoginInstead,
  onApiKeyLogin,
  apiKeyPending,
  apiKeyError,
  fetchImpl,
}: SetupPageProps) {
  const [token, setToken] = useState('');
  const [login, setLogin] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown | null>(null);

  const passwordsMismatch = confirmPassword.length > 0 && password !== confirmPassword;
  const canSubmit =
    tokenAvailable &&
    token.trim() &&
    login.trim() &&
    displayName.trim() &&
    password &&
    password === confirmPassword;

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await setupPlatform(
        { token: token.trim(), login: login.trim(), displayName: displayName.trim(), password },
        fetchImpl,
      );
      onSetupComplete(result);
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-screen">
      <Card className="login-card" padded={false}>
        <form className="stack" onSubmit={(event) => void handleSubmit(event)} noValidate>
          <div className="login-brand">
            <div className="sidebar-mark" aria-hidden>
              N
            </div>
            <div>
              <h1 className="login-title">初始化平台 Initialize the platform</h1>
              <p className="login-subtitle">Create the first platform administrator</p>
            </div>
          </div>

          {tokenAvailable ? (
            <Field
              id="setup-token"
              label="一次性令牌 Setup token"
              required
              hint={
                <>
                  The token is at <code>{'${NEXTTIME_DATA}/secrets/setup/token'}</code> on the
                  kernel host.
                </>
              }
            >
              <Input
                id="setup-token"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                disabled={submitting}
                mono
              />
            </Field>
          ) : (
            <Notice tone="warn">
              没有可用的一次性令牌 No usable setup token — restart the kernel to mint a fresh one (a
              previous token expired, or was invalidated after too many failed attempts).
            </Notice>
          )}

          <Field id="setup-login" label="登录名 Login" required>
            <Input
              id="setup-login"
              autoComplete="username"
              value={login}
              onChange={(event) => setLogin(event.target.value)}
              disabled={!tokenAvailable || submitting}
            />
          </Field>

          <Field id="setup-display-name" label="显示名 Display name" required>
            <Input
              id="setup-display-name"
              autoComplete="name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              disabled={!tokenAvailable || submitting}
            />
          </Field>

          <Field
            id="setup-password"
            label="密码 Password"
            required
            hint="至少 8 位 At least 8 characters"
          >
            <Input
              id="setup-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={!tokenAvailable || submitting}
            />
          </Field>

          <Field
            id="setup-confirm-password"
            label="确认密码 Confirm password"
            required
            error={passwordsMismatch ? '两次输入的密码不一致 Passwords do not match' : null}
          >
            <Input
              id="setup-confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              disabled={!tokenAvailable || submitting}
              invalid={passwordsMismatch}
            />
          </Field>

          {error !== null ? (
            <ErrorBanner error={error} title="无法初始化 Could not initialize the platform" />
          ) : null}

          <Button type="submit" variant="primary" loading={submitting} disabled={!canSubmit}>
            创建管理员 Create administrator
          </Button>

          <div className="row" style={{ justifyContent: 'center' }}>
            <Button type="button" variant="ghost" size="s" onClick={onLoginInstead}>
              已有账户？登录 Already have an account? Log in
            </Button>
          </div>
        </form>

        <ApiKeyLoginDetails onLogin={onApiKeyLogin} pending={apiKeyPending} error={apiKeyError} />
      </Card>
    </div>
  );
}
