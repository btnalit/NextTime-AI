import { ROLE_VALUES, type Role } from '@nexttime/shared';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { usePermissions } from '../hooks/usePermissions.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { isForbiddenError } from '../lib/errors.js';
import type { PrincipalRow } from '../lib/governance.js';
import { useT } from '../lib/i18n.js';
import { roleLabel } from '../lib/labels.js';
import {
  loginError,
  loginNormalizedNote,
  loginRuleText,
  normalizeLoginInput,
} from '../lib/login-input.js';
import { platformErrorMessage } from '../lib/platform-errors.js';
import { useUserDirectoryTap } from '../lib/users-directory.js';
import { Button } from './kit/button.js';
import { ErrorBanner } from './kit/error-banner.js';
import { Field } from './kit/field.js';
import { Select } from './kit/select.js';
import { UserPicker } from './platform/UserPicker.js';

export interface AddMemberFormProps {
  readonly http: CapabilityCaller;
  readonly onDone: (principal: PrincipalRow) => void;
  readonly onCancel: () => void;
  /** Whether the signed-in user is a platform administrator (`session.user?.platformRole ===
   *  'admin'`). `true` opens straight on the user directory; `false` never tries it. Omitted:
   *  the form tries `list_users` once in the background and offers the directory only if it
   *  answers (a 403 means "not a platform administrator" and is remembered for the session). */
  readonly platformAdmin?: boolean;
}

/** The probe asks for exactly `UserPicker`'s first page. */
const DIRECTORY_PROBE = { limit: 50 } as const;

type DirectoryState =
  | { readonly kind: 'probing' }
  | { readonly kind: 'available' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'failed'; readonly error: unknown };

/**
 * components/AddMemberForm (console redesign P3-4 part B, on `components/kit/*` only):
 * `add_member{login, role}` (P-A1) — a person joins this workspace by their **platform login**,
 * not by having a credential minted for them: the capability creates the membership Principal
 * with no API key at all (`hasApiKey: false`), and the person signs in with the password their
 * platform account already has (design doc §5: "工作区配置里的成员页语义变为从平台用户中添加（按登录
 * 名搜索 → 选角色）"). `create_principal` is now only the service-credential path — see
 * `CreatePrincipalForm`.
 *
 * Who the login belongs to: the user directory (`list_users`, `scope:'platform'`) is readable only
 * by a platform administrator, so for one the form offers `UserPicker` (search by login or display
 * name, then pick) instead of a blind text box. Everyone else types the login — normalized the way
 * the kernel will (trim + lower-case, "将保存为 alice") and checked against the login rule before
 * the round trip. A platform administrator can still switch to typing: the picker leaves out
 * accounts that have not set a password yet, and those can be added too.
 *
 * Two kernel refusals get their own bilingual line instead of a banner: `user_not_found` (404 —
 * no such platform login, or it is disabled) and `already_member` (409), the two a typo or a
 * double-click actually produces.
 */
