import { type FormEvent, useState } from 'react';
import {
  type MeResult,
  type SessionResult,
  type WireMembership,
  type WireUser,
  changePassword,
  claimIdentity,
  patchMe,
} from '../lib/auth-api.js';
import { HttpError } from '../lib/http-client.js';
import { BindApiKeyForm } from './BindApiKeyForm.js';
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
  /** The API-key session's own key (S4.1 revised) — only present, and only needed, when `user` is
   *  `null`: it proves identity for the claim form below (`POST /api/auth/claim`). */
  readonly apiKey?: string;
  /** Fires when the claim form (API-key mode) succeeds — `App.tsx`'s `handleClaimed` swaps the
   *  API-key session for the freshly-minted cookie one. */
  readonly onClaimed?: (result: SessionResult) => void;
  /** Fires when the bind form (cookie mode) succeeds — `App.tsx`'s `handleBound` refreshes the
   *  live session's/pre-session's `memberships`. */
  readonly onBound?: (result: MeResult) => void;
  /** Injectable `fetch` for tests — see `lib/auth-api.ts`'s own module doc comment. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * components/AccountPage: 我的账户 My Account (`#/me/account`, S4.1) — display name (`PATCH
 * /api/auth/me`), password change (`POST /api/auth/password`, optional here — unlike
 * `ChangePasswordPage`, nothing forces this one), a read-only list of the caller's own
 * memberships, and (cookie mode) a form to bind another pre-existing API key into this account.
 * Uses `lib/auth-api.ts` directly rather than a `CapabilityCaller` — these are the `/api/auth/*`
 * routes, not `/api/cap/<name>` capability calls, and need no workspace.
 *
 * API-key mode (`user === null`) shows a *claim* form instead (`POST /api/auth/claim`) — sets a
 * login/password on the key's own passwordless identity and hands the caller a cookie session, so
 * the key holder never has to re-type anything to land in the console proper.
 */
export function AccountPage({
  user,
  memberships,
  onUserChanged,
  apiKey,
  onClaimed,
  onBound,
  fetchImpl,
}: AccountPageProps) {
  if (!user) {
    return (
      <div className="page">
        <PageHeader title="我的账户 My Account" />
        <ClaimPasswordCard apiKey={apiKey} onClaimed={onClaimed} fetchImpl={fetchImpl} />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader title="我的账户 My Account" description={user.login} />
      <DisplayNameCard user={user} onUserChanged={onUserChanged} fetchImpl={fetchImpl} />
      <PasswordCard fetchImpl={fetchImpl} />
      <MembershipsCard memberships={memberships} />
      {onBound ? <BindApiKeyForm onBound={onBound} fetchImpl={fetchImpl} /> : null}
    </div>
  );
}

/** Kernel wire code → the exact Chinese copy this card shows for a claim failure
 *  (`auth-routes.ts` `POST /api/auth/claim`). Anything else falls back to the kernel's own
 *  message via `ErrorBanner`. */
function claimErrorMessage(err: unknown): string | null {
  if (!(err instanceof HttpError) || err.kind !== 'capability_error') return null;
  if (err.code === 'already_claimed') {
    return '该身份已经有密码了；请登出后用密码登录';
  }
  return null;
}

const LOGIN_PATTERN = /^[a-z0-9._-]{3,64}$/;

function ClaimPasswordCard({
  apiKey,
  onClaimed,
  fetchImpl,
}: {
  readonly apiKey?: string;
  readonly onClaimed?: (result: SessionResult) => void;
  readonly fetchImpl?: typeof fetch;
}) {
  const [login, setLogin] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown | null>(null);

  const loginInvalid = login.length > 0 && !LOGIN_PATTERN.test(login);
  const passwordsMismatch = confirmPassword.length > 0 && password !== confirmPassword;
  const canSubmit =
    Boolean(apiKey) &&
    LOGIN_PATTERN.test(login) &&
    displayName.trim().length > 0 &&
    password.length >= 8 &&
    password === confirmPassword;

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canSubmit || submitting || !apiKey) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await claimIdentity(
        apiKey,
        { login, displayName: displayName.trim(), password },
        fetchImpl,
      );
      onClaimed?.(result);
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  const inline = claimErrorMessage(error);

  return (
    <Card title="设置密码以启用密码登录 Set a password to enable password login">
      <form className="stack" onSubmit={(event) => void handleSubmit(event)} noValidate>
        <Field
          id="account-claim-login"
          label="登录名 Login"
          required
          hint="3–64 位，仅小写字母、数字、. _ - 3–64 characters: lowercase letters, digits, . _ -"
          error={loginInvalid ? '登录名格式不正确 Invalid login format' : null}
        >
          <Input
            id="account-claim-login"
            autoComplete="username"
            value={login}
            onChange={(event) => setLogin(event.target.value)}
            disabled={submitting}
            invalid={loginInvalid}
          />
        </Field>

        <Field id="account-claim-display-name" label="显示名 Display name" required>
          <Input
            id="account-claim-display-name"
            autoComplete="name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            disabled={submitting}
          />
        </Field>

        <Field
          id="account-claim-password"
          label="密码 Password"
          required
          hint="至少 8 位 At least 8 characters"
        >
          <Input
            id="account-claim-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={submitting}
          />
        </Field>

        <Field
          id="account-claim-confirm-password"
          label="确认密码 Confirm password"
          required
          error={passwordsMismatch ? '两次输入的密码不一致 Passwords do not match' : null}
        >
          <Input
            id="account-claim-confirm-password"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            disabled={submitting}
            invalid={passwordsMismatch}
          />
        </Field>

        {inline ? (
          <Notice tone="warn">{inline}</Notice>
        ) : error !== null ? (
          <ErrorBanner error={error} title="无法设置密码 Could not set a password" />
        ) : null}

        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button type="submit" variant="primary" loading={submitting} disabled={!canSubmit}>
            设置密码 Set password
          </Button>
        </div>
      </form>
    </Card>
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
