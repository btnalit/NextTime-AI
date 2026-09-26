import { type FormEvent, useState } from 'react';
import { usePermissions } from '../hooks/usePermissions.js';
import { useWorkspaceIdentity } from '../hooks/useWorkspaceIdentity.js';
import {
  type MeResult,
  type SessionResult,
  type WireMembership,
  type WireUser,
  changePassword,
  claimIdentity,
  patchMe,
} from '../lib/auth-api.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { HttpError } from '../lib/http-client.js';
import { useT } from '../lib/i18n.js';
import { breadcrumbFor } from '../lib/nav.js';
import { LOGIN_PATTERN } from '../lib/platform-errors.js';
import { BindApiKeyForm } from './BindApiKeyForm.js';
import { LangSwitch } from './LangSwitch.js';
import { IssueOwnHandleSection } from './account/IssueOwnHandleSection.js';
import { PageHeader } from './kit/page-header.js';
import { Button } from './ui/Button.js';
import { Card } from './ui/Card.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Field, Input } from './ui/Field.js';
import { Notice } from './ui/Notice.js';
import { StatusChip } from './ui/StatusChip.js';

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
  /** Fires when the bind form (cookie mode) succeeds — `App.tsx`'s `handleKeyBound` refreshes the
   *  live session's/pre-session's `memberships`. The bind card renders only when this is wired. */
  readonly onBound?: (result: MeResult) => void;
  /** Injectable `fetch` for tests — see `lib/auth-api.ts`'s own module doc comment. */
  readonly fetchImpl?: typeof fetch;
  /** 控制台产品化重构方案 D3 (docs/console-redesign-plan-2026-09-25.md §7): a workspace-scoped
   *  `CapabilityCaller`, needed only for the "接 Claude Code / MCP" card (`issue_handle`) below —
   *  optional and omitted by every call site that has no workspace in scope (`App.tsx`'s
   *  `noWorkspace` pre-session state has no session/http at all; `routes.tsx` also withholds it for
   *  a platform-only admin session, `selectedWorkspaceId === undefined`, the same case `Routed`
   *  redirects away from every *other* workspace-scoped route). This keeps this page's own
   *  long-standing invariant — reachable with no capability call at all — true for both of those,
   *  and the card simply does not render without `http`. */
  readonly http?: CapabilityCaller;
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
 *
 * 控制台产品化重构方案 D3: `IssueOwnHandleSection` ("接 Claude Code / MCP", moved off 访问 Access)
 * renders here, in cookie mode only, gated the same way it always was — `issue_handle` is
 * `minRole:'owner'` (`howto-connect-claude-code.md`), so this is still owner-only, not "any member"
 * — behind `HandleCard`'s own `canManage` (`useWorkspaceIdentity` + the `usePermissions` 403
 * fallback, the same formula `AccessPage`/`MembersPage` use).
 */