export function AddMemberForm({ http, onDone, onCancel, platformAdmin }: AddMemberFormProps) {
  const t = useT();
  const permissions = usePermissions();
  const directory = useUserDirectoryTap(http);

  // Decided once, on mount: a 403 from this very probe must not flip it mid-flight.
  const [shouldProbe] = useState(
    () => platformAdmin === undefined && !permissions.isDenied('list_users'),
  );
  const [directoryState, setDirectoryState] = useState<DirectoryState>(() =>
    platformAdmin === true
      ? { kind: 'available' }
      : shouldProbe
        ? { kind: 'probing' }
        : { kind: 'unavailable' },
  );
  const [mode, setMode] = useState<'directory' | 'typed'>(
    platformAdmin === true ? 'directory' : 'typed',
  );
  const [probeAttempt, setProbeAttempt] = useState(0);
  const [pickedUserId, setPickedUserId] = useState('');
  const [login, setLogin] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown | null>(null);

  // Read inside the probe's callback: a reader who already started typing keeps their text box.
  const loginRef = useRef(login);
  loginRef.current = login;
  const markDeniedRef = useRef(permissions.markDenied);
  markDeniedRef.current = permissions.markDenied;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `probeAttempt` is the retry trigger.
  useEffect(() => {
    if (!shouldProbe) return;
    let live = true;
    setDirectoryState({ kind: 'probing' });
    directory.caller.call('list_users', DIRECTORY_PROBE).then(
      () => {
        if (!live) return;
        setDirectoryState({ kind: 'available' });
        if (loginRef.current.trim() === '') setMode('directory');
      },
      (err: unknown) => {
        if (!live) return;
        if (isForbiddenError(err)) {
          markDeniedRef.current('list_users');
          setDirectoryState({ kind: 'unavailable' });
        } else {
          setDirectoryState({ kind: 'failed', error: err });
        }
      },
    );
    return () => {
      live = false;
    };
  }, [shouldProbe, directory.caller, probeAttempt]);

  const picked = mode === 'directory' ? directory.find(pickedUserId) : undefined;
  const normalizedLogin = normalizeLoginInput(login);
  const typedLoginError = mode === 'typed' ? loginError(normalizedLogin, t) : null;
  const typedLoginNote = mode === 'typed' ? loginNormalizedNote(login, t) : null;
  const submitLogin = mode === 'directory' ? (picked?.login ?? '') : normalizedLogin;
  const ready = submitLogin !== '' && typedLoginError === null;

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!ready || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      onDone(await http.call<PrincipalRow>('add_member', { login: submitLogin, role }));
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  function switchMode(next: 'directory' | 'typed'): void {
    setMode(next);
    setError(null);
    // Carry the picked user into the text box, so typing starts from it rather than from empty.
    if (next === 'typed' && picked) setLogin(picked.login);
  }

  const inline = platformErrorMessage(error, t);
  const typedHint = [
    t(
      '平台用户的登录名；这里不创建账户，也不签发 API key。',
      "An existing platform user's login — this creates no account and no API key.",
    ),
    loginRuleText(t),
    typedLoginNote,
  ]
    .filter((part) => part !== null)
    .join(' ');

  return (
    <form
      className="stack"
      onSubmit={(event) => void handleSubmit(event)}
      noValidate
      data-testid="add-member-form"
    >
      {mode === 'directory' ? (
        <>
          <UserPicker
            http={directory.caller}
            id="am-user"
            label={t('平台用户', 'Platform user')}
            hint={t(
              '从平台用户目录里选；还没设置过密码的账户不在列表里，可改为手动输入。',
              'Pick from the platform user directory. Accounts that have not set a password yet are not listed — type their login instead.',
            )}
            value={pickedUserId}
            onChange={setPickedUserId}
            disabled={submitting}
            testId="add-member-user"
          />
          <div className="row">
            <Button
              variant="ghost"
              size="s"
              onClick={() => switchMode('typed')}
              disabled={submitting}
              data-testid="add-member-type-instead"
            >
              {t('改为手动输入', 'Type a login instead')}
            </Button>
          </div>
        </>
      ) : (
        <>
          <Field
            id="am-login"
            label={t('登录名', 'Login')}
            required
            hint={typedHint}
            error={typedLoginError}
          >
            <input
              id="am-login"
              className="input input-mono"
              value={login}
              onChange={(event) => setLogin(event.target.value)}
              onBlur={() => setLogin(normalizeLoginInput(login))}
              disabled={submitting}
              aria-invalid={typedLoginError !== null || undefined}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          {directoryState.kind === 'available' ? (
            <div className="row">
              <Button
                variant="ghost"
                size="s"
                onClick={() => switchMode('directory')}
                disabled={submitting}
                data-testid="add-member-pick-instead"
              >
                {t('从平台用户目录选择', 'Pick from the user directory')}
              </Button>
            </div>
          ) : directoryState.kind === 'failed' ? (
            <ErrorBanner
              error={directoryState.error}
              title={t(
                '无法读取平台用户目录，可先手动输入',
                'Could not load the platform user directory — type the login for now',
              )}
              onRetry={() => setProbeAttempt((n) => n + 1)}
              testId="add-member-directory-error"
            />
          ) : null}
        </>
      )}

      <Field
        id="am-role"
        label={t('角色', 'Role')}
        required
        hint={t('之后可在成员行里修改。', "Can be changed later from the member's row.")}
      >
        <Select
          id="am-role"
          aria-label={t('角色', 'Role')}
          className="select-fit"
          value={role}
          onChange={(event) => setRole(event.target.value as Role)}
          disabled={submitting}
        >
          {ROLE_VALUES.map((value) => (
            <option key={value} value={value}>
              {roleLabel(value, t)}
            </option>
          ))}
        </Select>
      </Field>

      {inline !== null ? (
        <p className="field-error" role="alert" data-testid="add-member-error">
          {inline}
        </p>
      ) : error !== null ? (
        <ErrorBanner
          error={error}
          title={t('无法添加成员', 'Could not add this member')}
          testId="add-member-error"
        />
      ) : null}

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>
          {t('取消', 'Cancel')}
        </Button>
        <Button type="submit" variant="primary" aria-busy={submitting} disabled={!ready}>
          {t('添加', 'Add')}
        </Button>
      </div>
    </form>
  );
}
