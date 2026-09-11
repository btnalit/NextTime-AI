import { type FormEvent, useState } from 'react';
import { type WireUser, changePassword } from '../lib/auth-api.js';
import { HttpError } from '../lib/http-client.js';
import { Button } from './ui/Button.js';
import { Card } from './ui/Card.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Field, Input } from './ui/Field.js';

export interface ChangePasswordPageProps {
  readonly user: WireUser;
  readonly onChanged: (user: WireUser) => void;
  readonly onLogout: () => void;
  /** Injectable `fetch` for tests — see `lib/auth-api.ts`'s own module doc comment. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * components/ChangePasswordPage: the forced password change (design doc §7.11; S4.1) — rendered
 * by `App.tsx` whenever `user.mustChangePassword` is true (a temporary password an admin set),
 * covering every workspace capability with 403 `password_change_required` until this clears it
 * (`resolve-caller.ts` `PasswordChangeRequiredError`). The only two actions available are
 * changing the password and signing out — no shell, no route navigation, until it succeeds.
 */
export function ChangePasswordPage({
  user,
  onChanged,
  onLogout,
  fetchImpl,
}: ChangePasswordPageProps) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown | null>(null);

  const passwordsMismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;
  const canSubmit =
    currentPassword && newPassword && newPassword === confirmPassword && !submitting;

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await changePassword({ currentPassword, newPassword }, fetchImpl);
      onChanged(result.user);
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  const currentPasswordWrong =
    error instanceof HttpError &&
    error.kind === 'capability_error' &&
    error.code === 'bad_credentials';

  return (
    <div className="login-screen">
      <Card className="login-card" padded={false}>
        <form className="stack" onSubmit={(event) => void handleSubmit(event)} noValidate>
          <div className="login-brand">
            <div className="sidebar-mark" aria-hidden>
              N
            </div>
            <div>
              <h1 className="login-title">需要更改密码 Password change required</h1>
              <p className="login-subtitle">
                {user.displayName} ({user.login}) is using a temporary password.
              </p>
            </div>
          </div>

          <Field
            id="cp-current-password"
            label="当前密码 Current password"
            required
            error={currentPasswordWrong ? '当前密码不正确 Current password is incorrect' : null}
          >
            <Input
              id="cp-current-password"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              disabled={submitting}
              invalid={currentPasswordWrong}
            />
          </Field>

          <Field
            id="cp-new-password"
            label="新密码 New password"
            required
            hint="至少 8 位 At least 8 characters"
          >
            <Input
              id="cp-new-password"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              disabled={submitting}
            />
          </Field>

          <Field
            id="cp-confirm-password"
            label="确认新密码 Confirm new password"
            required
            error={passwordsMismatch ? '两次输入的密码不一致 Passwords do not match' : null}
          >
            <Input
              id="cp-confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              disabled={submitting}
              invalid={passwordsMismatch}
            />
          </Field>

          {error !== null && !currentPasswordWrong ? (
            <ErrorBanner error={error} title="无法更改密码 Could not change password" />
          ) : null}

          <Button type="submit" variant="primary" loading={submitting} disabled={!canSubmit}>
            更改密码 Change password
          </Button>

          <div className="row" style={{ justifyContent: 'center' }}>
            <Button type="button" variant="ghost" size="s" icon="logout" onClick={onLogout}>
              登出 Sign out
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
