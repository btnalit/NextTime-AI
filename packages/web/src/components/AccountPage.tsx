import { type FormEvent, useState } from 'react';
import { type WireMembership, type WireUser, changePassword, patchMe } from '../lib/auth-api.js';
import { HttpError } from '../lib/http-client.js';
import { Button } from './ui/Button.js';
import { Card } from './ui/Card.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Field, Input } from './ui/Field.js';
import { Notice } from './ui/Notice.js';
import { PageHeader } from './ui/PageHeader.js';

export interface AccountPageProps {
  /** `null` in API-key mode (`GET /api/auth/me` is never called for that channel — there is no
   *  platform user behind an API key). */
  readonly user: WireUser | null;
  readonly memberships: readonly WireMembership[];
  readonly onUserChanged: (user: WireUser) => void;
  /** Injectable `fetch` for tests — see `lib/auth-api.ts`'s own module doc comment. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * components/AccountPage: 我的账户 My Account (`#/me/account`, S4.1) — display name (`PATCH
 * /api/auth/me`), password change (`POST /api/auth/password`, optional here — unlike
 * `ChangePasswordPage`, nothing forces this one), and a read-only list of the caller's own
 * memberships. Uses `lib/auth-api.ts` directly rather than a `CapabilityCaller` — these are the
 * `/api/auth/*` routes, not `/api/cap/<name>` capability calls, and need no workspace.
 */
export function AccountPage({ user, memberships, onUserChanged, fetchImpl }: AccountPageProps) {
  if (!user) {
    return (
      <div className="page">
        <PageHeader title="我的账户 My Account" />
        <Notice tone="info">
          账户设置需要密码登录 Account settings require a password login — an API-key session has no
          platform user to manage (<code>GET /api/auth/me</code> is cookie-only).
        </Notice>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader title="我的账户 My Account" description={user.login} />
      <DisplayNameCard user={user} onUserChanged={onUserChanged} fetchImpl={fetchImpl} />
      <PasswordCard fetchImpl={fetchImpl} />
      <MembershipsCard memberships={memberships} />
    </div>
  );
}

function DisplayNameCard({
  user,
  onUserChanged,
  fetchImpl,
}: {
  readonly user: WireUser;
  readonly onUserChanged: (user: WireUser) => void;
  readonly fetchImpl?: typeof fetch;
}) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown | null>(null);
  const [saved, setSaved] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = displayName.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError(null);
    setSaved(false);
    try {
      const result = await patchMe({ displayName: trimmed }, fetchImpl);
      onUserChanged(result.user);
      setSaved(true);
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card title="显示名 Display name">
      <form className="stack" onSubmit={(event) => void handleSubmit(event)} noValidate>
        <Field id="account-display-name" label="显示名 Display name" required>
          <Input
            id="account-display-name"
            value={displayName}
            onChange={(event) => {
              setDisplayName(event.target.value);
              setSaved(false);
            }}
            disabled={submitting}
          />
        </Field>
        {error !== null ? (
          <ErrorBanner error={error} title="无法保存 Could not save" />
        ) : saved ? (
          <Notice tone="info">已保存 Saved</Notice>
        ) : null}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button
            type="submit"
            variant="primary"
            loading={submitting}
            disabled={!displayName.trim() || displayName.trim() === user.displayName}
          >
            保存 Save
          </Button>
        </div>
      </form>
    </Card>
  );
}

function PasswordCard({ fetchImpl }: { readonly fetchImpl?: typeof fetch }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown | null>(null);
  const [saved, setSaved] = useState(false);

  const passwordsMismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;
  const canSubmit = currentPassword && newPassword && newPassword === confirmPassword;
  const currentPasswordWrong =
    error instanceof HttpError &&
    error.kind === 'capability_error' &&
    error.code === 'bad_credentials';

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);
    setSaved(false);
    try {
      await changePassword({ currentPassword, newPassword }, fetchImpl);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setSaved(true);
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card title="密码 Password">
      <form className="stack" onSubmit={(event) => void handleSubmit(event)} noValidate>
        <Field
          id="account-current-password"
          label="当前密码 Current password"
          required
          error={currentPasswordWrong ? '当前密码不正确 Current password is incorrect' : null}
        >
          <Input
            id="account-current-password"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            disabled={submitting}
            invalid={currentPasswordWrong}
          />
        </Field>
        <Field
          id="account-new-password"
          label="新密码 New password"
          required
          hint="至少 8 位 At least 8 characters"
        >
          <Input
            id="account-new-password"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            disabled={submitting}
          />
        </Field>
        <Field
          id="account-confirm-password"
          label="确认新密码 Confirm new password"
          required
          error={passwordsMismatch ? '两次输入的密码不一致 Passwords do not match' : null}
        >
          <Input
            id="account-confirm-password"
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
        ) : saved ? (
          <Notice tone="info">密码已更改 Password changed</Notice>
        ) : null}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button type="submit" variant="primary" loading={submitting} disabled={!canSubmit}>
            更改密码 Change password
          </Button>
        </div>
      </form>
    </Card>
  );
}

function MembershipsCard({ memberships }: { readonly memberships: readonly WireMembership[] }) {
  return (
    <Card title="我的工作区 My workspaces">
      {memberships.length === 0 ? (
        <p className="empty-state-body">
          你还不属于任何工作区 You are not a member of any workspace.
        </p>
      ) : (
        <ul className="stack-s" data-testid="account-memberships">
          {memberships.map((m) => (
            <li key={m.workspaceId} className="row" style={{ justifyContent: 'space-between' }}>
              <span>{m.workspaceName}</span>
              <span className="tag">{m.role}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
