import { type FormEvent, useState } from 'react';
import { type SessionResult, login as apiLogin } from '../lib/auth-api.js';
import { describeError } from '../lib/errors.js';
import { HttpError } from '../lib/http-client.js';
import { ApiKeyLoginDetails } from './ApiKeyLoginDetails.js';
import { Button } from './ui/Button.js';
import { Card } from './ui/Card.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Field, Input } from './ui/Field.js';

/**
 * components/LoginPage: the console sign-in screen (design doc §7.11; S4.1). The primary form is
 * login name + password (`POST /api/auth/login`, self-contained — this component owns the fetch,
 * unlike the API-key path below); a collapsed `<details>` (`ApiKeyLoginDetails`) holds the
 * pre-S4.1 API-key form, whose multi-step WS connect + authenticate is still owned by `App.tsx`
 * (`onApiKeyLogin`/`apiKeyPending`/`apiKeyError`).
 */
export interface LoginPageProps {
  readonly onApiKeyLogin: (apiKey: string) => void;
  readonly apiKeyPending: boolean;
  readonly apiKeyError: unknown | null;
  readonly onLoggedIn: (result: SessionResult) => void;
  /** Injectable `fetch` for tests — see `lib/auth-api.ts`'s own module doc comment. */
  readonly fetchImpl?: typeof fetch;
}

/** Kernel wire code → the exact Chinese copy this page shows for a login failure (§7.11's own
 *  error taxonomy: `bad_credentials`/`locked`/`disabled`/`sessions_unavailable`). Anything else
 *  falls back to the kernel's own message via `ErrorBanner`. */
function loginErrorMessage(err: unknown): string | null {
  if (!(err instanceof HttpError) || err.kind !== 'capability_error') return null;
  switch (err.code) {
    case 'bad_credentials':
      return '登录名或密码不正确';
    case 'locked':
      return '尝试次数过多，请几分钟后再试';
    case 'disabled':
      return '此账户已停用';
    case 'sessions_unavailable':
      return '控制台会话尚未配置签名密钥，暂时无法使用密码登录 (no Handle signing key configured on this kernel)';
    default:
      return null;
  }
}

export function LoginPage({
  onApiKeyLogin,
  apiKeyPending,
  apiKeyError,
  onLoggedIn,
  fetchImpl,
}: LoginPageProps) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmedLogin = login.trim();
    if (!trimmedLogin || !password || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await apiLogin({ login: trimmedLogin, password }, fetchImpl);
      onLoggedIn(result);
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  const inline = loginErrorMessage(error);
  const described = error === null || error === undefined ? null : describeError(error);

  return (
    <div className="login-screen">
      <Card className="login-card" padded={false}>
        <form className="stack" onSubmit={(event) => void handleSubmit(event)} noValidate>
          <div className="login-brand">
            <div className="sidebar-mark" aria-hidden>
              N
            </div>
            <div>
              <h1 className="login-title">NextTime AI</h1>
              <p className="login-subtitle">Sign in to the workspace console</p>
            </div>
          </div>

          <Field id="login-name" label="登录名 Login" required>
            <Input
              id="login-name"
              name="login"
              autoComplete="username"
              value={login}
              onChange={(event) => setLogin(event.target.value)}
              disabled={submitting}
            />
          </Field>

          <Field id="login-password" label="密码 Password" required>
            <Input
              id="login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={submitting}
            />
          </Field>

          {inline ? (
            <p className="field-error" role="alert">
              {inline}
            </p>
          ) : described ? (
            <ErrorBanner error={error} title="Could not sign in" />
          ) : null}

          <Button
            type="submit"
            variant="primary"
            loading={submitting}
            disabled={!login.trim() || !password}
          >
            Log in
          </Button>

          <p className="login-footer">
            首次登录：用户名 admin，初始密码在主机的 secrets/setup/initial-admin-password（首次登录后必须修改）。
          </p>
        </form>

        <ApiKeyLoginDetails
          onLogin={onApiKeyLogin}
          pending={apiKeyPending}
          error={apiKeyError}
          footerExtra="用 key 登录后可在「我的账户」设置密码，之后用密码登录。"
        />
      </Card>
    </div>
  );
}