export function AccountPage({
  user,
  memberships,
  onUserChanged,
  apiKey,
  onClaimed,
  onBound,
  fetchImpl,
  http,
}: AccountPageProps) {
  const t = useT();
  if (!user) {
    return (
      <div className="page">
        <PageHeader breadcrumb={breadcrumbFor('account')} title={t('我的账户', 'My Account')} />
        <ClaimPasswordCard apiKey={apiKey} onClaimed={onClaimed} fetchImpl={fetchImpl} />
        <LanguageCard />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        breadcrumb={breadcrumbFor('account')}
        title={t('我的账户', 'My Account')}
        description={user.login}
      />
      <DisplayNameCard user={user} onUserChanged={onUserChanged} fetchImpl={fetchImpl} />
      <PasswordCard fetchImpl={fetchImpl} />
      <LanguageCard />
      <MembershipsCard memberships={memberships} />
      {http ? <HandleCard http={http} /> : null}
      {onBound ? <BindApiKeyForm onBound={onBound} fetchImpl={fetchImpl} /> : null}
    </div>
  );
}

/** D3: gated exactly like `AccessPage`'s old inline card — `useWorkspaceIdentity`'s authoritative
 *  `get_workspace.caller.role` once known, the `issue_handle` 403 inference (same `minRole:'owner'`
 *  denial closure `hooks/usePermissions.tsx` derives) only while it is not. A separate component
 *  (rather than calling these hooks straight from `AccountPage`) so they only ever mount, and only
 *  ever call `get_workspace`, when `http` exists — `AccountPage` itself stays capability-call-free
 *  in every mode that has no workspace in scope. */
function HandleCard({ http }: { readonly http: CapabilityCaller }) {
  const t = useT();
  const permissions = usePermissions();
  const { role } = useWorkspaceIdentity(http);
  const canManage =
    role.kind === 'known' ? role.role === 'owner' : !permissions.isDenied('issue_handle');
  if (!canManage) return null;
  return (
    <Card title={t('接 Claude Code / MCP', 'Connect Claude Code / MCP')}>
      <IssueOwnHandleSection http={http} />
    </Card>
  );
}

/** S8 W1-A9 (audit S4/S7): the one place a signed-in user can change the console's display
 *  language outside the sidebar footer/drawer — useful once the footer's own toggle has scrolled
 *  out of view, and the natural "preferences" spot on this page. */
function LanguageCard() {
  const t = useT();
  return (
    <Card title={t('界面语言', 'Language')}>
      <div className="stack">
        <p className="page-description">
          {t(
            '选择控制台显示中文还是英文，选择会保存在本浏览器。',
            'Choose whether the console shows Chinese or English. Saved in this browser.',
          )}
        </p>
        <LangSwitch />
      </div>
    </Card>
  );
}

/** Kernel wire code → the exact Chinese copy this card shows for a claim failure
 *  (`auth-routes.ts` `POST /api/auth/claim`). Anything else falls back to the kernel's own
 *  message via `ErrorBanner`. */
function claimErrorMessage(err: unknown): string | null {
  if (!(err instanceof HttpError) || err.kind !== 'capability_error') return null;
  switch (err.code) {
    case 'already_claimed':
      return '该身份已经有密码了；请登出后用密码登录';
    // C4: the kernel's `normalizeLogin` (identity/users.ts) is the authority; the shared
    // `LOGIN_PATTERN` (lib/platform-errors.ts) mirrors it client-side, and this maps the wire
    // code for the case the mirror still lets through.
    case 'invalid_login':
      return '登录名格式不正确：3–64 位，首字符须为字母或数字，仅小写字母、数字、. _ -';
    default:
      return null;
  }
}

function ClaimPasswordCard({
  apiKey,
  onClaimed,
  fetchImpl,
}: {
  readonly apiKey?: string;
  readonly onClaimed?: (result: SessionResult) => void;
  readonly fetchImpl?: typeof fetch;
}) {
  const t = useT();
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
    <Card title={t('设置密码以启用密码登录', 'Set a password to enable password login')}>
      <form className="stack" onSubmit={(event) => void handleSubmit(event)} noValidate>
        <Field
          id="account-claim-login"
          label={t('登录名', 'Login')}
          required
          hint={t(
            '3–64 位，首字符为字母或数字，仅小写字母、数字、. _ -',
            '3–64 characters, starting with a letter or digit: lowercase letters, digits, . _ -',
          )}
          error={loginInvalid ? t('登录名格式不正确', 'Invalid login format') : null}
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

        <Field id="account-claim-display-name" label={t('显示名', 'Display name')} required>
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
          label={t('密码', 'Password')}
          required
          hint={t('至少 8 位', 'At least 8 characters')}
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
          label={t('确认密码', 'Confirm password')}
          required
          error={passwordsMismatch ? t('两次输入的密码不一致', 'Passwords do not match') : null}
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
          <ErrorBanner error={error} title={t('无法设置密码', 'Could not set a password')} />
        ) : null}

        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button type="submit" variant="primary" loading={submitting} disabled={!canSubmit}>
            {t('设置密码', 'Set password')}
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
  const t = useT();
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
    <Card title={t('显示名', 'Display name')}>
      <form className="stack" onSubmit={(event) => void handleSubmit(event)} noValidate>
        <Field id="account-display-name" label={t('显示名', 'Display name')} required>
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
          <ErrorBanner error={error} title={t('无法保存', 'Could not save')} />
        ) : saved ? (
          <Notice tone="info">{t('已保存', 'Saved')}</Notice>
        ) : null}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button
            type="submit"
            variant="primary"
            loading={submitting}
            disabled={!displayName.trim() || displayName.trim() === user.displayName}
          >
            {t('保存', 'Save')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function PasswordCard({ fetchImpl }: { readonly fetchImpl?: typeof fetch }) {
  const t = useT();
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
    <Card title={t('密码', 'Password')}>
      <form className="stack" onSubmit={(event) => void handleSubmit(event)} noValidate>
        <Field
          id="account-current-password"
          label={t('当前密码', 'Current password')}
          required
          error={currentPasswordWrong ? t('当前密码不正确', 'Current password is incorrect') : null}
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
          label={t('新密码', 'New password')}
          required
          hint={t('至少 8 位', 'At least 8 characters')}
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
          label={t('确认新密码', 'Confirm new password')}
          required
          error={passwordsMismatch ? t('两次输入的密码不一致', 'Passwords do not match') : null}
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
          <ErrorBanner error={error} title={t('无法更改密码', 'Could not change password')} />
        ) : saved ? (
          <Notice tone="info">{t('密码已更改', 'Password changed')}</Notice>
        ) : null}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          {/* S8 W1-A11 (audit L2): secondary — the page's three independent forms each had their
           *  own ink primary button; `DisplayNameCard`'s "保存" (the most frequent, top-of-page
           *  action) stays the one primary for this view. */}
          <Button type="submit" variant="secondary" loading={submitting} disabled={!canSubmit}>
            {t('更改密码', 'Change password')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function MembershipsCard({ memberships }: { readonly memberships: readonly WireMembership[] }) {
  const t = useT();
  return (
    <Card title={t('我的工作区', 'My workspaces')}>
      {memberships.length === 0 ? (
        <p className="empty-state-body">
          {t('你还不属于任何工作区', 'You are not a member of any workspace.')}
        </p>
      ) : (
        // S8 W4 (audit AC1 "工作区行有无意义的左缩进；角色 chip 原样 owner"): the browser's default
        // `<ul>` padding was never reset here (unlike every other list in this codebase, which
        // resets it alongside `list-style`), and the role showed as a bare `.tag` instead of the
        // same `StatusChip` machine every other role display in this console already uses.
        <ul
          className="stack-s"
          data-testid="account-memberships"
          style={{ listStyle: 'none', padding: 0 }}
        >
          {memberships.map((m) => (
            <li key={m.workspaceId} className="row" style={{ justifyContent: 'space-between' }}>
              {/* S8 W4 (audit S15 "我的账户里写明'在 X 工作区中你是 owner'"): explicit "在 … 中你
               *  是 …" phrasing instead of a bare name + chip pair. */}
              <span>{t(`在 ${m.workspaceName} 中你是`, `In ${m.workspaceName}, you are`)}</span>
              <StatusChip machine="role" status={m.role} size="s" />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
